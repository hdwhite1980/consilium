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
import { countSignals, decide, type SignalSnapshot, type Decision } from '@/app/lib/trading/position-monitor-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Minimum bars required for technicals to be meaningful.
const MIN_BARS = 30

// Bars to fetch — enough for SMA50/MACD warmup
const BARS_TO_FETCH_5MIN = 80
const BARS_TO_FETCH_15MIN = 80

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
    await logResult(settings, att, ticker, {
      ok: true, decision: 'HOLD', actionTaken: 'hold',
      snap5m, snap15m,
      currentPrice: pos.current_price, currentStop: att.stop_price,
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
    if (result.ok) {
      console.log(`[position-monitor] ${ticker} TIGHTEN ${(att.stop_price ?? 0).toFixed(2)} → ${(result.newStop ?? 0).toFixed(2)} (${ruling.reason})`)
    }
    return result.ok
  }

  if (ruling.decision === 'EXIT') {
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
    }
    return result.ok
  }

  if (ruling.decision === 'ESCALATE') {
    userSummary.escalates++
    const escalation = await escalateToCouncil(settings, att, pos, ruling.reason)
    // Apply the council's decision via the same machinery
    if (escalation.action === 'EXIT') {
      const result = await applyExit(alpaca, pos)
      await logResult(settings, att, ticker, {
        ok: result.ok, decision: 'ESCALATE', actionTaken: result.ok ? 'escalated_exit' : 'escalated_exit_failed',
        snap5m, snap15m,
        currentPrice: pos.current_price, currentStop: att.stop_price,
        escalationResult: escalation,
        errorReason: result.ok ? undefined : result.reason,
      })
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

interface ExitResult { ok: boolean; reason?: string }

async function applyExit(alpaca: AlpacaClient, pos: AlpacaPosition): Promise<ExitResult> {
  try {
    // DELETE /v2/positions/{symbol} closes the entire position at market and
    // cancels child stop/target legs of the bracket
    await (alpaca as unknown as { request: (m: string, p: string) => Promise<unknown> })
      .request('DELETE', `/v2/positions/${encodeURIComponent(pos.symbol)}`)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) }
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
  const { data } = await admin
    .from('trade_attempts')
    .select('id, user_id, ticker, side, qty, filled_avg_price, entry_price_est, stop_price, target_price, broker_order_id, verdict_log_id, outcome, asset_class')
    .eq('user_id', userId)
    .or('asset_class.is.null,asset_class.eq.stocks,asset_class.eq.stock')
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .gte('created_at', cutoff)

  const map = new Map<string, OpenAttempt>()
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
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
      outcome: String(row.outcome),
      asset_class: row.asset_class !== null && row.asset_class !== undefined ? String(row.asset_class) : null,
    }
    map.set(att.ticker.toUpperCase(), att)
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
