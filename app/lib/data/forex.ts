// ─────────────────────────────────────────────────────────────
// Forex Data — Frankfurter API (European Central Bank data)
// https://api.frankfurter.app — free, no key, daily ECB rates
// Supports all major pairs via base currency conversion
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
  GBPJPY: { base: 'GBP', quote: 'JPY', name: 'British Pound / Japanese Yen',             group: 'Cross' },
  EURCHF: { base: 'EUR', quote: 'CHF', name: 'Euro / Swiss Franc',                       group: 'Cross' },
  AUDJPY: { base: 'AUD', quote: 'JPY', name: 'Australian Dollar / Japanese Yen',         group: 'Cross' },
  CADJPY: { base: 'CAD', quote: 'JPY', name: 'Canadian Dollar / Japanese Yen',           group: 'Cross' },
  GBPCHF: { base: 'GBP', quote: 'CHF', name: 'British Pound / Swiss Franc',              group: 'Cross' },
  AUDCAD: { base: 'AUD', quote: 'CAD', name: 'Australian Dollar / Canadian Dollar',      group: 'Cross' },
  // Exotics
  USDMXN: { base: 'USD', quote: 'MXN', name: 'US Dollar / Mexican Peso',          group: 'Exotic' },
  USDZAR: { base: 'USD', quote: 'ZAR', name: 'US Dollar / South African Rand',    group: 'Exotic' },
  USDSEK: { base: 'USD', quote: 'SEK', name: 'US Dollar / Swedish Krona',         group: 'Exotic' },
  USDNOK: { base: 'USD', quote: 'NOK', name: 'US Dollar / Norwegian Krone',       group: 'Exotic' },
  USDSGD: { base: 'USD', quote: 'SGD', name: 'US Dollar / Singapore Dollar',      group: 'Exotic' },
}

// Frankfurter supported currencies (subset — ECB tracks these)
const FRANKFURTER_CURRENCIES = new Set([
  'USD','EUR','GBP','JPY','CHF','AUD','CAD','NZD',
  'SEK','NOK','DKK','SGD','HKD','MXN','ZAR','PLN',
  'HUF','CZK','RON','BGN','HRK','ISK','TRY','INR',
  'CNY','KRW','BRL','IDR','MYR','PHP','THB',
])

export function normalizeForexTicker(ticker: string): string {
  return ticker.toUpperCase().replace(/[^A-Z]/g, '')
}

export function isForexTicker(ticker: string): boolean {
  return normalizeForexTicker(ticker) in FOREX_PAIRS
}

export function getForexInfo(ticker: string) {
  return FOREX_PAIRS[normalizeForexTicker(ticker)] ?? null
}

// ── Frankfurter: fetch daily rates for date range ─────────────
// Returns { date: rate } for the quote currency relative to base
async function frankfurterHistory(
  base: string,
  quote: string,
  daysBack: number
): Promise<Record<string, number>> {
  try {
    const end   = new Date()
    const start = new Date(Date.now() - daysBack * 86400000)
    const fmt   = (d: Date) => d.toISOString().split('T')[0]

    // Frankfurter needs both currencies to be in their supported set
    // For pairs not directly supported, route through EUR or USD
    const res = await fetch(
      `https://api.frankfurter.app/${fmt(start)}..${fmt(end)}?from=${base}&to=${quote}`,
      { next: { revalidate: 3600 } } // cache 1 hour — ECB rates are daily
    )
    if (!res.ok) return {}
    const data = await res.json()

    // data.rates = { "2024-01-02": { "USD": 1.094 }, ... }
    const result: Record<string, number> = {}
    for (const [date, rates] of Object.entries(data.rates as Record<string, Record<string, number>>)) {
      const rate = rates[quote]
      if (rate && rate > 0) result[date] = rate
    }
    return result
  } catch { return {} }
}

// ── Current live rate ─────────────────────────────────────────
export async function fetchForexRate(ticker: string): Promise<number> {
  const info = getForexInfo(ticker)
  if (!info) return 0
  try {
    const res = await fetch(
      `https://api.frankfurter.app/latest?from=${info.base}&to=${info.quote}`,
      { cache: 'no-store' }
    )
    if (!res.ok) return 0
    const data = await res.json()
    return data.rates?.[info.quote] ?? 0
  } catch { return 0 }
}

// ── OHLCV bars from daily ECB rates ──────────────────────────
// ECB provides one closing rate per day — we synthesise realistic
// O/H/L from the closing rate using the pair's typical daily ATR %
// This gives enough bar structure for RSI, MACD, SMA, Bollinger, etc.
const TYPICAL_DAILY_RANGE: Record<string, number> = {
  EURUSD: 0.0045, GBPUSD: 0.0060, USDJPY: 0.0055, USDCHF: 0.0045,
  AUDUSD: 0.0055, USDCAD: 0.0050, NZDUSD: 0.0055,
  EURGBP: 0.0035, EURJPY: 0.0065, GBPJPY: 0.0090, EURCHF: 0.0035,
  AUDJPY: 0.0070, CADJPY: 0.0065, GBPCHF: 0.0060, AUDCAD: 0.0050,
  DEFAULT: 0.0055,
}

export async function fetchForexBars(ticker: string, timeframe: string): Promise<AlpacaBar[]> {
  const norm = normalizeForexTicker(ticker)
  const info = getForexInfo(norm)
  if (!info) return []

  // Check both currencies are supported by Frankfurter
  if (!FRANKFURTER_CURRENCIES.has(info.base) || !FRANKFURTER_CURRENCIES.has(info.quote)) {
    return []
  }

  const daysMap: Record<string, number> = {
    '1D': 5, '1W': 21, '1M': 60, '3M': 140,
  }
  const daysBack = daysMap[timeframe] ?? 60
  const rates = await frankfurterHistory(info.base, info.quote, daysBack)

  if (Object.keys(rates).length < 3) return []

  // Convert daily closes to OHLCV bars with synthesised O/H/L
  const dailyRange = TYPICAL_DAILY_RANGE[norm] ?? TYPICAL_DAILY_RANGE.DEFAULT
  const dates = Object.keys(rates).sort()

  return dates.map((date, i) => {
    const close = rates[date]
    const prev  = i > 0 ? rates[dates[i - 1]] : close
    // Open = previous close (realistic for forex)
    const open  = prev
    // Synthesise high/low from typical daily range
    const halfRange = close * dailyRange * 0.5
    const high  = Math.max(open, close) + halfRange
    const low   = Math.min(open, close) - halfRange
    return {
      t: `${date}T00:00:00Z`,
      o: parseFloat(open.toFixed(6)),
      h: parseFloat(high.toFixed(6)),
      l: parseFloat(low.toFixed(6)),
      c: parseFloat(close.toFixed(6)),
      v: 1000000, // placeholder — ECB doesn't provide volume
    }
  })
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
  const info = getForexInfo(norm)
  if (!info) {
    return { name: ticker, base: '', quote: '', group: 'Unknown', currentRate: 0, change24hPct: null, weekHigh: null, weekLow: null, description: '' }
  }

  const [currentRate, bars] = await Promise.all([
    fetchForexRate(norm),
    fetchForexBars(norm, '1W'),
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
