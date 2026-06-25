// =============================================================
// app/api/cron/position-monitor/route.ts
//
// Fast mechanical position monitor. Runs every 3 min during US
// market hours. For each open stocks position:
//
//   1. Fetch 5min + 15min bars from Alpaca
//   2. Compute calculateTechnicals() on each
//   3. Count bearish/bullish signals via countSignals()
//   4. Decide via decide():
//        - HOLD → no action
//        - TIGHTEN_STOP → move stop closer via PATCH on Alpaca bracket
//        - EXIT → close position via DELETE /v2/positions/{symbol}
//        - ESCALATE → call existing thesis-check (Council), use its decision
//   5. Log every check to position_monitor_log
//
// Cooldown: skip if pm_cooldown_min has not elapsed since last
// action on this position.
//
// Hard floor: this cron NEVER places NEW positions. Only manages
// existing ones via tighten/exit.
// =============================================================

import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers, type UserTradingSettings, type AssetClass } from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import { makeAlpacaClient, type AlpacaClient, type AlpacaPosition } from '@/app/lib/trading/alpaca-client'
import { fetchBars } from '@/app/lib/data/alpaca'
import { calculateTechnicals } from '@/app/lib/signals/technicals'
import { countSignals, decide, computeTrailingStop, type SignalSnapshot, type Decision, type TrailingStopResult } from '@/app/lib/trading/position-monitor-signals'
import { type MonitorConfig, type MonitorMode } from '@/app/lib/trading/monitor-config'
import { AsyncLocalStorage } from 'node:async_hooks'

// Per-run monitor label (e.g. 'swing-monitor' / 'day-monitor'). runMonitor()
// sets this once for its entire async call tree so EVERY log line below —
// including deep helpers that never receive `config` — is attributed to the
// acting monitor. AsyncLocalStorage isolates concurrent swing/day runs, so
// there's no cross-talk even if both crons fire in the same warm process.
const monitorCtx = new AsyncLocalStorage<string>()
const monTag = (): string => monitorCtx.getStore() ?? 'monitor'


// Minimum bars required for technicals to be meaningful.
const MIN_BARS = 30

// Bars to fetch — enough for SMA50/MACD warmup
const BARS_TO_FETCH_5MIN = 80
const BARS_TO_FETCH_15MIN = 80

// ── Re-entry config ──
// After the monitor EXITs a position, the ticker stays on a re-entry watch for
// this many calendar days (~5 trading days). Within the window, if the original
// DIRECTIONAL setup returns (bullish signals for a long thesis, bearish for a
// short), the monitor re-enters at the same size and same stop distance.
const REENTRY_WINDOW_DAYS = 7
const MAX_REENTRIES = 2
// Minimum directional 5m signals required to call it a fresh entry setup.
const REENTRY_MIN_SIGNALS = 2

interface OpenAttempt {
  id: string
  user_id: string
  ticker: string
  side: 'buy' | 'sell' | null
  qty: number | null
  filled_avg_price: number | null
  entry_price_est: number | null
  stop_price: number | null
  target_price: number | null
  broker_order_id: string | null
  verdict_log_id: number | null
  original_stop_loss: number | null   // Council's original stop from verdict_log (immutable, for R-multiple trailing)
  outcome: string
  asset_class: string | null
  monitor_owned_stop: boolean | null
}

interface PerUserSummary {
  userId: string
  positionsChecked: number
  holds: number
  tightens: number
  exits: number
  escalates: number
  cooldowns: number
  errors: number
}

interface CronSummary {
  users: PerUserSummary[]
  durationMs: number
  totalActions: number
}

/**
 * Returns true if "now" is within 5 minutes of US market close (21:00 UTC).
 *
 * Used to gate EXIT actions: a market sell placed in the last 5 min may not
 * fill before close, queueing as a held order for the next session's open
 * with no protective stop in place (bracket children get cancelled by
 * applyExit). The KLAC bug (June 22, 2026) was caused by EXIT firing at
 * 21:06 UTC — past close. The pre-market-reeval cron handles such cases
 * with fresh data instead.
 *
 * Time zones: US market close is 4 PM ET = 21:00 UTC during EDT (Mar-Nov).
 * During EST (Nov-Mar) market close is 4 PM ET = 21:00 UTC also (since EST
 * is UTC-5 and the bell still rings at 4 PM ET). UTC math works in both.
 *
 * Window is [20:55 UTC, 21:00 UTC). After 21:00 UTC, position-monitor cron
 * shouldn't even be running (workflow schedule is `*\/3 13-21`) but defensive
 * check still kicks in if the run was late.
 */
function isWithinMarketCloseWindow(): boolean {
  const now = new Date()
  const totalMinutesUtc = now.getUTCHours() * 60 + now.getUTCMinutes()
  const MARKET_CLOSE_MIN_UTC = 21 * 60      // 21:00 UTC = 1260
  const GUARD_WINDOW_MIN = 5
  return totalMinutesUtc >= MARKET_CLOSE_MIN_UTC - GUARD_WINDOW_MIN
}

export async function runMonitor(config: MonitorConfig): Promise<CronSummary> {
  return monitorCtx.run(config.label, async (): Promise<CronSummary> => {
  const startedAt = Date.now()
  const summary: CronSummary = { users: [], durationMs: 0, totalActions: 0 }

  const users = (await listEnabledTradingUsers())
    .filter(s => isAssetClassEnabled(s, 'stock'))
    // Master switch — position_monitor_enabled defaults true (see migration 14
    // and settings.ts DEFAULT_TRADING_SETTINGS). Read directly now that settings.ts
    // surfaces the column. Falls through if explicitly disabled.
    .filter(s => s.positionMonitorEnabled !== false)

  for (const settings of users) {
    const userSummary: PerUserSummary = {
      userId: settings.userId,
      positionsChecked: 0,
      holds: 0, tightens: 0, exits: 0, escalates: 0,
      cooldowns: 0, errors: 0,
    }
    try {
      await processUser(settings, userSummary, config)
    } catch (e) {
      userSummary.errors++
      console.error(`[${config.label}] user=${settings.userId} fatal:`, e instanceof Error ? e.message : e)
    }
    summary.totalActions += userSummary.tightens + userSummary.exits + userSummary.escalates
    summary.users.push(userSummary)
  }

  summary.durationMs = Date.now() - startedAt
  console.log(
    `[${config.label}] done in ${summary.durationMs}ms users=${summary.users.length} ` +
    `totalActions=${summary.totalActions}`
  )
  return summary
  })
}

// ─────────────────────────────────────────────────────────────
// Per-user processing
// ─────────────────────────────────────────────────────────────

async function processUser(settings: UserTradingSettings, userSummary: PerUserSummary, config: MonitorConfig): Promise<void> {
  // Read PM-specific settings via defensive cast (the migration adds these
  // columns; the settings loader may not surface them until we update it)
  const pmSettings = pmSettingsFrom(settings)

  // Load broker — explicitly pass 'stock' (singular, matches DB) so we get
  // the alpaca stocks credential row, not crypto or another asset class
  const credLoad = await loadBrokerCredentialForUse(settings.userId, settings.broker, settings.mode, 'stock')
  if (!credLoad) {
    console.warn(`[${monTag()}] user=${settings.userId} no broker credentials for ${settings.broker}/${settings.mode}/stock`)
    return
  }
  const alpaca = makeAlpacaClient(credLoad.keyId, credLoad.secret, settings.mode)

  // Fetch open stocks positions from broker (source of truth) plus their
  // trade_attempts metadata (for stop adjustment + cooldown tracking)
  let positions: AlpacaPosition[] = []
  try {
    positions = await alpaca.positions()
  } catch (e) {
    console.error(
      `[${monTag()}] user=${settings.userId} alpaca.positions() THREW:`,
      e instanceof Error ? `${e.message}\n${e.stack ?? ''}`.slice(0, 600) : String(e).slice(0, 300),
    )
    userSummary.errors++
    return
  }
  if (positions.length === 0) {
    console.log(`[${monTag()}] user=${settings.userId} alpaca returned 0 open positions`)
    // Don't return early — exited tickers may still be on the re-entry watch,
    // which is scanned below regardless of whether anything is open right now.
    await runReentryPass(settings, alpaca, new Set<string>(), config).catch(e =>
      console.warn(`[${monTag()}] reentry pass user=${settings.userId}: ${e instanceof Error ? e.message : e}`))
    return
  }
  console.log(
    `[${monTag()}] user=${settings.userId} alpaca returned ${positions.length} positions: ` +
    positions.map(p => `${p.symbol}(qty=${p.qty})`).join(','),
  )

  const attemptsByTicker = await fetchOpenAttempts(settings.userId, config.mode)
  console.log(
    `[${monTag()}] user=${settings.userId} trade_attempts has ${attemptsByTicker.size} open rows: ` +
    Array.from(attemptsByTicker.keys()).join(','),
  )

  // Tickers owned by the OTHER monitor (swing vs day). A position tagged for the
  // other mode is that monitor's responsibility, not ours — so seeing it here is
  // expected, not an orphan. We only WARN for positions absent from BOTH modes.
  const otherMode: MonitorMode = config.mode === 'day' ? 'swing' : 'day'
  const otherModeTickers = await fetchOwnedTickers(settings.userId, otherMode)

  // EOD flatten (day monitor only): inside the pre-close window, flatten all
  // day-owned positions so they don't carry overnight gap risk, then stop —
  // no signal processing or re-entry at the end of the day.
  if (config.mode === 'day') {
    const flattened = await flattenDayPositionsAtClose(settings, alpaca, positions, attemptsByTicker, userSummary, config)
    if (flattened) return
  }

  for (const pos of positions) {
    const sym = pos.symbol.toUpperCase()
    const att = attemptsByTicker.get(sym)
    if (!att) {
      if (otherModeTickers.has(sym)) {
        // Owned by the other monitor — expected hand-off boundary, not a problem.
        console.log(
          `[${monTag()}] user=${settings.userId} ${sym} owned by ${otherMode} monitor — skipping (not this monitor's position)`,
        )
      } else {
        // Genuine orphan: broker has a position with no open trade_attempts row in
        // EITHER mode. Can't act safely (unknown original stop), so this is a warn.
        console.warn(
          `[${monTag()}] user=${settings.userId} ${sym} has no matching trade_attempts row in any mode (broker has position but DB doesn't); skipping`,
        )
      }
      continue
    }
    userSummary.positionsChecked++

    // Sync fill-back from broker BEFORE cooldown check, so cooldowned
    // positions still get their entry/risk corrected to actual fill.
    // Mutates `att` in-place if an update happens, so downstream logic
    // sees the corrected values.
    await syncFillBackFromBroker(att, pos).catch(e =>
      console.warn(`[${monTag()}] sync-fill ${sym} failed: ${e instanceof Error ? e.message : e}`),
    )

    try {
      const handled = await processPosition(settings, pmSettings, alpaca, pos, att, userSummary, config)
      if (!handled) userSummary.errors++
    } catch (e) {
      userSummary.errors++
      console.error(`[${monTag()}] ${sym} failed:`, e instanceof Error ? e.message : e)
      await logResult(settings, att, pos.symbol, {
        ok: false, errorReason: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
        decision: 'HOLD', actionTaken: 'error',
        snap5m: emptySnapshot(), snap15m: emptySnapshot(),
        currentPrice: pos.current_price, currentStop: att.stop_price,
      }, config.mode)
    }
  }

  // Re-entry pass: scan watched (exited) tickers for a returning setup. Pass the
  // currently-open tickers so we never re-enter something we already hold.
  const openTickers = new Set(positions.map(p => p.symbol.toUpperCase()))
  await runReentryPass(settings, alpaca, openTickers, config).catch(e =>
    console.warn(`[${monTag()}] reentry pass user=${settings.userId}: ${e instanceof Error ? e.message : e}`))
}

