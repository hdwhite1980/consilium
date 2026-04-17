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

// ── Sector top movers ──────────────────────────────────────────
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
      const etfRes = await fetch(`https://finnhub.io/api/v1/quote?symbol=${etf}&token=${finnhubKey}`)
      const etfQ = etfRes.ok ? await etfRes.json() : null
      const etfChange = etfQ?.dp ?? 0
      const tickerQuotes: Array<{ ticker: string; change: number; signal: 'up' | 'down' }> = []
      for (const ticker of info.tickers) {
        try {
          const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubKey}`)
          if (!res.ok) continue
          const q = await res.json()
          if (q.dp == null) continue
          tickerQuotes.push({ ticker, change: parseFloat(q.dp.toFixed(2)), signal: q.dp >= 0 ? 'up' : 'down' })
        } catch { /* skip */ }
        await new Promise(r => setTimeout(r, 80))
      }
      const topMovers = tickerQuotes.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 10)
      results.push({ sector: info.name, etf, emoji: info.emoji, direction: etfChange > 0.3 ? 'up' : etfChange < -0.3 ? 'down' : 'mixed', etfChange: parseFloat(etfChange.toFixed(2)), topMovers })
    } catch { /* skip */ }
  }
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
        const today = getTodayStr()
        const cacheKey = `tomorrow_${today}`

        // ── Cache check ──────────────────────────────────────
        if (!forceRefresh) {
          send('status', { message: 'Checking cached analysis...' })
          const { data: cached } = await supabase
            .from('news_cache')
            .select('*')
            .eq('cache_key', cacheKey)
            .maybeSingle()

          if (cached?.data) {
            const age = Math.round((Date.now() - new Date(cached.generated_at).getTime()) / 60000)
            send('status', { message: `Loaded cached analysis from ${age} minute${age === 1 ? '' : 's'} ago` })
            const sectorTopMovers = await fetchSectorTopMovers().catch(() => [])
            send('complete', { ...cached.data, sectorTopMovers, cached: true, ageMinutes: age })
            return
          }
        }

        // ── Fresh analysis ───────────────────────────────────
        send('status', { message: 'Gathering market intelligence for tomorrow...' })

        const [marketNews, cryptoNews, sectorTopMovers] = await Promise.all([
          fetchSectorTopMovers(),
          fetchUpcomingNews(),
          fetchCryptoNews(),
        ])

        send('status', { message: 'The council is building tomorrow\'s playbook...' })

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

        // Save to cache
        try {
          const saveResult = await supabase
            .from('news_cache')
            .upsert(
              { cache_key: cacheKey, cache_date: getTodayStr(), generated_at: new Date().toISOString(), data: result },
              { onConflict: 'cache_key' }
            )
          if (saveResult.error) {
            console.error('Tomorrow cache save error:', saveResult.error)
          }
        } catch (saveErr) {
          console.error('Tomorrow cache save failed:', saveErr)
        }

        send('complete', { ...(result as Record<string, unknown>), sectorTopMovers, cached: false, ageMinutes: 0 })

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
