// ═════════════════════════════════════════════════════════════
// app/lib/multi-source-news.ts
//
// Aggregates news from multiple sources for Today's/Tomorrow's Movers.
//
// Sources:
//   1. Alpaca news API (general market + crypto)
//   2. Finnhub company news (top S&P 100 tickers)
//   3. Gemini grounded search ("biggest stock market stories today")
//   4. NEW: Stocktwits trending tickers (retail chatter signal)
//   5. NEW: NewsAPI.org (mainstream credible-outlet aggregation)
//   6. NEW (optional): Marketaux (sentiment-scored aggregation)
//
// Output is deduped and ranked by recency. Each item has a source
// tag so the classifier can weight credible sources higher.
// ═════════════════════════════════════════════════════════════

import { GoogleGenerativeAI } from '@google/generative-ai'

const ALPACA_HEADERS: Record<string, string> = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY ?? '',
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY ?? '',
  Accept: 'application/json',
}

export interface NewsItem {
  headline: string
  summary?: string
  source: 'alpaca' | 'finnhub' | 'gemini-grounded' | 'stocktwits' | 'newsapi' | 'marketaux'
  url?: string
  tickers: string[]
  publishedAt?: string
  sourceOutlet?: string
}

// ─────────────────────────────────────────────────────────────
// Source 1: Alpaca news (unchanged)
// ─────────────────────────────────────────────────────────────
async function fetchAlpacaNews(limit = 50, symbols?: string): Promise<NewsItem[]> {
  if (!process.env.ALPACA_API_KEY) return []
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const url = symbols
      ? `https://data.alpaca.markets/v1beta1/news?limit=${limit}&sort=desc&symbols=${symbols}`
      : `https://data.alpaca.markets/v1beta1/news?limit=${limit}&sort=desc`
    const res = await fetch(url, { headers: ALPACA_HEADERS, signal: ctrl.signal })
    if (!res.ok) return []
    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data.news ?? []).map((n: any) => ({
      headline: String(n.headline ?? ''),
      summary: n.summary ? String(n.summary).slice(0, 300) : undefined,
      source: 'alpaca' as const,
      url: n.url,
      tickers: Array.isArray(n.symbols) ? n.symbols : [],
      publishedAt: n.created_at ?? n.updated_at,
      sourceOutlet: n.source,
    }))
  } catch { return [] }
  finally { clearTimeout(timer) }
}