// ─────────────────────────────────────────────────────────────
// Fill-back sync — keep trade_attempts in sync with broker truth
// ─────────────────────────────────────────────────────────────
//
// The Council recommends an entry price. The auto-trader places a market
// order at that price. The actual fill is whatever the ask is when the
// order hits Alpaca — often a few cents to a few dollars off.
//
// Before this sync, trade_attempts stored only the Council recommendation:
//   filled_avg_price = null
//   entry_price_est = council's number
//   risk_dollar_amount = computed from council's number (wrong)
//
// After: filled_avg_price + entry_price_est track broker truth.
// council_entry is preserved untouched for audit (Council's aspiration).
// risk_dollar_amount is recalculated against the actual fill.
//
// Idempotent: skips if filled_avg_price already matches broker within 1c.

async function syncFillBackFromBroker(
  att: OpenAttempt,
  pos: AlpacaPosition,
): Promise<void> {
  const brokerFill = pos.avg_entry_price
  if (!Number.isFinite(brokerFill) || brokerFill <= 0) return

  // Idempotency: skip if filled_avg_price is already accurate
  if (att.filled_avg_price !== null &&
      Math.abs(att.filled_avg_price - brokerFill) < 0.01) {
    return
  }

  // Recompute risk based on actual fill and current stop
  // (use att.stop_price which the cron knows about — broker may have a
  // tightened stop we haven't updated yet, but the math here is for the
  // recorded stop level)
  const stop = att.stop_price
  const qty = att.qty ?? Math.abs(pos.qty)
  if (stop === null || qty === null || qty <= 0) {
    console.warn(`[${monTag()}] sync-fill ${att.ticker}: missing stop or qty, skipping risk recalc`)
    return
  }

  const newRisk = Math.round(qty * Math.abs(brokerFill - stop) * 100) / 100

  const admin = await getSupabaseAdmin()
  const { error } = await admin
    .from('trade_attempts')
    .update({
      filled_avg_price: brokerFill,
      entry_price_est: brokerFill,
      risk_dollar_amount: newRisk,
    })
    .eq('id', att.id)

  if (error) {
    console.warn(`[${monTag()}] sync-fill ${att.ticker} update failed: ${error.message}`)
    return
  }

  console.log(
    `[${monTag()}] sync-fill ${att.ticker}: ` +
    `entry ${att.filled_avg_price ?? 'null'} -> ${brokerFill.toFixed(2)}, ` +
    `risk $${newRisk.toFixed(2)} (qty ${qty} x |fill - stop ${stop.toFixed(2)}|)`,
  )

  // Mutate in-memory att so downstream code uses corrected values
  att.filled_avg_price = brokerFill
  att.entry_price_est = brokerFill
}

// ─────────────────────────────────────────────────────────────
// Per-position decision + action
// ─────────────────────────────────────────────────────────────

