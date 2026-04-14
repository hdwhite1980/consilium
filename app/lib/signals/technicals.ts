// ─────────────────────────────────────────────────────────────
// PHASE 1 — Technical Indicators
// All calculated from raw OHLCV bars. Zero extra API calls.
// ─────────────────────────────────────────────────────────────

export interface Bar {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface TechnicalSignals {
  // Price
  currentPrice: number
  priceChange1D: number   // %
  priceChangePeriod: number // %
  high52w: number
  low52w: number
  distFromHigh: number    // % below 52w high
  distFromLow: number     // % above 52w low

  // Moving averages
  sma20: number
  sma50: number
  sma200: number
  ema12: number
  ema26: number
  priceVsSma20: number    // % above/below
  priceVsSma50: number
  priceVsSma200: number
  goldenCross: boolean    // sma50 > sma200
  deathCross: boolean     // sma50 < sma200

  // RSI (14)
  rsi: number
  rsiSignal: 'oversold' | 'overbought' | 'neutral'

  // MACD (12,26,9)
  macdLine: number
  macdSignal: number
  macdHistogram: number
  macdCrossover: 'bullish' | 'bearish' | 'none'

  // Bollinger Bands (20, 2σ)
  bbUpper: number
  bbMiddle: number
  bbLower: number
  bbWidth: number         // (upper-lower)/middle — volatility measure
  bbPosition: number      // 0-1 where price sits in the band
  bbSignal: 'squeeze' | 'expansion' | 'normal'

  // Volume
  avgVolume20: number
  lastVolume: number
  volumeRatio: number     // lastVolume / avgVolume
  volumeSignal: 'high' | 'low' | 'normal'

  // Support / Resistance (simple pivot)
  support: number
  resistance: number

  // Overall technical score -100 to +100
  technicalScore: number
  technicalBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'

  // Human readable summary
  summary: string
}

// ── SMA ───────────────────────────────────────────────────────
function sma(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0
  const slice = closes.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

// ── EMA ───────────────────────────────────────────────────────
function ema(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0
  const k = 2 / (period + 1)
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < closes.length; i++) {
    val = closes[i] * k + val * (1 - k)
  }
  return val
}

// ── RSI (14) ──────────────────────────────────────────────────
function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  let gains = 0, losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff
    else losses -= diff
  }
  let avgGain = gains / period
  let avgLoss = losses / period
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period
  }
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

// ── MACD (12, 26, 9) ──────────────────────────────────────────
function macd(closes: number[]): { line: number; signal: number; histogram: number } {
  const ema12 = ema(closes, 12)
  const ema26 = ema(closes, 26)
  const line = ema12 - ema26
  // Signal = 9-period EMA of MACD line (approximate)
  const macdValues: number[] = []
  for (let i = 26; i <= closes.length; i++) {
    const e12 = ema(closes.slice(0, i), 12)
    const e26 = ema(closes.slice(0, i), 26)
    macdValues.push(e12 - e26)
  }
  const signalLine = ema(macdValues, 9)
  return { line, signal: signalLine, histogram: line - signalLine }
}

// ── Bollinger Bands (20, 2σ) ──────────────────────────────────
function bollingerBands(closes: number[], period = 20): { upper: number; middle: number; lower: number } {
  const middle = sma(closes, period)
  const slice = closes.slice(-period)
  const variance = slice.reduce((s, c) => s + Math.pow(c - middle, 2), 0) / period
  const stddev = Math.sqrt(variance)
  return { upper: middle + 2 * stddev, middle, lower: middle - 2 * stddev }
}

// ── Pivot Support / Resistance ────────────────────────────────
function pivotLevels(bars: Bar[]): { support: number; resistance: number } {
  const recent = bars.slice(-20)
  const highs = recent.map(b => b.h)
  const lows = recent.map(b => b.l)
  const pivot = (Math.max(...highs) + Math.min(...lows) + recent[recent.length - 1].c) / 3
  return {
    resistance: 2 * pivot - Math.min(...lows),
    support: 2 * pivot - Math.max(...highs),
  }
}

