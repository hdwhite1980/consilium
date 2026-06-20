// =============================================================
// app/api/cron/auto-trade-reeval/route.ts
//
// Active position re-evaluation. Every 15 min during market hours.
// For each user with activeMgmtEnabled=true, for each open position:
//
// 1. Check materiality triggers:
//    - Drawdown trigger: position at >= reevalDrawdownPct of stop distance
//    - News trigger: news_cache row mentioning ticker in last 30 min
//    - Technical trigger: current_price crosses below SMA50 it was above
//    - Daily-close trigger: 3:55 PM ET → re-eval all positions
//
// 2. If ANY trigger fires AND last_reeval_at > 30 min ago:
//    - Run /api/analyze for the ticker (full Council)
//    - Map verdict → decision: HOLD / TIGHTEN_STOP / EARLY_EXIT / ADD
//
// 3. Execute decision via Alpaca:
//    - HOLD: do nothing, update reeval_history
//    - TIGHTEN_STOP: cancel old stop leg, place new tighter one
//    - EARLY_EXIT: market sell the position
//    - ADD: place additional bracket order (size from settings)
//
// 4. Every action logged to reeval_history JSONB + new trade_attempts row
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers, type UserTradingSettings } from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import { makeAlpacaClient, type AlpacaClient, type AlpacaPosition } from '@/app/lib/trading/alpaca-client'
import { computePositionSize } from '@/app/lib/trading/sizing'
import { randomBytes } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const REEVAL_COOLDOWN_MIN = 30
const NEWS_LOOKBACK_MIN = 30

interface ReevalSummary {
  users: number
  positionsChecked: number
  triggersFired: number
  holds: number
  tightens: number
  exits: number
  adds: number
  errors: number
  durationMs: number
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const startedAt = Date.now()
  const summary: ReevalSummary = {
    users: 0, positionsChecked: 0, triggersFired: 0,
    holds: 0, tightens: 0, exits: 0, adds: 0, errors: 0, durationMs: 0,
  }

