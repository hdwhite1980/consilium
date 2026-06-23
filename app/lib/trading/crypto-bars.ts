// =============================================================
// app/lib/trading/crypto-bars.ts
//
// Fetches OHLCV candles from Coinbase Advanced Trade API.
//
// Endpoint: GET /api/v3/brokerage/products/{product_id}/candles
//   Requires auth.
//   Query: start, end, granularity
//   Max 300 candles per call.
//
// Public alternative: /api/v3/brokerage/market/products/{product_id}/candles
//   No auth required (per Coinbase docs June 2026).
//
// Granularity values accepted by Coinbase:
//   ONE_MINUTE, FIVE_MINUTE, FIFTEEN_MINUTE, THIRTY_MINUTE,
//   ONE_HOUR, TWO_HOUR, SIX_HOUR, ONE_DAY
//
// Output Bar shape matches stocks bars where possible so signal/pattern
// code can consume crypto data without branching.
// =============================================================

const COINBASE_PUBLIC_BASE = 'https://api.coinbase.com/api/v3/brokerage'

export type CryptoGranularity =
  | 'ONE_MINUTE' | 'FIVE_MINUTE' | 'FIFTEEN_MINUTE' | 'THIRTY_MINUTE'
  | 'ONE_HOUR' | 'TWO_HOUR' | 'SIX_HOUR' | 'ONE_DAY'

export interface CryptoBar {
  timestamp: string           // ISO 8601
  unixSeconds: number         // raw epoch seconds
  open: number
  high: number
  low: number
  close: number
  volume: number              // base volume
}

export interface FetchBarsOptions {
  symbol: string              // e.g. "BTC-USD"
  granularity: CryptoGranularity
  limit?: number              // default 100, max 300
  startUnix?: number          // epoch seconds; if omitted, end-now lookback
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
 * Fetch OHLCV bars for a symbol/granularity. Uses public unauth endpoint.
 *
 * Coinbase returns candles oldest-first or newest-first depending on
 * params — we normalize to oldest-first (ascending by time).
 */
export async function fetchCryptoBars(opts: FetchBarsOptions): Promise<CryptoBar[]> {
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
    // Coinbase v3 returns candle objects with named fields:
    //   { start, low, high, open, close, volume }
    // start is unix-seconds-as-string. Normalize to our Bar shape.
    const bars: CryptoBar[] = data.candles.map(c => {
      const unixSeconds = Number(c.start ?? 0)
      return {
        timestamp: new Date(unixSeconds * 1000).toISOString(),
        unixSeconds,
        open: Number(c.open ?? 0),
        high: Number(c.high ?? 0),
        low: Number(c.low ?? 0),
        close: Number(c.close ?? 0),
        volume: Number(c.volume ?? 0),
      }
    })
    // Sort oldest-first (Coinbase commonly returns newest-first)
    bars.sort((a, b) => a.unixSeconds - b.unixSeconds)
    return bars
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Indicators — basic versions for signal counting
// ─────────────────────────────────────────────────────────────

/**
 * Simple Moving Average (SMA).
 */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/**
 * Exponential Moving Average (EMA).
 */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (values.length === 0) return out
  const k = 2 / (period + 1)
  // Seed with SMA of first `period` values
  if (values.length < period) return out
  let seed = 0
  for (let i = 0; i < period; i++) seed += values[i]
  seed = seed / period
  out[period - 1] = seed
  for (let i = period; i < values.length; i++) {
    const prev = out[i - 1] as number
    out[i] = values[i] * k + prev * (1 - k)
  }
  return out
}

/**
 * Relative Strength Index (Wilder smoothing). Period default 14.
 * Returns array of RSI values (null for the first `period` bars).
 */
export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null)
  if (closes.length <= period) return out

  let gainSum = 0
  let lossSum = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gainSum += diff
    else lossSum += -diff
  }
  let avgGain = gainSum / period
  let avgLoss = lossSum / period
  out[period] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss))

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    out[i] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss))
  }
  return out
}

/**
 * MACD: returns { macd, signal, histogram }
 * Defaults: fast=12, slow=26, signal=9.
 */
export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] } {
  const fastEma = ema(closes, fast)
  const slowEma = ema(closes, slow)
  const macdLine: (number | null)[] = closes.map((_, i) =>
    fastEma[i] !== null && slowEma[i] !== null
      ? (fastEma[i] as number) - (slowEma[i] as number)
      : null
  )
  // Signal line = EMA of macd line where both are defined
  const macdDefined: number[] = macdLine.filter((v): v is number => v !== null)
  const sigDefined = ema(macdDefined, signalPeriod)
  const signal: (number | null)[] = new Array(closes.length).fill(null)
  let definedIdx = 0
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] !== null) {
      if (sigDefined[definedIdx] !== null) signal[i] = sigDefined[definedIdx]
      definedIdx++
    }
  }
  const histogram: (number | null)[] = closes.map((_, i) =>
    macdLine[i] !== null && signal[i] !== null
      ? (macdLine[i] as number) - (signal[i] as number)
      : null
  )
  return { macd: macdLine, signal, histogram }
}

