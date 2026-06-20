// =============================================================
// app/api/cron/auto-trade-forex/route.ts
//
// Forex auto-trader via OANDA. Runs Sun 22:00 UTC → Fri 22:00 UTC.
//
// Differences from stocks worker:
//   - 24/5 schedule (forex closes weekends)
//   - Signed units (positive=buy/long, negative=sell/short)
//   - Native TP/SL attached to order (no separate bracket request)
//   - Instrument names use OANDA's underscore form: USD_CAD
//   - OANDA returns 1 position per instrument (long + short netted)
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import {
  listEnabledTradingUsers,
  setWorkerWatermark,
  getRiskPerTradePctForAsset,
  getMaxConcurrentForAsset,
  isAssetClassEnabled,
  type UserTradingSettings,
} from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import { makeOandaClient } from '@/app/lib/trading/oanda-client'
import { computeForexSize } from '@/app/lib/trading/forex-sizing'
import { routeTicker } from '@/app/lib/trading/asset-router'
import { haltUserAccount } from '@/app/lib/trading/kill-switches'
import { randomBytes } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_VERDICTS_PER_USER = 20
const VERDICT_AGE_HOURS = 4

interface VerdictRow {
  id: number; user_id: string; ticker: string; signal: string
  confidence: number | string | null
  entry_price: number | string | null; stop_loss: number | string | null; take_profit: number | string | null
  trader_decision: string | null; trader_grade: string | null
  trader_position_size: number | string | null
  created_at: string
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary = { users: 0, considered: 0, placed: 0, skipped: 0, errors: 0, durationMs: 0 }

  try {
    const users = (await listEnabledTradingUsers()).filter(s => isAssetClassEnabled(s, 'forex'))
    summary.users = users.length

    for (const settings of users) {
      try {
        // Load OANDA credentials for forex
        const credLoad = await loadBrokerCredentialForUse(settings.userId, 'oanda', settings.mode, 'forex')
        if (!credLoad) {
          console.warn(`[auto-trade-forex] user=${settings.userId} no oanda forex credential`)
          continue
        }
        // For OANDA, keyId is the accountId and secret is the access token
        const oandaAccountId = credLoad.keyId
        const accessToken = credLoad.secret
        const oanda = makeOandaClient(oandaAccountId, accessToken, settings.mode)

        // Per-class capacity
        const cap = getMaxConcurrentForAsset(settings, 'forex')
        const openCount = await countOpenForexAttempts(settings.userId)
        if (openCount >= cap) continue

        // Total cumulative cap
        const totalOpen = await countAllOpenAttempts(settings.userId)
        if (totalOpen >= settings.totalMaxConcurrent) continue

        // Fetch new forex verdicts
        const verdicts = await fetchNewForexVerdicts(settings.userId, settings.lastProcessedVerdictId ?? 0)
        summary.considered += verdicts.length

        let maxId = settings.lastProcessedVerdictId ?? 0
        for (const verdict of verdicts) {
          maxId = Math.max(maxId, verdict.id)

          const route = routeTicker(verdict.ticker)
          if (route.assetClass !== 'forex') continue  // wrong class for this worker

          if (verdict.trader_decision !== 'TAKE') {
            await logSkipped(verdict, settings, route.normalizedSymbol, `not a TAKE (${verdict.trader_decision})`)
            summary.skipped++; continue
          }
          if (!verdict.trader_grade || gradeRank(verdict.trader_grade) < gradeRank(settings.minGrade)) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `grade ${verdict.trader_grade} below floor ${settings.minGrade}`)
            summary.skipped++; continue
          }
          const ageH = (Date.now() - new Date(verdict.created_at).getTime()) / 3_600_000
          if (ageH > VERDICT_AGE_HOURS) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `verdict ${ageH.toFixed(1)}h old`)
            summary.skipped++; continue
          }
          if (verdict.signal !== 'BULLISH' && verdict.signal !== 'BEARISH') {
            await logSkipped(verdict, settings, route.normalizedSymbol, `signal ${verdict.signal} not actionable`)
            summary.skipped++; continue
          }

