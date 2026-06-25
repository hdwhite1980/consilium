// ─────────────────────────────────────────────────────────────
// Crypto Data Fetcher
// Primary:  CoinGecko free API (no key required, 30 req/min)
// Fallback: Alpaca Crypto API (free tier, real-time)
// ─────────────────────────────────────────────────────────────

import type { AlpacaBar } from './alpaca'
import { fetchCryptoBars as fetchCoinbaseCandles, type CryptoGranularity } from '@/app/lib/trading/crypto-bars'
import { isCryptoPairSymbol, toCoinbaseProduct } from '@/app/lib/crypto-symbol'

// Map common crypto tickers to CoinGecko IDs
const COINGECKO_IDS: Record<string, string> = {
  BTC:   'bitcoin',
  ETH:   'ethereum',
  SOL:   'solana',
  BNB:   'binancecoin',
  XRP:   'ripple',
  ADA:   'cardano',
  AVAX:  'avalanche-2',
  DOGE:  'dogecoin',
  DOT:   'polkadot',
  MATIC: 'matic-network',
  LINK:  'chainlink',
  LTC:   'litecoin',
  UNI:   'uniswap',
  ATOM:  'cosmos',
  XLM:   'stellar',
  ALGO:  'algorand',
  VET:   'vechain',
  FIL:   'filecoin',
  TRX:   'tron',
  NEAR:  'near',
  APT:   'aptos',
  ARB:   'arbitrum',
  OP:    'optimism',
  INJ:   'injective-protocol',
  SUI:   'sui',
}

// Also accept BTCUSD, ETHUSD, BTC-USD, BTC/USD formats
function normalizeCryptoTicker(ticker: string): string {
  return ticker.toUpperCase().replace(/[-/]/g, '').replace(/(USDT|USDC|USD)$/, '')
}

// Crypto recognition is now structural (any BASE+USD pair that isn't fiat/metal),
// covering the full Coinbase universe — not just the COINGECKO_IDS shortlist,
// which is now only used for CoinGecko metadata/fallback lookups.
export function isCryptoTicker(ticker: string): boolean {
  return isCryptoPairSymbol(ticker)
}

function getCoinGeckoId(ticker: string): string | null {
  const normalized = normalizeCryptoTicker(ticker)
  return COINGECKO_IDS[normalized] ?? null
}

