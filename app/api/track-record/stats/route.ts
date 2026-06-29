// =============================================================
// app/api/track-record/stats/route.ts
//
// GET /api/track-record/stats?version=<n|all>&source=<src>
//
// Returns hit-rate and direction-accuracy stats for the requested
// system version (or all-time if version=all).
//
// Adds a `sampleNote` field with an honest disclaimer when the
// graded verdict count is too low for the numbers to be meaningful.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import {
  getCurrentVersion,
  getVersionByNumber,
  type SystemVersion,
} from '@/app/lib/system-versions'

export const runtime = 'nodejs'
export const maxDuration = 10

const MIN_GRADED_FOR_MATURE = 30  // below this, return preview note

interface Stats {
  hitRate1w: number | null
  directionAcc1w: number | null
  totalVerdicts: number
  gradedVerdicts: number
  // Expectancy suite — the metrics that actually decide profitability
  expectancyR: number | null      // mean R per trade (target=+R, stop=−1R); >0 = edge
  profitFactor: number | null     // gross win R / gross loss R; >1 = profitable
  payoffRatio: number | null      // avg win R / avg loss R (avg loss = 1R)
  avgWinR: number | null
  totalR: number | null           // cumulative R captured across resolved trades
  avgReturnPct: number | null     // mean realized 1W directional return per verdict
  sampleNote: string | null
  versionLabel: string
}

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createAdmin(url, key)
}

