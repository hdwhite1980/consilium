// =============================================================
// app/api/cron/coinbase-futures-monitor/route.ts
//
// Position monitor for Coinbase Financial Markets (CFM) futures — the
// leveraged-money counterpart to the stock position monitor. Brings the
// Coinbase futures leg to protection parity with stocks:
//
//   1. HARD STOP-BREACH BACKSTOP — if price has crossed the intended stop but
//      the position is somehow still open (stop cancelled/expired/never armed),
//      flatten immediately. Also re-arms a missing protective stop.
//   2. LIQUIDATION DEFENSE — if price drifts within a danger buffer of the
//      exchange liquidation price, exit on our terms before the exchange
//      force-liquidates at worse terms. (Futures-only.)
//   3. SIGNAL EXIT — long exits on sustained bearish, short on sustained
//      bullish (computed from the underlying spot bars, which the perps track).
//   4. TRAILING STOP — same R-multiple milestone ladder as stocks/crypto, with
//      a short-side mirror; cancel + re-arm the broker stop as it ratchets.
//   5. RECONCILE — if the broker shows flat but the DB still says open, record
//      the closure so it stops being monitored (stop must have filled).
//
// Long AND short. Runs frequently (Coinbase futures trade 24/7).
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers, isCoinbaseFuturesEnabled, type UserTradingSettings } from '@/app/lib/trading/settings'
import { loadCoinbaseFuturesCredential } from '@/app/lib/trading/credentials'
import { makeCoinbaseClient, type CoinbaseClient, type CoinbaseFuturesPosition } from '@/app/lib/trading/coinbase-client'
import { computeTrailingStop } from '@/app/lib/trading/position-monitor-signals'
import { fetchCryptoBars, computeCryptoSignals, type CryptoSignalCounts } from '@/app/lib/trading/crypto-bars'
import { listCoinbaseFuturesContracts, type FuturesContract } from '@/app/lib/trading/coinbase-futures-products'
import { randomBytes } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Exit defensively when price is within this fraction of the liquidation price.
const LIQ_DANGER_BUFFER = 0.15

interface FuturesOpenAttempt {
  id: string
  user_id: string
  ticker: string                  // Coinbase futures product_id
  side: 'buy' | 'sell' | null     // buy = long, sell = short
  qty: number | null              // contract count
  filled_avg_price: number | null
  entry_price_est: number | null
  stop_price: number | null
  target_price: number | null
  broker_order_id: string | null
  stop_order_id: string | null
  verdict_log_id: number | null
  mode: 'paper' | 'live'
  original_stop_loss: number | null
}

