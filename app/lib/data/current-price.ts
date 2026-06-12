// =============================================================
// app/lib/data/current-price.ts
//
// Unified spot-price fetcher used by:
//   - The active-stories cron route (entry price for new stories)
//   - The active-stories GET endpoint (live current price on dashboard load)
//
// Routes by asset type:
//   - stock  → Finnhub /quote
//   - crypto → CoinGecko via existing fetchCryptoPrice()
//   - forex  → Frankfurter via existing fetchForexRate()
//
// Auto-correction: if the LLM declared assetType='stock' but the
// ticker matches a known crypto/forex pair, we route to the right
// source. This prevents misclassification from breaking the lookup.
//
// In-memory cache: 60s TTL. Many active stories share tickers across
// requests; caching prevents fanning out one Finnhub call per story
// per page load.
// =============================================================

import { fetchCryptoPrice, isCryptoTicker } from './crypto'
import { fetchForexRate, isForexTicker } from './forex'

// Public asset type — what gets stored in the DB and what callers see.
// Macro tickers (metals, oil, FX exotics, DXY) are stored as 'forex'
// at the data layer; they're an INTERNAL routing distinction only.
export type AssetType = 'stock' | 'crypto' | 'forex'

// Internal routing type — adds 'macro' so we can pick the TwelveData
// branch without exposing it to the DB layer (which has a CHECK constraint
// limiting asset_type to stock/crypto/forex). 'macro' is never returned
// from any exported function.
type InternalAssetType = AssetType | 'macro'

/** Result of a price lookup. Always returns an object — null fields signal missing data. */
export interface PriceLookup {
  ticker: string
  assetType: AssetType         // always one of the three public values
  price: number | null         // null if lookup failed
  fetchedAt: string            // ISO timestamp of the lookup
  source: 'finnhub' | 'coingecko' | 'frankfurter' | 'twelvedata' | 'cache' | 'failed'
}

// ─────────────────────────────────────────────────────────────
// Macro universe — FX exotics, precious metals, energy, indices.
// These route through TwelveData rather than Frankfurter (which has
// patchy EM/commodity coverage) or Finnhub (which doesn't know
// commodity symbols).
//
// Stored as a Set of internal canonical tickers; the TwelveData symbol
// mapping happens inside fetchMacroPrice() below.
// ─────────────────────────────────────────────────────────────

const MACRO_TICKERS = new Set<string>([
  // FX crosses not in FOREX_PAIRS (so they fall through to stock today)
  'GBPCAD', 'EURAUD', 'EURCAD', 'GBPAUD', 'CADJPY', 'CHFJPY',
  // EM majors not reliably in Frankfurter
  'USDTRY', 'USDCNH', 'USDHKD', 'USDBRL',
  // Precious metals (spot, USD-quoted)
  'XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD',
  // Energy
  'WTIUSD', 'BRENTUSD', 'NATGASUSD',
  // Dollar index
  'DXY',
])

export function isMacroTicker(ticker: string): boolean {
  return MACRO_TICKERS.has((ticker ?? '').toUpperCase().replace(/[^A-Z]/g, ''))
}

// ─────────────────────────────────────────────────────────────
// Asset-type detection (auto-correction)
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the actual asset type for a ticker, ignoring the LLM's
 * declaration if it conflicts with what the lookup tables know.
 *
 * This is the PUBLIC resolver — it returns one of the three public
 * AssetType values. Macro tickers (XAUUSD, WTIUSD, DXY, etc.) report
 * as 'forex' here because that's how they're stored at the DB layer.
 *
 * Order of precedence:
 *   1. Macro tickers → 'forex' (publicly), routed to TwelveData internally
 *   2. Explicit non-stock declaration ('crypto'/'forex') is trusted IF
 *      it lines up with a known mapping
 *   3. isForexTicker() — known FX pair → forex
 *   4. isCryptoTicker() — known crypto → crypto
 *   5. Otherwise fall back to stock
 */
export function resolveAssetType(ticker: string, declared?: string | null): AssetType {
  const upper = (ticker ?? '').toUpperCase()

  // Macro tickers report publicly as 'forex' so they pass the DB constraint.
  // Internal routing (which actually fetches via TwelveData) lives in
  // resolveAssetTypeForRouting below.
  if (isMacroTicker(upper)) return 'forex'

  // Trust the declaration only if it matches a known mapping
  if (declared === 'crypto' && isCryptoTicker(upper)) return 'crypto'
  if (declared === 'forex' && isForexTicker(upper)) return 'forex'

  // Auto-detect by symbol shape — these checks are cheap (lookup tables)
  if (isForexTicker(upper)) return 'forex'
  if (isCryptoTicker(upper)) return 'crypto'

  // Fall back to stock — Finnhub is permissive with ticker symbols
  return 'stock'
}

