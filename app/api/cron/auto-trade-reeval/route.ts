// =============================================================
// app/api/cron/auto-trade-reeval/route.ts
//
// Active position re-evaluation using THESIS-CHECK pattern.
// Every 15 min during market hours, for each user with
// activeMgmtEnabled=true, for each open position:
//
//   1. Check materiality triggers (drawdown, news, technical
//      regime break, daily close)
//   2. If ANY trigger fires AND last_reeval_at > 30 min ago:
//      → Call /api/reeval-thesis-check synchronously (~5s)
//      → Receives action: hold / tighten_stop / early_exit / add
//   3. Execute decision via Alpaca, gated by user permissions
//   4. Log to reeval_history JSONB + new trade_attempts row
//
// Thesis-check returns IN under 30s, well within cron budget.
// Real-time-ish active management (no 15-min lag).
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

        const [positions, attempts] = await Promise.all([
          alpaca.positions().catch(() => [] as AlpacaPosition[]),
          getOpenAttemptsForUser(settings.userId),
        ])

        for (const pos of positions) {
          summary.positionsChecked++
          const att = attempts.find(a => a.ticker.toUpperCase() === pos.symbol.toUpperCase())
          if (!att) continue

          // Cooldown check
          if (att.last_reeval_at) {
            const ageMin = (Date.now() - new Date(att.last_reeval_at).getTime()) / 60_000
            if (ageMin < REEVAL_COOLDOWN_MIN) continue
          }

          // Materiality triggers
          const triggers = await evaluateTriggers(settings, att, pos)
          if (triggers.length === 0) continue

          summary.triggersFired++
          console.log(`[reeval] user=${settings.userId} ${pos.symbol} triggered: ${triggers.join(', ')}`)

          // Skip if we have no link back to the original verdict
          if (!att.verdict_log_id) {
            console.warn(`[reeval] no verdict_log_id on attempt ${att.id} (${pos.symbol}); skipping thesis-check`)
            await updateReevalTracking(att.id, triggers, 'HOLD', 'no verdict_log_id linkage; cannot run thesis-check')
            summary.holds++
            continue
          }

          // Thesis check
          let decision: 'HOLD' | 'TIGHTEN_STOP' | 'EARLY_EXIT' | 'ADD' = 'HOLD'
          let rationale = ''
          try {
            const tc = await callThesisCheck(settings.userId, att, pos, triggers)
            if (tc) {
              decision = mapThesisAction(tc.action, settings, tc.thesisStatus)
              rationale = `[thesis-check ${tc.thesisStatus}, conf ${tc.confidence}] ${tc.rationale}`
            } else {
              rationale = 'thesis-check returned null; defaulting HOLD'
            }
          } catch (e) {
            summary.errors++
            const msg = e instanceof Error ? e.message : String(e)
            console.warn(`[reeval] thesis-check failed for ${pos.symbol}:`, msg.slice(0, 200))
            decision = 'HOLD'
            rationale = `thesis-check error: ${msg.slice(0, 200)}`
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
// Open attempts (with verdict_log_id linkage for thesis-check)
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
  verdict_log_id: number | null
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
    .select('id, user_id, ticker, side, qty, filled_avg_price, entry_price_est, stop_price, target_price, broker_order_id, council_signal, verdict_log_id, outcome, reeval_count, last_reeval_at, reeval_history, signal_source, created_at')
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
    verdict_log_id: d.verdict_log_id !== null && d.verdict_log_id !== undefined ? Number(d.verdict_log_id) : null,
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
      const drawdownPct = adverseMove / stopDistance
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
    // news_cache schema may differ; ignore silently
  }

  // 3. Technical regime trigger
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
  } catch { /* best-effort */ }

  // 4. Daily-close trigger
  const utcHour = new Date().getUTCHours()
  const utcMin = new Date().getUTCMinutes()
  const isClose = utcHour === 20 && utcMin >= 50
  if (isClose) triggers.push('daily-close re-eval')

  return triggers
}

// ─────────────────────────────────────────────────────────────
// Fresh data for thesis-check
// ─────────────────────────────────────────────────────────────

async function fetchFreshTechnicals(ticker: string): Promise<{
  rsi?: number
  macdHistogram?: number
  priceVsSma20?: number
  priceVsSma50?: number
  volumeRatio?: number
  priceChange1d?: number
} | undefined> {
  try {
    const { computeTickerTechnicals } = await import('@/app/lib/scanner-engine')
    const result = await computeTickerTechnicals(ticker)
    if (!result || !result.technicals) return undefined
    const t = result.technicals
    return {
      rsi: t.rsi,
      macdHistogram: t.macdHistogram,
      priceVsSma20: t.priceVsSma20,
      priceVsSma50: t.priceVsSma50,
      volumeRatio: t.volumeRatio,
      priceChange1d: t.priceChange1D,
    }
  } catch {
    return undefined
  }
}

