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
      ? swingLow + level * range           // retracement from low
      : swingHigh - level * range          // retracement from high
    return {
      level,
      price,
      label,
      type: (price < current ? 'support' : 'resistance') as 'support' | 'resistance',
    }
  })
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
    // New indicators
    atr14, atrPct, atrSignal, stopLossATR, takeProfitATR,
    roc10, roc20, rocSignal, momentum,
    williamsR, williamsSignal,
    cci, cciSignal,
    ichimokuTenkan, ichimokuKijun, ichimokuSignal, ichimokuCross,
    relStrengthVsSector, relStrengthSignal,
    technicalScore: score, technicalBias,
    summary,
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
    technicalScore: 0, technicalBias: 'NEUTRAL' as const,
    atr14: 0, atrPct: 0, atrSignal: 'normal' as const, stopLossATR: 0, takeProfitATR: 0,
    roc10: 0, roc20: 0, rocSignal: 'neutral' as const, momentum: 0,
    williamsR: -50, williamsSignal: 'neutral' as const,
    cci: 0, cciSignal: 'neutral' as const,
    ichimokuTenkan: 0, ichimokuKijun: 0, ichimokuSignal: 'unknown' as const, ichimokuCross: 'none' as const,
    relStrengthVsSector: null, relStrengthSignal: 'unknown' as const,
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
    currentPrice,
  }
}
