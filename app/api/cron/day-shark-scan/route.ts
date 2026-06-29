// =============================================================
// app/api/cron/day-shark-scan/route.ts
//
// Max's discovery lane. Enqueues 1D-horizon council analysis for momentum
// candidates, tagged source='day_shark', so the council issues TAKE/PASS/WAIT on
// a one-day view. The day-shark-trade executor (Phase 2b) then sizes the TAKEs
// against Max's budget.
//
// GATED on the per-asset slider: if maxAllocStockPct (etc.) is 0, Max is off for
// that asset and nothing is enqueued — no wasted council runs.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//   ?asset=stock  &limit=8  &userId=<uuid>  &maxAgeHours=12  &dryRun=1
//
// NOTE (refinement): candidates are currently a rotating universe slice. The
// honest day-trader version pre-filters to actual movers (top % change on
// volume) to focus council spend on names that are actually moving today.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { enqueueCouncil } from '@/app/lib/trading/council-queue'
import { loadUserTradingSettings } from '@/app/lib/trading/settings'
import { getAllUniverseTickers } from '@/app/lib/scanner-universe'
import { allocationPctFor } from '@/app/lib/trading/day-shark-budget'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

async function getRecentlyAnalyzed(userId: string, hours: number): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
  const { data } = await admin()
    .from('verdict_log').select('ticker')
    .eq('user_id', userId)
    .eq('source', 'day_shark')        // only skip names MAX recently analyzed — the regular
    .gte('created_at', cutoff)        // bots constantly touch these tickers and were starving him
  return new Set((data ?? []).map(r => String(r.ticker).toUpperCase()))
}

async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const userId = url.searchParams.get('userId')
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 })
  const asset = (url.searchParams.get('asset') ?? 'stock') as 'stock' | 'crypto' | 'forex'
  const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit') ?? '8')))
  const maxAgeHours = Number(url.searchParams.get('maxAgeHours') ?? '12')
  const slice = Math.max(0, Number(url.searchParams.get('slice') ?? '0'))
  const dryRun = url.searchParams.get('dryRun') === '1'

  const settings = await loadUserTradingSettings(userId)
  if (!settings) return NextResponse.json({ error: 'no settings' }, { status: 404 })

  // Gate on Max's slider for this asset — if he's off, do nothing.
  if (allocationPctFor(settings, asset) <= 0) {
    return NextResponse.json({ ok: true, skipped: `Max off for ${asset} (slider 0)`, enqueued: 0 })
  }

  // Candidate set per asset.
  const SHARK_CRYPTO = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD', 'AVAXUSD', 'LINKUSD', 'LTCUSD', 'ADAUSD', 'DOTUSD']
  const SHARK_FOREX = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'NZDUSD', 'EURJPY', 'GBPJPY']
  let candidates: string[]
  let assetType: 'stock' | 'crypto' | 'forex'
  if (asset === 'crypto') {
    assetType = 'crypto'
    candidates = SHARK_CRYPTO.slice(0, limit)
  } else if (asset === 'forex') {
    assetType = 'forex'
    candidates = SHARK_FOREX.slice(0, limit)
  } else {
    assetType = 'stock'
    const universe = getAllUniverseTickers()
    const start = (slice * limit) % Math.max(1, universe.length)
    candidates = universe.slice(start, start + limit)
  }

  const seen = await getRecentlyAnalyzed(userId, maxAgeHours)

  let enqueued = 0
  const results: Array<{ ticker: string; status: string }> = []
  for (const ticker of candidates) {
    const t = ticker.toUpperCase()
    if (seen.has(t)) { results.push({ ticker: t, status: 'recently_analyzed' }); continue }
    if (dryRun) { results.push({ ticker: t, status: 'would_enqueue' }); continue }
    const r = await enqueueCouncil({
      userId, ticker: t, assetType,
      source: 'day_shark', pool: 'normal', timeframe: '1D',
    })
    results.push({ ticker: t, status: String(r) })
    if (r === 'enqueued') enqueued++
  }

  return NextResponse.json({ ok: true, asset, candidates: candidates.length, enqueued, results })
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }
