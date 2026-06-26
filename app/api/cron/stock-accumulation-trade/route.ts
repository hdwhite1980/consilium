// =============================================================
// app/api/cron/stock-accumulation-trade/route.ts
//
// Equity accumulation -> Council -> trade lane. Stock counterpart to
// crypto-accumulation-trade, sourced from stock_accumulation_scan.
//
// Flow:
//   1. Read fresh bullish accumulation coils from stock_accumulation_scan
//   2. Gate on the user's tradeStocks flag (no-op if stocks are off — unlike the
//      crypto lane, this one self-gates so it won't waste Council compute)
//   3. Dedup against tickers analyzed in the last 4h
//   4. enqueueCouncil (normal pool) -> Council issues TAKE/PASS/WAIT
//   5. The existing auto-trade stock cron executes the TAKE verdicts
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//   ?minStrength=50 &limit=6 &userId=<uuid> &maxAgeHours=24 &dryRun=1
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { selectTimeframe, type Timeframe } from '@/app/lib/signals/timeframe-selector'
import { enqueueCouncil } from '@/app/lib/trading/council-queue'
import { loadUserTradingSettings, isAssetClassEnabled } from '@/app/lib/trading/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const DEFAULT_USER = '709312ee-df59-47f2-a351-49660142ed77'
const DEFAULT_MIN_STRENGTH = 50
const DEFAULT_LIMIT = 6
const DEDUP_HOURS = 4

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}
function getAdmin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

async function getRecentlyAnalyzed(userId: string, hours: number): Promise<Set<string>> {
  const admin = getAdmin()
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
  const { data } = await admin
    .from('verdict_log').select('ticker')
    .eq('user_id', userId).gte('created_at', cutoff)
  return new Set((data as Array<{ ticker: string }> ?? []).map(r => r.ticker.toUpperCase()))
}

async function triggerAnalyze(userId: string, ticker: string, timeframe: Timeframe): Promise<boolean> {
  const r = await enqueueCouncil({
    userId, ticker, assetType: 'stock',
    source: 'stock_accumulation', pool: 'normal', timeframe,
  })
  return r === 'enqueued'
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }

async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const userId = url.searchParams.get('userId') ?? DEFAULT_USER
  const minStrength = Number(url.searchParams.get('minStrength') ?? DEFAULT_MIN_STRENGTH)
  const limit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const maxAgeHours = Number(url.searchParams.get('maxAgeHours') ?? '24')
  const dryRun = url.searchParams.get('dryRun') === '1'

  // Self-gate: don't enqueue stock coils if the user has stock trading off.
  const settings = await loadUserTradingSettings(userId)
  if (!settings || !isAssetClassEnabled(settings, 'stock')) {
    return NextResponse.json({
      userId, skipped: true, reason: 'tradeStocks disabled for user',
      selected: [], triggered: [], failed: [],
    })
  }

  const admin = getAdmin()
  const freshCutoff = new Date(Date.now() - maxAgeHours * 3_600_000).toISOString()

  const { data: coils, error } = await admin
    .from('stock_accumulation_scan')
    .select('symbol, band, sector, strength, phase, bias, has_history, scanned_at')
    .eq('phase', 'accumulation')
    .eq('bias', 'bullish')
    .eq('has_history', true)
    .gte('strength', minStrength)
    .gte('scanned_at', freshCutoff)
    .order('strength', { ascending: false })
    .limit(limit * 3)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const recentlyAnalyzed = await getRecentlyAnalyzed(userId, DEDUP_HOURS)

  const selected: Array<{ ticker: string; strength: number; cap: string; sector: string; timeframe: Timeframe }> = []
  for (const c of (coils ?? [])) {
    const ticker = (c.symbol as string).toUpperCase()
    if (recentlyAnalyzed.has(ticker)) continue
    if (selected.some(s => s.ticker === ticker)) continue
    selected.push({ ticker, strength: c.strength, cap: c.band, sector: c.sector, timeframe: '1W' })
    if (selected.length >= limit) break
  }

  // Preliminary chart read — coils default to swing (1W); may upgrade to position
  // (1M) on a maturing base or flag an intraday breakout (1D).
  for (const s of selected) {
    try { s.timeframe = (await selectTimeframe(s.ticker, 'stock', { fallback: '1W' })).timeframe }
    catch { s.timeframe = '1W' }
  }

  const triggered: string[] = []
  const failed: string[] = []
  if (!dryRun) {
    for (const s of selected) {
      const ok = await triggerAnalyze(userId, s.ticker, s.timeframe)
      if (ok) triggered.push(s.ticker); else failed.push(s.ticker)
    }
  }

  console.log(`[stock-accum-trade] candidates=${selected.length} triggered=${triggered.length} failed=${failed.length}${dryRun ? ' (dryRun)' : ''}`)

  return NextResponse.json({
    userId, minStrength,
    candidatesConsidered: coils?.length ?? 0,
    selected: selected.map(s => ({ ticker: s.ticker, strength: s.strength, cap: s.cap, sector: s.sector, timeframe: s.timeframe })),
    triggered, failed, dryRun,
    note: 'Triggered coils flow through the Council; auto-trade executes any TAKE verdicts (stock path).',
  }, { status: 200 })
}