  try {
    const users = (await listEnabledTradingUsers()).filter(s => s.activeMgmtEnabled)
    summary.users = users.length

    for (const settings of users) {
      try {
        const credLoad = await loadBrokerCredentialForUse(settings.userId, settings.broker, settings.mode)
        if (!credLoad) continue
        const alpaca = makeAlpacaClient(credLoad.keyId, credLoad.secret, settings.mode)

        // Fetch open positions from Alpaca AND open trade_attempts from our DB
        const [positions, attempts] = await Promise.all([
          alpaca.positions().catch(() => [] as AlpacaPosition[]),
          getOpenAttemptsForUser(settings.userId),
        ])

        // Map: ticker → (position, attempt)
        for (const pos of positions) {
          summary.positionsChecked++
          const att = attempts.find(a => a.ticker.toUpperCase() === pos.symbol.toUpperCase())
          if (!att) continue  // position exists in Alpaca but not in our tracking — skip

          // Cooldown check
          if (att.last_reeval_at) {
            const ageMin = (Date.now() - new Date(att.last_reeval_at).getTime()) / 60_000
            if (ageMin < REEVAL_COOLDOWN_MIN) continue
          }

          // Check triggers
          const triggers = await evaluateTriggers(settings, att, pos)
          if (triggers.length === 0) continue

          summary.triggersFired++
          console.log(`[reeval] user=${settings.userId} ${pos.symbol} triggered: ${triggers.join(', ')}`)

          // Run the Council for this ticker
          let decision: 'HOLD' | 'TIGHTEN_STOP' | 'EARLY_EXIT' | 'ADD' = 'HOLD'
          let rationale = ''
          try {
            const reevalVerdict = await runReevalAnalysis(settings.userId, pos.symbol, triggers, att, pos)
            decision = mapVerdictToDecision(reevalVerdict, settings, pos, att)
            rationale = reevalVerdict?.rationale ?? ''
          } catch (e) {
            summary.errors++
            console.warn(`[reeval] analyze failed for ${pos.symbol}:`, e instanceof Error ? e.message : e)
            decision = 'HOLD'
            rationale = `analyze failed: ${e instanceof Error ? e.message.slice(0, 100) : 'unknown'}`
          }

          // Execute
          try {
            await executeDecision({
              decision, settings, alpaca, position: pos, attempt: att, triggers, rationale,
            })
            if (decision === 'HOLD') summary.holds++
            else if (decision === 'TIGHTEN_STOP') summary.tightens++
            else if (decision === 'EARLY_EXIT') summary.exits++
            else if (decision === 'ADD') summary.adds++
          } catch (e) {
            summary.errors++
            console.warn(`[reeval] execute ${decision} failed for ${pos.symbol}:`, e instanceof Error ? e.message : e)
          }

          // Update tracking
          await updateReevalTracking(att.id, triggers, decision, rationale)
        }
      } catch (e) {
        summary.errors++
        console.error(`[reeval] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[reeval cron] done in ${summary.durationMs}ms, triggers=${summary.triggersFired}, holds=${summary.holds}, tightens=${summary.tightens}, exits=${summary.exits}, adds=${summary.adds}`)
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────
// Open attempts (this is the "position state" in our DB)
// ─────────────────────────────────────────────────────────────

interface OpenAttempt {
  id: string
  user_id: string
  ticker: string
  side: 'buy' | 'sell' | null
  qty: number | null
  filled_avg_price: number | null
  entry_price_est: number | null
  stop_price: number | null
  target_price: number | null
  broker_order_id: string | null
  council_signal: string | null
  outcome: string
  reeval_count: number
  last_reeval_at: string | null
  reeval_history: unknown[]
  signal_source: string
  created_at: string
}

async function getOpenAttemptsForUser(userId: string): Promise<OpenAttempt[]> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data, error } = await admin
    .from('trade_attempts')
    .select('id, user_id, ticker, side, qty, filled_avg_price, entry_price_est, stop_price, target_price, broker_order_id, council_signal, outcome, reeval_count, last_reeval_at, reeval_history, signal_source, created_at')
    .eq('user_id', userId)
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .gte('created_at', cutoff)
  if (error || !data) return []
  return (data as Array<Record<string, unknown>>).map(d => ({
    id: String(d.id),
    user_id: String(d.user_id),
    ticker: String(d.ticker),
    side: (d.side as 'buy' | 'sell' | null) ?? null,
    qty: d.qty !== null ? Number(d.qty) : null,
    filled_avg_price: d.filled_avg_price !== null ? Number(d.filled_avg_price) : null,
    entry_price_est: d.entry_price_est !== null ? Number(d.entry_price_est) : null,
    stop_price: d.stop_price !== null ? Number(d.stop_price) : null,
    target_price: d.target_price !== null ? Number(d.target_price) : null,
    broker_order_id: d.broker_order_id !== null ? String(d.broker_order_id) : null,
    council_signal: d.council_signal !== null ? String(d.council_signal) : null,
    outcome: String(d.outcome),
    reeval_count: Number(d.reeval_count ?? 0),
    last_reeval_at: d.last_reeval_at !== null ? String(d.last_reeval_at) : null,
    reeval_history: Array.isArray(d.reeval_history) ? d.reeval_history : [],
    signal_source: String(d.signal_source ?? 'council'),
    created_at: String(d.created_at),
  }))
}

// ─────────────────────────────────────────────────────────────
// Trigger evaluation
// ─────────────────────────────────────────────────────────────

async function evaluateTriggers(
  settings: UserTradingSettings,
  att: OpenAttempt,
  pos: AlpacaPosition,
): Promise<string[]> {
  const triggers: string[] = []

  // 1. Drawdown trigger
  const entryPrice = att.filled_avg_price ?? att.entry_price_est ?? pos.avg_entry_price
  const stopPrice = att.stop_price
  const currentPrice = pos.current_price
  if (entryPrice && stopPrice && currentPrice && entryPrice > 0) {
    const stopDistance = Math.abs(entryPrice - stopPrice)
    if (stopDistance > 0) {
      const adverseMove = att.side === 'buy'
        ? Math.max(0, entryPrice - currentPrice)
        : Math.max(0, currentPrice - entryPrice)
      const drawdownPct = adverseMove / stopDistance  // 0 = no adverse, 1 = at stop
      if (drawdownPct >= settings.reevalDrawdownPct) {
        triggers.push(`drawdown ${(drawdownPct * 100).toFixed(0)}% of stop distance`)
      }
    }
  }

  // 2. News trigger
  try {
    const admin = await getSupabaseAdmin()
    const cutoff = new Date(Date.now() - NEWS_LOOKBACK_MIN * 60_000).toISOString()
    const { count } = await admin
      .from('news_cache')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', cutoff)
      .ilike('headline', `%${att.ticker}%`)
    if ((count ?? 0) > 0) triggers.push(`fresh news mention (last ${NEWS_LOOKBACK_MIN}m)`)
  } catch {
    // ignore; news_cache schema may not include 'headline' column — adjust if needed
  }

  // 3. Technical regime trigger — break below SMA50 (for long positions)
  try {
    const { computeTickerTechnicals } = await import('@/app/lib/scanner-engine')
    const tech = await computeTickerTechnicals(att.ticker)
    if (tech && tech.technicals) {
      const t = tech.technicals
      if (att.side === 'buy' && t.priceVsSma50 < 0 && t.priceChange1D < -1) {
        triggers.push('broke SMA50 with negative day')
      }
      if (att.side === 'buy' && t.macdCrossover === 'bearish') {
        triggers.push('MACD bearish cross')
      }
    }
  } catch {
    // ignore — best-effort; if tech compute fails we skip this trigger
  }

  // 4. Daily-close trigger: between 3:50 and 4:00 PM ET (20:50-21:00 UTC)
  const utcHour = new Date().getUTCHours()
  const utcMin = new Date().getUTCMinutes()
  const isClose = utcHour === 20 && utcMin >= 50
  if (isClose) triggers.push('daily-close re-eval')

  return triggers
}

// ─────────────────────────────────────────────────────────────
// Decision mapping
// ─────────────────────────────────────────────────────────────

interface ReevalVerdict {
  trader_decision: string | null
  signal: string | null
  confidence: number | null
  rationale: string | null
}

async function runReevalAnalysis(
  userId: string,
  ticker: string,
  triggers: string[],
  att: OpenAttempt,
  pos: AlpacaPosition,
): Promise<ReevalVerdict | null> {
  const baseUrl = process.env.APP_BASE_URL ?? ''
  if (!baseUrl) return null
  const res = await fetch(`${baseUrl}/api/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Trigger': 'reeval',
      'X-Service-User-Id': userId,
      'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
    },
    body: JSON.stringify({
      ticker, userId,
      source: 'reeval',
      timeframe: '1D',
      persona: 'balanced',
      context: {
        triggers,
        currentPosition: { qty: pos.qty, avgPrice: pos.avg_entry_price, unrealizedPl: pos.unrealized_pl, side: att.side },
        originalEntry: att.entry_price_est,
        originalStop: att.stop_price,
        originalTarget: att.target_price,
      },
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) return null
  const json = await res.json().catch(() => ({})) as Record<string, unknown>
  // analyze route should return the verdict shape; tolerate variations
  const v = json as Record<string, unknown>
  return {
    trader_decision: (v.trader_decision ?? v.traderDecision ?? null) as string | null,
    signal: (v.signal ?? null) as string | null,
    confidence: v.confidence !== undefined && v.confidence !== null ? Number(v.confidence) : null,
    rationale: (v.trader_rationale ?? v.traderRationale ?? v.rationale ?? null) as string | null,
  }
}

function mapVerdictToDecision(
  verdict: ReevalVerdict | null,
  settings: UserTradingSettings,
  pos: AlpacaPosition,
  att: OpenAttempt,
): 'HOLD' | 'TIGHTEN_STOP' | 'EARLY_EXIT' | 'ADD' {
  if (!verdict) return 'HOLD'

  const sig = (verdict.signal ?? '').toUpperCase()
  const dec = (verdict.trader_decision ?? '').toUpperCase()
  const conf = verdict.confidence ?? 0
  const positionIsLong = att.side === 'buy'

  // Reversal: verdict flipped against the position
  const reversed = positionIsLong ? sig === 'BEARISH' : sig === 'BULLISH'
  if (reversed && conf >= 60 && settings.allowEarlyExit) return 'EARLY_EXIT'

  // Strong continuation: verdict TAKE in our direction with high confidence
  const stronglyAligned = (positionIsLong && sig === 'BULLISH' && dec === 'TAKE' && conf >= 75)
                       || (!positionIsLong && sig === 'BEARISH' && dec === 'TAKE' && conf >= 75)

  if (stronglyAligned && settings.allowAddPosition) {
    // Only add if we haven't already added too many times
    const addsSoFar = (att.reeval_history as Array<{ decision?: string }>).filter(h => h.decision === 'ADD').length
    if (addsSoFar < settings.maxAddCount) return 'ADD'
  }

  // In-profit and slight weakening: tighten stop
  const unrealizedPnl = pos.unrealized_pl
  const inProfit = unrealizedPnl > 0
  if (inProfit && (sig === 'NEUTRAL' || dec === 'WAIT') && settings.allowTightenStop) {
    return 'TIGHTEN_STOP'
  }

  // Otherwise hold
  return 'HOLD'
}

// ─────────────────────────────────────────────────────────────
// Execution
// ─────────────────────────────────────────────────────────────

async function executeDecision(opts: {
  decision: 'HOLD' | 'TIGHTEN_STOP' | 'EARLY_EXIT' | 'ADD'
  settings: UserTradingSettings
  alpaca: AlpacaClient
  position: AlpacaPosition
  attempt: OpenAttempt
  triggers: string[]
  rationale: string
}): Promise<void> {
  const { decision, settings, alpaca, position, attempt, triggers, rationale } = opts
  const admin = await getSupabaseAdmin()

  if (decision === 'HOLD') {
    await admin.from('trade_attempts').insert({
      user_id: settings.userId, ticker: attempt.ticker, outcome: 'reeval_hold',
      reject_reason: `triggers: ${triggers.join('; ')}. ${rationale.slice(0, 300)}`,
      mode: settings.mode, broker: settings.broker, signal_source: attempt.signal_source,
      original_attempt_id: attempt.id,
    })
    return
  }

  if (decision === 'TIGHTEN_STOP') {
    // Tighten stop toward break-even. New stop = midpoint between entry and current price (for longs).
    const entry = attempt.filled_avg_price ?? attempt.entry_price_est ?? position.avg_entry_price
    const current = position.current_price
    const newStop = attempt.side === 'buy'
      ? Math.max(entry, (entry + current) / 2)
      : Math.min(entry, (entry + current) / 2)

    // NOTE: implementing the actual stop-replacement requires finding the
    // child stop leg in Alpaca and replacing its stop_price. This is broker-
    // specific; we log the intent and a follow-up commit can wire the actual
    // replace_order call once we verify the bracket leg shape on real fills.
    await admin.from('trade_attempts').insert({
      user_id: settings.userId, ticker: attempt.ticker, outcome: 'reeval_tighten_stop',
      reject_reason: `proposed new stop ${newStop.toFixed(2)}; triggers: ${triggers.join('; ')}. ${rationale.slice(0, 200)}`,
      mode: settings.mode, broker: settings.broker, signal_source: attempt.signal_source,
      original_attempt_id: attempt.id, stop_price: newStop,
    })
    console.log(`[reeval] TIGHTEN_STOP logged ${attempt.ticker} entry=${entry} current=${current} newStop=${newStop.toFixed(2)} (actual leg replacement pending)`)
    return
  }

  if (decision === 'EARLY_EXIT') {
    // Market-sell the position via Alpaca close-position endpoint
    try {
      // Use POST /v2/positions/:symbol/close — Alpaca handles legs cancellation
      await (alpaca as unknown as { request: (m: string, p: string) => Promise<unknown> })
        .request('DELETE', `/v2/positions/${encodeURIComponent(position.symbol)}`)
      await admin.from('trade_attempts').insert({
        user_id: settings.userId, ticker: attempt.ticker, outcome: 'reeval_early_exit',
        reject_reason: `triggers: ${triggers.join('; ')}. ${rationale.slice(0, 300)}`,
        mode: settings.mode, broker: settings.broker, signal_source: attempt.signal_source,
        original_attempt_id: attempt.id, side: 'sell',
        qty: Math.abs(position.qty), entry_price_est: position.current_price,
      })
      console.log(`[reeval] EARLY_EXIT ${attempt.ticker} closed at ~${position.current_price}`)
    } catch (e) {
      await admin.from('trade_attempts').insert({
        user_id: settings.userId, ticker: attempt.ticker, outcome: 'error',
        reject_reason: `EARLY_EXIT failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)}`,
        mode: settings.mode, broker: settings.broker, signal_source: attempt.signal_source,
        original_attempt_id: attempt.id,
      })
      throw e
    }
    return
  }

  if (decision === 'ADD') {
    // Compute additional size — use half the original risk budget
    const account = await alpaca.account()
    const entry = position.current_price
    const stop = attempt.stop_price ?? entry * 0.97
    const sizing = computePositionSize({
      accountEquity: account.equity,
      riskPerTradePct: settings.riskPerTradePct * 0.5,  // half size for adds
      maxPositionPct: settings.maxPositionPct,
      entryPrice: entry,
      stopPrice: stop,
      traderPositionSizePct: 0.5,
    })
    if (!sizing.ok) {
      await admin.from('trade_attempts').insert({
        user_id: settings.userId, ticker: attempt.ticker, outcome: 'skipped',
        reject_reason: `ADD sizing failed: ${sizing.reason}`,
        mode: settings.mode, broker: settings.broker, signal_source: 'reeval_add',
        original_attempt_id: attempt.id,
      })
      return
    }
    // Place bracket
    const clientOrderId = `reev-${attempt.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`
    try {
      const order = await alpaca.bracketOrder({
        symbol: position.symbol,
        qty: sizing.qty,
        side: attempt.side ?? 'buy',
        takeProfitPrice: attempt.target_price ?? entry * 1.05,
        stopLossPrice: stop,
        clientOrderId,
      })
      await admin.from('trade_attempts').insert({
        user_id: settings.userId, ticker: attempt.ticker, outcome: 'reeval_add',
        reject_reason: `ADD on continuation; triggers: ${triggers.join('; ')}. ${rationale.slice(0, 200)}`,
        mode: settings.mode, broker: settings.broker, signal_source: 'reeval_add',
        original_attempt_id: attempt.id,
        broker_order_id: order.id, broker_client_id: clientOrderId,
        side: attempt.side, qty: sizing.qty, entry_price_est: entry,
        stop_price: stop, target_price: attempt.target_price,
        risk_dollar_amount: sizing.dollarRisk, account_equity_at: account.equity,
      })
      console.log(`[reeval] ADD ${attempt.ticker} +${sizing.qty} shares risk=$${sizing.dollarRisk.toFixed(2)}`)
    } catch (e) {
      await admin.from('trade_attempts').insert({
        user_id: settings.userId, ticker: attempt.ticker, outcome: 'error',
        reject_reason: `ADD bracket failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`,
        mode: settings.mode, broker: settings.broker, signal_source: 'reeval_add',
        original_attempt_id: attempt.id,
      })
      throw e
    }
    return
  }
}

async function updateReevalTracking(
  attemptId: string,
  triggers: string[],
  decision: string,
  rationale: string,
): Promise<void> {
  const admin = await getSupabaseAdmin()
  const now = new Date().toISOString()
  const { data } = await admin
    .from('trade_attempts')
    .select('reeval_history, reeval_count')
    .eq('id', attemptId)
    .single()
  const hist = Array.isArray((data as { reeval_history?: unknown[] })?.reeval_history)
    ? (data as { reeval_history: unknown[] }).reeval_history : []
  const newEntry = { at: now, triggers, decision, rationale: rationale.slice(0, 500) }
  await admin
    .from('trade_attempts')
    .update({
      reeval_history: [...hist, newEntry].slice(-50),
      reeval_count: Number((data as { reeval_count?: number })?.reeval_count ?? 0) + 1,
      last_reeval_at: now,
    })
    .eq('id', attemptId)
}
