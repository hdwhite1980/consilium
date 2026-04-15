// ─────────────────────────────────────────────────────────────
// Forex Data — Finnhub API
// Supports all major and minor FX pairs
// ─────────────────────────────────────────────────────────────

import type { AlpacaBar } from './alpaca'

// ── Forex pair map ────────────────────────────────────────────
// Accepts common formats: EURUSD, EUR/USD, EUR-USD
export const FOREX_PAIRS: Record<string, { base: string; quote: string; name: string; group: string }> = {
  // Majors
  EURUSD: { base: 'EUR', quote: 'USD', name: 'Euro / US Dollar', group: 'Major' },
  GBPUSD: { base: 'GBP', quote: 'USD', name: 'British Pound / US Dollar', group: 'Major' },
  USDJPY: { base: 'USD', quote: 'JPY', name: 'US Dollar / Japanese Yen', group: 'Major' },
  USDCHF: { base: 'USD', quote: 'CHF', name: 'US Dollar / Swiss Franc', group: 'Major' },
  AUDUSD: { base: 'AUD', quote: 'USD', name: 'Australian Dollar / US Dollar', group: 'Major' },
  USDCAD: { base: 'USD', quote: 'CAD', name: 'US Dollar / Canadian Dollar', group: 'Major' },
  NZDUSD: { base: 'NZD', quote: 'USD', name: 'New Zealand Dollar / US Dollar', group: 'Major' },
  // Crosses
  EURGBP: { base: 'EUR', quote: 'GBP', name: 'Euro / British Pound', group: 'Cross' },
  EURJPY: { base: 'EUR', quote: 'JPY', name: 'Euro / Japanese Yen', group: 'Cross' },
  GBPJPY: { base: 'GBP', quote: 'JPY', name: 'British Pound / Japanese Yen', group: 'Cross' },
  EURCHF: { base: 'EUR', quote: 'CHF', name: 'Euro / Swiss Franc', group: 'Cross' },
  AUDJPY: { base: 'AUD', quote: 'JPY', name: 'Australian Dollar / Japanese Yen', group: 'Cross' },
  CADJPY: { base: 'CAD', quote: 'JPY', name: 'Canadian Dollar / Japanese Yen', group: 'Cross' },
  GBPCHF: { base: 'GBP', quote: 'CHF', name: 'British Pound / Swiss Franc', group: 'Cross' },
  AUDCAD: { base: 'AUD', quote: 'CAD', name: 'Australian Dollar / Canadian Dollar', group: 'Cross' },
  // Exotics
  USDMXN: { base: 'USD', quote: 'MXN', name: 'US Dollar / Mexican Peso', group: 'Exotic' },
  USDZAR: { base: 'USD', quote: 'ZAR', name: 'US Dollar / South African Rand', group: 'Exotic' },
  USDTRY: { base: 'USD', quote: 'TRY', name: 'US Dollar / Turkish Lira', group: 'Exotic' },
  USDSEK: { base: 'USD', quote: 'SEK', name: 'US Dollar / Swedish Krona', group: 'Exotic' },
  USDNOK: { base: 'USD', quote: 'NOK', name: 'US Dollar / Norwegian Krone', group: 'Exotic' },
  USDSGD: { base: 'USD', quote: 'SGD', name: 'US Dollar / Singapore Dollar', group: 'Exotic' },
  USDHKD: { base: 'USD', quote: 'HKD', name: 'US Dollar / Hong Kong Dollar', group: 'Exotic' },
}

// Normalize input: EUR/USD → EURUSD, eur-usd → EURUSD
export function normalizeForexTicker(ticker: string): string {
  return ticker.toUpperCase().replace(/[^A-Z]/g, '')
}

export function isForexTicker(ticker: string): boolean {
  const normalized = normalizeForexTicker(ticker)
  return normalized in FOREX_PAIRS
}

export function getForexInfo(ticker: string) {
  const normalized = normalizeForexTicker(ticker)
  return FOREX_PAIRS[normalized] ?? null
}

function finnhubSymbol(ticker: string): string {
  // Finnhub forex format: OANDA:EUR_USD
  const info = getForexInfo(ticker)
  if (!info) return ''
  return `OANDA:${info.base}_${info.quote}`
}

