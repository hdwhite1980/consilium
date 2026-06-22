// =============================================================
// app/api/cron/scanner-triage/route.ts
//
// Runs every 15 min during US market hours. For each enabled
// stocks-trading user:
//   1. Run scanner with fast_movers config (matches what the
//      existing auto-council-trigger uses).
//   2. For each pick, gather triage context (recent verdicts on
//      this ticker, open positions, prior pending triages).
//   3. Score each pick via scoreCandidate(...).
//   4. Cap fire_now at top N (default 8) per user per run.
//   5. Insert one scanner_triage row per pick with the decision.
//
// The auto-council-trigger cron consumes 'fire_now' rows and fires
// /api/analyze for each, then marks them as fired.
//
// Behavior when triage table is empty:
//   The auto-council-trigger falls back to its current behavior
//   (run scanner inline, pick top N). So this cron is safe to
//   deploy independently — it doesn't break the existing trigger.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers, isAssetClassEnabled } from '@/app/lib/trading/settings'
import { runScan, type EnrichedScore } from '@/app/lib/scanner-engine'
import {
  scoreCandidate,
  capFireNow,
  type TriageContext,
  type TriageResult,
} from '@/app/lib/trading/scanner-triage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Configuration
const SCAN_CONFIG = {
  universe: 'most_active',
  filter: {} as Record<string, unknown>,
  mode: 'both' as const,
  limit: 30,           // pull up to 30 scanner picks per run
  newsBoost: true,
  scanType: 'fast_movers' as const,
  horizon: 'day' as const,
  priceCeiling: 500,
}

const MAX_FIRE_NOW_PER_USER = 8
const RECENT_VERDICT_LOOKBACK_HOURS = 12
const PENDING_TRIAGE_LOOKBACK_MIN = 60

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Auth
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary = {
    users: 0,
    scanned: 0,
    fireNowInserted: 0,
    waitInserted: 0,
    skipInserted: 0,
    errors: 0,
    durationMs: 0,
    perUser: [] as Array<{
      userId: string
      scanned: number
      fireNow: number
      wait: number
      skip: number
      fireNowTickers: string[]
    }>,
  }

  try {
    const users = (await listEnabledTradingUsers())
      .filter(s => isAssetClassEnabled(s, 'stock'))
    summary.users = users.length

    if (users.length === 0) {
      summary.durationMs = Date.now() - startedAt
      return NextResponse.json(summary)
    }

    // Run the scanner ONCE per cron run (not per user). Scanner picks are
    // user-agnostic — the universe and filter don't depend on user. We
    // then score per user (because context like open positions and recent
    // verdicts is user-specific).
    let scanResult
    try {
      scanResult = await runScan({
        universe: SCAN_CONFIG.universe,
        filter: SCAN_CONFIG.filter,
        mode: SCAN_CONFIG.mode,
        limit: SCAN_CONFIG.limit,
        newsBoost: SCAN_CONFIG.newsBoost,
        scanType: SCAN_CONFIG.scanType,
        horizon: SCAN_CONFIG.horizon,
        priceCeiling: SCAN_CONFIG.priceCeiling,
      })
    } catch (e) {
      console.error('[scanner-triage] runScan failed:', e instanceof Error ? e.message : e)
      summary.errors++
      summary.durationMs = Date.now() - startedAt
      return NextResponse.json(summary)
    }

    const picks = scanResult.picks ?? []
    summary.scanned = picks.length
    const scannerRunAt = scanResult.generatedAt

    if (picks.length === 0) {
      console.log('[scanner-triage] scanner returned 0 picks; nothing to triage')
      summary.durationMs = Date.now() - startedAt
      return NextResponse.json(summary)
    }

    // Per-user triage
    for (const settings of users) {
      try {
        const userStats = {
          userId: settings.userId,
          scanned: picks.length,
          fireNow: 0,
          wait: 0,
          skip: 0,
          fireNowTickers: [] as string[],
        }

        // Fetch user-level context once per run, then per-ticker lookup is
        // a Map.get (cheap).
        const openPositionTickers = await fetchOpenPositionTickers(settings.userId)
        const pendingTriageTickers = await fetchPendingFireNowTickers(settings.userId)

        // Recent verdicts: one query for all tickers, keyed by ticker.
        const tickerSet = new Set<string>(picks.map(p => String(p.ticker).toUpperCase()))
        const recentVerdictsByTicker = await fetchRecentVerdictsByTicker(
          settings.userId,
          Array.from(tickerSet),
        )

        // Score each pick
        const scoredRows: Array<{ ticker: string; pick: EnrichedScore; result: TriageResult }> = []
        for (const pick of picks) {
          const t = pick.ticker.toUpperCase()
          const ctx: TriageContext = {
            recentVerdicts: recentVerdictsByTicker.get(t) ?? [],
            hasOpenPosition: openPositionTickers.has(t),
            hasPendingFireNow: pendingTriageTickers.has(t),
            minSharePrice: null,
          }
          const result = scoreCandidate(pick, ctx)
          scoredRows.push({ ticker: t, pick, result })
        }

        // Cap fire_now at top N
        const capped = capFireNow(scoredRows, MAX_FIRE_NOW_PER_USER)
        const cappedByTicker = new Map(capped.map(c => [c.ticker, c.result]))

        // Insert one triage row per pick
        const rowsToInsert = scoredRows.map(({ ticker, pick, result: originalResult }) => {
          // Use the capped result (which may have downgraded fire_now → wait)
          const finalResult = cappedByTicker.get(ticker) ?? originalResult
          return buildTriageRow(settings.userId, ticker, pick, scannerRunAt, finalResult)
        })

        const admin = await getSupabaseAdmin()
        const { error: insertErr } = await admin.from('scanner_triage').insert(rowsToInsert)
        if (insertErr) {
          console.error(`[scanner-triage] insert failed for user=${settings.userId}:`, insertErr.message)
          summary.errors++
          continue
        }

        // Update stats
        for (const row of rowsToInsert) {
          if (row.decision === 'fire_now') {
            userStats.fireNow++
            summary.fireNowInserted++
            userStats.fireNowTickers.push(row.ticker as string)
          } else if (row.decision === 'wait') {
            userStats.wait++
            summary.waitInserted++
          } else {
            userStats.skip++
            summary.skipInserted++
          }
        }

        summary.perUser.push(userStats)
        console.log(
          `[scanner-triage] user=${settings.userId} ` +
          `scanned=${userStats.scanned} fire=${userStats.fireNow} wait=${userStats.wait} skip=${userStats.skip} ` +
          `tickers=[${userStats.fireNowTickers.join(',')}]`
        )
      } catch (e) {
        console.error(`[scanner-triage] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
        summary.errors++
      }
    }
  } catch (e) {
    console.error('[scanner-triage cron] fatal:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(
    `[scanner-triage cron] done in ${summary.durationMs}ms ` +
    `users=${summary.users} scanned=${summary.scanned} ` +
    `fire=${summary.fireNowInserted} wait=${summary.waitInserted} skip=${summary.skipInserted}`
  )
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────
// Context fetchers
// ─────────────────────────────────────────────────────────────

async function fetchOpenPositionTickers(userId: string): Promise<Set<string>> {
  const admin = await getSupabaseAdmin()
  const { data, error } = await admin
    .from('trade_attempts')
    .select('ticker')
    .eq('user_id', userId)
    // trade_attempts stores asset_class='stock' singular. Accept all
    // variants (NULL + stock + stocks) for safety; same pattern used in
    // position-monitor and auto-trade-positions crons.
    .or('asset_class.is.null,asset_class.eq.stock,asset_class.eq.stocks')
    .in('outcome', ['placed', 'filled', 'partial_fill'])
  if (error) {
    console.warn(`[scanner-triage] fetchOpenPositionTickers err: ${error.message}`)
    return new Set()
  }
  return new Set((data ?? []).map(r => String(r.ticker ?? '').toUpperCase()))
}

async function fetchPendingFireNowTickers(userId: string): Promise<Set<string>> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - PENDING_TRIAGE_LOOKBACK_MIN * 60_000).toISOString()
  const { data, error } = await admin
    .from('scanner_triage')
    .select('ticker')
    .eq('user_id', userId)
    .eq('decision', 'fire_now')
    .is('fired_at', null)
    .gt('triaged_at', cutoff)
  if (error) {
    console.warn(`[scanner-triage] fetchPendingFireNowTickers err: ${error.message}`)
    return new Set()
  }
  return new Set((data ?? []).map(r => String(r.ticker ?? '').toUpperCase()))
}

async function fetchRecentVerdictsByTicker(
  userId: string,
  tickers: string[],
): Promise<Map<string, Array<{ id: number; trader_decision: string | null; created_at: string }>>> {
  const out = new Map<string, Array<{ id: number; trader_decision: string | null; created_at: string }>>()
  if (tickers.length === 0) return out

  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - RECENT_VERDICT_LOOKBACK_HOURS * 3_600_000).toISOString()
  const { data, error } = await admin
    .from('verdict_log')
    .select('id, ticker, trader_decision, created_at')
    .eq('user_id', userId)
    .gt('created_at', cutoff)
    .in('ticker', tickers)
  if (error) {
    console.warn(`[scanner-triage] fetchRecentVerdictsByTicker err: ${error.message}`)
    return out
  }

  for (const row of (data ?? [])) {
    const t = String(row.ticker ?? '').toUpperCase()
    if (!out.has(t)) out.set(t, [])
    out.get(t)!.push({
      id: Number(row.id),
      trader_decision: row.trader_decision,
      created_at: String(row.created_at),
    })
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// Row builder
// ─────────────────────────────────────────────────────────────

function buildTriageRow(
  userId: string,
  ticker: string,
  pick: EnrichedScore,
  scannerRunAt: string,
  result: TriageResult,
): Record<string, unknown> {
  // Extract recent verdict ID from rulesFired if hard_skip_recent_verdict
  // fired (encoded in reason text). We pull it back out for the column.
  let recentVerdictId: number | null = null
  if (result.rulesFired.includes('hard_skip_recent_verdict')) {
    const m = result.reason.match(/verdict (\d+)/)
    if (m) recentVerdictId = Number(m[1])
  }

  return {
    user_id: userId,
    ticker,
    asset_class: 'stock',
    scanner_run_at: scannerRunAt,
    composite_score: pick.compositeScore ?? null,
    composite_with_news: pick.compositeWithNews ?? null,
    momentum_score: pick.momentumScore ?? null,
    day_change_pct: null,                  // not surfaced by EnrichedScore directly
    dollar_volume_avg: pick.dollarVolumeAvg ?? null,
    liquidity_tier: pick.liquidityTier ?? null,
    news_match_type: pick.newsMatchType ?? null,
    news_exposure_score: pick.newsExposureScore ?? null,
    direction: pick.direction ?? null,
    setup_type: pick.setupType ?? null,
    recent_verdict_id: recentVerdictId,
    open_position_ticker: result.rulesFired.includes('hard_skip_open_position') ? ticker : null,
    decision: result.decision,
    score: result.score,
    reason: result.reason,
    rules_fired: result.rulesFired,
  }
}
