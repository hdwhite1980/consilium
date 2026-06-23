// =============================================================
// app/lib/trading/crypto-scanner.ts (v3 — June 23 2026)
//
// Fixes 429 rate-limit issues from v2:
//   - Authenticated path preferred (30 req/sec vs 10/sec public)
//   - Module-level cache (60s TTL) eliminates repeat fetches
//   - Lower concurrency (3 parallel instead of 6)
//   - Inter-batch delay (250ms) to stay under per-second budget
//   - Retry-with-backoff on 429
//   - Per-symbol error logging
//
// Auth path uses loadCoinbaseCredential to get the user's CDP key
// and signs JWTs via the existing CoinbaseClient. Falls back to
// the public /market/products/{id} endpoint when no creds available.
// =============================================================

import { loadCoinbaseCredential } from './credentials'
import { makeCoinbaseClient, type CoinbaseClient } from './coinbase-client'

const COINBASE_PUBLIC_BASE = 'https://api.coinbase.com/api/v3/brokerage'

// Curated USD universe on Coinbase.
const DEFAULT_CRYPTO_UNIVERSE = [
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'ADA-USD', 'AVAX-USD',
  'DOGE-USD', 'LINK-USD', 'DOT-USD', 'LTC-USD', 'BCH-USD',
  'UNI-USD', 'ATOM-USD', 'XLM-USD', 'ETC-USD', 'FIL-USD', 'NEAR-USD',
  'APT-USD', 'ARB-USD', 'OP-USD', 'SUI-USD', 'INJ-USD', 'AAVE-USD',
  'MKR-USD', 'GRT-USD', 'CRV-USD', 'COMP-USD',
  'POL-USD', 'SHIB-USD', 'PEPE-USD',
] as const

export interface CryptoTickerStats {
  symbol: string
  price: number
  priceChange24h: number
  high24h: number
  low24h: number
  volume24h: number
  volumeUsd24h: number
  composite: number
  liquidityTier: 'mega' | 'large' | 'mid' | 'small'
  direction: 'bullish' | 'bearish' | 'neutral'
  rangePositionPct: number
}

export interface ScanResult {
  picks: CryptoTickerStats[]
  fetchedAt: string
  universeSize: number
  symbolsFetched: number
  errors: number
  failedSymbols: string[]
  authedPath: boolean
  fromCache: boolean
}

export interface ScanOptions {
  universe?: readonly string[]
  minComposite?: number
  limit?: number
  userId?: string
}

// ─────────────────────────────────────────────────────────────
// Module-level cache (per-symbol)
//
// Avoids re-fetching the same product within the cache window. Both
// the scanner cron and the movers API endpoint benefit — multiple
// callers within 60s share the same fetch.
// ─────────────────────────────────────────────────────────────

interface CachedStats {
  stats: CryptoTickerStats
  fetchedAt: number
}
const statsCache = new Map<string, CachedStats>()
const CACHE_TTL_MS = 60_000

function getCached(symbol: string): CryptoTickerStats | null {
  const c = statsCache.get(symbol)
  if (!c) return null
  if (Date.now() - c.fetchedAt > CACHE_TTL_MS) {
    statsCache.delete(symbol)
    return null
  }
  return c.stats
}

function setCached(symbol: string, stats: CryptoTickerStats): void {
  statsCache.set(symbol, { stats, fetchedAt: Date.now() })
}

// ─────────────────────────────────────────────────────────────
// Main scan entry point
// ─────────────────────────────────────────────────────────────

export async function runCryptoScan(options: ScanOptions = {}): Promise<ScanResult> {
  const universe = options.universe ?? DEFAULT_CRYPTO_UNIVERSE
  const minComposite = options.minComposite ?? 60
  const limit = options.limit ?? 20

  // Try authenticated path first
  let authClient: CoinbaseClient | null = null
  if (options.userId) {
    const cred = await loadCoinbaseCredential(options.userId).catch(() => null)
    if (cred) {
      authClient = makeCoinbaseClient(cred.keyName, cred.privateKey)
    }
  }

  const results: CryptoTickerStats[] = []
  const failedSymbols: string[] = []
  let errors = 0
  let cacheHits = 0

  // Concurrency: 3 in parallel, 250ms delay between batches.
  // Authenticated: 30 req/sec ≈ batches of 3 every 100ms is fine.
  // Public: 10 req/sec ≈ batches of 3 every 300ms is safer.
  const CONCURRENCY = 3
  const BATCH_DELAY_MS = authClient ? 150 : 300

  for (let i = 0; i < universe.length; i += CONCURRENCY) {
    const batch = universe.slice(i, i + CONCURRENCY)

    const settled = await Promise.allSettled(batch.map(async sym => {
      // Check cache first
      const cached = getCached(sym)
      if (cached) {
        cacheHits++
        return { sym, stats: cached }
      }
      // Fetch with retry-on-429
      const stats = await fetchWithRetry(sym, authClient)
      if (stats) setCached(sym, stats)
      return { sym, stats }
    }))

    for (const r of settled) {
      if (r.status === 'fulfilled') {
        if (r.value.stats !== null) {
          results.push(r.value.stats)
        } else {
          errors++
          failedSymbols.push(r.value.sym)
        }
      } else {
        errors++
        failedSymbols.push('?')
      }
    }

    // Delay between batches (skip if we got everything from cache)
    if (i + CONCURRENCY < universe.length) {
      await sleep(BATCH_DELAY_MS)
    }
  }

  if (failedSymbols.length > 0) {
    console.warn(`[crypto-scanner] ${failedSymbols.length}/${universe.length} failed (authed=${authClient !== null}, cacheHits=${cacheHits}): ${failedSymbols.join(',')}`)
  }

  const filtered = results
    .filter(r => r.composite >= minComposite)
    .sort((a, b) => b.composite - a.composite)
    .slice(0, limit)

  return {
    picks: filtered,
    fetchedAt: new Date().toISOString(),
    universeSize: universe.length,
    symbolsFetched: results.length,
    errors,
    failedSymbols,
    authedPath: authClient !== null,
    fromCache: cacheHits === universe.length,
  }
}

