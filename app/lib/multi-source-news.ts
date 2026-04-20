// ═════════════════════════════════════════════════════════════
// app/lib/multi-source-news.ts
//
// Aggregates news from multiple sources for Today's/Tomorrow's Movers.
// Replaces the old Alpaca-only feed.
//
// Sources:
//   1. Alpaca news API (general market + crypto)
//   2. Finnhub company news (top S&P 100 tickers)
//   3. Gemini grounded search ("biggest stock market stories today")
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
  source: 'alpaca' | 'finnhub' | 'gemini-grounded'
  url?: string
  tickers: string[]         // array of tickers mentioned (Alpaca/Finnhub provide these)
  publishedAt?: string
  sourceOutlet?: string     // underlying publication if known (e.g. "Reuters")
}

// ─────────────────────────────────────────────────────────────
// Source 1: Alpaca news
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
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Source 2: Finnhub company news for specific tickers
//
// We fetch news for the top ~15 most-mentioned tickers in the Alpaca
// feed to add depth. Finnhub company news is higher signal because
// it filters for relevance to a specific stock.
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
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Source 3: Gemini grounded search — "biggest stock stories today"
//
// Uses Google Search grounding to find major market stories from
// credible outlets. Returns summarized items with source attribution.
// ─────────────────────────────────────────────────────────────
async function fetchGeminiGroundedNews(): Promise<NewsItem[]> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return []

  try {
    const genAI = new GoogleGenerativeAI(key)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-pro',
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2500,
      },
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
      // When duplicated, prefer gemini-grounded > finnhub > alpaca
      // (gemini brings source attribution)
      const existing = seen.get(key)!
      const priority = (src: NewsItem['source']) =>
        src === 'gemini-grounded' ? 3 : src === 'finnhub' ? 2 : 1
      if (priority(item.source) > priority(existing.source)) {
        seen.set(key, item)
      }
    }
  }
  return Array.from(seen.values())
}

// ─────────────────────────────────────────────────────────────
// Main entrypoint: fetch news from all sources
// ─────────────────────────────────────────────────────────────
export interface MultiSourceNewsResult {
  items: NewsItem[]
  counts: {
    alpaca: number
    finnhub: number
    geminiGrounded: number
    afterDedupe: number
  }
  fetchedAt: string
}

/**
 * Fetch news from all configured sources in parallel.
 * Never throws — returns whatever succeeded, empty array if all fail.
 */
export async function fetchMultiSourceNews(options?: {
  includeCrypto?: boolean      // fetch extra crypto-specific Alpaca feed
  topTickersForFinnhub?: string[]  // fetch Finnhub news for these (max 15)
}): Promise<MultiSourceNewsResult> {
  const started = Date.now()

  // Kick off all independent fetches in parallel
  const alpacaPromise = fetchAlpacaNews(50)
  const cryptoPromise = options?.includeCrypto
    ? fetchAlpacaNews(20, 'BTC,ETH,SOL,DOGE,XRP')
    : Promise.resolve([])
  const geminiPromise = fetchGeminiGroundedNews()
    .catch(() => [] as NewsItem[])

  const [alpaca, crypto, gemini] = await Promise.all([alpacaPromise, cryptoPromise, geminiPromise])

  // Finnhub fetches can be done on top tickers (optional) — small parallel batch
  const topTickers = (options?.topTickersForFinnhub ?? []).slice(0, 15)
  const finnhubNews: NewsItem[] = []
  if (topTickers.length > 0) {
    const finnhubBatches = await Promise.all(
      topTickers.map(t => fetchFinnhubNewsForTicker(t, 24))
    )
    for (const batch of finnhubBatches) finnhubNews.push(...batch)
  }

  const all = [...alpaca, ...crypto, ...gemini, ...finnhubNews]
  const deduped = dedupe(all)

  // Sort by publishedAt descending (most recent first)
  deduped.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0
    return tb - ta
  })

  const elapsedMs = Date.now() - started
  console.log(`[multi-source-news] fetched ${all.length} total, ${deduped.length} after dedupe in ${elapsedMs}ms (alpaca:${alpaca.length} crypto:${crypto.length} gemini:${gemini.length} finnhub:${finnhubNews.length})`)

  return {
    items: deduped,
    counts: {
      alpaca: alpaca.length + crypto.length,
      finnhub: finnhubNews.length,
      geminiGrounded: gemini.length,
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
