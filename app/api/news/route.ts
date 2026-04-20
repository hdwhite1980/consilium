// ═════════════════════════════════════════════════════════════
// app/api/news/route.ts — Today's Movers (rewrite)
//
// What changed vs the original:
//   1. Multi-source news (Alpaca + Finnhub per-ticker + Gemini grounded)
//   2. Market regime context injected into the prompt
//   3. Claude Sonnet 4 classification with confidence scores (0-100)
//   4. Gemini Pro grounded verification of top 5 classifications
//   5. Confidence threshold filtering (≥60% shown by default)
//   6. Telemetry — every flagged mover written to movers_log
//   7. Sector top movers cached 5 min (was refetching every request)
//
// Preserves:
//   - SSE streaming protocol (same events as before)
//   - news_cache table for daily cache
//   - Response shape (adds fields, doesn't remove any)
// ═════════════════════════════════════════════════════════════

import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { createServerClient } from '@/app/lib/supabase'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { fetchMultiSourceNews, formatNewsForPrompt, type NewsItem } from '@/app/lib/multi-source-news'
import { getMarketRegime, type MarketRegime } from '@/app/lib/market-regime'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

const getAdminClient = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ── Helpers ────────────────────────────────────────────────────
function todayUTC(): string {
  return new Date().toISOString().split('T')[0]
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

// ── Sector top movers (cached 5 min) ───────────────────────────
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

// In-memory cache for sector top movers — 5 minute TTL.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sectorCache: { data: any[]; fetchedAt: number } | null = null
const SECTOR_CACHE_TTL_MS = 5 * 60 * 1000

async function fetchSectorTopMovers(): Promise<Array<{
  sector: string; etf: string; emoji: string; direction: string; etfChange: number;
  topMovers: Array<{ ticker: string; change: number; signal: 'up' | 'down' }>
}>> {
  // Cache hit?
  if (sectorCache && Date.now() - sectorCache.fetchedAt < SECTOR_CACHE_TTL_MS) {
    return sectorCache.data
  }

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
      results.push({
        sector: info.name,
        etf,
        emoji: info.emoji,
        direction: etfChange > 0.3 ? 'up' : etfChange < -0.3 ? 'down' : 'mixed',
        etfChange: parseFloat(etfChange.toFixed(2)),
        topMovers,
      })
    } catch { /* skip */ }
  }

  const sorted = results.sort((a, b) => Math.abs(b.etfChange) - Math.abs(a.etfChange))
  sectorCache = { data: sorted, fetchedAt: Date.now() }
  return sorted
}

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
interface ClassifiedMover {
  ticker: string
  companyName: string
  type: 'stock' | 'crypto'
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  magnitude: 'high' | 'medium' | 'low'
  confidence: number  // 0-100
  headline: string
  reason: string
  catalyst: string
  riskLevel: 'high' | 'medium' | 'low'
  timeframe: 'today'
  relatedNews: string[]
  // Verification fields (added after Pass 2)
  verified?: boolean
  verificationSources?: string[]
  verificationNote?: string
}

interface ClassificationResult {
  generatedAt: string
  marketStatus: string
  summary: string
  marketTheme: string
  topBullish: ClassifiedMover[]
  topBearish: ClassifiedMover[]
  watchlist: ClassifiedMover[]
  sectorMovers: Array<{ sector: string; direction: string; reason: string }>
  cryptoAlert: string | null
}

