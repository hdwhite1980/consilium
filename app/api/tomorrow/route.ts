import { NextRequest } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { createServerClient } from '@/app/lib/supabase'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

const ALPACA_HEADERS = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
  'Accept': 'application/json',
}

// Get next trading day
function getNextTradingDay(): string {
  const now = new Date()
  const day = now.getDay() // 0=Sun, 1=Mon...6=Sat
  const daysAhead = day === 5 ? 3 : day === 6 ? 2 : 1 // skip weekend
  const next = new Date(now)
  next.setDate(next.getDate() + daysAhead)
  return next.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function getTodayStr(): string {
  return new Date().toISOString().split('T')[0]
}

async function fetchUpcomingNews(): Promise<string> {
  try {
    const res = await fetch(
      'https://data.alpaca.markets/v1beta1/news?limit=50&sort=desc',
      { headers: ALPACA_HEADERS }
    )
    if (!res.ok) return ''
    const data = await res.json()
    return (data.news || []).slice(0, 40)
      .map((n: { headline: string; summary?: string; symbols?: string[] }) =>
        `• [${n.symbols?.join(',') || 'MARKET'}] ${n.headline}${n.summary ? ' — ' + n.summary.slice(0, 120) : ''}`
      ).join('\n')
  } catch { return '' }
}

async function fetchCryptoNews(): Promise<string> {
  try {
    const res = await fetch(
      'https://data.alpaca.markets/v1beta1/news?limit=20&sort=desc&symbols=BTC,ETH,SOL,DOGE,XRP',
      { headers: ALPACA_HEADERS }
    )
    if (!res.ok) return ''
    const data = await res.json()
    return (data.news || []).slice(0, 15)
      .map((n: { headline: string; symbols?: string[] }) =>
        `• [${n.symbols?.join(',') || 'CRYPTO'}] ${n.headline}`
      ).join('\n')
  } catch { return '' }
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
        const supabase = createServerClient()
        const today = getTodayStr()
        const cacheKey = `tomorrow_${today}`

        // ── Cache check ──────────────────────────────────────
        if (!forceRefresh) {
          send('status', { message: 'Checking cached analysis...' })
          const { data: cached } = await supabase
            .from('news_cache')
            .select('*')
            .eq('cache_key', cacheKey)
            .single()

          if (cached?.data) {
            const age = Math.round((Date.now() - new Date(cached.generated_at).getTime()) / 60000)
            send('status', { message: `Loaded cached analysis from ${age} minute${age === 1 ? '' : 's'} ago` })
            send('complete', { ...cached.data, cached: true, ageMinutes: age })
            return
          }
        }

        // ── Fresh analysis ───────────────────────────────────
        send('status', { message: 'Gathering market intelligence for tomorrow...' })

        const [marketNews, cryptoNews] = await Promise.all([
          fetchUpcomingNews(),
          fetchCryptoNews(),
        ])

        send('status', { message: 'Gemini is building tomorrow\'s playbook...' })

        const nextDay = getNextTradingDay()
        const today_display = new Date().toLocaleDateString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        })

        const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']
        let result = null

        for (const modelName of MODELS) {
          try {
            const model = genAI.getGenerativeModel({ model: modelName })
            const response = await model.generateContent(`You are a professional market strategist preparing traders for the NEXT trading day (${nextDay}). Today is ${today_display}.

CURRENT MARKET NEWS AND DEVELOPMENTS:
${marketNews}

CRYPTO DEVELOPMENTS:
${cryptoNews}

Your job is to look AHEAD and identify:
1. Stocks with earnings reports tomorrow or in the next 2 days
2. Stocks reacting to news TODAY that will continue moving tomorrow
3. Scheduled economic data releases that will move markets (Fed minutes, CPI, jobs report, etc.)
4. Stocks setting up technically for a big move (consolidation breaking out, approaching key levels)
5. Sector rotations already in progress
6. Any pre-market catalysts to watch (analyst days, product launches, FDA decisions)
7. Crypto setups heading into tomorrow

Think like a professional trader preparing their watchlist the night before.

Respond JSON ONLY (no markdown):
{
  "nextTradingDay": "${nextDay}",
  "generatedAt": "${new Date().toISOString()}",
  "marketOutlook": "2-3 sentence overall market setup heading into tomorrow — what is the dominant theme, what is the macro backdrop, is sentiment risk-on or risk-off?",
  "keyTheme": "single most important theme for tomorrow e.g. 'Earnings season ramp-up', 'Fed decision reaction', 'Sector rotation into defensives'",
  "preMarketWatchlist": [
    {
      "ticker": "SYMBOL",
      "companyName": "Full Company Name",
      "type": "stock",
      "signal": "BULLISH|BEARISH|NEUTRAL",
      "catalyst": "specific reason e.g. 'Reports earnings before market open — expected $1.20 EPS'",
      "setupType": "earnings|technical_breakout|news_continuation|sector_play|macro_event|catalyst",
      "magnitude": "high|medium|low",
      "keyLevel": "specific price level to watch e.g. 'Watch $45.50 — if it holds pre-market this confirms bullish setup'",
      "planBull": "what to watch for if bullish scenario plays out",
      "planBear": "what to watch for if bearish scenario plays out",
      "timeOfDay": "pre-market|market-open|intraday|after-hours",
      "riskLevel": "high|medium|low",
      "plainEnglish": "2-3 sentences explaining this setup to a beginner — what is happening and what to watch for tomorrow"
    }
  ],
  "earningsCalendar": [
    {
      "ticker": "SYMBOL",
      "companyName": "Full Name",
      "reportTime": "pre-market|after-hours|during-market",
      "expectedMove": "percentage e.g. ±5%",
      "analystExpectation": "brief summary of what analysts expect",
      "watchFor": "what will make it a beat or miss"
    }
  ],
  "economicEvents": [
    {
      "event": "event name e.g. 'Fed Minutes Release'",
      "time": "approximate time e.g. '2:00 PM ET'",
      "impact": "high|medium|low",
      "whatToWatch": "plain English explanation of what this means for markets"
    }
  ],
  "sectorSetups": [
    {
      "sector": "sector name",
      "etf": "e.g. XLK",
      "direction": "bullish|bearish|mixed",
      "reason": "why this sector is set up for a move tomorrow",
      "topPlay": "best individual stock play in this sector for tomorrow"
    }
  ],
  "cryptoSetup": "2-3 sentences on crypto heading into tomorrow — any key levels, catalysts, or setups to watch",
  "openingBellPlaybook": "A plain English step-by-step guide for what to do in the first 30 minutes of trading tomorrow. Written for someone new to trading. What should they watch, what price levels matter, when should they wait vs act?",
  "riskFactors": ["key risk 1 that could change the outlook", "key risk 2", "key risk 3"]
}

Rules:
- Only include tickers with SPECIFIC setups or catalysts — no speculation without basis
- The preMarketWatchlist should have 5-8 stocks/crypto
- earningsCalendar should list any earnings reports you know about tomorrow (can be empty array if none known)
- economicEvents can be empty array if no major events
- Be specific with price levels where possible
- Write for a mix of beginners and experienced traders`)

            result = parseJSON(response.response.text())
            break
          } catch (e) {
            const msg = (e as Error).message ?? ''
            if (!msg.includes('503') && !msg.includes('overload') && !msg.includes('404')) throw e
            console.warn(`Model ${modelName} unavailable, trying next...`)
          }
        }

        if (!result) throw new Error('All models unavailable')

        // Save to cache (use tomorrow's date as key so it persists all day)
        await supabase
          .from('news_cache')
          .upsert(
            { cache_key: cacheKey, cache_date: getTodayStr(), generated_at: new Date().toISOString(), data: result },
            { onConflict: 'cache_key' }
          )

        send('complete', { ...(result as Record<string, unknown>), cached: false, ageMinutes: 0 })

      } catch (err) {
        console.error('Tomorrow movers error:', err)
        send('error', { message: err instanceof Error ? err.message : 'Failed to generate analysis' })
      } finally {
        controller.close()
      }
    }
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  })
}
