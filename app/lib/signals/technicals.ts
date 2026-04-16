// ─────────────────────────────────────────────────────────────
// PHASE 1 — Full Technical Indicators Suite
// All calculated from raw OHLCV bars. Zero extra API calls.
//
// Includes:
//   Trend:      SMA 20/50/200, EMA 9/20, MACD (12,26,9)
//   Momentum:   RSI (14), Stochastic Oscillator (14,3,3)
//   Volume:     VWAP, OBV, Volume ratio
//   Volatility: Bollinger Bands (20,2σ)
//   Levels:     Support/Resistance, Fibonacci Retracements
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
  // ── Price ─────────────────────────────────────────────────
  currentPrice: number
  priceChange1D: number
  priceChangePeriod: number
  high52w: number
  low52w: number
  distFromHigh: number
  distFromLow: number

  // ── Moving Averages ───────────────────────────────────────
  sma20: number
  sma50: number
  sma200: number
  ema9: number
  ema20: number
  ema12: number
  ema26: number
  priceVsSma20: number
  priceVsSma50: number
  priceVsSma200: number
  goldenCross: boolean
  deathCross: boolean
  ema9CrossEma20: 'bullish' | 'bearish' | 'none'  // fast EMA cross

  // ── MACD (12, 26, 9) ──────────────────────────────────────
  macdLine: number
  macdSignal: number
  macdHistogram: number
  macdCrossover: 'bullish' | 'bearish' | 'none'

  // ── RSI (14) ──────────────────────────────────────────────
  rsi: number
  rsiSignal: 'oversold' | 'overbought' | 'neutral'

  // ── Stochastic Oscillator (14, 3, 3) ──────────────────────
  stochK: number          // %K line
  stochD: number          // %D line (signal)
  stochSignal: 'oversold' | 'overbought' | 'neutral'
  stochCrossover: 'bullish' | 'bearish' | 'none'

  // ── Bollinger Bands (20, 2σ) ──────────────────────────────
  bbUpper: number
  bbMiddle: number
  bbLower: number
  bbWidth: number
  bbPosition: number
  bbSignal: 'squeeze' | 'expansion' | 'normal'

  // ── VWAP ──────────────────────────────────────────────────
  vwap: number
  priceVsVwap: number     // % above/below VWAP
  vwapSignal: 'above' | 'below'

  // ── OBV (On-Balance Volume) ───────────────────────────────
  obv: number
  obvTrend: 'rising' | 'falling' | 'flat'
  obvDivergence: 'bullish' | 'bearish' | 'none'  // price vs OBV direction

  // ── Volume ────────────────────────────────────────────────
  avgVolume20: number
  lastVolume: number
  volumeRatio: number
  volumeSignal: 'high' | 'low' | 'normal'

  // ── Support / Resistance ──────────────────────────────────
  support: number
  resistance: number
  support2: number        // secondary support
  resistance2: number     // secondary resistance

  // ── Fibonacci Retracements ────────────────────────────────
  fibLevels: FibLevel[]
  nearestFibLevel: FibLevel | null

  // ── Golden Zone Fibonacci ──────────────────────────────────
  goldenZone: GoldenZone

  // ── ATR (Average True Range) ──────────────────────────────
  atr14: number            // 14-period ATR in dollars
  atrPct: number           // ATR as % of price
  atrSignal: 'high_volatility' | 'low_volatility' | 'normal'
  stopLossATR: number      // 2x ATR below current price (suggested stop)
  takeProfitATR: number    // 3x ATR above current price (suggested target)

  // ── Rate of Change / Momentum ─────────────────────────────
  roc10: number            // 10-period ROC %
  roc20: number            // 20-period ROC %
  rocSignal: 'accelerating' | 'decelerating' | 'neutral'
  momentum: number         // raw momentum (close - close[10])

  // ── Relative Strength vs Sector ───────────────────────────
  relStrengthVsSector: number | null   // % outperformance vs sector ETF
  relStrengthSignal: 'outperforming' | 'underperforming' | 'inline' | 'unknown'

  // ── Ichimoku Cloud (basic) ────────────────────────────────
  ichimokuTenkan: number   // 9-period midpoint
  ichimokuKijun: number    // 26-period midpoint
  ichimokuSignal: 'above_cloud' | 'below_cloud' | 'in_cloud' | 'unknown'
  ichimokuCross: 'bullish' | 'bearish' | 'none'  // TK cross

  // ── Williams %R ───────────────────────────────────────────
  williamsR: number        // -100 to 0; near 0 = overbought, near -100 = oversold
  williamsSignal: 'overbought' | 'oversold' | 'neutral'

  // ── CCI (Commodity Channel Index) ─────────────────────────
  cci: number              // >100 overbought, <-100 oversold
  cciSignal: 'overbought' | 'oversold' | 'neutral'

  // ── Overall Score ─────────────────────────────────────────
  technicalScore: number
  technicalBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  summary: string

  // ── Pattern Detection ─────────────────────────────────────
  candlePattern: CandlePattern | null
  chartPattern: ChartPattern | null
  gapPattern: GapPattern | null
  trendLines: TrendLines
}

export interface CandlePattern {
  name: string
  type: 'bullish' | 'bearish' | 'neutral'
  strength: 'strong' | 'moderate' | 'weak'
  description: string
}

export interface ChartPattern {
  name: string
  type: 'bullish' | 'bearish' | 'neutral'
  target: number | null       // price target implied by pattern
  invalidation: number | null // level that breaks the pattern
  description: string
  confidence: 'high' | 'medium' | 'low'
}

export interface GapPattern {
  type: 'gap_up' | 'gap_down'
  size: number          // gap size in %
  filled: boolean       // has price come back to fill the gap
  gapHigh: number
  gapLow: number
  bullish: boolean
  description: string
}

export interface TrendLines {
  higherHighs: boolean        // uptrend structure
  lowerLows: boolean          // downtrend structure
  higherLows: boolean         // bullish accumulation
  lowerHighs: boolean         // bearish distribution
  trend: 'uptrend' | 'downtrend' | 'sideways'
  dynamicSupport: number | null   // trend line support price now
  dynamicResistance: number | null // trend line resistance price now
}

export interface FibLevel {
  level: number        // 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1
  price: number
  label: string
  type: 'support' | 'resistance'
}

function calcATR(bars: Bar[], period = 14): number {
  if (bars.length < period + 1) return 0
  const trueRanges: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const hl = bars[i].h - bars[i].l
    const hc = Math.abs(bars[i].h - bars[i - 1].c)
    const lc = Math.abs(bars[i].l - bars[i - 1].c)
    trueRanges.push(Math.max(hl, hc, lc))
  }
  // Wilder's smoothing
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period
  }
  return atr
}

function calcROC(closes: number[], period: number): number {
  if (closes.length < period + 1) return 0
  const prev = closes[closes.length - 1 - period]
  const curr = closes[closes.length - 1]
  return prev === 0 ? 0 : ((curr - prev) / prev) * 100
}

function calcWilliamsR(bars: Bar[], period = 14): number {
  if (bars.length < period) return -50
  const slice = bars.slice(-period)
  const high = Math.max(...slice.map(b => b.h))
  const low = Math.min(...slice.map(b => b.l))
  const close = bars[bars.length - 1].c
  return high === low ? -50 : ((high - close) / (high - low)) * -100
}