// ─────────────────────────────────────────────────────────────
// Pass 1: Claude Sonnet 4 classifies news into movers with confidence
// ─────────────────────────────────────────────────────────────
async function classifyWithClaude(
  newsBlock: string,
  regime: MarketRegime,
  today: string
): Promise<ClassificationResult> {
  const system = `You are a financial analyst scanning today's news to find stocks and crypto that could make or lose money TODAY (${today}).

You have market regime context. Use it. Bullish news in risk-off markets often fades. Bearish news in risk-on markets often gets bought. Factor this into your confidence scores — don't just classify the headline in isolation.

For every mover you flag, you MUST assign a confidence score from 0-100 representing how likely your directional call will be correct by end of day:
  - 80-100: extremely high conviction, clear catalyst, supports regime
  - 65-79: strong conviction, clear catalyst
  - 50-64: moderate conviction, some signal
  - below 50: don't flag — not worth including

Only include movers with confidence >= 60. Quality over quantity.

All numeric fields must be plain numbers — no $ signs, no commas.`

  const user = `MARKET REGIME RIGHT NOW:
${regime.contextParagraph}

NEWS HEADLINES (deduped, from Alpaca + Finnhub + Gemini grounded search):
${newsBlock}

Analyze these headlines and identify the most important movers for TODAY. Focus on: earnings beats/misses, FDA decisions, M&A news, analyst upgrades/downgrades, product launches, legal/regulatory news, executive changes, macro data, crypto catalysts.

For each ticker you flag:
- "signal": BULLISH if likely up today, BEARISH if down, NEUTRAL if worth watching
- "magnitude": HIGH if expecting 5%+ move, MEDIUM if 2-5%, LOW if <2%
- "confidence": 0-100 score, must be >= 60 to include
- "catalyst": the specific event driving this (e.g. "Beat Q2 earnings by 12%")
- "reason": plain English explanation a beginner could understand, 1-2 sentences
- "riskLevel": based on volatility, spread, float

Do NOT include movers without a specific news catalyst in the feed. Do NOT speculate about tickers not mentioned in the news block.

Respond JSON ONLY (no markdown, no preamble):
{
  "generatedAt": "${new Date().toISOString()}",
  "marketStatus": "one sentence on overall market mood today given the regime",
  "summary": "2-3 sentences on the most important themes driving markets today in plain English",
  "marketTheme": "single dominant theme today",
  "topBullish": [
    {
      "ticker": "SYMBOL",
      "companyName": "Full Company Name",
      "type": "stock",
      "signal": "BULLISH",
      "magnitude": "high",
      "confidence": 72,
      "headline": "the exact headline driving this",
      "reason": "plain English explanation — why this stock should go up today",
      "catalyst": "specific event e.g. Beat Q3 earnings by 15%",
      "riskLevel": "medium",
      "timeframe": "today",
      "relatedNews": ["other relevant headline if multiple support this"]
    }
  ],
  "topBearish": [],
  "watchlist": [],
  "sectorMovers": [
    {"sector": "Technology", "direction": "up|down|mixed", "reason": "why moving today"}
  ],
  "cryptoAlert": "1 sentence on major crypto news today, or null if nothing significant"
}

Rules:
- 3-5 bullish, 3-5 bearish, 2-4 watchlist (fewer is better if conviction isn't there)
- Every item MUST have confidence >= 60
- Crypto (type: "crypto") included only if significant news exists
- Tickers must be uppercase US equity or major crypto symbols`

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: user }],
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (msg.content[0] as any).text as string
  const parsed = parseJSON<ClassificationResult>(text)

  // Sanity: ensure required arrays exist and drop anything below confidence threshold
  const filterMovers = (list: ClassifiedMover[] | undefined): ClassifiedMover[] =>
    (list ?? []).filter(m =>
      m && m.ticker && typeof m.confidence === 'number' && m.confidence >= 60
    )

  return {
    ...parsed,
    topBullish: filterMovers(parsed.topBullish),
    topBearish: filterMovers(parsed.topBearish),
    watchlist: filterMovers(parsed.watchlist),
    sectorMovers: Array.isArray(parsed.sectorMovers) ? parsed.sectorMovers : [],
  }
}

// ─────────────────────────────────────────────────────────────
// Pass 2: Gemini Pro grounded verification of top 5 movers
//
// For each of the top-confidence movers, we ask Gemini with Google Search
// grounding whether credible sources (Reuters, Bloomberg, WSJ, CNBC)
// actually confirm the catalyst. Unverified movers get demoted, not
// dropped (the original Gemini classification may still be useful).
// ─────────────────────────────────────────────────────────────
interface VerificationResult {
  ticker: string
  verified: boolean
  sources: string[]
  note: string
}

