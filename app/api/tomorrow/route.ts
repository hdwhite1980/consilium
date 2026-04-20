// ═════════════════════════════════════════════════════════════
// app/api/tomorrow/route.ts — Tomorrow's Movers (rewrite)
//
// What changed vs the original:
//   1. Real Finnhub earnings calendar for next trading day (no more hallucinated dates)
//   2. Real Finnhub economic calendar (Fed, CPI, jobs — actual scheduled events)
//   3. After-hours price moves on today's earnings reporters
//   4. Multi-source news (Alpaca + Finnhub + Gemini grounded)
//   5. Market regime context injected into prompt
//   6. Claude Sonnet 4 classification with confidence scores
//   7. Gemini 2.5 Pro grounded verification of top 5
//   8. Confidence thresholding (≥60% shown)
//   9. Telemetry to movers_log with source='tomorrow'
//
// Preserves:
//   - SSE streaming protocol
//   - news_cache table with 'tomorrow_YYYY-MM-DD' key
//   - Client response shape (adds fields, doesn't remove)
// ═════════════════════════════════════════════════════════════

import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { createServerClient } from '@/app/lib/supabase'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { fetchMultiSourceNews, formatNewsForPrompt } from '@/app/lib/multi-source-news'
import { getMarketRegime, type MarketRegime } from '@/app/lib/market-regime'
import { fetchForwardContext, formatForwardContextForPrompt, type ForwardContext } from '@/app/lib/forward-data'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

const getAdminClient = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function getTodayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function getNextTradingDayLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  return d.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'UTC',
  })
}

function parseJSON<T>(text: string): T {
  const clean = text.replace(/```json|```/g, '').trim()
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON in response')
  return JSON.parse(clean.slice(start, end + 1)) as T
}

// ─────────────────────────────────────────────────────────────
// Sector top movers (cached 5 min) — shared pattern from Session 2
// ─────────────────────────────────────────────────────────────
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sectorCache: { data: any[]; fetchedAt: number } | null = null
const SECTOR_CACHE_TTL_MS = 5 * 60 * 1000

