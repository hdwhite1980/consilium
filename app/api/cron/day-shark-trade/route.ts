// =============================================================
// app/api/cron/day-shark-trade/route.ts
//
// Max's executor — MULTI-ASSET. Re-decides on the NORMAL trader's verdicts with
// his own looser R:R bar (Max fires no councils of his own): any directional
// verdict clearing SHARK_RR_FLOOR is fair game — including ones the trader passed
// for being below ITS stricter bar. Sized within Max's per-asset virtual budget,
// placed through the right broker, exited by his own EOD/max-hold monitor, and
// tagged signal_source='day_shark' so he runs beside (not on top of) the trader.
//
//   crypto → Coinbase/Alpaca (selectCryptoBroker), notional market entry.
//            Real money. Soft stop enforced by day-shark-monitor.
//   stock  → Alpaca PAPER, fractional market order (qty). Market-hours gated.
//            Soft stop enforced by day-shark-monitor.
//   forex  → OANDA PRACTICE, signed-units market order with NATIVE TP/SL — the
//            broker holds the stop/target; the monitor only does EOD cut/ride.
//
// SAFETY (same spine for all three):
//   - Budget gate: never deploys past Max's available sleeve for that asset.
//   - Dedup: skips verdicts that already have a day_shark attempt (re-run safe);
//     deterministic client_order_id wos-shark-{id}.
//   - Per-run running budget so multiple fills in one run can't overspend.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//   ?asset=stock|crypto|forex|all (default crypto)  &userId=<uuid>  &dryRun=1
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { listEnabledTradingUsers, isAssetClassEnabled, type UserTradingSettings } from '@/app/lib/trading/settings'
import { selectCryptoBroker } from '@/app/lib/trading/crypto-broker'
import { getSharkBudget, allocationPctFor } from '@/app/lib/trading/day-shark-budget'
import { computeSharkSize, maxNarration, type SharkAsset } from '@/app/lib/trading/day-shark'
import { isCryptoPairSymbol } from '@/app/lib/crypto-symbol'
import { makeAlpacaClient } from '@/app/lib/trading/alpaca-client'
import { makeOandaClient } from '@/app/lib/trading/oanda-client'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const SAFETY_MARGIN = 0.95

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}
function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

// Asset classification from the verdict ticker. Crypto first (BTCUSD is crypto,
// not forex), then 6-letter fiat pairs are forex, everything else is stock.
function assetOf(ticker: string): SharkAsset {
  if (isCryptoPairSymbol(ticker)) return 'crypto'
  if (/^[A-Z]{6}$/.test(ticker)) return 'forex'
  return 'stock'
}
function oandaInstrument(ticker: string): string {
  return ticker.length === 6 ? `${ticker.slice(0, 3)}_${ticker.slice(3)}` : ticker
}

interface SharkVerdict {
  id: number
  ticker: string
  signal: string
  confidence: number | string | null
  entry_price: number | null
  stop_loss: number | null
  take_profit: number | null
  trader_grade: string | null
  trader_risk_reward: number | string | null
}

// Max's own bar — looser than the normal trader's. He re-decides on the trader's
// analysis (no new council): any directional verdict whose R:R clears this floor
// is fair game, even ones the trader passed for being below ITS stricter bar.
const SHARK_RR_FLOOR = 1.2