type Summary = { positions: number; trailingAdvanced: number; signalExits: number; liqDefenses: number; breachCloses: number; reconciled: number; noChange: number; errors: number }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary: Summary & { durationMs: number } = {
    positions: 0, trailingAdvanced: 0, signalExits: 0, liqDefenses: 0,
    breachCloses: 0, reconciled: 0, noChange: 0, errors: 0, durationMs: 0,
  }

  try {
    const users = (await listEnabledTradingUsers()).filter(s => isCoinbaseFuturesEnabled(s))
    for (const settings of users) {
      try {
        await processUser(settings, summary)
      } catch (e) {
        summary.errors++
        console.error(`[cb-fut-monitor] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[cb-fut-monitor cron] done in ${summary.durationMs}ms pos=${summary.positions} trail=${summary.trailingAdvanced} sigExit=${summary.signalExits} liq=${summary.liqDefenses} breach=${summary.breachCloses} reconciled=${summary.reconciled}`)
  return NextResponse.json(summary)
}

async function processUser(settings: UserTradingSettings, summary: Summary): Promise<void> {
  const attempts = await fetchOpenFuturesAttempts(settings.userId)
  if (attempts.length === 0) return

  const cred = await loadCoinbaseFuturesCredential(settings.userId)
  if (!cred) {
    console.warn(`[cb-fut-monitor] user=${settings.userId} open futures attempts but no Coinbase credential`)
    return
  }
  const client = makeCoinbaseClient(cred.keyName, cred.privateKey)

  // Live broker truth + contract metadata (for contract size / underlying root).
  let livePositions: CoinbaseFuturesPosition[] = []
  try {
    livePositions = await client.listFuturesPositions()
  } catch (e) {
    console.warn(`[cb-fut-monitor] user=${settings.userId} listFuturesPositions failed: ${e instanceof Error ? e.message : e}`)
    return
  }
  const posByProduct = new Map<string, CoinbaseFuturesPosition>()
  for (const p of livePositions) posByProduct.set(p.productId, p)

  let universe: FuturesContract[] = []
  try {
    universe = await listCoinbaseFuturesContracts(client)
  } catch { /* contract metadata is best-effort */ }
  const contractByProduct = new Map<string, FuturesContract>()
  for (const c of universe) contractByProduct.set(c.productId, c)

  for (const att of attempts) {
    summary.positions++
    try {
      await monitorPosition(att, client, posByProduct.get(att.ticker) ?? null, contractByProduct.get(att.ticker) ?? null, summary)
    } catch (e) {
      summary.errors++
      console.error(`[cb-fut-monitor] ${att.ticker} attempt=${att.id} error:`, e instanceof Error ? e.message : e)
    }
  }
}

async function monitorPosition(
  att: FuturesOpenAttempt,
  client: CoinbaseClient,
  pos: CoinbaseFuturesPosition | null,
  contract: FuturesContract | null,
  summary: Summary,
): Promise<void> {
  const contractSize = contract?.contractSize ?? null

  // ── RECONCILE: broker flat but DB open → the stop must have filled. ──
  // Before reconciling, confirm via the single-position endpoint so a hiccup
  // in the bulk list can't false-close a live leveraged position. (Even if it
  // did, the broker-side stop would remain — but we avoid losing the monitor.)
  if (!pos || pos.contracts <= 0) {
    const confirm = await client.getFuturesPosition(att.ticker).catch(() => null)
    if (confirm && confirm.contracts > 0) {
      pos = confirm
    } else {
      await recordClosure(att, att.stop_price ?? att.entry_price_est ?? null, contractSize, 'reconcile_flat')
      await logResult(att, 'EXIT', 'reconcile: broker flat, marking closed', null, null)
      summary.reconciled++
      return
    }
  }

  const currentPrice = pos.currentPrice > 0 ? pos.currentPrice : (att.entry_price_est ?? 0)
  if (currentPrice <= 0) {
    await logResult(att, 'HOLD', 'no_price', null, null)
    summary.noChange++
    return
  }

  const isLong = att.side !== 'sell'
  const contracts = pos.contracts

  // ── 1. HARD STOP-BREACH BACKSTOP ──
  // Price crossed the intended stop but we're still in — the broker stop didn't
  // protect (cancelled/expired/never armed). Flatten now.
  const breached = att.stop_price !== null && (
    isLong ? currentPrice <= att.stop_price : currentPrice >= att.stop_price
  )
  if (breached) {
    await closePosition(client, att, contracts, currentPrice, contractSize, summary, 'stop_breach',
      `hard stop-breach @ ${currentPrice.toFixed(2)} vs stop ${att.stop_price!.toFixed(2)}`)
    summary.breachCloses++
    return
  }

  // ── 2. LIQUIDATION DEFENSE ──
  if (pos.liquidationPrice && pos.liquidationPrice > 0) {
    const distToLiq = Math.abs(currentPrice - pos.liquidationPrice) / currentPrice
    const approaching = isLong ? currentPrice <= pos.liquidationPrice * (1 + LIQ_DANGER_BUFFER)
                               : currentPrice >= pos.liquidationPrice * (1 - LIQ_DANGER_BUFFER)
    if (approaching || distToLiq < LIQ_DANGER_BUFFER) {
      await closePosition(client, att, contracts, currentPrice, contractSize, summary, 'liq_defense',
        `liquidation defense @ ${currentPrice.toFixed(2)} (liq ${pos.liquidationPrice.toFixed(2)}, ${(distToLiq * 100).toFixed(1)}% away)`)
      summary.liqDefenses++
      return
    }
  }

  // ── 3. SIGNAL EXIT (underlying spot bars; perps track spot) ──
  const root = contract?.rootUnit
  if (root) {
    const sig = await computeSpotSignals(`${root}-USD`)
    if (sig) {
      const { bear5, bull5, bear15, bull15, score5, score15, bias15 } = sig
      const strongAgainstExit = isLong
        ? (score15 >= 50 || (bias15 === 'BULLISH' && bull15 >= 7))   // strong bullish holds a long
        : (score15 <= -50 || (bias15 === 'BEARISH' && bear15 >= 7))  // strong bearish holds a short
      const sustainedReversal = !strongAgainstExit && (isLong
        ? (score15 <= -30 || bear15 >= 7 || score5 <= -40 || bear5 >= 7)
        : (score15 >= 30 || bull15 >= 7 || score5 >= 40 || bull5 >= 7))
      if (sustainedReversal) {
        await closePosition(client, att, contracts, currentPrice, contractSize, summary, 'signal_exit',
          `signal exit (${isLong ? 'bearish' : 'bullish'}) score5=${score5} score15=${score15}`)
        summary.signalExits++
        return
      }
    }
  }

  // ── 4. TRAILING STOP ──
  const trailing = computeFuturesTrailing(
    isLong ? 'buy' : 'sell',
    att.filled_avg_price ?? att.entry_price_est,
    currentPrice,
    att.stop_price,
    att.original_stop_loss,
  )
  if (trailing) {
    try {
      if (att.stop_order_id) {
        const c = await client.cancelOrder(att.stop_order_id)
        if (!c.ok) console.warn(`[cb-fut-monitor] cancel stop ${att.stop_order_id} failed: ${c.reason}`)
      }
      const newStop = await client.futuresStopOrder({
        productId: att.ticker,
        side: isLong ? 'sell' : 'buy',
        contracts,
        stopPrice: trailing.newStop,
        stopDirection: isLong ? 'STOP_DIRECTION_STOP_DOWN' : 'STOP_DIRECTION_STOP_UP',
        clientOrderId: `wos-cbftrail-${att.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`,
      })
      await syncStop(att.id, newStop.id, trailing.newStop)
      await logResult(att, 'TIGHTEN_STOP', `trailing_${trailing.milestone}`, currentPrice, trailing.newStop)
      console.log(`[cb-fut-monitor] TRAIL ${att.ticker} ${(att.stop_price ?? 0).toFixed(2)} → ${trailing.newStop.toFixed(2)} (${trailing.milestone} +${trailing.gainR.toFixed(2)}R)`)
      summary.trailingAdvanced++
      return
    } catch (e) {
      await logResult(att, 'TIGHTEN_STOP', `trailing_failed: ${e instanceof Error ? e.message.slice(0, 100) : 'unknown'}`, currentPrice, null)
      summary.noChange++
      return
    }
  }

  // ── 5. ENSURE A PROTECTIVE STOP EXISTS ──
  // No stop order on record (e.g. it filled-and-was-replaced, or initial attach
  // was lost) and not breached/exited above → re-arm at the recorded stop.
  if (!att.stop_order_id && att.stop_price !== null) {
    try {
      const armed = await client.futuresStopOrder({
        productId: att.ticker,
        side: isLong ? 'sell' : 'buy',
        contracts,
        stopPrice: att.stop_price,
        stopDirection: isLong ? 'STOP_DIRECTION_STOP_DOWN' : 'STOP_DIRECTION_STOP_UP',
        clientOrderId: `wos-cbfarm-${att.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`,
      })
      await syncStop(att.id, armed.id, att.stop_price)
      await logResult(att, 'TIGHTEN_STOP', 'rearm_missing_stop', currentPrice, att.stop_price)
      console.log(`[cb-fut-monitor] RE-ARM stop ${att.ticker} @ ${att.stop_price.toFixed(2)}`)
      summary.trailingAdvanced++
      return
    } catch (e) {
      await logResult(att, 'HOLD', `rearm_failed: ${e instanceof Error ? e.message.slice(0, 80) : 'unknown'}`, currentPrice, null)
      summary.noChange++
      return
    }
  }

  await logResult(att, 'HOLD', 'no_action', currentPrice, null)
  summary.noChange++
}

// ─────────────────────────────────────────────────────────────
// Exit helper — cancel stop, market-close opposite side, record P&L
// ─────────────────────────────────────────────────────────────
async function closePosition(
  client: CoinbaseClient,
  att: FuturesOpenAttempt,
  contracts: number,
  exitPrice: number,
  contractSize: number | null,
  summary: Summary,
  kind: string,
  reason: string,
): Promise<void> {
  try {
    if (att.stop_order_id) await client.cancelOrder(att.stop_order_id).catch(() => null)
    await client.futuresMarketOrder({
      productId: att.ticker,
      side: att.side === 'sell' ? 'buy' : 'sell',   // close = opposite of entry
      contracts,
      clientOrderId: `wos-cbfx-${att.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`,
    })
    await recordClosure(att, exitPrice, contractSize, kind)
    await logResult(att, 'EXIT', `${kind}: ${reason}`, exitPrice, null)
    console.log(`[cb-fut-monitor] EXIT ${att.ticker} — ${reason}`)
  } catch (e) {
    await logResult(att, 'EXIT', `${kind}_failed: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`, exitPrice, null)
    console.error(`[cb-fut-monitor] EXIT FAILED ${att.ticker} (${kind}):`, e instanceof Error ? e.message : e)
    summary.errors++
  }
}

// ─────────────────────────────────────────────────────────────
// Trailing — long via shared engine, short mirror inline
// ─────────────────────────────────────────────────────────────
function computeFuturesTrailing(
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
  if (riskPerUnit <= 0 || riskPerUnit / entry < 0.001) return null
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

  // Only move the short's stop DOWN, never widen up.
  if (proposed >= currentStop) return null
  // Sanity: keep the stop above current price (a short stop triggers upward).
  const minAllowed = currentPrice * 1.003
  if (proposed <= minAllowed) proposed = minAllowed
  if (proposed >= currentStop) return null
  return { newStop: proposed, milestone, gainR }
}

// ─────────────────────────────────────────────────────────────
// Spot signals (underlying), reused for the futures exit decision
// ─────────────────────────────────────────────────────────────
async function computeSpotSignals(spotSymbol: string): Promise<{
  bear5: number; bull5: number; bear15: number; bull15: number
  score5: number; score15: number; bias15: string
} | null> {
  let s5: CryptoSignalCounts | null = null
  let s15: CryptoSignalCounts | null = null
  try { s5 = computeCryptoSignals(await fetchCryptoBars({ symbol: spotSymbol, granularity: 'FIVE_MINUTE', limit: 100 })) } catch { /* no spot bars (commodity/index) */ }
  try { s15 = computeCryptoSignals(await fetchCryptoBars({ symbol: spotSymbol, granularity: 'FIFTEEN_MINUTE', limit: 100 })) } catch { /* idem */ }
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
async function fetchOpenFuturesAttempts(userId: string): Promise<FuturesOpenAttempt[]> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data } = await admin
    .from('trade_attempts')
    .select(`
      id, user_id, ticker, side, qty, filled_avg_price, entry_price_est,
      stop_price, target_price, broker_order_id, stop_order_id, verdict_log_id,
      mode, asset_class, broker,
      verdict_log:verdict_log_id ( stop_loss )
    `)
    .eq('user_id', userId)
    .eq('asset_class', 'futures')
    .eq('broker', 'coinbase')
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .gte('created_at', cutoff)

  const out: FuturesOpenAttempt[] = []
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const vj = row.verdict_log as { stop_loss?: number | string | null } | null | undefined
    const osl = vj?.stop_loss !== null && vj?.stop_loss !== undefined ? Number(vj.stop_loss) : null
    const initialStop = row.stop_price !== null && row.stop_price !== undefined ? Number(row.stop_price) : null
    out.push({
      id: String(row.id),
      user_id: String(row.user_id),
      ticker: String(row.ticker),
      side: (row.side as 'buy' | 'sell' | null) ?? null,
      qty: row.qty !== null && row.qty !== undefined ? Number(row.qty) : null,
      filled_avg_price: row.filled_avg_price !== null && row.filled_avg_price !== undefined ? Number(row.filled_avg_price) : null,
      entry_price_est: row.entry_price_est !== null && row.entry_price_est !== undefined ? Number(row.entry_price_est) : null,
      stop_price: initialStop,
      target_price: row.target_price !== null && row.target_price !== undefined ? Number(row.target_price) : null,
      broker_order_id: row.broker_order_id !== null && row.broker_order_id !== undefined ? String(row.broker_order_id) : null,
      stop_order_id: row.stop_order_id !== null && row.stop_order_id !== undefined ? String(row.stop_order_id) : null,
      verdict_log_id: row.verdict_log_id !== null && row.verdict_log_id !== undefined ? Number(row.verdict_log_id) : null,
      mode: (row.mode as 'paper' | 'live') ?? 'live',
      // Prefer the immutable council stop for R-multiple math; fall back to the
      // current stop (only used if it hasn't been trailed yet).
      original_stop_loss: osl !== null && Number.isFinite(osl) ? osl : initialStop,
    })
  }
  return out
}