// CoinGecko free API — no key needed
async function fetchCoinGeckoBars(coinId: string, days: number): Promise<AlpacaBar[]> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`,
      { next: { revalidate: 300 } }
    )
    if (!res.ok) return []
    const data: number[][] = await res.json()
    // CoinGecko OHLC format: [timestamp, open, high, low, close]
    return data.map(([t, o, h, l, c]) => ({
      t: new Date(t).toISOString(),
      o, h, l, c,
      v: 0, // CoinGecko OHLC doesn't include volume in this endpoint
    }))
  } catch {
    return []
  }
}

// CoinGecko market chart for volume data
async function fetchCoinGeckoMarketChart(coinId: string, days: number): Promise<{ prices: [number,number][]; total_volumes: [number,number][] }> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
      { next: { revalidate: 300 } }
    )
    if (!res.ok) return { prices: [], total_volumes: [] }
    return await res.json()
  } catch {
    return { prices: [], total_volumes: [] }
  }
}

// Alpaca crypto bars as fallback
async function fetchAlpacaCryptoBars(ticker: string, timeframe: string, daysBack: number): Promise<AlpacaBar[]> {
  try {
    const BASE = process.env.ALPACA_BASE_URL || 'https://data.alpaca.markets'
    const headers = {
      'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
      'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
    }
    const symbol = `${normalizeCryptoTicker(ticker)}/USD`
    const end = new Date().toISOString()
    const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()

    const tfMap: Record<string, string> = {
      '1D': '1Hour', '1W': '1Day', '1M': '1Day', '3M': '1Day'
    }
    const tf = tfMap[timeframe] ?? '1Day'

    const res = await fetch(
      `${BASE}/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(symbol)}&timeframe=${tf}&start=${start}&end=${end}&limit=10000`,
      { headers, next: { revalidate: 300 } }
    )
    if (!res.ok) return []
    const data = await res.json()
    const bars = data.bars?.[symbol] ?? []
    return bars.map((b: { t: string; o: number; h: number; l: number; c: number; v: number }) => ({
      t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v
    }))
  } catch {
    return []
  }
}

// Fetch current crypto price from CoinGecko
export async function fetchCryptoPrice(ticker: string): Promise<number> {
  // PRIMARY: latest Coinbase 1-minute candle close — works for any listed coin.
  try {
    const usdProduct = toCoinbaseProduct(ticker)
    for (const product of [usdProduct, usdProduct.replace(/-USD$/, '-USDC')]) {
      const bars = await fetchCoinbaseCandles({ symbol: product, granularity: 'ONE_MINUTE', limit: 1 })
      const last = bars[bars.length - 1]
      if (last && last.c > 0) return last.c
    }
  } catch {
    // fall through to CoinGecko
  }

  // FALLBACK: CoinGecko simple price (known coins only).
  const coinId = getCoinGeckoId(ticker)
  if (!coinId) return 0
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      { next: { revalidate: 60 } }
    )
    if (!res.ok) return 0
    const data = await res.json()
    return data[coinId]?.usd ?? 0
  } catch {
    return 0
  }
}

// Main function — get OHLCV bars for crypto
// Coinbase candle config per Council timeframe. Coinbase candles cover the
// full product universe, so any scanner-surfaced coin gets real chart data.
const CB_BARS: Record<string, { granularity: CryptoGranularity; limit: number }> = {
  '1D': { granularity: 'ONE_HOUR', limit: 72 },
  '1W': { granularity: 'ONE_HOUR', limit: 168 },
  '1M': { granularity: 'ONE_DAY', limit: 35 },
  '3M': { granularity: 'ONE_DAY', limit: 95 },
}

// Fetch bars from Coinbase for the Council. Tries the -USD product first,
// then -USDC (some coins are only quoted in USDC). Returns AlpacaBar shape.
async function fetchCoinbaseBarsForCouncil(ticker: string, timeframe: string): Promise<AlpacaBar[]> {
  const cfg = CB_BARS[timeframe] ?? CB_BARS['1M']
  const usdProduct = toCoinbaseProduct(ticker)                 // "BTC-USD"
  const candidates = [usdProduct, usdProduct.replace(/-USD$/, '-USDC')]
  for (const product of candidates) {
    try {
      const bars = await fetchCoinbaseCandles({ symbol: product, granularity: cfg.granularity, limit: cfg.limit })
      if (bars.length >= 10) {
        return bars.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })) as AlpacaBar[]
      }
    } catch {
      // try next candidate / fall through to CoinGecko
    }
  }
  return []
}

export async function fetchCryptoBars(ticker: string, timeframe: string): Promise<AlpacaBar[]> {
  // PRIMARY: Coinbase candles — full product universe, same feed the scanner
  // and position monitor use, so the Council no longer disagrees with them and
  // less-public coins (outside COINGECKO_IDS) now get real chart data.
  const cb = await fetchCoinbaseBarsForCouncil(ticker, timeframe)
  if (cb.length >= 10) return cb

  // FALLBACK: CoinGecko (known coins only) for resilience if a Coinbase candle
  // call fails transiently.
  const coinId = getCoinGeckoId(ticker)
  const daysMap: Record<string, number> = { '1D': 1, '1W': 7, '1M': 30, '3M': 90 }
  const days = daysMap[timeframe] ?? 30
  if (coinId) {
    const ohlcBars = await fetchCoinGeckoBars(coinId, days)
    if (ohlcBars.length >= 10) {
      try {
        const chart = await fetchCoinGeckoMarketChart(coinId, days)
        const volMap = new Map(chart.total_volumes.map(([t, v]) => [
          new Date(t).toISOString().split('T')[0], v
        ]))
        return ohlcBars.map(bar => ({
          ...bar,
          v: volMap.get(bar.t.split('T')[0]) ?? 0
        }))
      } catch {
        return ohlcBars
      }
    }
  }

  // LAST RESORT: Alpaca crypto bars (legacy).
  const alpacaBars = await fetchAlpacaCryptoBars(ticker, timeframe, (daysMap[timeframe] ?? 30) * 3)
  if (alpacaBars.length >= 10) return alpacaBars

  return []
}

// Get extended crypto metadata from CoinGecko
// When CoinGecko has no entry for a coin, derive the fields Coinbase CAN
// provide from candles: 24h/7d price change and 24h USD volume. Market cap,
// circulating supply, and ATH are tokenomics data Coinbase does not expose,
// so those remain null.
async function fetchCoinbaseMetaFallback(ticker: string): Promise<{
  priceChange24h: number | null
  priceChange7d: number | null
  volume24h: number | null
  name: string
}> {
  const base = toCoinbaseProduct(ticker).replace(/-USD$/, '')
  const empty = { priceChange24h: null, priceChange7d: null, volume24h: null, name: base }
  for (const product of [`${base}-USD`, `${base}-USDC`]) {
    try {
      const bars = await fetchCoinbaseCandles({ symbol: product, granularity: 'ONE_HOUR', limit: 168 })
      if (bars.length < 2) continue
      const last = bars[bars.length - 1].c
      const c24 = bars[Math.max(0, bars.length - 1 - 24)].c
      const c7d = bars[0].c
      const vol24Base = bars.slice(Math.max(0, bars.length - 24)).reduce((s, b) => s + b.v, 0)
      return {
        priceChange24h: c24 > 0 ? ((last - c24) / c24) * 100 : null,
        priceChange7d: c7d > 0 ? ((last - c7d) / c7d) * 100 : null,
        volume24h: last > 0 ? vol24Base * last : null,
        name: base,
      }
    } catch {
      // try next product / fall through
    }
  }
  return empty
}

export async function fetchCryptoMetadata(ticker: string): Promise<{
  marketCap: number | null
  volume24h: number | null
  circulatingSupply: number | null
  priceChange24h: number | null
  priceChange7d: number | null
  ath: number | null
  athChangePercent: number | null
  name: string
  description: string
}> {
  const empty = { marketCap: null, volume24h: null, circulatingSupply: null, priceChange24h: null, priceChange7d: null, ath: null, athChangePercent: null, name: ticker, description: '' }
  const coinId = getCoinGeckoId(ticker)

  let cg = empty
  if (coinId) {
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`,
        { next: { revalidate: 600 } }
      )
      if (res.ok) {
        const d = await res.json()
        cg = {
          name: d.name ?? ticker,
          description: d.description?.en?.slice(0, 300) ?? '',
          marketCap: d.market_data?.market_cap?.usd ?? null,
          volume24h: d.market_data?.total_volume?.usd ?? null,
          circulatingSupply: d.market_data?.circulating_supply ?? null,
          priceChange24h: d.market_data?.price_change_percentage_24h ?? null,
          priceChange7d: d.market_data?.price_change_percentage_7d ?? null,
          ath: d.market_data?.ath?.usd ?? null,
          athChangePercent: d.market_data?.ath_change_percentage?.usd ?? null,
        }
      }
    } catch {
      cg = empty
    }
  }

  // If CoinGecko lacked the coin (less-public), backfill the price/volume
  // fields from Coinbase candles. Cap/supply/ATH stay null (no Coinbase source).
  if (cg.priceChange24h === null || cg.volume24h === null) {
    const cb = await fetchCoinbaseMetaFallback(ticker)
    return {
      ...cg,
      priceChange24h: cg.priceChange24h ?? cb.priceChange24h,
      priceChange7d: cg.priceChange7d ?? cb.priceChange7d,
      volume24h: cg.volume24h ?? cb.volume24h,
      name: cg.name && cg.name !== ticker ? cg.name : cb.name,
    }
  }

  return cg
}