async function loadSharkVerdicts(userId: string, asset: SharkAsset): Promise<SharkVerdict[]> {
  const db = admin()
  // Fresh normal-trader analysis only — a day-old signal's move is usually already done.
  const cutoff = new Date(Date.now() - 4 * 3_600_000).toISOString()
  const { data: verdicts } = await db
    .from('verdict_log')
    .select('id, ticker, signal, confidence, entry_price, stop_loss, take_profit, trader_grade, trader_risk_reward')
    .eq('user_id', userId)
    .or('source.is.null,source.neq.day_shark')   // the NORMAL trader's verdicts — Max no longer fires his own
    .in('signal', ['BULLISH', 'BEARISH'])         // directional only; Max re-decides regardless of trader_decision
    .gte('created_at', cutoff)
    .order('id', { ascending: true })
  if (!verdicts || verdicts.length === 0) return []

  const ids = verdicts.map(v => v.id)
  const { data: done } = await db
    .from('trade_attempts')
    .select('verdict_log_id')
    .eq('user_id', userId)
    .eq('signal_source', 'day_shark')
    .in('verdict_log_id', ids)
  const doneSet = new Set((done ?? []).map(r => r.verdict_log_id))
  // Crypto can't be shorted on Coinbase spot, and Alpaca has no fractional shorts
  // (Max uses fractional orders) — so those two lanes are long-only. Forex can
  // short (OANDA signed units), so it takes both directions. Without this guard a
  // BEARISH verdict would make Max BUY — a backwards trade.
  const canShort = asset === 'forex'
  return (verdicts as SharkVerdict[]).filter(v =>
    !doneSet.has(v.id) &&
    assetOf(v.ticker) === asset &&
    v.trader_risk_reward != null &&
    Number(v.trader_risk_reward) >= SHARK_RR_FLOOR &&        // Max's looser bar — takes what the trader passed on R:R
    (canShort || (v.signal ?? '').toUpperCase() === 'BULLISH')  // crypto/stock: long-only
  )
}

async function recordAttempt(
  userId: string, verdict: SharkVerdict, asset: SharkAsset, side: 'buy' | 'sell',
  outcome: string, mode: string, broker: string, details: Record<string, unknown>,
): Promise<string | null> {
  const { error } = await admin().from('trade_attempts').insert({
    user_id: userId,
    verdict_log_id: verdict.id,
    ticker: verdict.ticker,
    asset_class: asset,
    council_signal: verdict.signal,
    council_confidence: verdict.confidence !== null ? Math.round(Number(verdict.confidence)) : null,
    outcome,
    signal_source: 'day_shark',
    side,
    mode,        // NOT NULL — the lane's real broker mode (paper/live/practice)
    broker,      // NOT NULL — the lane's real broker name
    ...details,
  })
  if (error) {
    console.error(`[day-shark-trade] record '${outcome}' ${verdict.ticker} FAILED: ${error.message}`, error.details ?? '')
    return error.message
  }
  return null
}

interface LaneCtx {
  equity: number
  cash: number
  brokerName: string
  mode: string
  place: (v: SharkVerdict, notionalUsd: number, entry: number, stop: number, target: number | null, clientOrderId: string)
    => Promise<{ orderId: string; brokerSymbol: string; qty: number; side: 'buy' | 'sell' }>
}