async function processPosition(
  settings: UserTradingSettings,
  pm: PMSettings,
  alpaca: AlpacaClient,
  pos: AlpacaPosition,
  att: OpenAttempt,
  userSummary: PerUserSummary,
  config: MonitorConfig,
): Promise<boolean> {
  const ticker = pos.symbol.toUpperCase()
  // Stamp every log row with the acting monitor's mode (attribution) and the
  // latest bar-health readout (captured by reference; assigned after the fetch).
  let bhFast: number | null = null
  let bhSlow: number | null = null
  let bhAge: number | null = null
  const logR = (tk: string, p: LogPayload) =>
    logResult(settings, att, tk, {
      ...p,
      barsFastCount: p.barsFastCount ?? bhFast,
      barsSlowCount: p.barsSlowCount ?? bhSlow,
      slowBarAgeMin: p.slowBarAgeMin ?? bhAge,
    }, config.mode)

  // Cooldown — don't double-act on a position within pm_cooldown_min
  if (await isInCooldown(att.id, pm.cooldownMin)) {
    userSummary.cooldowns++
    return true
  }

  // Monitor-owned stop (fractional shares): there is NO broker stop leg, so the
  // monitor IS the stop. Hard-close immediately on a stop breach, before any
  // signal evaluation — this is the protection a broker bracket would normally
  // provide. Bracket positions skip this (their broker stop leg handles it).
  {
    const stopLevel = att.stop_price
    const sideNow = (att.side ?? 'buy') as 'buy' | 'sell'
    if (att.monitor_owned_stop && stopLevel !== null && Number.isFinite(stopLevel)) {
      const px = pos.current_price
      const breached = sideNow === 'buy' ? px <= stopLevel : px >= stopLevel
      if (breached) {
        const result = await applyExit(alpaca, pos)
        if (result.ok) userSummary.exits++
        await logR(ticker, {
          ok: result.ok,
          decision: 'EXIT',
          actionTaken: result.ok ? 'monitor_stop_breach' : 'monitor_stop_breach_failed',
          snap5m: emptySnapshot(), snap15m: emptySnapshot(),
          currentPrice: px, currentStop: stopLevel,
          errorReason: result.ok ? undefined : result.reason,
        })
        if (result.ok) {
          console.log(`[${monTag()}] ${ticker} MONITOR-STOP breach @ ${px.toFixed(2)} <= stop ${stopLevel.toFixed(2)} — market close (fractional, no broker stop)`)
          await recordExitClosure(att, pos, 'monitor_exit').catch(e =>
            console.warn(`[${monTag()}] record-exit ${ticker}: ${e instanceof Error ? e.message : e}`))
        }
        return true
      }
      // Not breached: arm a broker-side DAY stop for intratick protection so we
      // don't depend on the next poll. Fractional stops expire each close, so
      // this re-arms them every run (self-healing daily). The hard-breach check
      // above remains the backstop for the brief unarmed window + overnight.
      await ensureMonitorOwnedStop(alpaca, att, pos, stopLevel, sideNow).catch(e =>
        console.warn(`[${monTag()}] arm stop ${ticker}: ${e instanceof Error ? e.message : e}`))
    }
  }

  // Side (we don't currently take shorts; default buy)
  const side = (att.side ?? 'buy') as 'buy' | 'sell'

  // Fetch bars and compute technicals
  const [bars5m, bars15m] = await Promise.all([
    fetchBarsForTimeframe(ticker, config.fastTimeframe, BARS_TO_FETCH_5MIN),
    fetchBarsForTimeframe(ticker, config.slowTimeframe, BARS_TO_FETCH_15MIN),
  ])

  // Bar-health: counts + staleness of the slow feed (latest slow bar age).
  bhFast = bars5m.length
  bhSlow = bars15m.length
  {
    const lastSlow = bars15m[bars15m.length - 1]
    const ts = lastSlow ? Date.parse(String(lastSlow.t)) : NaN
    bhAge = Number.isFinite(ts) ? Math.max(0, Math.round((Date.now() - ts) / 60000)) : null
  }

  if (bars5m.length < MIN_BARS || bars15m.length < MIN_BARS) {
    // Not enough data — log a HOLD and move on
    await logR(ticker, {
      ok: true, decision: 'HOLD', actionTaken: 'hold_insufficient_data',
      snap5m: emptySnapshot(), snap15m: emptySnapshot(),
      currentPrice: pos.current_price, currentStop: att.stop_price,
      errorReason: `5m bars: ${bars5m.length}, 15m bars: ${bars15m.length}, need ${MIN_BARS}`,
    })
    userSummary.holds++
    return true
  }

  const t5m = calculateTechnicals(bars5m)
  const t15m = calculateTechnicals(bars15m)
  const snap5m = countSignals(t5m, side)
  const snap15m = countSignals(t15m, side)

  // Rule engine decision
  const ruling = decide({
    snap5m, snap15m,
    tightenThreshold15m: config.tightenThreshold15m ?? pm.tightenThreshold15m,
    exitThreshold15m: config.exitThreshold15m ?? pm.exitThreshold15m,
    exitThreshold5m: config.exitThreshold5m ?? pm.exitThreshold5m,
    escalateOnConflict: pm.escalateOnConflict,
  })

  // Execute
  if (ruling.decision === 'HOLD') {
    userSummary.holds++
    // Profit trailing: even on a HOLD, ratchet the stop up to lock in gains at
    // R-multiple milestones (breakeven at +1R, +0.5R at +2R, etc.). This is the
    // "exit with a win" protection that previously only existed on the crypto
    // monitor — the stock monitor reached HOLD and left the stop untouched.
    const trail = await applyTrailingStop(alpaca, att, pos)
    if (trail.applied) {
      console.log(`[${monTag()}] ${ticker} TRAIL ${trail.milestone} → stop ${trail.newStop?.toFixed(2)}`)
    }
    await logR(ticker, {
      ok: true, decision: 'HOLD', actionTaken: trail.applied ? 'trailed' : 'hold',
      snap5m, snap15m,
      currentPrice: pos.current_price, currentStop: att.stop_price,
      newStopPrice: trail.applied ? trail.newStop : undefined,
    })
    return true
  }

  if (ruling.decision === 'TIGHTEN_STOP') {
    const result = await applyTighten(alpaca, att, pos)
    userSummary.tightens++
    await logR(ticker, {
      ok: result.ok, decision: 'TIGHTEN_STOP', actionTaken: result.ok ? 'tightened' : 'tighten_failed',
      snap5m, snap15m,
      currentPrice: pos.current_price, currentStop: att.stop_price,
      newStopPrice: result.newStop,
      errorReason: result.ok ? undefined : result.reason,
    })
    if (result.ok && result.newStop !== undefined) {
      console.log(`[${monTag()}] ${ticker} TIGHTEN ${(att.stop_price ?? 0).toFixed(2)} → ${result.newStop.toFixed(2)} (${ruling.reason})`)
      // Persist new stop level to trade_attempts so future runs see correct level
      await syncTightenedStop(att, result.newStop).catch(e =>
        console.warn(`[${monTag()}] sync-tighten ${ticker}: ${e instanceof Error ? e.message : e}`))
    }
    // After the signal-based tighten, also run profit trailing: if the R-multiple
    // milestone implies a higher stop than the midpoint nudge, ratchet up to it.
    // applyTighten already updated att.stop_price, so this only moves UP further.
    const trail = await applyTrailingStop(alpaca, att, pos)
    if (trail.applied) {
      console.log(`[${monTag()}] ${ticker} TRAIL ${trail.milestone} → stop ${trail.newStop?.toFixed(2)} (post-tighten)`)
    }
    return result.ok || trail.applied
  }

  if (ruling.decision === 'EXIT') {
    // KLAC bug guard (June 22, 2026): refuse EXIT actions in the last 5 minutes
    // of trading. After-hours fills don't work for bracket orders — applyExit
    // would cancel the protective children and place a market sell that just
    // queues for the next session's open, leaving the position unprotected
    // overnight. Pre-market-reeval cron picks up these cases at next open.
    if (isWithinMarketCloseWindow()) {
      console.log(`[${monTag()}] ${ticker} EXIT deferred — within 5 min of market close (${ruling.reason})`)
      await logR(ticker, {
        ok: true, decision: 'EXIT', actionTaken: 'exit_deferred_close_window',
        snap5m, snap15m,
        currentPrice: pos.current_price, currentStop: att.stop_price,
        errorReason: `deferred: within market-close window; pre-market-reeval will handle`,
      })
      return true
    }
    const result = await applyExit(alpaca, pos)
    userSummary.exits++
    await logR(ticker, {
      ok: result.ok, decision: 'EXIT', actionTaken: result.ok ? 'exited' : 'exit_failed',
      snap5m, snap15m,
      currentPrice: pos.current_price, currentStop: att.stop_price,
      errorReason: result.ok ? undefined : result.reason,
    })
    if (result.ok) {
      console.log(`[${monTag()}] ${ticker} EXIT @ ~${pos.current_price.toFixed(2)} (${ruling.reason})`)
      // Persist closure to trade_attempts so lifecycle/dashboard see truth
      await recordExitClosure(att, pos, 'monitor_exit').catch(e =>
        console.warn(`[${monTag()}] record-exit ${ticker}: ${e instanceof Error ? e.message : e}`))
      // Add to the re-entry watch: if the original directional setup returns
      // within the window, the monitor can re-enter (dip-then-recover).
      await recordReentryWatch(att, pos).catch(e =>
        console.warn(`[${monTag()}] reentry-watch ${ticker}: ${e instanceof Error ? e.message : e}`))
    }
    return result.ok
  }

  if (ruling.decision === 'ESCALATE') {
    userSummary.escalates++
    const escalation = await escalateToCouncil(settings, att, pos, ruling.reason)
    // Apply the council's decision via the same machinery
    if (escalation.action === 'EXIT') {
      // Same market-close guard for escalated exits
      if (isWithinMarketCloseWindow()) {
        console.log(`[${monTag()}] ${ticker} ESCALATED EXIT deferred — within 5 min of market close`)
        await logR(ticker, {
          ok: true, decision: 'ESCALATE', actionTaken: 'escalated_exit_deferred_close_window',
          snap5m, snap15m,
          currentPrice: pos.current_price, currentStop: att.stop_price,
          escalationResult: escalation,
          errorReason: 'deferred: within market-close window',
        })
        return true
      }
      const result = await applyExit(alpaca, pos)
      await logR(ticker, {
        ok: result.ok, decision: 'ESCALATE', actionTaken: result.ok ? 'escalated_exit' : 'escalated_exit_failed',
        snap5m, snap15m,
        currentPrice: pos.current_price, currentStop: att.stop_price,
        escalationResult: escalation,
        errorReason: result.ok ? undefined : result.reason,
      })
      if (result.ok) {
        await recordExitClosure(att, pos, 'escalated_exit').catch(e =>
          console.warn(`[${monTag()}] record-exit ${ticker}: ${e instanceof Error ? e.message : e}`))
        await recordReentryWatch(att, pos).catch(e =>
          console.warn(`[${monTag()}] reentry-watch ${ticker}: ${e instanceof Error ? e.message : e}`))
      }
    } else if (escalation.action === 'TIGHTEN_STOP') {
      const result = await applyTighten(alpaca, att, pos)
      await logR(ticker, {
        ok: result.ok, decision: 'ESCALATE', actionTaken: result.ok ? 'escalated_tighten' : 'escalated_tighten_failed',
        snap5m, snap15m,
        currentPrice: pos.current_price, currentStop: att.stop_price,
        newStopPrice: result.newStop,
        escalationResult: escalation,
        errorReason: result.ok ? undefined : result.reason,
      })
      if (result.ok && result.newStop !== undefined) {
        await syncTightenedStop(att, result.newStop).catch(e =>
          console.warn(`[${monTag()}] sync-tighten ${ticker}: ${e instanceof Error ? e.message : e}`))
      }
    } else {
      // Council said HOLD or returned ambiguously
      await logR(ticker, {
        ok: true, decision: 'ESCALATE', actionTaken: 'escalated_hold',
        snap5m, snap15m,
        currentPrice: pos.current_price, currentStop: att.stop_price,
        escalationResult: escalation,
      })
    }
    return true
  }

  return false
}

// ─────────────────────────────────────────────────────────────
// DB update helpers — close-out + stop-tighten persistence
// ─────────────────────────────────────────────────────────────
//
// When position-monitor successfully tightens a stop or exits a position,
// we need to update trade_attempts to reflect reality. Otherwise:
//   - stop_price stays at the original Council recommendation forever
//   - outcome stays 'placed' even after the position is closed
//   - track record, dashboard, downstream crons see a lie
//
// Conventions follow the existing lifecycle cron (auto-trade-positions):
//   - outcome: 'closed_win' | 'closed_loss' | 'closed_be' (by P&L sign with $0.005 eps)
//   - realized_pnl: snapshot from (exit - entry) × qty × side_sign
//   - closed_at: ISO timestamp now
//   - closure_kind: 'monitor_exit' (new value, distinct from existing
//     'stop_fired', 'target_hit', 'closed_external')
//
// Note: realized_pnl is computed from current_price snapshot, not the actual
// market sell fill (which we don't have at this moment). It's approximate.
// The actual fill may differ by a few cents. Lifecycle cron could later
// refine this from the close_order_id if needed — a future enhancement.

async function syncTightenedStop(att: OpenAttempt, newStop: number): Promise<void> {
  if (!Number.isFinite(newStop) || newStop <= 0) return
  const admin = await getSupabaseAdmin()
  const { error } = await admin
    .from('trade_attempts')
    .update({ stop_price: newStop })
    .eq('id', att.id)
  if (error) {
    console.warn(`[${monTag()}] sync-tighten ${att.ticker} update failed: ${error.message}`)
    return
  }
  console.log(`[${monTag()}] sync-tighten ${att.ticker}: stop_price -> ${newStop.toFixed(2)}`)
  // Mutate so downstream code sees correct value
  att.stop_price = newStop
}

