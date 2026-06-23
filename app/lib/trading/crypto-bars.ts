// =============================================================
// app/lib/trading/crypto-bars.ts
//
// Fetches OHLCV candles from Coinbase Advanced Trade API and
// converts them to the SAME Bar shape used by the stocks pipeline,
// so the existing `calculateTechnicals()` engine in technicals.ts
// works identically on crypto.
//
// This gives crypto FULL signal parity with stocks:
//   - SMA 20/50/200, EMA 9/20/12/26
//   - MACD (12, 26, 9)
//   - RSI(14), Stochastic(14,3,3), Williams %R, CCI
//   - Bollinger Bands (20, 2σ)
//   - VWAP, OBV (with divergence)
//   - Volume ratio
//   - Support/Resistance, Fibonacci, Golden Zone
//   - ATR(14), ROC, Ichimoku, Williams %R, CCI
//   - Candle patterns, chart patterns, gap detection, trend lines
//   - Composite technicalScore -100..+100 and technicalBias
//
// Coinbase endpoint:
//   GET /api/v3/brokerage/market/products/{product_id}/candles
//   Granularity: ONE_MINUTE, FIVE_MINUTE, FIFTEEN_MINUTE, THIRTY_MINUTE,
//                ONE_HOUR, TWO_HOUR, SIX_HOUR, ONE_DAY
//   Max 300 candles per call.
// =============================================================

import { calculateTechnicals, type Bar, type TechnicalSignals } from '@/app/lib/signals/technicals'

const COINBASE_PUBLIC_BASE = 'https://api.coinbase.com/api/v3/brokerage'

export type CryptoGranularity =
  | 'ONE_MINUTE' | 'FIVE_MINUTE' | 'FIFTEEN_MINUTE' | 'THIRTY_MINUTE'
  | 'ONE_HOUR' | 'TWO_HOUR' | 'SIX_HOUR' | 'ONE_DAY'

export interface FetchBarsOptions {
  symbol: string              // e.g. "BTC-USD"
  granularity: CryptoGranularity
  limit?: number              // default 100, max 300
  startUnix?: number          // epoch seconds
  endUnix?: number            // epoch seconds; default now
}

const GRANULARITY_SECONDS: Record<CryptoGranularity, number> = {
  ONE_MINUTE: 60,
  FIVE_MINUTE: 300,
  FIFTEEN_MINUTE: 900,
  THIRTY_MINUTE: 1800,
  ONE_HOUR: 3600,
  TWO_HOUR: 7200,
  SIX_HOUR: 21600,
  ONE_DAY: 86400,
}

/**
 * Fetch OHLCV bars from Coinbase. Returns bars in the SAME shape as
 * stocks Bar interface so calculateTechnicals() consumes them directly.
 *
 * Bars are returned oldest-first (ascending by time).
 */