async function setupLane(settings: UserTradingSettings, asset: SharkAsset): Promise<LaneCtx | { error: string }> {
  if (asset === 'crypto') {
    const broker = await selectCryptoBroker(settings)
    if (!broker) return { error: 'no crypto broker' }
    const acct = await broker.account()
    return {
      equity: acct.equity || acct.cash, cash: acct.cash, brokerName: broker.brokerName, mode: broker.effectiveMode,
      place: async (v, notionalUsd, entry, _stop, _target, clientOrderId) => {
        const brokerSymbol = broker.symbolFor(v.ticker.includes('/') ? v.ticker : v.ticker.replace(/USD$/, '/USD'))
        const order = await broker.marketEntry({ symbol: brokerSymbol, notionalUsd, side: 'buy', clientOrderId })
        return { orderId: order.id, brokerSymbol, qty: notionalUsd / entry, side: 'buy' }
      },
    }
  }

  if (asset === 'stock') {
    const cred = await loadBrokerCredentialForUse(settings.userId, 'alpaca', settings.mode, 'stock')
    if (!cred) return { error: 'no alpaca stock broker' }
    const alpaca = makeAlpacaClient(cred.keyId, cred.secret, settings.mode)
    const clock = await alpaca.getClock()
    if (!clock.isOpen) return { error: 'market closed' }   // Max day-trades RTH only
    const acct = await alpaca.account()
    return {
      // Max shares this account with the normal trader, which spends the free cash
      // on its own positions. Gate Max on buying_power (margin purchasing power) so
      // he can still trade beside it; his virtual sleeve remains the primary cap.
      equity: acct.equity || acct.cash, cash: acct.buying_power || acct.cash, brokerName: 'alpaca', mode: settings.mode,
      place: async (v, notionalUsd, entry, _stop, _target, clientOrderId) => {
        const rawQty = notionalUsd / entry
        let qty = Number(rawQty.toFixed(6))   // fractional shares by default
        // Some names (e.g. SLS) aren't fractionable — Alpaca rejects fractional
        // qty (40310000). Floor to whole shares; skip if it can't afford one.
        const a = await alpaca.assetTradable(v.ticker)
        if (a.fractionable === false) {
          qty = Math.floor(rawQty)
          if (qty < 1) throw new Error(`$${notionalUsd.toFixed(2)} too small for 1 whole share of non-fractionable ${v.ticker} (~$${entry.toFixed(2)}/sh)`)
        }
        const order = await alpaca.fractionalMarketOrder({ symbol: v.ticker, qty, side: 'buy', clientOrderId })
        return { orderId: order.id, brokerSymbol: v.ticker, qty, side: 'buy' }
      },
    }
  }

  // forex — OANDA practice, native TP/SL (both required)
  const cred = await loadBrokerCredentialForUse(settings.userId, 'oanda', settings.mode, 'forex')
  if (!cred) return { error: 'no oanda broker' }
  const oanda = makeOandaClient(cred.keyId, cred.secret, settings.mode)  // keyId=accountId, secret=token
  const acct = await oanda.accountSummary()
  return {
    equity: acct.equity || acct.balance, cash: acct.marginAvailable || acct.balance, brokerName: 'oanda', mode: settings.mode,
    place: async (v, notionalUsd, entry, stop, target, clientOrderId) => {
      const instrument = oandaInstrument(v.ticker)
      const long = !(v.signal?.toUpperCase().includes('BEAR'))
      const units = Math.max(1, Math.round(notionalUsd / entry))   // base-currency units (practice approx)
      const res = await oanda.marketOrder({
        instrument, units: long ? units : -units,
        takeProfitPrice: target as number,   // guarded non-null before place() is called
        stopLossPrice: stop,
        clientOrderId,
      })
      if (res.errorMessage) throw new Error(`OANDA: ${res.errorMessage}`)
      const fillId = res.orderFillTransaction?.tradeOpened?.tradeID ?? res.lastTransactionID ?? `oanda-${v.id}`
      return { orderId: String(fillId), brokerSymbol: instrument, qty: units, side: long ? 'buy' : 'sell' }
    },
  }
}