async function recordExitClosure(
  att: OpenAttempt,
  pos: AlpacaPosition,
  closureKind: 'monitor_exit' | 'escalated_exit' | 'eod_flatten',
): Promise<void> {
  const entryFill = att.filled_avg_price ?? att.entry_price_est
  const exitPrice = pos.current_price
  const qty = att.qty ?? Math.abs(pos.qty)

  if (entryFill === null || !Number.isFinite(exitPrice) || qty <= 0) {
    console.warn(`[${monTag()}] record-exit ${att.ticker}: missing entry/exit/qty, marking closed without P&L`)
    const admin = await getSupabaseAdmin()
    await admin
      .from('trade_attempts')
      .update({
        outcome: 'closed_be',
        closed_at: new Date().toISOString(),
        closure_kind: closureKind,
      })
      .eq('id', att.id)
    return
  }

  // P&L = (exit - entry) × qty × side_sign (buy=+1, sell=-1)
  // Note: this is SNAPSHOT P&L from current_price, not actual fill price.
  // The market sell from applyExit takes a moment to fill at whatever the bid is.
  // For paper trading the difference is usually <$0.05/share. For real money,
  // this is a known small error that lifecycle cron could later correct.
  const sign = att.side === 'sell' ? -1 : 1
  const pnl = (exitPrice - entryFill) * qty * sign
  const eps = 0.005
  let outcome: 'closed_win' | 'closed_loss' | 'closed_be'
  if (pnl > eps) outcome = 'closed_win'
  else if (pnl < -eps) outcome = 'closed_loss'
  else outcome = 'closed_be'

  const admin = await getSupabaseAdmin()
  const { error } = await admin
    .from('trade_attempts')
    .update({
      outcome,
      realized_pnl: Math.round(pnl * 100) / 100,
      closed_at: new Date().toISOString(),
      closure_kind: closureKind,
    })
    .eq('id', att.id)
  if (error) {
    console.warn(`[${monTag()}] record-exit ${att.ticker} update failed: ${error.message}`)
    return
  }
  console.log(
    `[${monTag()}] record-exit ${att.ticker}: ` +
    `${outcome}, pnl $${pnl.toFixed(2)} (entry ${entryFill.toFixed(2)} -> exit ${exitPrice.toFixed(2)}, qty ${qty})`,
  )
}

// ─────────────────────────────────────────────────────────────
// Re-entry — watch exited tickers, re-enter if the directional setup returns
// ─────────────────────────────────────────────────────────────

/**
 * Record an exited ticker on the re-entry watch. Read-first upsert keyed on
 * (user_id, verdict_log_id): a re-exit of a re-entered position updates the same
 * row and never resets reentry_count or revives an exhausted thesis.
 */
async function recordReentryWatch(att: OpenAttempt, pos: AlpacaPosition): Promise<void> {
  if (att.verdict_log_id === null) return                      // need a thesis to re-enter on
  if (att.original_stop_loss === null) return                  // need a stop distance
  const side = att.side === 'sell' ? 'sell' : 'buy'
  const entry = att.filled_avg_price ?? att.entry_price_est
  if (entry === null || !Number.isFinite(entry)) return

  const admin = await getSupabaseAdmin()
  const nowIso = new Date().toISOString()

  const { data: existing } = await admin
    .from('reentry_watch')
    .select('id, reentry_count')
    .eq('user_id', att.user_id)
    .eq('verdict_log_id', att.verdict_log_id)
    .maybeSingle()

  if (existing) {
    const status = Number(existing.reentry_count) >= MAX_REENTRIES ? 'exhausted' : 'watching'
    await admin.from('reentry_watch').update({
      ticker: att.ticker.toUpperCase(),
      side,
      original_entry: entry,
      original_stop: att.original_stop_loss,
      original_target: att.target_price,
      original_qty: att.qty,
      exit_price: pos.current_price,
      exit_at: nowIso,
      status,
      updated_at: nowIso,
    }).eq('id', existing.id)
  } else {
    await admin.from('reentry_watch').insert({
      user_id: att.user_id,
      ticker: att.ticker.toUpperCase(),
      verdict_log_id: att.verdict_log_id,
      side,
      asset_class: att.asset_class ?? 'stock',
      original_entry: entry,
      original_stop: att.original_stop_loss,
      original_target: att.target_price,
      original_qty: att.qty,
      exit_price: pos.current_price,
      exit_at: nowIso,
      reentry_count: 0,
      status: 'watching',
    })
  }
  console.log(`[${monTag()}] ${att.ticker} on re-entry watch (side=${side})`)
}

interface ReentryWatchRow {
  id: string
  ticker: string
  verdict_log_id: number | null
  side: string
  asset_class: string | null
  original_entry: number | null
  original_stop: number | null
  original_target: number | null
  original_qty: number | null
  exit_price: number | null
  exit_at: string
  reentry_count: number
}

/**
 * Re-entry pass: for each watched ticker (within window, under the re-entry cap)
 * that we DON'T currently hold, recompute the directional signal snapshot. If a
 * fresh entry setup is present — bullish signals for a long thesis, bearish for
 * a short — and a 5m bar has closed since the exit (no same-bar rebuy), re-enter
 * at the same size and same stop distance.
 */
async function runReentryPass(
  settings: UserTradingSettings,
  alpaca: AlpacaClient,
  openTickers: Set<string>,
  config: MonitorConfig,
): Promise<void> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - REENTRY_WINDOW_DAYS * 86_400_000).toISOString()

  // Expire stale watches (past the window) so they stop being scanned.
  await admin.from('reentry_watch')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .eq('user_id', settings.userId)
    .eq('status', 'watching')
    .lt('exit_at', cutoff)

  const { data, error } = await admin
    .from('reentry_watch')
    .select('id, ticker, verdict_log_id, side, asset_class, original_entry, original_stop, original_target, original_qty, exit_price, exit_at, reentry_count')
    .eq('user_id', settings.userId)
    .eq('status', 'watching')
    .lt('reentry_count', MAX_REENTRIES)
    .gte('exit_at', cutoff)

  if (error) {
    console.warn(`[${monTag()}] reentry fetch failed user=${settings.userId}: ${error.message}`)
    return
  }
  const rows = (data ?? []) as ReentryWatchRow[]
  if (rows.length === 0) return
  console.log(`[${monTag()}] reentry pass user=${settings.userId}: ${rows.length} watched ticker(s)`)

  for (const w of rows) {
    const ticker = String(w.ticker).toUpperCase()
    if (openTickers.has(ticker)) continue                       // already holding it — never double-enter
    const side = w.side === 'sell' ? 'sell' : 'buy'

    const [bars5m, bars15m] = await Promise.all([
      fetchBarsForTimeframe(ticker, config.fastTimeframe, BARS_TO_FETCH_5MIN),
      fetchBarsForTimeframe(ticker, config.slowTimeframe, BARS_TO_FETCH_15MIN),
    ])
    if (bars5m.length < MIN_BARS || bars15m.length < MIN_BARS) continue

    const t5 = calculateTechnicals(bars5m)
    const t15 = calculateTechnicals(bars15m)
    const snap5 = countSignals(t5, side)
    const snap15 = countSignals(t15, side)

    // Directional entry signal: for a long thesis we want BULLISH signals; for a
    // short thesis we want BEARISH. countSignals already frames bullish/bearish
    // relative to the side, so we read the matching directional count.
    const dir5 = side === 'buy' ? snap5.bullishCount : snap5.bearishCount
    const opp5 = side === 'buy' ? snap5.bearishCount : snap5.bullishCount
    const dir15 = side === 'buy' ? snap15.bullishCount : snap15.bearishCount

    const freshSetup = dir5 >= REENTRY_MIN_SIGNALS && dir5 > opp5 && dir15 >= 1
    if (!freshSetup) {
      await admin.from('reentry_watch').update({ last_checked_at: new Date().toISOString() }).eq('id', w.id)
      continue
    }

    // Rebuy guard: the newest 5m bar must have CLOSED after the exit, so we never
    // re-buy on the same bar we just sold. (The directional setup above is the
    // "indicators/patterns determine a new entry" condition.)
    const lastBarMs = new Date(bars5m[bars5m.length - 1].t).getTime()
    const exitMs = new Date(w.exit_at).getTime()
    if (!Number.isFinite(lastBarMs) || lastBarMs <= exitMs) continue

    await placeReentry(settings, alpaca, w, ticker, side, t5.currentPrice, config).catch(e =>
      console.warn(`[${monTag()}] reentry place ${ticker}: ${e instanceof Error ? e.message : e}`))
  }
}

/**
 * Place a re-entry bracket at the current price using the original size and the
 * SAME stop distance / reward geometry as the original verdict. Inserts a
 * trade_attempts row (so the monitor manages it, including trailing) with an
 * immutable initial_stop so R-multiple trailing is correct for the new entry.
 */
async function placeReentry(
  settings: UserTradingSettings,
  alpaca: AlpacaClient,
  w: ReentryWatchRow,
  ticker: string,
  side: 'buy' | 'sell',
  currentPrice: number,
  config: MonitorConfig,
): Promise<void> {
  const origEntry = w.original_entry !== null ? Number(w.original_entry) : NaN
  const origStop = w.original_stop !== null ? Number(w.original_stop) : NaN
  const origTarget = w.original_target !== null ? Number(w.original_target) : null
  const qty = w.original_qty !== null ? Math.floor(Number(w.original_qty)) : 0

  if (qty <= 0 || !Number.isFinite(origEntry) || !Number.isFinite(origStop) || !Number.isFinite(currentPrice) || currentPrice <= 0) return
  const stopDistance = Math.abs(origEntry - origStop)
  if (stopDistance <= 0) return
  const targetDistance = origTarget !== null && Number.isFinite(origTarget) ? Math.abs(origTarget - origEntry) : stopDistance * 2

  const newStop = side === 'buy' ? currentPrice - stopDistance : currentPrice + stopDistance
  const newTarget = side === 'buy' ? currentPrice + targetDistance : currentPrice - targetDistance
  if (newStop <= 0 || newTarget <= 0) return
  if ((side === 'buy' && newStop >= currentPrice) || (side === 'sell' && newStop <= currentPrice)) return

  const nextCount = Number(w.reentry_count) + 1
  const clientOrderId = `wos-${w.verdict_log_id}-re${nextCount}`

  // Idempotency: if a bracket with this client id already exists, don't re-place.
  const existingOrder = await alpaca.getOrderByClientId(clientOrderId).catch(() => null)
  let orderId: string
  if (existingOrder) {
    orderId = existingOrder.id
  } else {
    const order = await alpaca.bracketOrder({
      symbol: ticker,
      qty,
      side,
      takeProfitPrice: newTarget,
      stopLossPrice: newStop,
      clientOrderId,
    })
    orderId = order.id
  }

  const admin = await getSupabaseAdmin()
  // trade_attempts row so the monitor tracks (and trails) the re-entered position.
  // initial_stop is immutable and drives R-multiple trailing for THIS entry.
  const { error: insErr } = await admin.from('trade_attempts').insert({
    user_id: settings.userId,
    verdict_log_id: w.verdict_log_id,
    ticker,
    outcome: 'placed',
    council_signal: side === 'buy' ? 'BULLISH' : 'BEARISH',
    mode: settings.mode,
    broker: settings.broker,
    broker_order_id: orderId,
    broker_client_id: clientOrderId,
    side,
    qty,
    entry_price_est: currentPrice,
    stop_price: newStop,
    target_price: newTarget,
    initial_stop: newStop,
    council_stop: newStop,
    council_target: newTarget,
    asset_class: w.asset_class ?? 'stock',
    monitor_mode: config.mode,
  })
  if (insErr) {
    console.warn(`[${monTag()}] reentry trade_attempts insert ${ticker}: ${insErr.message}`)
  }

  const status = nextCount >= MAX_REENTRIES ? 'exhausted' : 'watching'
  await admin.from('reentry_watch').update({
    reentry_count: nextCount,
    status,
    last_reentry_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', w.id)

  console.log(`[${monTag()}] ${ticker} RE-ENTRY #${nextCount} ${side} qty=${qty} @ ~${currentPrice.toFixed(2)} stop=${newStop.toFixed(2)} target=${newTarget.toFixed(2)}`)
}

// ─────────────────────────────────────────────────────────────
// Action helpers
// ─────────────────────────────────────────────────────────────

interface TightenResult { ok: boolean; reason?: string; newStop?: number }

async function applyTighten(
  alpaca: AlpacaClient,
  att: OpenAttempt,
  pos: AlpacaPosition,
): Promise<TightenResult> {
  if (!att.broker_order_id) {
    return { ok: false, reason: 'no broker_order_id on attempt' }
  }
  // Compute new stop: midpoint between current price and current stop, rounded
  // up to ensure it actually tightens. For long: new_stop = max(current_stop, midpoint).
  const current = pos.current_price
  const oldStop = att.stop_price ?? (att.entry_price_est ?? current) * 0.97
  // Midpoint, but only move stop UP (longs) — never widen it
  const midpoint = (current + oldStop) / 2
  const newStop = att.side === 'buy'
    ? Math.max(oldStop, midpoint)
    : Math.min(oldStop, midpoint)

  // Don't tighten if the new stop would be within 0.3% of current price (too close, gets stopped on noise)
  const minDistance = current * 0.003
  const adjustedNewStop = att.side === 'buy'
    ? Math.min(newStop, current - minDistance)
    : Math.max(newStop, current + minDistance)

  if ((att.side === 'buy' && adjustedNewStop <= oldStop) ||
      (att.side === 'sell' && adjustedNewStop >= oldStop)) {
    return { ok: false, reason: `computed new stop ${adjustedNewStop.toFixed(2)} not tighter than current ${oldStop.toFixed(2)}` }
  }

  try {
    const parent = await alpaca.getOrder(att.broker_order_id) as unknown as {
      legs?: Array<{ id: string; type?: string; order_type?: string; status?: string }>
    }
    const legs = parent.legs ?? []
    const stopLeg = legs.find(l => {
      const t = (l.type ?? l.order_type ?? '').toLowerCase()
      const s = (l.status ?? '').toLowerCase()
      return (t === 'stop' || t === 'stop_limit') && (s === 'new' || s === 'accepted' || s === 'held' || s === 'pending_new')
    })
    if (!stopLeg) return { ok: false, reason: 'no active stop leg found on parent', newStop: adjustedNewStop }

    await (alpaca as unknown as { request: (m: string, p: string, body?: unknown) => Promise<unknown> })
      .request('PATCH', `/v2/orders/${encodeURIComponent(stopLeg.id)}`, { stop_price: adjustedNewStop.toFixed(2) })

    return { ok: true, newStop: adjustedNewStop }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e), newStop: adjustedNewStop }
  }
}

/**
 * Profit-based trailing stop (R-multiple milestones).
 *
 * Distinct from applyTighten (which reacts to bearish signals with a midpoint
 * nudge): this runs every cycle on a winning long and ratchets the stop up to
 * lock in gains — breakeven at +1R, +0.5R at +2R, +1.5R at +3R, then a 1R
 * trail at +4R+. It needs the IMMUTABLE original stop (att.original_stop_loss,
 * the Council's verdict stop) to compute R, because att.stop_price has already
 * been moved up by prior tightens/trails.
 *
 * Applies through the same Alpaca bracket-stop-leg PATCH path as applyTighten,
 * then persists via syncTightenedStop. Only ever moves the stop UP.
 */
interface TrailResult { applied: boolean; newStop?: number; milestone?: string; reason?: string }

async function applyTrailingStop(alpaca: AlpacaClient, att: OpenAttempt, pos: AlpacaPosition): Promise<TrailResult> {
  if (att.side && att.side !== 'buy') return { applied: false, reason: 'short side not supported' }
  // Fractional / monitor-owned positions have no bracket leg to PATCH — their
  // stop is armed and trailed in ensureMonitorOwnedStop (earlier in the run).
  if (att.monitor_owned_stop) return { applied: false, reason: 'monitor-owned stop (trailed in ensureMonitorOwnedStop)' }
  if (!att.broker_order_id) return { applied: false, reason: 'no broker_order_id' }

  const entry = att.filled_avg_price ?? att.entry_price_est
  if (entry === null || att.stop_price === null || att.original_stop_loss === null) {
    return { applied: false, reason: 'missing entry / stop / original_stop_loss' }
  }

  const trail: TrailingStopResult | null = computeTrailingStop({
    side: 'buy',
    entryPrice: entry,
    currentPrice: pos.current_price,
    currentStop: att.stop_price,
    originalStop: att.original_stop_loss,
  })
  if (!trail) return { applied: false, reason: 'no milestone reached / not in profit' }

  try {
    const parent = await alpaca.getOrder(att.broker_order_id) as unknown as {
      legs?: Array<{ id: string; type?: string; order_type?: string; status?: string }>
    }
    const legs = parent.legs ?? []
    const stopLeg = legs.find(l => {
      const t = (l.type ?? l.order_type ?? '').toLowerCase()
      const s = (l.status ?? '').toLowerCase()
      return (t === 'stop' || t === 'stop_limit') && (s === 'new' || s === 'accepted' || s === 'held' || s === 'pending_new')
    })
    if (!stopLeg) return { applied: false, reason: 'no active stop leg found on parent', newStop: trail.newStop }

    await (alpaca as unknown as { request: (m: string, p: string, body?: unknown) => Promise<unknown> })
      .request('PATCH', `/v2/orders/${encodeURIComponent(stopLeg.id)}`, { stop_price: trail.newStop.toFixed(2) })
  } catch (e) {
    return { applied: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e), newStop: trail.newStop }
  }

  await syncTightenedStop(att, trail.newStop).catch(e =>
    console.warn(`[${monTag()}] sync-trail ${att.ticker}: ${e instanceof Error ? e.message : e}`))

  return { applied: true, newStop: trail.newStop, milestone: trail.milestone }
}

interface ExitResult { ok: boolean; reason?: string }

/**
 * Close a bracket position safely.
 *
 * The position's shares are reserved by the bracket's stop and take-profit
 * children. DELETE /v2/positions/{symbol} alone fails with HTTP 403
 * "insufficient qty available for order (requested: N, available: 0)"
 * because those reserved shares can't be sold by a second order.
 *
 * Correct procedure per Alpaca docs:
 *   1. List open orders for the symbol
 *   2. Cancel each open child order
 *   3. Wait briefly for cancellations to propagate (race condition warning
 *      from Alpaca's docs — sending close immediately after cancel can fail)
 *   4. DELETE /v2/positions/{symbol}
 *
 * If step 4 still fails, the broker stop remains in place — position stays
 * protected at the bracket stop level. Not catastrophic, just not the
 * immediate market exit we wanted.
 */
