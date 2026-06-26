// =============================================================
// app/lib/backtest/backtest-engine.ts
//
// Signal backtester. Backtests deterministic discovery SIGNALS (not the Council —
// the Council's data bundle is point-in-time-contaminated and can't be replayed
// historically without lookahead leakage). The signals are pure functions of a
// Bar[] array, so "evaluate as of bar T" = call the real function on bars[0..T].
// The production code IS the backtest, so there's no model/reality drift.
//
// Two exit models, reported side by side:
//   bracket  — stop at stopPct, target at stopPct*rMultiple; pessimistic fill
//              (if one bar straddles both, assume STOP hit first)
//   horizon  — exit at a fixed number of bars after entry (return N bars later)
//
// Anti-lookahead: signal sees only bars<=T; entry is bars[T+1].open; exits use
// bars strictly after entry. Trades are non-overlapping (one position at a time).
// =============================================================

import type { Bar } from '@/app/lib/signals/technicals'
import { analyzeWeeklyTrend } from '@/app/lib/signals/weekly-trend'

export type BacktestAssetType = 'stock' | 'crypto' | 'forex' | 'futures'

export interface BacktestParams {
  minStrength: number    // signal strength floor to take a trade
  stopPct: number        // 1R in price terms (e.g. 0.05 = 5% stop)
  rMultiple: number      // target distance = rMultiple * stopPct
  horizonBars: number    // fixed-horizon lookforward
  maxHoldBars: number    // bracket timeout
  warmupBars: number     // bars reserved to warm the signal (~26 weeks)
  stepBars: number       // evaluation cadence (5 ≈ weekly on daily bars)
  costBps: number        // ONE-WAY cost (slippage+fee+spread) in bps; round-trip = 2x
  historyDays: number    // how deep to pull daily history (default ~10y)
}

const ASSET_COST_BPS: Record<BacktestAssetType, number> = { stock: 5, crypto: 15, forex: 2, futures: 5 }
// Crypto volatility blows through a 5% stop in hours; per-asset stop defaults.
const ASSET_STOP_PCT: Record<BacktestAssetType, number> = { stock: 0.05, crypto: 0.15, forex: 0.03, futures: 0.05 }

export function defaultParams(assetType: BacktestAssetType): BacktestParams {
  return {
    minStrength: 50, stopPct: ASSET_STOP_PCT[assetType], rMultiple: 2, horizonBars: 20,
    maxHoldBars: 60, warmupBars: 130, stepBars: 5, costBps: ASSET_COST_BPS[assetType],
    historyDays: 3650,
  }
}

// The weekly-trend read only uses the last ~26 weeks, so feed it a bounded daily
// window instead of the full (possibly decade-long) slice — keeps each evaluation
// O(window) regardless of history depth. Lookahead-safe: the window still ends at T.
const SIGNAL_WINDOW = 220   // daily bars ≈ 44 weeks

export interface BacktestTrade {
  entryDate: string
  entryPrice: number
  strength: number
  bracket: { outcome: 'target' | 'stop' | 'timeout'; exitPrice: number; barsHeld: number; netR: number }
  horizon: { exitPrice: number; barsHeld: number; netReturnPct: number }
}

export interface SideStats {
  winRate: number
  expectancy: number       // avg net R (bracket) or avg net % (horizon) per trade
  profitFactor: number
  maxDrawdown: number      // in R (bracket) or cumulative % (horizon)
  avgBarsHeld: number
}

export interface BacktestResult {
  ticker: string
  assetType: BacktestAssetType
  signal: 'weekly_trend'
  barsLoaded: number
  trades: number
  params: BacktestParams
  bracket: SideStats
  horizon: SideStats
  sampleTrades: BacktestTrade[]
  note: string
}