function calcCCI(bars: Bar[], period = 20): number {
  if (bars.length < period) return 0
  const slice = bars.slice(-period)
  const typicalPrices = slice.map(b => (b.h + b.l + b.c) / 3)
  const mean = typicalPrices.reduce((a, b) => a + b, 0) / period
  const meanDev = typicalPrices.reduce((a, b) => a + Math.abs(b - mean), 0) / period
  return meanDev === 0 ? 0 : (typicalPrices[typicalPrices.length - 1] - mean) / (0.015 * meanDev)
}

function calcIchimoku(bars: Bar[]): { tenkan: number; kijun: number; signal: 'above_cloud' | 'below_cloud' | 'in_cloud' | 'unknown'; cross: 'bullish' | 'bearish' | 'none' } {
  if (bars.length < 52) return { tenkan: 0, kijun: 0, signal: 'unknown', cross: 'none' }

  const midpoint = (b: Bar[], n: number) => {
    const slice = b.slice(-n)
    return (Math.max(...slice.map(x => x.h)) + Math.min(...slice.map(x => x.l))) / 2
  }

  const tenkan = midpoint(bars, 9)
  const kijun = midpoint(bars, 26)

  // Senkou span A and B (cloud) — shifted 26 periods back in time, so use current calc
  const senkouA = (tenkan + kijun) / 2
  const senkouB = midpoint(bars, 52)

  const current = bars[bars.length - 1].c
  const cloudTop = Math.max(senkouA, senkouB)
  const cloudBot = Math.min(senkouA, senkouB)

  const signal: 'above_cloud' | 'below_cloud' | 'in_cloud' =
    current > cloudTop ? 'above_cloud' :
    current < cloudBot ? 'below_cloud' : 'in_cloud'

  // TK cross (previous vs current)
  const prevTenkan = bars.length >= 10 ? midpoint(bars.slice(0, -1), 9) : tenkan
  const prevKijun  = bars.length >= 27 ? midpoint(bars.slice(0, -1), 26) : kijun
  const cross: 'bullish' | 'bearish' | 'none' =
    prevTenkan < prevKijun && tenkan > kijun ? 'bullish' :
    prevTenkan > prevKijun && tenkan < kijun ? 'bearish' : 'none'

  return { tenkan, kijun, signal, cross }
}

// ── Math Helpers ──────────────────────────────────────────────

function sma(values: number[], period: number): number {
  const n = Math.min(period, values.length)
  return values.slice(-n).reduce((a, b) => a + b, 0) / n
}

function ema(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0
  const k = 2 / (period + 1)
  let val = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < values.length; i++) {
    val = values[i] * k + val * (1 - k)
  }
  return val
}

function emaArray(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const result: number[] = []
  let val = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { result.push(NaN); continue }
    if (i === period - 1) { result.push(val); continue }
    val = values[i] * k + val * (1 - k)
    result.push(val)
  }
  return result
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  let gains = 0, losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff; else losses -= diff
  }
  let avgGain = gains / period, avgLoss = losses / period
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period
  }
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

function calcMACD(closes: number[]): { line: number; signal: number; histogram: number } {
  const ema12arr = emaArray(closes, 12)
  const ema26arr = emaArray(closes, 26)
  const macdArr = ema12arr.map((v, i) =>
    isNaN(v) || isNaN(ema26arr[i]) ? NaN : v - ema26arr[i]
  ).filter(v => !isNaN(v))

  const line = macdArr[macdArr.length - 1] ?? 0
  const signalLine = ema(macdArr, 9)
  return { line, signal: signalLine, histogram: line - signalLine }
}

function calcBollinger(closes: number[], period = 20) {
  const middle = sma(closes, period)
  const slice = closes.slice(-period)
  const variance = slice.reduce((s, c) => s + Math.pow(c - middle, 2), 0) / period
  const stddev = Math.sqrt(variance)
  return { upper: middle + 2 * stddev, middle, lower: middle - 2 * stddev }
}

// ── Stochastic Oscillator (14, 3, 3) ──────────────────────────
function calcStochastic(bars: Bar[], kPeriod = 14, dPeriod = 3): { k: number; d: number } {
  if (bars.length < kPeriod) return { k: 50, d: 50 }
  const kValues: number[] = []
  for (let i = kPeriod - 1; i < bars.length; i++) {
    const slice = bars.slice(i - kPeriod + 1, i + 1)
    const high = Math.max(...slice.map(b => b.h))
    const low  = Math.min(...slice.map(b => b.l))
    const close = bars[i].c
    const k = high === low ? 50 : ((close - low) / (high - low)) * 100
    kValues.push(k)
  }
  // %D = 3-period SMA of %K
  const k = kValues[kValues.length - 1]
  const d = sma(kValues, dPeriod)
  return { k, d }
}

// ── VWAP ──────────────────────────────────────────────────────
// For intraday (hourly) bars: true session VWAP using all bars
// For daily bars: 20-day VWAP (rolling) — TradingView equivalent
function calcVWAP(bars: Bar[]): number {
  // Use last 20 bars for daily, all bars for intraday
  const window = bars.length > 100 ? bars.slice(-20) : bars
  let totalTPV = 0, totalVol = 0
  for (const bar of window) {
    const typicalPrice = (bar.h + bar.l + bar.c) / 3
    totalTPV += typicalPrice * bar.v
    totalVol += bar.v
  }
  return totalVol > 0 ? totalTPV / totalVol : bars[bars.length - 1]?.c ?? 0
}

// ── OBV ───────────────────────────────────────────────────────
function calcOBV(bars: Bar[]): { obv: number; trend: 'rising' | 'falling' | 'flat'; divergence: 'bullish' | 'bearish' | 'none' } {
  if (bars.length < 2) return { obv: 0, trend: 'flat', divergence: 'none' }
  let obv = 0
  const obvArr: number[] = [0]
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].c > bars[i-1].c)      obv += bars[i].v
    else if (bars[i].c < bars[i-1].c) obv -= bars[i].v
    obvArr.push(obv)
  }
  // Trend: compare last 5 OBV values
  const recent = obvArr.slice(-5)
  const obvChange = recent[recent.length-1] - recent[0]
  const trend: 'rising' | 'falling' | 'flat' = Math.abs(obvChange) < 1000
    ? 'flat' : obvChange > 0 ? 'rising' : 'falling'

  // Divergence: price up but OBV down = bearish divergence (and vice versa)
  const priceChange = bars[bars.length-1].c - bars[Math.max(0, bars.length-5)].c
  let divergence: 'bullish' | 'bearish' | 'none' = 'none'
  if (priceChange < 0 && obvChange > 0) divergence = 'bullish'
  else if (priceChange > 0 && obvChange < 0) divergence = 'bearish'

  return { obv, trend, divergence }
}