async function verifyMoversWithGemini(
  movers: ClassifiedMover[],
  today: string
): Promise<Map<string, VerificationResult>> {
  const resultMap = new Map<string, VerificationResult>()
  if (movers.length === 0) return resultMap

  // Verify top 5 by confidence (across all three lists combined)
  const top5 = movers.slice(0, 5)
  const list = top5.map((m, i) =>
    `[${i + 1}] ${m.ticker} (${m.signal}): ${m.catalyst} — headline was "${m.headline}"`
  ).join('\n')

  const prompt = `You are a financial fact-checker. For each ticker claim below, use Google Search to verify whether CREDIBLE mainstream financial sources (Reuters, Bloomberg, WSJ, CNBC, MarketWatch, Financial Times, Barron's, or primary sources like SEC filings and company IR pages) actually confirm the catalyst.

Today's date: ${today}

CLAIMS TO VERIFY:
${list}

For EACH claim, return:
- verified: true if at least one credible outlet reports the catalyst
- sources: array of 1-3 credible URLs you found (empty array if none)
- note: 1 sentence on what you confirmed or why it couldn't be verified

DO NOT count X/Twitter, Reddit, Stocktwits, YouTube, or random blogs as credible.

Return ONLY this JSON, no preamble or markdown:
{
  "verifications": [
    {
      "ticker": "AAPL",
      "verified": true,
      "sources": ["https://www.reuters.com/..."],
      "note": "Reuters confirmed Apple beat Q2 earnings on 2026-04-20"
    }
  ]
}`

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-pro',
      generationConfig: { temperature: 0.1, maxOutputTokens: 2500 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [{ googleSearch: {} } as any],
    })
    const result = await model.generateContent(prompt)
    const text = result.response.text()
    const clean = text.replace(/```json|```/g, '').trim()
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    if (start === -1 || end === -1) return resultMap

    const parsed = JSON.parse(clean.slice(start, end + 1))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verifications: any[] = Array.isArray(parsed.verifications) ? parsed.verifications : []

    for (const v of verifications) {
      if (!v?.ticker) continue
      resultMap.set(v.ticker.toUpperCase(), {
        ticker: v.ticker.toUpperCase(),
        verified: !!v.verified,
        sources: Array.isArray(v.sources) ? v.sources.filter((u: unknown) => typeof u === 'string').slice(0, 3) : [],
        note: typeof v.note === 'string' ? v.note.slice(0, 250) : '',
      })
    }
  } catch (e) {
    console.warn('[today-movers] verification failed:', (e as Error).message?.slice(0, 120))
  }
  return resultMap
}

// ─────────────────────────────────────────────────────────────
// Telemetry: write flagged movers to movers_log
// Fire-and-forget so we don't block the response.
// ─────────────────────────────────────────────────────────────
function logMoversToDb(
  result: ClassificationResult,
  regime: MarketRegime,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pricesAtFlag: Record<string, number>
): void {
  void (async () => {
    try {
      const admin = getAdminClient()
      const allMovers: ClassifiedMover[] = [
        ...result.topBullish,
        ...result.topBearish,
        ...result.watchlist,
      ]

      const rows = allMovers.map(m => ({
        source: 'today',
        ticker: m.ticker.toUpperCase(),
        company_name: m.companyName ?? null,
        asset_type: m.type ?? 'stock',
        signal: m.signal,
        magnitude: m.magnitude ?? null,
        confidence: m.confidence ?? null,
        timeframe: 'today',
        headline: m.headline ?? null,
        catalyst: m.catalyst ?? null,
        reason: m.reason ?? null,
        classification_model: 'claude-sonnet-4',
        verification_status: m.verified === true ? 'verified' : m.verified === false ? 'stripped' : 'skipped',
        verification_sources: m.verificationSources ?? null,
        market_regime: regime.regime,
        spy_change_pct: regime.spyChangePct,
        vix_level: regime.vixLevel,
        price_at_flag: pricesAtFlag[m.ticker.toUpperCase()] ?? null,
      }))

      if (rows.length > 0) {
        const { error } = await admin.from('movers_log').insert(rows)
        if (error) console.warn('[today-movers/log] insert failed:', error.message)
      }
    } catch (e) {
      console.warn('[today-movers/log] fire-and-forget failed:', (e as Error).message?.slice(0, 100))
    }
  })()
}

