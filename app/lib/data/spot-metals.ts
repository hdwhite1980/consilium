// ─────────────────────────────────────────────────────────────
// Spot Metals Data — TwelveData API
// https://twelvedata.com/docs
//
// Supports spot precious metals quoted against USD:
//   XAU/USD — Gold
//   XAG/USD — Silver
//   XPT/USD — Platinum
//   XPD/USD — Palladium
//
// Why TwelveData and not Frankfurter: ECB (Frankfurter's source)
// doesn't track metals, only fiat currencies. TwelveData covers
// spot metals as forex-style pairs with intraday OHLC data.
//
// Tier note (Jun 2026): Currently on free Basic tier — 8 credits/
// minute, 800/day. Each metals analysis consumes ~6-10 credits
// (quote + bars × 1-2 timeframes + indicators). Sustainable for
// <100 metals analyses/day across all users. Upgrade to Grow ($29/mo,
// 55 credits/min) before going to broader audience.
// ─────────────────────────────────────────────────────────────

import type { AlpacaBar } from './alpaca'

const TD_BASE = 'https://api.twelvedata.com'

// Symbol metadata. Internal storage uses no-slash form (XAUUSD);
// TwelveData API expects slash form (XAU/USD); we convert at the edge.
export const SPOT_METAL_PAIRS: Record<string, {
  apiSymbol: string         // TwelveData symbol with slash
  base: string              // Metal code (XAU, XAG, etc.)
  quote: string             // Always USD for our supported set
  name: string              // Display name
  group: string             // Always 'Spot Metal'
  description: string       // Per-metal narrative for AI context
}> = {
  XAUUSD: {
    apiSymbol: 'XAU/USD',
    base: 'XAU', quote: 'USD',
    name: 'Spot Gold / US Dollar',
    group: 'Spot Metal',
    description:
      "Spot gold is the global benchmark for gold prices and the dominant safe-haven asset during equity sell-offs, " +
      "geopolitical stress, and dollar weakness. Drivers: real yields (inverse), USD strength (inverse), central bank " +
      "buying, ETF flows (GLD/IAU), and inflation expectations. Trades 23 hours/day, 5 days/week. Highly correlated to " +
      "TIPS yields and inversely correlated to DXY.",
  },
  XAGUSD: {
    apiSymbol: 'XAG/USD',
    base: 'XAG', quote: 'USD',
    name: 'Spot Silver / US Dollar',
    group: 'Spot Metal',
    description:
      "Spot silver tracks both monetary demand (similar to gold) and industrial demand (solar, electronics, EV). " +
      "More volatile than gold — typically 2-3x daily range. Gold-silver ratio is a key relative-value metric " +
      "(historical average ~70:1; ratios above 80 suggest silver underpriced). Drivers: industrial PMI data, " +
      "solar installation trends, real yields, and gold's direction.",
  },
  XPTUSD: {
    apiSymbol: 'XPT/USD',
    base: 'XPT', quote: 'USD',
    name: 'Spot Platinum / US Dollar',
    group: 'Spot Metal',
    description:
      "Spot platinum is primarily an industrial metal — auto catalysts (especially diesel), jewelry, and " +
      "increasingly hydrogen fuel cells. Thinner market than gold/silver, wider spreads, more event-driven. " +
      "Drivers: South African mining supply (~70% of global), auto sector demand, and palladium substitution.",
  },
  XPDUSD: {
    apiSymbol: 'XPD/USD',
    base: 'XPD', quote: 'USD',
    name: 'Spot Palladium / US Dollar',
    group: 'Spot Metal',
    description:
      "Spot palladium is dominated by auto catalyst demand (gasoline engines). Highly volatile, supply-constrained " +
      "(Russia + South Africa = ~80% supply). Drivers: auto production data, EV transition rate (long-term bearish), " +
      "Russia sanctions impact, and inventory levels at LBMA.",
  },
}

export function isSpotMetalTicker(ticker: string): boolean {
  return normalizeSpotMetalTicker(ticker) in SPOT_METAL_PAIRS
}

export function normalizeSpotMetalTicker(ticker: string): string {
  return ticker.toUpperCase().replace(/[^A-Z]/g, '')
}

export function getSpotMetalInfo(ticker: string) {
  return SPOT_METAL_PAIRS[normalizeSpotMetalTicker(ticker)] ?? null
}

// ─────────────────────────────────────────────────────────────
// Internal: fetch from TwelveData with API key + error handling
// ─────────────────────────────────────────────────────────────

function getApiKey(): string | null {
  return process.env.TWELVEDATA_API_KEY ?? null
}