// ── Fibonacci Retracements ────────────────────────────────────
function calcFibLevels(bars: Bar[]): FibLevel[] {
  const highs = bars.map(b => b.h)
  const lows  = bars.map(b => b.l)
  const swingHigh = Math.max(...highs)
  const swingLow  = Math.min(...lows)
  const range = swingHigh - swingLow
  const current = bars[bars.length - 1].c
  const trending = current > (swingHigh + swingLow) / 2 ? 'up' : 'down'

  const FIB_LEVELS = [
    { level: 0,     label: '0% (swing low)' },
    { level: 0.236, label: '23.6%' },
    { level: 0.382, label: '38.2%' },
    { level: 0.500, label: '50%' },
    { level: 0.618, label: '61.8% (golden ratio)' },
    { level: 0.786, label: '78.6%' },
    { level: 1,     label: '100% (swing high)' },
  ]

  return FIB_LEVELS.map(({ level, label }) => {
    const price = trending === 'up'
      ? swingLow + level * range
      : swingHigh - level * range
    return {
      level,
      price,
      label,
      type: (price < current ? 'support' : 'resistance') as 'support' | 'resistance',
    }
  })
}

// ── Golden Zone Fibonacci (0.618–0.786 institutional entry zone) ──────────────
export interface GoldenZone {
  swingHigh: number
  swingLow: number
  trending: 'up' | 'down'
  levels: FibLevel[]
  // The golden pocket — 0.618 to 0.786 price range
  goldenPocketHigh: number
  goldenPocketLow: number
  // Is current price inside the golden zone?
  inGoldenZone: boolean
  // Distance to nearest golden zone boundary as %
  distToZone: number
}

function calcGoldenZone(bars: Bar[]): GoldenZone {
  const highs = bars.map(b => b.h)
  const lows  = bars.map(b => b.l)
  const swingHigh = Math.max(...highs)
  const swingLow  = Math.min(...lows)
  const range = swingHigh - swingLow
  const current = bars[bars.length - 1].c
  const trending: 'up' | 'down' = current > (swingHigh + swingLow) / 2 ? 'up' : 'down'

  // Golden Zone levels: 0.618, 0.65 (midpoint), 0.705 (golden pocket), 0.786, 0.88
  const GOLDEN_LEVELS = [
    { level: 0.618, label: '61.8% — Golden Ratio entry' },
    { level: 0.650, label: '65% — Golden Zone mid' },
    { level: 0.705, label: '70.5% — Golden Pocket (optimal entry)' },
    { level: 0.786, label: '78.6% — Golden Zone outer boundary' },
    { level: 0.880, label: '88.6% — Deep retracement' },
  ]

  const levels: FibLevel[] = GOLDEN_LEVELS.map(({ level, label }) => {
    const price = trending === 'up'
      ? swingHigh - level * range   // retracement DOWN from swing high
      : swingLow + level * range    // retracement UP from swing low
    return {
      level,
      price: parseFloat(price.toFixed(2)),
      label,
      type: (price < current ? 'support' : 'resistance') as 'support' | 'resistance',
    }
  })

  // Golden pocket = 0.618 to 0.786 price range
  const p618 = levels.find(l => l.level === 0.618)!.price
  const p786 = levels.find(l => l.level === 0.786)!.price
  const goldenPocketHigh = Math.max(p618, p786)
  const goldenPocketLow  = Math.min(p618, p786)

  const inGoldenZone = current >= goldenPocketLow && current <= goldenPocketHigh

  // Distance to nearest boundary as %
  const distToZone = inGoldenZone ? 0 :
    Math.min(
      Math.abs(current - goldenPocketHigh) / current * 100,
      Math.abs(current - goldenPocketLow)  / current * 100
    )

  return {
    swingHigh: parseFloat(swingHigh.toFixed(2)),
    swingLow:  parseFloat(swingLow.toFixed(2)),
    trending,
    levels,
    goldenPocketHigh: parseFloat(goldenPocketHigh.toFixed(2)),
    goldenPocketLow:  parseFloat(goldenPocketLow.toFixed(2)),
    inGoldenZone,
    distToZone: parseFloat(distToZone.toFixed(1)),
  }
}

function nearestFib(fibs: FibLevel[], current: number): FibLevel | null {
  if (!fibs.length) return null
  return fibs.reduce((best, f) =>
    Math.abs(f.price - current) < Math.abs(best.price - current) ? f : best
  )
}

// ── Pivot Support / Resistance ────────────────────────────────
function calcPivots(bars: Bar[]): { s1: number; s2: number; r1: number; r2: number } {
  const recent = bars.slice(-20)
  const high = Math.max(...recent.map(b => b.h))
  const low  = Math.min(...recent.map(b => b.l))
  const close = recent[recent.length - 1].c
  const pivot = (high + low + close) / 3
  return {
    r1: 2 * pivot - low,
    r2: pivot + (high - low),
    s1: 2 * pivot - high,
    s2: pivot - (high - low),
  }
}


// ═══════════════════════════════════════════════════════════
// PATTERN DETECTION ENGINE
// ═══════════════════════════════════════════════════════════

function detectCandlePattern(bars: Bar[]): CandlePattern | null {
  if (bars.length < 3) return null
  const n  = bars.length - 1
  const c  = bars[n]
  const p  = bars[n - 1]
  const p2 = bars[n - 2]
  const bodyC  = Math.abs(c.c - c.o)
  const bodyP  = Math.abs(p.c - p.o)
  const rangeC = c.h - c.l
  const bullC  = c.c > c.o
  const bullP  = p.c > p.o
  const midP   = (p.o + p.c) / 2
  const upperWick = (b: Bar) => b.h - Math.max(b.o, b.c)
  const lowerWick = (b: Bar) => Math.min(b.o, b.c) - b.l
  const isSmallBody = (b: Bar) => Math.abs(b.c - b.o) < (b.h - b.l) * 0.25

  if (!bullP && bullC && c.o < p.c && c.c > p.o && bodyC > bodyP * 1.2)
    return { name: 'Bullish Engulfing', type: 'bullish', strength: 'strong',
      description: 'Buyers overwhelmed prior bearish bar — strong reversal signal.' }

  if (bullP && !bullC && c.o > p.c && c.c < p.o && bodyC > bodyP * 1.2)
    return { name: 'Bearish Engulfing', type: 'bearish', strength: 'strong',
      description: 'Sellers overwhelmed prior bullish bar — strong reversal signal.' }

  if (!bullP && lowerWick(c) > bodyC * 2 && upperWick(c) < bodyC * 0.5 && c.l < p.l)
    return { name: 'Hammer', type: 'bullish', strength: 'moderate',
      description: 'Long lower wick after decline — buyers stepped in hard at lows.' }

  if (bullP && upperWick(c) > bodyC * 2 && lowerWick(c) < bodyC * 0.5 && c.h > p.h)
    return { name: 'Shooting Star', type: 'bearish', strength: 'moderate',
      description: 'Long upper wick after rally — sellers rejected the push to new highs.' }

  if (bodyC < rangeC * 0.1 && rangeC > 0) {
    const name = upperWick(c) > lowerWick(c) * 2 ? 'Gravestone Doji'
               : lowerWick(c) > upperWick(c) * 2 ? 'Dragonfly Doji' : 'Doji'
    const type: CandlePattern['type'] = name === 'Gravestone Doji' ? 'bearish' : name === 'Dragonfly Doji' ? 'bullish' : 'neutral'
    return { name, type, strength: 'weak', description: 'Open and close nearly identical — market indecision. Next bar confirms direction.' }
  }

  if (!bullP && isSmallBody(p) && bullC && c.c > midP && p2.c < p2.o)
    return { name: 'Morning Star', type: 'bullish', strength: 'strong',
      description: 'Three-bar bullish reversal: down, indecision, then strong up — classic bottom.' }

  if (bullP && isSmallBody(p) && !bullC && c.c < midP && p2.c > p2.o)
    return { name: 'Evening Star', type: 'bearish', strength: 'strong',
      description: 'Three-bar bearish reversal: up, indecision, then strong down — classic top.' }

  if (!bullP && bullC && c.o > p.c && c.c < p.o && bodyC < bodyP * 0.5)
    return { name: 'Bullish Harami', type: 'bullish', strength: 'weak',
      description: 'Small bullish bar inside prior bearish bar — selling momentum fading.' }

  if (bullP && !bullC && c.o < p.c && c.c > p.o && bodyC < bodyP * 0.5)
    return { name: 'Bearish Harami', type: 'bearish', strength: 'weak',
      description: 'Small bearish bar inside prior bullish bar — buying momentum fading.' }

  const b1 = bars[n-2], b2 = bars[n-1], b3 = bars[n]
  if (b1.c > b1.o && b2.c > b2.o && b3.c > b3.o && b2.o > b1.o && b3.o > b2.o && b3.c > b2.c)
    return { name: 'Three White Soldiers', type: 'bullish', strength: 'strong',
      description: 'Three consecutive bullish bars each opening and closing higher — sustained buying pressure.' }

  if (b1.c < b1.o && b2.c < b2.o && b3.c < b3.o && b2.o < b1.o && b3.o < b2.o && b3.c < b2.c)
    return { name: 'Three Black Crows', type: 'bearish', strength: 'strong',
      description: 'Three consecutive bearish bars each opening and closing lower — sustained selling pressure.' }

  if (upperWick(c) < rangeC * 0.02 && lowerWick(c) < rangeC * 0.02 && bodyC > rangeC * 0.95)
    return { name: bullC ? 'Bullish Marubozu' : 'Bearish Marubozu',
      type: bullC ? 'bullish' : 'bearish', strength: 'strong',
      description: bullC ? 'Full bullish body, no wicks — buyers in complete control.' : 'Full bearish body, no wicks — sellers in complete control.' }

  return null
}