          const entry = verdict.entry_price !== null ? Number(verdict.entry_price) : NaN
          const stop = verdict.stop_loss !== null ? Number(verdict.stop_loss) : NaN
          const target = verdict.take_profit !== null ? Number(verdict.take_profit) : NaN
          if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) {
            await logSkipped(verdict, settings, route.normalizedSymbol, 'missing or invalid entry/stop/target')
            summary.skipped++; continue
          }
          // Direction sanity
          const longSide = verdict.signal === 'BULLISH'
          if (longSide && (stop >= entry || target <= entry)) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `BULLISH stop/target on wrong side`)
            summary.skipped++; continue
          }
          if (!longSide && (stop <= entry || target >= entry)) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `BEARISH stop/target on wrong side`)
            summary.skipped++; continue
          }

          // Get instrument metadata
          const instrument = await oanda.instrument(route.normalizedSymbol)
          if (!instrument) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `OANDA instrument lookup failed for ${route.normalizedSymbol}`)
            summary.skipped++; continue
          }

          // Get account summary
          let account: Awaited<ReturnType<typeof oanda.accountSummary>>
          try {
            account = await oanda.accountSummary()
          } catch (e) {
            await haltUserAccount(settings.userId, `OANDA account fetch failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`)
            summary.errors++
            break
          }
          if (account.equity <= 0) {
            await haltUserAccount(settings.userId, `OANDA equity is ${account.equity}`)
            summary.errors++
            break
          }

          // Sizing
          const traderSize = verdict.trader_position_size !== null
            ? Math.min(1, Math.max(0.1, Number(verdict.trader_position_size)))
            : 1
          const sizing = computeForexSize({
            accountEquity: account.equity,
            accountCurrency: account.currency,
            riskPerTradePct: getRiskPerTradePctForAsset(settings, 'forex'),
            maxPositionPct: settings.maxPositionPct,
            entryPrice: entry,
            stopPrice: stop,
            instrument: route.normalizedSymbol,
            pipLocation: instrument.pipLocation,
            minimumTradeSize: Number(instrument.minimumTradeSize),
            traderPositionSizePct: traderSize,
          })
          if (!sizing.ok) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `forex sizing: ${sizing.reason}`)
            summary.skipped++; continue
          }

          // Re-check capacity right before placing (race conditions)
          const stillOpen = await countOpenForexAttempts(settings.userId)
          if (stillOpen >= cap) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `at max forex positions (${stillOpen}/${cap})`)
            summary.skipped++; continue
          }
          const stillTotal = await countAllOpenAttempts(settings.userId)
          if (stillTotal >= settings.totalMaxConcurrent) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `at total max positions (${stillTotal}/${settings.totalMaxConcurrent})`)
            summary.skipped++; continue
          }

          // Don't pyramid: skip if already open on this instrument
          const positions = await oanda.positions().catch(() => [])
          const existing = positions.find(p =>
            p.instrument === route.normalizedSymbol && p.side !== 'flat'
          )
          if (existing) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `already in position ${existing.side} ${Math.abs(existing.netUnits)} units`)
            summary.skipped++; continue
          }

          // Place market order with TP/SL attached
          const clientOrderId = `wos-f-${verdict.id}-${randomBytes(4).toString('hex')}`
          const signedUnits = longSide ? sizing.units : -sizing.units
          try {
            const result = await oanda.marketOrder({
              instrument: route.normalizedSymbol,
              units: signedUnits,
              takeProfitPrice: target,
              stopLossPrice: stop,
              clientOrderId,
            })

            // Check the order didn't get rejected/cancelled
            const fillTx = result.orderFillTransaction
            const cancelTx = result.orderCancelTransaction
            if (cancelTx) {
              await logRejected(verdict, settings, route.normalizedSymbol, clientOrderId, `OANDA cancelled: ${cancelTx.reason ?? 'unknown'}`)
              summary.errors++
              continue
            }
            const filledUnits = fillTx?.units ? Math.abs(Number(fillTx.units)) : sizing.units
            const filledPrice = fillTx?.price !== undefined ? Number(fillTx.price) : entry
            const brokerOrderId = result.orderCreateTransaction?.id ?? fillTx?.id ?? clientOrderId

            await logPlaced(verdict, settings, {
              normalizedSymbol: route.normalizedSymbol,
              clientOrderId,
              brokerOrderId,
              units: filledUnits,
              side: longSide ? 'buy' : 'sell',
              entryPrice: filledPrice,
              stopPrice: stop,
              targetPrice: target,
              dollarRisk: sizing.dollarRisk,
              accountEquity: account.equity,
            })
            summary.placed++
            console.log(`[auto-trade-forex] PLACED user=${settings.userId} ${longSide ? 'BUY' : 'SELL'} ${filledUnits} ${route.normalizedSymbol} @ ${filledPrice} stop=${stop} tp=${target} risk=$${sizing.dollarRisk.toFixed(2)}`)
          } catch (e) {
            await logRejected(verdict, settings, route.normalizedSymbol, clientOrderId, e instanceof Error ? e.message : String(e))
            summary.errors++
          }
        }

        if (maxId > (settings.lastProcessedVerdictId ?? 0)) {
          await setWorkerWatermark(settings.userId, maxId)
        }
      } catch (e) {
        summary.errors++
        console.error(`[auto-trade-forex] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[auto-trade-forex cron] done in ${summary.durationMs}ms placed=${summary.placed} skipped=${summary.skipped}`)
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────

function gradeRank(g: string): number {
  return g === 'A' ? 3 : g === 'B' ? 2 : g === 'C' ? 1 : 0
}

async function fetchNewForexVerdicts(userId: string, watermark: number): Promise<VerdictRow[]> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - VERDICT_AGE_HOURS * 3_600_000).toISOString()
  const { data, error } = await admin
    .from('verdict_log')
    .select('id, user_id, ticker, signal, confidence, entry_price, stop_loss, take_profit, trader_decision, trader_grade, trader_position_size, created_at')
    .eq('user_id', userId)
    .gt('id', watermark)
    .eq('trader_decision', 'TAKE')
    .gte('created_at', cutoff)
    .order('id', { ascending: true })
    .limit(MAX_VERDICTS_PER_USER)
  if (error) return []
  return (data ?? []) as VerdictRow[]
}

