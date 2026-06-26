// =============================================================
// app/lib/backtest/portfolio-backtest.ts
//
// Sweep the weekly-trend signal across a whole universe and POOL every trade into
// one expectancy figure. A single symbol yields too few trades to mean anything;
// the portfolio number (hundreds of trades across names) is the real read on edge.
// =============================================================

import {
  collectWeeklyTrendTrades, statsFromTrades, defaultParams,
  type BacktestAssetType, type BacktestParams, type SideStats,
} from '@/app/lib/backtest/backtest-engine'

export interface PerSymbolSummary {
  ticker: string
  trades: number
  bracketExpectancy: number
  bracketWinRate: number
  horizonExpectancy: number
}

export interface PortfolioBacktestResult {
  signal: 'weekly_trend'
  assetType: BacktestAssetType
  universe: string
  params: BacktestParams
  symbolsRequested: number
  symbolsTested: number
  totalTrades: number
  bracket: SideStats          // pooled across all symbols/trades
  horizon: SideStats          // pooled across all symbols/trades
  perSymbol: PerSymbolSummary[]
  failures: Array<{ ticker: string; reason: string }>
  note: string
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

export async function runPortfolioBacktest(args: {
  symbols: string[]
  assetType: BacktestAssetType
  universe: string
  override?: Partial<BacktestParams>
  concurrency?: number
}): Promise<PortfolioBacktestResult> {
  const { symbols, assetType, universe } = args
  const params = { ...defaultParams(assetType), ...(args.override ?? {}) }
  const concurrency = args.concurrency ?? 5

  type Outcome =
    | { ok: true; ticker: string; trades: ReturnType<typeof statsFromTrades> extends never ? never : Awaited<ReturnType<typeof collectWeeklyTrendTrades>>['trades'] }
    | { ok: false; ticker: string; reason: string }

  const results = await mapLimited<string, Outcome>(symbols, concurrency, async (ticker) => {
    try {
      const { trades } = await collectWeeklyTrendTrades(ticker, assetType, params)
      return { ok: true, ticker, trades }
    } catch (e) {
      return { ok: false, ticker, reason: e instanceof Error ? e.message : String(e) }
    }
  })

  const pooled = [] as Awaited<ReturnType<typeof collectWeeklyTrendTrades>>['trades']
  const perSymbol: PerSymbolSummary[] = []
  const failures: Array<{ ticker: string; reason: string }> = []
  let symbolsTested = 0

  for (const r of results) {
    if (!r.ok) { failures.push({ ticker: r.ticker, reason: r.reason }); continue }
    symbolsTested++
    if (r.trades.length === 0) continue
    pooled.push(...r.trades)
    const s = statsFromTrades(r.trades)
    perSymbol.push({
      ticker: r.ticker.toUpperCase(),
      trades: r.trades.length,
      bracketExpectancy: s.bracket.expectancy,
      bracketWinRate: s.bracket.winRate,
      horizonExpectancy: s.horizon.expectancy,
    })
  }

  perSymbol.sort((a, b) => b.bracketExpectancy - a.bracketExpectancy)
  const { bracket, horizon } = statsFromTrades(pooled)

  return {
    signal: 'weekly_trend', assetType, universe, params,
    symbolsRequested: symbols.length,
    symbolsTested,
    totalTrades: pooled.length,
    bracket, horizon, perSymbol, failures,
    note: pooled.length < 50
      ? `Only ${pooled.length} pooled trades — still too few to conclude; widen the universe or deepen history.`
      : `Pooled ${pooled.length} trades across ${symbolsTested} symbols. bracket.expectancy is the headline edge figure (avg net R/trade). Pooled maxDrawdown ignores cross-symbol timing — treat as rough.`,
  }
}
