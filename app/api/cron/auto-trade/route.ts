// =============================================================
// app/api/cron/auto-trade/route.ts
//
// Polling worker for the auto-trader. Runs every ~5 minutes
// via GitHub Actions cron. For each enabled user:
//   1. Find new verdicts since their watermark
//   2. For each verdict, run decide pipeline
//   3. Place bracket orders for 'place' decisions
//   4. Log all attempts to trade_attempts
//   5. Update watermark
//
// CRON_SECRET gated. Returns a structured summary.
//
// Idempotency: trade_attempts has a unique index on
// (user_id, verdict_log_id) for placed/filled outcomes. Re-running
// the worker won't double-fire.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers, setWorkerWatermark } from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import { makeAlpacaClient } from '@/app/lib/trading/alpaca-client'
import { decideForUser, type VerdictForTrade, type Decision } from '@/app/lib/trading/decide'
import { haltUserAccount } from '@/app/lib/trading/kill-switches'
import { randomBytes } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_VERDICTS_PER_USER_PER_RUN = 20  // safety cap

interface UserSummary {
  userId: string
  email?: string
  enabled: boolean
  mode: 'paper' | 'live'
  verdictsConsidered: number
  placed: number
  skipped: number
  halted: number
  errors: number
  haltedThisRun: boolean
  haltReason?: string
  decisions: Array<{
    verdictId: number
    ticker: string
    outcome: string
    reason?: string
  }>
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // CRON_SECRET gate
  const auth = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary: { users: UserSummary[]; durationMs: number; totalPlaced: number } = {
    users: [],
    durationMs: 0,
    totalPlaced: 0,
  }

