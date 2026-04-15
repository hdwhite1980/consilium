// ─────────────────────────────────────────────────────────────
// Forex Data
// Primary:  Alpaca v1beta3 /forex/bars (same keys we already use)
// Fallback: Finnhub /forex/candle (OANDA symbols)
// Rate:     Finnhub /forex/rates
// ─────────────────────────────────────────────────────────────

import type { AlpacaBar } from './alpaca'

export const FOREX_PAIRS: Record<string, { base: string; quote: string; name: string; group: string }> = {
  // Majors
  EURUSD: { base: 'EUR', quote: 'USD', name: 'Euro / US Dollar',               group: 'Major' },
  GBPUSD: { base: 'GBP', quote: 'USD', name: 'British Pound / US Dollar',      group: 'Major' },
  USDJPY: { base: 'USD', quote: 'JPY', name: 'US Dollar / Japanese Yen',       group: 'Major' },
  USDCHF: { base: 'USD', quote: 'CHF', name: 'US Dollar / Swiss Franc',        group: 'Major' },
  AUDUSD: { base: 'AUD', quote: 'USD', name: 'Australian Dollar / US Dollar',  group: 'Major' },
  USDCAD: { base: 'USD', quote: 'CAD', name: 'US Dollar / Canadian Dollar',    group: 'Major' },
  NZDUSD: { base: 'NZD', quote: 'USD', name: 'New Zealand Dollar / US Dollar', group: 'Major' },
  // Crosses
  EURGBP: { base: 'EUR', quote: 'GBP', name: 'Euro / British Pound',                     group: 'Cross' },
  EURJPY: { base: 'EUR', quote: 'JPY', name: 'Euro / Japanese Yen',                      group: 'Cross' },
  GBPJPY: { base: 'GBP', quote: 'JPY', name: 'British Pound / Japanese Yen',            group: 'Cross' },
  EURCHF: { base: 'EUR', quote: 'CHF', name: 'Euro / Swiss Franc',                       group: 'Cross' },
  AUDJPY: { base: 'AUD', quote: 'JPY', name: 'Australian Dollar / Japanese Yen',        group: 'Cross' },
  CADJPY: { base: 'CAD', quote: 'JPY', name: 'Canadian Dollar / Japanese Yen',          group: 'Cross' },
  GBPCHF: { base: 'GBP', quote: 'CHF', name: 'British Pound / Swiss Franc',             group: 'Cross' },
  AUDCAD: { base: 'AUD', quote: 'CAD', name: 'Australian Dollar / Canadian Dollar',     group: 'Cross' },
  // Exotics
  USDMXN: { base: 'USD', quote: 'MXN', name: 'US Dollar / Mexican Peso',          group: 'Exotic' },
  USDZAR: { base: 'USD', quote: 'ZAR', name: 'US Dollar / South African Rand',    group: 'Exotic' },
  USDTRY: { base: 'USD', quote: 'TRY', name: 'US Dollar / Turkish Lira',          group: 'Exotic' },
  USDSEK: { base: 'USD', quote: 'SEK', name: 'US Dollar / Swedish Krona',         group: 'Exotic' },
  USDNOK: { base: 'USD', quote: 'NOK', name: 'US Dollar / Norwegian Krone',       group: 'Exotic' },
  USDSGD: { base: 'USD', quote: 'SGD', name: 'US Dollar / Singapore Dollar',      group: 'Exotic' },
  USDHKD: { base: 'USD', quote: 'HKD', name: 'US Dollar / Hong Kong Dollar',      group: 'Exotic' },
}

export function normalizeForexTicker(ticker: string): string {
  return ticker.toUpperCase().replace(/[^A-Z]/g, '')
}

export function isForexTicker(ticker: string): boolean {
  return normalizeForexTicker(ticker) in FOREX_PAIRS
}

export function getForexInfo(ticker: string) {
  return FOREX_PAIRS[normalizeForexTicker(ticker)] ?? null
}

// ── Current live rate via Finnhub /forex/rates ────────────────
export async function fetchForexRate(ticker: string): Promise<number> {
  const info = getForexInfo(ticker)
  if (!info) return 0
  try {
    const key = process.env.FINNHUB_API_KEY
    if (!key) return 0
    const res = await fetch(
      `https://finnhub.io/api/v1/forex/rates?base=${info.base}&token=${key}`,
      { cache: 'no-store' }
    )
    if (!res.ok) return 0
    const data = await res.json()
    const rate = data?.quote?.[info.quote]
    return typeof rate === 'number' && rate > 0 ? rate : 0
  } catch { return 0 }
}

// ── OHLCV bars — Alpaca primary, Finnhub fallback ─────────────
async function fetchAlpacaForexBars(ticker: string, timeframe: string): Promise<AlpacaBar[]> {
  try {
    const BASE = process.env.ALPACA_BASE_URL || 'https://data.alpaca.markets'
    const key = process.env.ALPACA_API_KEY
    const secret = process.env.ALPACA_SECRET_KEY
    if (!key || !secret) return []

    const info = getForexInfo(ticker)
    if (!info) return []

    // Alpaca forex symbol format: EUR/USD
    const symbol = `${info.base}/${info.quote}`

    const tfMap: Record<string, string> = {
      '1D': '1Hour', '1W': '1Day', '1M': '1Day', '3M': '1Week',
    }
    const daysBack: Record<string, number> = {
      '1D': 3, '1W': 14, '1M': 40, '3M': 100,
    }
    const tf      = tfMap[timeframe]    ?? '1Day'
    const days    = daysBack[timeframe] ?? 40
    const end     = new Date().toISOString()
    const start   = new Date(Date.now() - days * 86400000).toISOString()

    const url = `${BASE}/v1beta3/forex/bars?symbols=${encodeURIComponent(symbol)}&timeframe=${tf}&start=${start}&end=${end}&limit=1000&sort=asc`
    const res = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret,
      },
      next: { revalidate: 300 },
    })
    if (!res.ok) return []
    const data = await res.json()
    const bars = data.bars?.[symbol] ?? []
    if (!bars.length) return []

    return bars.map((b: { t: string; o: number; h: number; l: number; c: number; v: number }) => ({
      t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 1000000,
    }))
  } catch { return [] }
}