function detectGap(bars: Bar[]): GapPattern | null {
  if (bars.length < 3) return null
  const n = bars.length - 1
  for (let i = n; i >= Math.max(1, n - 5); i--) {
    const curr = bars[i], prev = bars[i - 1]
    const gapUp = curr.l > prev.h, gapDown = curr.h < prev.l
    if (!gapUp && !gapDown) continue
    const gapSize = gapUp ? ((curr.l - prev.h) / prev.h) * 100 : ((prev.l - curr.h) / curr.h) * 100
    if (gapSize < 0.3) continue
    const gapHigh = gapUp ? curr.l : prev.h
    const gapLow  = gapUp ? prev.h : curr.l
    let filled = false
    for (let j = i + 1; j <= n; j++) {
      if (bars[j].l <= gapHigh && bars[j].h >= gapLow) { filled = true; break }
    }
    const ageLabel = i === n ? 'today' : i === n - 1 ? 'yesterday' : `${n - i} bars ago`
    if (gapUp) return {
      type: 'gap_up', size: parseFloat(gapSize.toFixed(2)), filled,
      gapHigh, gapLow: prev.h, bullish: true,
      description: `Gap up ${gapSize.toFixed(1)}% from $${prev.h.toFixed(2)} to $${curr.l.toFixed(2)} (${ageLabel})${filled ? ' — filled.' : ' — unfilled, acts as support.'}`
    }
    return {
      type: 'gap_down', size: parseFloat(gapSize.toFixed(2)), filled,
      gapHigh: prev.l, gapLow: curr.h, bullish: false,
      description: `Gap down ${gapSize.toFixed(1)}% from $${prev.l.toFixed(2)} to $${curr.h.toFixed(2)} (${ageLabel})${filled ? ' — filled.' : ' — unfilled, acts as resistance.'}`
    }
  }
  return null
}

function analyzeTrendLines(bars: Bar[]): TrendLines {
  if (bars.length < 10) return { higherHighs: false, lowerLows: false, higherLows: false, lowerHighs: false, trend: 'sideways', dynamicSupport: null, dynamicResistance: null }
  const window = bars.slice(-20), n = window.length
  const swingHighs: { i: number; price: number }[] = []
  const swingLows:  { i: number; price: number }[] = []
  for (let i = 2; i < n - 2; i++) {
    if (window[i].h > window[i-1].h && window[i].h > window[i-2].h && window[i].h > window[i+1].h && window[i].h > window[i+2].h)
      swingHighs.push({ i, price: window[i].h })
    if (window[i].l < window[i-1].l && window[i].l < window[i-2].l && window[i].l < window[i+1].l && window[i].l < window[i+2].l)
      swingLows.push({ i, price: window[i].l })
  }
  const higherHighs = swingHighs.length >= 2 && swingHighs[swingHighs.length-1].price > swingHighs[swingHighs.length-2].price
  const lowerHighs  = swingHighs.length >= 2 && swingHighs[swingHighs.length-1].price < swingHighs[swingHighs.length-2].price
  const higherLows  = swingLows.length >= 2  && swingLows[swingLows.length-1].price  > swingLows[swingLows.length-2].price
  const lowerLows   = swingLows.length >= 2  && swingLows[swingLows.length-1].price  < swingLows[swingLows.length-2].price
  const trend: TrendLines['trend'] = (higherHighs && higherLows) ? 'uptrend' : (lowerHighs && lowerLows) ? 'downtrend' : 'sideways'
  let dynamicSupport: number | null = null, dynamicResistance: number | null = null
  if (swingLows.length >= 2) {
    const sl1 = swingLows[swingLows.length-2], sl2 = swingLows[swingLows.length-1]
    dynamicSupport = parseFloat((sl2.price + (sl2.price - sl1.price) / (sl2.i - sl1.i) * (n - 1 - sl2.i)).toFixed(2))
  }
  if (swingHighs.length >= 2) {
    const sh1 = swingHighs[swingHighs.length-2], sh2 = swingHighs[swingHighs.length-1]
    dynamicResistance = parseFloat((sh2.price + (sh2.price - sh1.price) / (sh2.i - sh1.i) * (n - 1 - sh2.i)).toFixed(2))
  }
  return { higherHighs, lowerLows, higherLows, lowerHighs, trend, dynamicSupport, dynamicResistance }
}

