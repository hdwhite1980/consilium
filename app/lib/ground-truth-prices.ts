// =============================================================
// app/lib/ground-truth-prices.ts
//
// Fetches live prices for ~30 anchor tickers (sector ETFs, indices,
// commodities, crypto) BEFORE the model classifies. The prompt then
// includes a "GROUND TRUTH MARKET DATA" block that the model is told
// is authoritative - if news suggests one thing but the price says
// another, prefer the price.
//
// Used by:
//   1. Layer 1: prompt injection (formatGroundTruthForPrompt)
//   2. Layer 2: post-validation (lookup map for watchlist validator)
//
// Design choices:
//   - Alpaca for US ETFs (already wired, has the keys)
//   - Yahoo unofficial for VIX and crypto (no Alpaca crypto for some)
//   - Parallel fetch with hard timeouts; degrade silently on failure
//   - Returns previous close + last price + change pct so validator
//     can verify both magnitude and direction
// =============================================================

export interface GroundTruthQuote {
  ticker: string
  displayName: string
  category: 'sector' | 'index' | 'commodity' | 'volatility' | 'crypto'
  price: number          // Last available price
  previousClose: number  // Previous trading session's close
  changePct: number      // (price - previousClose) / previousClose * 100
  source: 'alpaca' | 'yahoo'
  asOf?: string          // ISO timestamp
}

// Standard anchor list. All ~23 weekday tickers.
// Yahoo international/futures/forex are added separately on weekends
// via the existing yahoo-quotes.ts module.
const ANCHOR_TICKERS: Array<{
  ticker: string
  displayName: string
  category: GroundTruthQuote['category']
  yahooSymbol?: string  // For tickers not on Alpaca (VIX, crypto if needed)
  preferYahoo?: boolean
}> = [
  // Sector ETFs - 11
  { ticker: 'XLE',  displayName: 'Energy',                  category: 'sector' },
  { ticker: 'XLK',  displayName: 'Technology',              category: 'sector' },
  { ticker: 'XLF',  displayName: 'Financials',              category: 'sector' },
  { ticker: 'XLV',  displayName: 'Healthcare',              category: 'sector' },
  { ticker: 'XLY',  displayName: 'Consumer Discretionary',  category: 'sector' },
  { ticker: 'XLP',  displayName: 'Consumer Staples',        category: 'sector' },
  { ticker: 'XLI',  displayName: 'Industrials',             category: 'sector' },
  { ticker: 'XLU',  displayName: 'Utilities',               category: 'sector' },
  { ticker: 'XLB',  displayName: 'Materials',               category: 'sector' },
  { ticker: 'XLRE', displayName: 'Real Estate',             category: 'sector' },
  { ticker: 'XLC',  displayName: 'Communication',           category: 'sector' },

  // Index ETFs - 4
  { ticker: 'SPY', displayName: 'S&P 500',          category: 'index' },
  { ticker: 'QQQ', displayName: 'Nasdaq 100',       category: 'index' },
  { ticker: 'IWM', displayName: 'Russell 2000',     category: 'index' },
  { ticker: 'DIA', displayName: 'Dow Jones',        category: 'index' },

  // Commodity ETFs - 4
  { ticker: 'USO', displayName: 'Oil (USO)',           category: 'commodity' },
  { ticker: 'GLD', displayName: 'Gold (GLD)',          category: 'commodity' },
  { ticker: 'SLV', displayName: 'Silver (SLV)',        category: 'commodity' },
  { ticker: 'UNG', displayName: 'Natural Gas (UNG)',   category: 'commodity' },

  // Volatility - 1 (VIX is an index, not on Alpaca - use Yahoo)
  { ticker: 'VIX', displayName: 'VIX',  category: 'volatility', yahooSymbol: '^VIX', preferYahoo: true },

  // Crypto - 3 (Alpaca supports these)
  { ticker: 'BTC/USD', displayName: 'Bitcoin',  category: 'crypto', yahooSymbol: 'BTC-USD' },
  { ticker: 'ETH/USD', displayName: 'Ethereum', category: 'crypto', yahooSymbol: 'ETH-USD' },
  { ticker: 'SOL/USD', displayName: 'Solana',   category: 'crypto', yahooSymbol: 'SOL-USD' },
]

