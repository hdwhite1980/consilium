// ─────────────────────────────────────────────────────────────
// Alpaca Markets Data API
// Alpaca Trader Plus: SIP real-time feed, all US exchanges, 9+ years history, 10k calls/min
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


// ── Pagination helpers ─────────────────────────────────────────
// Alpaca's /v2/stocks bars endpoint paginates results via next_page_token.
// Without following the token, we get the first ~5-6 weeks of data only,
// truncating large date ranges silently. These helpers loop through pages.
//
// Safety cap: 10 pages (~100k bars max) prevents runaway loops.
const MAX_PAGES = 10

async function fetchPaginatedBars(baseUrl: string): Promise<AlpacaBar[]> {
  const allBars: AlpacaBar[] = []
  let pageToken: string | null = null
  let pages = 0

  while (pages < MAX_PAGES) {
    const url: string = pageToken
      ? `${baseUrl}&page_token=${encodeURIComponent(pageToken)}`
      : baseUrl
    const res = await fetch(url, { headers: alpacaHeaders(), next: { revalidate: 300 } })
    if (!res.ok) break

    const data = await res.json()
    const pageBars = (data.bars || []) as AlpacaBar[]
    allBars.push(...pageBars)

    pageToken = data.next_page_token || null
    pages++

    if (!pageToken) break
  }

  return allBars
}

async function fetchPaginatedMultiBars(baseUrl: string): Promise<Record<string, AlpacaBar[]>> {
  const result: Record<string, AlpacaBar[]> = {}
  let pageToken: string | null = null
  let pages = 0

  while (pages < MAX_PAGES) {
    const url: string = pageToken
      ? `${baseUrl}&page_token=${encodeURIComponent(pageToken)}`
      : baseUrl
    const res = await fetch(url, { headers: alpacaHeaders(), next: { revalidate: 300 } })
    if (!res.ok) break

    const data = await res.json()
    const pageBars = (data.bars || {}) as Record<string, AlpacaBar[]>

    // Merge page bars into result
    for (const [symbol, bars] of Object.entries(pageBars)) {
      if (!result[symbol]) result[symbol] = []
      result[symbol].push(...bars)
    }

    pageToken = data.next_page_token || null
    pages++

    if (!pageToken) break
  }

  return result
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

    // Trader Plus: SIP = real-time consolidated tape from all US exchanges
    try {
      const allBars = await fetchPaginatedBars(
        `${BASE}/v2/stocks/${ticker}/bars?timeframe=${tf}&start=${startStr}&end=${endStr}&limit=10000&adjustment=all&feed=sip`
      )
      if (allBars.length >= 5) return allBars
    } catch { /* fallthrough */ }
    // IEX fallback for non-SIP-covered tickers (OTC etc)
    try {
      const allBars = await fetchPaginatedBars(
        `${BASE}/v2/stocks/${ticker}/bars?timeframe=${tf}&start=${startStr}&end=${endStr}&limit=10000&adjustment=all&feed=iex`
      )
      return allBars
    } catch { /* ignore */ }
    return []
  } catch {
    return []
  }
}

// ── Latest Quote ───────────────────────────────────────────────
export async function fetchQuote(ticker: string): Promise<AlpacaQuote | null> {
  try {
    const res = await fetch(
      `${BASE}/v2/stocks/${ticker}/quotes/latest?feed=sip`,
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

    try {
      const result = await fetchPaginatedMultiBars(
        `${BASE}/v2/stocks/bars?symbols=${symbols}&timeframe=${tf}&start=${startStr}&end=${endStr}&limit=10000&adjustment=all&feed=sip`
      )
      if (Object.keys(result).length > 0) return result
    } catch { /* fallthrough */ }
    try {
      const result = await fetchPaginatedMultiBars(
        `${BASE}/v2/stocks/bars?symbols=${symbols}&timeframe=${tf}&start=${startStr}&end=${endStr}&limit=10000&adjustment=all&feed=iex`
      )
      if (Object.keys(result).length > 0) return result
    } catch { /* ignore */ }
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
  // Each timeframe gets a distinct bar resolution and lookback window.
  // This ensures RSI, MACD, Ichimoku, and momentum indicators reflect
  // the correct lens — a 15min RSI and a daily RSI tell very different stories.
  // Trader Plus: 9+ years of history available, 10k bar limit per request
  switch (timeframe) {
    case '1D': return { tf: '15Min', daysBack: 30  }   // 30 days of 15-min bars ~2880 bars — much better RSI/MACD warmup
    case '1W': return { tf: '1Hour', daysBack: 90  }   // 90 days of hourly bars ~1440 bars — strong swing signals
    case '1M': return { tf: '1Day',  daysBack: 500 }   // 500 calendar days ~350 trading days — robust SMA200 + 1yr S/R
    case '3M': return { tf: '1Day',  daysBack: 1200}   // ~3.3 years daily bars — long-term trend, multi-year S/R levels
    default:   return { tf: '1Day',  daysBack: 500 }
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