function detectChartPattern(bars: Bar[], currentPrice: number): ChartPattern | null {
  if (bars.length < 20) return null
  const w = bars.slice(-40), n = w.length
  const highs = w.map(b => b.h), lows = w.map(b => b.l), closes = w.map(b => b.c)
  const swingH: { i: number; price: number }[] = [], swingL: { i: number; price: number }[] = []
  for (let i = 3; i < n - 3; i++) {
    if (highs[i] === Math.max(...highs.slice(i-3, i+4))) swingH.push({ i, price: highs[i] })
    if (lows[i] === Math.min(...lows.slice(i-3, i+4))) swingL.push({ i, price: lows[i] })
  }

  if (swingH.length >= 2) {
    const h1 = swingH[swingH.length-2], h2 = swingH[swingH.length-1]
    if (Math.abs(h1.price - h2.price) / h1.price < 0.03 && h2.i - h1.i >= 5) {
      const neck = Math.min(...lows.slice(h1.i, h2.i))
      if (currentPrice < neck * 1.01) {
        const tgt = neck - (h1.price - neck)
        return { name: 'Double Top', type: 'bearish', confidence: 'high', target: parseFloat(tgt.toFixed(2)), invalidation: parseFloat((Math.max(h1.price, h2.price) * 1.01).toFixed(2)),
          description: `Two peaks at ~$${h1.price.toFixed(2)} and ~$${h2.price.toFixed(2)}, neckline $${neck.toFixed(2)} broken. Target: $${tgt.toFixed(2)}.` }
      }
    }
  }

  if (swingL.length >= 2) {
    const l1 = swingL[swingL.length-2], l2 = swingL[swingL.length-1]
    if (Math.abs(l1.price - l2.price) / l1.price < 0.03 && l2.i - l1.i >= 5) {
      const neck = Math.max(...highs.slice(l1.i, l2.i))
      if (currentPrice > neck * 0.99) {
        const tgt = neck + (neck - l1.price)
        return { name: 'Double Bottom', type: 'bullish', confidence: 'high', target: parseFloat(tgt.toFixed(2)), invalidation: parseFloat((Math.min(l1.price, l2.price) * 0.99).toFixed(2)),
          description: `Two troughs at ~$${l1.price.toFixed(2)} and ~$${l2.price.toFixed(2)}, neckline $${neck.toFixed(2)} broken. Target: $${tgt.toFixed(2)}.` }
      }
    }
  }

  if (swingH.length >= 3) {
    const [ls, hd, rs] = swingH.slice(-3)
    if (hd.price > ls.price * 1.02 && hd.price > rs.price * 1.02 && Math.abs(ls.price - rs.price) / ls.price < 0.05) {
      const neck = ((Math.min(...lows.slice(ls.i, hd.i))) + (Math.min(...lows.slice(hd.i, rs.i)))) / 2
      const tgt = neck - (hd.price - neck)
      return { name: 'Head & Shoulders', type: 'bearish', confidence: 'medium', target: parseFloat(tgt.toFixed(2)), invalidation: parseFloat((hd.price * 1.01).toFixed(2)),
        description: `Shoulders at $${ls.price.toFixed(2)}/$${rs.price.toFixed(2)}, head $${hd.price.toFixed(2)}, neckline ~$${neck.toFixed(2)}. Target: $${tgt.toFixed(2)}.` }
    }
  }

  if (swingL.length >= 3) {
    const [ls, hd, rs] = swingL.slice(-3)
    if (hd.price < ls.price * 0.98 && hd.price < rs.price * 0.98 && Math.abs(ls.price - rs.price) / ls.price < 0.05) {
      const neck = ((Math.max(...highs.slice(ls.i, hd.i))) + (Math.max(...highs.slice(hd.i, rs.i)))) / 2
      const tgt = neck + (neck - hd.price)
      return { name: 'Inverse Head & Shoulders', type: 'bullish', confidence: 'medium', target: parseFloat(tgt.toFixed(2)), invalidation: parseFloat((hd.price * 0.99).toFixed(2)),
        description: `Inv. shoulders $${ls.price.toFixed(2)}/$${rs.price.toFixed(2)}, head $${hd.price.toFixed(2)}, neckline ~$${neck.toFixed(2)}. Target: $${tgt.toFixed(2)}.` }
    }
  }

  if (swingH.length >= 2 && swingL.length >= 2) {
    const rH = swingH.slice(-3), rL = swingL.slice(-3)
    if (rH.length >= 2 && rL.length >= 2) {
      const flatTop   = rH.every(h => Math.abs(h.price - rH[0].price) / rH[0].price < 0.02)
      const risingLow = rL.every((l, i) => i === 0 || l.price > rL[i-1].price)
      if (flatTop && risingLow) {
        const tgt = rH[0].price + (rH[0].price - rL[0].price)
        return { name: 'Ascending Triangle', type: 'bullish', confidence: 'medium', target: parseFloat(tgt.toFixed(2)), invalidation: parseFloat((rL[rL.length-1].price * 0.98).toFixed(2)),
          description: `Flat resistance ~$${rH[0].price.toFixed(2)} with rising lows. Breakout target: $${tgt.toFixed(2)}.` }
      }
      const flatBot    = rL.every(l => Math.abs(l.price - rL[0].price) / rL[0].price < 0.02)
      const fallingHigh = rH.every((h, i) => i === 0 || h.price < rH[i-1].price)
      if (flatBot && fallingHigh) {
        const tgt = rL[0].price - (rH[0].price - rL[0].price)
        return { name: 'Descending Triangle', type: 'bearish', confidence: 'medium', target: parseFloat(tgt.toFixed(2)), invalidation: parseFloat((rH[rH.length-1].price * 1.02).toFixed(2)),
          description: `Flat support ~$${rL[0].price.toFixed(2)} with falling highs. Breakdown target: $${tgt.toFixed(2)}.` }
      }
    }
  }

  const rc = closes.slice(-15)
  const fh = rc.slice(0, 7), sh = rc.slice(7)
  const pole = (fh[fh.length-1] - fh[0]) / fh[0]
  const drift = (sh[sh.length-1] - sh[0]) / sh[0]
  if (pole > 0.05 && drift < 0 && drift > -0.04) {
    const tgt = currentPrice * (1 + pole)
    return { name: 'Bull Flag', type: 'bullish', confidence: 'medium', target: parseFloat(tgt.toFixed(2)), invalidation: parseFloat((sh[0] * 0.98).toFixed(2)),
      description: `Pole +${(pole*100).toFixed(1)}% with tight bearish consolidation. Continuation target: $${tgt.toFixed(2)}.` }
  }
  const drop = (fh[0] - fh[fh.length-1]) / fh[0]
  const bounce = (sh[sh.length-1] - sh[0]) / sh[0]
  if (drop > 0.05 && bounce > 0 && bounce < 0.04) {
    const tgt = currentPrice * (1 - drop)
    return { name: 'Bear Flag', type: 'bearish', confidence: 'medium', target: parseFloat(tgt.toFixed(2)), invalidation: parseFloat((sh[sh.length-1] * 1.02).toFixed(2)),
      description: `Pole −${(drop*100).toFixed(1)}% with weak bullish consolidation. Continuation target: $${tgt.toFixed(2)}.` }
  }

  return null
}

