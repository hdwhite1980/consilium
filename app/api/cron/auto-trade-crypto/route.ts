// =============================================================
// app/api/cron/auto-trade-crypto/route.ts
//
// Crypto auto-trader. Runs 24/7 (separate cron from stocks).
// Polls verdict_log for TAKE verdicts on crypto symbols,
// places market entries via Alpaca crypto API, then attaches
// a stop-limit child order after entry confirms.
//
// Differences from stocks worker:
//   - 24/7, no market-hours gating
//   - Fractional units (notional sizing)
//   - No bracket orders — entry + separate stop_limit child
//   - Long only (Alpaca crypto disallows shorts)
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
import { makeAlpacaCryptoClient } from '@/app/lib/trading/alpaca-crypto-client'
import { computeCryptoSize } from '@/app/lib/trading/crypto-sizing'
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
    const users = (await listEnabledTradingUsers())
      .filter(s => isAssetClassEnabled(s, 'crypto'))
    summary.users = users.length

    for (const settings of users) {
      try {
        // Find this user's crypto credentials (separate from stocks)
        const credLoad = await loadBrokerCredentialForUse(settings.userId, 'alpaca', settings.mode, 'crypto')
        if (!credLoad) {
          console.warn(`[auto-trade-crypto] user=${settings.userId} no alpaca crypto credential; skipping`)
          continue
        }
        const alpaca = makeAlpacaCryptoClient(credLoad.keyId, credLoad.secret, settings.mode)

        // Check concurrent crypto positions
        const openCount = await countOpenCryptoAttempts(settings.userId)
        const cap = getMaxConcurrentForAsset(settings, 'crypto')
        if (openCount >= cap) {
          continue
        }

        // Fetch new crypto verdicts
        const verdicts = await fetchNewCryptoVerdicts(settings.userId, settings.lastProcessedVerdictId ?? 0)
        summary.considered += verdicts.length

        let maxId = settings.lastProcessedVerdictId ?? 0
        for (const verdict of verdicts) {
          maxId = Math.max(maxId, verdict.id)

          // Route + filter
          const route = routeTicker(verdict.ticker)
          if (route.assetClass !== 'crypto') continue   // someone else's job
          if (verdict.trader_decision !== 'TAKE') {
            await logSkipped(verdict, settings, `not a TAKE (${verdict.trader_decision})`)
            summary.skipped++
            continue
          }
          if (!verdict.trader_grade || gradeRank(verdict.trader_grade) < gradeRank(settings.minGrade)) {
            await logSkipped(verdict, settings, `grade ${verdict.trader_grade} below floor ${settings.minGrade}`)
            summary.skipped++
            continue
          }
          // Age check
          const ageH = (Date.now() - new Date(verdict.created_at).getTime()) / 3_600_000
          if (ageH > VERDICT_AGE_HOURS) {
            await logSkipped(verdict, settings, `verdict ${ageH.toFixed(1)}h old`)
            summary.skipped++
            continue
          }
          // Sell-side: Alpaca crypto doesn't support shorts; can only place SELL on existing position
          if (verdict.signal === 'BEARISH') {
            await logSkipped(verdict, settings, 'BEARISH crypto not tradeable (no shorting)')
            summary.skipped++
            continue
          }
          if (verdict.signal !== 'BULLISH') {
            await logSkipped(verdict, settings, `signal ${verdict.signal} not actionable`)
            summary.skipped++
            continue
          }

          // Trade plan
          const entry = verdict.entry_price !== null ? Number(verdict.entry_price) : NaN
          const stop = verdict.stop_loss !== null ? Number(verdict.stop_loss) : NaN
          const target = verdict.take_profit !== null ? Number(verdict.take_profit) : NaN
          if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) {
            await logSkipped(verdict, settings, 'missing or invalid entry/stop/target')
            summary.skipped++
            continue
          }
          if (stop >= entry) {
            await logSkipped(verdict, settings, `stop (${stop}) >= entry (${entry}) on BULLISH`)
            summary.skipped++
            continue
          }

          // Verify Alpaca tradability
          const tradable = await alpaca.assetTradable(route.normalizedSymbol)
          if (!tradable.tradable) {
            await logSkipped(verdict, settings, `Alpaca crypto: ${tradable.reason ?? 'not tradable'}`)
            summary.skipped++
            continue
          }

          // Sizing
          //
          // Audit Finding 1: Alpaca crypto's `equity` includes unrealized P&L
          // on open crypto positions. `cash` is what we can actually deploy
          // (crypto is unmargined for retail accounts on Alpaca). Using the
          // min defends against both winning-streak inflation and the rare
          // case where they diverge.
          const account = await alpaca.account().catch(() => null)
          if (!account || account.equity <= 0) {
            await haltUserAccount(settings.userId, `crypto account fetch failed or equity <= 0`)
            summary.errors++
            break
          }
          const effectiveEquity = Math.min(account.equity, account.cash)
          if (effectiveEquity <= 0) {
            await logSkipped(verdict, settings, `crypto effectiveEquity ${effectiveEquity} <= 0`)
            summary.skipped++
            continue
          }

          // Per-trade bounds from settings (Audit Phase 2).
          const traderSize = verdict.trader_position_size !== null
            ? Math.min(1, Math.max(0.1, Number(verdict.trader_position_size)))
            : 1
          const sizing = computeCryptoSize({
            accountEquity: effectiveEquity,
            riskPerTradePct: getRiskPerTradePctForAsset(settings, 'crypto'),
            maxPositionPct: settings.maxPositionPct,
            entryPrice: entry,
            stopPrice: stop,
            traderPositionSizePct: traderSize,
            minDollarRiskPerTrade: settings.minDollarRiskPerTrade,
            maxDollarRiskPerTrade: settings.maxDollarRiskPerTrade,
            minTradeNotional: settings.minTradeNotional,
            maxTradeNotional: settings.maxTradeNotional,
          })
          if (!sizing.ok) {
            await logSkipped(verdict, settings, `crypto sizing: ${sizing.reason}`)
            summary.skipped++
            continue
          }

          // Pre-place buying-power gate (Audit Phase 3).
          // For Alpaca crypto, available capital = account.cash (unmargined).
          // 5% safety margin covers market fill slippage above entry estimate.
          const CRYPTO_BUYING_POWER_SAFETY_MARGIN = 0.95
          const cryptoSafeCash = account.cash * CRYPTO_BUYING_POWER_SAFETY_MARGIN
          if (sizing.notionalUsd > cryptoSafeCash) {
            await logSkipped(verdict, settings,
              `pre-place gate: notional $${sizing.notionalUsd.toFixed(2)} > safe cash $${cryptoSafeCash.toFixed(2)} (raw: $${account.cash.toFixed(2)})`)
            summary.skipped++
            continue
          }

          // Re-check capacity (per-asset + total)
          const stillOpen = await countOpenCryptoAttempts(settings.userId)
          if (stillOpen >= cap) {
            await logSkipped(verdict, settings, `at max crypto positions (${stillOpen}/${cap})`)
            summary.skipped++
            continue
          }
          const totalOpen = await countAllOpenAttempts(settings.userId)
          if (totalOpen >= settings.totalMaxConcurrent) {
            await logSkipped(verdict, settings, `at total max positions (${totalOpen}/${settings.totalMaxConcurrent})`)
            summary.skipped++
            continue
          }

          // Place market entry
          const clientOrderId = `wos-c-${verdict.id}-${randomBytes(4).toString('hex')}`
          try {
            const order = await alpaca.marketEntry({
              symbol: route.normalizedSymbol,
              notionalUsd: sizing.notionalUsd,
              side: 'buy',
              clientOrderId,
            })
            await logPlaced(verdict, settings, {
              clientOrderId,
              brokerOrderId: order.id,
              units: sizing.units,
              notionalUsd: sizing.notionalUsd,
              entryPrice: entry,
              stopPrice: stop,
              targetPrice: target,
              dollarRisk: sizing.dollarRisk,
              accountEquity: effectiveEquity,
              normalizedSymbol: route.normalizedSymbol,
            })
            summary.placed++
            console.log(`[auto-trade-crypto] PLACED user=${settings.userId} BUY $${sizing.notionalUsd.toFixed(2)} ${route.normalizedSymbol} stop=${stop} tp=${target} mode=${settings.mode}`)
          } catch (e) {
            await logRejected(verdict, settings, clientOrderId, e instanceof Error ? e.message : String(e))
            summary.errors++
          }
        }

        if (maxId > (settings.lastProcessedVerdictId ?? 0)) {
          // Update watermark — shared with stocks worker; only advance, never regress
          // We rely on settings.lastProcessedVerdictId being a shared rolling pointer.
          await setWorkerWatermark(settings.userId, maxId)
        }
      } catch (e) {
        summary.errors++
        console.error(`[auto-trade-crypto] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[auto-trade-crypto cron] done in ${summary.durationMs}ms placed=${summary.placed} skipped=${summary.skipped}`)
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────

function gradeRank(g: string): number {
  return g === 'A' ? 3 : g === 'B' ? 2 : g === 'C' ? 1 : 0
}

async function fetchNewCryptoVerdicts(userId: string, watermark: number): Promise<VerdictRow[]> {
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

async function countOpenCryptoAttempts(userId: string): Promise<number> {
  const admin = await getSupabaseAdmin()
  const { count } = await admin
    .from('trade_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('asset_class', 'crypto')
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

async function logSkipped(verdict: VerdictRow, settings: UserTradingSettings, reason: string): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId,
    verdict_log_id: verdict.id,
    ticker: verdict.ticker,
    asset_class: 'crypto',
    council_signal: verdict.signal,
    outcome: 'skipped',
    reject_reason: reason,
    mode: settings.mode,
    broker: 'alpaca',
    signal_source: 'council',
  })
}

async function logPlaced(
  verdict: VerdictRow,
  settings: UserTradingSettings,
  details: {
    clientOrderId: string; brokerOrderId: string
    units: number; notionalUsd: number
    entryPrice: number; stopPrice: number; targetPrice: number
    dollarRisk: number; accountEquity: number; normalizedSymbol: string
  },
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId,
    verdict_log_id: verdict.id,
    ticker: details.normalizedSymbol,
    asset_class: 'crypto',
    council_signal: verdict.signal,
    council_confidence: verdict.confidence !== null ? Math.round(Number(verdict.confidence)) : null,
    council_entry: details.entryPrice,
    council_stop: details.stopPrice,
    council_target: details.targetPrice,
    outcome: 'placed',
    mode: settings.mode,
    broker: 'alpaca',
    broker_order_id: details.brokerOrderId,
    broker_client_id: details.clientOrderId,
    side: 'buy',
    qty: details.units,
    entry_price_est: details.entryPrice,
    stop_price: details.stopPrice,
    target_price: details.targetPrice,
    risk_dollar_amount: details.dollarRisk,
    account_equity_at: details.accountEquity,
    signal_source: 'council',
  })
}

async function logRejected(
  verdict: VerdictRow, settings: UserTradingSettings, clientOrderId: string, msg: string,
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId,
    verdict_log_id: verdict.id,
    ticker: verdict.ticker,
    asset_class: 'crypto',
    council_signal: verdict.signal,
    outcome: 'rejected',
    reject_reason: msg.slice(0, 500),
    mode: settings.mode,
    broker: 'alpaca',
    broker_client_id: clientOrderId,
    signal_source: 'council',
  })
}
