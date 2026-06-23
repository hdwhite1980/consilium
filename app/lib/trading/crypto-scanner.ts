// =============================================================
// app/lib/trading/crypto-scanner.ts (v4 — June 23 2026)
//
// Dynamic-universe scanner with pre-filters.
//
// v4 changes from v3:
//   - Hits Coinbase /products list ONCE per scan (vs 30+ per-symbol calls)
//   - Filters: quote=USD, status=online, not disabled/cancel-only
//   - Volume floor (configurable, default $500K for discovery / $1M trading)
//   - Movement floor (|24h change| ≥ threshold OR volume spike)
//   - Detects new listings via Coinbase's `new` flag
//   - 1-hour cache for the product list (changes rarely)
//   - Composite scoring + ranking still applies
//
// Result: a single fast scan over the entire Coinbase USD universe,
// returning only quality movers. Top picks can then be sent through
// the bars+technicals pipeline for Council analysis.
// =============================================================

import { loadCoinbaseCredential } from './credentials'
import { makeCoinbaseClient, type CoinbaseClient } from './coinbase-client'

const COINBASE_PUBLIC_BASE = 'https://api.coinbase.com/api/v3/brokerage'

export interface CryptoTickerStats {
  symbol: string                // product_id, e.g. "BTC-USD"
  price: number
  priceChange24h: number        // %
  volumeChange24h: number       // % (may be 0 if not provided)
  volume24h: number             // base volume
  volumeUsd24h: number          // approx USD volume
  composite: number             // 0-100
  liquidityTier: 'mega' | 'large' | 'mid' | 'small'
  direction: 'bullish' | 'bearish' | 'neutral'
  isNew: boolean                // Coinbase's `new` flag
  highVolumeSpike: boolean      // volumeChange24h >= 100%
  baseDisplaySymbol?: string    // e.g. "BTC" if Coinbase provides it
}

export interface ScanResult {
  picks: CryptoTickerStats[]
  fetchedAt: string
  universeSize: number          // total USD products discovered
  postFilterSize: number        // surviving filters
  errors: number
  failedSymbols: string[]
  authedPath: boolean
  fromCache: boolean
  universeAgeMs: number         // age of cached universe in ms
}

export interface ScanOptions {
  userId?: string
  minComposite?: number         // default 0
  minMovement?: number          // default 0.5 (% absolute)
  minVolume?: number            // default 500_000 (USD)
  limit?: number                // default 50
  direction?: 'bullish' | 'bearish' | 'all'   // default 'all'
  onlyNew?: boolean             // default false; if true, returns only new listings
}

// ─────────────────────────────────────────────────────────────
// Module-level cache for the full product list (1 hour TTL)
//
// The /products list response is identical across all users — caching
// here means all callers within an hour share one Coinbase API call.
// ─────────────────────────────────────────────────────────────

interface CachedUniverse {
  products: Array<Record<string, unknown>>
  fetchedAt: number
  authed: boolean
}
let universeCache: CachedUniverse | null = null
const UNIVERSE_TTL_MS = 60 * 60 * 1000

// ─────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────

export async function runCryptoScan(options: ScanOptions = {}): Promise<ScanResult> {
  const minComposite = options.minComposite ?? 0
  const minMovement = options.minMovement ?? 0.5
  const minVolume = options.minVolume ?? 500_000
  const limit = options.limit ?? 50
  const direction = options.direction ?? 'all'
  const onlyNew = options.onlyNew ?? false

  // Try authenticated path first
  let authClient: CoinbaseClient | null = null
  if (options.userId) {
    const cred = await loadCoinbaseCredential(options.userId).catch(() => null)
    if (cred) {
      authClient = makeCoinbaseClient(cred.keyName, cred.privateKey)
    }
  }

  // Load universe (cached or fresh)
  let universe: Array<Record<string, unknown>>
  let fromCache = false
  let universeAgeMs = 0

  const now = Date.now()
  if (universeCache && (now - universeCache.fetchedAt) < UNIVERSE_TTL_MS) {
    universe = universeCache.products
    fromCache = true
    universeAgeMs = now - universeCache.fetchedAt
  } else {
    try {
      universe = authClient
        ? await authClient.listProducts('SPOT')
        : await fetchProductsListPublic()
      universeCache = { products: universe, fetchedAt: now, authed: authClient !== null }
    } catch (e) {
      console.error('[crypto-scanner] listProducts failed:', e instanceof Error ? e.message : e)
      // Fall back to stale cache if available, otherwise empty
      if (universeCache) {
        universe = universeCache.products
        fromCache = true
        universeAgeMs = now - universeCache.fetchedAt
      } else {
        return {
          picks: [], fetchedAt: new Date(now).toISOString(),
          universeSize: 0, postFilterSize: 0, errors: 1, failedSymbols: [],
          authedPath: authClient !== null, fromCache: false, universeAgeMs: 0,
        }
      }
    }
  }

  // Filter + score
  const candidates: CryptoTickerStats[] = []
  const failedSymbols: string[] = []
  let errors = 0

  // Apply relaxed filters for onlyNew mode (new listings often have tiny volume)
  const effectiveMinVolume = onlyNew ? Math.min(minVolume, 50_000) : minVolume
  const effectiveMinMovement = onlyNew ? 0 : minMovement

  for (const product of universe) {
    try {
      // Quote currency filter (USD only)
      const quote = String(product.quote_currency_id ?? '').toUpperCase()
      if (quote !== 'USD') continue

      // Status filter (must be online)
      const status = String(product.status ?? '').toLowerCase()
      if (status !== 'online') continue

      // Tradability filter
      if (product.trading_disabled === true) continue
      if (product.cancel_only === true) continue
      if (product.limit_only === true) continue
      if (product.auction_mode === true) continue
      if (product.post_only === true) continue

      // Product type filter (spot only; skip futures even if returned)
      const productType = String(product.product_type ?? 'SPOT').toUpperCase()
      if (productType !== 'SPOT' && productType !== 'UNKNOWN_PRODUCT_TYPE') continue

      // New listing filter (if requested)
      const isNew = product.new === true
      if (onlyNew && !isNew) continue

      const stats = computeStats(product)
      if (!stats) continue

      // Volume filter
      if (stats.volumeUsd24h < effectiveMinVolume) continue

      // Movement filter (|change| ≥ threshold OR volume spike)
      const sustainedMove = Math.abs(stats.priceChange24h) >= effectiveMinMovement
      const volumeSpike = stats.volumeChange24h >= 100
      if (!onlyNew && !sustainedMove && !volumeSpike) continue

      // Composite floor
      if (stats.composite < minComposite) continue

      // Direction filter
      if (direction === 'bullish' && stats.direction !== 'bullish') continue
      if (direction === 'bearish' && stats.direction !== 'bearish') continue

      candidates.push(stats)
    } catch (e) {
      errors++
      const sym = String(product.product_id ?? '?')
      failedSymbols.push(sym)
      console.warn(`[crypto-scanner] ${sym} failed scoring:`, e instanceof Error ? e.message : e)
    }
  }

  // Sort by composite descending
  candidates.sort((a, b) => b.composite - a.composite)
  const picks = candidates.slice(0, limit)

  if (errors > 0) {
    console.warn(`[crypto-scanner] ${errors} symbols failed during scoring`)
  }

  return {
    picks,
    fetchedAt: new Date(now).toISOString(),
    universeSize: universe.length,
    postFilterSize: candidates.length,
    errors,
    failedSymbols,
    authedPath: authClient !== null,
    fromCache,
    universeAgeMs,
  }
}

