// ─────────────────────────────────────────────────────────────
// Alpaca Markets Data API
// Free tier: news + IEX price data (15-min delayed)
// Sign up at alpaca.markets (paper trading account)
// ─────────────────────────────────────────────────────────────

const BASE = process.env.ALPACA_BASE_URL || 'https://data.alpaca.markets'

function alpacaHeaders() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
    'Accept': 'application/json',
  }
}

// ── News ───────────────────────────────────────────────────────
export async function fetchNews(ticker: string, limit = 15): Promise<AlpacaNewsItem[]> {
  try {
    const res = await fetch(
      `${BASE}/v1beta1/news?symbols=${ticker}&limit=${limit}&sort=desc`,
      { headers: alpacaHeaders(), next: { revalidate: 300 } }
    )
    if (!res.ok) return []
    const data = await res.json()
    return (data.news || []) as AlpacaNewsItem[]
  } catch {
    return []
  }
}

// ── OHLCV Bars ─────────────────────────────────────────────────
export async function fetchBars(ticker: string, timeframe: string): Promise<AlpacaBar[]> {
  try {
    const { tf, daysBack } = barParams(timeframe)
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - daysBack)
    const startStr = start.toISOString().split('T')[0]
    const endStr   = end.toISOString().split('T')[0]

    for (const feed of ['sip', 'iex']) {
      try {
        const url = `${BASE}/v2/stocks/${ticker}/bars?timeframe=${tf}&start=${startStr}&end=${endStr}&limit=1000&adjustment=split&feed=${feed}`
        const res = await fetch(url, { headers: alpacaHeaders(), next: { revalidate: 300 } })
        if (!res.ok) continue
        const data = await res.json()
        const bars = (data.bars || []) as AlpacaBar[]
        if (bars.length >= 20) return bars
      } catch {
        continue
      }
    }
    return []
  } catch {
    return []
  }
}

// ── Latest Quote ───────────────────────────────────────────────
export async function fetchQuote(ticker: string): Promise<AlpacaQuote | null> {
  try {
    const res = await fetch(
      `${BASE}/v2/stocks/${ticker}/quotes/latest`,
      { headers: alpacaHeaders(), next: { revalidate: 60 } }
    )
    if (!res.ok) return null
    const data = await res.json()
    return data.quote as AlpacaQuote
  } catch {
    return null
  }
}

// ── Multi-ticker bars (for competitors + market context) ───────
export async function fetchMultiBars(tickers: string[], timeframe: string): Promise<Record<string, AlpacaBar[]>> {
  try {
    const { tf, daysBack } = barParams(timeframe)
    const symbols = tickers.join(',')
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - daysBack)
    const startStr = start.toISOString().split('T')[0]
    const endStr   = end.toISOString().split('T')[0]

    for (const feed of ['sip', 'iex']) {
      try {
        const url = `${BASE}/v2/stocks/bars?symbols=${symbols}&timeframe=${tf}&start=${startStr}&end=${endStr}&limit=1000&adjustment=split&feed=${feed}`
        const res = await fetch(url, { headers: alpacaHeaders(), next: { revalidate: 300 } })
        if (!res.ok) continue
        const data = await res.json()
        if (data.bars && Object.keys(data.bars).length > 0) return data.bars
      } catch {
        continue
      }
    }
    return {}
  } catch {
    return {}
  }
}

// ── Formatted news for AI ──────────────────────────────────────
export function formatNewsForAI(news: AlpacaNewsItem[]): string {
  if (!news.length) return 'No recent news available.'
  return news
    .map(n => `• ${n.headline} (${formatAge(n.created_at)})${n.summary ? '\n  ' + n.summary.slice(0, 150) : ''}`)
    .join('\n')
}

// ── Price action summary for AI ────────────────────────────────
export function formatBarsForAI(bars: AlpacaBar[], timeframe: string): string {
  if (!bars.length) return 'No price data available.'
  const first = bars[0]
  const last = bars[bars.length - 1]
  const change = ((last.c - first.o) / first.o * 100).toFixed(2)
  const high = Math.max(...bars.map(b => b.h)).toFixed(2)
  const low = Math.min(...bars.map(b => b.l)).toFixed(2)
  const avgVol = Math.round(bars.reduce((s, b) => s + b.v, 0) / bars.length)
  const lastVol = last.v
  const volNote = lastVol > avgVol * 1.5 ? 'HIGH volume' : lastVol < avgVol * 0.5 ? 'LOW volume' : 'average volume'
  return `${timeframe} price action: $${first.o.toFixed(2)} → $${last.c.toFixed(2)} (${Number(change) >= 0 ? '+' : ''}${change}%). Range: $${low}–$${high}. Last bar: ${volNote} (${lastVol.toLocaleString()} vs avg ${avgVol.toLocaleString()}).`
}

// ── Helpers ────────────────────────────────────────────────────
function barParams(timeframe: string) {
  // Different bar resolutions per timeframe so indicators reflect that view.
  // 1D and 1W use hourly bars — RSI/MACD on hourly tells a different story.
  // 1M and 3M use daily bars with enough history for accurate SMA200.
  switch (timeframe) {
    case '1D': return { tf: '1Hour', daysBack: 30  }   // 30 days of hourly = ~480 bars
    case '1W': return { tf: '1Hour', daysBack: 60  }   // 60 days of hourly = ~960 bars
    case '1M': return { tf: '1Day',  daysBack: 420 }   // 420 calendar days = ~290 trading days
    case '3M': return { tf: '1Day',  daysBack: 420 }   // same — need SMA200
    default:   return { tf: '1Day',  daysBack: 420 }
  }
}

function formatAge(iso: string): string {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000)
  return h < 1 ? 'just now' : h < 24 ? `${h}h ago` : `${Math.floor(h/24)}d ago`
}

// ── Types ──────────────────────────────────────────────────────
export type AlpacaNewsItem = {
  id: number
  headline: string
  summary: string
  url: string
  created_at: string
  symbols: string[]
}

export type AlpacaBar = {
  t: string   // timestamp
  o: number   // open
  h: number   // high
  l: number   // low
  c: number   // close
  v: number   // volume
}

export type AlpacaQuote = {
  ap: number  // ask price
  bp: number  // bid price
  t: string   // timestamp
}
