// =============================================================
// app/lib/signals/timeframe-selector.ts
//
// Preliminary "chart read" that picks the best analysis horizon (1D / 1W / 1M)
// for a ticker BEFORE the expensive Council runs. The pipeline already maps each
// timeframe to a distinct resolution across every asset class:
//     1D -> 15-min   |   1W -> 1-hour   |   1M -> daily
// so we just pull the ticker at all three, score how clean/strong the tradeable
// structure looks on each chart, and hand the Council the winner.
//
//   selectTimeframe('SOLUSD', 'crypto') -> { timeframe:'1D', confidence, scores, rationale }
// =============================================================

import type { Bar } from '@/app/lib/signals/technicals'
import type { WeeklyTrendAssetType } from '@/app/lib/signals/weekly-trend'

export type Timeframe = '1D' | '1W' | '1M'
export type SelectorAssetType = WeeklyTrendAssetType   // 'stock' | 'crypto' | 'futures' | 'forex'

export interface TimeframeRead {
  ticker: string
  assetType: SelectorAssetType
  timeframe: Timeframe
  confidence: number                  // 0..100 — margin of the winner over the runner-up
  scores: Record<Timeframe, number>   // setup-quality score per horizon
  directions: Record<Timeframe, 'up' | 'down' | 'flat'>
  rationale: string
}

const ALL_TF: Timeframe[] = ['1D', '1W', '1M']

function avg(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0 }

// Linear-regression slope of y over its index, normalized to %/bar of mean price.
function normSlope(closes: number[]): number {
  const n = closes.length
  if (n < 3) return 0
  const mx = (n - 1) / 2
  const my = avg(closes)
  let num = 0, den = 0
  for (let i = 0; i < n; i++) { num += (i - mx) * (closes[i] - my); den += (i - mx) ** 2 }
  const slope = den > 0 ? num / den : 0
  return my > 0 ? (slope / my) * 100 : 0      // % of price per bar
}

/**
 * Score how clean and actionable the directional structure is on one chart
 * (resolution-agnostic — same fn for 15-min, hourly, or daily bars).
 */
function scoreChart(bars: Bar[], assetType: SelectorAssetType): { score: number; direction: 'up' | 'down' | 'flat' } {
  if (!bars || bars.length < 30) return { score: 0, direction: 'flat' }
  const b = bars.slice(-Math.min(80, bars.length))
  const closes = b.map(x => x.c)
  const last = closes[closes.length - 1]

  // 1) Trend: regression-implied move OVER the window (honest magnitude, not %/bar)
  const slope = normSlope(closes)                          // %/bar
  const trendMovePct = Math.abs(slope) * closes.length     // ~ total drift across the window
  const trendScore = Math.min(35, trendMovePct * (assetType === 'forex' ? 30 : 2.5))
  const direction: 'up' | 'down' | 'flat' = slope > 0.0005 ? 'up' : slope < -0.0005 ? 'down' : 'flat'

  // 2) Directional consistency: fraction of bars moving with the trend
  let withTrend = 0
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    if ((slope >= 0 && d >= 0) || (slope < 0 && d < 0)) withTrend++
  }
  const consistency = withTrend / (closes.length - 1)              // 0..1
  const consistencyScore = Math.min(20, Math.max(0, (consistency - 0.5) * 50))

  // 3) Momentum: move over the last ~15% of the window, aligned with trend
  const ref = closes[Math.floor(closes.length * 0.85)] ?? closes[0]
  const momPct = ref > 0 ? ((last - ref) / ref) * 100 : 0
  const momAligned = (slope >= 0 ? momPct : -momPct)
  const momScore = Math.min(20, Math.max(0, momAligned * (assetType === 'forex' ? 60 : 4)))

  // 4) Breakout: last close beyond the prior range edge (excl. last 2 bars)
  const priorHigh = Math.max(...b.slice(0, -2).map(x => x.h))
  const priorLow = Math.min(...b.slice(0, -2).map(x => x.l))
  const breakout = last > priorHigh || last < priorLow
  const breakoutScore = breakout ? 15 : 0

  // 5) Volume confirmation (skip forex tick-volume); drop dead extended-hours bars
  let volScore = 0
  if (assetType !== 'forex') {
    const live = b.filter(x => (x.v ?? 0) > 0)
    if (live.length >= 24) {
      const recentVol = avg(live.slice(-4).map(x => x.v ?? 0))
      const baseVol = avg(live.slice(-24, -4).map(x => x.v ?? 0))
      const rvol = baseVol > 0 ? Math.min(recentVol / baseVol, 20) : 1
      volScore = Math.min(10, Math.max(0, (rvol - 1)) * 10)
    }
  }

  const score = Math.round(Math.max(0, Math.min(100, trendScore + consistencyScore + momScore + breakoutScore + volScore)))
  return { score, direction }
}

