// =============================================================
// app/api/cron/backtest-oos/route.ts
//
// Out-of-sample stop sweep. The honesty guard against curve-fitting:
//   1. Load each symbol's deep history ONCE.
//   2. Simulate a grid of stop values in memory.
//   3. Split every result at one global date (default 70% through).
//   4. Pick the stop that scores best on the TRAIN window.
//   5. Report THAT stop's expectancy on the untouched TEST window.
//
// If the train-best stop still pays out on test, the edge is plausibly real.
// If test collapses, the in-sample number was curve-fit. Either answer is useful.
//
//   GET ?assetType=stock&splitFrac=0.7&stops=0.05,0.08,0.10,0.12,0.15&rMultiple=2
//       ?assetType=crypto&limit=25
//       &symbols=AAPL,MSFT,NVDA   (explicit list overrides universe)
// Auth: Authorization: Bearer ${CRON_SECRET}
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import {
  loadBacktestHistory, simulateWeeklyTrend, statsFromTrades, defaultParams,
  type BacktestAssetType, type BacktestParams, type BacktestTrade,
} from '@/app/lib/backtest/backtest-engine'
import { resolveUniverse } from '@/app/lib/backtest/portfolio-backtest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const VALID: BacktestAssetType[] = ['stock', 'crypto', 'forex', 'futures']
const DEFAULT_MAX_SYMBOLS = 15             // synchronous compute — bounded so the proxy doesn't cut us
const MIN_TRAIN_TRADES = 30   // don't trust a train pick made on too few trades

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker(): Promise<void> {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]) }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }

async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const url = new URL(req.url)

  const at = (url.searchParams.get('assetType') ?? 'stock').toLowerCase() as BacktestAssetType
  const assetType = VALID.includes(at) ? at : 'stock'
  const limit = Number(url.searchParams.get('limit') ?? '25')
  const maxSymbols = Math.max(1, Number(url.searchParams.get('maxSymbols') ?? String(DEFAULT_MAX_SYMBOLS)))
  const explicit = url.searchParams.get('symbols')
  const splitFrac = Math.min(0.9, Math.max(0.4, Number(url.searchParams.get('splitFrac') ?? '0.7')))
  const rMultiple = Number(url.searchParams.get('rMultiple') ?? '2')
  // ONE stop per call — the whole-grid version exceeds Railway's request window.
  // Run this 3x (e.g. 0.05/0.10/0.15) and compare train vs test across calls.
  const stopPct = Number(url.searchParams.get('stopPct') ?? '0.10')

  const base = defaultParams(assetType)
  const fixed: Partial<BacktestParams> = { rMultiple: Number.isFinite(rMultiple) ? rMultiple : base.rMultiple }
  for (const k of ['minStrength', 'horizonBars', 'maxHoldBars', 'warmupBars', 'stepBars', 'costBps', 'historyDays'] as const) {
    const raw = url.searchParams.get(k); if (raw == null) continue   // absent → keep default (Number(null) is 0, which would wrongly pass isFinite)
    const v = Number(raw); if (Number.isFinite(v)) (fixed as Record<string, number>)[k] = v
  }

  const resolved = await resolveUniverse(assetType, limit, explicit)
  const symbols = resolved.symbols.slice(0, maxSymbols)
  const label = resolved.label

  // Deterministic calendar split — independent of which stop is being run, so the
  // separate single-stop calls share the same train/test boundary and stay comparable.
  const historyDays = (fixed.historyDays as number) ?? base.historyDays
  const splitDate = new Date(Date.now() - (1 - splitFrac) * historyDays * 86_400_000).toISOString().split('T')[0]

  // Load + simulate per symbol; free each symbol's bars before the next.
  const concurrency = assetType === 'crypto' ? 2 : 5
  const pooled: BacktestTrade[] = []
  let tested = 0
  await mapLimited(symbols, concurrency, async (ticker) => {
    let bars
    try { bars = await loadBacktestHistory(ticker, assetType, historyDays) } catch { return }
    if (!bars || bars.length <= base.warmupBars + 40) return
    tested++
    pooled.push(...simulateWeeklyTrend(bars, { ...base, ...fixed, stopPct }))
  })

  const train = pooled.filter(t => t.entryDate < splitDate)
  const test = pooled.filter(t => t.entryDate >= splitDate)
  const trainStats = statsFromTrades(train)
  const testStats = statsFromTrades(test)

  return NextResponse.json({
    signal: 'weekly_trend', assetType, universe: label,
    stopPct, rMultiple: fixed.rMultiple, splitFrac, splitDate,
    symbolsRequested: symbols.length, symbolsTested: tested, totalTrades: pooled.length,
    train: {
      trades: train.length,
      bracketExpectancy: trainStats.bracket.expectancy, bracketWinRate: trainStats.bracket.winRate, bracketProfitFactor: trainStats.bracket.profitFactor,
      horizonExpectancy: trainStats.horizon.expectancy,
    },
    test: {
      trades: test.length,
      bracketExpectancy: testStats.bracket.expectancy, bracketWinRate: testStats.bracket.winRate, bracketProfitFactor: testStats.bracket.profitFactor,
      horizonExpectancy: testStats.horizon.expectancy,
    },
    note: train.length < MIN_TRAIN_TRADES
      ? `Thin train sample (${train.length} trades) — widen the universe or lower minStrength before trusting this.`
      : 'One stop, split at a fixed calendar date. Run several stops and pick the best TRAIN expectancy, then read its TEST. Bracket (net R) basis, long-only, costs applied.',
  })
}
