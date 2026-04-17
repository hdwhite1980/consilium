import { NextRequest } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { createServerClient } from '@/app/lib/supabase'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

const ALPACA_HEADERS = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
  'Accept': 'application/json',
}

// ── Helpers ────────────────────────────────────────────────────
function todayUTC(): string {
  return new Date().toISOString().split('T')[0] // "2025-04-14"
}

function minutesAgo(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / 60000)
}

function parseJSON<T>(text: string): T {
  const clean = text.replace(/```json|```/g, '').trim()
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON in response')
  return JSON.parse(clean.slice(start, end + 1)) as T
}

// ── Data fetchers ──────────────────────────────────────────────
async function fetchTopNews(): Promise<string> {
  try {
    const res = await fetch(
      'https://data.alpaca.markets/v1beta1/news?limit=50&sort=desc',
      { headers: ALPACA_HEADERS }
    )
    if (!res.ok) return 'No news data available'
    const data = await res.json()
    return (data.news || [])
      .slice(0, 40)
      .map((n: { headline: string; summary?: string; symbols?: string[] }) =>
        `• [${n.symbols?.join(',') || 'MARKET'}] ${n.headline}${n.summary ? ' — ' + n.summary.slice(0, 100) : ''}`
      ).join('\n')
  } catch { return 'News feed unavailable' }
}

async function fetchCryptoNews(): Promise<string> {
  try {
    const res = await fetch(
      'https://data.alpaca.markets/v1beta1/news?limit=20&sort=desc&symbols=BTC,ETH,SOL,DOGE,XRP',
      { headers: ALPACA_HEADERS }
    )
    if (!res.ok) return ''
    const data = await res.json()
    return (data.news || [])
      .slice(0, 15)
      .map((n: { headline: string; symbols?: string[] }) =>
        `• [${n.symbols?.join(',') || 'CRYPTO'}] ${n.headline}`
      ).join('\n')
  } catch { return '' }
}

// ── Gemini analysis ────────────────────────────────────────────
async function runGeminiAnalysis(marketNews: string, cryptoNews: string) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  })

  const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']

  for (const modelName of MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName })
      const response = await model.generateContent(`You are a financial analyst scanning today's news to find stocks and crypto that could make or lose money TODAY (${today}).

TODAY'S MARKET NEWS:
${marketNews}

TODAY'S CRYPTO NEWS:
${cryptoNews}

Analyze ALL headlines and identify the most important movers. For each ticker, assess if it is likely to go UP (bullish) or DOWN (bearish) TODAY based on specific news.

Focus on: earnings beats/misses, FDA decisions, M&A news, analyst upgrades/downgrades, product launches, legal/regulatory news, executive changes, macro data releases, crypto catalysts.

Respond JSON ONLY (no fences):
{
  "generatedAt": "${new Date().toISOString()}",
  "marketStatus": "one sentence on overall market mood today",
  "summary": "2-3 sentences on the most important themes driving markets today in plain English",
  "marketTheme": "the single dominant theme today e.g. 'AI earnings season'",
  "topBullish": [
    {
      "ticker": "SYMBOL",
      "companyName": "Full Company Name",
      "type": "stock",
      "signal": "BULLISH",
      "magnitude": "high|medium|low",
      "headline": "the exact headline driving this",
      "reason": "plain English explanation why this stock should go up today — write for a beginner",
      "catalyst": "specific event e.g. Beat Q3 earnings by 15%",
      "riskLevel": "high|medium|low",
      "timeframe": "today",
      "relatedNews": ["other relevant headline"]
    }
  ],
  "topBearish": [
    {
      "ticker": "SYMBOL",
      "companyName": "Full Company Name",
      "type": "stock",
      "signal": "BEARISH",
      "magnitude": "high|medium|low",
      "headline": "the exact headline driving this",
      "reason": "plain English why this could fall today",
      "catalyst": "specific event",
      "riskLevel": "high|medium|low",
      "timeframe": "today",
      "relatedNews": []
    }
  ],
  "watchlist": [
    {
      "ticker": "SYMBOL",
      "companyName": "Full Company Name",
      "type": "stock",
      "signal": "NEUTRAL",
      "magnitude": "medium",
      "headline": "headline",
      "reason": "why worth watching today",
      "catalyst": "what event to watch",
      "riskLevel": "medium",
      "timeframe": "today",
      "relatedNews": []
    }
  ],
  "sectorMovers": [
    {"sector": "Technology", "direction": "up|down|mixed", "reason": "why moving today"}
  ],
  "cryptoAlert": "1 sentence on major crypto news today, or null if nothing significant"
}

Rules: 4-6 bullish, 4-6 bearish, 3-4 watchlist. Include crypto if significant news exists. Only tickers with SPECIFIC news today. magnitude HIGH = 5%+ move expected, MEDIUM = 2-5%, LOW = <2%.`)

      return parseJSON(response.response.text())
    } catch (e) {
      const msg = (e as Error).message ?? ''
      if (!msg.includes('503') && !msg.includes('overload') && !msg.includes('high demand') && !msg.includes('404')) throw e
      console.warn(`Model ${modelName} unavailable, trying next...`)
    }
  }
  throw new Error('All Gemini models unavailable')
}