// ─────────────────────────────────────────────────────────────
// Signal counting (parallels stock position-monitor logic)
// ─────────────────────────────────────────────────────────────

export interface CryptoSignalCounts {
  bullishCount: number
  bearishCount: number
  unanimousBullish: number      // both EMA-up and RSI-bullish and MACD-bullish
  signals: Array<{ name: string; direction: 'bullish' | 'bearish' | 'neutral'; detail: string }>
}

/**
 * Compute basic signal counts on a bar series. Used by crypto-position-monitor
 * to detect when a position should be exited based on price action weakness,
 * similar to how stock position-monitor counts bearish 5m/15m signals.
 *
 * Returns counts and individual signal directions for logging.
 */
export function computeCryptoSignals(bars: CryptoBar[]): CryptoSignalCounts {
  const signals: Array<{ name: string; direction: 'bullish' | 'bearish' | 'neutral'; detail: string }> = []
  if (bars.length < 30) {
    return { bullishCount: 0, bearishCount: 0, unanimousBullish: 0, signals }
  }
  const closes = bars.map(b => b.close)
  const lastClose = closes[closes.length - 1]
  const lastIdx = closes.length - 1

  // EMA20 vs EMA50 trend
  const ema20 = ema(closes, 20)
  const ema50 = ema(closes, 50)
  const e20 = ema20[lastIdx]
  const e50 = ema50[lastIdx]
  if (e20 !== null && e50 !== null) {
    if (e20 > e50 && lastClose > e20) {
      signals.push({ name: 'ema_trend', direction: 'bullish', detail: `close ${lastClose.toFixed(2)} > EMA20 ${e20.toFixed(2)} > EMA50 ${e50.toFixed(2)}` })
    } else if (e20 < e50 && lastClose < e20) {
      signals.push({ name: 'ema_trend', direction: 'bearish', detail: `close ${lastClose.toFixed(2)} < EMA20 ${e20.toFixed(2)} < EMA50 ${e50.toFixed(2)}` })
    } else {
      signals.push({ name: 'ema_trend', direction: 'neutral', detail: 'mixed EMA configuration' })
    }
  }

  // RSI(14)
  const rsiVals = rsi(closes, 14)
  const lastRsi = rsiVals[lastIdx]
  if (lastRsi !== null) {
    if (lastRsi > 55) {
      signals.push({ name: 'rsi', direction: 'bullish', detail: `RSI=${lastRsi.toFixed(1)} > 55` })
    } else if (lastRsi < 45) {
      signals.push({ name: 'rsi', direction: 'bearish', detail: `RSI=${lastRsi.toFixed(1)} < 45` })
    } else {
      signals.push({ name: 'rsi', direction: 'neutral', detail: `RSI=${lastRsi.toFixed(1)} neutral` })
    }
  }

  // MACD histogram
  const macdResult = macd(closes)
  const lastHist = macdResult.histogram[lastIdx]
  const prevHist = macdResult.histogram[lastIdx - 1]
  if (lastHist !== null && prevHist !== null) {
    if (lastHist > 0 && lastHist > prevHist) {
      signals.push({ name: 'macd', direction: 'bullish', detail: `MACD hist=${lastHist.toFixed(3)} positive & rising` })
    } else if (lastHist < 0 && lastHist < prevHist) {
      signals.push({ name: 'macd', direction: 'bearish', detail: `MACD hist=${lastHist.toFixed(3)} negative & falling` })
    } else {
      signals.push({ name: 'macd', direction: 'neutral', detail: `MACD hist=${lastHist.toFixed(3)} mixed` })
    }
  }

  // Recent momentum: last 5 bars net move
  if (bars.length >= 5) {
    const prevClose = closes[lastIdx - 4]
    const pct = ((lastClose - prevClose) / prevClose) * 100
    if (pct > 0.5) signals.push({ name: 'short_momentum', direction: 'bullish', detail: `last 5 bars +${pct.toFixed(2)}%` })
    else if (pct < -0.5) signals.push({ name: 'short_momentum', direction: 'bearish', detail: `last 5 bars ${pct.toFixed(2)}%` })
    else signals.push({ name: 'short_momentum', direction: 'neutral', detail: `last 5 bars ${pct.toFixed(2)}%` })
  }

  const bullishCount = signals.filter(s => s.direction === 'bullish').length
  const bearishCount = signals.filter(s => s.direction === 'bearish').length
  const unanimousBullish = bullishCount >= 4 ? 1 : 0

  return { bullishCount, bearishCount, unanimousBullish, signals }
}
