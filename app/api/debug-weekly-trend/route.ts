// =============================================================
// app/api/debug-weekly-trend/route.ts
//
// Verification endpoint for the weekly-trend / accumulation analyzer.
// Runs getWeeklyTrend on one or more tickers and returns the full breakdown
// (every sub-metric + the human-readable notes) so the read can be checked by
// eye against the chart.
//
// Auth: GET with Authorization: Bearer ${CRON_SECRET}
//   /api/debug-weekly-trend?ticker=POL&assetType=crypto
//   /api/debug-weekly-trend?ticker=POL,ETH,SOL&assetType=crypto
//   /api/debug-weekly-trend?ticker=AAPL,NVDA&assetType=stock
//   /api/debug-weekly-trend?ticker=SPY,QQQ&assetType=futures
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getWeeklyTrend, runAccumulationScan, type WeeklyTrendAssetType } from '@/app/lib/signals/weekly-trend'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

const VALID: WeeklyTrendAssetType[] = ['stock', 'crypto', 'futures', 'forex']

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized - send Authorization: Bearer <CRON_SECRET>' }, { status: 401 })
  }

  const url = new URL(req.url)

  // ?mode=scan -> run the crypto accumulation discovery scan (finds POL-style
  // coils across the liquid universe), instead of analyzing specific tickers.
  if (url.searchParams.get('mode') === 'scan') {
    const minStrength = Number(url.searchParams.get('minStrength') ?? '45')
    const universeLimit = Number(url.searchParams.get('limit') ?? '40')
    const scan = await runAccumulationScan({ minStrength, universeLimit })
    return NextResponse.json({
      mode: 'accumulation-scan',
      generatedAt: new Date().toISOString(),
      universeSize: scan.universeSize,
      scanned: scan.scanned,
      found: scan.picks.length,
      picks: scan.picks.map(p => ({
        symbol: p.baseSymbol,
        phase: p.weekly.phase,
        bias: p.weekly.bias,
        strength: p.weekly.strength,
        priceChange24h: p.priceChange24h,
        volumeUsd24h: Math.round(p.volumeUsd24h),
        note: p.weekly.notes[0],
      })),
      // every coin the scan checked + its read, so found:0 is explainable
      scannedReads: scan.scannedReads.sort((a, b) => b.strength - a.strength),
    }, { status: 200 })
  }

  const tickersParam = url.searchParams.get('ticker') ?? 'POL'
  const assetTypeParam = (url.searchParams.get('assetType') ?? 'crypto').toLowerCase() as WeeklyTrendAssetType
  const assetType = VALID.includes(assetTypeParam) ? assetTypeParam : 'crypto'

  const tickers = tickersParam.split(',').map(t => t.trim()).filter(Boolean).slice(0, 12)

  const results = await Promise.all(
    tickers.map(async (ticker) => {
      const analysis = await getWeeklyTrend(ticker, assetType)
      return {
        ticker: ticker.toUpperCase(),
        assetType,
        // headline read first for quick scanning
        phase: analysis.phase,
        bias: analysis.bias,
        strength: analysis.strength,
        trend: analysis.trend,
        volumeTrend: analysis.volumeTrend,
        detail: analysis,
      }
    }),
  )

  return NextResponse.json({
    assetType,
    count: results.length,
    generatedAt: new Date().toISOString(),
    results,
  }, { status: 200 })
}