// ── Route handler ──────────────────────────────────────────────
// ── Sector top movers from Finnhub ─────────────────────────────
// Maps sector ETFs to their top constituent tickers
const SECTOR_TICKERS: Record<string, { name: string; emoji: string; tickers: string[] }> = {
  XLK:  { name: 'Technology',       emoji: '💻', tickers: ['NVDA','MSFT','AAPL','META','GOOGL','AVGO','ORCL','AMD','ADBE','CRM'] },
  XLV:  { name: 'Healthcare',       emoji: '🏥', tickers: ['LLY','UNH','JNJ','ABBV','MRK','TMO','ABT','DHR','PFE','AMGN'] },
  XLF:  { name: 'Financials',       emoji: '🏦', tickers: ['BRK-B','JPM','V','MA','BAC','GS','MS','WFC','BX','SPGI'] },
  XLE:  { name: 'Energy',           emoji: '⚡', tickers: ['XOM','CVX','COP','EOG','SLB','OXY','MPC','PSX','VLO','HES'] },
  XLY:  { name: 'Consumer Disc.',   emoji: '🛍', tickers: ['AMZN','TSLA','HD','MCD','NKE','LOW','SBUX','TJX','BKNG','CMG'] },
  XLP:  { name: 'Consumer Staples', emoji: '🛒', tickers: ['WMT','PG','KO','COST','PEP','PM','MDLZ','CL','GIS','KMB'] },
  XLI:  { name: 'Industrials',      emoji: '🏭', tickers: ['GE','CAT','UPS','HON','UNP','BA','DE','LMT','RTX','ETN'] },
  XLB:  { name: 'Materials',        emoji: '⛏',  tickers: ['LIN','SHW','APD','ECL','FCX','NEM','NUE','VMC','MLM','CTVA'] },
  XLRE: { name: 'Real Estate',      emoji: '🏠', tickers: ['PLD','AMT','EQIX','WELL','SPG','DLR','O','PSA','EXR','AVB'] },
  XLU:  { name: 'Utilities',        emoji: '💡', tickers: ['NEE','SO','DUK','SRE','AEP','D','PCG','EXC','XEL','WEC'] },
  XLC:  { name: 'Comm. Services',   emoji: '📡', tickers: ['META','GOOGL','NFLX','DIS','CHTR','T','VZ','TMUS','EA','TTWO'] },
}

async function fetchSectorTopMovers(): Promise<Array<{
  sector: string; etf: string; emoji: string; direction: string; etfChange: number;
  topMovers: Array<{ ticker: string; change: number; signal: 'up' | 'down' }>
}>> {
  const finnhubKey = process.env.FINNHUB_API_KEY
  if (!finnhubKey) return []

  const results = []

  for (const [etf, info] of Object.entries(SECTOR_TICKERS)) {
    try {
      // Get sector ETF change
      const etfRes = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${etf}&token=${finnhubKey}`
      )
      const etfQ = etfRes.ok ? await etfRes.json() : null
      const etfChange = etfQ?.dp ?? 0

      // Get top 10 constituent changes
      const tickerQuotes: Array<{ ticker: string; change: number; signal: 'up' | 'down' }> = []

      for (const ticker of info.tickers) {
        try {
          const res = await fetch(
            `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubKey}`
          )
          if (!res.ok) continue
          const q = await res.json()
          if (q.dp == null) continue
          tickerQuotes.push({
            ticker,
            change: parseFloat(q.dp.toFixed(2)),
            signal: q.dp >= 0 ? 'up' : 'down',
          })
        } catch { /* skip */ }
        await new Promise(r => setTimeout(r, 80)) // respect rate limit
      }

      // Sort by absolute change, take top 10
      const topMovers = tickerQuotes
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
        .slice(0, 10)

      const direction = etfChange > 0.3 ? 'up' : etfChange < -0.3 ? 'down' : 'mixed'

      results.push({
        sector: info.name,
        etf,
        emoji: info.emoji,
        direction,
        etfChange: parseFloat(etfChange.toFixed(2)),
        topMovers,
      })
    } catch { /* skip sector */ }
  }

  // Sort sectors by absolute ETF change (most active first)
  return results.sort((a, b) => Math.abs(b.etfChange) - Math.abs(a.etfChange))
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const forceRefresh = searchParams.get('refresh') === 'true'

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))

      try {
        const supabase = createServerClient()
        const today = todayUTC()

        // ── Cache check ──────────────────────────────────────
        if (!forceRefresh) {
          send('status', { message: 'Checking today\'s cached analysis...' })

          const { data: cached } = await supabase
            .from('news_cache')
            .select('*')
            .eq('cache_key', today)
            .maybeSingle()

          if (cached?.data) {
            const age = minutesAgo(cached.generated_at)
            send('status', { message: `Loaded cached analysis from ${age} minute${age === 1 ? '' : 's'} ago` })

            // Fetch live sector movers even for cached analysis (always fresh)
            const sectorTopMovers = await fetchSectorTopMovers().catch(() => [])

            // Add cache metadata to the response
            const result = {
              ...cached.data,
              sectorTopMovers,
              cached: true,
              cachedAt: cached.generated_at,
              ageMinutes: age,
            }
            send('complete', result)
            return
          }
        }

        // ── Fresh analysis ───────────────────────────────────
        send('status', { message: 'Fetching today\'s financial headlines & sector data...' })
        const [marketNews, cryptoNews, sectorTopMovers] = await Promise.all([
          fetchTopNews(),
          fetchCryptoNews(),
          fetchSectorTopMovers(),
        ])

        send('status', { message: 'The council is analyzing today\'s market movers...' })
        const result = await runGeminiAnalysis(marketNews, cryptoNews)

        // ── Save to Supabase (upsert — one row per day) ──────
        await supabase
          .from('news_cache')
          .upsert(
            { cache_key: today, cache_date: today, generated_at: new Date().toISOString(), data: result },
            { onConflict: 'cache_key' }
          )

        send('complete', { ...(result as Record<string, unknown>), sectorTopMovers, cached: false, ageMinutes: 0 })

      } catch (err) {
        console.error('News error:', err)
        send('error', { message: err instanceof Error ? err.message : 'Failed to load news' })
      } finally {
        controller.close()
      }
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
