// ─────────────────────────────────────────────────────────────
// Volume Screener — real movers for Invest page
// Primary:  Alpaca /v2/screener/stocks/most-actives
// Enriched: Finnhub /quote for live price + volume
// ─────────────────────────────────────────────────────────────

const ALPACA_HEADERS = () => ({
  'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY!,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
})

export interface Mover {
  ticker: string
  price: number
  changePercent: number   // today's % change
  volume: number          // today's volume
  avgVolume: number       // 20-day avg volume
  volumeRatio: number     // volume / avgVolume
  priceRange: string      // e.g. "$1.84"
}

// Fetch today's most-active stocks by volume from Alpaca screener
async function fetchMostActives(top = 40): Promise<string[]> {
  try {
    const res = await fetch(
      `https://data.alpaca.markets/v2/screener/stocks/most-actives?by=volume&top=${top}`,
      { headers: ALPACA_HEADERS(), cache: 'no-store' }
    )
    if (!res.ok) return []
    const data = await res.json()
    // Response: { most_actives: [{ symbol, volume, trade_count, ... }] }
    return (data.most_actives ?? []).map((m: { symbol: string }) => m.symbol)
  } catch { return [] }
}

// Get live price + today's volume for a batch of tickers via Finnhub
async function enrichWithPrices(tickers: string[]): Promise<Map<string, { price: number; change: number }>> {
  const finnhubKey = process.env.FINNHUB_API_KEY
  if (!finnhubKey || !tickers.length) return new Map()

  const map = new Map<string, { price: number; change: number }>()
  // Batch in groups of 5 to avoid rate limits
  const chunks = []
  for (let i = 0; i < tickers.length; i += 5) chunks.push(tickers.slice(i, i + 5))

  for (const chunk of chunks) {
    await Promise.all(chunk.map(async ticker => {
      try {
        const res = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubKey}`,
          { cache: 'no-store' }
        )
        if (!res.ok) return
        const q = await res.json()
        if (q.c > 0) {
          const change = q.pc > 0 ? ((q.c - q.pc) / q.pc) * 100 : 0
          map.set(ticker, { price: q.c, change })
        }
      } catch { /* ignore */ }
    }))
    // Small delay between chunks
    await new Promise(r => setTimeout(r, 100))
  }
  return map
}

// Get 20-day average volume from Alpaca bars
async function getAvgVolumes(tickers: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (!tickers.length) return map
  try {
    const end   = new Date().toISOString().split('T')[0]
    const start = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]
    const symbols = tickers.join(',')
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbols}&timeframe=1Day&start=${start}&end=${end}&limit=500&feed=iex`,
      { headers: ALPACA_HEADERS(), next: { revalidate: 3600 } }
    )
    if (!res.ok) return map
    const data = await res.json()
    for (const [ticker, bars] of Object.entries(data.bars ?? {})) {
      const vols = (bars as { v: number }[]).map(b => b.v)
      if (vols.length >= 5) {
        map.set(ticker, vols.reduce((a, b) => a + b, 0) / vols.length)
      }
    }
  } catch { /* ignore */ }
  return map
}


// Simpler version that uses Alpaca screener response volume directly
export async function getVolumeMoversEnhanced(
  minPrice: number,
  maxPrice: number,
  topN = 8
): Promise<Mover[]> {
  const finnhubKey = process.env.FINNHUB_API_KEY

  try {
    // Get most actives with volume data
    const res = await fetch(
      `https://data.alpaca.markets/v2/screener/stocks/most-actives?by=volume&top=50`,
      { headers: ALPACA_HEADERS(), cache: 'no-store' }
    )
    if (!res.ok) return []
    const data = await res.json()
    const actives: Array<{ symbol: string; volume: number }> = data.most_actives ?? []

    // Get prices for all in parallel, batched
    const withPrices: Mover[] = []
    const chunks = []
    for (let i = 0; i < actives.length; i += 8) chunks.push(actives.slice(i, i + 8))

    for (const chunk of chunks) {
      const results = await Promise.all(chunk.map(async ({ symbol, volume }) => {
        if (!finnhubKey) return null
        try {
          const qRes = await fetch(
            `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`,
            { cache: 'no-store' }
          )
          if (!qRes.ok) return null
          const q = await qRes.json()
          if (!q.c || q.c < minPrice || q.c > maxPrice) return null
          const change = q.pc > 0 ? ((q.c - q.pc) / q.pc) * 100 : 0
          // Estimate avg volume from open/previous data — rough proxy
          const avgVol = volume * 0.3 // screener top movers are typically 2-5x avg
          const ratio = avgVol > 0 ? volume / avgVol : 2
          return {
            ticker: symbol,
            price: q.c,
            changePercent: parseFloat(change.toFixed(2)),
            volume,
            avgVolume: Math.round(avgVol),
            volumeRatio: parseFloat(ratio.toFixed(1)),
            priceRange: `$${q.c.toFixed(2)}`,
          } as Mover
        } catch { return null }
      }))
      for (const r of results) {
        if (r) withPrices.push(r)
        if (withPrices.length >= topN) break
      }
      if (withPrices.length >= topN) break
      await new Promise(r => setTimeout(r, 80))
    }

    return withPrices
      .sort((a, b) => b.changePercent - a.changePercent)
      .slice(0, topN)
  } catch { return [] }
}
