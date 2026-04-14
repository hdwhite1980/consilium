import { NextRequest } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

const ALPACA_HEADERS = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
  'Accept': 'application/json',
}

export interface NewsMover {
  ticker: string
  companyName: string
  type: 'stock' | 'crypto'
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  magnitude: 'high' | 'medium' | 'low'  // expected move size
  headline: string
  reason: string           // plain English why
  catalyst: string         // specific event driving it
  riskLevel: 'high' | 'medium' | 'low'
  timeframe: string        // 'today' | 'this week'
  relatedNews: string[]
}

export interface NewsPageData {
  generatedAt: string
  marketStatus: string
  topBullish: NewsMover[]
  topBearish: NewsMover[]
  watchlist: NewsMover[]   // neutral but worth watching
  marketTheme: string      // overarching theme of the day
  sectorMovers: Array<{ sector: string; direction: string; reason: string }>
  cryptoAlert: string | null
  summary: string          // 2-3 sentence day summary
}

async function fetchTopNews(): Promise<string> {
  try {
    // Fetch latest general market news
    const res = await fetch(
      'https://data.alpaca.markets/v1beta1/news?limit=50&sort=desc',
      { headers: ALPACA_HEADERS, next: { revalidate: 900 } } // 15 min cache
    )
    if (!res.ok) return 'No news data available'
    const data = await res.json()
    const news = data.news || []
    return news
      .slice(0, 40)
      .map((n: { headline: string; summary?: string; symbols?: string[]; created_at: string }) =>
        `• [${n.symbols?.join(',') || 'MARKET'}] ${n.headline}${n.summary ? ' — ' + n.summary.slice(0, 100) : ''}`
      )
      .join('\n')
  } catch {
    return 'News feed unavailable'
  }
}

async function fetchCryptoNews(): Promise<string> {
  try {
    const res = await fetch(
      'https://data.alpaca.markets/v1beta1/news?limit=20&sort=desc&symbols=BTC,ETH,SOL,DOGE,XRP',
      { headers: ALPACA_HEADERS, next: { revalidate: 900 } }
    )
    if (!res.ok) return ''
    const data = await res.json()
    const news = data.news || []
    return news
      .slice(0, 15)
      .map((n: { headline: string; symbols?: string[] }) =>
        `• [${n.symbols?.join(',') || 'CRYPTO'}] ${n.headline}`
      )
      .join('\n')
  } catch {
    return ''
  }
}

function parseJSON<T>(text: string): T {
  const clean = text.replace(/```json|```/g, '').trim()
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON in response')
  return JSON.parse(clean.slice(start, end + 1)) as T
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
        send('status', { message: 'Scanning today\'s financial news...' })

        // Fetch news in parallel
        const [marketNews, cryptoNews] = await Promise.all([
          fetchTopNews(),
          fetchCryptoNews(),
        ])

        send('status', { message: 'Gemini is analyzing market movers...' })

        const today = new Date().toLocaleDateString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        })

        const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']
        let result: NewsPageData | null = null

        for (const modelName of GEMINI_MODELS) {
          try {
            const model = genAI.getGenerativeModel({ model: modelName })
            const response = await model.generateContent(`You are a financial analyst scanning today's news to find stocks and crypto that could make or lose money TODAY (${today}).

TODAY'S MARKET NEWS:
${marketNews}

TODAY'S CRYPTO NEWS:
${cryptoNews}

Analyze ALL headlines and identify the most important movers. For each ticker mentioned, assess if it is likely to go UP (bullish) or DOWN (bearish) TODAY based on the news.

Focus on:
- Earnings beats/misses
- FDA approvals/rejections  
- Merger/acquisition news
- Analyst upgrades/downgrades
- Product launches or failures
- Legal/regulatory news
- Executive changes
- Macro data releases affecting sectors
- Crypto-specific catalysts

Respond with JSON ONLY (no markdown fences, no explanation outside JSON):
{
  "generatedAt": "${new Date().toISOString()}",
  "marketStatus": "one sentence on overall market mood today",
  "summary": "2-3 sentences summarizing the most important themes driving markets today in plain English",
  "marketTheme": "the single dominant theme today e.g. 'AI earnings season', 'Fed rate concerns', 'biotech catalyst day'",
  "topBullish": [
    {
      "ticker": "SYMBOL",
      "companyName": "Full Company Name",
      "type": "stock",
      "signal": "BULLISH",
      "magnitude": "high|medium|low",
      "headline": "the exact headline driving this",
      "reason": "plain English explanation of why this stock should go up today — write as if explaining to a beginner",
      "catalyst": "specific event e.g. 'Beat Q3 earnings by 15%, raised guidance'",
      "riskLevel": "high|medium|low",
      "timeframe": "today",
      "relatedNews": ["other relevant headline 1", "other relevant headline 2"]
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
      "reason": "plain English explanation of why this stock could fall today",
      "catalyst": "specific event e.g. 'Missed revenue estimates, cut full year guidance'",
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
      "reason": "why this is worth watching today",
      "catalyst": "what event to watch",
      "riskLevel": "medium",
      "timeframe": "today",
      "relatedNews": []
    }
  ],
  "sectorMovers": [
    {"sector": "Technology", "direction": "up|down|mixed", "reason": "why this sector is moving today"}
  ],
  "cryptoAlert": "1 sentence on any major crypto news today, or null if nothing significant"
}

Rules:
- Include 4-6 bullish tickers, 4-6 bearish tickers, 3-4 watchlist tickers
- Include crypto tickers (BTC, ETH, SOL etc) in bullish/bearish if there is significant crypto news
- Only include tickers that have SPECIFIC news today — do not guess
- Plain English explanations should be simple enough for someone who has never traded
- magnitude HIGH = potential 5%+ move, MEDIUM = 2-5%, LOW = <2%
- Include 2-4 sector movers`)

            result = parseJSON<NewsPageData>(response.response.text())
            break
          } catch (e) {
            const msg = (e as Error).message ?? ''
            if (!msg.includes('503') && !msg.includes('overload') && !msg.includes('high demand') && !msg.includes('404')) throw e
            console.warn(`Model ${modelName} unavailable, trying next...`)
          }
        }

        if (!result) throw new Error('All Gemini models unavailable')

        send('complete', result)

      } catch (err) {
        console.error('News page error:', err)
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
