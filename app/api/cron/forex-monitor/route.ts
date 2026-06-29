// =============================================================
// app/api/cron/forex-monitor/route.ts
//
// Position monitor for OANDA forex — brings forex to the same post-entry
// protection parity as stocks / Coinbase futures. Forex entries already carry a
// native OANDA stop-loss + take-profit (the broker-side floor); this adds the
// active ratchet layer that was missing:
//
//   1. HARD STOP-BREACH BACKSTOP — price crossed the intended stop but the
//      position is still open (SL cancelled / not where we think) → flatten.
//   2. MARGIN DEFENSE — if account margin availability collapses toward OANDA's
//      closeout, exit on our terms before a forced closeout. (Forex analogue of
//      the futures liquidation defense.)
//   3. SIGNAL EXIT — long exits on sustained bearish, short on sustained
//      bullish, from the instrument's own candles (same signal engine the other
//      monitors use).
//   4. TRAILING STOP — the stock R-multiple ladder, with a short-side mirror;
//      replaces the trade's SL in place via OANDA (atomic cancel+re-arm).
//   5. ENSURE-STOP-EXISTS + RECONCILE — re-arm a missing SL; if OANDA shows the
//      instrument flat, record the closure so it stops being monitored.
//
// Long AND short. 24/5 — schedule it across the forex week.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers, isAssetClassEnabled, type UserTradingSettings } from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import { makeOandaClient, type OandaClient, type OandaPosition, type OandaTrade } from '@/app/lib/trading/oanda-client'
import { computeTrailingStop } from '@/app/lib/trading/position-monitor-signals'
import { computeCryptoSignals, type CryptoSignalCounts } from '@/app/lib/trading/crypto-bars'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Defend when free margin falls below this fraction of equity (OANDA forces a
// closeout near 50% margin level; we step out well before that).
const MARGIN_DANGER_FRACTION = 0.10

interface FxOpenAttempt {
  id: string
  user_id: string
  ticker: string                 // OANDA instrument, e.g. "USD_CAD"
  side: string | null
  qty: number | null
  filled_avg_price: number | null
  entry_price_est: number | null
  stop_price: number | null
  target_price: number | null
  verdict_log_id: number | null
  mode: 'paper' | 'live'
  original_stop_loss: number | null
}

type Summary = { positions: number; trailingAdvanced: number; signalExits: number; marginDefenses: number; breachCloses: number; reconciled: number; noChange: number; errors: number }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary: Summary & { durationMs: number } = {
    positions: 0, trailingAdvanced: 0, signalExits: 0, marginDefenses: 0,
    breachCloses: 0, reconciled: 0, noChange: 0, errors: 0, durationMs: 0,
  }

  try {
    const users = (await listEnabledTradingUsers()).filter(s => isAssetClassEnabled(s, 'forex'))
    for (const settings of users) {
      try {
        await processUser(settings, summary)
      } catch (e) {
        summary.errors++
        console.error(`[forex-monitor] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[forex-monitor cron] done in ${summary.durationMs}ms pos=${summary.positions} trail=${summary.trailingAdvanced} sigExit=${summary.signalExits} margin=${summary.marginDefenses} breach=${summary.breachCloses} reconciled=${summary.reconciled}`)
  return NextResponse.json(summary)
}

async function processUser(settings: UserTradingSettings, summary: Summary): Promise<void> {
  const attempts = await fetchOpenForexAttempts(settings.userId)
  if (attempts.length === 0) return

  const cred = await loadBrokerCredentialForUse(settings.userId, 'oanda', settings.mode, 'forex')
  if (!cred) {
    console.warn(`[forex-monitor] user=${settings.userId} open forex attempts but no OANDA credential`)
    return
  }
  const client = makeOandaClient(cred.keyId, cred.secret, settings.mode)

  // Account margin posture (for the margin-defense check).
  let equity = 0
  let marginAvailable = 0
  try {
    const acct = await client.accountSummary()
    equity = acct.equity
    marginAvailable = acct.marginAvailable
  } catch (e) {
    console.warn(`[forex-monitor] user=${settings.userId} accountSummary failed: ${e instanceof Error ? e.message : e}`)
    return  // can't reason about margin/positions without the account
  }

  let positions: OandaPosition[] = []
  try {
    positions = await client.positions()
  } catch (e) {
    console.warn(`[forex-monitor] user=${settings.userId} positions failed: ${e instanceof Error ? e.message : e}`)
    return
  }
  const posByInstrument = new Map<string, OandaPosition>()
  for (const p of positions) if (p.side !== 'flat') posByInstrument.set(p.instrument, p)

  let trades: OandaTrade[] = []
  try {
    trades = await client.openTrades()
  } catch { /* trade lookup is best-effort; trailing/ensure-stop will no-op without it */ }
  const tradeByInstrument = new Map<string, OandaTrade>()
  for (const t of trades) {
    // Prefer a trade that already carries a stop-loss order; otherwise first seen.
    const existing = tradeByInstrument.get(t.instrument)
    if (!existing || (t.stopLossOrderId && !existing.stopLossOrderId)) tradeByInstrument.set(t.instrument, t)
  }

  const marginFloor = equity * MARGIN_DANGER_FRACTION

  for (const att of attempts) {
    summary.positions++
    try {
      await monitorPosition(att, client, posByInstrument.get(att.ticker) ?? null, tradeByInstrument.get(att.ticker) ?? null, marginAvailable, marginFloor, summary)
    } catch (e) {
      summary.errors++
      console.error(`[forex-monitor] ${att.ticker} attempt=${att.id} error:`, e instanceof Error ? e.message : e)
    }
  }
}

async function monitorPosition(
  att: FxOpenAttempt,
  client: OandaClient,
  pos: OandaPosition | null,
  trade: OandaTrade | null,
  marginAvailable: number,
  marginFloor: number,
  summary: Summary,
): Promise<void> {
  // ── RECONCILE: OANDA flat for this instrument but DB still open. ──
  if (!pos || pos.side === 'flat') {
    await recordClosure(att, att.stop_price ?? att.entry_price_est ?? null, null, 'reconcile_flat')
    await logResult(att, 'EXIT', 'reconcile: OANDA flat, marking closed', null, null)
    summary.reconciled++
    return
  }

  const isLong = pos.side === 'long'
  const entry = trade?.entryPrice ?? pos.avgPrice ?? att.filled_avg_price ?? att.entry_price_est

  // Current price from a live quote (mid); fall back to the position's avg.
  let currentPrice = 0
  try {
    const q = await client.priceQuote(att.ticker)
    if (q && Number.isFinite(q.mid) && q.mid > 0) currentPrice = q.mid
  } catch { /* fall through to fallback */ }
  if (currentPrice <= 0) currentPrice = pos.avgPrice ?? 0
  if (currentPrice <= 0) {
    await logResult(att, 'HOLD', 'no_price', null, null)
    summary.noChange++
    return
  }

  const currentStop = trade?.stopLossPrice ?? att.stop_price
  const realized = pos.unrealizedPL   // captured now = what gets realized if we close

  // ── 1. HARD STOP-BREACH BACKSTOP ──
  const breached = currentStop !== null && (isLong ? currentPrice <= currentStop : currentPrice >= currentStop)
  if (breached) {
    await closePosition(client, att, pos.side, currentPrice, realized, summary, 'stop_breach',
      `hard stop-breach @ ${currentPrice} vs stop ${currentStop}`)
    summary.breachCloses++
    return
  }

  // ── 2. MARGIN DEFENSE ──
  if (marginAvailable < marginFloor) {
    await closePosition(client, att, pos.side, currentPrice, realized, summary, 'margin_defense',
      `margin defense — free margin ${marginAvailable.toFixed(2)} below floor ${marginFloor.toFixed(2)}`)
    summary.marginDefenses++
    return
  }

  // ── 3. SIGNAL EXIT ──
  const sig = await computeFxSignals(client, att.ticker)
  if (sig) {
    const { bear5, bull5, bear15, bull15, score5, score15, bias15 } = sig
    const strongAgainstExit = isLong
      ? (score15 >= 50 || (bias15 === 'BULLISH' && bull15 >= 7))
      : (score15 <= -50 || (bias15 === 'BEARISH' && bear15 >= 7))
    const sustainedReversal = !strongAgainstExit && (isLong
      ? (score15 <= -30 || bear15 >= 7 || score5 <= -40 || bear5 >= 7)
      : (score15 >= 30 || bull15 >= 7 || score5 >= 40 || bull5 >= 7))
    if (sustainedReversal) {
      await closePosition(client, att, pos.side, currentPrice, realized, summary, 'signal_exit',
        `signal exit (${isLong ? 'bearish' : 'bullish'}) score5=${score5} score15=${score15}`)
      summary.signalExits++
      return
    }
  }

  // ── 4. TRAILING STOP ──
  const trailing = computeFxTrailing(isLong ? 'buy' : 'sell', entry, currentPrice, currentStop, att.original_stop_loss)
  if (trailing && trade?.tradeId) {
    const res = await client.setTradeStopLoss(trade.tradeId, att.ticker, trailing.newStop)
    if (res.ok) {
      await syncStop(att.id, res.stopOrderId ?? null, trailing.newStop)
      await logResult(att, 'TIGHTEN_STOP', `trailing_${trailing.milestone}`, currentPrice, trailing.newStop)
      console.log(`[forex-monitor] TRAIL ${att.ticker} ${currentStop ?? '?'} → ${trailing.newStop} (${trailing.milestone} +${trailing.gainR.toFixed(2)}R)`)
      summary.trailingAdvanced++
    } else {
      await logResult(att, 'TIGHTEN_STOP', `trailing_failed: ${(res.reason ?? '').slice(0, 100)}`, currentPrice, null)
      summary.noChange++
    }
    return
  }

  // ── 5. ENSURE A PROTECTIVE STOP EXISTS ──
  if (trade?.tradeId && !trade.stopLossOrderId && att.stop_price !== null) {
    const res = await client.setTradeStopLoss(trade.tradeId, att.ticker, att.stop_price)
    if (res.ok) {
      await syncStop(att.id, res.stopOrderId ?? null, att.stop_price)
      await logResult(att, 'TIGHTEN_STOP', 'rearm_missing_stop', currentPrice, att.stop_price)
      console.log(`[forex-monitor] RE-ARM stop ${att.ticker} @ ${att.stop_price}`)
      summary.trailingAdvanced++
    } else {
      await logResult(att, 'HOLD', `rearm_failed: ${(res.reason ?? '').slice(0, 80)}`, currentPrice, null)
      summary.noChange++
    }
    return
  }

  await logResult(att, 'HOLD', 'no_action', currentPrice, null)
  summary.noChange++
}

// ─────────────────────────────────────────────────────────────
// Exit helper — close the netted position, record realized P&L
// ─────────────────────────────────────────────────────────────
async function closePosition(
  client: OandaClient,
  att: FxOpenAttempt,
  side: 'long' | 'short',
  exitPrice: number,
  realizedPL: number | null,
  summary: Summary,
  kind: string,
  reason: string,
): Promise<void> {
  try {
    await client.closePosition(att.ticker, side)
    await recordClosure(att, exitPrice, realizedPL, kind)
    await logResult(att, 'EXIT', `${kind}: ${reason}`, exitPrice, null)
    console.log(`[forex-monitor] EXIT ${att.ticker} — ${reason}`)
  } catch (e) {
    await logResult(att, 'EXIT', `${kind}_failed: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`, exitPrice, null)
    console.error(`[forex-monitor] EXIT FAILED ${att.ticker} (${kind}):`, e instanceof Error ? e.message : e)
    summary.errors++
  }
}

// ─────────────────────────────────────────────────────────────
// Trailing — long via shared engine, short mirror inline
// ─────────────────────────────────────────────────────────────
function computeFxTrailing(
  side: 'buy' | 'sell',
  entry: number | null,
  currentPrice: number,
  currentStop: number | null,
  originalStop: number | null,
): { newStop: number; milestone: string; gainR: number } | null {
  if (entry === null || currentStop === null || originalStop === null) return null

  if (side === 'buy') {
    const r = computeTrailingStop({ side: 'buy', entryPrice: entry, currentPrice, currentStop, originalStop })
    return r ? { newStop: r.newStop, milestone: r.milestone, gainR: r.gainR } : null
  }

  // SHORT mirror: stop sits ABOVE entry, profit grows as price falls.
  if (![entry, currentPrice, currentStop, originalStop].every(v => Number.isFinite(v) && v > 0)) return null
  const riskPerUnit = originalStop - entry
  if (riskPerUnit <= 0 || riskPerUnit / entry < 0.0001) return null
  const gain = entry - currentPrice
  if (gain <= 0) return null
  const gainR = gain / riskPerUnit

  let proposed: number
  let milestone: string
  if (gainR >= 4) { proposed = currentPrice + riskPerUnit; milestone = '4R_trail_1R' }
  else if (gainR >= 3) { proposed = entry - riskPerUnit * 1.5; milestone = '3R_lock_1_5R' }
  else if (gainR >= 2) { proposed = entry - riskPerUnit * 0.5; milestone = '2R_lock_half' }
  else if (gainR >= 1.5) { proposed = entry - riskPerUnit * 0.5; milestone = '1_5R_lock_half' }
  else if (gainR >= 1) { proposed = entry; milestone = '1R_breakeven' }
  else return null

  if (proposed >= currentStop) return null          // only ratchet the short's stop DOWN
  const minAllowed = currentPrice * 1.0003           // keep it above current price
  if (proposed <= minAllowed) proposed = minAllowed
  if (proposed >= currentStop) return null
  return { newStop: proposed, milestone, gainR }
}

// ─────────────────────────────────────────────────────────────
// Signals from the instrument's own candles
// ─────────────────────────────────────────────────────────────
async function computeFxSignals(client: OandaClient, instrument: string): Promise<{
  bear5: number; bull5: number; bear15: number; bull15: number
  score5: number; score15: number; bias15: string
} | null> {
  let s5: CryptoSignalCounts | null = null
  let s15: CryptoSignalCounts | null = null
  try { s5 = computeCryptoSignals(await client.candles(instrument, 'M5', 100)) } catch { /* no bars */ }
  try { s15 = computeCryptoSignals(await client.candles(instrument, 'M15', 100)) } catch { /* idem */ }
  if (!s5 && !s15) return null
  return {
    bear5: s5?.bearishCount ?? 0, bull5: s5?.bullishCount ?? 0,
    bear15: s15?.bearishCount ?? 0, bull15: s15?.bullishCount ?? 0,
    score5: s5?.technicalScore ?? 0, score15: s15?.technicalScore ?? 0,
    bias15: s15?.technicalBias ?? 'NEUTRAL',
  }
}

// ─────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────
async function fetchOpenForexAttempts(userId: string): Promise<FxOpenAttempt[]> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data } = await admin
    .from('trade_attempts')
    .select(`
      id, user_id, ticker, side, qty, filled_avg_price, entry_price_est,
      stop_price, target_price, verdict_log_id, mode, asset_class, broker, initial_stop,
      verdict_log:verdict_log_id ( stop_loss )
    `)
    .eq('user_id', userId)
    .eq('asset_class', 'forex')
    .eq('broker', 'oanda')
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .gte('created_at', cutoff)

  const out: FxOpenAttempt[] = []
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const vj = row.verdict_log as { stop_loss?: number | string | null } | null | undefined
    const initialStop = row.initial_stop !== null && row.initial_stop !== undefined && Number.isFinite(Number(row.initial_stop))
      ? Number(row.initial_stop) : null
    const verdictStop = vj?.stop_loss !== null && vj?.stop_loss !== undefined && Number.isFinite(Number(vj.stop_loss))
      ? Number(vj.stop_loss) : null
    out.push({
      id: String(row.id),
      user_id: String(row.user_id),
      ticker: String(row.ticker),
      side: (row.side as string | null) ?? null,
      qty: row.qty !== null && row.qty !== undefined ? Number(row.qty) : null,
      filled_avg_price: row.filled_avg_price !== null && row.filled_avg_price !== undefined ? Number(row.filled_avg_price) : null,
      entry_price_est: row.entry_price_est !== null && row.entry_price_est !== undefined ? Number(row.entry_price_est) : null,
      stop_price: row.stop_price !== null && row.stop_price !== undefined ? Number(row.stop_price) : null,
      target_price: row.target_price !== null && row.target_price !== undefined ? Number(row.target_price) : null,
      verdict_log_id: row.verdict_log_id !== null && row.verdict_log_id !== undefined ? Number(row.verdict_log_id) : null,
      mode: (row.mode as 'paper' | 'live') ?? 'paper',
      // Immutable original stop for R-multiple math: per-attempt initial_stop,
      // else the Council's verdict stop, else the current stop.
      original_stop_loss: initialStop ?? verdictStop ?? (row.stop_price !== null && row.stop_price !== undefined ? Number(row.stop_price) : null),
    })
  }
  return out
}

async function syncStop(attemptId: string, stopOrderId: string | null, newStopPrice: number): Promise<void> {
  const admin = await getSupabaseAdmin()
  const patch: Record<string, unknown> = { stop_price: newStopPrice }
  if (stopOrderId) patch.stop_order_id = stopOrderId
  await admin.from('trade_attempts').update(patch).eq('id', attemptId)
}

async function recordClosure(
  att: FxOpenAttempt,
  exitPrice: number | null,
  realizedPL: number | null,
  closureKind: string,
): Promise<void> {
  const admin = await getSupabaseAdmin()
  const eps = 0.005

  // Prefer OANDA's realized P&L; fall back to price direction vs entry.
  let outcome: 'closed_win' | 'closed_loss' | 'closed_be' = 'closed_be'
  let pnl: number | null = realizedPL
  if (realizedPL !== null && Number.isFinite(realizedPL)) {
    outcome = realizedPL > eps ? 'closed_win' : realizedPL < -eps ? 'closed_loss' : 'closed_be'
  } else {
    const entry = att.filled_avg_price ?? att.entry_price_est
    if (entry !== null && exitPrice !== null && Number.isFinite(exitPrice)) {
      const isLong = att.side !== 'sell' && att.side !== 'short'
      const dir = (exitPrice - entry) * (isLong ? 1 : -1)
      outcome = dir > eps ? 'closed_win' : dir < -eps ? 'closed_loss' : 'closed_be'
    }
    pnl = null
  }

  const patch: Record<string, unknown> = { outcome, closed_at: new Date().toISOString(), closure_kind: 'monitor_exit' }
  if (pnl !== null) patch.realized_pnl = Math.round(pnl * 100) / 100
  if (exitPrice !== null && Number.isFinite(exitPrice)) patch.exit_price = exitPrice
  await admin.from('trade_attempts').update(patch).eq('id', att.id)
  console.log(`[forex-monitor] closed ${att.ticker}: ${outcome}${pnl !== null ? ` pnl ${pnl.toFixed(2)}` : ''} (${closureKind})`)
}

async function logResult(
  att: FxOpenAttempt,
  decision: 'HOLD' | 'TIGHTEN_STOP' | 'EXIT',
  actionTaken: string,
  currentPrice: number | null,
  newStopPrice: number | null,
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('position_monitor_log').insert({
    user_id: att.user_id,
    trade_attempt_id: att.id,
    ticker: att.ticker,
    asset_class: 'forex',
    decision,
    action_taken: actionTaken,
    current_price: currentPrice,
    current_stop: att.stop_price,
    new_stop_price: newStopPrice,
  }).then(({ error }) => {
    if (error && !/duplicate|conflict/i.test(error.message)) {
      console.warn(`[forex-monitor] logResult failed:`, error.message)
    }
  })
}
