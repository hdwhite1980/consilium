// ═════════════════════════════════════════════════════════════
// /api/backtest/stats — Aggregated backtest statistics
//
// Query params:
//   scope: 'public' (default) | 'user' — user requires auth
//   horizon: '1w' (default) | '1m'
//   persona: 'all' (default) | 'balanced' | 'technical' | 'fundamental'
//   timeframe: 'all' (default) | '1D' | '1W' | '1M' | '3M'
//
// Returns:
//   - Headline stats: hit rate (strict), direction accuracy (directional)
//   - Breakdowns by persona, timeframe, confidence band
//   - Sample size for each cell
//   - Recent verdicts list (last 100, for public transparency)
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface VerdictRow {
  ticker: string
  signal: string
  confidence: number | null
  persona: string | null
  timeframe: string | null
  verdict_date: string
  entry_price: number | null
  outcome_1w_strict: string
  outcome_1w_directional: string
  outcome_1w_price: number | null
  outcome_1m_strict: string
  outcome_1m_directional: string
  outcome_1m_price: number | null
}

function computeHitRate(rows: VerdictRow[], horizon: '1w' | '1m'): {
  wins: number; losses: number; expired: number; total: number; hitRate: number
} {
  const strictCol = horizon === '1w' ? 'outcome_1w_strict' : 'outcome_1m_strict'
  let wins = 0, losses = 0, expired = 0
  for (const r of rows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (r as any)[strictCol]
    if (v === 'win') wins++
    else if (v === 'loss') losses++
    else if (v === 'expired') expired++
  }
  const total = wins + losses + expired
  // Hit rate = wins / (wins + losses); expired excluded (thesis never played out)
  const decided = wins + losses
  const hitRate = decided > 0 ? wins / decided : 0
  return { wins, losses, expired, total, hitRate }
}

function computeDirectionAccuracy(rows: VerdictRow[], horizon: '1w' | '1m'): {
  correct: number; incorrect: number; pending: number; total: number; accuracy: number
} {
  const col = horizon === '1w' ? 'outcome_1w_directional' : 'outcome_1m_directional'
  let correct = 0, incorrect = 0, pending = 0
  for (const r of rows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = (r as any)[col]
    if (v === 'win') correct++
    else if (v === 'loss') incorrect++
    else pending++
  }
  const total = correct + incorrect + pending
  const decided = correct + incorrect
  const accuracy = decided > 0 ? correct / decided : 0
  return { correct, incorrect, pending, total, accuracy }
}

function bucketConfidence(c: number | null): string {
  if (c === null || c === undefined) return 'unknown'
  if (c >= 80) return 'high (80+)'
  if (c >= 65) return 'medium (65-79)'
  if (c >= 50) return 'low (50-64)'
  return 'very low (<50)'
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const scope = url.searchParams.get('scope') ?? 'public'
  const horizon = (url.searchParams.get('horizon') ?? '1w') as '1w' | '1m'
  const personaFilter = url.searchParams.get('persona') ?? 'all'
  const timeframeFilter = url.searchParams.get('timeframe') ?? 'all'

  // Auth for user-scope requests
  let userId: string | null = null
  if (scope === 'user') {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
          setAll: () => {},
        },
      }
    )
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'authentication required for user scope' }, { status: 401 })
    }
    userId = user.id
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  let query = admin
    .from('verdict_log')
    .select('ticker, signal, confidence, persona, timeframe, verdict_date, entry_price, outcome_1w_strict, outcome_1w_directional, outcome_1w_price, outcome_1m_strict, outcome_1m_directional, outcome_1m_price')
    .order('verdict_date', { ascending: false })
    .limit(5000)

  // Filter out NEUTRAL signals — they're not meaningful for backtest
  query = query.neq('signal', 'NEUTRAL')

  if (userId) {
    query = query.eq('user_id', userId)
  }
  if (personaFilter !== 'all') {
    query = query.eq('persona', personaFilter)
  }
  if (timeframeFilter !== 'all') {
    query = query.eq('timeframe', timeframeFilter)
  }

  const { data: rows, error } = await query
  if (error) {
    console.error('[backtest-stats] query failed:', error.message)
    return NextResponse.json({ error: 'stats query failed', detail: error.message }, { status: 500 })
  }

  const allRows = (rows ?? []) as VerdictRow[]

  // Overall stats
  const overall = {
    hitRate: computeHitRate(allRows, horizon),
    direction: computeDirectionAccuracy(allRows, horizon),
  }

  // Breakdown by persona
  const personas = ['balanced', 'technical', 'fundamental']
  const byPersona = personas.map(p => {
    const subset = allRows.filter(r => r.persona === p)
    return {
      persona: p,
      sampleSize: subset.length,
      hitRate: computeHitRate(subset, horizon),
      direction: computeDirectionAccuracy(subset, horizon),
    }
  })

  // Breakdown by timeframe
  const timeframes = ['1D', '1W', '1M', '3M']
  const byTimeframe = timeframes.map(tf => {
    const subset = allRows.filter(r => r.timeframe === tf)
    return {
      timeframe: tf,
      sampleSize: subset.length,
      hitRate: computeHitRate(subset, horizon),
      direction: computeDirectionAccuracy(subset, horizon),
    }
  })

  // Breakdown by confidence band
  const bands = ['high (80+)', 'medium (65-79)', 'low (50-64)', 'very low (<50)']
  const byConfidence = bands.map(b => {
    const subset = allRows.filter(r => bucketConfidence(r.confidence) === b)
    return {
      band: b,
      sampleSize: subset.length,
      hitRate: computeHitRate(subset, horizon),
      direction: computeDirectionAccuracy(subset, horizon),
    }
  })

  // Signal breakdown (bullish vs bearish)
  const bullish = allRows.filter(r => r.signal === 'BULLISH')
  const bearish = allRows.filter(r => r.signal === 'BEARISH')

  const bySignal = [
    { signal: 'BULLISH', sampleSize: bullish.length, hitRate: computeHitRate(bullish, horizon), direction: computeDirectionAccuracy(bullish, horizon) },
    { signal: 'BEARISH', sampleSize: bearish.length, hitRate: computeHitRate(bearish, horizon), direction: computeDirectionAccuracy(bearish, horizon) },
  ]

  // Recent verdicts (last 100 for display)
  const horizonStrict = horizon === '1w' ? 'outcome_1w_strict' : 'outcome_1m_strict'
  const horizonDir    = horizon === '1w' ? 'outcome_1w_directional' : 'outcome_1m_directional'
  const horizonPrice  = horizon === '1w' ? 'outcome_1w_price' : 'outcome_1m_price'

  const recent = allRows.slice(0, 100).map(r => ({
    ticker: r.ticker,
    signal: r.signal,
    confidence: r.confidence,
    persona: r.persona,
    timeframe: r.timeframe,
    verdict_date: r.verdict_date,
    entry_price: r.entry_price,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outcome_strict: (r as any)[horizonStrict],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outcome_directional: (r as any)[horizonDir],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outcome_price: (r as any)[horizonPrice],
  }))

  return NextResponse.json({
    ok: true,
    scope,
    horizon,
    filters: { persona: personaFilter, timeframe: timeframeFilter },
    totalVerdicts: allRows.length,
    overall,
    byPersona,
    byTimeframe,
    byConfidence,
    bySignal,
    recent,
    generatedAt: new Date().toISOString(),
  })
}
