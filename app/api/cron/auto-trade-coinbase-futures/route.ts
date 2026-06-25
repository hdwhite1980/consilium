// =============================================================
// app/api/cron/auto-trade-coinbase-futures/route.ts
//
// Coinbase Financial Markets (CFM) futures auto-trader.
//
// Trades the Coinbase Derivatives universe (crypto perps, commodity nanos,
// equity index) routed via the CBF:/-PERP notation. Leveraged, real money —
// so this worker carries the SAME protection spine as the stock worker plus
// the futures-only guards baked into computeFuturesSize:
//
//   • Venue master switch (coinbase_futures_enabled) — OFF by default.
//   • Risk-% of equity sizing + quality multiplier + dollar bounds.
//   • LEVERAGE CAP, MARGIN GATE, LIQUIDATION BUFFER (in the sizing engine).
//   • Per-asset + total concurrency caps; no-pyramid per contract.
//   • Protective stop attached INLINE right after entry; if the stop can't be
//     attached, the position is immediately FLATTENED so we never hold naked
//     leverage waiting on a separate attach cycle.
//   • Kill-switch on account-fetch failure; deterministic client_order_id so a
//     lost watermark write can't double-place.
//
// Conservative posture: TAKE verdicts only (no PASS/WAIT bypass for leveraged
// futures), long AND short supported.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import {
  listEnabledTradingUsers,
  getRiskPerTradePctForAsset,
  getMaxConcurrentForAsset,
  getMaxLeverageForFutures,
  isCoinbaseFuturesEnabled,
  setVerdictWatermark,
  type UserTradingSettings,
} from '@/app/lib/trading/settings'
import { loadCoinbaseFuturesCredential } from '@/app/lib/trading/credentials'
import { makeCoinbaseClient, type CoinbaseClient } from '@/app/lib/trading/coinbase-client'
import { computeFuturesSize } from '@/app/lib/trading/coinbase-futures-sizing'
import {
  resolveFuturesContract,
  listCoinbaseFuturesContracts,
  type FuturesContract,
} from '@/app/lib/trading/coinbase-futures-products'
import { routeTicker } from '@/app/lib/trading/asset-router'
import { haltUserAccount } from '@/app/lib/trading/kill-switches'

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
  trader_risk_reward: number | string | null
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
    // Venue master switch gates entry — leveraged real money is explicit opt-in.
    const users = (await listEnabledTradingUsers()).filter(s => isCoinbaseFuturesEnabled(s))
    summary.users = users.length

    for (const settings of users) {
      try {
        const cred = await loadCoinbaseFuturesCredential(settings.userId)
        if (!cred) {
          console.warn(`[cb-futures] user=${settings.userId} no Coinbase futures credential`)
          continue
        }
        const client = makeCoinbaseClient(cred.keyName, cred.privateKey)

        // Account equity + available margin. A throw here usually means the
        // account isn't entitled for futures yet — skip the user, don't halt.
        let balance
        try {
          balance = await client.futuresBalanceSummary()
        } catch (e) {
          console.warn(`[cb-futures] user=${settings.userId} balance fetch failed (futures entitled?): ${e instanceof Error ? e.message : e}`)
          continue
        }
        if (!Number.isFinite(balance.totalUsd) || balance.totalUsd <= 0) {
          console.warn(`[cb-futures] user=${settings.userId} CFM equity ${balance.totalUsd} <= 0; skipping`)
          continue
        }

        // Capacity (per-asset futures cap + cross-asset total).
        const cap = getMaxConcurrentForAsset(settings, 'futures')
        const openCount = await countOpenFuturesAttempts(settings.userId)
        if (openCount >= cap) continue
        const totalOpen = await countAllOpenAttempts(settings.userId)
        if (totalOpen >= settings.totalMaxConcurrent) continue

        // Preload the live tradable universe once per user (entitlement-gated).
        let universe: FuturesContract[]
        try {
          universe = await listCoinbaseFuturesContracts(client)
        } catch (e) {
          console.warn(`[cb-futures] user=${settings.userId} product list failed: ${e instanceof Error ? e.message : e}`)
          continue
        }

        const verdicts = await fetchNewCoinbaseFuturesVerdicts(
          settings.userId, settings.coinbaseFuturesLastProcessedVerdictId ?? 0,
        )
        summary.considered += verdicts.length
        let maxId = settings.coinbaseFuturesLastProcessedVerdictId ?? 0

        const maxLeverage = getMaxLeverageForFutures(settings)
        const riskPct = getRiskPerTradePctForAsset(settings, 'futures')

        for (const verdict of verdicts) {
          maxId = Math.max(maxId, verdict.id)

          const route = routeTicker(verdict.ticker)
          if (route.assetClass !== 'futures' || route.broker !== 'coinbase') continue  // not ours

          // Conservative for leverage: TAKE only.
          if (verdict.trader_decision !== 'TAKE') {
            await logSkipped(verdict, settings, route.normalizedSymbol, `not a TAKE (${verdict.trader_decision})`)
            summary.skipped++; continue
          }
          if (!verdict.trader_grade || gradeRank(verdict.trader_grade) < gradeRank(settings.minGrade)) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `grade ${verdict.trader_grade ?? 'null'} below floor ${settings.minGrade}`)
            summary.skipped++; continue
          }
          const ageH = (Date.now() - new Date(verdict.created_at).getTime()) / 3_600_000
          if (ageH > VERDICT_AGE_HOURS) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `verdict ${ageH.toFixed(1)}h old`)
            summary.skipped++; continue
          }

          const side: 'long' | 'short' =
            verdict.signal === 'BULLISH' ? 'long' :
            verdict.signal === 'BEARISH' ? 'short' : 'long'
          if (verdict.signal !== 'BULLISH' && verdict.signal !== 'BEARISH') {
            await logSkipped(verdict, settings, route.normalizedSymbol, `signal ${verdict.signal} not actionable`)
            summary.skipped++; continue
          }

          const entry = verdict.entry_price !== null ? Number(verdict.entry_price) : NaN
          const stop = verdict.stop_loss !== null ? Number(verdict.stop_loss) : NaN
          const target = verdict.take_profit !== null ? Number(verdict.take_profit) : NaN
          if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) {
            await logSkipped(verdict, settings, route.normalizedSymbol, 'missing/invalid entry/stop/target')
            summary.skipped++; continue
          }
          if (side === 'long' && stop >= entry) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `long stop ${stop} >= entry ${entry}`)
            summary.skipped++; continue
          }
          if (side === 'short' && stop <= entry) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `short stop ${stop} <= entry ${entry}`)
            summary.skipped++; continue
          }

          // Resolve the live tradable contract (perp preferred; no roll).
          const contract = await resolveFuturesContract(client, route.normalizedSymbol, universe)
          if (!contract) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `no tradable Coinbase futures contract for ${route.normalizedSymbol}`)
            summary.skipped++; continue
          }
          if (!contract.tradable) {
            await logSkipped(verdict, settings, contract.productId, `contract not tradable: ${contract.notTradableReason ?? 'unknown'}`)
            summary.skipped++; continue
          }

          // No-pyramid: skip if already in a position on this contract.
          const existing = await client.getFuturesPosition(contract.productId)
          if (existing && existing.contracts > 0) {
            await logSkipped(verdict, settings, contract.productId, `already in ${existing.side} ${existing.contracts} contract(s)`)
            summary.skipped++; continue
          }

          // Size through the full protection stack.
          const traderSize = verdict.trader_position_size !== null
            ? Math.min(1, Math.max(0.1, Number(verdict.trader_position_size))) : 1
          const sizing = computeFuturesSize({
            accountEquity: balance.totalUsd,
            availableMargin: balance.availableMargin,
            riskPerTradePct: riskPct,
            entryPrice: entry,
            stopPrice: stop,
            side,
            contractSize: contract.contractSize,
            initialMarginPerContract: contract.initialMarginPerContract,
            maxLeverage,
            traderPositionSizePct: traderSize,
            minDollarRiskPerTrade: settings.minDollarRiskPerTrade,
            maxDollarRiskPerTrade: settings.maxDollarRiskPerTrade,
            minTradeNotional: settings.minTradeNotional,
            maxTradeNotional: settings.maxTradeNotional,
            qualityGrade: (verdict.trader_grade === 'A' || verdict.trader_grade === 'B' || verdict.trader_grade === 'C')
              ? verdict.trader_grade : null,
            qualityConfidence: verdict.confidence !== null ? Number(verdict.confidence) : null,
            qualityRiskReward: verdict.trader_risk_reward !== null && verdict.trader_risk_reward !== undefined
              ? Number(verdict.trader_risk_reward) : null,
          })
          if (!sizing.ok) {
            await logSkipped(verdict, settings, contract.productId, `sizing: ${sizing.reason}`)
            summary.skipped++; continue
          }

          // Re-check capacity right before placing.
          const stillOpen = await countOpenFuturesAttempts(settings.userId)
          if (stillOpen >= cap) {
            await logSkipped(verdict, settings, contract.productId, `at max futures positions (${stillOpen}/${cap})`)
            summary.skipped++; continue
          }
          const stillTotal = await countAllOpenAttempts(settings.userId)
          if (stillTotal >= settings.totalMaxConcurrent) {
            await logSkipped(verdict, settings, contract.productId, `at total max positions (${stillTotal}/${settings.totalMaxConcurrent})`)
            summary.skipped++; continue
          }

          // Place entry, then attach the protective stop INLINE.
          const entrySide: 'buy' | 'sell' = side === 'long' ? 'buy' : 'sell'
          const closeSide: 'buy' | 'sell' = side === 'long' ? 'sell' : 'buy'
          const stopDir = side === 'long' ? 'STOP_DIRECTION_STOP_DOWN' : 'STOP_DIRECTION_STOP_UP'
          const clientOrderId = `wos-cf-${verdict.id}`

          let entryOrderId: string
          try {
            const order = await client.futuresMarketOrder({
              productId: contract.productId,
              side: entrySide,
              contracts: sizing.contracts,
              clientOrderId,
            })
            entryOrderId = order.id
          } catch (e) {
            await logRejected(verdict, settings, contract.productId, clientOrderId, e instanceof Error ? e.message : String(e))
            summary.errors++; continue
          }

          // Attach protective stop. On failure, FLATTEN immediately — never
          // hold naked leverage waiting on a separate attach cycle.
          let stopOrderId: string | null = null
          try {
            const stopOrder = await client.futuresStopOrder({
              productId: contract.productId,
              side: closeSide,
              contracts: sizing.contracts,
              stopPrice: stop,
              stopDirection: stopDir,
              clientOrderId: `wos-cf-stop-${verdict.id}`,
            })
            stopOrderId = stopOrder.id
          } catch (stopErr) {
            console.error(`[cb-futures] STOP ATTACH FAILED ${contract.productId} — flattening: ${stopErr instanceof Error ? stopErr.message : stopErr}`)
            try {
              await client.futuresMarketOrder({
                productId: contract.productId,
                side: closeSide,
                contracts: sizing.contracts,
                clientOrderId: `wos-cf-flat-${verdict.id}`,
              })
            } catch (flatErr) {
              // Couldn't flatten either — halt the account so a human looks.
              await haltUserAccount(settings.userId, `cb-futures: stop attach AND flatten failed on ${contract.productId} (naked leverage risk): ${flatErr instanceof Error ? flatErr.message : flatErr}`)
            }
            await logRejected(verdict, settings, contract.productId, clientOrderId,
              `stop attach failed; position flattened: ${stopErr instanceof Error ? stopErr.message : stopErr}`)
            summary.errors++; continue
          }

          await logPlaced(verdict, settings, {
            productId: contract.productId,
            displayName: contract.displayName,
            clientOrderId,
            brokerOrderId: entryOrderId,
            stopOrderId,
            contracts: sizing.contracts,
            side: entrySide,
            entryPrice: entry,
            stopPrice: stop,
            targetPrice: target,
            dollarRisk: sizing.dollarRisk,
            accountEquity: balance.totalUsd,
          })
          summary.placed++
          console.log(`[cb-futures] PLACED user=${settings.userId} ${entrySide.toUpperCase()} ${sizing.contracts}× ${contract.productId} | ${sizing.rationale}`)
        }

        if (maxId > (settings.coinbaseFuturesLastProcessedVerdictId ?? 0)) {
          await setVerdictWatermark(settings.userId, 'coinbaseFutures', maxId)
        }
      } catch (e) {
        summary.errors++
        console.error(`[cb-futures] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[cb-futures cron] done in ${summary.durationMs}ms placed=${summary.placed} skipped=${summary.skipped} errors=${summary.errors}`)
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────

function gradeRank(g: string): number {
  return g === 'A' ? 3 : g === 'B' ? 2 : g === 'C' ? 1 : 0
}

async function fetchNewCoinbaseFuturesVerdicts(userId: string, watermark: number): Promise<VerdictRow[]> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - VERDICT_AGE_HOURS * 3_600_000).toISOString()
  const { data, error } = await admin
    .from('verdict_log')
    .select('id, user_id, ticker, signal, confidence, entry_price, stop_loss, take_profit, trader_decision, trader_grade, trader_position_size, trader_risk_reward, created_at')
    .eq('user_id', userId)
    .gt('id', watermark)
    .eq('trader_decision', 'TAKE')
    .gte('created_at', cutoff)
    .order('id', { ascending: true })
    .limit(MAX_VERDICTS_PER_USER)
  if (error) return []
  return (data ?? []) as VerdictRow[]
}

