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

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers, type UserTradingSettings, type AssetClass } from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import { makeAlpacaClient, type AlpacaClient, type AlpacaPosition } from '@/app/lib/trading/alpaca-client'
import { fetchBars } from '@/app/lib/data/alpaca'
import { calculateTechnicals } from '@/app/lib/signals/technicals'
import { countSignals, decide, computeTrailingStop, type SignalSnapshot, type Decision, type TrailingStopResult } from '@/app/lib/trading/position-monitor-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary: CronSummary = { users: [], durationMs: 0, totalActions: 0 }

  try {
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
        await processUser(settings, userSummary)
      } catch (e) {
        userSummary.errors++
        console.error(`[position-monitor] user=${settings.userId} fatal:`, e instanceof Error ? e.message : e)
      }
      summary.totalActions += userSummary.tightens + userSummary.exits + userSummary.escalates
      summary.users.push(userSummary)
    }
  } catch (e) {
    console.error('[position-monitor cron] outer:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(
    `[position-monitor cron] done in ${summary.durationMs}ms users=${summary.users.length} ` +
    `totalActions=${summary.totalActions}`
  )
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────
// Per-user processing
// ─────────────────────────────────────────────────────────────

async function processUser(settings: UserTradingSettings, userSummary: PerUserSummary): Promise<void> {
  // Read PM-specific settings via defensive cast (the migration adds these
  // columns; the settings loader may not surface them until we update it)
  const pmSettings = pmSettingsFrom(settings)

  // Load broker — explicitly pass 'stock' (singular, matches DB) so we get
  // the alpaca stocks credential row, not crypto or another asset class
  const credLoad = await loadBrokerCredentialForUse(settings.userId, settings.broker, settings.mode, 'stock')
  if (!credLoad) {
    console.warn(`[position-monitor] user=${settings.userId} no broker credentials for ${settings.broker}/${settings.mode}/stock`)
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
      `[position-monitor] user=${settings.userId} alpaca.positions() THREW:`,
      e instanceof Error ? `${e.message}\n${e.stack ?? ''}`.slice(0, 600) : String(e).slice(0, 300),
    )
    userSummary.errors++
    return
  }
  if (positions.length === 0) {
    console.log(`[position-monitor] user=${settings.userId} alpaca returned 0 open positions`)
    // Don't return early — exited tickers may still be on the re-entry watch,
    // which is scanned below regardless of whether anything is open right now.
    await runReentryPass(settings, alpaca, new Set<string>()).catch(e =>
      console.warn(`[position-monitor] reentry pass user=${settings.userId}: ${e instanceof Error ? e.message : e}`))
    return
  }
  console.log(
    `[position-monitor] user=${settings.userId} alpaca returned ${positions.length} positions: ` +
    positions.map(p => `${p.symbol}(qty=${p.qty})`).join(','),
  )

  const attemptsByTicker = await fetchOpenAttempts(settings.userId)
  console.log(
    `[position-monitor] user=${settings.userId} trade_attempts has ${attemptsByTicker.size} open rows: ` +
    Array.from(attemptsByTicker.keys()).join(','),
  )

  for (const pos of positions) {
    const sym = pos.symbol.toUpperCase()
    const att = attemptsByTicker.get(sym)
    if (!att) {
      // Position exists on broker but we have no trade_attempts record — can't
      // act safely (don't know the original stop, can't update). Skip silently.
      console.warn(
        `[position-monitor] user=${settings.userId} ${sym} has no matching trade_attempts row (broker has position but DB doesn't); skipping`,
      )
      continue
    }
    userSummary.positionsChecked++

    // Sync fill-back from broker BEFORE cooldown check, so cooldowned
    // positions still get their entry/risk corrected to actual fill.
    // Mutates `att` in-place if an update happens, so downstream logic
    // sees the corrected values.
    await syncFillBackFromBroker(att, pos).catch(e =>
      console.warn(`[position-monitor] sync-fill ${sym} failed: ${e instanceof Error ? e.message : e}`),
    )

    try {
      const handled = await processPosition(settings, pmSettings, alpaca, pos, att, userSummary)
      if (!handled) userSummary.errors++
    } catch (e) {
      userSummary.errors++
      console.error(`[position-monitor] ${sym} failed:`, e instanceof Error ? e.message : e)
      await logResult(settings, att, pos.symbol, {
        ok: false, errorReason: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
        decision: 'HOLD', actionTaken: 'error',
        snap5m: emptySnapshot(), snap15m: emptySnapshot(),
        currentPrice: pos.current_price, currentStop: att.stop_price,
      })
    }
  }

  // Re-entry pass: scan watched (exited) tickers for a returning setup. Pass the
  // currently-open tickers so we never re-enter something we already hold.
  const openTickers = new Set(positions.map(p => p.symbol.toUpperCase()))
  await runReentryPass(settings, alpaca, openTickers).catch(e =>
    console.warn(`[position-monitor] reentry pass user=${settings.userId}: ${e instanceof Error ? e.message : e}`))
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
    console.warn(`[position-monitor] sync-fill ${att.ticker}: missing stop or qty, skipping risk recalc`)
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
    console.warn(`[position-monitor] sync-fill ${att.ticker} update failed: ${error.message}`)
    return
  }

  console.log(
    `[position-monitor] sync-fill ${att.ticker}: ` +
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
): Promise<boolean> {
  const ticker = pos.symbol.toUpperCase()

  // Cooldown — don't double-act on a position within pm_cooldown_min
  if (await isInCooldown(att.id, pm.cooldownMin)) {
    userSummary.cooldowns++
    return true
  }

  // Side (we don't currently take shorts; default buy)
  const side = (att.side ?? 'buy') as 'buy' | 'sell'

  // Fetch bars and compute technicals
  const [bars5m, bars15m] = await Promise.all([
    fetchBarsForTimeframe(ticker, '5Min', BARS_TO_FETCH_5MIN),
    fetchBarsForTimeframe(ticker, '15Min', BARS_TO_FETCH_15MIN),
  ])

  if (bars5m.length < MIN_BARS || bars15m.length < MIN_BARS) {
    // Not enough data — log a HOLD and move on
    await logResult(settings, att, ticker, {
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
    tightenThreshold15m: pm.tightenThreshold15m,
    exitThreshold15m: pm.exitThreshold15m,
    exitThreshold5m: pm.exitThreshold5m,
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
      console.log(`[position-monitor] ${ticker} TRAIL ${trail.milestone} → stop ${trail.newStop?.toFixed(2)}`)
    }
    await logResult(settings, att, ticker, {
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
    await logResult(settings, att, ticker, {
      ok: result.ok, decision: 'TIGHTEN_STOP', actionTaken: result.ok ? 'tightened' : 'tighten_failed',
      snap5m, snap15m,
      currentPrice: pos.current_price, currentStop: att.stop_price,
      newStopPrice: result.newStop,
      errorReason: result.ok ? undefined : result.reason,
    })
    if (result.ok && result.newStop !== undefined) {
      console.log(`[position-monitor] ${ticker} TIGHTEN ${(att.stop_price ?? 0).toFixed(2)} → ${result.newStop.toFixed(2)} (${ruling.reason})`)
      // Persist new stop level to trade_attempts so future runs see correct level
      await syncTightenedStop(att, result.newStop).catch(e =>
        console.warn(`[position-monitor] sync-tighten ${ticker}: ${e instanceof Error ? e.message : e}`))
    }
    // After the signal-based tighten, also run profit trailing: if the R-multiple
    // milestone implies a higher stop than the midpoint nudge, ratchet up to it.
    // applyTighten already updated att.stop_price, so this only moves UP further.
    const trail = await applyTrailingStop(alpaca, att, pos)
    if (trail.applied) {
      console.log(`[position-monitor] ${ticker} TRAIL ${trail.milestone} → stop ${trail.newStop?.toFixed(2)} (post-tighten)`)
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
      console.log(`[position-monitor] ${ticker} EXIT deferred — within 5 min of market close (${ruling.reason})`)
      await logResult(settings, att, ticker, {
        ok: true, decision: 'EXIT', actionTaken: 'exit_deferred_close_window',
        snap5m, snap15m,
        currentPrice: pos.current_price, currentStop: att.stop_price,
        errorReason: `deferred: within market-close window; pre-market-reeval will handle`,
      })
      return true
    }
    const result = await applyExit(alpaca, pos)
    userSummary.exits++
    await logResult(settings, att, ticker, {
      ok: result.ok, decision: 'EXIT', actionTaken: result.ok ? 'exited' : 'exit_failed',
      snap5m, snap15m,
      currentPrice: pos.current_price, currentStop: att.stop_price,
      errorReason: result.ok ? undefined : result.reason,
    })
    if (result.ok) {
      console.log(`[position-monitor] ${ticker} EXIT @ ~${pos.current_price.toFixed(2)} (${ruling.reason})`)
      // Persist closure to trade_attempts so lifecycle/dashboard see truth
      await recordExitClosure(att, pos, 'monitor_exit').catch(e =>
        console.warn(`[position-monitor] record-exit ${ticker}: ${e instanceof Error ? e.message : e}`))
      // Add to the re-entry watch: if the original directional setup returns
      // within the window, the monitor can re-enter (dip-then-recover).
      await recordReentryWatch(att, pos).catch(e =>
        console.warn(`[position-monitor] reentry-watch ${ticker}: ${e instanceof Error ? e.message : e}`))
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
        console.log(`[position-monitor] ${ticker} ESCALATED EXIT deferred — within 5 min of market close`)
        await logResult(settings, att, ticker, {
          ok: true, decision: 'ESCALATE', actionTaken: 'escalated_exit_deferred_close_window',
          snap5m, snap15m,
          currentPrice: pos.current_price, currentStop: att.stop_price,
          escalationResult: escalation,
          errorReason: 'deferred: within market-close window',
        })
        return true
      }
      const result = await applyExit(alpaca, pos)
      await logResult(settings, att, ticker, {
        ok: result.ok, decision: 'ESCALATE', actionTaken: result.ok ? 'escalated_exit' : 'escalated_exit_failed',
        snap5m, snap15m,
        currentPrice: pos.current_price, currentStop: att.stop_price,
        escalationResult: escalation,
        errorReason: result.ok ? undefined : result.reason,
      })
      if (result.ok) {
        await recordExitClosure(att, pos, 'escalated_exit').catch(e =>
          console.warn(`[position-monitor] record-exit ${ticker}: ${e instanceof Error ? e.message : e}`))
        await recordReentryWatch(att, pos).catch(e =>
          console.warn(`[position-monitor] reentry-watch ${ticker}: ${e instanceof Error ? e.message : e}`))
      }
    } else if (escalation.action === 'TIGHTEN_STOP') {
      const result = await applyTighten(alpaca, att, pos)
      await logResult(settings, att, ticker, {
        ok: result.ok, decision: 'ESCALATE', actionTaken: result.ok ? 'escalated_tighten' : 'escalated_tighten_failed',
        snap5m, snap15m,
        currentPrice: pos.current_price, currentStop: att.stop_price,
        newStopPrice: result.newStop,
        escalationResult: escalation,
        errorReason: result.ok ? undefined : result.reason,
      })
      if (result.ok && result.newStop !== undefined) {
        await syncTightenedStop(att, result.newStop).catch(e =>
          console.warn(`[position-monitor] sync-tighten ${ticker}: ${e instanceof Error ? e.message : e}`))
      }
    } else {
      // Council said HOLD or returned ambiguously
      await logResult(settings, att, ticker, {
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
    console.warn(`[position-monitor] sync-tighten ${att.ticker} update failed: ${error.message}`)
    return
  }
  console.log(`[position-monitor] sync-tighten ${att.ticker}: stop_price -> ${newStop.toFixed(2)}`)
  // Mutate so downstream code sees correct value
  att.stop_price = newStop
}

async function recordExitClosure(
  att: OpenAttempt,
  pos: AlpacaPosition,
  closureKind: 'monitor_exit' | 'escalated_exit',
): Promise<void> {
  const entryFill = att.filled_avg_price ?? att.entry_price_est
  const exitPrice = pos.current_price
  const qty = att.qty ?? Math.abs(pos.qty)

  if (entryFill === null || !Number.isFinite(exitPrice) || qty <= 0) {
    console.warn(`[position-monitor] record-exit ${att.ticker}: missing entry/exit/qty, marking closed without P&L`)
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
    console.warn(`[position-monitor] record-exit ${att.ticker} update failed: ${error.message}`)
    return
  }
  console.log(
    `[position-monitor] record-exit ${att.ticker}: ` +
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
  console.log(`[position-monitor] ${att.ticker} on re-entry watch (side=${side})`)
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
    console.warn(`[position-monitor] reentry fetch failed user=${settings.userId}: ${error.message}`)
    return
  }
  const rows = (data ?? []) as ReentryWatchRow[]
  if (rows.length === 0) return
  console.log(`[position-monitor] reentry pass user=${settings.userId}: ${rows.length} watched ticker(s)`)

  for (const w of rows) {
    const ticker = String(w.ticker).toUpperCase()
    if (openTickers.has(ticker)) continue                       // already holding it — never double-enter
    const side = w.side === 'sell' ? 'sell' : 'buy'

    const [bars5m, bars15m] = await Promise.all([
      fetchBarsForTimeframe(ticker, '5Min', BARS_TO_FETCH_5MIN),
      fetchBarsForTimeframe(ticker, '15Min', BARS_TO_FETCH_15MIN),
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

    await placeReentry(settings, alpaca, w, ticker, side, t5.currentPrice).catch(e =>
      console.warn(`[position-monitor] reentry place ${ticker}: ${e instanceof Error ? e.message : e}`))
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
  })
  if (insErr) {
    console.warn(`[position-monitor] reentry trade_attempts insert ${ticker}: ${insErr.message}`)
  }

  const status = nextCount >= MAX_REENTRIES ? 'exhausted' : 'watching'
  await admin.from('reentry_watch').update({
    reentry_count: nextCount,
    status,
    last_reentry_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', w.id)

  console.log(`[position-monitor] ${ticker} RE-ENTRY #${nextCount} ${side} qty=${qty} @ ~${currentPrice.toFixed(2)} stop=${newStop.toFixed(2)} target=${newTarget.toFixed(2)}`)
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
    console.warn(`[position-monitor] sync-trail ${att.ticker}: ${e instanceof Error ? e.message : e}`))

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
        `[position-monitor] applyExit ${symbol}: ` +
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

async function fetchOpenAttempts(userId: string): Promise<Map<string, OpenAttempt>> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()

  // Note (June 23 2026): the previous `.or('asset_class.is.null,asset_class.eq.stocks,asset_class.eq.stock')`
  // chained with `.in('outcome', ...)` was silently returning an empty result
  // set under PostgREST when both were used together. Symptom: position-monitor
  // logged "trade_attempts has 0 open rows" despite 4 rows existing.
  //
  // Fix: use a plain `.in('asset_class', [...])` and run a SECOND query for
  // legacy NULL rows. Both errors are now logged explicitly.
  const { data, error } = await admin
    .from('trade_attempts')
    .select('id, user_id, ticker, side, qty, filled_avg_price, entry_price_est, stop_price, target_price, broker_order_id, verdict_log_id, initial_stop, outcome, asset_class')
    .eq('user_id', userId)
    .in('asset_class', ['stock', 'stocks'])
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .gte('created_at', cutoff)

  if (error) {
    console.error(`[position-monitor] fetchOpenAttempts main query failed for user=${userId}:`, error.message)
    return new Map()
  }

  // Legacy: rows created before the asset_class column was added may have NULL.
  // Quick second query — if it errors we just skip the legacy rows.
  const { data: legacyData, error: legacyError } = await admin
    .from('trade_attempts')
    .select('id, user_id, ticker, side, qty, filled_avg_price, entry_price_est, stop_price, target_price, broker_order_id, verdict_log_id, initial_stop, outcome, asset_class')
    .eq('user_id', userId)
    .is('asset_class', null)
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .gte('created_at', cutoff)

  if (legacyError) {
    console.warn(`[position-monitor] fetchOpenAttempts legacy NULL query failed for user=${userId} (ignoring):`, legacyError.message)
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
      console.warn(`[position-monitor] verdict_log stop_loss lookup failed (trailing will no-op):`, vError.message)
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
}

async function logResult(
  settings: UserTradingSettings,
  att: OpenAttempt,
  ticker: string,
  payload: LogPayload,
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('position_monitor_log').insert({
    user_id: settings.userId,
    trade_attempt_id: att.id,
    ticker,
    asset_class: att.asset_class ?? 'stock',
    bearish_count_5m: payload.snap5m.bearishCount,
    bearish_count_15m: payload.snap15m.bearishCount,
    bullish_count_5m: payload.snap5m.bullishCount,
    bullish_count_15m: payload.snap15m.bullishCount,
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
  timeframe: '5Min' | '15Min',
  limit: number,
): Promise<AlpacaBarRaw[]> {
  // For 15Min we can use the existing fetchBars('1D') which returns 15-min
  // bars. Sliced to last N. Cleaner: it already handles SIP/IEX fallback.
  if (timeframe === '15Min') {
    const bars = await fetchBars(ticker, '1D').catch(() => [])
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