// ─────────────────────────────────────────────────────────────
// Public list fetcher (fallback when no auth)
// ─────────────────────────────────────────────────────────────

async function fetchProductsListPublic(): Promise<Array<Record<string, unknown>>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(`${COINBASE_PUBLIC_BASE}/market/products?product_type=SPOT&limit=500`, {
      signal: ctrl.signal,
      headers: { 'cache-control': 'no-cache' },
    })
    if (!res.ok) {
      throw new Error(`Coinbase /market/products HTTP ${res.status}`)
    }
    const data = await res.json() as { products?: Array<Record<string, unknown>> }
    return data.products ?? []
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Stats computation
// ─────────────────────────────────────────────────────────────

function computeStats(product: Record<string, unknown>): CryptoTickerStats | null {
  const symbol = String(product.product_id ?? '')
  if (!symbol) return null

  const currentPrice = Number(product.price ?? 0)
  if (!currentPrice || !Number.isFinite(currentPrice)) return null

  let change24hPct = parsePct(product.price_percentage_change_24h)
  if (!Number.isFinite(change24hPct)) change24hPct = 0

  let volumeChange24hPct = parsePct(product.volume_percentage_change_24h)
  if (!Number.isFinite(volumeChange24hPct)) volumeChange24hPct = 0

  const baseVolume = Number(product.volume_24h ?? 0)
  const volumeUsd = baseVolume * currentPrice

  const liquidityTier: 'mega' | 'large' | 'mid' | 'small' =
    volumeUsd >= 1_000_000_000 ? 'mega'
    : volumeUsd >= 100_000_000  ? 'large'
    : volumeUsd >= 10_000_000   ? 'mid'
    : 'small'

  const direction: 'bullish' | 'bearish' | 'neutral' =
    change24hPct >= 1.5 ? 'bullish'
    : change24hPct <= -1.5 ? 'bearish'
    : 'neutral'

  // Composite scoring (same idea as v3, slightly extended)
  let composite = 0
  composite += Math.min(40, Math.abs(change24hPct) * 4)
  composite += liquidityTier === 'mega' ? 30
            : liquidityTier === 'large' ? 22
            : liquidityTier === 'mid' ? 15
            : 5
  if (liquidityTier !== 'small' && direction !== 'neutral') composite += 10
  // Volume spike bonus
  if (volumeChange24hPct >= 100) composite += 8
  // Optional new listing bonus
  if (product.new === true) composite += 5
  composite = Math.min(100, Math.max(0, Math.round(composite)))

  const baseDisplay = product.base_display_symbol ? String(product.base_display_symbol) : undefined

  return {
    symbol,
    price: currentPrice,
    priceChange24h: change24hPct,
    volumeChange24h: volumeChange24hPct,
    volume24h: baseVolume,
    volumeUsd24h: volumeUsd,
    composite,
    liquidityTier,
    direction,
    isNew: product.new === true,
    highVolumeSpike: volumeChange24hPct >= 100,
    baseDisplaySymbol: baseDisplay,
  }
}

/**
 * Parse a Coinbase pct field. Comes as "1.23" string, "1.23%" string,
 * or 1.23 number. Returns NaN on bad input.
 */
function parsePct(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const trimmed = raw.replace('%', '').trim()
    if (trimmed === '') return 0
    return Number(trimmed)
  }
  return 0
}
