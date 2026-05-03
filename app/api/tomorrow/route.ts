// =============================================================
// app/api/tomorrow/route.ts - Tomorrow's Movers + Weekend Brief
//
// What changed vs the original:
//   1. Real Finnhub earnings calendar for next trading day (no more hallucinated dates)
//   2. Real Finnhub economic calendar (Fed, CPI, jobs - actual scheduled events)
//   3. After-hours price moves on today's earnings reporters
//   4. Multi-source news (Alpaca + Finnhub + Gemini grounded)
//   5. Market regime context injected into prompt
//   6. Claude Sonnet 4 classification with confidence scores
//   7. Gemini 2.5 Pro grounded verification of top 5
//   8. Confidence thresholding (>=60% shown)
//   9. Telemetry to movers_log with source='tomorrow'
//   10. NEW: Weekend mode - Sat/Sun render a Monday-focused brief with
//       international quotes, world events, and wider news lookback.
//       4 cache slots per weekend (sat-am, sat-pm, sun-am, sun-pm).
//
// Preserves:
//   - SSE streaming protocol
//   - news_cache table (now with weekend_YYYY-MM-DD_slot keys on weekends)
//   - Client response shape (adds fields, doesn't remove)
// =============================================================

import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { generateWithFallback } from '@/app/lib/gemini-helper'
import { createServerClient } from '@/app/lib/supabase'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { fetchMultiSourceNews, formatNewsForPrompt } from '@/app/lib/multi-source-news'
import { getMarketRegime, type MarketRegime } from '@/app/lib/market-regime'
import { fetchForwardContext, formatForwardContextForPrompt, type ForwardContext } from '@/app/lib/forward-data'
import { fetchInternationalQuotes, formatQuotesForPrompt, buildInternationalSnapshot, type InternationalSnapshot } from '@/app/lib/yahoo-quotes'
import { fetchGroundTruthPrices, formatGroundTruthForPrompt, buildGroundTruthMap, type GroundTruthQuote } from '@/app/lib/ground-truth-prices'
import { validateWatchlist, summarizeValidation, type PriceCheckResult } from '@/app/lib/watchlist-validator'

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

// -----------------------------------------------------------------
// Weekend mode detection and cache-slot helpers
// -----------------------------------------------------------------
type BriefMode = 'weekday' | 'weekend' | 'fri-after-close'

/**
 * Determine which mode to render based on current ET time.
 *
 *   weekday          - Mon-Thu any time, OR Fri before 4pm ET
 *   fri-after-close  - Fri 4pm-midnight ET (weekend brief preview)
 *   weekend          - Sat any time, Sun any time
 */
function getBriefMode(now: Date = new Date()): BriefMode {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  })
  const parts = fmt.formatToParts(now)
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? 'Mon'
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10)

  if (weekday === 'Sat' || weekday === 'Sun') return 'weekend'
  if (weekday === 'Fri' && hour >= 16) return 'fri-after-close'
  return 'weekday'
}

/**
 * Build a cache key for the current weekend slot.
 * Caching B: 4 slots over the weekend keyed off the Saturday date so
 * Sat-AM, Sat-PM, Sun-AM, Sun-PM all share an obvious grouping.
 *
 *   sat-am: Sat 00:00-12:00 ET
 *   sat-pm: Sat 12:00-23:59 ET
 *   sun-am: Sun 00:00-18:00 ET
 *   sun-pm: Sun 18:00 onward (after Asian markets open)
 *   fri-pm: Fri 16:00 onward (preview before the weekend)
 *
 * Returns "weekend_2026-05-02_sat-am" or similar.
 */