// ── End-of-day flatten (day monitor only) ─────────────────────────────────
// Day-owned positions (monitor_mode='day' — currently earnings-window trades)
// are flattened before the session close so they never carry overnight gap
// risk through an earnings print. Timing comes from Alpaca's clock (next_close)
// so DST and half-days are handled. We act in a [floor, lead] window before
// close; the floor (>=5 min) leaves the market close orders time to fill before
// the bell, avoiding the after-hours-queue problem that strands a position
// unprotected overnight (the KLAC failure mode).
const EOD_FLATTEN_LEAD_MIN = 15
const EOD_FLATTEN_FLOOR_MIN = 5

// Decide, for a day-owned position, whether we must flatten it now (before its
// earnings print) or can still hold it overnight. `ev` is the nearest upcoming
// earnings event for the ticker (from earnings_watch), or undefined if none.
//   - no upcoming earnings        -> flatten (plain intraday day trade)
//   - bmo print on report_date    -> last safe hold session is report_date - 1
//   - amc/dmh/unknown on report_date -> last safe hold session is report_date
// We flatten once today >= that last-safe session; otherwise we ride overnight.
// This is what lets a multi-day pre-earnings run-up hold through to the print
// session and exit just before the binary event, instead of flattening every
// EOD (intraday earnings trades) or holding straight through it (swing).
function shouldFlattenForPrint(
  today: string,
  ev: { report_date: string; report_hour: string | null } | undefined,
): { flatten: boolean; reason: string } {
  if (!ev) return { flatten: true, reason: 'day_trade_no_earnings' }
  const hour = (ev.report_hour ?? '').toLowerCase()
  let mustBeFlatBy = ev.report_date
  if (hour === 'bmo') {
    const d = new Date(`${ev.report_date}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 1)
    mustBeFlatBy = d.toISOString().split('T')[0]
  }
  if (today >= mustBeFlatBy) {
    return { flatten: true, reason: `pre_print_flatten (reports ${ev.report_date} ${hour || 'unknown'})` }
  }
  return { flatten: false, reason: `holding_runup (reports ${ev.report_date} ${hour || 'unknown'}, not yet imminent)` }
}

async function flattenDayPositionsAtClose(
  settings: UserTradingSettings,
  alpaca: AlpacaClient,
  positions: AlpacaPosition[],
  attemptsByTicker: Map<string, OpenAttempt>,
  userSummary: PerUserSummary,
  config: MonitorConfig,
): Promise<boolean> {
  if (config.mode !== 'day') return false
  const clock = await alpaca.getClock().catch(() => null)
  if (!clock || !clock.isOpen || !clock.nextClose || !clock.timestamp) return false
  const minsToClose = (Date.parse(clock.nextClose) - Date.parse(clock.timestamp)) / 60000
  if (!Number.isFinite(minsToClose)) return false
  if (minsToClose > EOD_FLATTEN_LEAD_MIN || minsToClose < EOD_FLATTEN_FLOOR_MIN) return false

  // Today's trading date (UTC date == ET date at the ~close-time this runs).
  const today = (clock.timestamp.split('T')[0]) || new Date().toISOString().split('T')[0]

  // One lookup: nearest upcoming earnings for every day-owned ticker, so we can
  // decide hold-overnight vs flatten-before-print per position.
  const dayTickers = positions
    .map(p => p.symbol.toUpperCase())
    .filter(sym => attemptsByTicker.has(sym))
  const earningsByTicker = new Map<string, { report_date: string; report_hour: string | null }>()
  if (dayTickers.length > 0) {
    try {
      const admin = await getSupabaseAdmin()
      const { data } = await admin
        .from('earnings_watch')
        .select('ticker, report_date, report_hour')
        .in('ticker', dayTickers)
        .gte('report_date', today)
        .in('status', ['watching', 'analyzed', 'entered'])
        .order('report_date', { ascending: true })
      for (const r of (data ?? []) as Array<{ ticker: string; report_date: string; report_hour: string | null }>) {
        const k = r.ticker.toUpperCase()
        if (!earningsByTicker.has(k)) earningsByTicker.set(k, { report_date: r.report_date, report_hour: r.report_hour })
      }
    } catch (e) {
      // If the lookup fails, fall back to the safe default (flatten) below.
      console.warn(`[${config.label}] earnings_watch lookup failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  console.log(`[${config.label}] EOD flatten window (${minsToClose.toFixed(1)} min to close) — evaluating ${dayTickers.length} day-owned position(s)`)
  for (const pos of positions) {
    const sym = pos.symbol.toUpperCase()
    const att = attemptsByTicker.get(sym)
    if (!att) continue  // ownership filter already applied upstream; leave non-day rows

    const decision = shouldFlattenForPrint(today, earningsByTicker.get(sym))
    if (!decision.flatten) {
      console.log(`[${config.label}] ${sym} HOLD overnight — ${decision.reason}`)
      continue  // multi-day run-up still mid-flight; ride it
    }

    userSummary.positionsChecked++
    try {
      const result = await applyExit(alpaca, pos)
      if (result.ok) userSummary.exits++
      await logResult(settings, att, pos.symbol, {
        ok: result.ok, decision: 'EXIT',
        actionTaken: result.ok ? 'eod_flatten' : 'eod_flatten_failed',
        snap5m: emptySnapshot(), snap15m: emptySnapshot(),
        currentPrice: pos.current_price, currentStop: att.stop_price,
        errorReason: result.ok ? undefined : result.reason,
      }, config.mode)
      if (result.ok) {
        console.log(`[${config.label}] ${sym} FLATTEN @ ~${pos.current_price.toFixed(2)} — ${decision.reason}`)
        await recordExitClosure(att, pos, 'eod_flatten').catch(e =>
          console.warn(`[${config.label}] record-exit ${sym}: ${e instanceof Error ? e.message : e}`))
      } else {
        console.warn(`[${config.label}] ${sym} FLATTEN failed: ${result.reason}`)
      }
    } catch (e) {
      userSummary.errors++
      console.error(`[${config.label}] flatten ${sym} failed:`, e instanceof Error ? e.message : e)
    }
  }
  return true
}

/**
 * Arm, re-arm, and TRAIL a broker-side protective stop for a monitor-owned
 * (fractional) position. Fractional stops are DAY tif and expire each close, so
 * this runs every monitor cycle:
 *   - no broker stop open  → arm one at the desired level (covers initial arm
 *     and the daily re-arm after DAY expiry)
 *   - a new R-multiple milestone raised the stop → cancel the old stop, place a
 *     new one at the higher level, and persist it (so the hard-breach check and
 *     the next run both see the trailed level)
 *   - otherwise            → leave the existing stop in place
 * Best-effort — the monitor's hard stop-breach close is the backstop for the
 * brief unarmed window and overnight.
 */
async function ensureMonitorOwnedStop(
  alpaca: AlpacaClient,
  att: OpenAttempt,
  pos: AlpacaPosition,
  stopLevel: number,
  side: 'buy' | 'sell',
): Promise<void> {
  if (side !== 'buy') return // trailing/arming is long-only for now
  const symbol = att.ticker
  const exitSide: 'buy' | 'sell' = 'sell'
  const qty = Math.abs(Number(att.qty ?? pos.qty ?? 0))
  if (!Number.isFinite(qty) || qty <= 0) return

  // Desired stop: ratchet up via the same R-multiple milestones as bracket
  // positions, never below the tracked stop, never at/above current price.
  let desired = stopLevel
  const entry = att.filled_avg_price ?? att.entry_price_est
  if (entry !== null && att.original_stop_loss !== null) {
    const trail = computeTrailingStop({
      side: 'buy',
      entryPrice: entry,
      currentPrice: pos.current_price,
      currentStop: stopLevel,
      originalStop: att.original_stop_loss,
    })
    if (trail && trail.newStop > desired) desired = trail.newStop
  }
  const cap = pos.current_price * 0.997 // keep ≥0.3% below price so it doesn't insta-trigger
  if (desired > cap) desired = cap
  if (!Number.isFinite(desired) || desired <= 0) return

  const open = await alpaca.openOrders(symbol)
  const existing = open.find(o => {
    const t = (o.type ?? '').toLowerCase()
    return (t === 'stop' || t === 'stop_limit') && o.side === exitSide
  })
  const trailedUp = desired > stopLevel + 1e-6

  // Already armed at the right level → nothing to do.
  if (existing && !trailedUp) return
  // Trailing up → replace the existing stop with one at the higher level.
  if (existing && trailedUp) await alpaca.cancelOrder(existing.id).catch(() => {})

  await alpaca.fractionalStopOrder({ symbol, qty, stopPrice: desired, side: exitSide })
  if (trailedUp) {
    // Persist so the hard-breach check and the next run use the trailed level.
    await syncTightenedStop(att, desired).catch(e =>
      console.warn(`[${monTag()}] sync-trail ${symbol}: ${e instanceof Error ? e.message : e}`))
  }
  console.log(`[${monTag()}] ${symbol} stop ${existing ? 'trailed' : 'armed'} @ ${desired.toFixed(2)} (monitor-owned, qty=${qty})`)
}

async function applyExit(alpaca: AlpacaClient, pos: AlpacaPosition): Promise<ExitResult> {
  const symbol = pos.symbol
  // IMPORTANT: do NOT extract `request` as a const — that loses the `this`
  // binding inside the AlpacaClient and the call fails with
  // "Cannot read properties of undefined (reading 'baseUrl')".
  // Always call alpaca.request(...) inline so `this` is preserved.
  // Cast on each call site is the cheapest way to satisfy the type checker.
  const callAlpaca = (m: string, p: string, body?: unknown): Promise<unknown> =>
    (alpaca as unknown as {
      request: (m: string, p: string, body?: unknown) => Promise<unknown>
    }).request(m, p, body)

  try {
    // Step 1: list open orders for this symbol
    const ordersResp = await callAlpaca('GET', `/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}&limit=50`) as Array<{ id: string; status?: string }>
    const orders: Array<{ id: string; status?: string }> = Array.isArray(ordersResp) ? ordersResp : []

    // Step 2: cancel each open order (these are the bracket children)
    if (orders.length > 0) {
      const cancelPromises = orders.map(o =>
        callAlpaca('DELETE', `/v2/orders/${encodeURIComponent(o.id)}`)
          .then(() => ({ id: o.id, ok: true }))
          .catch((e: unknown) => ({
            id: o.id, ok: false,
            err: e instanceof Error ? e.message : String(e),
          })),
      )
      const cancelResults = await Promise.all(cancelPromises)
      const cancelOk = cancelResults.filter(r => r.ok).length
      const cancelFail = cancelResults.length - cancelOk
      console.log(
        `[${monTag()}] applyExit ${symbol}: ` +
        `cancelled ${cancelOk}/${cancelResults.length} bracket children` +
        (cancelFail > 0 ? ` (${cancelFail} failed)` : ''),
      )

      // Step 3: brief wait for cancellations to propagate.
      // Alpaca's docs explicitly warn that close-immediately-after-cancel
      // can fail with the same insufficient-qty error if the system hasn't
      // released the shares yet. 750ms is empirically sufficient for paper;
      // live trading may need more.
      await new Promise(resolve => setTimeout(resolve, 750))
    }

    // Step 4: DELETE the position. Now that bracket children are cancelled,
    // shares are free and the close-at-market should succeed.
    await callAlpaca('DELETE', `/v2/positions/${encodeURIComponent(symbol)}`)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: msg.slice(0, 300) }
  }
}

// ─────────────────────────────────────────────────────────────
// Escalation to Council
// ─────────────────────────────────────────────────────────────

interface EscalationResult {
  action: 'HOLD' | 'TIGHTEN_STOP' | 'EXIT'
  rationale: string
  confidence: number
  raw?: unknown
}

/**
 * Call the existing thesis-check endpoint that the reeval cron uses.
 * This is the only LLM-touching path in this cron.
 */
async function escalateToCouncil(
  settings: UserTradingSettings,
  att: OpenAttempt,
  pos: AlpacaPosition,
  triggerReason: string,
): Promise<EscalationResult> {
  try {
    const rawBase = process.env.APP_BASE_URL ?? ''
    if (!rawBase) {
      return { action: 'HOLD', rationale: 'APP_BASE_URL not set; cannot escalate', confidence: 0 }
    }
    const baseUrl = (rawBase.startsWith('http://') || rawBase.startsWith('https://'))
      ? rawBase.replace(/\/+$/, '')
      : `https://${rawBase.replace(/\/+$/, '')}`

    // If we don't have a verdict_log_id, we can't call thesis-check (the endpoint
    // requires verdictId to look up the original verdict). Skip to safe HOLD.
    if (att.verdict_log_id === null || att.verdict_log_id === undefined) {
      return { action: 'HOLD', rationale: 'no verdict_log_id on attempt; cannot escalate', confidence: 0 }
    }

    // Compute unrealized P/L % from entry to current
    const entry = pos.avg_entry_price ?? att.filled_avg_price ?? att.entry_price_est ?? 0
    let unrealizedPnlPct = 0
    if (entry > 0) {
      const dir = att.side === 'sell' ? -1 : 1
      unrealizedPnlPct = ((pos.current_price - entry) / entry) * 100 * dir
    }

    const res = await fetch(`${baseUrl}/api/reeval-thesis-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
        'x-service-trigger': 'position-monitor',
        'x-service-user-id': settings.userId,
      },
      // Field names must match ThesisCheckRequest interface exactly:
      //   verdictId (number), currentPrice, unrealizedPnlPct, triggersFired (array)
      body: JSON.stringify({
        verdictId: att.verdict_log_id,
        currentPrice: pos.current_price,
        unrealizedPnlPct,
        triggersFired: [`position_monitor: ${triggerReason}`],
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      return {
        action: 'HOLD',
        rationale: `thesis-check returned ${res.status}: ${errBody.slice(0, 150)}`,
        confidence: 0,
      }
    }
    const data = await res.json() as { action?: string; rationale?: string; confidence?: number }
    const action = (data.action ?? 'hold').toLowerCase()
    if (action === 'early_exit') return { action: 'EXIT', rationale: data.rationale ?? '', confidence: data.confidence ?? 0, raw: data }
    if (action === 'tighten_stop') return { action: 'TIGHTEN_STOP', rationale: data.rationale ?? '', confidence: data.confidence ?? 0, raw: data }
    return { action: 'HOLD', rationale: data.rationale ?? '', confidence: data.confidence ?? 0, raw: data }
  } catch (e) {
    return { action: 'HOLD', rationale: `escalation error: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`, confidence: 0 }
  }
}

// ─────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────

// Lightweight ownership probe: the set of tickers this user has an OPEN
// position-attempt for under a given monitor mode. Selects only `ticker`
// (a base column) so it can't be tripped by a stale schema cache on newer
// columns. Used to distinguish "owned by the OTHER monitor" (expected — info)
// from a genuine orphan (broker has it, DB doesn't in either mode — a real warn).
async function fetchOwnedTickers(userId: string, mode: MonitorMode): Promise<Set<string>> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data, error } = await admin
    .from('trade_attempts')
    .select('ticker')
    .eq('user_id', userId)
    .eq('monitor_mode', mode)
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .gte('created_at', cutoff)
  if (error || !data) return new Set()
  return new Set((data as Array<{ ticker: string }>).map(r => String(r.ticker).toUpperCase()))
}

async function fetchOpenAttempts(userId: string, mode: MonitorMode = 'swing'): Promise<Map<string, OpenAttempt>> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()

  // Note (June 23 2026): the previous `.or('asset_class.is.null,asset_class.eq.stocks,asset_class.eq.stock')`
  // chained with `.in('outcome', ...)` was silently returning an empty result
  // set under PostgREST when both were used together. Symptom: position-monitor
  // logged "trade_attempts has 0 open rows" despite 4 rows existing.
  //
  // Fix: use a plain `.in('asset_class', [...])` and run a SECOND query for
  // legacy NULL rows. Both errors are now logged explicitly.
  // Resilience: select the full column set, but if a newly-added column is
  // missing (migration not run yet / stale PostgREST cache), retry WITHOUT it
  // instead of failing the whole query and blinding the monitor to every
  // position. The row mapping defaults any absent column safely.
  const COLS_FULL = 'id, user_id, ticker, side, qty, filled_avg_price, entry_price_est, stop_price, target_price, broker_order_id, verdict_log_id, initial_stop, outcome, asset_class, monitor_owned_stop'
  const COLS_BASE = 'id, user_id, ticker, side, qty, filled_avg_price, entry_price_est, stop_price, target_price, broker_order_id, verdict_log_id, initial_stop, outcome, asset_class'

  const isMissingColumn = (err: { code?: string; message?: string } | null): boolean => {
    if (!err) return false
    const code = err.code ?? ''
    const msg = (err.message ?? '').toLowerCase()
    return code === 'PGRST204' || code === '42703' || msg.includes('does not exist') || msg.includes('column')
  }

  const selectAttempts = async (
    legacyNull: boolean,
  ): Promise<{ data: Array<Record<string, unknown>> | null; error: { code?: string; message?: string } | null }> => {
    const run = async (cols: string) => {
      const base = admin.from('trade_attempts').select(cols).eq('user_id', userId)
      const scoped = legacyNull ? base.is('asset_class', null) : base.in('asset_class', ['stock', 'stocks'])
      const { data, error } = await scoped
        .eq('monitor_mode', mode)
        .in('outcome', ['placed', 'filled', 'partial_fill'])
        .gte('created_at', cutoff)
      return {
        data: (data ?? null) as Array<Record<string, unknown>> | null,
        error: (error ?? null) as { code?: string; message?: string } | null,
      }
    }
    let res = await run(COLS_FULL)
    if (res.error && isMissingColumn(res.error)) {
      console.warn(
        `[${monTag()}] fetchOpenAttempts: a selected column is missing — run the pending migration. ` +
        `Retrying without new columns so monitoring isn't blocked. (${res.error.message})`,
      )
      res = await run(COLS_BASE)
    }
    return res
  }

  const { data, error } = await selectAttempts(false)

  if (error) {
    console.error(`[${monTag()}] fetchOpenAttempts main query failed for user=${userId}:`, error.message)
    return new Map()
  }

  // Legacy: rows created before the asset_class column was added may have NULL.
  // Quick second query — if it errors we just skip the legacy rows.
  const { data: legacyData, error: legacyError } = await selectAttempts(true)

  if (legacyError) {
    console.warn(`[${monTag()}] fetchOpenAttempts legacy NULL query failed for user=${userId} (ignoring):`, legacyError.message)
  }

  const combined: Array<Record<string, unknown>> = []
  combined.push(...((data ?? []) as Array<Record<string, unknown>>))
  combined.push(...((legacyData ?? []) as Array<Record<string, unknown>>))

  const map = new Map<string, OpenAttempt>()
  for (const row of combined) {
    const att: OpenAttempt = {
      id: String(row.id),
      user_id: String(row.user_id),
      ticker: String(row.ticker),
      side: (row.side as 'buy' | 'sell' | null) ?? null,
      qty: row.qty !== null && row.qty !== undefined ? Number(row.qty) : null,
      filled_avg_price: row.filled_avg_price !== null && row.filled_avg_price !== undefined ? Number(row.filled_avg_price) : null,
      entry_price_est: row.entry_price_est !== null && row.entry_price_est !== undefined ? Number(row.entry_price_est) : null,
      stop_price: row.stop_price !== null && row.stop_price !== undefined ? Number(row.stop_price) : null,
      target_price: row.target_price !== null && row.target_price !== undefined ? Number(row.target_price) : null,
      broker_order_id: row.broker_order_id !== null && row.broker_order_id !== undefined ? String(row.broker_order_id) : null,
      monitor_owned_stop: row.monitor_owned_stop === true,
      verdict_log_id: row.verdict_log_id !== null && row.verdict_log_id !== undefined ? Number(row.verdict_log_id) : null,
      // Prefer the per-attempt immutable initial_stop (set on re-entries, whose
      // stop sits at a new price). Falls back to verdict_log.stop_loss below for
      // original entries that don't carry it. (council_stop is NOT used — reeval
      // overwrites it when it moves the stop, so it isn't immutable.)
      original_stop_loss: row.initial_stop !== null && row.initial_stop !== undefined && Number.isFinite(Number(row.initial_stop))
        ? Number(row.initial_stop) : null,
      outcome: String(row.outcome),
      asset_class: row.asset_class !== null && row.asset_class !== undefined ? String(row.asset_class) : null,
    }
    map.set(att.ticker.toUpperCase(), att)
  }

  // Enrich with the Council's ORIGINAL stop from verdict_log (immutable —
  // stop_price on the attempt gets moved up by tightening/trailing, so it
  // can't be used to compute R-multiples). Done as a separate batched query
  // rather than a PostgREST embedded join: this file was previously bitten by
  // the .or().in() silent-empty bug, so we avoid adding joins to that path.
  const verdictIds = Array.from(
    new Set(Array.from(map.values())
      .filter(a => a.original_stop_loss === null)
      .map(a => a.verdict_log_id)
      .filter((v): v is number => v !== null))
  )
  if (verdictIds.length > 0) {
    const { data: vData, error: vError } = await admin
      .from('verdict_log')
      .select('id, stop_loss')
      .in('id', verdictIds)
    if (vError) {
      console.warn(`[${monTag()}] verdict_log stop_loss lookup failed (trailing will no-op):`, vError.message)
    } else {
      const stopById = new Map<number, number>()
      for (const r of (vData ?? []) as Array<{ id: number; stop_loss: number | string | null }>) {
        const sl = r.stop_loss !== null && r.stop_loss !== undefined ? Number(r.stop_loss) : null
        if (sl !== null && Number.isFinite(sl)) stopById.set(Number(r.id), sl)
      }
      for (const att of map.values()) {
        if (att.original_stop_loss === null && att.verdict_log_id !== null && stopById.has(att.verdict_log_id)) {
          att.original_stop_loss = stopById.get(att.verdict_log_id)!
        }
      }
    }
  }

  return map
}

