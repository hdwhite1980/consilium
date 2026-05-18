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
import { createClient } from '@/app/lib/auth/server'
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
    // Auth check
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const url = new URL(req.url)
    const versionParam = url.searchParams.get('version') ?? 'current'

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

    const stats = await computeStats(version)
    return NextResponse.json(stats, {
      headers: { 'Cache-Control': 'private, max-age=300' },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[track-record/stats] Error:', msg)
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────

async function computeStats(version: SystemVersion | null): Promise<Stats> {
  const admin = getAdmin()
  let q = admin
    .from('verdict_log')
    .select('outcome_1w_strict, outcome_1w_directional')
    .in('signal', ['BULLISH', 'BEARISH'])

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

  return {
    hitRate1w,
    directionAcc1w,
    totalVerdicts,
    gradedVerdicts,
    sampleNote,
    versionLabel: version?.label ?? 'All time',
  }
}