  try {
    const users = await listEnabledTradingUsers()
    console.log(`[auto-trade cron] found ${users.length} enabled users`)

    for (const settings of users) {
      const userSummary: UserSummary = {
        userId: settings.userId,
        enabled: true,
        mode: settings.mode,
        verdictsConsidered: 0,
        placed: 0,
        skipped: 0,
        halted: 0,
        errors: 0,
        haltedThisRun: false,
        decisions: [],
      }

      try {
        // Load broker credentials for this user
        const credLoad = await loadBrokerCredentialForUse(settings.userId, settings.broker, settings.mode)
        if (!credLoad) {
          userSummary.errors++
          userSummary.decisions.push({
            verdictId: -1, ticker: '', outcome: 'no_creds',
            reason: `no ${settings.broker}/${settings.mode} credential`,
          })
          summary.users.push(userSummary)
          continue
        }
        const alpaca = makeAlpacaClient(credLoad.keyId, credLoad.secret, settings.mode)

        // Find new verdicts since watermark
        const watermark = settings.lastProcessedVerdictId ?? 0
        const verdicts = await fetchNewVerdicts(settings.userId, watermark)
        userSummary.verdictsConsidered = verdicts.length

        let maxIdProcessed = watermark
        for (const verdict of verdicts) {
          maxIdProcessed = Math.max(maxIdProcessed, verdict.id)

          let decision: Decision
          try {
            decision = await decideForUser({ verdict, settings, alpaca })
          } catch (e) {
            userSummary.errors++
            await logTradeAttempt(verdict, settings, {
              outcome: 'error',
              reason: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500),
            })
            userSummary.decisions.push({
              verdictId: verdict.id, ticker: verdict.ticker, outcome: 'error',
              reason: e instanceof Error ? e.message.slice(0, 200) : String(e),
            })
            continue
          }

          if (decision.kind === 'skip') {
            userSummary.skipped++
            await logTradeAttempt(verdict, settings, {
              outcome: 'skipped',
              reason: decision.reason,
            })
            userSummary.decisions.push({
              verdictId: verdict.id, ticker: verdict.ticker, outcome: 'skipped',
              reason: decision.reason,
            })
            continue
          }

          if (decision.kind === 'halt') {
            userSummary.halted++
            userSummary.haltedThisRun = true
            userSummary.haltReason = decision.reason
            await haltUserAccount(settings.userId, decision.reason)
            await logTradeAttempt(verdict, settings, {
              outcome: 'skipped',
              reason: `[HALTED] ${decision.reason}`,
            })
            userSummary.decisions.push({
              verdictId: verdict.id, ticker: verdict.ticker, outcome: 'halt',
              reason: decision.reason,
            })
            // Stop processing this user's remaining verdicts
            break
          }

          // decision.kind === 'place' — actually place the order
          const clientOrderId = `wos-${verdict.id}-${randomBytes(4).toString('hex')}`
          try {
            // Idempotency: check if we've already placed this clientOrderId
            const existing = await alpaca.getOrderByClientId(clientOrderId).catch(() => null)
            if (existing) {
              userSummary.decisions.push({
                verdictId: verdict.id, ticker: verdict.ticker, outcome: 'already_placed',
              })
              continue
            }

            const order = await alpaca.bracketOrder({
              symbol: decision.ticker,
              qty: decision.qty,
              side: decision.side,
              takeProfitPrice: decision.targetPrice,
              stopLossPrice: decision.stopPrice,
              clientOrderId,
            })

            userSummary.placed++
            summary.totalPlaced++
            await logTradeAttempt(verdict, settings, {
              outcome: 'placed',
              brokerOrderId: order.id,
              brokerClientId: clientOrderId,
              side: decision.side,
              qty: decision.qty,
              entryPriceEst: decision.entryPrice,
              stopPrice: decision.stopPrice,
              targetPrice: decision.targetPrice,
              dollarRisk: decision.dollarRisk,
              accountEquity: decision.accountEquity,
            })
            userSummary.decisions.push({
              verdictId: verdict.id, ticker: verdict.ticker, outcome: 'placed',
              reason: decision.rationale,
            })
            console.log(`[auto-trade] PLACED user=${settings.userId} ${decision.side} ${decision.qty} ${decision.ticker} @ ${decision.entryPrice} stop=${decision.stopPrice} tp=${decision.targetPrice} risk=$${decision.dollarRisk.toFixed(2)} mode=${settings.mode}`)
          } catch (e) {
            userSummary.errors++
            const msg = e instanceof Error ? e.message : String(e)
            await logTradeAttempt(verdict, settings, {
              outcome: 'rejected',
              reason: msg.slice(0, 500),
              brokerClientId: clientOrderId,
              side: decision.side,
              qty: decision.qty,
              entryPriceEst: decision.entryPrice,
              stopPrice: decision.stopPrice,
              targetPrice: decision.targetPrice,
              dollarRisk: decision.dollarRisk,
              accountEquity: decision.accountEquity,
            })
            userSummary.decisions.push({
              verdictId: verdict.id, ticker: verdict.ticker, outcome: 'rejected',
              reason: msg.slice(0, 200),
            })
            console.error(`[auto-trade] REJECTED user=${settings.userId} ${decision.ticker}:`, msg.slice(0, 300))
          }
        }

        // Update watermark to highest verdict id processed
        if (maxIdProcessed > watermark) {
          await setWorkerWatermark(settings.userId, maxIdProcessed)
        }
      } catch (e) {
        userSummary.errors++
        console.error(`[auto-trade cron] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }

      summary.users.push(userSummary)
    }
  } catch (e) {
    console.error('[auto-trade cron] outer failure:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[auto-trade cron] done in ${summary.durationMs}ms, placed=${summary.totalPlaced}`)
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

async function fetchNewVerdicts(userId: string, watermark: number): Promise<VerdictForTrade[]> {
  const admin = await getSupabaseAdmin()
  // Look back 4 hours max; ignore older verdicts as too stale
  const cutoff = new Date(Date.now() - 4 * 3_600_000).toISOString()
  const { data, error } = await admin
    .from('verdict_log')
    .select('id, user_id, ticker, signal, confidence, entry_price, stop_loss, take_profit, timeframe, trader_decision, trader_grade, trader_position_size, trader_risk_reward, created_at')
    .eq('user_id', userId)
    .gt('id', watermark)
    .eq('trader_decision', 'TAKE')
    .gte('created_at', cutoff)
    .order('id', { ascending: true })
    .limit(MAX_VERDICTS_PER_USER_PER_RUN)
  if (error) {
    console.error('[auto-trade] fetchNewVerdicts failed:', error.message)
    return []
  }
  return (data ?? []) as VerdictForTrade[]
}

interface LogPayload {
  outcome: 'placed' | 'rejected' | 'skipped' | 'error'
  reason?: string
  brokerOrderId?: string
  brokerClientId?: string
  side?: 'buy' | 'sell'
  qty?: number
  entryPriceEst?: number
  stopPrice?: number
  targetPrice?: number
  dollarRisk?: number
  accountEquity?: number
}

async function logTradeAttempt(
  verdict: VerdictForTrade,
  settings: { userId: string; mode: 'paper' | 'live'; broker: 'alpaca' },
  payload: LogPayload,
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId,
    verdict_log_id: verdict.id,           // link back to verdict_log row for thesis-check
    analysis_id: null,
    ticker: verdict.ticker,
    council_signal: verdict.signal,
    council_confidence: verdict.confidence !== null ? Math.round(Number(verdict.confidence)) : null,
    council_entry: verdict.entry_price !== null ? Number(verdict.entry_price) : null,
    council_stop: verdict.stop_loss !== null ? Number(verdict.stop_loss) : null,
    council_target: verdict.take_profit !== null ? Number(verdict.take_profit) : null,
    outcome: payload.outcome,
    reject_reason: payload.reason ?? null,
    mode: settings.mode,
    broker: settings.broker,
    broker_order_id: payload.brokerOrderId ?? null,
    broker_client_id: payload.brokerClientId ?? null,
    side: payload.side ?? null,
    qty: payload.qty ?? null,
    entry_price_est: payload.entryPriceEst ?? null,
    stop_price: payload.stopPrice ?? null,
    target_price: payload.targetPrice ?? null,
    risk_dollar_amount: payload.dollarRisk ?? null,
    account_equity_at: payload.accountEquity ?? null,
  })
}