// ── Per-asset, per-timeframe bar fetch (reuses the pipeline's own mappings) ──
async function barsAt(ticker: string, assetType: SelectorAssetType, tf: Timeframe): Promise<Bar[]> {
  if (assetType === 'crypto') {
    const { fetchCryptoBars } = await import('@/app/lib/trading/crypto-bars')
    const { toCoinbaseProduct } = await import('@/app/lib/crypto-symbol')
    const gran = tf === '1D' ? 'FIFTEEN_MINUTE' : tf === '1W' ? 'ONE_HOUR' : 'ONE_DAY'
    const limit = tf === '1M' ? 200 : tf === '1W' ? 200 : 120
    return fetchCryptoBars({ symbol: toCoinbaseProduct(ticker), granularity: gran, limit }) as unknown as Bar[]
  }
  if (assetType === 'forex') {
    const { fetchForexBars } = await import('@/app/lib/data/forex')
    return (await fetchForexBars(ticker.toUpperCase(), tf)) as unknown as Bar[]
  }
  // stock + futures proxies
  const { fetchBars } = await import('@/app/lib/data/alpaca')
  return (await fetchBars(ticker.toUpperCase(), tf)) as unknown as Bar[]
}

/**
 * Read the chart at all three horizons and return the best one for the Council.
 * Falls back gracefully: a horizon that can't be fetched simply scores 0.
 */
export async function selectTimeframe(
  ticker: string,
  assetType: SelectorAssetType,
  opts: { fallback?: Timeframe } = {},
): Promise<TimeframeRead> {
  const scores: Record<Timeframe, number> = { '1D': 0, '1W': 0, '1M': 0 }
  const directions: Record<Timeframe, 'up' | 'down' | 'flat'> = { '1D': 'flat', '1W': 'flat', '1M': 'flat' }

  await Promise.all(ALL_TF.map(async (tf) => {
    try {
      const r = scoreChart(await barsAt(ticker, assetType, tf), assetType)
      scores[tf] = r.score; directions[tf] = r.direction
    } catch { /* leave at 0 */ }
  }))

  // Rank; tie-break toward the swing default (1W), then 1D, then 1M.
  const order: Timeframe[] = ['1W', '1D', '1M']
  const ranked = [...ALL_TF].sort((a, b) => scores[b] - scores[a] || order.indexOf(a) - order.indexOf(b))
  const top = ranked[0], second = ranked[1]

  const fallback = opts.fallback ?? '1W'
  let chosen: Timeframe = top
  // If everything is weak/flat, don't pretend — use the safe default.
  if (scores[top] < 20) chosen = fallback
  const confidence = Math.max(0, Math.min(100, scores[top] - scores[second]))

  const horizonWord: Record<Timeframe, string> = { '1D': 'intraday/day', '1W': 'swing', '1M': 'position' }
  const rationale = scores[top] < 20
    ? `No clear structure on any horizon (1D ${scores['1D']}, 1W ${scores['1W']}, 1M ${scores['1M']}); defaulting to ${horizonWord[fallback]} (${fallback}).`
    : `Best structure on ${chosen} (${horizonWord[chosen]}, ${directions[chosen]}) — score ${scores[chosen]} vs 1D ${scores['1D']} / 1W ${scores['1W']} / 1M ${scores['1M']}.`

  return { ticker: ticker.toUpperCase(), assetType, timeframe: chosen, confidence, scores, directions, rationale }
}