// ── Main Calculator ───────────────────────────────────────────
export function calculateTechnicals(bars: Bar[]): TechnicalSignals {
  if (!bars.length) return emptyTechnicals()

  const closes = bars.map(b => b.c)
  const volumes = bars.map(b => b.v)
  const current = closes[closes.length - 1]
  const prev = closes[closes.length - 2] ?? current
  const first = closes[0]

  // Price stats
  const priceChange1D = ((current - prev) / prev) * 100
  const priceChangePeriod = ((current - first) / first) * 100
  const high52w = Math.max(...bars.map(b => b.h))
  const low52w = Math.min(...bars.map(b => b.l))
  const distFromHigh = ((high52w - current) / high52w) * 100
  const distFromLow = ((current - low52w) / low52w) * 100

  // Moving averages
  const s20 = sma(closes, Math.min(20, closes.length))
  const s50 = sma(closes, Math.min(50, closes.length))
  const s200 = sma(closes, Math.min(200, closes.length))
  const e12 = ema(closes, Math.min(12, closes.length))
  const e26 = ema(closes, Math.min(26, closes.length))

  // RSI
  const rsiVal = rsi(closes)
  const rsiSignal = rsiVal >= 70 ? 'overbought' : rsiVal <= 30 ? 'oversold' : 'neutral'

  // MACD
  const { line: macdLine, signal: macdSig, histogram: macdHist } = macd(closes)
  const prevMacdHist = closes.length > 2 ? (() => {
    const { histogram } = macd(closes.slice(0, -1))
    return histogram
  })() : 0
  const macdCrossover = macdHist > 0 && prevMacdHist <= 0 ? 'bullish'
    : macdHist < 0 && prevMacdHist >= 0 ? 'bearish' : 'none'

  // Bollinger
  const { upper: bbU, middle: bbM, lower: bbL } = bollingerBands(closes)
  const bbWidth = (bbU - bbL) / bbM
  const bbPosition = (current - bbL) / (bbU - bbL)
  const bbSignal = bbWidth < 0.05 ? 'squeeze' : bbWidth > 0.15 ? 'expansion' : 'normal'

  // Volume
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length)
  const lastVol = volumes[volumes.length - 1]
  const volRatio = lastVol / avgVol
  const volumeSignal = volRatio > 1.5 ? 'high' : volRatio < 0.5 ? 'low' : 'normal'

  // Pivot levels
  const { support, resistance } = pivotLevels(bars)

  // ── Score: -100 to +100 ───────────────────────────────────
  let score = 0
  // Trend (40 pts)
  if (current > s50) score += 15
  else score -= 15
  if (current > s200) score += 15
  else score -= 15
  if (s50 > s200) score += 10
  else score -= 10
  // Momentum (30 pts)
  if (rsiVal > 50 && rsiVal < 70) score += 15
  else if (rsiVal >= 70) score += 5
  else if (rsiVal < 50 && rsiVal > 30) score -= 10
  else score -= 20
  if (macdHist > 0) score += 15
  else score -= 15
  // Volume (15 pts)
  if (priceChange1D > 0 && volumeSignal === 'high') score += 15
  else if (priceChange1D < 0 && volumeSignal === 'high') score -= 15
  else score += 0
  // Bollinger (15 pts)
  if (bbPosition > 0.6 && bbPosition < 0.9) score += 10
  else if (bbPosition >= 0.9) score -= 5
  else if (bbPosition < 0.2) score -= 10
  if (bbSignal === 'squeeze') score += 5 // coiled spring

  score = Math.max(-100, Math.min(100, score))
  const technicalBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
    score > 25 ? 'BULLISH' : score < -25 ? 'BEARISH' : 'NEUTRAL'

  // ── Summary string for AI ─────────────────────────────────
  const pricePct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
  const parts: string[] = [
    `Price: $${current.toFixed(2)} (${pricePct(priceChange1D)} today, ${pricePct(priceChangePeriod)} period)`,
    `RSI(14): ${rsiVal.toFixed(1)} — ${rsiSignal}`,
    `MACD: histogram ${macdHist >= 0 ? 'positive' : 'negative'} (${macdCrossover !== 'none' ? macdCrossover + ' crossover!' : 'no crossover'})`,
    `vs MAs: SMA20 ${pricePct((current/s20-1)*100)}, SMA50 ${pricePct((current/s50-1)*100)}, SMA200 ${pricePct((current/s200-1)*100)}`,
    `${s50 > s200 ? 'Golden cross in effect' : 'Death cross in effect'} (SMA50 ${s50 > s200 ? '>' : '<'} SMA200)`,
    `Bollinger: price at ${(bbPosition * 100).toFixed(0)}% of band, band ${bbSignal}`,
    `Volume: ${volRatio.toFixed(1)}x average — ${volumeSignal}`,
    `Support: $${support.toFixed(2)}, Resistance: $${resistance.toFixed(2)}`,
    `Technical score: ${score}/100 → ${technicalBias}`,
  ]

  return {
    currentPrice: current, priceChange1D, priceChangePeriod,
    high52w, low52w, distFromHigh, distFromLow,
    sma20: s20, sma50: s50, sma200: s200, ema12: e12, ema26: e26,
    priceVsSma20: (current/s20-1)*100,
    priceVsSma50: (current/s50-1)*100,
    priceVsSma200: (current/s200-1)*100,
    goldenCross: s50 > s200, deathCross: s50 < s200,
    rsi: rsiVal, rsiSignal,
    macdLine, macdSignal: macdSig, macdHistogram: macdHist, macdCrossover,
    bbUpper: bbU, bbMiddle: bbM, bbLower: bbL, bbWidth, bbPosition, bbSignal,
    avgVolume20: avgVol, lastVolume: lastVol, volumeRatio: volRatio, volumeSignal,
    support, resistance,
    technicalScore: score, technicalBias,
    summary: parts.join('\n'),
  }
}

function emptyTechnicals(): TechnicalSignals {
  const z = 0
  return {
    currentPrice: z, priceChange1D: z, priceChangePeriod: z,
    high52w: z, low52w: z, distFromHigh: z, distFromLow: z,
    sma20: z, sma50: z, sma200: z, ema12: z, ema26: z,
    priceVsSma20: z, priceVsSma50: z, priceVsSma200: z,
    goldenCross: false, deathCross: false,
    rsi: 50, rsiSignal: 'neutral',
    macdLine: z, macdSignal: z, macdHistogram: z, macdCrossover: 'none',
    bbUpper: z, bbMiddle: z, bbLower: z, bbWidth: z, bbPosition: 0.5, bbSignal: 'normal',
    avgVolume20: z, lastVolume: z, volumeRatio: 1, volumeSignal: 'normal',
    support: z, resistance: z,
    technicalScore: 0, technicalBias: 'NEUTRAL',
    summary: 'No price data available.',
  }
}