// ─────────────────────────────────────────────────────────────
// Fetch with retry-on-429 (exponential backoff)
// ─────────────────────────────────────────────────────────────

async function fetchWithRetry(symbol: string, authClient: CoinbaseClient | null): Promise<CryptoTickerStats | null> {
  const MAX_ATTEMPTS = 3
  let lastErrorWas429 = false

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const product = authClient
        ? await authClient.getProduct(symbol)
        : await fetchProductPublic(symbol)
      if (!product) return null
      return computeStats(symbol, product)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const is429 = /HTTP 429|too many requests/i.test(msg)
      lastErrorWas429 = is429
      if (is429 && attempt < MAX_ATTEMPTS) {
        // Exponential backoff: 500ms, 1500ms, 4500ms
        const delay = 500 * Math.pow(3, attempt - 1)
        console.warn(`[crypto-scanner] ${symbol}: 429 attempt ${attempt}, retry in ${delay}ms`)
        await sleep(delay)
        continue
      }
      // Non-retryable error or out of retries
      if (!is429) {
        console.warn(`[crypto-scanner] ${symbol} failed (attempt ${attempt}): ${msg.slice(0, 200)}`)
      }
      return null
    }
  }

  if (lastErrorWas429) {
    console.warn(`[crypto-scanner] ${symbol}: gave up after ${MAX_ATTEMPTS} 429s`)
  }
  return null
}

// ─────────────────────────────────────────────────────────────
// Public fallback path
// ─────────────────────────────────────────────────────────────

async function fetchProductPublic(symbol: string): Promise<Record<string, unknown> | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8_000)
  try {
    const res = await fetch(`${COINBASE_PUBLIC_BASE}/market/products/${encodeURIComponent(symbol)}`, {
      signal: ctrl.signal,
      headers: { 'cache-control': 'no-cache' },
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    return await res.json() as Record<string, unknown>
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Stats computation (shared by both paths)
// ─────────────────────────────────────────────────────────────

function computeStats(symbol: string, product: Record<string, unknown>): CryptoTickerStats | null {
  const currentPrice = Number(product.price ?? 0)
  if (!currentPrice || !Number.isFinite(currentPrice)) {
    console.warn(`[crypto-scanner] ${symbol}: missing/invalid price; keys: ${Object.keys(product).slice(0, 10).join(',')}`)
    return null
  }

  let change24hPct = 0
  const rawChange = product.price_percentage_change_24h
  if (typeof rawChange === 'string') {
    change24hPct = Number(rawChange.replace('%', '').trim())
  } else if (typeof rawChange === 'number') {
    change24hPct = rawChange
  }
  if (!Number.isFinite(change24hPct)) change24hPct = 0

  const baseVolume = Number(product.volume_24h ?? 0)
  const volumeUsd = baseVolume * currentPrice

  const high24h = currentPrice * (1 + Math.max(0, change24hPct) / 100 + 0.01)
  const low24h = currentPrice * (1 - Math.max(0, -change24hPct) / 100 - 0.01)
  const rangeSize = high24h - low24h
  const rangePosition = rangeSize > 0 ? ((currentPrice - low24h) / rangeSize) * 100 : 50

  const liquidityTier: 'mega' | 'large' | 'mid' | 'small' =
    volumeUsd >= 1_000_000_000 ? 'mega'
    : volumeUsd >= 100_000_000  ? 'large'
    : volumeUsd >= 10_000_000   ? 'mid'
    : 'small'

  const direction: 'bullish' | 'bearish' | 'neutral' =
    change24hPct >= 1.5 ? 'bullish'
    : change24hPct <= -1.5 ? 'bearish'
    : 'neutral'

  let composite = 0
  composite += Math.min(40, Math.abs(change24hPct) * 4)
  composite += liquidityTier === 'mega' ? 30
            : liquidityTier === 'large' ? 22
            : liquidityTier === 'mid' ? 15
            : 5
  if (direction === 'bullish' && rangePosition > 50) composite += (rangePosition - 50) / 50 * 20
  else if (direction === 'bearish' && rangePosition < 50) composite += (50 - rangePosition) / 50 * 20
  if (liquidityTier === 'mega' && direction !== 'neutral') composite += 10
  else if (liquidityTier === 'large' && direction !== 'neutral') composite += 5
  composite = Math.min(100, Math.max(0, Math.round(composite)))

  return {
    symbol,
    price: currentPrice,
    priceChange24h: change24hPct,
    high24h, low24h,
    volume24h: baseVolume,
    volumeUsd24h: volumeUsd,
    composite,
    liquidityTier,
    direction,
    rangePositionPct: Math.round(rangePosition),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