// ── Main Calculator ───────────────────────────────────────────
export function calculateTechnicals(bars: Bar[]): TechnicalSignals {
  if (!bars.length) return emptyTechnicals()

  const closes  = bars.map(b => b.c)
  const highs   = bars.map(b => b.h)
  const lows    = bars.map(b => b.l)
  const volumes = bars.map(b => b.v)
  const current = closes[closes.length - 1]
  const first   = closes[0]

  // ── priceChange1D — always vs yesterday's close, not previous bar ─
  // For intraday bars (15min, 1hour), find the last bar from the previous
  // trading day so "today" change is accurate regardless of bar resolution.
  let prevDayClose = closes[closes.length - 2] ?? current
  if (bars[0]?.t) {
    const todayDate = new Date(bars[bars.length - 1].t).toISOString().split('T')[0]
    // Walk backwards to find last bar from a different date
    for (let i = bars.length - 2; i >= 0; i--) {
      const barDate = new Date(bars[i].t).toISOString().split('T')[0]
      if (barDate < todayDate) {
        prevDayClose = bars[i].c
        break
      }
    }
  }
  const prev = prevDayClose

  // ── Price stats ───────────────────────────────────────────
  const priceChange1D = ((current - prev) / prev) * 100
  // Cap period change at ±500% — anything beyond that is a data error, not a real move
  const rawPeriodChange = first > 0 ? ((current - first) / first) * 100 : 0
  const priceChangePeriod = Math.max(-500, Math.min(500, rawPeriodChange))
  const high52w = Math.max(...highs)
  const low52w  = Math.min(...lows)
  const distFromHigh = ((high52w - current) / high52w) * 100
  const distFromLow  = ((current - low52w) / low52w) * 100

  // ── Moving averages ───────────────────────────────────────
  // Only compute SMA if we have enough bars — never silently compute a wrong value
  const hasEnoughFor200 = closes.length >= 200
  const hasEnoughFor50  = closes.length >= 50
  const s20  = closes.length >= 20  ? sma(closes, 20)  : sma(closes, closes.length)
  const s50  = hasEnoughFor50       ? sma(closes, 50)  : sma(closes, closes.length)
  const s200 = hasEnoughFor200      ? sma(closes, 200) : s50  // fallback to s50 so cross logic doesn't break
  const e9   = ema(closes, Math.min(9, closes.length))
  const e20  = ema(closes, Math.min(20, closes.length))
  const e12  = ema(closes, Math.min(12, closes.length))
  const e26  = ema(closes, Math.min(26, closes.length))
  // Only signal golden/death cross when we have real SMA200 data
  const crossValid = hasEnoughFor200 && hasEnoughFor50

  // EMA 9/20 crossover (using previous values to detect cross)
  const prevE9  = ema(closes.slice(0, -1), Math.min(9, closes.length - 1))
  const prevE20 = ema(closes.slice(0, -1), Math.min(20, closes.length - 1))
  const ema9CrossEma20: 'bullish' | 'bearish' | 'none' =
    e9 > e20 && prevE9 <= prevE20 ? 'bullish' :
    e9 < e20 && prevE9 >= prevE20 ? 'bearish' : 'none'

  // ── MACD ──────────────────────────────────────────────────
  const { line: macdLine, signal: macdSig, histogram: macdHist } = calcMACD(closes)
  const { histogram: prevMacdHist } = calcMACD(closes.slice(0, -1))
  const macdCrossover: 'bullish' | 'bearish' | 'none' =
    macdHist > 0 && prevMacdHist <= 0 ? 'bullish' :
    macdHist < 0 && prevMacdHist >= 0 ? 'bearish' : 'none'

  // ── RSI ───────────────────────────────────────────────────
  const rsiVal = calcRSI(closes)
  const rsiSignal: TechnicalSignals['rsiSignal'] =
    rsiVal >= 70 ? 'overbought' : rsiVal <= 30 ? 'oversold' : 'neutral'

  // ── Stochastic ────────────────────────────────────────────
  const { k: stochK, d: stochD } = calcStochastic(bars)
  const prevStoch = calcStochastic(bars.slice(0, -1))
  const stochSignal: TechnicalSignals['stochSignal'] =
    stochK >= 80 ? 'overbought' : stochK <= 20 ? 'oversold' : 'neutral'
  const stochCrossover: TechnicalSignals['stochCrossover'] =
    stochK > stochD && prevStoch.k <= prevStoch.d ? 'bullish' :
    stochK < stochD && prevStoch.k >= prevStoch.d ? 'bearish' : 'none'

  // ── Bollinger Bands ───────────────────────────────────────
  const { upper: bbU, middle: bbM, lower: bbL } = calcBollinger(closes)
  const bbWidth = (bbU - bbL) / bbM
  const bbPosition = (bbU > bbL) ? (current - bbL) / (bbU - bbL) : 0.5
  const bbSignal: TechnicalSignals['bbSignal'] =
    bbWidth < 0.05 ? 'squeeze' : bbWidth > 0.15 ? 'expansion' : 'normal'

  // ── VWAP ──────────────────────────────────────────────────
  const vwap = calcVWAP(bars)
  const priceVsVwap = ((current - vwap) / vwap) * 100
  const vwapSignal: TechnicalSignals['vwapSignal'] = current >= vwap ? 'above' : 'below'

  // ── OBV ───────────────────────────────────────────────────
  const { obv, trend: obvTrend, divergence: obvDivergence } = calcOBV(bars)

  // ── Volume ────────────────────────────────────────────────
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length)
  const lastVol = volumes[volumes.length - 1]
  // If all volume is zero (e.g. forex/ECB data), volume signals are meaningless
  const hasRealVolume = avgVol > 0
  const volRatio = hasRealVolume ? lastVol / avgVol : 1
  const volumeSignal: TechnicalSignals['volumeSignal'] =
    !hasRealVolume ? 'normal' :
    volRatio > 1.5 ? 'high' : volRatio < 0.5 ? 'low' : 'normal'

  // ── Fibonacci ─────────────────────────────────────────────
  const fibLevels = calcFibLevels(bars)
  const nearestFibLevel = nearestFib(fibLevels, current)

  // ── Pivots ────────────────────────────────────────────────
  const { s1, s2, r1, r2 } = calcPivots(bars)

  // ── Technical Score (-100 to +100) ───────────────────────
  // ── ATR ───────────────────────────────────────────────────
  const atr14 = calcATR(bars, 14)
  const atrPct = current > 0 ? (atr14 / current) * 100 : 0
  const atrSignal: 'high_volatility' | 'low_volatility' | 'normal' =
    atrPct > 3 ? 'high_volatility' : atrPct < 0.8 ? 'low_volatility' : 'normal'
  const stopLossATR = current - atr14 * 2
  const takeProfitATR = current + atr14 * 3

  // ── ROC / Momentum ─────────────────────────────────────────
  const roc10 = calcROC(closes, 10)
  const roc20 = calcROC(closes, 20)
  const momentum = closes.length >= 11 ? current - closes[closes.length - 11] : 0
  const rocSignal: 'accelerating' | 'decelerating' | 'neutral' =
    roc10 > roc20 + 1 ? 'accelerating' :
    roc10 < roc20 - 1 ? 'decelerating' : 'neutral'

  // ── Williams %R ───────────────────────────────────────────
  const williamsR = calcWilliamsR(bars)
  const williamsSignal: 'overbought' | 'oversold' | 'neutral' =
    williamsR > -20 ? 'overbought' : williamsR < -80 ? 'oversold' : 'neutral'

  // ── CCI ───────────────────────────────────────────────────
  const cci = calcCCI(bars)
  const cciSignal: 'overbought' | 'oversold' | 'neutral' =
    cci > 100 ? 'overbought' : cci < -100 ? 'oversold' : 'neutral'

  // ── Ichimoku ──────────────────────────────────────────────
  const ichimoku = calcIchimoku(bars)
  const ichimokuTenkan = ichimoku.tenkan
  const ichimokuKijun = ichimoku.kijun
  const ichimokuSignal = ichimoku.signal
  const ichimokuCross = ichimoku.cross

  // Relative strength vs sector — placeholder, filled by market-context
  const relStrengthVsSector: number | null = null
  const relStrengthSignal: 'outperforming' | 'underperforming' | 'inline' | 'unknown' = 'unknown'

  let score = 0

  // Trend (35 pts)
  if (current > s50)  score += 12; else score -= 12
  if (current > s200) score += 12; else score -= 12
  if (s50 > s200)     score += 11; else score -= 11

  // EMA signals (15 pts)
  if (current > e9)           score += 5
  if (e9 > e20)               score += 5
  if (ema9CrossEma20 === 'bullish') score += 5
  else if (ema9CrossEma20 === 'bearish') score -= 5

  // MACD (15 pts)
  if (macdHist > 0)                    score += 8; else score -= 8
  if (macdCrossover === 'bullish')     score += 7
  else if (macdCrossover === 'bearish') score -= 7

  // RSI (10 pts)
  if (rsiVal > 50 && rsiVal < 70) score += 7
  else if (rsiVal >= 70)          score += 2
  else if (rsiVal > 30)           score -= 5
  else                            score -= 10

  // Stochastic (10 pts)
  if (stochK > stochD && stochSignal !== 'overbought') score += 5
  else if (stochK < stochD && stochSignal !== 'oversold') score -= 5
  if (stochCrossover === 'bullish') score += 5
  else if (stochCrossover === 'bearish') score -= 5

  // VWAP (10 pts)
  if (vwapSignal === 'above') score += 10; else score -= 10

  // OBV (10 pts)
  if (obvTrend === 'rising')       score += 7
  else if (obvTrend === 'falling') score -= 7
  if (obvDivergence === 'bullish') score += 3
  else if (obvDivergence === 'bearish') score -= 3

  // Bollinger (5 pts)
  if (bbSignal === 'squeeze') score += 3
  if (bbPosition > 0.5 && bbPosition < 0.9) score += 2
  else if (bbPosition >= 0.9) score -= 3

  // Williams %R (5 pts)
  if (williamsSignal === 'oversold') score += 5
  else if (williamsSignal === 'overbought') score -= 5

  // CCI (5 pts)
  if (cciSignal === 'oversold') score += 5
  else if (cciSignal === 'overbought') score -= 5

  // Ichimoku (10 pts)
  if (ichimokuSignal === 'above_cloud') score += 7
  else if (ichimokuSignal === 'below_cloud') score -= 7
  if (ichimokuCross === 'bullish') score += 3
  else if (ichimokuCross === 'bearish') score -= 3

  // ROC momentum (5 pts)
  if (rocSignal === 'accelerating') score += 5
  else if (rocSignal === 'decelerating') score -= 5

  score = Math.max(-100, Math.min(100, Math.round(score)))
  const technicalBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
    score > 25 ? 'BULLISH' : score < -25 ? 'BEARISH' : 'NEUTRAL'

  // ── Summary string for AI ─────────────────────────────────
  const p = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
  const summary = [
    `Price: $${current.toFixed(2)} (${p(priceChange1D)} today, ${p(priceChangePeriod)} period)`,
    `EMAs: EMA9 $${e9.toFixed(2)} / EMA20 $${e20.toFixed(2)} — ${ema9CrossEma20 !== 'none' ? ema9CrossEma20 + ' crossover!' : e9 > e20 ? 'bullish alignment' : 'bearish alignment'}`,
    hasEnoughFor200
      ? `MAs: SMA50 ${p((current/s50-1)*100)} / SMA200 ${p((current/s200-1)*100)} — ${s50 > s200 ? 'golden cross' : 'death cross'} in effect`
      : `MAs: SMA50 ${p((current/s50-1)*100)} — SMA200 unavailable (only ${closes.length} bars, need 200)`,
    `MACD: histogram ${macdHist >= 0 ? 'positive' : 'negative'}${macdCrossover !== 'none' ? ' — ' + macdCrossover + ' crossover!' : ''}`,
    `RSI(14): ${rsiVal.toFixed(1)} — ${rsiSignal}`,
    `Stochastic(14,3,3): %K ${stochK.toFixed(1)} / %D ${stochD.toFixed(1)} — ${stochSignal}${stochCrossover !== 'none' ? ', ' + stochCrossover + ' crossover' : ''}`,
    `Williams %R(14): ${williamsR.toFixed(1)} — ${williamsSignal}`,
    `CCI(20): ${cci.toFixed(1)} — ${cciSignal}`,
    `ATR(14): $${atr14.toFixed(2)} (${atrPct.toFixed(1)}% of price) — ${atrSignal} | Suggested stop: $${stopLossATR.toFixed(2)} | Target: $${takeProfitATR.toFixed(2)}`,
    `ROC: 10-period ${p(roc10)}, 20-period ${p(roc20)} — momentum ${rocSignal}`,
    `Ichimoku: price is ${ichimokuSignal.replace(/_/g,' ')}${ichimokuCross !== 'none' ? ' — TK ' + ichimokuCross + ' cross!' : ''}`,
    `VWAP: $${vwap.toFixed(2)} — price is ${p(priceVsVwap)} ${vwapSignal} VWAP`,
    `OBV trend: ${obvTrend}${obvDivergence !== 'none' ? ' — ' + obvDivergence + ' divergence detected!' : ''}`,
    `Bollinger: ${bbSignal} band, price at ${(bbPosition * 100).toFixed(0)}% of band`,
    hasRealVolume ? `Volume: ${volRatio.toFixed(1)}x average — ${volumeSignal}` : `Volume: N/A (no volume data for this asset type)`,
    `Fibonacci: nearest level is ${nearestFibLevel?.label ?? 'N/A'} at $${nearestFibLevel?.price.toFixed(2) ?? 'N/A'} (${nearestFibLevel?.type ?? ''})`,
    `Key levels: Support $${s1.toFixed(2)} / $${s2.toFixed(2)}, Resistance $${r1.toFixed(2)} / $${r2.toFixed(2)}`,
    `Technical score: ${score}/100 → ${technicalBias}`,
  ].join('\n')

  // ── Pattern Detection ───────────────────────────────────
  const candlePattern  = detectCandlePattern(bars)
  const chartPattern   = detectChartPattern(bars, current)
  const gapPattern     = detectGap(bars)
  const trendLines     = analyzeTrendLines(bars)

  // Append pattern summary to AI context
  const patternLines = [
    candlePattern  ? `Candle pattern: ${candlePattern.name} (${candlePattern.type}, ${candlePattern.strength}) — ${candlePattern.description}` : '',
    chartPattern   ? `Chart pattern: ${chartPattern.name} (${chartPattern.type}, ${chartPattern.confidence} confidence) — ${chartPattern.description}` : '',
    gapPattern     ? `Gap: ${gapPattern.description}` : '',
    `Trend structure: ${trendLines.trend.toUpperCase()}${trendLines.dynamicSupport ? ` | Dynamic support: $${trendLines.dynamicSupport}` : ''}${trendLines.dynamicResistance ? ` | Dynamic resistance: $${trendLines.dynamicResistance}` : ''}`,
  ].filter(Boolean).join('\n')

  const summaryWithPatterns = patternLines ? summary + '\n\n' + patternLines : summary

  return {
    currentPrice: current, priceChange1D, priceChangePeriod,
    high52w, low52w, distFromHigh, distFromLow,
    sma20: s20, sma50: s50, sma200: s200,
    ema9: e9, ema20: e20, ema12: e12, ema26: e26,
    priceVsSma20: (current/s20-1)*100,
    priceVsSma50: (current/s50-1)*100,
    priceVsSma200: (current/s200-1)*100,
    goldenCross: crossValid && s50 > s200,
    deathCross:  crossValid && s50 < s200,
    ema9CrossEma20,
    macdLine, macdSignal: macdSig, macdHistogram: macdHist, macdCrossover,
    rsi: rsiVal, rsiSignal,
    stochK, stochD, stochSignal, stochCrossover,
    bbUpper: bbU, bbMiddle: bbM, bbLower: bbL, bbWidth, bbPosition, bbSignal,
    vwap, priceVsVwap, vwapSignal,
    obv, obvTrend, obvDivergence,
    avgVolume20: avgVol, lastVolume: lastVol, volumeRatio: volRatio, volumeSignal,
    support: s1, resistance: r1, support2: s2, resistance2: r2,
    fibLevels, nearestFibLevel,
    goldenZone: calcGoldenZone(bars),
    atr14, atrPct, atrSignal, stopLossATR, takeProfitATR,
    roc10, roc20, rocSignal, momentum,
    williamsR, williamsSignal,
    cci, cciSignal,
    ichimokuTenkan, ichimokuKijun, ichimokuSignal, ichimokuCross,
    relStrengthVsSector, relStrengthSignal,
    technicalScore: score, technicalBias,
    summary: summaryWithPatterns,
    // Pattern detection
    candlePattern, chartPattern, gapPattern, trendLines,
  }
}

