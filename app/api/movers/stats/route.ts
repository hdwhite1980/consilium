// ═════════════════════════════════════════════════════════════
// app/api/movers/stats/route.ts
//
// Returns aggregated hit-rate stats from movers_log + movers_outcomes.
// Used by the hit-rate widget on /today and /tomorrow pages, and by
// any admin dashboard that wants to show accuracy over time.
//
// Query params:
//   ?source=today|tomorrow  (default: both)
//   ?days=7|14|30|90        (default: 30)
//
// Returns:
//   - overall 1d and 3d hit rates
//   - breakdown by signal (BULLISH / BEARISH / NEUTRAL)
//   - breakdown by confidence bucket
//   - breakdown by regime
//   - total calls made and resolved
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const source = searchParams.get('source') // 'today' | 'tomorrow' | null (both)
  const daysParam = searchParams.get('days')
  const days = daysParam && /^\d+$/.test(daysParam)
    ? Math.max(1, Math.min(90, parseInt(daysParam, 10)))
    : 30

  try {
    const admin = getAdmin()
    const since = new Date()
    since.setUTCDate(since.getUTCDate() - days)
    const sinceStr = since.toISOString().split('T')[0]

    // Join movers_log + movers_outcomes client-side (Supabase JS doesn't
    // support complex joins cleanly — two queries + merge is simpler)
    let movLogQuery = admin
      .from('movers_log')
      .select('id, source, ticker, signal, magnitude, confidence, market_regime')
      .gte('flagged_date', sinceStr)

    if (source === 'today' || source === 'tomorrow') {
      movLogQuery = movLogQuery.eq('source', source)
    }

    const { data: movers, error: mErr } = await movLogQuery
    if (mErr) throw new Error(`movers_log query failed: ${mErr.message}`)
    if (!movers || movers.length === 0) {
      return NextResponse.json({
        days,
        source: source ?? 'both',
        totalCalls: 0,
        resolvedCalls: 0,
        overallHitRate1d: null,
        overallHitRate3d: null,
        bySignal: {},
        byConfidenceBucket: {},
        byRegime: {},
        bySource: {},
        message: 'No movers logged in this period yet',
      })
    }

    const ids = movers.map(m => m.id as number)
    const { data: outcomes } = await admin
      .from('movers_outcomes')
      .select('mover_id, outcome_1d, outcome_3d, change_1d_pct, change_3d_pct, magnitude_hit_1d, magnitude_hit_3d')
      .in('mover_id', ids)

    interface OutcomeRow {
      mover_id: number
      outcome_1d: string | null
      outcome_3d: string | null
      change_1d_pct: number | null
      change_3d_pct: number | null
      magnitude_hit_1d: boolean | null
      magnitude_hit_3d: boolean | null
    }

    const outcomeMap = new Map<number, OutcomeRow>()
    for (const o of (outcomes ?? []) as OutcomeRow[]) {
      outcomeMap.set(o.mover_id, o)
    }

    // ─────────────────────────────────────────────────
    // Aggregation helpers
    // ─────────────────────────────────────────────────
    type Bucket = { total: number; resolved1d: number; correct1d: number; resolved3d: number; correct3d: number }
    const newBucket = (): Bucket => ({ total: 0, resolved1d: 0, correct1d: 0, resolved3d: 0, correct3d: 0 })

    const overall: Bucket = newBucket()
    const bySignal: Record<string, Bucket> = {}
    const byConfidenceBucket: Record<string, Bucket> = {}
    const byRegime: Record<string, Bucket> = {}
    const bySourceBkt: Record<string, Bucket> = {}

    const getConfBucket = (c: number | null): string => {
      if (c === null) return 'unscored'
      if (c >= 80) return 'high (80+)'
      if (c >= 70) return 'med-high (70-79)'
      if (c >= 60) return 'medium (60-69)'
      return 'low (<60)'
    }

    for (const m of movers) {
      const signal = (m.signal as string) ?? 'UNKNOWN'
      const regime = (m.market_regime as string) ?? 'unknown'
      const src = (m.source as string) ?? 'unknown'
      const confBucket = getConfBucket(m.confidence as number | null)

      bySignal[signal] = bySignal[signal] ?? newBucket()
      byConfidenceBucket[confBucket] = byConfidenceBucket[confBucket] ?? newBucket()
      byRegime[regime] = byRegime[regime] ?? newBucket()
      bySourceBkt[src] = bySourceBkt[src] ?? newBucket()

      const buckets = [overall, bySignal[signal], byConfidenceBucket[confBucket], byRegime[regime], bySourceBkt[src]]

      for (const b of buckets) b.total++

      const o = outcomeMap.get(m.id as number)
      if (o) {
        if (o.outcome_1d) {
          for (const b of buckets) {
            b.resolved1d++
            if (o.outcome_1d === 'correct') b.correct1d++
          }
        }
        if (o.outcome_3d) {
          for (const b of buckets) {
            b.resolved3d++
            if (o.outcome_3d === 'correct') b.correct3d++
          }
        }
      }
    }

    // Convert buckets to rates
    const bucketToRate = (b: Bucket) => ({
      total: b.total,
      resolved1d: b.resolved1d,
      correct1d: b.correct1d,
      hitRate1dPct: b.resolved1d > 0
        ? Math.round(1000 * b.correct1d / b.resolved1d) / 10
        : null,
      resolved3d: b.resolved3d,
      correct3d: b.correct3d,
      hitRate3dPct: b.resolved3d > 0
        ? Math.round(1000 * b.correct3d / b.resolved3d) / 10
        : null,
    })

    const mapBuckets = (obj: Record<string, Bucket>): Record<string, ReturnType<typeof bucketToRate>> => {
      const out: Record<string, ReturnType<typeof bucketToRate>> = {}
      for (const [k, v] of Object.entries(obj)) {
        out[k] = bucketToRate(v)
      }
      return out
    }

    return NextResponse.json({
      days,
      source: source ?? 'both',
      since: sinceStr,
      totalCalls: overall.total,
      resolvedCalls1d: overall.resolved1d,
      resolvedCalls3d: overall.resolved3d,
      overallHitRate1d: overall.resolved1d > 0
        ? Math.round(1000 * overall.correct1d / overall.resolved1d) / 10
        : null,
      overallHitRate3d: overall.resolved3d > 0
        ? Math.round(1000 * overall.correct3d / overall.resolved3d) / 10
        : null,
      bySignal: mapBuckets(bySignal),
      byConfidenceBucket: mapBuckets(byConfidenceBucket),
      byRegime: mapBuckets(byRegime),
      bySource: mapBuckets(bySourceBkt),
    })
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message?.slice(0, 300) ?? 'unknown error' },
      { status: 500 }
    )
  }
}
