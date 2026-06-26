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
const DEFAULT_STOPS = [0.05, 0.08, 0.10, 0.12, 0.15]
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
  const explicit = url.searchParams.get('symbols')
  const splitFrac = Math.min(0.9, Math.max(0.4, Number(url.searchParams.get('splitFrac') ?? '0.7')))
  const rMultiple = Number(url.searchParams.get('rMultiple') ?? '2')
  const stops = (url.searchParams.get('stops')?.split(',').map(Number).filter(s => s > 0 && s < 1)) || DEFAULT_STOPS

  const base = defaultParams(assetType)
  const fixed: Partial<BacktestParams> = { rMultiple: Number.isFinite(rMultiple) ? rMultiple : base.rMultiple }
  for (const k of ['minStrength', 'horizonBars', 'maxHoldBars', 'warmupBars', 'stepBars', 'costBps', 'historyDays'] as const) {
    const v = Number(url.searchParams.get(k)); if (Number.isFinite(v)) (fixed as Record<string, number>)[k] = v
  }

  const { symbols, label } = await resolveUniverse(assetType, limit, explicit)

  // 1. Load every symbol's deep history once (crypto pages Coinbase — keep gentle).
  const concurrency = assetType === 'crypto' ? 2 : 5
  const loaded = await mapLimited(symbols, concurrency, async (ticker) => {
    try { return { ticker, bars: await loadBacktestHistory(ticker, assetType, base.historyDays) } }
    catch { return { ticker, bars: [] } }
  })
  const usable = loaded.filter(l => l.bars.length > base.warmupBars + 40)

  // 2. Simulate the grid in memory; pool trades per stop across symbols.
  const perStop = new Map<number, BacktestTrade[]>()
  for (const stopPct of stops) {
    const params: BacktestParams = { ...base, ...fixed, stopPct }
    const pooled: BacktestTrade[] = []
    for (const { bars } of usable) pooled.push(...simulateWeeklyTrend(bars, params))
    perStop.set(stopPct, pooled)
  }

  // 3. One global split date from all trade entry-dates (so windows match across stops).
  const allDates = [...perStop.values()].flat().map(t => t.entryDate).sort()
  if (allDates.length < MIN_TRAIN_TRADES + 10) {
    return NextResponse.json({
      assetType, universe: label, symbolsTested: usable.length, totalTrades: allDates.length,
      error: 'Too few trades to split — widen the universe, lower minStrength, or deepen history.',
    })
  }
  const splitDate = allDates[Math.floor(allDates.length * splitFrac)]

  // 4. Per stop: split by date, score each window.
  const grid = stops.map(stopPct => {
    const trades = perStop.get(stopPct) ?? []
    const train = trades.filter(t => t.entryDate < splitDate)
    const test = trades.filter(t => t.entryDate >= splitDate)
    const trainStats = statsFromTrades(train)
    const testStats = statsFromTrades(test)
    return {
      stopPct, rMultiple: fixed.rMultiple,
      train: { trades: train.length, expectancy: trainStats.bracket.expectancy, winRate: trainStats.bracket.winRate, profitFactor: trainStats.bracket.profitFactor },
      test: { trades: test.length, expectancy: testStats.bracket.expectancy, winRate: testStats.bracket.winRate, profitFactor: testStats.bracket.profitFactor },
    }
  })

  // 5. Choose the stop that's best on TRAIN (with enough train trades); report its TEST result.
  const eligible = grid.filter(g => g.train.trades >= MIN_TRAIN_TRADES)
  const chosen = (eligible.length ? eligible : grid)
    .slice().sort((a, b) => b.train.expectancy - a.train.expectancy)[0]

  const honest = chosen
    ? (chosen.test.expectancy >= chosen.train.expectancy * 0.5 && chosen.test.expectancy > 0
        ? 'Test expectancy held up — the edge survives out-of-sample (still survivorship-biased; not yet point-in-time).'
        : 'Test expectancy collapsed vs train — the in-sample number was largely curve-fit. Treat the signal as unproven.')
    : 'No eligible stop met the minimum train-trade count.'

  return NextResponse.json({
    signal: 'weekly_trend', assetType, universe: label,
    symbolsRequested: symbols.length, symbolsTested: usable.length,
    splitFrac, splitDate, totalTrades: allDates.length,
    chosenStop: chosen ? {
      stopPct: chosen.stopPct, rMultiple: chosen.rMultiple,
      trainExpectancy: chosen.train.expectancy, trainTrades: chosen.train.trades,
      testExpectancy: chosen.test.expectancy, testTrades: chosen.test.trades,
      testWinRate: chosen.test.winRate, testProfitFactor: chosen.test.profitFactor,
    } : null,
    grid,
    verdict: honest,
    note: 'Stop chosen on the train window only; headline figure is its expectancy on the untouched test window. Bracket (net R) basis, long-only, costs applied.',
  })
}
