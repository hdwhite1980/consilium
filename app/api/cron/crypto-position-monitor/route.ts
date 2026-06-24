// =============================================================
// app/api/cron/crypto-position-monitor/route.ts
//
// 24/7 position monitor for crypto positions. Parallels the stock
// position-monitor but adapted for crypto realities:
//
//   - 24/7 schedule (no market hours)
//   - No 5m/15m bar-based technicals (Coinbase has different data shape;
//     building a parallel signal engine is deferred). Instead, manages
//     positions purely via TRAILING STOPS keyed off Council's original
//     stop. Same milestone math as stock trailing stops:
//       +1R → stop to breakeven
//       +2R → stop to entry + 0.5R
//       +3R → stop to entry + 1.5R
//       +4R+ → trail 1R below current
//
//   - Per asset class: looks for stocks=null OR asset_class='crypto'
//   - Per broker: Coinbase OR Alpaca crypto
//   - Uses live spot price from the broker, not external feed
//   - Modifies the protective stop via cancel-and-replace on Coinbase
//     (Coinbase doesn't have a PATCH stop_price)
//
// CRON_SECRET gated. Should run every 3-5 min.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers, type UserTradingSettings } from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse, loadCoinbaseCredential } from '@/app/lib/trading/credentials'
import { makeAlpacaCryptoClient, type AlpacaCryptoClient } from '@/app/lib/trading/alpaca-crypto-client'
import { makeCoinbaseClient, type CoinbaseClient } from '@/app/lib/trading/coinbase-client'
import { computeTrailingStop, type TrailingStopResult } from '@/app/lib/trading/position-monitor-signals'
import { fetchCryptoBars, computeCryptoSignals, type CryptoSignalCounts } from '@/app/lib/trading/crypto-bars'
import { randomBytes } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface CryptoOpenAttempt {
  id: string
  user_id: string
  ticker: string                  // e.g. "BTC-USD" or "BTC/USD"
  side: 'buy' | 'sell' | null
  qty: number | null
  filled_avg_price: number | null
  entry_price_est: number | null
  stop_price: number | null
  target_price: number | null
  broker_order_id: string | null  // entry order
  stop_order_id: string | null    // protective stop
  verdict_log_id: number | null
  broker: 'alpaca' | 'coinbase'
  mode: 'paper' | 'live'
  original_stop_loss: number | null   // Council's original stop from verdict_log
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary = {
    users: 0,
    positions: 0,
    trailingAdvanced: 0,
    signalExits: 0,
    noChange: 0,
    errors: 0,
    durationMs: 0,
  }

  try {
    const users = await listEnabledTradingUsers()
    summary.users = users.length

    for (const settings of users) {
      try {
        await processUser(settings, summary)
      } catch (e) {
        summary.errors++
        console.error(`[crypto-position-monitor] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[crypto-position-monitor cron] done in ${summary.durationMs}ms, trailing=${summary.trailingAdvanced} signalExits=${summary.signalExits} hold=${summary.noChange}`)
  return NextResponse.json(summary)
}

async function processUser(
  settings: UserTradingSettings,
  summary: { positions: number; trailingAdvanced: number; signalExits: number; noChange: number; errors: number },
): Promise<void> {
  const attempts = await fetchOpenCryptoAttempts(settings.userId)
  if (attempts.length === 0) return

  // Group by broker so we only init one client per broker per user
  const coinbaseAttempts = attempts.filter(a => a.broker === 'coinbase')
  const alpacaAttempts = attempts.filter(a => a.broker === 'alpaca')

  // ── Coinbase positions ─────────────────────────────────────
  if (coinbaseAttempts.length > 0) {
    const cred = await loadCoinbaseCredential(settings.userId)
    if (!cred) {
      console.warn(`[crypto-position-monitor] user=${settings.userId} coinbase attempts present but no credential`)
    } else {
      const client = makeCoinbaseClient(cred.keyName, cred.privateKey)
      for (const att of coinbaseAttempts) {
        summary.positions++
        try {
          await monitorCoinbasePosition(att, client, summary)
        } catch (e) {
          summary.errors++
          console.error(`[crypto-position-monitor] coinbase ${att.ticker} attempt=${att.id} error:`, e instanceof Error ? e.message : e)
        }
      }
    }
  }

  // ── Alpaca crypto positions ────────────────────────────────
  if (alpacaAttempts.length > 0) {
    const mode = alpacaAttempts[0].mode
    const cred = await loadBrokerCredentialForUse(settings.userId, 'alpaca', mode, 'crypto')
    if (!cred) {
      console.warn(`[crypto-position-monitor] user=${settings.userId} alpaca attempts present but no credential`)
    } else {
      const client = makeAlpacaCryptoClient(cred.keyId, cred.secret, mode)
      for (const att of alpacaAttempts) {
        summary.positions++
        try {
          await monitorAlpacaPosition(att, client, summary)
        } catch (e) {
          summary.errors++
          console.error(`[crypto-position-monitor] alpaca ${att.ticker} attempt=${att.id} error:`, e instanceof Error ? e.message : e)
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Coinbase monitoring
// ─────────────────────────────────────────────────────────────

async function monitorCoinbasePosition(
  att: CryptoOpenAttempt,
  client: CoinbaseClient,
  summary: { trailingAdvanced: number; noChange: number; signalExits: number },
): Promise<void> {
  // Get current spot price
  const currentPrice = await client.getSpotPrice(att.ticker).catch(() => null)
  if (currentPrice === null || currentPrice <= 0) {
    await logResult(att, 'HOLD', 'no_spot_price', null, null)
    summary.noChange++
    return
  }

  // ── Signal check ──────────────────────────────────────────
  // Fetch 5m and 15m bars, count bearish signals on each. If 3+ bearish
  // on 5m OR 4+ bearish on 15m, EXIT the position. This parallels the
  // stock position-monitor's signal-based exit logic.
  let signals5m: CryptoSignalCounts | null = null
  let signals15m: CryptoSignalCounts | null = null
  try {
    const bars5m = await fetchCryptoBars({ symbol: att.ticker, granularity: 'FIVE_MINUTE', limit: 100 })
    signals5m = computeCryptoSignals(bars5m)
  } catch (e) {
    console.warn(`[crypto-position-monitor] coinbase 5m signals ${att.ticker} failed:`, e instanceof Error ? e.message : e)
  }
  try {
    const bars15m = await fetchCryptoBars({ symbol: att.ticker, granularity: 'FIFTEEN_MINUTE', limit: 100 })
    signals15m = computeCryptoSignals(bars15m)
  } catch (e) {
    console.warn(`[crypto-position-monitor] coinbase 15m signals ${att.ticker} failed:`, e instanceof Error ? e.message : e)
  }

  const bear5 = signals5m?.bearishCount ?? 0
  const bull5 = signals5m?.bullishCount ?? 0
  const bear15 = signals15m?.bearishCount ?? 0
  const bull15 = signals15m?.bullishCount ?? 0
  const score5 = signals5m?.technicalScore ?? 0
  const score15 = signals15m?.technicalScore ?? 0
  const bias5 = signals5m?.technicalBias ?? 'NEUTRAL'
  const bias15 = signals15m?.technicalBias ?? 'NEUTRAL'

  // Bullish override: if 15m is strongly bullish (score >= 50 OR bias=BULLISH with bull15>=7),
  // hold even if 5m wobbles
  const strongBullish15m = score15 >= 50 || (bias15 === 'BULLISH' && bull15 >= 7)
  // Sustained bearish: technical score deeply negative OR many bearish signals on either timeframe
  // Thresholds: score <= -30 on 15m (significant bearish bias) OR bear15 >= 7 (many indicators agree)
  //   OR rapid 5m deterioration (score5 <= -40, bear5 >= 6)
  const sustainedBearish = !strongBullish15m && (
    score15 <= -30 || bear15 >= 7 ||
    score5 <= -40 || bear5 >= 7
  )

  if (sustainedBearish) {
    // EXIT: market sell the entire position via Coinbase
    try {
      if (att.stop_order_id) {
        await client.cancelOrder(att.stop_order_id).catch(() => null)
      }
      await client.closePosition(att.ticker)
      await logResult(att, 'EXIT', `signal_exit: score5=${score5} score15=${score15} bear5=${bear5} bear15=${bear15} bull15=${bull15}`, currentPrice, null)
      console.log(`[crypto-position-monitor] coinbase SIGNAL EXIT ${att.ticker} score5=${score5} score15=${score15} bear5=${bear5} bear15=${bear15}`)
      summary.signalExits++
      return
    } catch (e) {
      console.error(`[crypto-position-monitor] coinbase SIGNAL EXIT FAILED ${att.ticker}:`, e instanceof Error ? e.message : e)
      await logResult(att, 'EXIT', `signal_exit_failed: ${e instanceof Error ? e.message.slice(0, 100) : 'unknown'}`, currentPrice, null)
      summary.noChange++
      return
    }
  }

  // ── Trailing stop check ───────────────────────────────────
  const trailing = computeTrailing(att, currentPrice)
  if (!trailing) {
    await logResult(att, 'HOLD', `no_milestone score5=${score5} score15=${score15} bias=${bias5}/${bias15}`, currentPrice, null)
    summary.noChange++
    return
  }

  // Cancel existing stop, place new stop. Coinbase doesn't support PATCH on
  // stop orders — must cancel and replace.
  if (att.stop_order_id) {
    const cancelResult = await client.cancelOrder(att.stop_order_id)
    if (!cancelResult.ok) {
      console.warn(`[crypto-position-monitor] coinbase cancel stop ${att.stop_order_id} failed: ${cancelResult.reason}`)
    }
  }

  if (att.qty === null || att.qty <= 0) {
    await logResult(att, 'HOLD', `invalid qty=${att.qty}`, currentPrice, null)
    summary.noChange++
    return
  }

  const stopClientId = `wos-cbtrail-${att.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`
  try {
    const newStop = await client.stopLimitSell({
      symbol: att.ticker,
      qty: att.qty,
      stopPrice: trailing.newStop,
      clientOrderId: stopClientId,
    })
    await syncTrailedStop(att.id, newStop.id, trailing.newStop)
    await logResult(att, 'TIGHTEN_STOP', `trailing_${trailing.milestone}`, currentPrice, trailing.newStop)
    console.log(`[crypto-position-monitor] coinbase TRAILING ${att.ticker} ${(att.stop_price ?? 0).toFixed(2)} → ${trailing.newStop.toFixed(2)} (${trailing.milestone} at +${trailing.gainR.toFixed(2)}R)`)
    summary.trailingAdvanced++
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await logResult(att, 'TIGHTEN_STOP', `trailing_failed: ${msg.slice(0, 100)}`, currentPrice, null)
    summary.noChange++
    console.warn(`[crypto-position-monitor] coinbase TRAILING FAILED ${att.ticker}: ${msg.slice(0, 200)}`)
  }
}

// ─────────────────────────────────────────────────────────────
// Alpaca crypto monitoring
// ─────────────────────────────────────────────────────────────

async function monitorAlpacaPosition(
  att: CryptoOpenAttempt,
  client: AlpacaCryptoClient,
  summary: { trailingAdvanced: number; noChange: number; signalExits: number },
): Promise<void> {
  // Get current price from the positions list (Alpaca returns current_price)
  const positions = await client.positions().catch(() => [])
  const pos = positions.find(p => p.symbol.toUpperCase() === att.ticker.replace('/', '').toUpperCase())
  const currentPrice = pos?.current_price ?? null
  if (currentPrice === null || currentPrice <= 0) {
    await logResult(att, 'HOLD', 'no_position_price', null, null)
    summary.noChange++
    return
  }

  // ── Signal check (use Coinbase bars; same instruments) ────
  // Convert Alpaca BTC/USD → BTC-USD for bar fetch
  const barSymbol = att.ticker.replace('/', '-')
  let signals5m: CryptoSignalCounts | null = null
  let signals15m: CryptoSignalCounts | null = null
  try {
    const bars5m = await fetchCryptoBars({ symbol: barSymbol, granularity: 'FIVE_MINUTE', limit: 100 })
    signals5m = computeCryptoSignals(bars5m)
  } catch (e) {
    console.warn(`[crypto-position-monitor] alpaca 5m signals ${att.ticker} failed:`, e instanceof Error ? e.message : e)
  }
  try {
    const bars15m = await fetchCryptoBars({ symbol: barSymbol, granularity: 'FIFTEEN_MINUTE', limit: 100 })
    signals15m = computeCryptoSignals(bars15m)
  } catch (e) {
    console.warn(`[crypto-position-monitor] alpaca 15m signals ${att.ticker} failed:`, e instanceof Error ? e.message : e)
  }

  const bear5 = signals5m?.bearishCount ?? 0
  const bull5 = signals5m?.bullishCount ?? 0
  const bear15 = signals15m?.bearishCount ?? 0
  const bull15 = signals15m?.bullishCount ?? 0
  const score5 = signals5m?.technicalScore ?? 0
  const score15 = signals15m?.technicalScore ?? 0
  const bias5 = signals5m?.technicalBias ?? 'NEUTRAL'
  const bias15 = signals15m?.technicalBias ?? 'NEUTRAL'

  const strongBullish15m = score15 >= 50 || (bias15 === 'BULLISH' && bull15 >= 7)
  const sustainedBearish = !strongBullish15m && (
    score15 <= -30 || bear15 >= 7 ||
    score5 <= -40 || bear5 >= 7
  )

  if (sustainedBearish) {
    try {
      if (att.stop_order_id) {
        await client.cancelOrder(att.stop_order_id).catch(() => null)
      }
      await client.closePosition(att.ticker)
      await logResult(att, 'EXIT', `signal_exit: score5=${score5} score15=${score15} bear5=${bear5} bear15=${bear15} bull15=${bull15}`, currentPrice, null)
      console.log(`[crypto-position-monitor] alpaca SIGNAL EXIT ${att.ticker} score5=${score5} score15=${score15}`)
      summary.signalExits++
      return
    } catch (e) {
      console.error(`[crypto-position-monitor] alpaca SIGNAL EXIT FAILED ${att.ticker}:`, e instanceof Error ? e.message : e)
      await logResult(att, 'EXIT', `signal_exit_failed: ${e instanceof Error ? e.message.slice(0, 100) : 'unknown'}`, currentPrice, null)
      summary.noChange++
      return
    }
  }

  // ── Trailing stop check ───────────────────────────────────
  const trailing = computeTrailing(att, currentPrice)
  if (!trailing) {
    await logResult(att, 'HOLD', `no_milestone score5=${score5} score15=${score15} bias=${bias5}/${bias15}`, currentPrice, null)
    summary.noChange++
    return
  }

  // Cancel + replace stop (Alpaca crypto also no bracket patch)
  if (att.stop_order_id) {
    await client.cancelOrder(att.stop_order_id).catch(e => {
      console.warn(`[crypto-position-monitor] alpaca cancel stop ${att.stop_order_id} failed: ${e instanceof Error ? e.message : e}`)
    })
  }
  if (att.qty === null || att.qty <= 0) {
    await logResult(att, 'HOLD', `invalid qty=${att.qty}`, currentPrice, null)
    summary.noChange++
    return
  }

  const stopClientId = `wos-actrail-${att.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`
  try {
    const newStop = await client.stopLimitSell({
      symbol: att.ticker,
      qty: att.qty,
      stopPrice: trailing.newStop,
      clientOrderId: stopClientId,
    })
    await syncTrailedStop(att.id, newStop.id, trailing.newStop)
    await logResult(att, 'TIGHTEN_STOP', `trailing_${trailing.milestone}`, currentPrice, trailing.newStop)
    console.log(`[crypto-position-monitor] alpaca TRAILING ${att.ticker} ${(att.stop_price ?? 0).toFixed(2)} → ${trailing.newStop.toFixed(2)} (${trailing.milestone} at +${trailing.gainR.toFixed(2)}R)`)
    summary.trailingAdvanced++
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await logResult(att, 'TIGHTEN_STOP', `trailing_failed: ${msg.slice(0, 100)}`, currentPrice, null)
    summary.noChange++
  }
}

// ─────────────────────────────────────────────────────────────
// Trailing computation — wraps the stock trailing function
// ─────────────────────────────────────────────────────────────

function computeTrailing(att: CryptoOpenAttempt, currentPrice: number): TrailingStopResult | null {
  const entry = att.filled_avg_price ?? att.entry_price_est
  if (entry === null || att.stop_price === null || att.original_stop_loss === null) {
    return null
  }
  return computeTrailingStop({
    side: 'buy',
    entryPrice: entry,
    currentPrice,
    currentStop: att.stop_price,
    originalStop: att.original_stop_loss,
  })
}

// ─────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────

async function fetchOpenCryptoAttempts(userId: string): Promise<CryptoOpenAttempt[]> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data } = await admin
    .from('trade_attempts')
    .select(`
      id, user_id, ticker, side, qty, filled_avg_price, entry_price_est,
      stop_price, target_price, broker_order_id, stop_order_id, verdict_log_id,
      broker, mode, asset_class,
      verdict_log:verdict_log_id ( stop_loss )
    `)
    .eq('user_id', userId)
    .eq('asset_class', 'crypto')
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .gte('created_at', cutoff)

  const out: CryptoOpenAttempt[] = []
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const verdictJoin = row.verdict_log as { stop_loss?: number | string | null } | null | undefined
    const originalStopLoss = verdictJoin?.stop_loss !== null && verdictJoin?.stop_loss !== undefined
      ? Number(verdictJoin.stop_loss) : null
    out.push({
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
      stop_order_id: row.stop_order_id !== null && row.stop_order_id !== undefined ? String(row.stop_order_id) : null,
      verdict_log_id: row.verdict_log_id !== null && row.verdict_log_id !== undefined ? Number(row.verdict_log_id) : null,
      broker: (row.broker === 'coinbase' ? 'coinbase' : 'alpaca'),
      mode: (row.mode as 'paper' | 'live') ?? 'paper',
      original_stop_loss: originalStopLoss !== null && Number.isFinite(originalStopLoss) ? originalStopLoss : null,
    })
  }
  return out
}

async function syncTrailedStop(attemptId: string, newStopOrderId: string, newStopPrice: number): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').update({
    stop_order_id: newStopOrderId,
    stop_price: newStopPrice,
  }).eq('id', attemptId)
}

async function logResult(
  att: CryptoOpenAttempt,
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
    asset_class: 'crypto',
    decision,
    action_taken: actionTaken,
    current_price: currentPrice,
    current_stop: att.stop_price,
    new_stop_price: newStopPrice,
  }).then(({ error }) => {
    if (error && !/duplicate|conflict/i.test(error.message)) {
      console.warn(`[crypto-position-monitor] logResult failed:`, error.message)
    }
  })
}
