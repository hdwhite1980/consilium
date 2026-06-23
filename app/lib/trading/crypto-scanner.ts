// =============================================================
// app/lib/trading/crypto-scanner.ts (v2 — June 23 2026)
//
// FIX (v2): The previous version used /market/products/{id}/ticker
// which doesn't exist as a public endpoint. Only 12/30 symbols
// returned data. Plus MATIC renamed to POL, dropping more.
//
// v2 changes:
//   - Hits /market/products/{id} only (one call per symbol)
//   - Per-symbol error logging so failures aren't silent
//   - Universe pruned: MATIC removed (now POL), added POL/SHIB/PEPE
//   - cache-control: no-cache header for fresher data
//   - Returns failedSymbols in result for diagnostics
// =============================================================

const COINBASE_PUBLIC_BASE = 'https://api.coinbase.com/api/v3/brokerage'

// Curated universe of mainstream USD-quoted crypto on Coinbase.
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
  priceChange24h: number     // % change last 24h
  high24h: number
  low24h: number
  volume24h: number          // base volume
  volumeUsd24h: number       // approximate USD volume
  composite: number          // 0-100 score
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
}

export interface ScanOptions {
  universe?: readonly string[]
  minComposite?: number
  limit?: number
}

export async function runCryptoScan(options: ScanOptions = {}): Promise<ScanResult> {
  const universe = options.universe ?? DEFAULT_CRYPTO_UNIVERSE
  const minComposite = options.minComposite ?? 60
  const limit = options.limit ?? 20

  const results: CryptoTickerStats[] = []
  const failedSymbols: string[] = []
  let errors = 0

  const CONCURRENCY = 6
  for (let i = 0; i < universe.length; i += CONCURRENCY) {
    const batch = universe.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map(sym => fetchProductStats(sym).then(stats => ({ sym, stats })))
    )
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
        // Settled with rejection — we lost the symbol context
        failedSymbols.push('?')
      }
    }
  }

  if (failedSymbols.length > 0) {
    console.warn(`[crypto-scanner] ${failedSymbols.length}/${universe.length} symbols failed: ${failedSymbols.join(',')}`)
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
  }
}

/**
 * Fetch product info from Coinbase public endpoint.
 *
 * Endpoint: GET /api/v3/brokerage/market/products/{product_id}
 * Returns price, price_percentage_change_24h, volume_24h, and other fields
 * in a single call. No auth required.
 */
async function fetchProductStats(symbol: string): Promise<CryptoTickerStats | null> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8_000)
    const res = await fetch(`${COINBASE_PUBLIC_BASE}/market/products/${encodeURIComponent(symbol)}`, {
      signal: ctrl.signal,
      headers: { 'cache-control': 'no-cache' },
    })
    clearTimeout(timer)
    if (!res.ok) {
      console.warn(`[crypto-scanner] ${symbol}: HTTP ${res.status}`)
      return null
    }
    const product = await res.json() as Record<string, unknown>

    const currentPrice = Number(product.price ?? 0)
    if (!currentPrice || !Number.isFinite(currentPrice)) {
      console.warn(`[crypto-scanner] ${symbol}: missing/invalid price; product keys: ${Object.keys(product).slice(0, 10).join(',')}`)
      return null
    }

    // price_percentage_change_24h may come as "1.23" or "1.23%" string, or number
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

    // Approximate 24h high/low using % change (the products endpoint doesn't expose
    // explicit 24h_high/24h_low — these come from candles or stats endpoints).
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
      high24h,
      low24h,
      volume24h: baseVolume,
      volumeUsd24h: volumeUsd,
      composite,
      liquidityTier,
      direction,
      rangePositionPct: Math.round(rangePosition),
    }
  } catch (e) {
    console.warn(`[crypto-scanner] ${symbol} threw:`, e instanceof Error ? e.message : e)
    return null
  }
}