/**
 * INTERNAL routing resolver — adds 'macro' so we can pick the TwelveData
 * branch. Never exported. Callers see the public resolveAssetType.
 */
function resolveAssetTypeForRouting(ticker: string, declared?: string | null): InternalAssetType {
  const upper = (ticker ?? '').toUpperCase()

  if (isMacroTicker(upper)) return 'macro'

  if (declared === 'crypto' && isCryptoTicker(upper)) return 'crypto'
  if (declared === 'forex' && isForexTicker(upper)) return 'forex'

  if (isForexTicker(upper)) return 'forex'
  if (isCryptoTicker(upper)) return 'crypto'

  return 'stock'
}

// ─────────────────────────────────────────────────────────────
// Stock quote (Finnhub /quote)
// ─────────────────────────────────────────────────────────────

interface FinnhubQuote {
  c: number   // current price
  h: number   // high (today)
  l: number   // low (today)
  o: number   // open (today)
  pc: number  // previous close
  d: number   // change
  dp: number  // % change
  t: number   // unix timestamp
}

// ─────────────────────────────────────────────────────────────
// Macro spot price (TwelveData)
//
// Covers FX exotics, precious metals, energy, indices. TwelveData's
// /price endpoint returns a single number per symbol; it accepts pairs
// in either slash or compact form, and has its own conventions for
// commodities (USOIL/UKOIL historically, WTI/USD newer).
//
// Symbol mapping: internal canonical ticker → TwelveData symbol.
// For oil/gas we provide a fallback in case TwelveData's primary symbol
// has changed.
// ─────────────────────────────────────────────────────────────

interface TwelveDataPriceResponse {
  price?: string | number     // TwelveData returns price as STRING usually
  symbol?: string
  status?: string             // 'error' when symbol not found / rate-limited
  code?: number               // numeric error code on failures
  message?: string            // error description
}

// Primary TwelveData symbol for each canonical macro ticker.
const TD_SYMBOL: Record<string, string> = {
  // FX exotics — slash form
  GBPCAD: 'GBP/CAD',
  EURAUD: 'EUR/AUD',
  EURCAD: 'EUR/CAD',
  GBPAUD: 'GBP/AUD',
  CADJPY: 'CAD/JPY',
  CHFJPY: 'CHF/JPY',
  USDTRY: 'USD/TRY',
  USDCNH: 'USD/CNH',
  USDHKD: 'USD/HKD',
  USDBRL: 'USD/BRL',
  // Metals — slash form
  XAUUSD: 'XAU/USD',
  XAGUSD: 'XAG/USD',
  XPTUSD: 'XPT/USD',
  XPDUSD: 'XPD/USD',
  // Energy — TwelveData uses "WTI/USD" and "BRENT/USD" on Basic tier;
  // older docs / some tiers used USOIL/UKOIL. Fallback handled below.
  WTIUSD: 'WTI/USD',
  BRENTUSD: 'BRENT/USD',
  NATGASUSD: 'NG/USD',
  // Dollar index
  DXY: 'DXY',
}

// Fallback symbols to try if the primary returns an error.
// (Empty array means no fallback — primary is canonical.)
const TD_FALLBACK_SYMBOLS: Record<string, string[]> = {
  WTIUSD: ['USOIL', 'WTI'],
  BRENTUSD: ['UKOIL', 'BRENT'],
  NATGASUSD: ['NG', 'XNG/USD'],
}