// ─────────────────────────────────────────────────────────────
// Source 2: Finnhub company news (unchanged)
// ─────────────────────────────────────────────────────────────
async function fetchFinnhubNewsForTicker(ticker: string, hours = 24): Promise<NewsItem[]> {
  const token = process.env.FINNHUB_API_KEY
  if (!token) return []
  const to = new Date().toISOString().split('T')[0]
  const fromDate = new Date()
  fromDate.setHours(fromDate.getHours() - hours)
  const from = fromDate.toISOString().split('T')[0]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${token}`,
      { signal: ctrl.signal, cache: 'no-store' }
    )
    if (!res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data)) return []
    return data.slice(0, 5).map((n) => ({
      headline: String(n.headline ?? ''),
      summary: n.summary ? String(n.summary).slice(0, 300) : undefined,
      source: 'finnhub' as const,
      url: n.url,
      tickers: [ticker],
      publishedAt: n.datetime ? new Date(n.datetime * 1000).toISOString() : undefined,
      sourceOutlet: n.source,
    }))
  } catch { return [] }
  finally { clearTimeout(timer) }
}

// ─────────────────────────────────────────────────────────────
// Source 3: Gemini grounded search (unchanged)
// ─────────────────────────────────────────────────────────────
async function fetchGeminiGroundedNews(): Promise<NewsItem[]> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return []
  try {
    const genAI = new GoogleGenerativeAI(key)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-pro',
      generationConfig: { temperature: 0.1, maxOutputTokens: 2500 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [{ googleSearch: {} } as any],
    })
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    })
    const prompt = `Use Google Search to find the 10 biggest US stock market stories published TODAY (${today}). Focus on earnings, M&A, Fed/macro, analyst upgrades/downgrades, regulatory news, major product announcements.

Prioritize coverage from credible outlets: Reuters, Bloomberg, WSJ, CNBC, MarketWatch, Financial Times, Barron's, Axios.

For each story, return:
- The exact ticker symbol(s) mentioned (use "MARKET" if no specific ticker)
- The headline as it was published
- A 1-sentence summary of what happened
- The source outlet name
- The URL

Return ONLY this JSON format (no markdown, no preamble):
{
  "stories": [
    {
      "tickers": ["AAPL"],
      "headline": "Apple beats Q2 earnings, revenue up 8%",
      "summary": "Apple reported Q2 revenue of $94.8B vs analyst estimate of $90.5B",
      "outlet": "Reuters",
      "url": "https://www.reuters.com/..."
    }
  ]
}

Return exactly 10 stories. Tickers must be uppercase US stock tickers or "MARKET".`
    const result = await model.generateContent(prompt)
    const text = result.response.text()
    const clean = text.replace(/```json|```/g, '').trim()
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    if (start === -1 || end === -1) return []
    const parsed = JSON.parse(clean.slice(start, end + 1))
    const stories = Array.isArray(parsed.stories) ? parsed.stories : []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return stories.map((s: any) => ({
      headline: String(s.headline ?? ''),
      summary: s.summary ? String(s.summary).slice(0, 300) : undefined,
      source: 'gemini-grounded' as const,
      url: typeof s.url === 'string' && s.url.startsWith('http') ? s.url : undefined,
      tickers: Array.isArray(s.tickers)
        ? s.tickers.filter((t: unknown) => typeof t === 'string' && t.length > 0).map((t: string) => t.toUpperCase())
        : [],
      publishedAt: new Date().toISOString(),
      sourceOutlet: typeof s.outlet === 'string' ? s.outlet : undefined,
    })).filter((item: NewsItem) => item.headline.length > 0).slice(0, 15)
  } catch (e) {
    console.warn('[multi-source-news] Gemini grounded fetch failed:', (e as Error).message?.slice(0, 100))
    return []
  }
}

// ─────────────────────────────────────────────────────────────
// Source 4 (NEW): Stocktwits — top trending tickers + recent messages
//
// For Today's/Tomorrow's Movers we want the trending tickers list, which
// surfaces what retail traders are actively discussing. The trending
// endpoint is unauthenticated.
// ─────────────────────────────────────────────────────────────
async function fetchStocktwitsTrending(): Promise<NewsItem[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 6000)
  try {
    const res = await fetch(
      'https://api.stocktwits.com/api/2/trending/symbols.json',
      { signal: ctrl.signal, cache: 'no-store' }
    )
    if (!res.ok) return []
    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const symbols = (data.symbols ?? []) as any[]

    return symbols.slice(0, 10).map((s) => {
      const ticker = String(s?.symbol ?? '').toUpperCase()
      const name = typeof s?.title === 'string' ? s.title : ticker
      return {
        headline: `${ticker} (${name}) is trending on Stocktwits — elevated retail discussion`,
        summary: `Watchlist count: ${s?.watchlist_count ?? 'unknown'} watchers. Retail chatter is currently elevated for this ticker.`,
        source: 'stocktwits' as const,
        url: `https://stocktwits.com/symbol/${ticker}`,
        tickers: [ticker],
        publishedAt: new Date().toISOString(),
        sourceOutlet: 'Stocktwits Trending',
      }
    }).filter(item => item.tickers[0] && item.tickers[0].length <= 6)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Source 5 (NEW): NewsAPI.org — broad market news from credible outlets
// ─────────────────────────────────────────────────────────────
async function fetchNewsAPIMarket(): Promise<NewsItem[]> {
  const key = process.env.NEWSAPI_KEY
  if (!key) return []

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    // For market-wide, use top-headlines from business category instead of /everything
    // (top-headlines is the right endpoint for "what's hot today")
    const url = `https://newsapi.org/v2/top-headlines?` +
      `category=business&country=us&pageSize=30&apiKey=${key}`

    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) return []
    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const articles = (data.articles ?? []) as any[]

    return articles.slice(0, 20).map((a) => ({
      headline: String(a?.title ?? '').slice(0, 250),
      summary: a?.description ? String(a.description).slice(0, 300) : undefined,
      source: 'newsapi' as const,
      url: typeof a?.url === 'string' ? a.url : undefined,
      // top-headlines doesn't tag tickers, classifier will extract from text
      tickers: [],
      publishedAt: typeof a?.publishedAt === 'string' ? a.publishedAt : undefined,
      sourceOutlet: typeof a?.source?.name === 'string' ? a.source.name : undefined,
    })).filter(item => item.headline.length > 5)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Source 6 (NEW): Marketaux — sentiment-scored news (optional)
// ─────────────────────────────────────────────────────────────
async function fetchMarketauxMarket(): Promise<NewsItem[]> {
  const key = process.env.MARKETAUX_API_KEY
  if (!key) return []

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    // /v1/news/all without symbols filter pulls broad market news
    const url = `https://api.marketaux.com/v1/news/all?` +
      `language=en&filter_entities=true&limit=20&api_token=${key}`

    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) return []
    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = (data.data ?? []) as any[]

    return items.map((i) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entities = (i?.entities ?? []) as any[]
      const tickers = entities
        .filter(e => typeof e?.symbol === 'string' && e.symbol.length > 0 && e.symbol.length <= 6)
        .map(e => String(e.symbol).toUpperCase())
        .filter((t, i, arr) => arr.indexOf(t) === i)
        .slice(0, 5)

      return {
        headline: String(i?.title ?? '').slice(0, 250),
        summary: i?.snippet ? String(i.snippet).slice(0, 300)
          : i?.description ? String(i.description).slice(0, 300) : undefined,
        source: 'marketaux' as const,
        url: typeof i?.url === 'string' ? i.url : undefined,
        tickers,
        publishedAt: typeof i?.published_at === 'string' ? i.published_at : undefined,
        sourceOutlet: typeof i?.source === 'string' ? i.source : undefined,
      }
    }).filter(item => item.headline.length > 5)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Dedupe headlines — same/near-duplicate stories across sources