function getWeekendCacheKey(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = fmt.formatToParts(now)
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? 'Sat'
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10)
  const yyyy = parts.find(p => p.type === 'year')?.value ?? '2026'
  const mm = parts.find(p => p.type === 'month')?.value ?? '01'
  const dd = parts.find(p => p.type === 'day')?.value ?? '01'

  // Saturday-anchor date: all slots in a given weekend share this.
  let satDate: string
  if (weekday === 'Sat') {
    satDate = `${yyyy}-${mm}-${dd}`
  } else if (weekday === 'Sun') {
    // Subtract 1 day to land on Saturday
    const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 1)
    satDate = d.toISOString().split('T')[0]
  } else if (weekday === 'Fri') {
    // Long weekend - Saturday is tomorrow
    const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 1)
    satDate = d.toISOString().split('T')[0]
  } else {
    satDate = `${yyyy}-${mm}-${dd}`
  }

  let slot: string
  if (weekday === 'Sat' && hour < 12)        slot = 'sat-am'
  else if (weekday === 'Sat')                slot = 'sat-pm'
  else if (weekday === 'Sun' && hour < 18)   slot = 'sun-am'
  else if (weekday === 'Sun')                slot = 'sun-pm'
  else if (weekday === 'Fri' && hour >= 16)  slot = 'fri-pm'
  else                                       slot = 'unknown'

  return `weekend_${satDate}_${slot}`
}

/**
 * Compute the next Monday's date label for the weekend brief.
 * On Friday after close: Monday is 3 days out.
 * On Saturday: Monday is 2 days out.
 * On Sunday: Monday is 1 day out.
 */
function getMondayLabel(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = fmt.formatToParts(now)
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? 'Sat'
  const yyyy = parts.find(p => p.type === 'year')?.value ?? '2026'
  const mm = parts.find(p => p.type === 'month')?.value ?? '01'
  const dd = parts.find(p => p.type === 'day')?.value ?? '01'

  let daysUntilMonday: number
  if (weekday === 'Fri') daysUntilMonday = 3
  else if (weekday === 'Sat') daysUntilMonday = 2
  else if (weekday === 'Sun') daysUntilMonday = 1
  else daysUntilMonday = 0

  const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + daysUntilMonday)
  return d.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'UTC',
  })
}

// ─────────────────────────────────────────────────────────────
// Sector top movers (cached 5 min) --- shared pattern from Session 2
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
  // Price-grounding validation result (added by validateWatchlist)
  priceCheck?: PriceCheckResult
}

