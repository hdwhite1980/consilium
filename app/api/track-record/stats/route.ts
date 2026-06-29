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
import { isCryptoPairSymbol } from '@/app/lib/crypto-symbol'
import {
  getCurrentVersion,
  getVersionByNumber,
  type SystemVersion,
} from '@/app/lib/system-versions'

export const runtime = 'nodejs'
export const maxDuration = 10

const MIN_GRADED_FOR_MATURE = 30  // below this, return preview note

interface BucketStats {
  hitRate1w: number | null
  directionAcc1w: number | null
  totalVerdicts: number
  gradedVerdicts: number
  expectancyR: number | null      // mean R per trade (target=+R, stop=−1R); >0 = edge
  profitFactor: number | null     // gross win R / gross loss R; >1 = profitable
  payoffRatio: number | null      // avg win R / avg loss R (avg loss = 1R)
  avgWinR: number | null
  totalR: number | null           // cumulative R captured across resolved trades
  avgReturnPct: number | null     // mean realized 1W directional return (outlier-prone)
  medianReturnPct: number | null  // median realized 1W return (honest middle)
  avgAlphaPct: number | null      // mean (strategy return − SPY return) — outlier-prone
  medianAlphaPct: number | null   // median alpha — the honest middle
  beatSpyRate: number | null      // % of benchmarked verdicts that beat SPY
  benchmarkedCount: number        // how many verdicts have a SPY benchmark
}

interface Stats extends BucketStats {
  sampleNote: string | null
  versionLabel: string
  byAsset: { stock: BucketStats; crypto: BucketStats; forex: BucketStats }
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

type VRow = {
  outcome_1w_strict: string | null
  outcome_1w_directional: string | null
  outcome_1w_price: number | string | null
  signal: string | null
  entry_price: number | string | null
  stop_loss: number | string | null
  take_profit: number | string | null
  ticker: string | null
  spy_return_1w: number | string | null
}

function assetOf(ticker: string | null): 'crypto' | 'forex' | 'stock' {
  if (!ticker) return 'stock'
  if (isCryptoPairSymbol(ticker)) return 'crypto'
  if (/^[A-Z]{6}$/.test(ticker)) return 'forex'
  return 'stock'
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const round = (x: number | null, d = 2): number | null => (x === null ? null : Number(x.toFixed(d)))

// Compute the full expectancy suite for any subset of verdict rows.
function bucketStats(rows: VRow[]): BucketStats {
  let wins = 0, losses = 0, dirC = 0, dirI = 0
  let grossWinR = 0, grossLossR = 0, winCountR = 0, lossCountR = 0
  const rets: number[] = []
  const alphas: number[] = []

  for (const r of rows) {
    if (r.outcome_1w_strict === 'win') wins++
    else if (r.outcome_1w_strict === 'loss') losses++
    if (r.outcome_1w_directional === 'win') dirC++
    else if (r.outcome_1w_directional === 'loss') dirI++

    const entry = Number(r.entry_price), stop = Number(r.stop_loss), tgt = Number(r.take_profit)
    const risk = Math.abs(entry - stop)
    const validRisk = entry > 0 && risk > 0 && risk / entry >= 0.001   // guard junk (entry≈stop)
    if (validRisk && r.outcome_1w_strict === 'win' && tgt > 0) {
      grossWinR += Math.min(10, Math.abs(tgt - entry) / risk); winCountR++   // cap absurd outliers
    } else if (validRisk && r.outcome_1w_strict === 'loss') {
      grossLossR += 1; lossCountR++
    }

    const p1w = Number(r.outcome_1w_price)
    if (entry > 0 && p1w > 0) {
      const stratRet = (r.signal === 'BEARISH' ? -1 : 1) * ((p1w - entry) / entry) * 100
      rets.push(stratRet)
      // Alpha vs SPY over the same window (only where the benchmark is cached)
      if (r.spy_return_1w !== null && r.spy_return_1w !== undefined) {
        alphas.push(stratRet - Number(r.spy_return_1w) * 100)
      }
    }
  }

  const graded = wins + losses
  const dirGraded = dirC + dirI
  const nR = winCountR + lossCountR
  const avgWinR = winCountR > 0 ? grossWinR / winCountR : null
  return {
    hitRate1w: graded > 0 ? round((wins / graded) * 100) : null,
    directionAcc1w: dirGraded > 0 ? round((dirC / dirGraded) * 100) : null,
    totalVerdicts: rows.length,
    gradedVerdicts: graded,
    expectancyR: nR > 0 ? round((grossWinR - grossLossR) / nR, 3) : null,
    profitFactor: grossLossR > 0 ? round(grossWinR / grossLossR) : null,
    payoffRatio: round(avgWinR),
    avgWinR: round(avgWinR),
    totalR: nR > 0 ? round(grossWinR - grossLossR, 1) : null,
    avgReturnPct: rets.length > 0 ? round(rets.reduce((a, b) => a + b, 0) / rets.length) : null,
    medianReturnPct: round(median(rets)),
    avgAlphaPct: alphas.length > 0 ? round(alphas.reduce((a, b) => a + b, 0) / alphas.length) : null,
    medianAlphaPct: round(median(alphas)),
    beatSpyRate: alphas.length > 0 ? round((alphas.filter(a => a > 0).length / alphas.length) * 100) : null,
    benchmarkedCount: alphas.length,
  }
}

async function computeStats(version: SystemVersion | null, source?: string | null): Promise<Stats> {
  const admin = getAdmin()
  let q = admin
    .from('verdict_log')
    .select('outcome_1w_strict, outcome_1w_directional, outcome_1w_price, signal, entry_price, stop_loss, take_profit, ticker, spy_return_1w')
    .in('signal', ['BULLISH', 'BEARISH'])

  // Max (day_shark) is measured separately — exclude by default; opt in via ?source=day_shark
  if (source === 'day_shark') q = q.eq('source', 'day_shark')
  else q = q.or('source.is.null,source.neq.day_shark')

  if (version) q = q.eq('version_number', version.number)

  const { data, error } = await q
  if (error) throw new Error(`stats query failed: ${error.message}`)

  const rows = (data ?? []) as VRow[]
  const overall = bucketStats(rows)
  const byAsset = {
    stock: bucketStats(rows.filter(r => assetOf(r.ticker) === 'stock')),
    crypto: bucketStats(rows.filter(r => assetOf(r.ticker) === 'crypto')),
    forex: bucketStats(rows.filter(r => assetOf(r.ticker) === 'forex')),
  }

  // Honest sample-size note
  let sampleNote: string | null = null
  if (overall.gradedVerdicts === 0 && overall.totalVerdicts > 0) {
    sampleNote = `${overall.totalVerdicts} verdicts logged, none graded yet — outcomes need ~5 trading days to resolve`
  } else if (overall.gradedVerdicts < MIN_GRADED_FOR_MATURE) {
    sampleNote = `Preview — only ${overall.gradedVerdicts} graded outcomes, too small to draw conclusions yet`
  }

  return { ...overall, byAsset, sampleNote, versionLabel: version?.label ?? 'All time' }
}