function emptyTechnicals(): TechnicalSignals {
  const z = 0
  return {
    currentPrice: z, priceChange1D: z, priceChangePeriod: z,
    high52w: z, low52w: z, distFromHigh: z, distFromLow: z,
    sma20: z, sma50: z, sma200: z,
    ema9: z, ema20: z, ema12: z, ema26: z,
    priceVsSma20: z, priceVsSma50: z, priceVsSma200: z,
    goldenCross: false, deathCross: false, ema9CrossEma20: 'none',
    macdLine: z, macdSignal: z, macdHistogram: z, macdCrossover: 'none',
    // RSI/Stoch at 50 looks like a real "neutral" reading — use 0 and unknown signal
    // so the AI doesn't treat empty data as a real signal
    rsi: 50, rsiSignal: 'neutral' as const,
    stochK: 50, stochD: 50, stochSignal: 'neutral' as const, stochCrossover: 'none' as const,
    bbUpper: z, bbMiddle: z, bbLower: z, bbWidth: z, bbPosition: 0.5, bbSignal: 'normal' as const,
    vwap: z, priceVsVwap: z, vwapSignal: 'above' as const,
    obv: z, obvTrend: 'flat' as const, obvDivergence: 'none' as const,
    avgVolume20: z, lastVolume: z, volumeRatio: 1, volumeSignal: 'normal' as const,
    support: z, resistance: z, support2: z, resistance2: z,
    fibLevels: [], nearestFibLevel: null,
    goldenZone: { swingHigh: 0, swingLow: 0, trending: 'up' as const, levels: [], goldenPocketHigh: 0, goldenPocketLow: 0, inGoldenZone: false, distToZone: 0 },
    technicalScore: 0, technicalBias: 'NEUTRAL' as const,
    atr14: 0, atrPct: 0, atrSignal: 'normal' as const, stopLossATR: 0, takeProfitATR: 0,
    roc10: 0, roc20: 0, rocSignal: 'neutral' as const, momentum: 0,
    williamsR: -50, williamsSignal: 'neutral' as const,
    cci: 0, cciSignal: 'neutral' as const,
    ichimokuTenkan: 0, ichimokuKijun: 0, ichimokuSignal: 'unknown' as const, ichimokuCross: 'none' as const,
    relStrengthVsSector: null, relStrengthSignal: 'unknown' as const,
    candlePattern: null, chartPattern: null, gapPattern: null,
    trendLines: { higherHighs: false, lowerLows: false, higherLows: false, lowerHighs: false, trend: 'sideways' as const, dynamicSupport: null, dynamicResistance: null },
    summary: [
      '=== TECHNICALS ===',
      'WARNING: Price bar data unavailable for this ticker.',
      'All technical indicators are unreliable. Do not cite RSI, MACD, moving averages,',
      'volume, or any other technical signal — treat technical data as absent.',
    ].join('\n'),
  }
}

