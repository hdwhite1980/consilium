// =============================================================
// app/api/cron/earnings-council/route.ts
//
// Phase 3 of the pre-earnings run-up tracker.
//
// Selects earnings_watch names that, per the accumulated earnings_signal_log,
// are drifting bullishly into their print with CONSISTENT signal (not a single
// day), in the entry window, and triggers the Council on them via /api/analyze
// — exactly like the crypto scanner. The resulting verdict flows through the
// normal path: verdict_log -> auto-trade -> (for imminent earnings) the
// levels-preserve + day-route + EOD-flatten execution already built.
//
// SAFETY / SCOPE:
//   * Only runs for users who opted into earnings trading (earningsFullSize).
//   * Default entry window is DTE 1 (the eve of the print) because the existing
//     execution path fully manages that case: a trade entered the day before
//     earnings is day-routed and flattened before the close, so it never holds
//     through the print. Extending the window to DTE 2-3 (the multi-day "two
//     days early" ride) needs Phase 3b (flatten-BEFORE-PRINT keyed on the
//     earnings datetime, vs. flatten-every-EOD) — do NOT widen ENTRY_DTE_MAX
//     past 1 until that ships, or DTE-2 entries would hold through the print.
//   * Skips parabolic pre-earnings moves (buy-the-rumor already spent).
//
// The Council reads the bundle (earnings proximity, technicals reflecting the
// drift, options) and decides direction + levels; it is NOT asked to predict
// the earnings result.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { enqueueCouncil } from '@/app/lib/trading/council-queue'
import {
  listEnabledTradingUsers,
  isAssetClassEnabled,
  type UserTradingSettings,
} from '@/app/lib/trading/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Entry window (trading-day delta to the report). Phase 3b (flatten-before-
// print) is in place: run-up trades are day-routed and held overnight until the
// print is imminent, then flattened before it — so the multi-day "two days
// early" ride is now safe. DTE 1-2 = enter up to two sessions before the print.
const ENTRY_DTE_MIN = 1
const ENTRY_DTE_MAX = 2
// Run-up quality bars
const MIN_RUNUP_SCORE = 62          // directional 0..100; >=62 = clearly bullish
const MIN_BULLISH_SNAPSHOTS = 2     // signal must have been bullish on >=2 days (consistency)
const MAX_DRIFT_5D = 25             // skip parabolic blow-offs (buy-the-rumor already spent)
const MAX_TRIGGERS = 12             // cap analyses per run
const DEDUP_HOURS = 12              // don't re-analyze a ticker already done this window

interface CandidateRow {
  earnings_watch_id: string
  ticker: string
  report_date: string
  days_to_report: number
  runup_score: number
  drift_5d: number
}

async function getRecentlyAnalyzed(userId: string, hours: number): Promise<Set<string>> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
  const { data } = await admin
    .from('verdict_log')
    .select('ticker')
    .eq('user_id', userId)
    .gte('created_at', cutoff)
  if (!data) return new Set()
  return new Set((data as Array<{ ticker: string }>).map(r => r.ticker.toUpperCase()))
}

async function triggerAnalyze(userId: string, ticker: string): Promise<boolean> {
  const r = await enqueueCouncil({
    userId, ticker, assetType: 'stock',
    source: 'earnings_runup', pool: 'normal', timeframe: '1W',
  })
  return r === 'enqueued'
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const admin = await getSupabaseAdmin()
  const today = new Date().toISOString().split('T')[0]

  // 1. Today's qualifying snapshots: gated-in, bullish, strong, not parabolic,
  //    in the entry window.
  const { data: snapRows, error: snapErr } = await admin
    .from('earnings_signal_log')
    .select('earnings_watch_id, ticker, report_date, days_to_report, runup_score, drift_5d')
    .eq('snapshot_date', today)
    .eq('passes_gate', true)
    .eq('runup_bias', 'bullish')
    .gte('runup_score', MIN_RUNUP_SCORE)
    .gte('days_to_report', ENTRY_DTE_MIN)
    .lte('days_to_report', ENTRY_DTE_MAX)
    .lte('drift_5d', MAX_DRIFT_5D)

  if (snapErr) {
    return NextResponse.json({ error: `signal read failed: ${snapErr.message}` }, { status: 500 })
  }
  const todaysCandidates = (snapRows ?? []) as CandidateRow[]

  // 2. Consistency: require the run-up to have been bullish on >= N snapshots.
  let candidates: CandidateRow[] = []
  if (todaysCandidates.length > 0) {
    const watchIds = todaysCandidates.map(c => c.earnings_watch_id)
    const { data: bullRows } = await admin
      .from('earnings_signal_log')
      .select('earnings_watch_id')
      .in('earnings_watch_id', watchIds)
      .eq('runup_bias', 'bullish')
    const bullCount = new Map<string, number>()
    for (const r of (bullRows ?? []) as Array<{ earnings_watch_id: string }>) {
      bullCount.set(r.earnings_watch_id, (bullCount.get(r.earnings_watch_id) ?? 0) + 1)
    }
    candidates = todaysCandidates
      .filter(c => (bullCount.get(c.earnings_watch_id) ?? 0) >= MIN_BULLISH_SNAPSHOTS)
      .sort((a, b) => b.runup_score - a.runup_score)
      .slice(0, MAX_TRIGGERS)
  }

  // 3. Trigger the Council per opted-in stock-trading user (dedup recent).
  const allUsers = await listEnabledTradingUsers()
  const users = allUsers.filter(
    (u: UserTradingSettings) => isAssetClassEnabled(u, 'stock') && u.earningsFullSize === true,
  )

  const triggeredWatchIds = new Set<string>()
  const perUser: Array<{ userId: string; triggered: string[]; skipped: string[] }> = []

  for (const u of users) {
    const recent = await getRecentlyAnalyzed(u.userId, DEDUP_HOURS)
    const triggered: string[] = []
    const skipped: string[] = []
    for (const c of candidates) {
      if (recent.has(c.ticker.toUpperCase())) {
        skipped.push(c.ticker)
        continue
      }
      const ok = await triggerAnalyze(u.userId, c.ticker)
      if (ok) {
        triggered.push(c.ticker)
        triggeredWatchIds.add(c.earnings_watch_id)
      } else {
        skipped.push(c.ticker)
      }
    }
    perUser.push({ userId: u.userId, triggered, skipped })
  }

  // 4. Mark triggered events 'entered' so we don't re-fire daily.
  if (triggeredWatchIds.size > 0) {
    await admin
      .from('earnings_watch')
      .update({ status: 'entered', updated_at: new Date().toISOString() })
      .in('id', Array.from(triggeredWatchIds))
  }

  const durationMs = Date.now() - startedAt
  console.log(
    `[earnings-council] candidates=${candidates.length} optedInUsers=${users.length} ` +
      `triggeredEvents=${triggeredWatchIds.size} in ${durationMs}ms`,
  )
  return NextResponse.json({
    ok: true,
    entryWindow: { dteMin: ENTRY_DTE_MIN, dteMax: ENTRY_DTE_MAX },
    candidatesToday: todaysCandidates.length,
    candidatesConsistent: candidates.length,
    optedInUsers: users.length,
    candidates: candidates.map(c => ({
      ticker: c.ticker,
      dte: c.days_to_report,
      score: c.runup_score,
      drift5d: c.drift_5d,
      reportDate: c.report_date,
    })),
    perUser,
    durationMs,
  })
}