export async function fetchCryptoBars(opts: FetchBarsOptions): Promise<Bar[]> {
  const limit = Math.min(300, Math.max(1, opts.limit ?? 100))
  const granSec = GRANULARITY_SECONDS[opts.granularity]
  const endUnix = opts.endUnix ?? Math.floor(Date.now() / 1000)
  const startUnix = opts.startUnix ?? (endUnix - granSec * limit)

  const url = `${COINBASE_PUBLIC_BASE}/market/products/${encodeURIComponent(opts.symbol)}/candles` +
    `?start=${startUnix}&end=${endUnix}&granularity=${opts.granularity}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'cache-control': 'no-cache' },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Coinbase candles HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = await res.json() as { candles?: Array<Record<string, unknown>> }
    if (!data.candles || !Array.isArray(data.candles)) {
      throw new Error(`Coinbase candles malformed response`)
    }
    // Coinbase v3 candles: { start: "1697040000", low, high, open, close, volume } — strings
    // Convert to stocks Bar shape: { t (ISO), o, h, l, c, v }
    const bars: Bar[] = data.candles.map(c => {
      const unixSeconds = Number(c.start ?? 0)
      return {
        t: new Date(unixSeconds * 1000).toISOString(),
        o: Number(c.open ?? 0),
        h: Number(c.high ?? 0),
        l: Number(c.low ?? 0),
        c: Number(c.close ?? 0),
        v: Number(c.volume ?? 0),
      }
    })
    // Sort oldest-first (Coinbase typically returns newest-first)
    bars.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
    return bars
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One-call helper: fetch bars + compute full technicals.
 * Identical signal output to stocks.
 */
export async function fetchCryptoTechnicals(
  opts: FetchBarsOptions,
): Promise<{ bars: Bar[]; technicals: TechnicalSignals }> {
  const bars = await fetchCryptoBars(opts)
  const technicals = calculateTechnicals(bars)
  return { bars, technicals }
}

// ─────────────────────────────────────────────────────────────
// Signal counting wrapper for position-monitor compatibility.
//
// Returns a simple bullish/bearish count for quick exit decisions,
// derived from the FULL technicals signals. This mirrors the
// counting approach used in the stock position-monitor v3.
// ─────────────────────────────────────────────────────────────

export interface CryptoSignalCounts {
  bullishCount: number
  bearishCount: number
  unanimousBullish: boolean
  technicalScore: number       // -100 to +100
  technicalBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  individualSignals: Array<{ name: string; direction: 'bullish' | 'bearish' | 'neutral'; detail: string }>
}

/**
 * Convert TechnicalSignals into bullish/bearish counts.
 *
 * Each of these is counted as a single bullish or bearish signal:
 *   - EMA9 vs EMA20 alignment + cross
 *   - MACD histogram direction + crossover
 *   - RSI overbought/oversold/momentum
 *   - Stochastic + crossover
 *   - Bollinger position
 *   - VWAP relationship
 *   - OBV trend + divergence
 *   - Volume confirmation
 *   - Williams %R
 *   - CCI
 *   - Ichimoku cloud position + TK cross
 *   - ROC momentum acceleration
 *
 * "Unanimous bullish" requires technicalScore >= 50 (very strong bull).
 */
export function computeCryptoSignals(bars: Bar[]): CryptoSignalCounts {
  if (bars.length < 20) {
    return {
      bullishCount: 0, bearishCount: 0, unanimousBullish: false,
      technicalScore: 0, technicalBias: 'NEUTRAL', individualSignals: [],
    }
  }
  const t = calculateTechnicals(bars)
  const signals: Array<{ name: string; direction: 'bullish' | 'bearish' | 'neutral'; detail: string }> = []

  // 1. EMA stack
  if (t.ema9CrossEma20 === 'bullish') {
    signals.push({ name: 'ema_cross', direction: 'bullish', detail: 'EMA9 crossed above EMA20' })
  } else if (t.ema9CrossEma20 === 'bearish') {
    signals.push({ name: 'ema_cross', direction: 'bearish', detail: 'EMA9 crossed below EMA20' })
  } else if (t.ema9 > t.ema20 && t.currentPrice > t.ema9) {
    signals.push({ name: 'ema_stack', direction: 'bullish', detail: `Price > EMA9 > EMA20 (bull stack)` })
  } else if (t.ema9 < t.ema20 && t.currentPrice < t.ema9) {
    signals.push({ name: 'ema_stack', direction: 'bearish', detail: `Price < EMA9 < EMA20 (bear stack)` })
  } else {
    signals.push({ name: 'ema_stack', direction: 'neutral', detail: 'mixed EMA alignment' })
  }

  // 2. MACD
  if (t.macdCrossover === 'bullish' || (t.macdHistogram > 0 && t.macdLine > t.macdSignal)) {
    signals.push({ name: 'macd', direction: 'bullish', detail: `MACD bullish (hist=${t.macdHistogram.toFixed(3)})` })
  } else if (t.macdCrossover === 'bearish' || (t.macdHistogram < 0 && t.macdLine < t.macdSignal)) {
    signals.push({ name: 'macd', direction: 'bearish', detail: `MACD bearish (hist=${t.macdHistogram.toFixed(3)})` })
  } else {
    signals.push({ name: 'macd', direction: 'neutral', detail: 'MACD mixed' })
  }

  // 3. RSI
  if (t.rsi > 55 && t.rsi < 70) {
    signals.push({ name: 'rsi', direction: 'bullish', detail: `RSI=${t.rsi.toFixed(1)} bullish momentum` })
  } else if (t.rsi < 45 && t.rsi > 30) {
    signals.push({ name: 'rsi', direction: 'bearish', detail: `RSI=${t.rsi.toFixed(1)} bearish momentum` })
  } else if (t.rsi >= 70) {
    signals.push({ name: 'rsi', direction: 'bearish', detail: `RSI=${t.rsi.toFixed(1)} overbought (fade)` })
  } else if (t.rsi <= 30) {
    signals.push({ name: 'rsi', direction: 'bullish', detail: `RSI=${t.rsi.toFixed(1)} oversold (bounce)` })
  } else {
    signals.push({ name: 'rsi', direction: 'neutral', detail: `RSI=${t.rsi.toFixed(1)} neutral` })
  }

  // 4. Stochastic
  if (t.stochCrossover === 'bullish') {
    signals.push({ name: 'stoch', direction: 'bullish', detail: `Stoch bullish cross %K=${t.stochK.toFixed(1)}` })
  } else if (t.stochCrossover === 'bearish') {
    signals.push({ name: 'stoch', direction: 'bearish', detail: `Stoch bearish cross %K=${t.stochK.toFixed(1)}` })
  } else if (t.stochSignal === 'oversold') {
    signals.push({ name: 'stoch', direction: 'bullish', detail: `Stoch oversold %K=${t.stochK.toFixed(1)}` })
  } else if (t.stochSignal === 'overbought') {
    signals.push({ name: 'stoch', direction: 'bearish', detail: `Stoch overbought %K=${t.stochK.toFixed(1)}` })
  } else {
    signals.push({ name: 'stoch', direction: 'neutral', detail: `Stoch neutral %K=${t.stochK.toFixed(1)}` })
  }

  // 5. Bollinger Bands
  if (t.bbPosition > 0.8) {
    signals.push({ name: 'bb', direction: 'bearish', detail: `Price near upper band (${(t.bbPosition*100).toFixed(0)}%)` })
  } else if (t.bbPosition < 0.2) {
    signals.push({ name: 'bb', direction: 'bullish', detail: `Price near lower band (${(t.bbPosition*100).toFixed(0)}%)` })
  } else if (t.bbSignal === 'squeeze') {
    signals.push({ name: 'bb', direction: 'neutral', detail: 'BB squeeze (consolidation)' })
  } else {
    signals.push({ name: 'bb', direction: 'neutral', detail: `BB position ${(t.bbPosition*100).toFixed(0)}%` })
  }

  // 6. VWAP
  if (t.vwapSignal === 'above' && t.priceVsVwap > 0.2) {
    signals.push({ name: 'vwap', direction: 'bullish', detail: `Price ${t.priceVsVwap.toFixed(2)}% above VWAP` })
  } else if (t.vwapSignal === 'below' && t.priceVsVwap < -0.2) {
    signals.push({ name: 'vwap', direction: 'bearish', detail: `Price ${t.priceVsVwap.toFixed(2)}% below VWAP` })
  } else {
    signals.push({ name: 'vwap', direction: 'neutral', detail: 'Near VWAP' })
  }

  // 7. OBV
  if (t.obvDivergence === 'bullish' || (t.obvTrend === 'rising' && t.obvDivergence === 'none')) {
    signals.push({ name: 'obv', direction: 'bullish', detail: `OBV ${t.obvTrend}${t.obvDivergence !== 'none' ? ' + divergence' : ''}` })
  } else if (t.obvDivergence === 'bearish' || (t.obvTrend === 'falling' && t.obvDivergence === 'none')) {
    signals.push({ name: 'obv', direction: 'bearish', detail: `OBV ${t.obvTrend}${t.obvDivergence !== 'none' ? ' + divergence' : ''}` })
  } else {
    signals.push({ name: 'obv', direction: 'neutral', detail: `OBV ${t.obvTrend}` })
  }

  // 8. Williams %R (Wilder's overbought/oversold)
  if (t.williamsSignal === 'oversold') {
    signals.push({ name: 'williamsR', direction: 'bullish', detail: `Williams %R=${t.williamsR.toFixed(1)} oversold` })
  } else if (t.williamsSignal === 'overbought') {
    signals.push({ name: 'williamsR', direction: 'bearish', detail: `Williams %R=${t.williamsR.toFixed(1)} overbought` })
  } else {
    signals.push({ name: 'williamsR', direction: 'neutral', detail: `Williams %R=${t.williamsR.toFixed(1)}` })
  }

  // 9. CCI
  if (t.cci > 100) {
    signals.push({ name: 'cci', direction: 'bullish', detail: `CCI=${t.cci.toFixed(0)} strong momentum` })
  } else if (t.cci < -100) {
    signals.push({ name: 'cci', direction: 'bearish', detail: `CCI=${t.cci.toFixed(0)} weak momentum` })
  } else {
    signals.push({ name: 'cci', direction: 'neutral', detail: `CCI=${t.cci.toFixed(0)}` })
  }

  // 10. Ichimoku
  if (t.ichimokuCross === 'bullish' || (t.ichimokuSignal === 'above_cloud' && t.ichimokuTenkan > t.ichimokuKijun)) {
    signals.push({ name: 'ichimoku', direction: 'bullish', detail: `Ichimoku ${t.ichimokuSignal}` })
  } else if (t.ichimokuCross === 'bearish' || (t.ichimokuSignal === 'below_cloud' && t.ichimokuTenkan < t.ichimokuKijun)) {
    signals.push({ name: 'ichimoku', direction: 'bearish', detail: `Ichimoku ${t.ichimokuSignal}` })
  } else {
    signals.push({ name: 'ichimoku', direction: 'neutral', detail: `Ichimoku ${t.ichimokuSignal}` })
  }

  // 11. ROC momentum
  if (t.rocSignal === 'accelerating' && t.roc10 > 0) {
    signals.push({ name: 'roc', direction: 'bullish', detail: `ROC accelerating (10p=${t.roc10.toFixed(2)}%)` })
  } else if (t.rocSignal === 'decelerating' || t.roc10 < -1) {
    signals.push({ name: 'roc', direction: 'bearish', detail: `ROC weakening (10p=${t.roc10.toFixed(2)}%)` })
  } else {
    signals.push({ name: 'roc', direction: 'neutral', detail: `ROC=${t.roc10.toFixed(2)}%` })
  }

  // 12. Candle pattern
  if (t.candlePattern) {
    signals.push({
      name: 'candle_pattern',
      direction: t.candlePattern.type === 'bullish' ? 'bullish' : t.candlePattern.type === 'bearish' ? 'bearish' : 'neutral',
      detail: `${t.candlePattern.name} (${t.candlePattern.strength})`,
    })
  }

  // 13. Chart pattern
  if (t.chartPattern) {
    signals.push({
      name: 'chart_pattern',
      direction: t.chartPattern.type === 'bullish' ? 'bullish' : t.chartPattern.type === 'bearish' ? 'bearish' : 'neutral',
      detail: `${t.chartPattern.name} (${t.chartPattern.confidence})`,
    })
  }

  const bullishCount = signals.filter(s => s.direction === 'bullish').length
  const bearishCount = signals.filter(s => s.direction === 'bearish').length
  const unanimousBullish = t.technicalScore >= 50

  return {
    bullishCount,
    bearishCount,
    unanimousBullish,
    technicalScore: t.technicalScore,
    technicalBias: t.technicalBias,
    individualSignals: signals,
  }
}
