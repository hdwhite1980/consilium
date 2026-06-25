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

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_VERDICTS_PER_USER_PER_RUN = 20  // safety cap
// Cap how many NEW positions a single cron run may open per user. Stops one
// run from churning a burst of verdicts into many correlated entries at once;
// remaining verdicts defer to the next run (re-decided, deterministic id so no
// duplicate). Concurrent-position cap (kill switch) still applies on top.
const MAX_NEW_POSITIONS_PER_RUN = 5
// How many times a verdict that keeps ERRORING (transient throw / broker 5xx)
// may be retried across runs before we give up and advance past it, so one bad
// verdict can never wedge the watermark for everything newer than it.
const MAX_ATTEMPT_RETRIES = 3

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

        // Watermark advancement model (#4): advance only PAST verdicts that
        // reached a terminal state (placed / skipped / halt / already-placed /
        // rejected, or an error that exhausted its retries). The first
        // RETRYABLE error blocks further advancement so that verdict — and the
        // ones after it — get reprocessed next run instead of being silently
        // dropped. Deterministic client_order_ids make reprocessing safe.
        let advanceTo = watermark
        let blocked = false
        let placedThisRun = 0
        const resolve = (id: number) => { if (!blocked) advanceTo = id }

        for (const verdict of verdicts) {
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
            // Retryable error: block the watermark so this verdict retries next
            // run — unless it has already failed MAX_ATTEMPT_RETRIES times, in
            // which case give up and advance past it.
            const priorErrors = await countErrorAttempts(settings.userId, verdict.id)
            if (priorErrors + 1 >= MAX_ATTEMPT_RETRIES) resolve(verdict.id)
            else blocked = true
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
            resolve(verdict.id)
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
            resolve(verdict.id)
            // Stop processing this user's remaining verdicts
            break
          }

          // Per-run new-position cap (#9): stop opening positions once we hit
          // the cap and defer the rest to the next run (do NOT advance past
          // them, so they get reconsidered). break is safe: deterministic ids
          // mean a re-decided verdict can't double-place.
          if (placedThisRun >= MAX_NEW_POSITIONS_PER_RUN) {
            blocked = true
            userSummary.decisions.push({
              verdictId: verdict.id, ticker: verdict.ticker, outcome: 'deferred',
              reason: `per-run cap reached (${MAX_NEW_POSITIONS_PER_RUN}); deferring to next run`,
            })
            break
          }

          // decision.kind === 'place' — actually place the order.
          // Deterministic client_order_id (#2): keyed only on verdict id so the
          // broker's own duplicate-client_order_id rejection is a hard backstop
          // against double-placement if a run crashes after placing but before
          // the watermark is persisted.
          const clientOrderId = `wos-${verdict.id}`
          try {
            // Idempotency: with a deterministic id this actually finds a prior
            // placement for the same verdict and skips re-placing it.
            const existing = await alpaca.getOrderByClientId(clientOrderId).catch(() => null)
            if (existing) {
              userSummary.decisions.push({
                verdictId: verdict.id, ticker: verdict.ticker, outcome: 'already_placed',
              })
              resolve(verdict.id)
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
            placedThisRun++

            // Day-route trades on names with an IMMINENT earnings print (opt-in
            // via earningsFullSize) so the day-monitor owns them and flattens
            // before the print. Multi-day pre-earnings run-up rides entered a
            // couple days early are normal TAKEs (not earnings bypasses), so
            // decide() leaves them 'swing'; this promotes them to 'day'. The
            // flatten logic then holds overnight until the print is imminent.
            let effectiveMode = decision.monitorMode
            if (settings.earningsFullSize && effectiveMode !== 'day') {
              try {
                const admin2 = await getSupabaseAdmin()
                const today2 = new Date().toISOString().split('T')[0]
                const to2 = new Date(Date.now() + 4 * 86400000).toISOString().split('T')[0]
                const { data: ew } = await admin2
                  .from('earnings_watch')
                  .select('id')
                  .eq('ticker', decision.ticker.toUpperCase())
                  .gte('report_date', today2)
                  .lte('report_date', to2)
                  .in('status', ['watching', 'analyzed', 'entered'])
                  .limit(1)
                if ((ew?.length ?? 0) > 0) effectiveMode = 'day'
              } catch { /* leave routing as decided */ }
            }

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
              monitorMode: effectiveMode,
            })
            userSummary.decisions.push({
              verdictId: verdict.id, ticker: verdict.ticker, outcome: 'placed',
              reason: decision.rationale,
            })
            resolve(verdict.id)
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
            // Broker rejection is terminal (bad price, market closed, not
            // tradable) — retrying rarely helps and would wedge the watermark.
            resolve(verdict.id)
            console.error(`[auto-trade] REJECTED user=${settings.userId} ${decision.ticker}:`, msg.slice(0, 300))
          }
        }

        // Persist the watermark up to the last fully-resolved verdict.
        if (advanceTo > watermark) {
          await setWorkerWatermark(settings.userId, advanceTo)
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

async function countErrorAttempts(userId: string, verdictId: number): Promise<number> {
  const admin = await getSupabaseAdmin()
  const { count, error } = await admin
    .from('trade_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('verdict_log_id', verdictId)
    .eq('outcome', 'error')
  if (error) {
    console.warn('[auto-trade] countErrorAttempts failed:', error.message)
    return 0
  }
  return count ?? 0
}

async function fetchNewVerdicts(userId: string, watermark: number): Promise<VerdictForTrade[]> {
  const admin = await getSupabaseAdmin()
  // Look back 4 hours max; ignore older verdicts as too stale
  const cutoff = new Date(Date.now() - 4 * 3_600_000).toISOString()
  // PASS bypass (June 22, 2026): we now fetch PASS verdicts too. decideForUser
  // classifies them via classifyPassBypass — most still skip, but marginal-R:R
  // and earnings-window passes become bypass placements at half size.
  const { data, error } = await admin
    .from('verdict_log')
    .select('id, user_id, ticker, signal, confidence, entry_price, stop_loss, take_profit, timeframe, trader_decision, trader_grade, trader_position_size, trader_risk_reward, trader_pass_reasons, created_at')
    .eq('user_id', userId)
    .gt('id', watermark)
    .in('trader_decision', ['TAKE', 'PASS'])
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
  monitorMode?: 'swing' | 'day'
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
    monitor_mode: payload.monitorMode ?? 'swing',
  })
}
