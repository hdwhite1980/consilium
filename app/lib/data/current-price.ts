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

export type AssetType = 'stock' | 'crypto' | 'forex'

/** Result of a price lookup. Always returns an object — null fields signal missing data. */
export interface PriceLookup {
  ticker: string
  assetType: AssetType
  price: number | null         // null if lookup failed
  fetchedAt: string            // ISO timestamp of the lookup
  source: 'finnhub' | 'coingecko' | 'frankfurter' | 'cache' | 'failed'
}

// ─────────────────────────────────────────────────────────────
// Asset-type detection (auto-correction)
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the actual asset type for a ticker, ignoring the LLM's
 * declaration if it conflicts with what the lookup tables know.
 *
 * Order of precedence:
 *   1. Explicit non-stock declaration ('crypto'/'forex') is trusted IF it lines up
 *      with a known mapping. If it doesn't, fall through to detection.
 *   2. isForexTicker() — if it's a known forex pair, use forex
 *   3. isCryptoTicker() — if it's a known crypto symbol, use crypto
 *   4. Otherwise fall back to stock
 */
export function resolveAssetType(ticker: string, declared?: string | null): AssetType {
  const upper = (ticker ?? '').toUpperCase()

  // Trust the declaration only if it matches a known mapping
  if (declared === 'crypto' && isCryptoTicker(upper)) return 'crypto'
  if (declared === 'forex' && isForexTicker(upper)) return 'forex'

  // Auto-detect by symbol shape — these checks are cheap (lookup tables)
  if (isForexTicker(upper)) return 'forex'
  if (isCryptoTicker(upper)) return 'crypto'

  // Fall back to stock — Finnhub is permissive with ticker symbols
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

function cacheKey(ticker: string, assetType: AssetType): string {
  return `${assetType}:${ticker.toUpperCase()}`
}

function getCached(ticker: string, assetType: AssetType): number | null {
  const entry = priceCache.get(cacheKey(ticker, assetType))
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    priceCache.delete(cacheKey(ticker, assetType))
    return null
  }
  return entry.price
}

function setCached(ticker: string, assetType: AssetType, price: number): void {
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
  const assetType = resolveAssetType(upper, declaredAssetType)
  const fetchedAt = new Date().toISOString()

  // Cache hit?
  const cached = getCached(upper, assetType)
  if (cached !== null) {
    return { ticker: upper, assetType, price: cached, fetchedAt, source: 'cache' }
  }

  let price: number | null = null
  let source: PriceLookup['source'] = 'failed'

  if (assetType === 'crypto') {
    const p = await fetchCryptoPrice(upper)
    if (p > 0) { price = p; source = 'coingecko' }
  } else if (assetType === 'forex') {
    const p = await fetchForexRate(upper)
    if (p > 0) { price = p; source = 'frankfurter' }
  } else {
    const p = await fetchStockPrice(upper)
    if (p !== null && p > 0) { price = p; source = 'finnhub' }
  }

  if (price !== null) {
    setCached(upper, assetType, price)
  }

  return { ticker: upper, assetType, price, fetchedAt, source }
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