async function isInCooldown(tradeAttemptId: string, cooldownMin: number): Promise<boolean> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - cooldownMin * 60_000).toISOString()
  const { count } = await admin
    .from('position_monitor_log')
    .select('id', { count: 'exact', head: true })
    .eq('trade_attempt_id', tradeAttemptId)
    .in('action_taken', ['tightened', 'exited', 'escalated_exit', 'escalated_tighten'])
    .gt('created_at', cutoff)
  return (count ?? 0) > 0
}

interface LogPayload {
  ok: boolean
  decision: Decision
  actionTaken: string
  snap5m: SignalSnapshot
  snap15m: SignalSnapshot
  currentPrice: number
  currentStop: number | null
  newStopPrice?: number
  escalationResult?: EscalationResult
  errorReason?: string
  // Bar-health diagnostics (optional; set on the main processPosition path)
  barsFastCount?: number | null
  barsSlowCount?: number | null
  slowBarAgeMin?: number | null
}

async function logResult(
  settings: UserTradingSettings,
  att: OpenAttempt,
  ticker: string,
  payload: LogPayload,
  monitorMode: MonitorMode = 'swing',
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('position_monitor_log').insert({
    user_id: settings.userId,
    trade_attempt_id: att.id,
    ticker,
    monitor_mode: monitorMode,
    asset_class: att.asset_class ?? 'stock',
    bearish_count_5m: payload.snap5m.bearishCount,
    bearish_count_15m: payload.snap15m.bearishCount,
    bullish_count_5m: payload.snap5m.bullishCount,
    bullish_count_15m: payload.snap15m.bullishCount,
    bars_fast_count: payload.barsFastCount ?? null,
    bars_slow_count: payload.barsSlowCount ?? null,
    slow_bar_age_min: payload.slowBarAgeMin ?? null,
    signals_5m: payload.snap5m.bearishSignals,
    signals_15m: payload.snap15m.bearishSignals,
    decision: payload.decision,
    action_taken: payload.actionTaken,
    escalation_result: payload.escalationResult ?? null,
    current_price: payload.currentPrice,
    current_stop: payload.currentStop,
    new_stop_price: payload.newStopPrice ?? null,
    ok: payload.ok,
    error_reason: payload.errorReason ?? null,
  })
}

