// =============================================================
// app/lib/yahoo-quotes.ts
//
// Fetches international market quotes (indices, forex, commodities,
// futures) from Yahoo Finance's unofficial chart endpoint.
//
// Used by /api/tomorrow on weekends to give the AI context about
// global markets while US is closed. Yahoo is free and unauthenticated
// but unofficial - on any error we degrade silently and let Gemini
// grounded news carry the narrative.
//
// Hard 3-second timeout per symbol. Errors swallowed.
// =============================================================

export interface YahooQuote {
  symbol: string
  displayName: string
  category: 'index' | 'forex' | 'commodity' | 'futures'
  price: number
  changePct: number       // % change from previous close
  previousClose: number
  marketTime?: string     // ISO timestamp of the quote
}

// Symbols and their display labels.
// Yahoo expects these exact symbols on the chart endpoint.
const YAHOO_SYMBOLS: Array<{ symbol: string; displayName: string; category: YahooQuote['category'] }> = [
  // International indices
  { symbol: '^N225',    displayName: 'Nikkei 225',       category: 'index' },
  { symbol: '^HSI',     displayName: 'Hang Seng',        category: 'index' },
  { symbol: '^FTSE',    displayName: 'FTSE 100',         category: 'index' },
  { symbol: '^GDAXI',   displayName: 'DAX',              category: 'index' },
  { symbol: '^FCHI',    displayName: 'CAC 40',           category: 'index' },
  { symbol: '^STOXX50E', displayName: 'Euro Stoxx 50',   category: 'index' },

  // Forex (vs USD)
  { symbol: 'EURUSD=X', displayName: 'EUR/USD',          category: 'forex' },
  { symbol: 'JPY=X',    displayName: 'USD/JPY',          category: 'forex' },
  { symbol: 'GBPUSD=X', displayName: 'GBP/USD',          category: 'forex' },
  { symbol: 'DX-Y.NYB', displayName: 'DXY (Dollar Index)', category: 'forex' },

  // Commodities
  { symbol: 'CL=F',     displayName: 'WTI Crude Oil',    category: 'commodity' },
  { symbol: 'GC=F',     displayName: 'Gold',             category: 'commodity' },

  // US futures (trade Sunday night ET)
  { symbol: 'ES=F',     displayName: 'S&P 500 Futures',  category: 'futures' },
  { symbol: 'NQ=F',     displayName: 'Nasdaq Futures',   category: 'futures' },
  { symbol: 'YM=F',     displayName: 'Dow Futures',      category: 'futures' },
  { symbol: 'RTY=F',    displayName: 'Russell 2000 Futures', category: 'futures' },
]

// Single-symbol fetcher with hard timeout. Returns null on any failure.
async function fetchOne(symbol: string): Promise<{ price: number; previousClose: number; marketTime?: string } | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  try {
    // Yahoo's chart endpoint - widely used by open-source libs
    // We use range=2d to ensure we get yesterday's close even on Mondays
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // Some Cloudflare paths block the default fetch UA
        'User-Agent': 'Mozilla/5.0 (compatible; WaliOS/1.0)',
        'Accept': 'application/json',
      },
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = await res.json()

    // Yahoo response shape:
    // { chart: { result: [{ meta: { regularMarketPrice, chartPreviousClose }, timestamp: [...] }] } }
    const result = data?.chart?.result?.[0]
    if (!result) return null
    const meta = result.meta
    if (!meta) return null

    const price = Number(meta.regularMarketPrice)
    const previousClose = Number(meta.chartPreviousClose ?? meta.previousClose)
    if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose === 0) {
      return null
    }

    // Time of the quote, if available
    const ts = meta.regularMarketTime
    const marketTime = typeof ts === 'number' ? new Date(ts * 1000).toISOString() : undefined

    return { price, previousClose, marketTime }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch all configured international quotes in parallel.
 * Returns whatever succeeded. Empty array if nothing returns.
 * Never throws.
 */
export async function fetchInternationalQuotes(): Promise<YahooQuote[]> {
  const started = Date.now()
  const results = await Promise.all(
    YAHOO_SYMBOLS.map(async (cfg) => {
      const data = await fetchOne(cfg.symbol)
      if (!data) return null
      const changePct = ((data.price - data.previousClose) / data.previousClose) * 100
      return {
        symbol: cfg.symbol,
        displayName: cfg.displayName,
        category: cfg.category,
        price: data.price,
        changePct,
        previousClose: data.previousClose,
        marketTime: data.marketTime,
      } as YahooQuote
    })
  )

  const ok = results.filter((q): q is YahooQuote => q !== null)
  const elapsedMs = Date.now() - started
  console.log(`[yahoo-quotes] fetched ${ok.length}/${YAHOO_SYMBOLS.length} quotes in ${elapsedMs}ms`)
  return ok
}

/**
 * Format quotes as a string block for embedding in an LLM prompt.
 * Groups by category, drops empty categories.
 */
export function formatQuotesForPrompt(quotes: YahooQuote[]): string {
  if (!quotes.length) return 'No live international quotes available - rely on news narrative for global market context.'

  const groups: Record<YahooQuote['category'], YahooQuote[]> = {
    index: [],
    forex: [],
    commodity: [],
    futures: [],
  }
  for (const q of quotes) groups[q.category].push(q)

  const formatLine = (q: YahooQuote) => {
    const sign = q.changePct >= 0 ? '+' : ''
    const arrow = q.changePct > 0.5 ? 'UP' : q.changePct < -0.5 ? 'DOWN' : 'FLAT'
    // Round price sensibly by category
    const priceStr = q.category === 'forex'
      ? q.price.toFixed(4)
      : q.category === 'index' || q.price > 100
        ? q.price.toFixed(2)
        : q.price.toFixed(2)
    return `  ${q.displayName}: ${priceStr} (${sign}${q.changePct.toFixed(2)}%) [${arrow}]`
  }

  const sections: string[] = []
  if (groups.index.length) {
    sections.push(`INTERNATIONAL INDICES:\n${groups.index.map(formatLine).join('\n')}`)
  }
  if (groups.forex.length) {
    sections.push(`FOREX (vs USD):\n${groups.forex.map(formatLine).join('\n')}`)
  }
  if (groups.commodity.length) {
    sections.push(`COMMODITIES:\n${groups.commodity.map(formatLine).join('\n')}`)
  }
  if (groups.futures.length) {
    sections.push(`US FUTURES (Sunday/overnight pricing):\n${groups.futures.map(formatLine).join('\n')}`)
  }
  return sections.join('\n\n')
}

/**
 * Build a structured snapshot for the API response.
 * The page renders this in the new "Internationalsnapshot" section.
 */
export function buildInternationalSnapshot(quotes: YahooQuote[]) {
  const groups: Record<YahooQuote['category'], YahooQuote[]> = {
    index: [],
    forex: [],
    commodity: [],
    futures: [],
  }
  for (const q of quotes) groups[q.category].push(q)

  // Helper to compute group sentiment - rough majority direction
  const sentiment = (items: YahooQuote[]): 'up' | 'down' | 'mixed' | 'unknown' => {
    if (!items.length) return 'unknown'
    const up = items.filter(q => q.changePct > 0.1).length
    const down = items.filter(q => q.changePct < -0.1).length
    if (up > down * 2) return 'up'
    if (down > up * 2) return 'down'
    return 'mixed'
  }

  return {
    fetchedAt: new Date().toISOString(),
    indices: groups.index.map(q => ({
      name: q.displayName,
      symbol: q.symbol,
      price: q.price,
      changePct: q.changePct,
    })),
    forex: groups.forex.map(q => ({
      name: q.displayName,
      symbol: q.symbol,
      price: q.price,
      changePct: q.changePct,
    })),
    commodities: groups.commodity.map(q => ({
      name: q.displayName,
      symbol: q.symbol,
      price: q.price,
      changePct: q.changePct,
    })),
    futures: groups.futures.map(q => ({
      name: q.displayName,
      symbol: q.symbol,
      price: q.price,
      changePct: q.changePct,
    })),
    sentiment: {
      indices: sentiment(groups.index),
      forex: sentiment(groups.forex),
      commodities: sentiment(groups.commodity),
      futures: sentiment(groups.futures),
    },
  }
}

export type InternationalSnapshot = ReturnType<typeof buildInternationalSnapshot>