async function tdFetch<T>(endpoint: string, params: Record<string, string>): Promise<T | null> {
  const key = getApiKey()
  if (!key) {
    console.warn(`[spot-metals] TWELVEDATA_API_KEY not set — cannot fetch ${endpoint}`)
    return null
  }
  const qs = new URLSearchParams({ ...params, apikey: key }).toString()
  const url = `${TD_BASE}/${endpoint}?${qs}`
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) {
      console.warn(`[spot-metals] TwelveData ${endpoint} HTTP ${res.status}`)
      return null
    }
    const data = await res.json()
    // TwelveData returns { code: 4xx, message: "..." } for errors with HTTP 200
    if (data?.code && typeof data.code === 'number' && data.code >= 400) {
      console.warn(`[spot-metals] TwelveData ${endpoint} error ${data.code}: ${data.message}`)
      return null
    }
    return data as T
  } catch (e) {
    console.warn(`[spot-metals] TwelveData ${endpoint} fetch failed:`, e instanceof Error ? e.message : e)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Current live rate
// 1 credit per call.
// ─────────────────────────────────────────────────────────────

export async function fetchSpotMetalPrice(ticker: string): Promise<number> {
  const info = getSpotMetalInfo(ticker)
  if (!info) return 0
  const data = await tdFetch<{ price?: string }>('price', { symbol: info.apiSymbol })
  if (!data?.price) return 0
  const n = parseFloat(data.price)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ─────────────────────────────────────────────────────────────
// OHLC bars
// 1 credit per call. We fetch enough history for SMA200 + Ichimoku.
//
// TwelveData supports interval values: 1min, 5min, 15min, 30min, 45min,
// 1h, 2h, 4h, 1day, 1week, 1month. We map our timeframes to suitable
// intervals + outputsize for indicator warmup.
// ─────────────────────────────────────────────────────────────

interface TdTimeSeriesResponse {
  values?: Array<{
    datetime: string
    open: string
    high: string
    low: string
    close: string
    volume?: string  // optional — metals often have 0 volume from this feed
  }>
}

export async function fetchSpotMetalBars(ticker: string, timeframe: string): Promise<AlpacaBar[]> {
  const info = getSpotMetalInfo(ticker)
  if (!info) return []

  // Map our timeframe to TwelveData interval + outputsize.
  // outputsize is bar count requested (TwelveData max is 5000).
  // We oversample so RSI/MACD/SMA200/Ichimoku all have enough warmup history.
  const configMap: Record<string, { interval: string; outputsize: number }> = {
    '1D': { interval: '1day',  outputsize: 250 },   // ~1yr daily — covers SMA200
    '1W': { interval: '1day',  outputsize: 250 },   // weekly view uses daily for indicator math
    '1M': { interval: '1day',  outputsize: 420 },   // longer history for SMA200 + Ichimoku
    '3M': { interval: '1week', outputsize: 200 },   // weekly bars over ~4 years
  }
  const config = configMap[timeframe] ?? { interval: '1day', outputsize: 250 }

  const data = await tdFetch<TdTimeSeriesResponse>('time_series', {
    symbol: info.apiSymbol,
    interval: config.interval,
    outputsize: String(config.outputsize),
    order: 'ASC',   // oldest first — matches our internal bar convention
  })

  if (!data?.values || !Array.isArray(data.values) || data.values.length < 3) {
    return []
  }

  return data.values.map(v => {
    // datetime comes as "YYYY-MM-DD" for daily, "YYYY-MM-DD HH:MM:SS" for intraday
    const t = v.datetime.includes(' ')
      ? new Date(v.datetime.replace(' ', 'T') + 'Z').toISOString()
      : `${v.datetime}T00:00:00Z`
    return {
      t,
      o: parseFloat(v.open),
      h: parseFloat(v.high),
      l: parseFloat(v.low),
      c: parseFloat(v.close),
      // Metals from TwelveData often have 0 volume (interbank market —
      // no centralized volume reporting). Zero suppresses volume signals,
      // which is correct behavior.
      v: v.volume ? parseFloat(v.volume) || 0 : 0,
    }
  }).filter(b => Number.isFinite(b.c) && b.c > 0)
}

// ─────────────────────────────────────────────────────────────
// Metadata for AI context (current rate, 24h change, week range)
// Reuses bars fetch — no extra credit unless bars failed.
// ─────────────────────────────────────────────────────────────

export async function fetchSpotMetalMetadata(ticker: string): Promise<{
  name: string
  base: string
  quote: string
  group: string
  currentRate: number
  change24hPct: number | null
  weekHigh: number | null
  weekLow: number | null
  description: string
}> {
  const info = getSpotMetalInfo(ticker)
  if (!info) {
    return {
      name: ticker, base: '', quote: '', group: 'Unknown',
      currentRate: 0, change24hPct: null, weekHigh: null, weekLow: null,
      description: '',
    }
  }

  // Run both in parallel — 2 credits total.
  const [currentRate, bars] = await Promise.all([
    fetchSpotMetalPrice(ticker),
    fetchSpotMetalBars(ticker, '1D'),
  ])

  let change24hPct: number | null = null
  let weekHigh: number | null = null
  let weekLow: number | null = null

  if (bars.length >= 2) {
    const prev = bars[bars.length - 2].c
    const curr = currentRate || bars[bars.length - 1].c
    if (prev > 0) change24hPct = ((curr - prev) / prev) * 100

    // 5-day window for "week" high/low
    const last5 = bars.slice(-5)
    weekHigh = Math.max(...last5.map(b => b.h))
    weekLow = Math.min(...last5.map(b => b.l))
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
    description: info.description,
  }
}
