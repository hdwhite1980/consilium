// =============================================================
// app/lib/trading/crypto-scanner.ts
//
// Crypto scanner. Fetches 24h ticker stats for a curated universe
// of liquid USD pairs and scores them by composite signal:
//   - Price change 24h (directional)
//   - Volume in USD (liquidity tier)
//   - Price action: short-term momentum vs daily range
//
// Output picks feed two places:
//   1. /api/cron/crypto-scanner-trade — triggers /api/analyze on top picks
//   2. /api/movers/crypto             — returns the ranked list for UI
//
// Universe: top crypto by market cap with liquid USD pairs on Coinbase.
// Hardcoded to start; can move to dynamic discovery once stable.
// =============================================================

const COINBASE_PUBLIC_BASE = 'https://api.coinbase.com/api/v3/brokerage'

// Curated universe of mainstream USD-quoted crypto on Coinbase.
// Ordered by market cap rank (mid-2026 approximate).
const DEFAULT_CRYPTO_UNIVERSE = [
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'ADA-USD', 'AVAX-USD',
  'DOGE-USD', 'LINK-USD', 'DOT-USD', 'MATIC-USD', 'LTC-USD', 'BCH-USD',
  'UNI-USD', 'ATOM-USD', 'XLM-USD', 'ETC-USD', 'FIL-USD', 'NEAR-USD',
  'APT-USD', 'ARB-USD', 'OP-USD', 'SUI-USD', 'INJ-USD', 'AAVE-USD',
  'MKR-USD', 'GRT-USD', 'CRV-USD', 'COMP-USD', 'SAND-USD', 'MANA-USD',
] as const

export interface CryptoTickerStats {
  symbol: string             // e.g. "BTC-USD"
  price: number              // current spot
  priceChange24h: number     // last 24h % change
  high24h: number
  low24h: number
  volume24h: number          // base volume
  volumeUsd24h: number       // approximate dollar volume
  composite: number          // 0-100 score
  liquidityTier: 'mega' | 'large' | 'mid' | 'small'
  direction: 'bullish' | 'bearish' | 'neutral'
  rangePositionPct: number   // where in 24h range (0 = at low, 100 = at high)
}

export interface ScanResult {
  picks: CryptoTickerStats[]
  fetchedAt: string
  universeSize: number
  errors: number
}

export interface ScanOptions {
  universe?: readonly string[]   // override the default universe
  minComposite?: number          // filter picks below this score (default 60)
  limit?: number                 // max picks returned (default 20)
}

/**
 * Scan a list of crypto products via Coinbase public ticker endpoint.
 * Public endpoints don't require JWT auth so this works without credentials.
 */
export async function runCryptoScan(options: ScanOptions = {}): Promise<ScanResult> {
  const universe = options.universe ?? DEFAULT_CRYPTO_UNIVERSE
  const minComposite = options.minComposite ?? 60
  const limit = options.limit ?? 20

  const results: CryptoTickerStats[] = []
  let errors = 0

  // Coinbase public stats endpoint: /products/{product_id}/stats
  // Fetch all in parallel with a concurrency cap.
  const CONCURRENCY = 10
  for (let i = 0; i < universe.length; i += CONCURRENCY) {
    const batch = universe.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(batch.map(sym => fetchProductStats(sym)))
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value !== null) {
        results.push(r.value)
      } else {
        errors++
      }
    }
  }

  // Filter and sort by composite
  const filtered = results
    .filter(r => r.composite >= minComposite)
    .sort((a, b) => b.composite - a.composite)
    .slice(0, limit)

  return {
    picks: filtered,
    fetchedAt: new Date().toISOString(),
    universeSize: universe.length,
    errors,
  }
}

/**
 * Fetch ticker + 24h stats from Coinbase public endpoints (no auth required).
 * Returns null on failure.
 */
async function fetchProductStats(symbol: string): Promise<CryptoTickerStats | null> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8_000)
    const [productRes, statsRes] = await Promise.all([
      fetch(`${COINBASE_PUBLIC_BASE}/market/products/${encodeURIComponent(symbol)}`, { signal: ctrl.signal }),
      fetch(`${COINBASE_PUBLIC_BASE}/market/products/${encodeURIComponent(symbol)}/ticker?limit=1`, { signal: ctrl.signal }),
    ])
    clearTimeout(timer)
    if (!productRes.ok || !statsRes.ok) return null

    const product = await productRes.json() as {
      price?: string
      price_percentage_change_24h?: string
      volume_24h?: string
      volume_percentage_change_24h?: string
      base_increment?: string
      quote_increment?: string
    }
    const ticker = await statsRes.json() as {
      trades?: Array<{ price?: string; size?: string }>
      price?: string
    }

    const currentPrice = Number(product.price ?? ticker.price ?? (ticker.trades?.[0]?.price ?? 0))
    if (!currentPrice || !Number.isFinite(currentPrice)) return null

    const change24hPct = Number(product.price_percentage_change_24h ?? 0)
    const baseVolume = Number(product.volume_24h ?? 0)
    const volumeUsd = baseVolume * currentPrice

    // Range position approx: without explicit high/low24h from this endpoint,
    // we approximate using current vs assumed range. If unavailable, use 50.
    // (Full bar data would be better but adds another API call per ticker.)
    const high24h = currentPrice * (1 + Math.max(0, change24hPct) / 100 + 0.01)
    const low24h = currentPrice * (1 - Math.max(0, -change24hPct) / 100 - 0.01)
    const rangeSize = high24h - low24h
    const rangePosition = rangeSize > 0 ? ((currentPrice - low24h) / rangeSize) * 100 : 50

    const liquidityTier = volumeUsd >= 1_000_000_000 ? 'mega'
                        : volumeUsd >= 100_000_000  ? 'large'
                        : volumeUsd >= 10_000_000   ? 'mid'
                        : 'small'

    const direction: 'bullish' | 'bearish' | 'neutral' = 
      change24hPct >= 1.5 ? 'bullish'
      : change24hPct <= -1.5 ? 'bearish'
      : 'neutral'

    // Composite score 0-100:
    //   Strong directional move (40 pts max)
    //   Volume tier (30 pts max)
    //   Range position aligned with direction (20 pts max)
    //   Bonus for liquid + directional (10 pts)
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
  } catch {
    return null
  }
}
