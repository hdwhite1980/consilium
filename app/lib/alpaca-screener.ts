// ═════════════════════════════════════════════════════════════
// app/lib/alpaca-screener.ts
//
// Wrapper for Alpaca's screener API endpoints (real-time SIP data).
//
//   GET /v1beta1/screener/stocks/most-actives — top by volume/trades
//   GET /v1beta1/screener/{market_type}/movers — top gainers + losers
//
// These return a small focused list of currently-moving stocks — not
// a full market scan. Combined, they give us ~100-250 unique tickers
// that are actually active today, with real prices.
//
// Used by the scanner to extend the curated universe with live movers.
// ═════════════════════════════════════════════════════════════

const ALPACA_DATA_BASE = 'https://data.alpaca.markets/v1beta1/screener'

const ALPACA_HEADERS = (): Record<string, string> => ({
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY ?? '',
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY ?? '',
})

// ─────────────────────────────────────────────────────────────
// Types — match Alpaca response shapes
// ─────────────────────────────────────────────────────────────

export interface ScreenerMover {
  ticker: string
  price: number
  changePct: number          // signed daily % change
  change: number             // signed daily $ change
  source: 'gainer' | 'loser' | 'most-active'
  volume?: number            // only set by most-actives
  trades?: number            // only set by most-actives
}

interface MostActivesResponse {
  most_actives?: Array<{
    symbol?: string
    volume?: number
    trade_count?: number
  }>
  last_updated?: string
}

interface MoversResponse {
  gainers?: Array<{
    symbol?: string
    percent_change?: number
    change?: number
    price?: number
  }>
  losers?: Array<{
    symbol?: string
    percent_change?: number
    change?: number
    price?: number
  }>
  market_type?: string
  last_updated?: string
}

// ─────────────────────────────────────────────────────────────
// In-memory cache — screener data resets at market open, so 5 min
// is a good balance between freshness and rate-limit friendliness
// ─────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T
  fetchedAt: number
}

const screenerCache = new Map<string, CacheEntry<ScreenerMover[]>>()
const SCREENER_CACHE_TTL_MS = 5 * 60 * 1000

// ─────────────────────────────────────────────────────────────
// HTTP fetcher with timeout + auth
// ─────────────────────────────────────────────────────────────

async function alpacaFetch(path: string, query: Record<string, string | number>): Promise<unknown | null> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) params.set(k, String(v))

  const url = `${ALPACA_DATA_BASE}${path}?${params.toString()}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)

  try {
    const res = await fetch(url, {
      headers: ALPACA_HEADERS(),
      signal: ctrl.signal,
      cache: 'no-store',
    })
    if (!res.ok) {
      console.warn(`[alpaca-screener] ${path} returned ${res.status}`)
      return null
    }
    return await res.json()
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 200) ?? 'unknown'
    console.warn(`[alpaca-screener] ${path} failed: ${msg}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Get most-active stocks (by volume by default)
// ─────────────────────────────────────────────────────────────

export async function getMostActives(top = 100, by: 'volume' | 'trades' = 'volume'): Promise<ScreenerMover[]> {
  const cacheKey = `most-actives:${by}:${top}`
  const cached = screenerCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < SCREENER_CACHE_TTL_MS) {
    return cached.data
  }

  const result = await alpacaFetch('/stocks/most-actives', {
    by,
    top: Math.min(100, Math.max(1, top)),
  }) as MostActivesResponse | null

  if (!result || !Array.isArray(result.most_actives)) return []

  // Most-actives doesn't include price — leave price=0; bars fetch
  // will get the real price downstream
  const movers: ScreenerMover[] = result.most_actives
    .filter(a => typeof a?.symbol === 'string' && a.symbol.length > 0)
    .map(a => ({
      ticker: (a.symbol as string).toUpperCase(),
      price: 0,
      changePct: 0,
      change: 0,
      volume: typeof a.volume === 'number' ? a.volume : undefined,
      trades: typeof a.trade_count === 'number' ? a.trade_count : undefined,
      source: 'most-active' as const,
    }))

  screenerCache.set(cacheKey, { data: movers, fetchedAt: Date.now() })
  return movers
}

// ─────────────────────────────────────────────────────────────
// Get top gainers + losers — `top` returns this many of EACH
// ─────────────────────────────────────────────────────────────

export async function getMovers(top = 50): Promise<{
  gainers: ScreenerMover[]
  losers: ScreenerMover[]
}> {
  const cacheKey = `movers:${top}`
  const cached = screenerCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < SCREENER_CACHE_TTL_MS) {
    // Reconstruct gainers + losers from the cached array
    const gainers = cached.data.filter(m => m.source === 'gainer')
    const losers = cached.data.filter(m => m.source === 'loser')
    return { gainers, losers }
  }

  const result = await alpacaFetch('/stocks/movers', {
    top: Math.min(50, Math.max(1, top)),
  }) as MoversResponse | null

  if (!result) return { gainers: [], losers: [] }

  const toMover = (m: { symbol?: string; percent_change?: number; change?: number; price?: number }, source: 'gainer' | 'loser'): ScreenerMover | null => {
    if (typeof m?.symbol !== 'string' || m.symbol.length === 0) return null
    return {
      ticker: m.symbol.toUpperCase(),
      price: typeof m.price === 'number' ? m.price : 0,
      changePct: typeof m.percent_change === 'number' ? m.percent_change : 0,
      change: typeof m.change === 'number' ? m.change : 0,
      source,
    }
  }

  const gainers = (result.gainers ?? [])
    .map(g => toMover(g, 'gainer'))
    .filter((g): g is ScreenerMover => g !== null)

  const losers = (result.losers ?? [])
    .map(l => toMover(l, 'loser'))
    .filter((l): l is ScreenerMover => l !== null)

  // Cache combined for later partial reads
  screenerCache.set(cacheKey, {
    data: [...gainers, ...losers],
    fetchedAt: Date.now(),
  })

  return { gainers, losers }
}

// ─────────────────────────────────────────────────────────────
// Combined — fetch everything in parallel and dedupe
// Returns up to ~150-250 unique tickers covering volume + movement
// ─────────────────────────────────────────────────────────────

export async function getAllScreenerMovers(opts?: {
  mostActiveTop?: number
  moversTop?: number
}): Promise<ScreenerMover[]> {
  const mostActiveTop = opts?.mostActiveTop ?? 100
  const moversTop = opts?.moversTop ?? 50

  const [mostActives, movers] = await Promise.all([
    getMostActives(mostActiveTop),
    getMovers(moversTop),
  ])

  // Dedupe — preserve first-seen entry (which carries most info)
  // Priority: gainer/loser entries (have price + changePct) > most-active (no price yet)
  const byTicker = new Map<string, ScreenerMover>()

  for (const m of [...movers.gainers, ...movers.losers]) {
    if (!byTicker.has(m.ticker)) byTicker.set(m.ticker, m)
  }
  for (const m of mostActives) {
    if (!byTicker.has(m.ticker)) byTicker.set(m.ticker, m)
  }

  return Array.from(byTicker.values())
}

// ─────────────────────────────────────────────────────────────
// Helper — true if the env has Alpaca credentials configured
// ─────────────────────────────────────────────────────────────

export function isAlpacaConfigured(): boolean {
  return Boolean(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY)
}
