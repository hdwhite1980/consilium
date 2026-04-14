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
            .eq('cache_date', today)
            .single()

          if (cached?.data) {
            const age = minutesAgo(cached.generated_at)
            send('status', { message: `Loaded cached analysis from ${age} minute${age === 1 ? '' : 's'} ago` })

            // Add cache metadata to the response
            const result = {
              ...cached.data,
              cached: true,
              cachedAt: cached.generated_at,
              ageMinutes: age,
            }
            send('complete', result)
            return
          }
        }

        // ── Fresh analysis ───────────────────────────────────
        send('status', { message: 'Fetching today\'s financial headlines...' })
        const [marketNews, cryptoNews] = await Promise.all([
          fetchTopNews(),
          fetchCryptoNews(),
        ])

        send('status', { message: 'Gemini is analyzing today\'s market movers...' })
        const result = await runGeminiAnalysis(marketNews, cryptoNews)

        // ── Save to Supabase (upsert — one row per day) ──────
        await supabase
          .from('news_cache')
          .upsert(
            { cache_date: today, generated_at: new Date().toISOString(), data: result },
            { onConflict: 'cache_date' }
          )

        send('complete', { ...(result as Record<string, unknown>), cached: false, ageMinutes: 0 })

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
