// =============================================================
// app/api/cron/live-movers-trade/route.ts
//
// Live intraday early-gainer -> Council -> trade lane. Parameterized by asset
// class; mirrors crypto-accumulation-trade (direct /analyze trigger, NOT the
// stock scanner_triage table). The verdict_log 4h dedup coordinates this lane
// with the momentum and accumulation lanes so a ticker is analyzed once.
//
//   GET ?assetType=crypto   (or forex | futures)
//       &minScore=45 &limit=6 &userId=<uuid> &dryRun=1
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { detectLiveMovers, type LiveAssetType } from '@/app/lib/signals/live-movers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const DEFAULT_USER = '709312ee-df59-47f2-a351-49660142ed77'
const DEFAULT_MIN_SCORE = 45
const DEFAULT_LIMIT = 6
const DEDUP_HOURS = 4
const VALID: LiveAssetType[] = ['crypto', 'forex', 'futures']

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

function getAdmin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// Council ticker form differs by class:
//   crypto  -> concatenated BASE+USD (POL -> POLUSD), the gate's canonical form
//   forex   -> the pair as-is (EURUSD)
//   futures -> the proxy ETF as-is (SPY)
function toCouncilSymbol(assetType: LiveAssetType, symbol: string): string {
  if (assetType === 'crypto') {
    const base = (symbol.split('-')[0] ?? symbol).toUpperCase()
    return `${base}USD`
  }
  return symbol.toUpperCase()
}

async function getRecentlyAnalyzed(userId: string, hours: number): Promise<Set<string>> {
  const admin = getAdmin()
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
  const { data } = await admin
    .from('verdict_log').select('ticker')
    .eq('user_id', userId).gte('created_at', cutoff)
  return new Set((data as Array<{ ticker: string }> ?? []).map(r => r.ticker.toUpperCase()))
}

async function triggerAnalyze(userId: string, ticker: string, assetType: LiveAssetType): Promise<boolean> {
  const rawBase = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '')
  if (!rawBase) { console.warn('[live-movers-trade] APP_BASE_URL not set'); return false }
  const baseUrl = /^https?:\/\//.test(rawBase) ? rawBase : `https://${rawBase}`
  try {
    const res = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Trigger': 'live-movers-trade',
        'X-Service-User-Id': userId,
        'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
      },
      body: JSON.stringify({ ticker, userId, source: `live_movers_${assetType}`, timeframe: '1D', persona: 'balanced' }),
      signal: AbortSignal.timeout(90_000),
    })
    return res.ok
  } catch (e) {
    console.warn(`[live-movers-trade] analyze trigger failed for ${ticker}:`, e instanceof Error ? e.message : e)
    return false
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }

async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const at = (url.searchParams.get('assetType') ?? 'crypto').toLowerCase() as LiveAssetType
  const assetType = VALID.includes(at) ? at : 'crypto'
  const userId = url.searchParams.get('userId') ?? DEFAULT_USER
  const minScore = Number(url.searchParams.get('minScore') ?? DEFAULT_MIN_SCORE)
  const limit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const universeLimit = url.searchParams.get('universeLimit')
  const dryRun = url.searchParams.get('dryRun') === '1'

  let movers
  try {
    movers = await detectLiveMovers(assetType, {
      universeLimit: universeLimit ? Number(universeLimit) : undefined,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }

  const recentlyAnalyzed = await getRecentlyAnalyzed(userId, DEDUP_HOURS)

  const selected: Array<{ display: string; council: string; score: number; changePct: number }> = []
  for (const m of movers) {
    if (m.score < minScore) continue
    const council = toCouncilSymbol(assetType, m.symbol)
    if (recentlyAnalyzed.has(council)) continue
    if (selected.some(s => s.council === council)) continue
    selected.push({ display: m.symbol, council, score: m.score, changePct: m.intradayChangePct })
    if (selected.length >= limit) break
  }

  const triggered: string[] = []
  const failed: string[] = []
  if (!dryRun) {
    for (const s of selected) {
      const ok = await triggerAnalyze(userId, s.council, assetType)
      if (ok) triggered.push(s.council); else failed.push(s.council)
    }
  }

  console.log(`[live-movers-trade] assetType=${assetType} movers=${movers.length} selected=${selected.length} triggered=${triggered.length} failed=${failed.length}${dryRun ? ' (dryRun)' : ''}`)

  return NextResponse.json({
    assetType,
    userId,
    minScore,
    moversFound: movers.length,
    selected: selected.map(s => ({ ticker: s.council, display: s.display, score: s.score, intradayChangePct: s.changePct })),
    triggered,
    failed,
    dryRun,
    note: 'Triggered movers flow through the Council; the matching auto-trade cron executes any TAKE verdicts.',
  }, { status: 200 })
}