export async function GET(req: NextRequest) {
  try {
    // NOTE: This endpoint is intentionally PUBLIC.
    //
    // The track-record page is a conversion surface — anonymous visitors must be
    // able to see the version timeline and aggregated stats (hit rate, direction
    // accuracy, sample sizes) before they sign up. Gating it behind auth means
    // potential customers leave before seeing the trust story (version-honest
    // dashboard with preview badges, multi-version comparison).
    //
    // The exposed data is intentionally aggregated marketing content — no PII,
    // no individual user data, no sensitive trade-plan specifics. The verdict
    // list (which contains per-verdict entry/stop/target prices) is handled
    // separately by VerdictList and may apply its own gating policy.
    //
    // Previously this returned 401 for anonymous requests, which broke the
    // page's primary purpose. Email collection, if needed, happens via a
    // softer inline mechanism on the page itself rather than a hard auth wall.

    const url = new URL(req.url)
    const versionParam = url.searchParams.get('version') ?? 'current'
    const sourceParam = url.searchParams.get('source')

    // Resolve to a version metadata object (or null for all-time)
    let version: SystemVersion | null = null
    if (versionParam === 'all') {
      version = null
    } else if (versionParam === 'current') {
      version = getCurrentVersion()
    } else {
      const n = parseInt(versionParam, 10)
      if (Number.isNaN(n)) {
        return NextResponse.json({ error: 'Invalid version param' }, { status: 400 })
      }
      version = getVersionByNumber(n)
      if (!version) {
        return NextResponse.json({ error: `Unknown version ${n}` }, { status: 404 })
      }
    }

    const stats = await computeStats(version, sourceParam)
    return NextResponse.json(stats, {
      // Public, short-lived cache: response is identical for all visitors,
      // graded outcomes don't change minute-to-minute (cron grades 1x daily).
      // s-maxage applies at CDN/edge; max-age in the browser. Both 5 min.
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300' },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[track-record/stats] Error:', msg)
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────

async function computeStats(version: SystemVersion | null, source?: string | null): Promise<Stats> {
  const admin = getAdmin()
  let q = admin
    .from('verdict_log')
    .select('outcome_1w_strict, outcome_1w_directional, outcome_1w_price, signal, entry_price, stop_loss, take_profit')
    .in('signal', ['BULLISH', 'BEARISH'])

  // Max (day_shark) is measured separately — exclude by default; opt in via ?source=day_shark
  if (source === 'day_shark') q = q.eq('source', 'day_shark')
  else q = q.or('source.is.null,source.neq.day_shark')

  if (version) {
    q = q.eq('version_number', version.number)
  }

  const { data, error } = await q
  if (error) throw new Error(`stats query failed: ${error.message}`)

  const rows = data ?? []
  const totalVerdicts = rows.length

  // Hit rate: target hit / (target hit + stop hit), excluding expired
  // Direction accuracy: price moved in predicted direction at 1W mark.
  //   Both columns use the same vocabulary: 'win' | 'loss' | 'pending' | 'expired'
  //   - outcome_1w_strict: 'win' = target hit first, 'loss' = stop hit first, 'expired' = neither hit within 1W
  //   - outcome_1w_directional: 'win' = price moved in predicted direction, 'loss' = opposite direction
  //     (Naming is a bit confusing — the column is named "directional" but uses the same
  //      win/loss vocabulary as the strict column, just with a looser definition of "win.")
  let wins = 0
  let losses = 0
  let directionCorrect = 0
  let directionIncorrect = 0

  for (const r of rows) {
    if (r.outcome_1w_strict === 'win') wins++
    else if (r.outcome_1w_strict === 'loss') losses++

    if (r.outcome_1w_directional === 'win') directionCorrect++
    else if (r.outcome_1w_directional === 'loss') directionIncorrect++
  }

  const gradedVerdicts = wins + losses
  const directionGraded = directionCorrect + directionIncorrect

  const hitRate1w = gradedVerdicts === 0
    ? null
    : (wins / gradedVerdicts) * 100

  const directionAcc1w = directionGraded === 0
    ? null
    : (directionCorrect / directionGraded) * 100

  // Honest sample-size note
  let sampleNote: string | null = null
  if (gradedVerdicts === 0 && totalVerdicts > 0) {
    sampleNote = `${totalVerdicts} verdicts logged, none graded yet — outcomes need ~5 trading days to resolve`
  } else if (gradedVerdicts < MIN_GRADED_FOR_MATURE) {
    sampleNote = `Preview — only ${gradedVerdicts} graded outcomes, too small to draw conclusions yet`
  }

  // ── Expectancy suite ────────────────────────────────────────
  // R-multiple per resolved trade: target hit = +targetR, stop hit = −1R.
  // Expectancy = mean R per trade. Profit factor = gross win R / gross loss R.
  // Realized return = mean directional 1W move (includes trades that expired
  // without hitting either level — the honest "what actually happened" figure).
  let grossWinR = 0, grossLossR = 0, winCountR = 0, lossCountR = 0
  let retSum = 0, retCount = 0
  for (const r of rows) {
    const entry = Number(r.entry_price), stop = Number(r.stop_loss), tgt = Number(r.take_profit)
    const risk = Math.abs(entry - stop)
    const validRisk = entry > 0 && risk > 0 && risk / entry >= 0.001   // guard junk (entry≈stop)

    if (validRisk && r.outcome_1w_strict === 'win' && tgt > 0) {
      const targetR = Math.min(10, Math.abs(tgt - entry) / risk)       // cap absurd outliers
      grossWinR += targetR; winCountR++
    } else if (validRisk && r.outcome_1w_strict === 'loss') {
      grossLossR += 1; lossCountR++
    }

    // realized directional 1W return (bearish profits when price falls)
    const p1w = Number(r.outcome_1w_price)
    if (entry > 0 && p1w > 0) {
      const raw = (p1w - entry) / entry
      retSum += (r.signal === 'BEARISH' ? -raw : raw); retCount++
    }
  }
  const nR = winCountR + lossCountR
  const avgWinR = winCountR > 0 ? grossWinR / winCountR : null
  const expectancyR = nR > 0 ? (grossWinR - grossLossR) / nR : null
  const profitFactor = grossLossR > 0 ? grossWinR / grossLossR : (grossWinR > 0 ? null : null)
  const payoffRatio = avgWinR  // avg win R ÷ avg loss R, and avg loss R = 1 by definition
  const totalR = nR > 0 ? grossWinR - grossLossR : null
  const avgReturnPct = retCount > 0 ? (retSum / retCount) * 100 : null

  return {
    hitRate1w,
    directionAcc1w,
    totalVerdicts,
    gradedVerdicts,
    expectancyR: expectancyR === null ? null : Number(expectancyR.toFixed(3)),
    profitFactor: profitFactor === null ? null : Number(profitFactor.toFixed(2)),
    payoffRatio: payoffRatio === null ? null : Number(payoffRatio.toFixed(2)),
    avgWinR: avgWinR === null ? null : Number(avgWinR.toFixed(2)),
    totalR: totalR === null ? null : Number(totalR.toFixed(1)),
    avgReturnPct: avgReturnPct === null ? null : Number(avgReturnPct.toFixed(2)),
    sampleNote,
    versionLabel: version?.label ?? 'All time',
  }
}