interface WorldEvent {
  category: 'geopolitical' | 'central_bank' | 'macro_data' | 'corporate' | 'energy' | 'other'
  headline: string
  summary: string
  marketImpact: 'high' | 'medium' | 'low'
  affectedSectors?: string[]
  affectedTickers?: string[]
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
  // Weekend-only fields (undefined on weekday briefs)
  worldEvents?: WorldEvent[]
  internationalSummary?: string
  internationalSnapshot?: InternationalSnapshot
  briefMode?: BriefMode
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
  groundTruthBlock: string
}): Promise<TomorrowResult> {
  const { forwardContext, newsBlock, regime, todayLabel, nextDayLabel, groundTruthBlock } = params
  const forwardBlock = formatForwardContextForPrompt(forwardContext)

  const system = `You are a professional market strategist preparing traders for the NEXT US trading day (${nextDayLabel}). Today is ${todayLabel}.

You have REAL data --- do not invent earnings dates, EPS estimates, economic events, or PRICE MOVES. Only use what is provided in the data blocks below. If specific data isn't there, don't make it up.

CRITICAL PRICE INTEGRITY RULES:
- The GROUND TRUTH MARKET DATA block contains the AUTHORITATIVE current prices and most recent moves for major sector ETFs, indices, commodities, and crypto.
- You MUST NOT contradict prices in the ground truth block.
- You MUST NOT cite percentage moves that conflict with the ground truth block.
- If your news suggests one direction (e.g. "oil surge") but the ground truth shows the opposite, PREFER THE GROUND TRUTH and adjust the catalyst accordingly. The model is NOT being run live --- news may be stale.
- Only cite percentage moves explicitly present in either the ground truth block or the news block. Do NOT invent specific percentages.

You also have market regime context. Use it when assessing conviction. Bullish setups in risk-off markets often fail. Bearish setups in risk-on markets often fade.

For every watchlist item you flag, assign a confidence score 0-100 representing how likely your directional call is correct by end of next trading day:
  - 80-100: extremely high conviction (real catalyst + regime alignment + price action confirms)
  - 65-79: strong conviction (real catalyst)
  - 60-64: moderate conviction
  - below 60: don't include

Only include items with confidence >= 60. Quality over quantity.

All numeric fields must be plain numbers (no $ signs, no commas).`

  const user = `${groundTruthBlock}

MARKET REGIME RIGHT NOW:
${regime.contextParagraph}

FORWARD-LOOKING DATA FOR ${nextDayLabel}:
${forwardBlock}

TODAY'S NEWS HEADLINES (may carry forward into tomorrow):
${newsBlock}

Build tomorrow's trader playbook. Consider:
1. Stocks with earnings reports (use the real dates/times above --- don't make them up)
2. After-hours movers that will gap at the open
3. Scheduled economic events (use the real ones above)
4. Today's news that creates continuation trades tomorrow
5. Sector rotations likely to continue
6. Pre-market catalysts (product launches, FDA, analyst days)

Respond JSON ONLY (no markdown, no preamble):
{
  "nextTradingDay": "${nextDayLabel}",
  "generatedAt": "${new Date().toISOString()}",
  "marketOutlook": "2-3 sentences on the setup heading into tomorrow --- dominant theme, macro backdrop, risk-on vs risk-off bias",
  "keyTheme": "single most important theme for tomorrow",
  "preMarketWatchlist": [
    {
      "ticker": "SYMBOL",
      "companyName": "Full Name",
      "type": "stock",
      "signal": "BULLISH|BEARISH|NEUTRAL",
      "confidence": 72,
      "catalyst": "specific reason e.g. 'Reports earnings BMO --- EPS est 1.20, revenue est 50B, high bar given valuation'",
      "setupType": "earnings|technical_breakout|news_continuation|sector_play|macro_event|catalyst|after_hours_move",
      "magnitude": "high|medium|low",
      "keyLevel": "specific price level to watch",
      "planBull": "what to look for if bullish scenario plays out",
      "planBear": "what to look for if bearish scenario plays out",
      "timeOfDay": "pre-market|market-open|intraday|after-hours",
      "riskLevel": "high|medium|low",
      "plainEnglish": "2-3 sentences explaining for a beginner --- what to watch for tomorrow"
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
- earningsCalendar: ONLY tickers from the forward data above --- do NOT invent
- economicEvents: ONLY events from the forward data above --- do NOT invent
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

// -----------------------------------------------------------------
// Weekend playbook builder
// Used on Sat/Sun to produce a Monday-focused brief that emphasizes
// world events, international markets, and 65-hour news lookback.
// -----------------------------------------------------------------
async function buildWeekendPlaybookWithClaude(params: {
  forwardContext: ForwardContext
  newsBlock: string
  regime: MarketRegime
  internationalBlock: string
  todayLabel: string
  mondayLabel: string
  groundTruthBlock: string
}): Promise<TomorrowResult> {
  const { forwardContext, newsBlock, regime, internationalBlock, todayLabel, mondayLabel, groundTruthBlock } = params
  const forwardBlock = formatForwardContextForPrompt(forwardContext)

  const system = `You are a professional market strategist preparing traders for the upcoming Monday open (${mondayLabel}). Today is ${todayLabel} and US markets are closed.

A weekend brief is fundamentally different from a weekday brief. While US markets are closed, three things matter most:

1. WORLD EVENTS that broke after Friday close - geopolitics, central bank actions, regulatory news, corporate news, natural disasters, and macro data scheduled for Monday morning
2. INTERNATIONAL MARKETS that already reacted - Asian markets (Sun night ET), European pre-market, currency moves, oil and gold
3. POSITIONING for the open - what's already priced into futures, what's a potential gap risk, what specific catalysts hit Monday

You have REAL data - do not invent earnings dates, EPS estimates, world events, or PRICE MOVES. Only use what is provided in the data blocks below. If specific data isn't there, don't make it up.

CRITICAL PRICE INTEGRITY RULES:
- The GROUND TRUTH MARKET DATA block contains AUTHORITATIVE last-available prices for sector ETFs, indices, commodities, crypto.
- The INTERNATIONAL MARKETS block contains live or last-available data for international indices, forex, commodities, futures.
- You MUST NOT contradict prices in either block.
- You MUST NOT cite percentage moves that conflict with these blocks.
- Weekend news cycles often carry stale data from earlier in the week. If a news headline says "oil surged" but the ground truth shows oil DOWN on Friday close, prefer the price - the news is probably reporting an earlier intraweek peak.
- Only cite percentages explicitly present in the ground truth, international, or news blocks. Do NOT invent specific numbers.

For every watchlist item you flag, assign a confidence score 0-100:
  - 80-100: extremely high conviction (real catalyst + cross-market confirmation + price action confirms)
  - 65-79: strong conviction (real catalyst + sector tailwind)
  - 60-64: moderate conviction
  - below 60: don't include

Only include items with confidence >= 60.

All numeric fields must be plain numbers (no $ signs, no commas).`

  const user = `${groundTruthBlock}

MARKET REGIME (last close):
${regime.contextParagraph}

INTERNATIONAL MARKETS (live or last available):
${internationalBlock}

FORWARD-LOOKING DATA FOR THIS WEEK (earnings, economic events scheduled):
${forwardBlock}

NEWS HEADLINES (Friday close through now - 65 hours of news):
${newsBlock}

Build the WEEKEND BRIEF for Monday. Lead with world events and international context, then the trading playbook.

Respond JSON ONLY (no markdown, no preamble):
{
  "nextTradingDay": "${mondayLabel}",
  "generatedAt": "${new Date().toISOString()}",
  "marketOutlook": "3-4 sentences on the setup heading into Monday - dominant theme since Friday close, how international markets reacted, risk-on vs risk-off bias, what the futures (if available) suggest",
  "keyTheme": "the single most important theme for Monday's open",
  "internationalSummary": "2-3 sentences specifically about how Asian, European, and currency markets traded over the weekend and what it implies for US open",
  "worldEvents": [
    {
      "category": "geopolitical|central_bank|macro_data|corporate|energy|other",
      "headline": "factual headline of what happened",
      "summary": "2 sentences on what it means for Monday's market",
      "marketImpact": "high|medium|low",
      "affectedSectors": ["sector name"],
      "affectedTickers": ["TICKER1", "TICKER2"]
    }
  ],
  "preMarketWatchlist": [
    {
      "ticker": "SYMBOL",
      "companyName": "Full Name",
      "type": "stock",
      "signal": "BULLISH|BEARISH|NEUTRAL",
      "confidence": 72,
      "catalyst": "specific weekend catalyst e.g. 'Reports earnings Monday BMO - weekend news strengthens bull case'",
      "setupType": "earnings|technical_breakout|news_continuation|sector_play|macro_event|catalyst|after_hours_move",
      "magnitude": "high|medium|low",
      "keyLevel": "specific price level to watch",
      "planBull": "what to look for if bullish scenario plays out at the open",
      "planBear": "what to look for if bearish scenario plays out at the open",
      "timeOfDay": "pre-market|market-open|intraday|after-hours",
      "riskLevel": "high|medium|low",
      "plainEnglish": "2-3 sentences explaining for a beginner - what to watch for at the Monday open"
    }
  ],
  "earningsCalendar": [
    {
      "ticker": "SYMBOL",
      "companyName": "Full Name",
      "reportTime": "pre-market|after-hours|during-market",
      "expectedMove": "percentage estimate",
      "analystExpectation": "brief summary of analyst expectations",
      "watchFor": "what will make it a beat or miss"
    }
  ],
  "economicEvents": [
    {
      "event": "event name from the real list above",
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
      "reason": "why this sector is set up given weekend catalysts and international action",
      "topPlay": "best individual stock play"
    }
  ],
  "cryptoSetup": "2-3 sentences on crypto over the weekend (BTC, ETH) - it's the only major US-traded asset that traded the full weekend, often a leading indicator",
  "openingBellPlaybook": "Plain English step-by-step for the first 30 minutes of Monday's trading. What to watch first, what levels matter, when to wait vs act. Address how international action and weekend news should reshape the trader's plan vs a normal weekday open.",
  "riskFactors": ["weekend-specific risk 1", "risk 2", "risk 3"]
}

Rules:
- worldEvents: 3-7 items max, only events you have actual data for above
- preMarketWatchlist: 5-8 items, confidence >= 60 each
- earningsCalendar: ONLY tickers from the forward data above - do NOT invent
- economicEvents: ONLY events from the forward data above - do NOT invent
- sectorSetups: 3-5 sectors max
- Be specific. Vague setups aren't useful.`

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 6000,
    system,
    messages: [{ role: 'user', content: user }],
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (msg.content[0] as any).text as string
  const parsed = parseJSON<TomorrowResult>(text)

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
    worldEvents: Array.isArray(parsed.worldEvents) ? parsed.worldEvents : [],
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

  const prompt = `You are a financial fact-checker. For each claim below about what will move tomorrow (${nextDayLabel}), use Google Search to verify TWO things:
1. Whether CREDIBLE mainstream financial sources (Reuters, Bloomberg, WSJ, CNBC, MarketWatch, Financial Times, Barron's, or SEC filings / company IR pages) confirm the setup or catalyst.
2. Whether the implied price direction in the catalyst matches the most recent actual price action for the ticker mentioned. If the catalyst says "oil surge +5%" check the actual most recent oil close - if it's down, that's a price-direction mismatch.

CLAIMS TO VERIFY:
${list}

For EACH claim, return:
- verified: true if credible sources confirm the setup (e.g., earnings ARE reporting that day, the after-hours move DID happen, the economic event IS scheduled) AND the implied direction matches recent price action
- priceDirectionConsistent: true if the implied direction in the catalyst (bullish/bearish) matches the most recent actual close for the asset mentioned, false if it contradicts, null if no price claim/direction is implied
- sources: array of 1-3 credible URLs found (empty if none)
- note: 1 sentence on what you confirmed, OR if there's a price-direction mismatch, explicitly flag it (e.g., "Catalyst implies oil surge but WTI closed down 3% Friday")

Do NOT count X/Twitter, Reddit, Stocktwits, YouTube, or random blogs as credible.

Return ONLY this JSON, no preamble:
{
  "verifications": [
    {
      "ticker": "AAPL",
      "verified": true,
      "priceDirectionConsistent": true,
      "sources": ["https://www.reuters.com/..."],
      "note": "Reuters confirmed Apple reports Q2 earnings after-hours on 2026-04-21; implied bullish direction consistent with recent price action"
    }
  ]
}`

  try {
    const { text } = await generateWithFallback({
      prompt,
      caller: 'tomorrow:verify-watchlist',
      temperature: 0.1,
      maxOutputTokens: 2500,
      useGoogleSearchGrounding: true,
    })
    const clean = text.replace(/```json|```/g, '').trim()
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    if (start === -1 || end === -1) return resultMap

    const parsed = JSON.parse(clean.slice(start, end + 1))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verifications: any[] = Array.isArray(parsed.verifications) ? parsed.verifications : []

    for (const v of verifications) {
      if (!v?.ticker) continue
      // If priceDirectionConsistent is explicitly false, mark as not verified
      // even if the underlying news fact is real - the trade setup is broken
      const verified = !!v.verified && v.priceDirectionConsistent !== false
      resultMap.set(v.ticker.toUpperCase(), {
        ticker: v.ticker.toUpperCase(),
        verified,
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

/**
 * Fetch full quote data (price + previous close + change) for arbitrary tickers.
 * Used to extend the validator's ground-truth map with stock-specific quotes
 * so we can validate watchlist items whose tickers aren't in the anchor list.
 *
 * Returns an array of GroundTruthQuote that can be merged into the validation map.
 */
async function fetchTickerQuotes(tickers: string[]): Promise<GroundTruthQuote[]> {
  const token = process.env.FINNHUB_API_KEY
  if (!token || tickers.length === 0) return []
  const results: (GroundTruthQuote | null)[] = await Promise.all(
    tickers.slice(0, 20).map(async (t): Promise<GroundTruthQuote | null> => {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 3000)
        try {
          const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${t}&token=${token}`, {
            signal: ctrl.signal, cache: 'no-store',
          })
          if (!res.ok) return null
          const q = await res.json()
          const price = Number(q?.c)
          const previousClose = Number(q?.pc)
          if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose === 0) return null
          const changePct = ((price - previousClose) / previousClose) * 100
          return {
            ticker: t.toUpperCase(),
            displayName: t.toUpperCase(),
            category: 'sector',  // Tag as sector since we don't know what kind it is - just for the type
            price,
            previousClose,
            changePct,
            source: 'alpaca',  // Finnhub-sourced but the type expects this enum
            asOf: new Date().toISOString(),
          }
        } finally { clearTimeout(timer) }
      } catch { return null }
    })
  )
  return results.filter((q): q is GroundTruthQuote => q !== null)
}

// ═════════════════════════════════════════════════════════════
// Route handler
// ═════════════════════════════════════════════════════════════
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const forceRefresh = searchParams.get('refresh') === 'true'
  // Allow ?force_weekend=true to test weekend mode on a weekday
  const forceWeekend = searchParams.get('force_weekend') === 'true'

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
      const briefMode: BriefMode = forceWeekend ? 'weekend' : getBriefMode()
      const isWeekendMode = briefMode === 'weekend' || briefMode === 'fri-after-close'
      console.log(`[tomorrow-movers] START mode=${briefMode}`)

      try {
        const supabase = createServerClient()
        const today = getTodayStr()
        const cacheKey = isWeekendMode ? getWeekendCacheKey() : `tomorrow_${today}`

        // -- Cache check --------------------------------------
        if (!forceRefresh) {
          send('status', { message: isWeekendMode ? 'Checking cached weekend brief...' : 'Checking cached playbook...' })
          const { data: cached } = await supabase
            .from('news_cache')
            .select('*')
            .eq('cache_key', cacheKey)
            .maybeSingle()

          if (cached?.data) {
            const age = Math.round((Date.now() - new Date(cached.generated_at).getTime()) / 60000)
            send('status', { message: `Loaded cached ${isWeekendMode ? 'weekend brief' : 'playbook'} from ${age} minute${age === 1 ? '' : 's'} ago` })
            const sectorTopMovers = await fetchSectorTopMovers().catch(() => [])
            send('complete', { ...cached.data, sectorTopMovers, cached: true, ageMinutes: age })
            console.log(`[tomorrow-movers] cache hit (age ${age}m, key=${cacheKey}) in ${Date.now() - pipelineStart}ms`)
            return
          }
        }

        if (isWeekendMode) {
          // ===== WEEKEND PATH =====
          send('status', { message: 'Building weekend brief: scanning international markets, world events, news, anchor prices...' })
          const parallelStart = Date.now()
          const [forwardContext, newsResult, regime, sectorTopMovers, internationalQuotes, groundTruthQuotes] = await Promise.all([
            fetchForwardContext(),
            fetchMultiSourceNews({ includeCrypto: true, weekendMode: true }),
            getMarketRegime(),
            fetchSectorTopMovers(),
            fetchInternationalQuotes(),
            fetchGroundTruthPrices(),
          ])
          console.log(`[tomorrow-movers] weekend parallel fetch ${Date.now() - parallelStart}ms (intl:${internationalQuotes.length} news:${newsResult.counts.afterDedupe} groundTruth:${groundTruthQuotes.length})`)

          const newsBlock = formatNewsForPrompt(newsResult.items, 60)  // wider window
          const internationalBlock = formatQuotesForPrompt(internationalQuotes)
          const internationalSnapshot = buildInternationalSnapshot(internationalQuotes)
          const groundTruthBlock = formatGroundTruthForPrompt(groundTruthQuotes)
          const groundTruthMap = buildGroundTruthMap(groundTruthQuotes)
          const todayLabel = new Date().toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          })
          const mondayLabel = getMondayLabel()

          send('status', { message: `Regime: ${regime.regime}. Building Monday playbook with weekend context...` })
          const classifyStart = Date.now()
          const result = await buildWeekendPlaybookWithClaude({
            forwardContext,
            newsBlock,
            regime,
            internationalBlock,
            todayLabel,
            mondayLabel,
            groundTruthBlock,
          })
          console.log(`[tomorrow-movers] weekend playbook ${Date.now() - classifyStart}ms (watchlist:${result.preMarketWatchlist.length} world:${result.worldEvents?.length ?? 0})`)

          // Layer 2: extend ground-truth with per-ticker quotes for items
          // whose tickers aren't in the standard anchor list
          const watchlistTickers = Array.from(new Set(
            result.preMarketWatchlist.map(w => w.ticker.toUpperCase())
          )).filter(t => !groundTruthMap.has(t))
          if (watchlistTickers.length > 0) {
            const tickerQuoteStart = Date.now()
            const tickerQuotes = await fetchTickerQuotes(watchlistTickers)
            for (const q of tickerQuotes) groundTruthMap.set(q.ticker, q)
            console.log(`[tomorrow-movers] per-ticker quotes ${Date.now() - tickerQuoteStart}ms (fetched ${tickerQuotes.length}/${watchlistTickers.length})`)
          }

          // Validate watchlist against the extended ground truth
          send('status', { message: 'Validating watchlist against live prices...' })
          const validationStart = Date.now()
          const validation = validateWatchlist(result.preMarketWatchlist, groundTruthMap)
          const validationSummary = summarizeValidation(validation.kept, validation.dropped)
          console.log(`[tomorrow-movers] validator ${Date.now() - validationStart}ms (kept:${validation.kept.length} dropped:${validation.dropped.length} majorIssues:${validationSummary.majorIssues.length})`)
          if (validationSummary.majorIssues.length > 0) {
            console.log('[tomorrow-movers] MAJOR validation issues:', validationSummary.majorIssues)
          }
          result.preMarketWatchlist = validation.kept

          // Verification step (same as weekday)
          send('status', { message: 'Verifying top setups against Reuters, Bloomberg, WSJ...' })
          const verifyStart = Date.now()
          const sorted = [...result.preMarketWatchlist].sort((a, b) => b.confidence - a.confidence)
          const verifications = await verifyWatchlistWithGemini(sorted, mondayLabel)
          console.log(`[tomorrow-movers] verification ${Date.now() - verifyStart}ms`)

          const attachVerif = (w: WatchlistItem): WatchlistItem => {
            const v = verifications.get(w.ticker.toUpperCase())
            if (!v) return w
            return { ...w, verified: v.verified, verificationSources: v.sources, verificationNote: v.note }
          }
          result.preMarketWatchlist = result.preMarketWatchlist.map(attachVerif)

          // Attach weekend-specific data
          result.internationalSnapshot = internationalSnapshot
          result.briefMode = briefMode

          // Telemetry
          const allTickers = result.preMarketWatchlist.map(m => m.ticker.toUpperCase())
          const pricesAtFlag = await fetchPricesForTickers(allTickers).catch(() => ({}))
          logMoversToDb(result, regime, pricesAtFlag)

          // Build full response object - cached and fresh responses use the same shape
          const fullResponse = {
            ...result,
            regime: {
              label: regime.regime,
              spyChangePct: regime.spyChangePct,
              vixLevel: regime.vixLevel,
              context: regime.contextParagraph,
            },
            forwardCounts: forwardContext.counts,
            newsCounts: newsResult.counts,
            internationalCounts: { fetched: internationalQuotes.length },
          }

          // Save to cache (4-slot weekend key) - cache the FULL response so cached
          // hits include regime and counts, not just the bare TomorrowResult
          try {
            const saveResult = await supabase
              .from('news_cache')
              .upsert(
                { cache_key: cacheKey, cache_date: today, generated_at: new Date().toISOString(), data: fullResponse },
                { onConflict: 'cache_key' }
              )
            if (saveResult.error) console.error('[tomorrow-movers] weekend cache save error:', saveResult.error)
          } catch (e) {
            console.error('[tomorrow-movers] weekend cache save failed:', e)
          }

          const totalMs = Date.now() - pipelineStart
          console.log(`[tomorrow-movers] WEEKEND TOTAL ${totalMs}ms (${(totalMs/1000).toFixed(1)}s)`)

          send('complete', {
            ...fullResponse,
            sectorTopMovers,
            cached: false,
            ageMinutes: 0,
            elapsedMs: totalMs,
          })
        } else {
          // ===== WEEKDAY PATH (original) =====
          send('status', { message: 'Fetching forward-looking data, news, regime, and anchor prices...' })

          const parallelStart = Date.now()
          const [forwardContext, newsResult, regime, sectorTopMovers, groundTruthQuotes] = await Promise.all([
            fetchForwardContext(),
            fetchMultiSourceNews({ includeCrypto: true }),
            getMarketRegime(),
            fetchSectorTopMovers(),
            fetchGroundTruthPrices(),
          ])
          console.log(`[tomorrow-movers] parallel fetch ${Date.now() - parallelStart}ms (earnings:${forwardContext.counts.tomorrowEarnings} afterhours:${forwardContext.counts.afterHoursMovers} econ:${forwardContext.counts.economicEvents} news:${newsResult.counts.afterDedupe} groundTruth:${groundTruthQuotes.length})`)

          const newsBlock = formatNewsForPrompt(newsResult.items, 40)
          const groundTruthBlock = formatGroundTruthForPrompt(groundTruthQuotes)
          const groundTruthMap = buildGroundTruthMap(groundTruthQuotes)
          const todayLabel = new Date().toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          })
          const nextDayLabel = getNextTradingDayLabel(forwardContext.nextTradingDay)

          send('status', { message: `Regime: ${regime.regime}. Building tomorrow's playbook...` })
          const classifyStart = Date.now()
          const result = await buildPlaybookWithClaude({
            forwardContext,
            newsBlock,
            regime,
            todayLabel,
            nextDayLabel,
            groundTruthBlock,
          })
          console.log(`[tomorrow-movers] playbook ${Date.now() - classifyStart}ms (watchlist:${result.preMarketWatchlist.length} earnings:${result.earningsCalendar.length} econ:${result.economicEvents.length})`)

          // Layer 2: extend ground-truth with per-ticker quotes for items
          // whose tickers aren't in the standard anchor list
          const watchlistTickers = Array.from(new Set(
            result.preMarketWatchlist.map(w => w.ticker.toUpperCase())
          )).filter(t => !groundTruthMap.has(t))
          if (watchlistTickers.length > 0) {
            const tickerQuoteStart = Date.now()
            const tickerQuotes = await fetchTickerQuotes(watchlistTickers)
            for (const q of tickerQuotes) groundTruthMap.set(q.ticker, q)
            console.log(`[tomorrow-movers] per-ticker quotes ${Date.now() - tickerQuoteStart}ms (fetched ${tickerQuotes.length}/${watchlistTickers.length})`)
          }

          // Validate watchlist against the extended ground truth
          send('status', { message: 'Validating watchlist against live prices...' })
          const validationStart = Date.now()
          const validation = validateWatchlist(result.preMarketWatchlist, groundTruthMap)
          const validationSummary = summarizeValidation(validation.kept, validation.dropped)
          console.log(`[tomorrow-movers] validator ${Date.now() - validationStart}ms (kept:${validation.kept.length} dropped:${validation.dropped.length} majorIssues:${validationSummary.majorIssues.length})`)
          if (validationSummary.majorIssues.length > 0) {
            console.log('[tomorrow-movers] MAJOR validation issues:', validationSummary.majorIssues)
          }
          result.preMarketWatchlist = validation.kept

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
          result.briefMode = briefMode

          const allTickers = result.preMarketWatchlist.map(m => m.ticker.toUpperCase())
          const pricesAtFlag = await fetchPricesForTickers(allTickers).catch(() => ({}))
          logMoversToDb(result, regime, pricesAtFlag)

          // Build full response - cache and fresh responses share the same shape
          const fullResponse = {
            ...result,
            regime: {
              label: regime.regime,
              spyChangePct: regime.spyChangePct,
              vixLevel: regime.vixLevel,
              context: regime.contextParagraph,
            },
            forwardCounts: forwardContext.counts,
            newsCounts: newsResult.counts,
          }

          try {
            const saveResult = await supabase
              .from('news_cache')
              .upsert(
                { cache_key: cacheKey, cache_date: today, generated_at: new Date().toISOString(), data: fullResponse },
                { onConflict: 'cache_key' }
              )
            if (saveResult.error) console.error('[tomorrow-movers] cache save error:', saveResult.error)
          } catch (e) {
            console.error('[tomorrow-movers] cache save failed:', e)
          }

          const totalMs = Date.now() - pipelineStart
          console.log(`[tomorrow-movers] TOTAL ${totalMs}ms (${(totalMs/1000).toFixed(1)}s)`)

          send('complete', {
            ...fullResponse,
            sectorTopMovers,
            cached: false,
            ageMinutes: 0,
            elapsedMs: totalMs,
          })
        }
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