// Counts ALL open futures attempts (both venues) against the futures cap.
async function countOpenFuturesAttempts(userId: string): Promise<number> {
  const admin = await getSupabaseAdmin()
  const { count } = await admin
    .from('trade_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('asset_class', 'futures')
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

async function logSkipped(verdict: VerdictRow, settings: UserTradingSettings, ticker: string, reason: string): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId, verdict_log_id: verdict.id,
    ticker, asset_class: 'futures',
    council_signal: verdict.signal, outcome: 'skipped', reject_reason: reason,
    mode: 'live', broker: 'coinbase', signal_source: 'council',
  })
}

async function logPlaced(
  verdict: VerdictRow, settings: UserTradingSettings,
  details: {
    productId: string; displayName: string
    clientOrderId: string; brokerOrderId: string; stopOrderId: string | null
    contracts: number; side: 'buy' | 'sell'
    entryPrice: number; stopPrice: number; targetPrice: number
    dollarRisk: number; accountEquity: number
  },
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId, verdict_log_id: verdict.id,
    ticker: details.productId, asset_class: 'futures',
    council_signal: verdict.signal,
    council_confidence: verdict.confidence !== null ? Math.round(Number(verdict.confidence)) : null,
    council_entry: details.entryPrice, council_stop: details.stopPrice, council_target: details.targetPrice,
    outcome: 'placed',
    mode: 'live', broker: 'coinbase',
    broker_order_id: details.brokerOrderId, broker_client_id: details.clientOrderId,
    stop_order_id: details.stopOrderId,
    side: details.side, qty: details.contracts,
    entry_price_est: details.entryPrice, stop_price: details.stopPrice, target_price: details.targetPrice,
    risk_dollar_amount: details.dollarRisk, account_equity_at: details.accountEquity,
    signal_source: 'council',
  })
}

async function logRejected(
  verdict: VerdictRow, settings: UserTradingSettings, ticker: string, clientOrderId: string, msg: string,
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId, verdict_log_id: verdict.id,
    ticker, asset_class: 'futures',
    council_signal: verdict.signal,
    outcome: 'rejected', reject_reason: msg.slice(0, 500),
    mode: 'live', broker: 'coinbase',
    broker_client_id: clientOrderId, signal_source: 'council',
  })
}