async function runUser(settings: UserTradingSettings, asset: SharkAsset, dryRun: boolean) {
  const result = { asset, placed: 0, skipped: 0, errors: 0, notes: [] as string[] }
  if (allocationPctFor(settings, asset) <= 0) { result.notes.push(`Max off for ${asset}`); return result }
  if (!isAssetClassEnabled(settings, asset)) { result.notes.push(`${asset} disabled`); return result }

  const lane = await setupLane(settings, asset)
  if ('error' in lane) { result.notes.push(lane.error); return result }

  const budget = await getSharkBudget(settings, asset, lane.equity)
  if (budget.available <= 0) { result.notes.push(`Max out of budget (sleeve $${budget.sleeve.toFixed(2)})`); return result }

  const verdicts = await loadSharkVerdicts(settings.userId, asset)
  let remaining = budget.available
  let safeCash = lane.cash * SAFETY_MARGIN

  for (const v of verdicts) {
    const entry = v.entry_price, stop = v.stop_loss
    // forex needs BOTH stop and target (OANDA native TP/SL are required fields)
    if (!entry || !stop || (asset === 'forex' && !v.take_profit)) { result.skipped++; continue }

    const sized = computeSharkSize({
      budget: { ...budget, available: Math.min(remaining, safeCash) },
      entryPrice: entry, stopPrice: stop, minViableNotional: 1,
      qualityGrade: (v.trader_grade === 'A' || v.trader_grade === 'B' || v.trader_grade === 'C') ? v.trader_grade : null,
      qualityConfidence: v.confidence !== null ? Number(v.confidence) : null,
      qualityRiskReward: v.trader_risk_reward !== null && v.trader_risk_reward !== undefined ? Number(v.trader_risk_reward) : null,
    })
    if (!sized.ok) {
      if (!dryRun) {
        const recErr = await recordAttempt(settings.userId, v, asset, 'buy', 'skipped', lane.mode, lane.brokerName, { reject_reason: sized.reason })
        if (recErr && !result.notes.some(n => n.startsWith('record failed'))) result.notes.push(`record failed: ${recErr}`)
      }
      result.skipped++; continue
    }

    const rr = v.trader_risk_reward !== null && v.trader_risk_reward !== undefined ? Number(v.trader_risk_reward) : null
    if (dryRun) {
      result.notes.push(maxNarration({ event: 'entry', ticker: v.ticker, grade: v.trader_grade, riskReward: rr, equity: lane.equity })
        + ` [would place $${sized.notionalUsd!.toFixed(2)}]`)
      result.placed++; continue
    }

    const clientOrderId = `wos-shark-${v.id}`
    try {
      const fill = await lane.place(v, sized.notionalUsd!, entry, stop, v.take_profit, clientOrderId)
      const recErr = await recordAttempt(settings.userId, v, asset, fill.side, 'placed', lane.mode, lane.brokerName, {
        ticker: fill.brokerSymbol,
        broker_order_id: fill.orderId, broker_client_id: clientOrderId,
        qty: fill.qty, entry_price_est: entry,
        council_entry: entry, council_stop: stop, council_target: v.take_profit,
        stop_price: stop, target_price: v.take_profit,
        risk_dollar_amount: sized.dollarRisk, account_equity_at: lane.equity,
      })
      remaining -= sized.notionalUsd!
      safeCash -= sized.notionalUsd!
      result.placed++
      if (recErr) {
        // CRITICAL: order is live at the broker but not in our DB → the monitor
        // won't manage it (no stop/target/EOD). Surface loudly so it's caught.
        result.notes.push(`⚠ ${fill.brokerSymbol} PLACED (order ${fill.orderId}) but NOT recorded — UNTRACKED. DB error: ${recErr}`)
      } else {
        result.notes.push(maxNarration({ event: 'entry', ticker: fill.brokerSymbol, grade: v.trader_grade, riskReward: rr, equity: lane.equity }))
      }
      console.log(`[day-shark-trade:${asset}] MAX ${fill.side.toUpperCase()} $${sized.notionalUsd!.toFixed(2)} ${fill.brokerSymbol} (${sized.rationale})`)
    } catch (e) {
      const recErr = await recordAttempt(settings.userId, v, asset, 'buy', 'rejected', lane.mode, lane.brokerName, { reject_reason: e instanceof Error ? e.message : String(e), broker_client_id: clientOrderId })
      if (recErr) result.notes.push(`record-reject failed for ${v.ticker}: ${recErr}`)
      result.errors++
    }
  }
  return result
}

async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const onlyUser = url.searchParams.get('userId')
  const dryRun = url.searchParams.get('dryRun') === '1'
  const assetParam = (url.searchParams.get('asset') ?? 'crypto').toLowerCase()
  const assets: SharkAsset[] = assetParam === 'all' ? ['stock', 'crypto', 'forex']
    : (['stock', 'crypto', 'forex'] as SharkAsset[]).includes(assetParam as SharkAsset) ? [assetParam as SharkAsset]
    : ['crypto']

  const users = (await listEnabledTradingUsers()).filter(s => !onlyUser || s.userId === onlyUser)
  const summary = { assets, users: users.length, placed: 0, skipped: 0, errors: 0, perUser: [] as unknown[] }
  for (const settings of users) {
    for (const asset of assets) {
      try {
        const r = await runUser(settings, asset, dryRun)
        summary.placed += r.placed; summary.skipped += r.skipped; summary.errors += r.errors
        summary.perUser.push({ userId: settings.userId, ...r })
      } catch (e) {
        summary.errors++
        summary.perUser.push({ userId: settings.userId, asset, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  return NextResponse.json({ ok: true, ...summary })
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }
