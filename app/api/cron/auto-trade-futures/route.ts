// =============================================================
// app/api/cron/auto-trade-futures/route.ts
//
// Futures auto-trader via Tradovate.
//
// Schedule: Sun 22:00 → Fri 22:00 UTC (futures market closes
// Fri 4pm CT, reopens Sun 5pm CT).
//
// Differences from stocks/crypto/forex workers:
//   - Tradovate session token refreshes every 80 min (handled by client)
//   - Contract resolution: verdict ticker "ES" → front-month contract ID
//   - Position size is contract count (integer), not shares/units
//   - No bracket order endpoint in v1 client; entry first, then
//     separate stop + target child orders
//   - Long AND short supported
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
import { loadTradovateSession, saveTradovateTokenCache } from '@/app/lib/trading/credentials'
import { makeTradovateClient } from '@/app/lib/trading/tradovate-client'
import { computeFuturesSize, isFuturesRootSupported } from '@/app/lib/trading/futures-sizing'
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
    const users = (await listEnabledTradingUsers()).filter(s => isAssetClassEnabled(s, 'futures'))
    summary.users = users.length

    for (const settings of users) {
      try {
        const session = await loadTradovateSession(settings.userId, settings.mode)
        if (!session) {
          console.warn(`[auto-trade-futures] user=${settings.userId} no tradovate futures credential`)
          continue
        }
        if (session.accountSpec === null || session.accountIntId === null) {
          console.warn(`[auto-trade-futures] user=${settings.userId} Tradovate session missing accountSpec/accountIntId`)
          continue
        }

        const tradovate = makeTradovateClient({
          mode: settings.mode,
          credentials: {
            username: session.username,
            password: session.password,
            appId: session.appId,
            appVersion: session.appVersion,
            cid: session.cid,
            sec: session.sec,
          },
          accountSpec: session.accountSpec,
          accountIntId: session.accountIntId,
          cachedAccessToken: session.cachedAccessToken,
          cachedExpiresAt: session.cachedTokenExpiresAt,
          onTokenRefreshed: async (token, expiresAt) => {
            await saveTradovateTokenCache(session.credentialRowId, token, expiresAt)
          },
        })

        // Per-class capacity
        const cap = getMaxConcurrentForAsset(settings, 'futures')
        const openCount = await countOpenFuturesAttempts(settings.userId)
        if (openCount >= cap) continue

        // Total cumulative cap
        const totalOpen = await countAllOpenAttempts(settings.userId)
        if (totalOpen >= settings.totalMaxConcurrent) continue

        // Fetch new futures verdicts
        const verdicts = await fetchNewFuturesVerdicts(settings.userId, settings.lastProcessedVerdictId ?? 0)
        summary.considered += verdicts.length

        let maxId = settings.lastProcessedVerdictId ?? 0
        for (const verdict of verdicts) {
          maxId = Math.max(maxId, verdict.id)

          const route = routeTicker(verdict.ticker)
          if (route.assetClass !== 'futures') continue

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
          // Currently only equity-index + VX futures roots are supported by sizing
          if (!isFuturesRootSupported(route.normalizedSymbol)) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `futures root not yet supported (equity-index + VX only)`)
            summary.skipped++; continue
          }

          const entry = verdict.entry_price !== null ? Number(verdict.entry_price) : NaN
          const stop = verdict.stop_loss !== null ? Number(verdict.stop_loss) : NaN
          const target = verdict.take_profit !== null ? Number(verdict.take_profit) : NaN
          if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) {
            await logSkipped(verdict, settings, route.normalizedSymbol, 'missing or invalid entry/stop/target')
            summary.skipped++; continue
          }
          const longSide = verdict.signal === 'BULLISH'
          if (longSide && (stop >= entry || target <= entry)) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `BULLISH stop/target on wrong side`)
            summary.skipped++; continue
          }
          if (!longSide && (stop <= entry || target >= entry)) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `BEARISH stop/target on wrong side`)
            summary.skipped++; continue
          }

          // Resolve front-month contract
          const contract = await tradovate.findFrontMonthContract(route.normalizedSymbol)
          if (!contract) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `Tradovate: no active front-month for ${route.normalizedSymbol}`)
            summary.skipped++; continue
          }

          // Cash summary
          let cash: Awaited<ReturnType<typeof tradovate.cashSummary>>
          try {
            cash = await tradovate.cashSummary()
          } catch (e) {
            await haltUserAccount(settings.userId, `Tradovate cash fetch failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`)
            summary.errors++
            break
          }
          if (cash.totalCashValue <= 0) {
            await haltUserAccount(settings.userId, `Tradovate cash totalCashValue=${cash.totalCashValue}`)
            summary.errors++
            break
          }

          // Audit Finding 1: previous code used `totalCashValue + unrealizedPnL`
          // which OVER-counts available capital during winning streaks (paper
          // gains haven't been realized but were being used as sizing fuel).
          // `availableLiquidity` is what Tradovate says we can actually deploy
          // after accounting for open margin requirements. Fall back to
          // totalCashValue if availableLiquidity isn't set (older API responses).
          const effectiveEquity = cash.availableLiquidity > 0
            ? Math.min(cash.totalCashValue, cash.availableLiquidity)
            : cash.totalCashValue
          if (effectiveEquity <= 0) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `futures effectiveEquity ${effectiveEquity} <= 0`)
            summary.skipped++; continue
          }

          // Per-trade bounds from settings (Audit Phase 2).
          // Sizing
          const traderSize = verdict.trader_position_size !== null
            ? Math.min(1, Math.max(0.1, Number(verdict.trader_position_size)))
            : 1
          const sizing = computeFuturesSize({
            accountEquity: effectiveEquity,
            riskPerTradePct: getRiskPerTradePctForAsset(settings, 'futures'),
            maxPositionPct: settings.maxPositionPct,
            entryPrice: entry,
            stopPrice: stop,
            rootSymbol: route.normalizedSymbol,
            traderPositionSizePct: traderSize,
            minDollarRiskPerTrade: settings.minDollarRiskPerTrade,
            maxDollarRiskPerTrade: settings.maxDollarRiskPerTrade,
            minTradeNotional: settings.minTradeNotional,
            maxTradeNotional: settings.maxTradeNotional,
          })
          if (!sizing.ok) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `futures sizing: ${sizing.reason}`)
            summary.skipped++; continue
          }

          // Pre-place buying-power gate (Audit Phase 3).
          // For Tradovate futures, the relevant ceiling is availableLiquidity
          // (what's actually free for new margin). The position "notional" for
          // futures = estimatedMarginUsd. Apply 5% safety margin for slippage
          // and the fact that initialMarginEst is itself an approximation.
          const FUTURES_BUYING_POWER_SAFETY_MARGIN = 0.95
          const futuresSafeLiq = (cash.availableLiquidity > 0 ? cash.availableLiquidity : cash.totalCashValue)
            * FUTURES_BUYING_POWER_SAFETY_MARGIN
          if (sizing.estimatedMarginUsd > futuresSafeLiq) {
            await logSkipped(verdict, settings, route.normalizedSymbol,
              `pre-place gate: estMargin $${sizing.estimatedMarginUsd.toFixed(2)} > safe liquidity $${futuresSafeLiq.toFixed(2)} (avail: $${cash.availableLiquidity.toFixed(2)})`)
            summary.skipped++; continue
          }

          // Re-check capacity right before placing
          const stillOpen = await countOpenFuturesAttempts(settings.userId)
          if (stillOpen >= cap) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `at max futures positions (${stillOpen}/${cap})`)
            summary.skipped++; continue
          }
          const stillTotal = await countAllOpenAttempts(settings.userId)
          if (stillTotal >= settings.totalMaxConcurrent) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `at total max positions (${stillTotal}/${settings.totalMaxConcurrent})`)
            summary.skipped++; continue
          }

          // No-pyramid check on same contract
          const positions = await tradovate.positions().catch(() => [])
          const existing = positions.find(p => p.contractId === contract.id && p.netPos !== 0)
          if (existing) {
            await logSkipped(verdict, settings, route.normalizedSymbol, `already in position ${existing.netPos > 0 ? 'long' : 'short'} ${Math.abs(existing.netPos)} contracts on ${contract.name}`)
            summary.skipped++; continue
          }

          // Place market order
          const clientOrderId = `wos-fut-${verdict.id}-${randomBytes(4).toString('hex')}`
          try {
            const result = await tradovate.placeOrder({
              contractId: contract.id,
              action: longSide ? 'Buy' : 'Sell',
              qty: sizing.contracts,
              orderType: 'Market',
              isAutomated: true,
            })
            if (result.failureReason || result.failureText) {
              await logRejected(verdict, settings, route.normalizedSymbol, clientOrderId,
                `Tradovate ${result.failureReason ?? 'unknown'}: ${result.failureText ?? ''}`)
              summary.errors++
              continue
            }

            await logPlaced(verdict, settings, {
              normalizedSymbol: route.normalizedSymbol,
              contractName: contract.name,
              clientOrderId,
              brokerOrderId: result.orderId ? String(result.orderId) : clientOrderId,
              contracts: sizing.contracts,
              side: longSide ? 'buy' : 'sell',
              entryPrice: entry,
              stopPrice: stop,
              targetPrice: target,
              dollarRisk: sizing.totalDollarRisk,
              accountEquity: effectiveEquity,
              marginUsed: sizing.estimatedMarginUsd,
            })
            summary.placed++
            console.log(`[auto-trade-futures] PLACED user=${settings.userId} ${longSide ? 'BUY' : 'SELL'} ${sizing.contracts}× ${contract.name} stop=${stop} tp=${target} risk=$${sizing.totalDollarRisk.toFixed(2)}`)
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
        console.error(`[auto-trade-futures] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[auto-trade-futures cron] done in ${summary.durationMs}ms placed=${summary.placed} skipped=${summary.skipped}`)
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────

function gradeRank(g: string): number {
  return g === 'A' ? 3 : g === 'B' ? 2 : g === 'C' ? 1 : 0
}

async function fetchNewFuturesVerdicts(userId: string, watermark: number): Promise<VerdictRow[]> {
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

async function logSkipped(verdict: VerdictRow, settings: UserTradingSettings, normSymbol: string, reason: string): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId, verdict_log_id: verdict.id,
    ticker: normSymbol, asset_class: 'futures',
    council_signal: verdict.signal, outcome: 'skipped', reject_reason: reason,
    mode: settings.mode, broker: 'tradovate', signal_source: 'council',
  })
}

async function logPlaced(
  verdict: VerdictRow, settings: UserTradingSettings,
  details: {
    normalizedSymbol: string; contractName: string
    clientOrderId: string; brokerOrderId: string
    contracts: number; side: 'buy' | 'sell'
    entryPrice: number; stopPrice: number; targetPrice: number
    dollarRisk: number; accountEquity: number; marginUsed: number
  },
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId, verdict_log_id: verdict.id,
    ticker: details.contractName, asset_class: 'futures',
    council_signal: verdict.signal,
    council_confidence: verdict.confidence !== null ? Math.round(Number(verdict.confidence)) : null,
    council_entry: details.entryPrice, council_stop: details.stopPrice, council_target: details.targetPrice,
    outcome: 'placed',
    mode: settings.mode, broker: 'tradovate',
    broker_order_id: details.brokerOrderId, broker_client_id: details.clientOrderId,
    side: details.side, qty: details.contracts,
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
    ticker: normSymbol, asset_class: 'futures',
    council_signal: verdict.signal,
    outcome: 'rejected', reject_reason: msg.slice(0, 500),
    mode: settings.mode, broker: 'tradovate',
    broker_client_id: clientOrderId, signal_source: 'council',
  })
}