// ── Export helper for API route ───────────────────────────────
// Returns a plain object with all fields needed for the frontend.
// Using this avoids TypeScript cache issues with ReturnType inference.
export function technicalsToPayload(t: TechnicalSignals, currentPrice: number): Record<string, unknown> {
  return {
    rsi: t.rsi,
    technicalBias: t.technicalBias,
    technicalScore: t.technicalScore,
    sma20: t.sma20,
    sma50: t.sma50,
    sma200: t.sma200,
    ema9: t.ema9,
    ema20: t.ema20,
    support: t.support,
    support2: t.support2,
    resistance: t.resistance,
    resistance2: t.resistance2,
    goldenCross: t.goldenCross,
    deathCross: t.deathCross,
    ema9CrossEma20: t.ema9CrossEma20,
    macdLine: t.macdLine,
    macdSignal: t.macdSignal,
    macdHistogram: t.macdHistogram,
    macdCrossover: t.macdCrossover,
    bbPosition: t.bbPosition,
    bbSignal: t.bbSignal,
    bbUpper: t.bbUpper,
    bbMiddle: t.bbMiddle,
    bbLower: t.bbLower,
    stochK: t.stochK,
    stochD: t.stochD,
    stochSignal: t.stochSignal,
    stochCrossover: t.stochCrossover,
    vwap: t.vwap,
    priceVsVwap: t.priceVsVwap,
    vwapSignal: t.vwapSignal,
    obv: t.obv,
    obvTrend: t.obvTrend,
    obvDivergence: t.obvDivergence,
    volumeRatio: t.volumeRatio,
    priceChange1D: t.priceChange1D,
    fibLevels: t.fibLevels,
    goldenZone: t.goldenZone,
    nearestFibLevel: t.nearestFibLevel,
    atr14: t.atr14,
    atrPct: t.atrPct,
    atrSignal: t.atrSignal,
    stopLossATR: t.stopLossATR,
    takeProfitATR: t.takeProfitATR,
    roc10: t.roc10,
    roc20: t.roc20,
    rocSignal: t.rocSignal,
    momentum: t.momentum,
    williamsR: t.williamsR,
    williamsSignal: t.williamsSignal,
    cci: t.cci,
    cciSignal: t.cciSignal,
    ichimokuTenkan: t.ichimokuTenkan,
    ichimokuKijun: t.ichimokuKijun,
    ichimokuSignal: t.ichimokuSignal,
    ichimokuCross: t.ichimokuCross,
    relStrengthVsSector: t.relStrengthVsSector,
    relStrengthSignal: t.relStrengthSignal,
    candlePattern: t.candlePattern,
    chartPattern: t.chartPattern,
    gapPattern: t.gapPattern,
    trendLines: t.trendLines,
    currentPrice,
  }
}