// ─────────────────────────────────────────────────────────────
function normalizeHeadline(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function dedupe(items: NewsItem[]): NewsItem[] {
  const seen = new Map<string, NewsItem>()
  for (const item of items) {
    const key = normalizeHeadline(item.headline)
    if (!key) continue
    if (!seen.has(key)) {
      seen.set(key, item)
    } else {
      // Priority order — credible-tagged sources win when stories duplicate.
      // gemini-grounded (3) > marketaux (3) > newsapi (3) > finnhub (2) > stocktwits (1) > alpaca (1)
      const existing = seen.get(key)!
      const priority = (src: NewsItem['source']) => {
        if (src === 'gemini-grounded') return 4
        if (src === 'marketaux') return 4   // marketaux brings sentiment scores
        if (src === 'newsapi') return 3     // newsapi brings credible-outlet labels
        if (src === 'finnhub') return 2
        if (src === 'stocktwits') return 1  // stocktwits is retail-chatter signal, lower weight
        return 1                            // alpaca
      }
      if (priority(item.source) > priority(existing.source)) {
        seen.set(key, item)
      }
    }
  }
  return Array.from(seen.values())
}

// ─────────────────────────────────────────────────────────────
// Main entrypoint
// ─────────────────────────────────────────────────────────────
export interface MultiSourceNewsResult {
  items: NewsItem[]
  counts: {
    alpaca: number
    finnhub: number
    geminiGrounded: number
    stocktwits: number
    newsapi: number
    marketaux: number
    afterDedupe: number
  }
  fetchedAt: string
}

export async function fetchMultiSourceNews(options?: {
  includeCrypto?: boolean
  topTickersForFinnhub?: string[]
}): Promise<MultiSourceNewsResult> {
  const started = Date.now()

  // Kick off all independent fetches in parallel
  const alpacaP = fetchAlpacaNews(50)
  const cryptoP = options?.includeCrypto
    ? fetchAlpacaNews(20, 'BTC,ETH,SOL,DOGE,XRP')
    : Promise.resolve([])
  const geminiP = fetchGeminiGroundedNews().catch(() => [] as NewsItem[])
  const stocktwitsP = fetchStocktwitsTrending().catch(() => [] as NewsItem[])
  const newsapiP = fetchNewsAPIMarket().catch(() => [] as NewsItem[])
  const marketauxP = fetchMarketauxMarket().catch(() => [] as NewsItem[])

  const [alpaca, crypto, gemini, stocktwits, newsapi, marketaux] = await Promise.all([
    alpacaP, cryptoP, geminiP, stocktwitsP, newsapiP, marketauxP,
  ])

  // Finnhub fetches on top tickers
  const topTickers = (options?.topTickersForFinnhub ?? []).slice(0, 15)
  const finnhubNews: NewsItem[] = []
  if (topTickers.length > 0) {
    const batches = await Promise.all(
      topTickers.map(t => fetchFinnhubNewsForTicker(t, 24))
    )
    for (const batch of batches) finnhubNews.push(...batch)
  }

  const all = [...alpaca, ...crypto, ...gemini, ...stocktwits, ...newsapi, ...marketaux, ...finnhubNews]
  const deduped = dedupe(all)

  // Sort by publishedAt descending (most recent first)
  deduped.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0
    return tb - ta
  })

  const elapsedMs = Date.now() - started
  console.log(`[multi-source-news] fetched ${all.length} total, ${deduped.length} after dedupe in ${elapsedMs}ms ` +
    `(alpaca:${alpaca.length} crypto:${crypto.length} gemini:${gemini.length} stocktwits:${stocktwits.length} newsapi:${newsapi.length} marketaux:${marketaux.length} finnhub:${finnhubNews.length})`)

  return {
    items: deduped,
    counts: {
      alpaca: alpaca.length + crypto.length,
      finnhub: finnhubNews.length,
      geminiGrounded: gemini.length,
      stocktwits: stocktwits.length,
      newsapi: newsapi.length,
      marketaux: marketaux.length,
      afterDedupe: deduped.length,
    },
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * Format news items as a string block suitable for embedding in an LLM prompt.
 * Each item is a single line with its source tag for credibility weighting.
 */
export function formatNewsForPrompt(items: NewsItem[], maxItems = 40): string {
  const sliced = items.slice(0, maxItems)
  return sliced.map((n) => {
    const outlet = n.sourceOutlet ? ` (${n.sourceOutlet})` : ''
    const tickers = n.tickers.length > 0 ? n.tickers.join(',') : 'MARKET'
    const summary = n.summary ? ` — ${n.summary}` : ''
    return `• [${tickers}] ${n.headline}${summary} [source: ${n.source}${outlet}]`
  }).join('\n')
}