// ── Current rate ──────────────────────────────────────────────
export async function fetchForexRate(ticker: string): Promise<number> {
  try {
    const key = process.env.FINNHUB_API_KEY
    if (!key) return 0
    const symbol = finnhubSymbol(ticker)
    if (!symbol) return 0
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`,
      { cache: 'no-store' }
    )
    if (!res.ok) return 0
    const data = await res.json()
    return data.c > 0 ? data.c : 0
  } catch { return 0 }
}

// ── OHLCV bars ────────────────────────────────────────────────
export async function fetchForexBars(ticker: string, timeframe: string): Promise<AlpacaBar[]> {
  try {
    const key = process.env.FINNHUB_API_KEY
    if (!key) return []
    const symbol = finnhubSymbol(ticker)
    if (!symbol) return []

    // Map timeframe to Finnhub resolution
    const resolutionMap: Record<string, string> = {
      '1D': '60',   // 1-hour candles for intraday
      '1W': 'D',    // daily
      '1M': 'D',    // daily
      '3M': 'W',    // weekly
    }
    const resolution = resolutionMap[timeframe] ?? 'D'

    // Calculate date range
    const daysMap: Record<string, number> = { '1D': 2, '1W': 10, '1M': 35, '3M': 95 }
    const days = daysMap[timeframe] ?? 35
    const to = Math.floor(Date.now() / 1000)
    const from = to - days * 24 * 60 * 60

    const res = await fetch(
      `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}&token=${key}`,
      { next: { revalidate: 300 } }
    )
    if (!res.ok) return []
    const data = await res.json()

    if (data.s !== 'ok' || !data.t?.length) return []

    // Finnhub returns: t (timestamps), o, h, l, c, v
    return data.t.map((timestamp: number, i: number) => ({
      t: new Date(timestamp * 1000).toISOString(),
      o: data.o[i],
      h: data.h[i],
      l: data.l[i],
      c: data.c[i],
      v: data.v?.[i] ?? 0,
    }))
  } catch { return [] }
}

// ── Forex metadata ────────────────────────────────────────────
export async function fetchForexMetadata(ticker: string): Promise<{
  name: string
  base: string
  quote: string
  group: string
  currentRate: number
  change24h: number | null
  change24hPct: number | null
  weekHigh: number | null
  weekLow: number | null
  description: string
}> {
  const info = getForexInfo(ticker)
  if (!info) {
    return { name: ticker, base: '', quote: '', group: 'Unknown', currentRate: 0, change24h: null, change24hPct: null, weekHigh: null, weekLow: null, description: '' }
  }

  try {
    const key = process.env.FINNHUB_API_KEY
    if (!key) throw new Error('No key')

    const symbol = finnhubSymbol(ticker)
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`,
      { cache: 'no-store' }
    )
    if (!res.ok) throw new Error('Quote failed')
    const q = await res.json()

    const currentRate = q.c ?? 0
    const prevClose = q.pc ?? 0
    const change24h = prevClose > 0 ? currentRate - prevClose : null
    const change24hPct = prevClose > 0 ? ((currentRate - prevClose) / prevClose) * 100 : null
    const weekHigh = q.h ?? null
    const weekLow = q.l ?? null

    const descriptions: Record<string, string> = {
      EURUSD: "The world's most traded currency pair. EUR/USD movements are driven by ECB vs Fed monetary policy divergence, European economic data, and US employment/inflation figures.",
      GBPUSD: "Sterling vs Dollar, nicknamed 'Cable'. Sensitive to Bank of England policy, UK economic data, and geopolitical events. Higher volatility than EUR/USD.",
      USDJPY: "The carry trade benchmark. Rising USD/JPY typically reflects risk-on sentiment and higher US yields. BOJ intervention risk at extreme levels.",
      USDCHF: "Swiss Franc is the classic safe haven. Falls in risk-off environments. SNB actively manages CHF strength to protect exports.",
      AUDUSD: "The 'Commodity Dollar' — highly correlated to gold prices and Chinese economic data. Risk-on/off proxy.",
      GBPJPY: "The 'Dragon' — extreme volatility combining GBP and JPY sensitivity. Popular with experienced swing traders.",
    }

    return {
      name: info.name,
      base: info.base,
      quote: info.quote,
      group: info.group,
      currentRate,
      change24h,
      change24hPct,
      weekHigh,
      weekLow,
      description: descriptions[normalizeForexTicker(ticker)] ?? `${info.base}/${info.quote} currency pair. Influenced by central bank policy, economic data, and macroeconomic conditions of both regions.`,
    }
  } catch {
    return { name: info.name, base: info.base, quote: info.quote, group: info.group, currentRate: 0, change24h: null, change24hPct: null, weekHigh: null, weekLow: null, description: '' }
  }
}