async function fetchSectorTopMovers(): Promise<Array<{
  sector: string; etf: string; emoji: string; direction: string; etfChange: number;
  topMovers: Array<{ ticker: string; change: number; signal: 'up' | 'down' }>
}>> {
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
interface WatchlistItem {
  ticker: string
  companyName: string
  type: 'stock' | 'crypto'
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number
  catalyst: string
  setupType: 'earnings' | 'technical_breakout' | 'news_continuation' | 'sector_play' | 'macro_event' | 'catalyst' | 'after_hours_move'
  magnitude: 'high' | 'medium' | 'low'
  keyLevel?: string
  planBull?: string
  planBear?: string
  timeOfDay: 'pre-market' | 'market-open' | 'intraday' | 'after-hours'
  riskLevel: 'high' | 'medium' | 'low'
  plainEnglish: string
  // Post-verification
  verified?: boolean
  verificationSources?: string[]
  verificationNote?: string
}

interface TomorrowResult {
  nextTradingDay: string
  generatedAt: string
  marketOutlook: string
  keyTheme: string
  preMarketWatchlist: WatchlistItem[]
  earningsCalendar: Array<{
    ticker: string
    companyName: string
    reportTime: string
    expectedMove?: string
    analystExpectation?: string
    watchFor?: string
  }>
  economicEvents: Array<{
    event: string
    time: string
    impact: 'high' | 'medium' | 'low'
    whatToWatch: string
  }>
  sectorSetups: Array<{
    sector: string
    etf: string
    direction: 'bullish' | 'bearish' | 'mixed'
    reason: string
    topPlay: string
  }>
  cryptoSetup: string
  openingBellPlaybook: string
  riskFactors: string[]
}

// ─────────────────────────────────────────────────────────────
// Pass 1: Claude Sonnet 4 builds the tomorrow playbook
// ─────────────────────────────────────────────────────────────
async function buildPlaybookWithClaude(params: {
  forwardContext: ForwardContext
  newsBlock: string
  regime: MarketRegime
  todayLabel: string
  nextDayLabel: string
}): Promise<TomorrowResult> {
  const { forwardContext, newsBlock, regime, todayLabel, nextDayLabel } = params
  const forwardBlock = formatForwardContextForPrompt(forwardContext)

  const system = `You are a professional market strategist preparing traders for the NEXT US trading day (${nextDayLabel}). Today is ${todayLabel}.

You have REAL data — do not invent earnings dates, EPS estimates, or economic events. Only use what is provided in the FORWARD-LOOKING DATA block below. If specific data isn't there, don't make it up.

You also have market regime context. Use it when assessing conviction. Bullish setups in risk-off markets often fail. Bearish setups in risk-on markets often fade.

For every watchlist item you flag, assign a confidence score 0-100 representing how likely your directional call is correct by end of next trading day:
  - 80-100: extremely high conviction (real catalyst + regime alignment)
  - 65-79: strong conviction (real catalyst)
  - 60-64: moderate conviction
  - below 60: don't include

Only include items with confidence >= 60. Quality over quantity.

All numeric fields must be plain numbers (no $ signs, no commas).`

  const user = `MARKET REGIME RIGHT NOW:
${regime.contextParagraph}

FORWARD-LOOKING DATA FOR ${nextDayLabel}:
${forwardBlock}

TODAY'S NEWS HEADLINES (may carry forward into tomorrow):
${newsBlock}

Build tomorrow's trader playbook. Consider:
1. Stocks with earnings reports (use the real dates/times above — don't make them up)
2. After-hours movers that will gap at the open
3. Scheduled economic events (use the real ones above)
4. Today's news that creates continuation trades tomorrow
5. Sector rotations likely to continue
6. Pre-market catalysts (product launches, FDA, analyst days)

Respond JSON ONLY (no markdown, no preamble):
{
  "nextTradingDay": "${nextDayLabel}",
  "generatedAt": "${new Date().toISOString()}",
  "marketOutlook": "2-3 sentences on the setup heading into tomorrow — dominant theme, macro backdrop, risk-on vs risk-off bias",
  "keyTheme": "single most important theme for tomorrow",
  "preMarketWatchlist": [
    {
      "ticker": "SYMBOL",
      "companyName": "Full Name",
      "type": "stock",
      "signal": "BULLISH|BEARISH|NEUTRAL",
      "confidence": 72,
      "catalyst": "specific reason e.g. 'Reports earnings BMO — EPS est 1.20, revenue est 50B, high bar given valuation'",
      "setupType": "earnings|technical_breakout|news_continuation|sector_play|macro_event|catalyst|after_hours_move",
      "magnitude": "high|medium|low",
      "keyLevel": "specific price level to watch",
      "planBull": "what to look for if bullish scenario plays out",
      "planBear": "what to look for if bearish scenario plays out",
      "timeOfDay": "pre-market|market-open|intraday|after-hours",
      "riskLevel": "high|medium|low",
      "plainEnglish": "2-3 sentences explaining for a beginner — what to watch for tomorrow"
    }
  ],
  "earningsCalendar": [
    {
      "ticker": "SYMBOL",
      "companyName": "Full Name",
      "reportTime": "pre-market|after-hours|during-market",
      "expectedMove": "percentage estimate e.g. ±5%",
      "analystExpectation": "brief summary of what analysts expect (base this on the EPS/rev estimates provided)",
      "watchFor": "what will make it a beat or miss"
    }
  ],
  "economicEvents": [
    {
      "event": "event name (MUST be from the real list above)",
      "time": "approximate time",
      "impact": "high|medium|low",
      "whatToWatch": "plain English what this means for markets"
    }
  ],
  "sectorSetups": [
    {
      "sector": "sector name",
      "etf": "e.g. XLK",
      "direction": "bullish|bearish|mixed",
      "reason": "why this sector is set up for tomorrow",
      "topPlay": "best individual stock play"
    }
  ],
  "cryptoSetup": "2-3 sentences on crypto heading into tomorrow",
  "openingBellPlaybook": "Plain English step-by-step for the first 30 minutes of trading tomorrow. What to watch, what levels matter, when to wait vs act. Written for a beginner.",
  "riskFactors": ["key risk 1 that could invalidate the outlook", "key risk 2", "key risk 3"]
}

Rules:
- preMarketWatchlist: 5-8 items, confidence >= 60 each
- earningsCalendar: ONLY tickers from the forward data above — do NOT invent
- economicEvents: ONLY events from the forward data above — do NOT invent
- sectorSetups: 3-5 sectors max, based on sector data provided
- Be specific. Vague setups aren't useful.`

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 5000,
    system,
    messages: [{ role: 'user', content: user }],
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (msg.content[0] as any).text as string
  const parsed = parseJSON<TomorrowResult>(text)

  // Enforce confidence threshold + array sanity
  const watchlist = (parsed.preMarketWatchlist ?? []).filter(
    (w) => w && w.ticker && typeof w.confidence === 'number' && w.confidence >= 60
  )

  return {
    ...parsed,
    preMarketWatchlist: watchlist,
    earningsCalendar: Array.isArray(parsed.earningsCalendar) ? parsed.earningsCalendar : [],
    economicEvents: Array.isArray(parsed.economicEvents) ? parsed.economicEvents : [],
    sectorSetups: Array.isArray(parsed.sectorSetups) ? parsed.sectorSetups : [],
    riskFactors: Array.isArray(parsed.riskFactors) ? parsed.riskFactors : [],
  }
}

// ─────────────────────────────────────────────────────────────
// Pass 2: Gemini Pro grounded verification of top 5
// ─────────────────────────────────────────────────────────────
interface VerificationResult {
  ticker: string
  verified: boolean
  sources: string[]
  note: string
}

async function verifyWatchlistWithGemini(
  items: WatchlistItem[],
  nextDayLabel: string
): Promise<Map<string, VerificationResult>> {
  const resultMap = new Map<string, VerificationResult>()
  if (items.length === 0) return resultMap

  const top5 = items.slice(0, 5)
  const list = top5.map((m, i) =>
    `[${i + 1}] ${m.ticker} (${m.signal}): ${m.catalyst}`
  ).join('\n')

  const prompt = `You are a financial fact-checker. For each claim below about what will move tomorrow (${nextDayLabel}), use Google Search to verify whether CREDIBLE mainstream financial sources (Reuters, Bloomberg, WSJ, CNBC, MarketWatch, Financial Times, Barron's, or SEC filings / company IR pages) confirm the setup or catalyst.

CLAIMS TO VERIFY:
${list}

For EACH claim, return:
- verified: true if credible sources confirm the setup (e.g., earnings ARE reporting that day, the after-hours move DID happen, the economic event IS scheduled)
- sources: array of 1-3 credible URLs found (empty if none)
- note: 1 sentence on what you confirmed or why it couldn't be verified

Do NOT count X/Twitter, Reddit, Stocktwits, YouTube, or random blogs as credible.

Return ONLY this JSON, no preamble:
{
  "verifications": [
    {
      "ticker": "AAPL",
      "verified": true,
      "sources": ["https://www.reuters.com/..."],
      "note": "Reuters confirmed Apple reports Q2 earnings after-hours on 2026-04-21"
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
    console.warn('[tomorrow-movers] verification failed:', (e as Error).message?.slice(0, 120))
  }

  return resultMap
}

// ─────────────────────────────────────────────────────────────
// Telemetry: log preMarketWatchlist to movers_log
// ─────────────────────────────────────────────────────────────
function logMoversToDb(
  result: TomorrowResult,
  regime: MarketRegime,
  pricesAtFlag: Record<string, number>
): void {
  void (async () => {
    try {
      const admin = getAdminClient()
      const rows = result.preMarketWatchlist.map(m => ({
        source: 'tomorrow',
        ticker: m.ticker.toUpperCase(),
        company_name: m.companyName ?? null,
        asset_type: m.type ?? 'stock',
        signal: m.signal,
        magnitude: m.magnitude ?? null,
        confidence: m.confidence ?? null,
        timeframe: 'tomorrow',
        headline: m.catalyst ?? null,
        catalyst: m.catalyst ?? null,
        reason: m.plainEnglish ?? null,
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
        if (error) console.warn('[tomorrow-movers/log] insert failed:', error.message)
      }
    } catch (e) {
      console.warn('[tomorrow-movers/log] fire-and-forget failed:', (e as Error).message?.slice(0, 100))
    }
  })()
}

// ─────────────────────────────────────────────────────────────
// Fetch prices for tickers (for telemetry)
// ─────────────────────────────────────────────────────────────
async function fetchPricesForTickers(tickers: string[]): Promise<Record<string, number>> {
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

// ═════════════════════════════════════════════════════════════
// Route handler
// ═════════════════════════════════════════════════════════════
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

      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: heartbeat\n\n`)) } catch { /* closed */ }
      }, 15000)

      const pipelineStart = Date.now()
      console.log('[tomorrow-movers] START')

      try {
        const supabase = createServerClient()
        const today = getTodayStr()
        const cacheKey = `tomorrow_${today}`

        // ── Cache check ──────────────────────────────────────
        if (!forceRefresh) {
          send('status', { message: 'Checking cached playbook...' })
          const { data: cached } = await supabase
            .from('news_cache')
            .select('*')
            .eq('cache_key', cacheKey)
            .maybeSingle()

          if (cached?.data) {
            const age = Math.round((Date.now() - new Date(cached.generated_at).getTime()) / 60000)
            send('status', { message: `Loaded cached playbook from ${age} minute${age === 1 ? '' : 's'} ago` })
            const sectorTopMovers = await fetchSectorTopMovers().catch(() => [])
            send('complete', { ...cached.data, sectorTopMovers, cached: true, ageMinutes: age })
            console.log(`[tomorrow-movers] cache hit (age ${age}m) in ${Date.now() - pipelineStart}ms`)
            return
          }
        }

        // ── Fresh analysis ───────────────────────────────────
        send('status', { message: 'Fetching forward-looking data, news, and regime...' })

        const parallelStart = Date.now()
        const [forwardContext, newsResult, regime, sectorTopMovers] = await Promise.all([
          fetchForwardContext(),
          fetchMultiSourceNews({ includeCrypto: true }),
          getMarketRegime(),
          fetchSectorTopMovers(),
        ])
        console.log(`[tomorrow-movers] parallel fetch ${Date.now() - parallelStart}ms (earnings:${forwardContext.counts.tomorrowEarnings} afterhours:${forwardContext.counts.afterHoursMovers} econ:${forwardContext.counts.economicEvents} news:${newsResult.counts.afterDedupe})`)

        const newsBlock = formatNewsForPrompt(newsResult.items, 40)
        const todayLabel = new Date().toLocaleDateString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        })
        const nextDayLabel = getNextTradingDayLabel(forwardContext.nextTradingDay)

        // ── Pass 1: Claude builds playbook ───────────────────
        send('status', { message: `Regime: ${regime.regime}. Building tomorrow's playbook...` })
        const classifyStart = Date.now()
        const result = await buildPlaybookWithClaude({
          forwardContext,
          newsBlock,
          regime,
          todayLabel,
          nextDayLabel,
        })
        console.log(`[tomorrow-movers] playbook ${Date.now() - classifyStart}ms (watchlist:${result.preMarketWatchlist.length} earnings:${result.earningsCalendar.length} econ:${result.economicEvents.length})`)

        // ── Pass 2: Gemini verifies top 5 ────────────────────
        send('status', { message: 'Verifying top setups against Reuters, Bloomberg, WSJ...' })
        const verifyStart = Date.now()
        const sorted = [...result.preMarketWatchlist].sort((a, b) => b.confidence - a.confidence)
        const verifications = await verifyWatchlistWithGemini(sorted, nextDayLabel)
        console.log(`[tomorrow-movers] verification ${Date.now() - verifyStart}ms (${verifications.size} verified)`)

        const attachVerif = (w: WatchlistItem): WatchlistItem => {
          const v = verifications.get(w.ticker.toUpperCase())
          if (!v) return w
          return {
            ...w,
            verified: v.verified,
            verificationSources: v.sources,
            verificationNote: v.note,
          }
        }
        result.preMarketWatchlist = result.preMarketWatchlist.map(attachVerif)

        // ── Telemetry (fire-and-forget) ──────────────────────
        const allTickers = result.preMarketWatchlist.map(m => m.ticker.toUpperCase())
        const pricesAtFlag = await fetchPricesForTickers(allTickers).catch(() => ({}))
        logMoversToDb(result, regime, pricesAtFlag)

        // ── Save to cache ────────────────────────────────────
        try {
          const saveResult = await supabase
            .from('news_cache')
            .upsert(
              { cache_key: cacheKey, cache_date: today, generated_at: new Date().toISOString(), data: result },
              { onConflict: 'cache_key' }
            )
          if (saveResult.error) console.error('[tomorrow-movers] cache save error:', saveResult.error)
        } catch (e) {
          console.error('[tomorrow-movers] cache save failed:', e)
        }

        const totalMs = Date.now() - pipelineStart
        console.log(`[tomorrow-movers] TOTAL ${totalMs}ms (${(totalMs/1000).toFixed(1)}s)`)

        send('complete', {
          ...result,
          sectorTopMovers,
          regime: {
            label: regime.regime,
            spyChangePct: regime.spyChangePct,
            vixLevel: regime.vixLevel,
            context: regime.contextParagraph,
          },
          forwardCounts: forwardContext.counts,
          newsCounts: newsResult.counts,
          cached: false,
          ageMinutes: 0,
          elapsedMs: totalMs,
        })
      } catch (err) {
        console.error('[tomorrow-movers] error:', err)
        send('error', { message: err instanceof Error ? err.message : 'Failed to generate playbook' })
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
