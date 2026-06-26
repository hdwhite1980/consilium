// =============================================================
// app/api/cron/backtest-portfolio/route.ts
//
// Sweep the weekly-trend signal across a universe, pool the trades into one
// expectancy figure, and persist to backtest_runs. Heavy — run offline / on a
// slow schedule, not request-time.
//
//   GET ?assetType=crypto&limit=30
//       ?assetType=stock&symbols=AAPL,MSFT,NVDA   (explicit list overrides universe)
//       &minStrength=50 &stopPct=0.05 &rMultiple=2   (param overrides)
//       ?view=1   (list recent runs instead of running)
// Auth: Authorization: Bearer ${CRON_SECRET}
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { runPortfolioBacktest, resolveUniverse } from '@/app/lib/backtest/portfolio-backtest'
import type { BacktestAssetType, BacktestParams } from '@/app/lib/backtest/backtest-engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}
function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

const VALID: BacktestAssetType[] = ['stock', 'crypto', 'forex', 'futures']

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }

async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const db = admin()

  if (url.searchParams.get('view') === '1') {
    const { data } = await db.from('backtest_runs')
      .select('id, signal, asset_type, universe, symbols_tested, total_trades, bracket_stats, horizon_stats, created_at')
      .order('created_at', { ascending: false }).limit(20)
    return NextResponse.json({ recent: data ?? [] })
  }

  const at = (url.searchParams.get('assetType') ?? 'crypto').toLowerCase() as BacktestAssetType
  const assetType = VALID.includes(at) ? at : 'crypto'
  const limit = Number(url.searchParams.get('limit') ?? '30')
  const explicit = url.searchParams.get('symbols')

  const override: Partial<BacktestParams> = {}
  const num = (k: string) => { const v = url.searchParams.get(k); return v == null ? undefined : Number(v) }
  for (const k of ['minStrength', 'stopPct', 'rMultiple', 'horizonBars', 'maxHoldBars', 'warmupBars', 'stepBars', 'costBps'] as const) {
    const v = num(k); if (v !== undefined && Number.isFinite(v)) (override as Record<string, number>)[k] = v
  }

  let universe: { symbols: string[]; label: string }
  try {
    universe = await resolveUniverse(assetType, limit, explicit)
  } catch (e) {
    return NextResponse.json({ error: `universe resolution failed: ${e instanceof Error ? e.message : e}` }, { status: 500 })
  }

  const result = await runPortfolioBacktest({
    symbols: universe.symbols, assetType, universe: universe.label, override,
    concurrency: assetType === 'crypto' ? 2 : 5,   // crypto pages Coinbase; keep it gentle
  })

  // Persist
  const { data: row, error } = await db.from('backtest_runs').insert({
    signal: result.signal,
    asset_type: result.assetType,
    universe: result.universe,
    params: result.params,
    symbols_requested: result.symbolsRequested,
    symbols_tested: result.symbolsTested,
    total_trades: result.totalTrades,
    bracket_stats: result.bracket,
    horizon_stats: result.horizon,
    per_symbol: result.perSymbol,
    failures: result.failures,
  }).select('id').single()
  if (error) console.warn('[backtest-portfolio] persist failed:', error.message)

  return NextResponse.json({ runId: row?.id ?? null, ...result }, { status: 200 })
}