async function syncStop(attemptId: string, newStopOrderId: string, newStopPrice: number): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').update({ stop_order_id: newStopOrderId, stop_price: newStopPrice }).eq('id', attemptId)
}

async function recordClosure(
  att: FuturesOpenAttempt,
  exitPrice: number | null,
  contractSize: number | null,
  closureKind: string,
): Promise<void> {
  const admin = await getSupabaseAdmin()
  const entry = att.filled_avg_price ?? att.entry_price_est
  const contracts = att.qty ?? 0

  if (entry === null || exitPrice === null || !Number.isFinite(exitPrice) || contractSize === null || contracts <= 0) {
    await admin.from('trade_attempts').update({
      outcome: 'closed_be', closed_at: new Date().toISOString(), closure_kind: 'monitor_exit',
    }).eq('id', att.id)
    return
  }
  const sign = att.side === 'sell' ? -1 : 1
  const pnl = (exitPrice - entry) * contractSize * contracts * sign
  const eps = 0.005
  const outcome = pnl > eps ? 'closed_win' : pnl < -eps ? 'closed_loss' : 'closed_be'
  await admin.from('trade_attempts').update({
    outcome,
    realized_pnl: Math.round(pnl * 100) / 100,
    closed_at: new Date().toISOString(),
    closure_kind: 'monitor_exit',
  }).eq('id', att.id)
  console.log(`[cb-fut-monitor] closed ${att.ticker}: ${outcome} pnl $${pnl.toFixed(2)} (${closureKind})`)
}

async function logResult(
  att: FuturesOpenAttempt,
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
    asset_class: 'futures',
    decision,
    action_taken: actionTaken,
    current_price: currentPrice,
    current_stop: att.stop_price,
    new_stop_price: newStopPrice,
  }).then(({ error }) => {
    if (error && !/duplicate|conflict/i.test(error.message)) {
      console.warn(`[cb-fut-monitor] logResult failed:`, error.message)
    }
  })
}