async function fetchFinnhubForexBars(ticker: string, timeframe: string): Promise<AlpacaBar[]> {
  try {
    const key = process.env.FINNHUB_API_KEY
    if (!key) return []
    const info = getForexInfo(ticker)
    if (!info) return []

    const symbol = `OANDA:${info.base}_${info.quote}`
    const resMap: Record<string, string> = {
      '1D': '60', '1W': 'D', '1M': 'D', '3M': 'W',
    }
    const daysMap: Record<string, number> = {
      '1D': 3, '1W': 14, '1M': 40, '3M': 100,
    }
    const resolution = resMap[timeframe] ?? 'D'
    const days = daysMap[timeframe] ?? 40
    const to   = Math.floor(Date.now() / 1000)
    const from = to - days * 86400

    const res = await fetch(
      `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}&token=${key}`,
      { next: { revalidate: 300 } }
    )
    if (!res.ok) return []
    const data = await res.json()
    if (data.s !== 'ok' || !Array.isArray(data.t) || !data.t.length) return []

    return (data.t as number[]).map((ts, i) => ({
      t: new Date(ts * 1000).toISOString(),
      o: data.o[i], h: data.h[i], l: data.l[i], c: data.c[i],
      v: data.v?.[i] || 1000000,
    }))
  } catch { return [] }
}

export async function fetchForexBars(ticker: string, timeframe: string): Promise<AlpacaBar[]> {
  // Try Alpaca first (same keys, no extra cost, reliable)
  const alpacaBars = await fetchAlpacaForexBars(ticker, timeframe)
  if (alpacaBars.length >= 10) return alpacaBars

  // Fallback to Finnhub
  const finnhubBars = await fetchFinnhubForexBars(ticker, timeframe)
  if (finnhubBars.length >= 10) return finnhubBars

  return []
}

// ── Pair metadata ─────────────────────────────────────────────
const PAIR_DESCRIPTIONS: Record<string, string> = {
  EURUSD: "World's most traded pair. Driven by ECB vs Fed policy divergence, EU/US economic data, and risk sentiment. Tightest spreads of any pair.",
  GBPUSD: "'Cable' — volatile. Sensitive to Bank of England policy, UK inflation, and geopolitical events. Wider spreads than EUR/USD.",
  USDJPY: "Carry trade benchmark. Rises in risk-on environments. Highly sensitive to US-Japan yield differentials. BOJ intervention risk above 150-155.",
  USDCHF: "USD vs safe-haven CHF. Falls in risk-off moves. SNB actively manages CHF strength — surprise interventions happen.",
  AUDUSD: "'Aussie' — commodity dollar correlated to gold, iron ore, and China growth. Strong risk appetite proxy.",
  USDCAD: "'Loonie' — tightly linked to crude oil prices. Trends well. CAD follows WTI closely.",
  NZDUSD: "'Kiwi' — similar to AUD but more volatile. RBNZ policy, dairy export prices, and Chinese demand are key drivers.",
  GBPJPY: "'The Dragon' — extremely volatile. Combines GBP and JPY sensitivity. Wide daily ranges. Experienced traders only.",
  EURJPY: "Euro vs Yen carry trade. Sensitive to global risk sentiment — sells off sharply in risk-off environments.",
  EURGBP: "Euro vs Sterling. ECB vs BoE policy divergence. Tends to range-trade more than other pairs.",
  AUDJPY: "High-beta risk proxy. Drops hard in risk-off. Tracks China growth sentiment closely.",
}

export async function fetchForexMetadata(ticker: string): Promise<{
  name: string; base: string; quote: string; group: string
  currentRate: number; change24hPct: number | null
  weekHigh: number | null; weekLow: number | null; description: string
}> {
  const norm = normalizeForexTicker(ticker)
  const info = getForexInfo(ticker)
  if (!info) {
    return { name: ticker, base: '', quote: '', group: 'Unknown', currentRate: 0, change24hPct: null, weekHigh: null, weekLow: null, description: '' }
  }

  const [currentRate, bars] = await Promise.all([
    fetchForexRate(ticker),
    fetchForexBars(ticker, '1W'),
  ])

  let change24hPct: number | null = null
  let weekHigh: number | null = null
  let weekLow: number | null = null

  if (bars.length >= 2) {
    const prev = bars[bars.length - 2].c
    const curr = currentRate || bars[bars.length - 1].c
    if (prev > 0) change24hPct = ((curr - prev) / prev) * 100
    weekHigh = Math.max(...bars.map(b => b.h))
    weekLow  = Math.min(...bars.map(b => b.l))
  }

  return {
    name: info.name,
    base: info.base,
    quote: info.quote,
    group: info.group,
    currentRate,
    change24hPct,
    weekHigh,
    weekLow,
    description: PAIR_DESCRIPTIONS[norm] ?? `${info.base}/${info.quote} — driven by central bank policy divergence, interest rate differentials, and macroeconomic conditions of both regions.`,
  }
}