// ─────────────────────────────────────────────────────────────
// Fetch current prices for all movers (best-effort, for telemetry)
// ─────────────────────────────────────────────────────────────
async function fetchPricesForMovers(tickers: string[]): Promise<Record<string, number>> {
  const token = process.env.FINNHUB_API_KEY
  if (!token || tickers.length === 0) return {}
  const prices: Record<string, number> = {}
  await Promise.all(tickers.slice(0, 20).map(async (t) => {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 3000)
      try {
        const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${t}&token=${token}`, {
          signal: ctrl.signal, cache: 'no-store',
        })
        if (res.ok) {
          const q = await res.json()
          if (typeof q?.c === 'number' && q.c > 0) prices[t.toUpperCase()] = q.c
        }
      } finally { clearTimeout(timer) }
    } catch { /* skip */ }
  }))
  return prices
}

// ─────────────────────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const forceRefresh = searchParams.get('refresh') === 'true'

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      let controllerClosed = false
      const send = (event: string, data: unknown) => {
        if (controllerClosed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch { controllerClosed = true }
      }

      // Heartbeat to prevent edge proxy from killing the connection
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: heartbeat\n\n`)) } catch { /* stream closed */ }
      }, 15000)

      const pipelineStart = Date.now()
      console.log('[today-movers] START')

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

            // Fetch fresh sector movers even for cache hits (now cached internally 5 min)
            const sectorTopMovers = await fetchSectorTopMovers().catch(() => [])

            send('complete', {
              ...cached.data,
              sectorTopMovers,
              cached: true,
              cachedAt: cached.generated_at,
              ageMinutes: age,
            })
            console.log(`[today-movers] cache hit (age ${age}m) in ${Date.now() - pipelineStart}ms`)
            return
          }
        }

        // ── Fresh analysis ───────────────────────────────────
        send('status', { message: 'Fetching news, market regime, and sector data...' })

        const parallelStart = Date.now()
        const [newsResult, regime, sectorTopMovers] = await Promise.all([
          fetchMultiSourceNews({ includeCrypto: true }),
          getMarketRegime(),
          fetchSectorTopMovers(),
        ])
        console.log(`[today-movers] parallel fetch ${Date.now() - parallelStart}ms (news:${newsResult.counts.afterDedupe} regime:${regime.regime})`)

        // Build the news block for Claude
        const newsBlock = formatNewsForPrompt(newsResult.items, 40)

        // ── Pass 1: Claude classifies ────────────────────────
        send('status', { message: `Market regime: ${regime.regime}. Claude is classifying movers with confidence scores...` })
        const classifyStart = Date.now()
        const result = await classifyWithClaude(newsBlock, regime, today)
        console.log(`[today-movers] classification ${Date.now() - classifyStart}ms (bull:${result.topBullish.length} bear:${result.topBearish.length} watch:${result.watchlist.length})`)

        // ── Pass 2: Gemini verifies top-confidence movers ────
        send('status', { message: 'Verifying top movers against Reuters, Bloomberg, WSJ...' })
        const verifyStart = Date.now()
        // Combine all movers, sort by confidence, take top 5 for verification
        const allMoversSorted = [
          ...result.topBullish,
          ...result.topBearish,
          ...result.watchlist,
        ].sort((a, b) => b.confidence - a.confidence)

        const verifications = await verifyMoversWithGemini(allMoversSorted, today)
        console.log(`[today-movers] verification ${Date.now() - verifyStart}ms (${verifications.size} verified)`)

        // Attach verification fields to each mover
        const attachVerif = (m: ClassifiedMover): ClassifiedMover => {
          const v = verifications.get(m.ticker.toUpperCase())
          if (!v) return m
          return {
            ...m,
            verified: v.verified,
            verificationSources: v.sources,
            verificationNote: v.note,
          }
        }
        result.topBullish = result.topBullish.map(attachVerif)
        result.topBearish = result.topBearish.map(attachVerif)
        result.watchlist = result.watchlist.map(attachVerif)

        // ── Telemetry: log to movers_log (fire-and-forget) ───
        const allTickers = [...result.topBullish, ...result.topBearish, ...result.watchlist]
          .map(m => m.ticker.toUpperCase())
        const pricesAtFlag = await fetchPricesForMovers(allTickers).catch(() => ({}))
        logMoversToDb(result, regime, pricesAtFlag)

        // ── Save to Supabase news_cache ──────────────────────
        await supabase
          .from('news_cache')
          .upsert(
            { cache_key: today, cache_date: today, generated_at: new Date().toISOString(), data: result },
            { onConflict: 'cache_key' }
          )

        const totalMs = Date.now() - pipelineStart
        console.log(`[today-movers] TOTAL ${totalMs}ms (${(totalMs/1000).toFixed(1)}s)`)

        send('complete', {
          ...result,
          sectorTopMovers,
          regime: {
            label: regime.regime,
            spyChangePct: regime.spyChangePct,
            vixLevel: regime.vixLevel,
            context: regime.contextParagraph,
          },
          newsCounts: newsResult.counts,
          cached: false,
          ageMinutes: 0,
          elapsedMs: totalMs,
        })
      } catch (err) {
        console.error('[today-movers] error:', err)
        send('error', { message: err instanceof Error ? err.message : 'Failed to load news' })
      } finally {
        clearInterval(heartbeat)
        controllerClosed = true
        try { controller.close() } catch { /* already closed */ }
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