// -----------------------------------------------------------------
// Alpaca - for US stocks/ETFs
// -----------------------------------------------------------------
async function fetchAlpacaSnapshot(ticker: string): Promise<{ price: number; previousClose: number } | null> {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 4000)
  try {
    // Snapshot endpoint gives latest trade + previous daily bar
    const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/snapshot`
    const res = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
      },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const data = await res.json()
    const lastTrade = data?.latestTrade?.p ?? data?.dailyBar?.c
    const prevDailyClose = data?.prevDailyBar?.c
    if (typeof lastTrade !== 'number' || typeof prevDailyClose !== 'number' || prevDailyClose === 0) return null
    return { price: lastTrade, previousClose: prevDailyClose }
  } catch { return null }
  finally { clearTimeout(timer) }
}

async function fetchAlpacaCryptoSnapshot(symbol: string): Promise<{ price: number; previousClose: number } | null> {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 4000)
  try {
    const url = `https://data.alpaca.markets/v1beta3/crypto/us/snapshots?symbols=${encodeURIComponent(symbol)}`
    const res = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
      },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const data = await res.json()
    const snap = data?.snapshots?.[symbol]
    if (!snap) return null
    const lastTrade = snap?.latestTrade?.p ?? snap?.dailyBar?.c
    const prevClose = snap?.prevDailyBar?.c ?? snap?.dailyBar?.o
    if (typeof lastTrade !== 'number' || typeof prevClose !== 'number' || prevClose === 0) return null
    return { price: lastTrade, previousClose: prevClose }
  } catch { return null }
  finally { clearTimeout(timer) }
}

// -----------------------------------------------------------------
// Yahoo - for VIX and crypto fallback
// -----------------------------------------------------------------
async function fetchYahooSnapshot(symbol: string): Promise<{ price: number; previousClose: number } | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WaliOS/1.0)',
        'Accept':     'application/json',
      },
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = await res.json()
    const meta = data?.chart?.result?.[0]?.meta
    if (!meta) return null
    const price = Number(meta.regularMarketPrice)
    const previousClose = Number(meta.chartPreviousClose ?? meta.previousClose)
    if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose === 0) return null
    return { price, previousClose }
  } catch { return null }
  finally { clearTimeout(timer) }
}

// -----------------------------------------------------------------
// Main fetch - parallel, degrades silently
// -----------------------------------------------------------------
export async function fetchGroundTruthPrices(): Promise<GroundTruthQuote[]> {
  const started = Date.now()
  const results = await Promise.all(
    ANCHOR_TICKERS.map(async (cfg) => {
      let snapshot: { price: number; previousClose: number } | null = null
      let source: 'alpaca' | 'yahoo' = 'alpaca'

      if (cfg.preferYahoo && cfg.yahooSymbol) {
        snapshot = await fetchYahooSnapshot(cfg.yahooSymbol)
        source = 'yahoo'
      } else if (cfg.category === 'crypto') {
        // Try Alpaca crypto first, fall back to Yahoo
        snapshot = await fetchAlpacaCryptoSnapshot(cfg.ticker)
        if (!snapshot && cfg.yahooSymbol) {
          snapshot = await fetchYahooSnapshot(cfg.yahooSymbol)
          source = 'yahoo'
        }
      } else {
        // Try Alpaca first, fall back to Yahoo
        snapshot = await fetchAlpacaSnapshot(cfg.ticker)
        if (!snapshot && cfg.yahooSymbol) {
          snapshot = await fetchYahooSnapshot(cfg.yahooSymbol)
          source = 'yahoo'
        }
      }

      if (!snapshot) return null
      const changePct = ((snapshot.price - snapshot.previousClose) / snapshot.previousClose) * 100
      return {
        ticker: cfg.ticker,
        displayName: cfg.displayName,
        category: cfg.category,
        price: snapshot.price,
        previousClose: snapshot.previousClose,
        changePct,
        source,
        asOf: new Date().toISOString(),
      } as GroundTruthQuote
    })
  )

  const ok = results.filter((q): q is GroundTruthQuote => q !== null)
  const elapsedMs = Date.now() - started
  console.log(`[ground-truth] fetched ${ok.length}/${ANCHOR_TICKERS.length} anchor quotes in ${elapsedMs}ms`)
  return ok
}