async function countOpenForexAttempts(userId: string): Promise<number> {
  const admin = await getSupabaseAdmin()
  const { count } = await admin
    .from('trade_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('asset_class', 'forex')
    .in('outcome', ['placed', 'filled', 'partial_fill'])
  return count ?? 0
}

async function countAllOpenAttempts(userId: string): Promise<number> {
  const admin = await getSupabaseAdmin()
  const { count } = await admin
    .from('trade_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('outcome', ['placed', 'filled', 'partial_fill'])
  return count ?? 0
}

async function logSkipped(verdict: VerdictRow, settings: UserTradingSettings, normSymbol: string, reason: string): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId, verdict_log_id: verdict.id,
    ticker: normSymbol, asset_class: 'forex',
    council_signal: verdict.signal, outcome: 'skipped', reject_reason: reason,
    mode: settings.mode, broker: 'oanda', signal_source: 'council',
  })
}

async function logPlaced(
  verdict: VerdictRow, settings: UserTradingSettings,
  details: {
    normalizedSymbol: string; clientOrderId: string; brokerOrderId: string
    units: number; side: 'buy' | 'sell'
    entryPrice: number; stopPrice: number; targetPrice: number
    dollarRisk: number; accountEquity: number
  },
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId, verdict_log_id: verdict.id,
    ticker: details.normalizedSymbol, asset_class: 'forex',
    council_signal: verdict.signal,
    council_confidence: verdict.confidence !== null ? Math.round(Number(verdict.confidence)) : null,
    council_entry: details.entryPrice, council_stop: details.stopPrice, council_target: details.targetPrice,
    outcome: 'placed',
    mode: settings.mode, broker: 'oanda',
    broker_order_id: details.brokerOrderId, broker_client_id: details.clientOrderId,
    side: details.side, qty: details.units,
    entry_price_est: details.entryPrice, stop_price: details.stopPrice, target_price: details.targetPrice,
    risk_dollar_amount: details.dollarRisk, account_equity_at: details.accountEquity,
    signal_source: 'council',
  })
}

async function logRejected(
  verdict: VerdictRow, settings: UserTradingSettings, normSymbol: string, clientOrderId: string, msg: string,
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId, verdict_log_id: verdict.id,
    ticker: normSymbol, asset_class: 'forex',
    council_signal: verdict.signal,
    outcome: 'rejected', reject_reason: msg.slice(0, 500),
    mode: settings.mode, broker: 'oanda',
    broker_client_id: clientOrderId, signal_source: 'council',
  })
}