async function tryTwelveDataSymbol(symbol: string, apiKey: string): Promise<number | null> {
  try {
    const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`
    // Use AbortController for a hard timeout; Next's revalidate also helps cache
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 6_000)
    let res: Response
    try {
      res = await fetch(url, { signal: ctrl.signal, next: { revalidate: 60 } })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      console.warn(`[current-price] TwelveData returned ${res.status} for symbol="${symbol}"`)
      return null
    }
    const body = await res.json() as TwelveDataPriceResponse
    if (body.status === 'error' || body.code) {
      console.warn(`[current-price] TwelveData error for symbol="${symbol}": ${body.message ?? body.code}`)
      return null
    }
    if (body.price === undefined || body.price === null) return null
    const n = typeof body.price === 'string' ? parseFloat(body.price) : body.price
    if (!Number.isFinite(n) || n <= 0) return null
    return n
  } catch (e) {
    console.warn(`[current-price] TwelveData fetch failed for symbol="${symbol}":`, e instanceof Error ? e.message : e)
    return null
  }
}

async function fetchMacroPrice(ticker: string): Promise<number | null> {
  const apiKey = process.env.TWELVE_DATA_API_KEY ?? process.env.TWELVEDATA_API_KEY
  if (!apiKey) {
    console.warn('[current-price] TWELVE_DATA_API_KEY not set — cannot fetch macro price for', ticker)
    return null
  }
  const upper = ticker.toUpperCase()
  const primary = TD_SYMBOL[upper]
  if (!primary) {
    console.warn(`[current-price] no TwelveData symbol mapping for ${ticker}`)
    return null
  }

  // Try primary symbol first
  const p1 = await tryTwelveDataSymbol(primary, apiKey)
  if (p1 !== null) return p1

  // Try fallback symbols if defined
  const fallbacks = TD_FALLBACK_SYMBOLS[upper] ?? []
  for (const fb of fallbacks) {
    const pf = await tryTwelveDataSymbol(fb, apiKey)
    if (pf !== null) {
      console.log(`[current-price] ${ticker} resolved via fallback symbol "${fb}"`)
      return pf
    }
  }
  return null
}

async function fetchStockPrice(ticker: string): Promise<number | null> {
  const apiKey = process.env.FINNHUB_API_KEY
  if (!apiKey) {
    console.warn('[current-price] FINNHUB_API_KEY not set — cannot fetch stock price')
    return null
  }
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${apiKey}`
    const res = await fetch(url, { next: { revalidate: 60 } })
    if (!res.ok) {
      console.warn(`[current-price] Finnhub returned ${res.status} for ${ticker}`)
      return null
    }
    const q = await res.json() as FinnhubQuote
    // Finnhub returns c=0 for unknown tickers — treat as null
    if (!q.c || q.c <= 0) return null
    return q.c
  } catch (e) {
    console.warn(`[current-price] Finnhub fetch failed for ${ticker}:`, e instanceof Error ? e.message : e)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// In-memory cache (60s TTL)
// ─────────────────────────────────────────────────────────────

interface CacheEntry {
  price: number
  fetchedAt: number
}

const priceCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000

function cacheKey(ticker: string, assetType: InternalAssetType): string {
  return `${assetType}:${ticker.toUpperCase()}`
}

function getCached(ticker: string, assetType: InternalAssetType): number | null {
  const entry = priceCache.get(cacheKey(ticker, assetType))
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    priceCache.delete(cacheKey(ticker, assetType))
    return null
  }
  return entry.price
}

function setCached(ticker: string, assetType: InternalAssetType, price: number): void {
  priceCache.set(cacheKey(ticker, assetType), { price, fetchedAt: Date.now() })
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Fetch the current spot price for a single ticker.
 * Routes by asset type, auto-corrects misclassification, caches 60s.
 *
 * Returns a PriceLookup with `price: null` on any failure (never throws).
 */
export async function fetchCurrentPrice(
  ticker: string,
  declaredAssetType?: string | null,
): Promise<PriceLookup> {
  const upper = (ticker ?? '').toUpperCase()
  // Internal type drives routing — distinguishes macro from forex so we can
  // pick the TwelveData branch. The PUBLIC assetType returned in the
  // PriceLookup collapses macro → forex for DB-layer compatibility.
  const routingType = resolveAssetTypeForRouting(upper, declaredAssetType)
  const publicAssetType: AssetType = routingType === 'macro' ? 'forex' : routingType
  const fetchedAt = new Date().toISOString()

  // Cache hit? Key by routing type so macro and forex don't collide.
  const cached = getCached(upper, routingType)
  if (cached !== null) {
    return { ticker: upper, assetType: publicAssetType, price: cached, fetchedAt, source: 'cache' }
  }

  let price: number | null = null
  let source: PriceLookup['source'] = 'failed'

  if (routingType === 'crypto') {
    const p = await fetchCryptoPrice(upper)
    if (p > 0) { price = p; source = 'coingecko' }
  } else if (routingType === 'forex') {
    const p = await fetchForexRate(upper)
    if (p > 0) { price = p; source = 'frankfurter' }
  } else if (routingType === 'macro') {
    const p = await fetchMacroPrice(upper)
    if (p !== null && p > 0) { price = p; source = 'twelvedata' }
  } else {
    const p = await fetchStockPrice(upper)
    if (p !== null && p > 0) { price = p; source = 'finnhub' }
  }

  if (price !== null) {
    setCached(upper, routingType, price)
  }

  return { ticker: upper, assetType: publicAssetType, price, fetchedAt, source }
}

/**
 * Fetch current prices for many tickers in parallel. Used by the GET
 * endpoint to enrich active stories with live prices on each page load.
 *
 * Caps concurrency implicitly via Promise.all — at typical scale (20-40
 * tickers) this is fine. If we ever push past the rate limits, switch
 * to a bounded pool here.
 */
export async function fetchCurrentPricesMany(
  items: Array<{ ticker: string; assetType?: string | null }>,
): Promise<Map<string, PriceLookup>> {
  const lookups = await Promise.all(
    items.map(({ ticker, assetType }) => fetchCurrentPrice(ticker, assetType)),
  )
  const out = new Map<string, PriceLookup>()
  for (const l of lookups) {
    out.set(l.ticker, l)
  }
  return out
}