// -----------------------------------------------------------------
// Format for prompt - readable block the model can use as anchor
// -----------------------------------------------------------------
export function formatGroundTruthForPrompt(quotes: GroundTruthQuote[]): string {
  if (!quotes.length) {
    return 'GROUND TRUTH PRICES: unavailable - rely on news context with caution.'
  }

  const groups: Record<GroundTruthQuote['category'], GroundTruthQuote[]> = {
    sector: [], index: [], commodity: [], volatility: [], crypto: [],
  }
  for (const q of quotes) groups[q.category].push(q)

  const formatLine = (q: GroundTruthQuote) => {
    const sign = q.changePct >= 0 ? '+' : ''
    const arrow = q.changePct > 0.5 ? 'UP' : q.changePct < -0.5 ? 'DOWN' : 'FLAT'
    return `  ${q.ticker.padEnd(8)} ${q.displayName.padEnd(28)} $${q.price.toFixed(2).padStart(10)}  prev $${q.previousClose.toFixed(2).padStart(10)}  ${sign}${q.changePct.toFixed(2)}% [${arrow}]`
  }

  const sections: string[] = []
  if (groups.index.length)      sections.push(`INDEX ETFS:\n${groups.index.map(formatLine).join('\n')}`)
  if (groups.sector.length)     sections.push(`SECTOR ETFS:\n${groups.sector.map(formatLine).join('\n')}`)
  if (groups.commodity.length)  sections.push(`COMMODITIES:\n${groups.commodity.map(formatLine).join('\n')}`)
  if (groups.volatility.length) sections.push(`VOLATILITY:\n${groups.volatility.map(formatLine).join('\n')}`)
  if (groups.crypto.length)     sections.push(`CRYPTO:\n${groups.crypto.map(formatLine).join('\n')}`)

  return [
    '═══════════════════════════════════════════════════════════════',
    'GROUND TRUTH MARKET DATA - AUTHORITATIVE',
    '═══════════════════════════════════════════════════════════════',
    'These are the LAST AVAILABLE prices and moves. Treat as authoritative.',
    'If your news suggests one direction but a ticker price shows the opposite,',
    'PREFER THE PRICE. Do not invent percentage moves - only cite percentages',
    'present in this block or in the news section.',
    '',
    sections.join('\n\n'),
    '═══════════════════════════════════════════════════════════════',
  ].join('\n')
}

// -----------------------------------------------------------------
// Build a lookup map for the validator
// -----------------------------------------------------------------
export function buildGroundTruthMap(quotes: GroundTruthQuote[]): Map<string, GroundTruthQuote> {
  const map = new Map<string, GroundTruthQuote>()
  for (const q of quotes) {
    // Index by ticker uppercase
    map.set(q.ticker.toUpperCase(), q)
    // Common aliases for commodities/crypto so "oil" or "bitcoin" resolves
    if (q.ticker === 'USO')      { map.set('OIL', q); map.set('CRUDE', q); map.set('WTI', q) }
    if (q.ticker === 'GLD')      { map.set('GOLD', q) }
    if (q.ticker === 'SLV')      { map.set('SILVER', q) }
    if (q.ticker === 'UNG')      { map.set('NATGAS', q); map.set('NATURAL GAS', q) }
    if (q.ticker === 'BTC/USD')  { map.set('BTC', q); map.set('BITCOIN', q) }
    if (q.ticker === 'ETH/USD')  { map.set('ETH', q); map.set('ETHEREUM', q) }
    if (q.ticker === 'SOL/USD')  { map.set('SOL', q); map.set('SOLANA', q) }
    if (q.ticker === 'SPY')      { map.set('S&P', q); map.set('S&P 500', q); map.set('SPX', q) }
    if (q.ticker === 'QQQ')      { map.set('NASDAQ', q); map.set('NDX', q) }
    if (q.ticker === 'IWM')      { map.set('RUSSELL', q); map.set('SMALL CAP', q) }
    if (q.ticker === 'DIA')      { map.set('DOW', q); map.set('DJIA', q) }
    if (q.ticker === 'XLE')      { map.set('ENERGY', q) }
    if (q.ticker === 'XLK')      { map.set('TECH', q); map.set('TECHNOLOGY', q) }
    if (q.ticker === 'XLF')      { map.set('FINANCIALS', q); map.set('FINANCE', q) }
    if (q.ticker === 'XLV')      { map.set('HEALTHCARE', q); map.set('HEALTH', q) }
  }
  return map
}