async function fetchFreshNewsHeadlines(ticker: string): Promise<string[]> {
  try {
    const admin = await getSupabaseAdmin()
    const cutoff = new Date(Date.now() - NEWS_LOOKBACK_MIN * 60_000).toISOString()
    const { data, error } = await admin
      .from('news_cache')
      .select('headline')
      .gte('created_at', cutoff)
      .ilike('headline', `%${ticker}%`)
      .order('created_at', { ascending: false })
      .limit(5)
    if (error || !data) return []
    return (data as Array<{ headline: string }>).map(r => r.headline).filter(Boolean)
  } catch {
    return []
  }
}

// ─────────────────────────────────────────────────────────────
// Thesis-check call (synchronous, ~5s)
// ─────────────────────────────────────────────────────────────

interface ThesisCheckResult {
  thesisStatus: 'intact' | 'weakened' | 'invalidated'
  action: 'hold' | 'tighten_stop' | 'early_exit' | 'add'
  confidence: number
  rationale: string
  newVerdictId: number | null
}

async function callThesisCheck(
  userId: string,
  att: OpenAttempt,
  pos: AlpacaPosition,
  triggers: string[],
): Promise<ThesisCheckResult | null> {
  const baseUrl = process.env.APP_BASE_URL ?? ''
  if (!baseUrl) {
    console.warn('[reeval] APP_BASE_URL not set; cannot call thesis-check')
    return null
  }
  if (!att.verdict_log_id) return null

  const [technicals, headlines] = await Promise.all([
    fetchFreshTechnicals(att.ticker),
    fetchFreshNewsHeadlines(att.ticker),
  ])

  const entry = att.filled_avg_price ?? att.entry_price_est ?? pos.avg_entry_price
  const unrealizedPnlPct = entry > 0
    ? ((pos.current_price - entry) / entry) * 100 * (att.side === 'buy' ? 1 : -1)
    : 0

  const ctrl = new AbortController()
  const hardTimeout = setTimeout(() => ctrl.abort(), 25_000)
  try {
    const res = await fetch(`${baseUrl}/api/reeval-thesis-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
        'X-Service-Trigger': 'reeval',
        'X-Service-User-Id': userId,
      },
      body: JSON.stringify({
        verdictId: att.verdict_log_id,
        currentPrice: pos.current_price,
        unrealizedPnlPct,
        triggersFired: triggers,
        freshTechnicals: technicals,
        freshNewsHeadlines: headlines,
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      console.warn(`[reeval] thesis-check returned ${res.status} for ${att.ticker}: ${txt.slice(0, 200)}`)
      return null
    }
    const json = await res.json() as ThesisCheckResult & { ok?: boolean }
    if (json.ok === false) return null
    return json
  } finally {
    clearTimeout(hardTimeout)
  }
}

// ─────────────────────────────────────────────────────────────
// Action mapping (respects user permissions)
// ─────────────────────────────────────────────────────────────

function mapThesisAction(
  thesisAction: 'hold' | 'tighten_stop' | 'early_exit' | 'add',
  settings: UserTradingSettings,
  thesisStatus: 'intact' | 'weakened' | 'invalidated',
): 'HOLD' | 'TIGHTEN_STOP' | 'EARLY_EXIT' | 'ADD' {
  // Respect user permissions: if thesis-check says exit but user disallowed it,
  // fall back to tighten_stop. If tighten_stop also disallowed, fall back to hold.
  if (thesisAction === 'early_exit') {
    if (settings.allowEarlyExit) return 'EARLY_EXIT'
    if (settings.allowTightenStop) {
      console.log(`[reeval] thesis-check wanted early_exit but allowEarlyExit=false; falling back to tighten_stop (status=${thesisStatus})`)
      return 'TIGHTEN_STOP'
    }
    return 'HOLD'
  }
  if (thesisAction === 'tighten_stop') {
    return settings.allowTightenStop ? 'TIGHTEN_STOP' : 'HOLD'
  }
  if (thesisAction === 'add') {
    return settings.allowAddPosition ? 'ADD' : 'HOLD'
  }
  return 'HOLD'
}

// ─────────────────────────────────────────────────────────────
// Execution (same as before)
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
    const entry = attempt.filled_avg_price ?? attempt.entry_price_est ?? position.avg_entry_price
    const current = position.current_price
    const newStop = attempt.side === 'buy'
      ? Math.max(entry, (entry + current) / 2)
      : Math.min(entry, (entry + current) / 2)
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
    try {
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
    const account = await alpaca.account()
    const entry = position.current_price
    const stop = attempt.stop_price ?? entry * 0.97
    const sizing = computePositionSize({
      accountEquity: account.equity,
      riskPerTradePct: settings.riskPerTradePct * 0.5,
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
