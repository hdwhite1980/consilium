// =============================================================
// app/api/debug-verdict-memory/route.ts
//
// Inspect the dormant learning substrate. Nothing here influences the Council;
// it shows what the loop WOULD see once activated.
//
//   ?stats=1                                  -> resolved count, % with features, calibration curve
//   ?signal=BULLISH&timeframe=1W&confidence=65 -> retrieval test from explicit params
//        [&source=stock_accumulation&grade=A&riskReward=2&k=10&horizon=1w]
//   ?ticker=AAPL                              -> build the query from AAPL's latest verdict, then retrieve
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  retrieveSimilarVerdicts, loadResolvedMemory, computeCalibration,
  type Horizon, type RetrievalQuery,
} from '@/app/lib/learning/verdict-memory'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}
function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const db = admin()
  const horizon = (url.searchParams.get('horizon') ?? '1w') as Horizon

  // ── RAG readiness mode (is the C-engine gate open?) ──
  if (url.searchParams.get('readiness') === '1') {
    const { ragReadiness } = await import('@/app/lib/learning/council-rag')
    return NextResponse.json(await ragReadiness((url.searchParams.get('horizon') ?? '1m') as Horizon))
  }

  // ── Stats / calibration mode ──
  if (url.searchParams.get('stats') === '1') {
    const resolved = await loadResolvedMemory(db, horizon)
    const withFeatures = resolved.filter(r => r.features != null).length
    return NextResponse.json({
      horizon,
      resolvedVerdicts: resolved.length,
      withFeatures,
      calibration: computeCalibration(resolved),
      note: 'Dormant substrate — NOT wired into the Council. calibration = confidence band vs realized directional win rate.',
    })
  }

  // ── Retrieval test mode ──
  let query: RetrievalQuery
  const ticker = url.searchParams.get('ticker')
  if (ticker) {
    const { data: latest } = await db.from('verdict_log')
      .select('signal, confidence, timeframe, source, trader_grade, trader_risk_reward, features')
      .eq('ticker', ticker.toUpperCase())
      .order('verdict_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!latest) return NextResponse.json({ error: `no verdicts found for ${ticker}` }, { status: 404 })
    const l = latest as Record<string, unknown>
    query = {
      signal: String(l.signal ?? 'BULLISH'),
      confidence: (l.confidence as number) ?? null,
      timeframe: (l.timeframe as string) ?? null,
      source: (l.source as string) ?? null,
      traderGrade: (l.trader_grade as string) ?? null,
      riskReward: (l.trader_risk_reward as number) ?? null,
      features: (l.features as RetrievalQuery['features']) ?? null,
    }
  } else {
    const numOf = (k: string) => { const v = url.searchParams.get(k); return v == null ? null : Number(v) }
    query = {
      signal: url.searchParams.get('signal') ?? 'BULLISH',
      confidence: numOf('confidence'),
      timeframe: url.searchParams.get('timeframe'),
      source: url.searchParams.get('source'),
      traderGrade: url.searchParams.get('grade'),
      riskReward: numOf('riskReward'),
      features: null,
    }
  }

  const k = Number(url.searchParams.get('k') ?? '10')
  const result = await retrieveSimilarVerdicts(db, query, { k, horizon })
  return NextResponse.json({
    query, horizon, ...result,
    note: 'Retrieval is DORMANT — this is what RAG WOULD inject into the Council, not what it currently uses. favorableRate = of the K most-similar resolved verdicts, how many went the right way.',
  })
}