// ─────────────────────────────────────────────────────────────
// Settings reader (defensive cast — settings.ts may not surface yet)
// ─────────────────────────────────────────────────────────────

interface PMSettings {
  exitThreshold15m: number
  exitThreshold5m: number
  tightenThreshold15m: number
  cooldownMin: number
  escalateOnConflict: boolean
}

function pmSettingsFrom(s: UserTradingSettings): PMSettings {
  // settings.ts surfaces the pm_* columns directly now (Migration 14 + the
  // settings.ts update that landed alongside this fix). Read them as typed
  // fields. The ?? fallbacks remain only for safety against stale settings
  // shape during deploy-window race conditions.
  return {
    exitThreshold15m: s.pmExitThreshold15m ?? 3,
    exitThreshold5m: s.pmExitThreshold5m ?? 4,
    tightenThreshold15m: s.pmTightenThreshold15m ?? 3,
    cooldownMin: s.pmCooldownMin ?? 10,
    escalateOnConflict: s.pmEscalateOnConflict ?? true,
  }
}

function isAssetClassEnabled(s: UserTradingSettings, ac: AssetClass): boolean {
  if (ac === 'stock') return s.tradeStocks
  if (ac === 'crypto') return s.tradeCrypto
  if (ac === 'forex') return s.tradeForex
  if (ac === 'futures') return s.tradeFutures
  return false
}

// ─────────────────────────────────────────────────────────────
// Bars helper — wraps the Alpaca data API for our timeframes
// ─────────────────────────────────────────────────────────────
//
// The existing fetchBars() helper in app/lib/data/alpaca.ts uses Council
// timeframe strings (1D/1W/1M/3M) and maps them to bar params internally.
// We need 5min and 15min, which aren't part of that mapping. So we call
// fetchBars with timeframe="1D" (returns 15min bars over 30d) and slice
// what we need, plus a direct fetch for 5min bars.
//
// To keep this self-contained for now, we shell out to Alpaca's raw
// /v2/stocks/bars endpoint directly here.

interface AlpacaBarRaw {
  t: string; o: number; h: number; l: number; c: number; v: number
}

async function fetchBarsForTimeframe(
  ticker: string,
  timeframe: '5Min' | '15Min' | '1H' | '1D',
  limit: number,
): Promise<AlpacaBarRaw[]> {
  // 15Min / 1H / 1D map onto the existing fetchBars() ranges, which already
  // handle SIP/IEX fallback and pagination:
  //   '1D' range  → 15-minute bars
  //   '1W' range  → 1-hour bars
  //   '1M' range  → daily bars
  if (timeframe === '15Min') {
    const bars = await fetchBars(ticker, '1D').catch(() => [])
    return bars.slice(-limit) as AlpacaBarRaw[]
  }
  if (timeframe === '1H') {
    const bars = await fetchBars(ticker, '1W').catch(() => [])
    return bars.slice(-limit) as AlpacaBarRaw[]
  }
  if (timeframe === '1D') {
    const bars = await fetchBars(ticker, '1M').catch(() => [])
    return bars.slice(-limit) as AlpacaBarRaw[]
  }

  // 5Min: direct fetch.
  try {
    const BASE = process.env.ALPACA_BASE_URL || 'https://data.alpaca.markets'
    const end = new Date()
    const start = new Date(end.getTime() - 2 * 86_400_000) // 2 days lookback for 5-min
    const startStr = start.toISOString().split('T')[0]
    const endStr = end.toISOString().split('T')[0]
    const url =
      `${BASE}/v2/stocks/${ticker}/bars?timeframe=5Min&start=${startStr}&end=${endStr}` +
      `&limit=${limit * 3}&adjustment=all&feed=sip`
    const res = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY ?? '',
        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY ?? '',
        Accept: 'application/json',
      },
    })
    if (!res.ok) return []
    const data = await res.json() as { bars?: AlpacaBarRaw[] }
    const bars = data.bars ?? []
    return bars.slice(-limit)
  } catch {
    return []
  }
}

function emptySnapshot(): SignalSnapshot {
  return { bearishCount: 0, bullishCount: 0, bearishSignals: [], bullishSignals: [] }
}
