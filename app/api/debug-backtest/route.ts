// app/api/debug-backtest/route.ts — run the weekly-trend backtest on one symbol.
//   GET ?ticker=AAPL&assetType=stock
//       &minStrength=50 &stopPct=0.05 &rMultiple=2 &horizonBars=20 &costBps=5
// Auth: Authorization: Bearer ${CRON_SECRET}
import { NextRequest, NextResponse } from 'next/server'
import { runWeeklyTrendBacktest, type BacktestAssetType, type BacktestParams } from '@/app/lib/backtest/backtest-engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

const VALID: BacktestAssetType[] = ['stock', 'crypto', 'forex', 'futures']

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const ticker = url.searchParams.get('ticker')
  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })
  const at = (url.searchParams.get('assetType') ?? 'stock').toLowerCase() as BacktestAssetType
  const assetType = VALID.includes(at) ? at : 'stock'

  const override: Partial<BacktestParams> = {}
  const num = (k: string) => { const v = url.searchParams.get(k); return v == null ? undefined : Number(v) }
  for (const k of ['minStrength', 'stopPct', 'rMultiple', 'horizonBars', 'maxHoldBars', 'warmupBars', 'stepBars', 'costBps'] as const) {
    const v = num(k); if (v !== undefined && Number.isFinite(v)) (override as Record<string, number>)[k] = v
  }

  try {
    const result = await runWeeklyTrendBacktest(ticker, assetType, override)
    return NextResponse.json(result)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