// ── History loader: deep chronological daily bars ──
async function loadDailyHistory(ticker: string, assetType: BacktestAssetType, historyDays: number): Promise<Bar[]> {
  let bars: Bar[]
  if (assetType === 'crypto') {
    bars = await loadCryptoDeep(ticker, historyDays)
  } else if (assetType === 'forex') {
    const { fetchForexBars } = await import('@/app/lib/data/forex')
    bars = (await fetchForexBars(ticker.toUpperCase(), '1M')) as unknown as Bar[]   // ~250 daily; deepening is a follow-up
  } else {
    const { fetchDailyBarsDeep } = await import('@/app/lib/data/alpaca')
    bars = (await fetchDailyBarsDeep(ticker.toUpperCase(), historyDays)) as unknown as Bar[]
  }
  return (bars ?? []).slice().sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
}

// Coinbase caps 300 candles/request; page backward to assemble deep daily history.
// Throttled + retried — bursting these (esp. across a portfolio sweep) trips 429.
async function loadCryptoDeep(ticker: string, historyDays: number): Promise<Bar[]> {
  const { fetchCryptoBars } = await import('@/app/lib/trading/crypto-bars')
  const { toCoinbaseProduct } = await import('@/app/lib/crypto-symbol')
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
  const product = toCoinbaseProduct(ticker)
  const DAY = 86_400
  const earliest = Math.floor(Date.now() / 1000) - historyDays * DAY
  let end = Math.floor(Date.now() / 1000)
  const all: Bar[] = []
  for (let i = 0; i < 25 && end > earliest; i++) {
    const start = Math.max(earliest, end - 300 * DAY)
    let chunk: Bar[] | null = null
    for (let attempt = 0; attempt < 3 && chunk === null; attempt++) {
      try { chunk = await fetchCryptoBars({ symbol: product, granularity: 'ONE_DAY', limit: 300, startUnix: start, endUnix: end }) }
      catch { await sleep(500 * (attempt + 1)) }   // backoff on 429/error
    }
    if (!chunk || !chunk.length) break
    all.push(...chunk)
    if (chunk.length < 200) break    // ran out of listing history
    end = start - DAY
    await sleep(180)                 // throttle between pages
  }
  const seen = new Set<string>()
  return all.filter(b => { if (seen.has(b.t)) return false; seen.add(b.t); return true })
}

function mean(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0 }

function maxDrawdown(perTrade: number[]): number {
  let cum = 0, peak = 0, dd = 0
  for (const v of perTrade) { cum += v; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum) }
  return dd
}

function sideStats(values: number[], barsHeld: number[]): SideStats {
  if (values.length === 0) return { winRate: 0, expectancy: 0, profitFactor: 0, maxDrawdown: 0, avgBarsHeld: 0 }
  const wins = values.filter(v => v > 0)
  const losses = values.filter(v => v <= 0)
  const grossWin = wins.reduce((s, x) => s + x, 0)
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x, 0))
  return {
    winRate: Math.round((wins.length / values.length) * 1000) / 10,
    expectancy: Math.round(mean(values) * 1000) / 1000,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? 999 : 0),
    maxDrawdown: Math.round(maxDrawdown(values) * 1000) / 1000,
    avgBarsHeld: Math.round(mean(barsHeld) * 10) / 10,
  }
}

/** Collect every (non-overlapping) trade the weekly-trend signal would have taken. */
/** Load deep daily history for a symbol (exported so sweeps can load once, simulate many param sets). */
export async function loadBacktestHistory(ticker: string, assetType: BacktestAssetType, historyDays = 3650): Promise<Bar[]> {
  return loadDailyHistory(ticker, assetType, historyDays)
}

/** Pure: simulate the weekly-trend signal over pre-loaded bars. Lookahead-free (slice ends at T). */
export function simulateWeeklyTrend(bars: Bar[], params: BacktestParams): BacktestTrade[] {
  const p = params
  const n = bars.length
  const costRT = 2 * p.costBps / 10_000   // round-trip fraction
  const trades: BacktestTrade[] = []
  let T = p.warmupBars

  while (T < n - 2) {
    const sig = analyzeWeeklyTrend(bars.slice(Math.max(0, T + 1 - SIGNAL_WINDOW), T + 1))
    const fires = sig.ok && sig.bias === 'bullish'
      && (sig.phase === 'accumulation' || sig.phase === 'markup')
      && sig.strength >= p.minStrength

    if (!fires) { T += p.stepBars; continue }

    const entryIdx = T + 1
    const entry = bars[entryIdx].o
    if (!(entry > 0)) { T += p.stepBars; continue }

    const stop = entry * (1 - p.stopPct)
    const target = entry * (1 + p.stopPct * p.rMultiple)

    // Bracket exit (pessimistic: stop checked before target)
    let bOutcome: 'target' | 'stop' | 'timeout' = 'timeout'
    let bExitPrice = entry
    let bBarsHeld = 0
    const lastBracketIdx = Math.min(entryIdx + p.maxHoldBars, n - 1)
    for (let j = entryIdx + 1; j <= lastBracketIdx; j++) {
      if (bars[j].l <= stop) { bOutcome = 'stop'; bExitPrice = stop; bBarsHeld = j - entryIdx; break }
      if (bars[j].h >= target) { bOutcome = 'target'; bExitPrice = target; bBarsHeld = j - entryIdx; break }
      if (j === lastBracketIdx) { bOutcome = 'timeout'; bExitPrice = bars[j].c; bBarsHeld = j - entryIdx }
    }
    const bNetR = ((bExitPrice - entry) / entry - costRT) / p.stopPct

    // Fixed-horizon exit
    const hIdx = Math.min(entryIdx + p.horizonBars, n - 1)
    const hExit = bars[hIdx].c
    const hNetPct = ((hExit - entry) / entry - costRT) * 100

    trades.push({
      entryDate: bars[entryIdx].t,
      entryPrice: Math.round(entry * 1e6) / 1e6,
      strength: sig.strength,
      bracket: { outcome: bOutcome, exitPrice: Math.round(bExitPrice * 1e6) / 1e6, barsHeld: bBarsHeld, netR: Math.round(bNetR * 1000) / 1000 },
      horizon: { exitPrice: Math.round(hExit * 1e6) / 1e6, barsHeld: hIdx - entryIdx, netReturnPct: Math.round(hNetPct * 100) / 100 },
    })

    T = entryIdx + Math.max(bBarsHeld, 1)   // non-overlapping
  }

  return trades
}

export async function collectWeeklyTrendTrades(
  ticker: string,
  assetType: BacktestAssetType,
  override: Partial<BacktestParams> = {},
): Promise<{ trades: BacktestTrade[]; barsLoaded: number; params: BacktestParams }> {
  const p = { ...defaultParams(assetType), ...override }
  const bars = await loadDailyHistory(ticker, assetType, p.historyDays)
  const trades = simulateWeeklyTrend(bars, p)
  return { trades, barsLoaded: bars.length, params: p }
}

/** Pooled bracket + horizon stats from a set of trades (works across symbols). */
export function statsFromTrades(trades: BacktestTrade[]): { bracket: SideStats; horizon: SideStats } {
  return {
    bracket: sideStats(trades.map(t => t.bracket.netR), trades.map(t => t.bracket.barsHeld)),
    horizon: sideStats(trades.map(t => t.horizon.netReturnPct), trades.map(t => t.horizon.barsHeld)),
  }
}

export async function runWeeklyTrendBacktest(
  ticker: string,
  assetType: BacktestAssetType,
  override: Partial<BacktestParams> = {},
): Promise<BacktestResult> {
  const { trades, barsLoaded, params } = await collectWeeklyTrendTrades(ticker, assetType, override)
  const { bracket, horizon } = statsFromTrades(trades)

  return {
    ticker: ticker.toUpperCase(), assetType, signal: 'weekly_trend',
    barsLoaded, trades: trades.length, params,
    bracket, horizon,
    sampleTrades: trades.slice(0, 15),
    note: barsLoaded < params.warmupBars + 40
      ? 'Limited history loaded; results are thin — extend the history loader for a fuller test.'
      : 'Backtest of the weekly-trend signal, long-only, non-overlapping, costs applied.',
  }
}
