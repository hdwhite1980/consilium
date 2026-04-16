// ─────────────────────────────────────────────────────────────
// Crypto Data Fetcher
// Primary:  CoinGecko free API (no key required, 30 req/min)
// Fallback: Alpaca Crypto API (free tier, real-time)
// ─────────────────────────────────────────────────────────────

import type { AlpacaBar } from './alpaca'

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

// Also accept BTCUSD, ETHUSD etc formats
function normalizeCryptoTicker(ticker: string): string {
  return ticker.replace(/USD$/, '').replace(/USDT$/, '').replace(/USDC$/, '').toUpperCase()
}

export function isCryptoTicker(ticker: string): boolean {
  const normalized = normalizeCryptoTicker(ticker)
  return normalized in COINGECKO_IDS
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
export async function fetchCryptoBars(ticker: string, timeframe: string): Promise<AlpacaBar[]> {
  const coinId = getCoinGeckoId(ticker)

  // Map timeframe to days
  const daysMap: Record<string, number> = {
    '1D': 1, '1W': 7, '1M': 30, '3M': 90
  }
  const days = daysMap[timeframe] ?? 30

  // Try CoinGecko first (free, reliable)
  if (coinId) {
    // Get OHLC bars
    const ohlcBars = await fetchCoinGeckoBars(coinId, days)

    if (ohlcBars.length >= 10) {
      // Augment with volume data from market chart
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

  // Fallback to Alpaca crypto
  const daysBack = daysMap[timeframe] ?? 30
  const alpacaBars = await fetchAlpacaCryptoBars(ticker, timeframe, daysBack * 3)
  if (alpacaBars.length >= 10) return alpacaBars

  return []
}

// Get extended crypto metadata from CoinGecko
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
  const coinId = getCoinGeckoId(ticker)
  if (!coinId) return { marketCap: null, volume24h: null, circulatingSupply: null, priceChange24h: null, priceChange7d: null, ath: null, athChangePercent: null, name: ticker, description: '' }

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`,
      { next: { revalidate: 600 } }
    )
    if (!res.ok) return { marketCap: null, volume24h: null, circulatingSupply: null, priceChange24h: null, priceChange7d: null, ath: null, athChangePercent: null, name: ticker, description: '' }

    const d = await res.json()
    return {
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
  } catch {
    return { marketCap: null, volume24h: null, circulatingSupply: null, priceChange24h: null, priceChange7d: null, ath: null, athChangePercent: null, name: ticker, description: '' }
  }
}
