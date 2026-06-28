// =============================================================
// app/api/cron/day-shark-trade/route.ts
//
// Max's executor (Phase 2b) — CRYPTO. Reads source='day_shark' TAKE verdicts,
// sizes them HOT within Max's virtual budget, places through the verified
// selectCryptoBroker, and records the fill tagged signal_source='day_shark' so:
//   (a) computeSharkDeployed counts it against his sleeve next run, and
//   (b) the existing crypto-position-monitor enforces its stop (baseline
//       protection; Max's EOD exit discipline is Phase 3 on top).
//
// SAFETY:
//   - Budget gate: never deploys past Max's available sleeve (can't touch the
//     slow lane's cash). Running budget is decremented within the run too.
//   - Dedup: skips any verdict that already has a day_shark attempt (re-run safe),
//     and uses a deterministic client_order_id.
//   - Buying-power gate: notional must fit live cash with a safety margin.
//
// Auth: Authorization: Bearer ${CRON_SECRET}   ?userId=<uuid>  &dryRun=1
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { listEnabledTradingUsers, isAssetClassEnabled, type UserTradingSettings } from '@/app/lib/trading/settings'
import { selectCryptoBroker } from '@/app/lib/trading/crypto-broker'
import { getSharkBudget, allocationPctFor } from '@/app/lib/trading/day-shark-budget'
import { computeSharkSize } from '@/app/lib/trading/day-shark'
import { isCryptoPairSymbol } from '@/app/lib/crypto-symbol'

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

// day_shark TAKE verdicts for this user that haven't been executed yet.
async function loadSharkVerdicts(userId: string): Promise<SharkVerdict[]> {
  const db = admin()
  const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString()
  const { data: verdicts } = await db
    .from('verdict_log')
    .select('id, ticker, signal, confidence, entry_price, stop_loss, take_profit, trader_grade, trader_risk_reward')
    .eq('user_id', userId)
    .eq('source', 'day_shark')
    .eq('trader_decision', 'TAKE')
    .gte('created_at', cutoff)
    .order('id', { ascending: true })
  if (!verdicts || verdicts.length === 0) return []

  // Drop any that already have a day_shark attempt (re-run safe).
  const ids = verdicts.map(v => v.id)
  const { data: done } = await db
    .from('trade_attempts')
    .select('verdict_log_id')
    .eq('user_id', userId)
    .eq('signal_source', 'day_shark')
    .in('verdict_log_id', ids)
  const doneSet = new Set((done ?? []).map(r => r.verdict_log_id))
  return (verdicts as SharkVerdict[]).filter(v => !doneSet.has(v.id) && isCryptoPairSymbol(v.ticker))
}

async function recordAttempt(
  userId: string, verdict: SharkVerdict, outcome: string,
  details: Record<string, unknown>,
): Promise<void> {
  await admin().from('trade_attempts').insert({
    user_id: userId,
    verdict_log_id: verdict.id,
    ticker: verdict.ticker,
    asset_class: 'crypto',
    council_signal: verdict.signal,
    council_confidence: verdict.confidence !== null ? Math.round(Number(verdict.confidence)) : null,
    outcome,
    signal_source: 'day_shark',
    side: 'buy',
    ...details,
  })
}

async function runUser(settings: UserTradingSettings, dryRun: boolean) {
  const result = { ticker: '', placed: 0, skipped: 0, errors: 0, notes: [] as string[] }
  if (allocationPctFor(settings, 'crypto') <= 0) { result.notes.push('Max off for crypto'); return result }
  if (!isAssetClassEnabled(settings, 'crypto')) { result.notes.push('crypto disabled'); return result }

  const broker = await selectCryptoBroker(settings)
  if (!broker) { result.notes.push('no crypto broker'); return result }

  const account = await broker.account()
  const equity = account.equity || account.cash
  const budget = await getSharkBudget(settings, 'crypto', equity)
  if (budget.available <= 0) { result.notes.push(`Max out of budget (sleeve $${budget.sleeve.toFixed(2)})`); return result }

  const verdicts = await loadSharkVerdicts(settings.userId)
  let remaining = budget.available
  let safeCash = account.cash * SAFETY_MARGIN

  for (const v of verdicts) {
    const entry = v.entry_price, stop = v.stop_loss
    if (!entry || !stop) { result.skipped++; continue }

    const sized = computeSharkSize({
      budget: { ...budget, available: Math.min(remaining, safeCash) },
      entryPrice: entry,
      stopPrice: stop,
      minViableNotional: 1,
      qualityGrade: (v.trader_grade === 'A' || v.trader_grade === 'B' || v.trader_grade === 'C') ? v.trader_grade : null,
      qualityConfidence: v.confidence !== null ? Number(v.confidence) : null,
      qualityRiskReward: v.trader_risk_reward !== null && v.trader_risk_reward !== undefined ? Number(v.trader_risk_reward) : null,
    })
    if (!sized.ok) {
      if (!dryRun) await recordAttempt(settings.userId, v, 'skipped', { reject_reason: sized.reason })
      result.skipped++; continue
    }

    if (dryRun) {
      result.notes.push(`${v.ticker}: would place $${sized.notionalUsd!.toFixed(2)} (${sized.rationale})`)
      result.placed++; continue
    }

    const brokerSymbol = broker.symbolFor(v.ticker.includes('/') ? v.ticker : v.ticker.replace(/USD$/, '/USD'))
    const clientOrderId = `wos-shark-${v.id}`
    try {
      const order = await broker.marketEntry({ symbol: brokerSymbol, notionalUsd: sized.notionalUsd!, side: 'buy', clientOrderId })
      const units = sized.notionalUsd! / entry
      await recordAttempt(settings.userId, v, 'placed', {
        mode: broker.effectiveMode, broker: broker.brokerName,
        broker_order_id: order.id, broker_client_id: clientOrderId,
        qty: units, entry_price_est: entry,
        council_entry: entry, council_stop: stop, council_target: v.take_profit,
        stop_price: stop, target_price: v.take_profit,
        risk_dollar_amount: sized.dollarRisk, account_equity_at: equity,
      })
      remaining -= sized.notionalUsd!
      safeCash -= sized.notionalUsd!
      result.placed++
      console.log(`[day-shark-trade] MAX BUY $${sized.notionalUsd!.toFixed(2)} ${brokerSymbol} (${sized.rationale})`)
    } catch (e) {
      await recordAttempt(settings.userId, v, 'rejected', { reject_reason: e instanceof Error ? e.message : String(e), broker_client_id: clientOrderId })
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

  const users = (await listEnabledTradingUsers()).filter(s => !onlyUser || s.userId === onlyUser)
  const summary = { users: users.length, placed: 0, skipped: 0, errors: 0, perUser: [] as unknown[] }
  for (const settings of users) {
    try {
      const r = await runUser(settings, dryRun)
      summary.placed += r.placed; summary.skipped += r.skipped; summary.errors += r.errors
      summary.perUser.push({ userId: settings.userId, ...r })
    } catch (e) {
      summary.errors++
      summary.perUser.push({ userId: settings.userId, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return NextResponse.json({ ok: true, ...summary })
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }
