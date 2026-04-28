// =============================================================
// app/lib/overnight-brief.ts
//
// Generates per-ticker overnight news briefs for watched tickers.
// Called by /api/cron/overnight-brief at ~9 UTC (4-5 AM ET).
//
// For each ticker:
//   1. Pull recent news via Alpaca (fetchNews returns 15 most-recent)
//   2. Filter to overnight window (previous close → now)
//   3. Pre-filter by relevance (sector context + ticker mentions)
//   4. Single Claude Haiku call for synthesis
//   5. Return structured brief
//
// Reuses sector-context.ts from earlier today.
// =============================================================

import Anthropic from '@anthropic-ai/sdk'
import { fetchNews, type AlpacaNewsItem } from './data/alpaca'
import { getSectorContext } from './data/sector-context'
import { isFundTicker, getFundInfo } from './data/fund-detection'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// =============================================================
// Types
// =============================================================

export interface BriefItem {
  severity: 'high' | 'medium' | 'low'
  direction: 'bullish' | 'bearish' | 'uncertain'
  headline: string
  url: string | null
  source: string | null
  published_at: string  // ISO
  reasoning: string     // 1-sentence "why this matters for THIS ticker"
}

export interface OvernightBrief {
  ticker: string
  brief_date: string                                                          // YYYY-MM-DD
  summary: string                                                              // 2-3 sentence overview
  sentiment_skew: 'bullish' | 'bearish' | 'mixed' | 'neutral' | 'quiet'
  items: BriefItem[]
  news_count: number                                                           // raw news items examined
  news_window_start: string                                                    // ISO
  news_window_end: string                                                      // ISO
  llm_input_tokens?: number
  llm_output_tokens?: number
  generation_ms: number
}

// =============================================================
// Default overnight window
// =============================================================
//
// "Previous market close" → "now". Market close is 4 PM ET.
//   - EDT (Mar–Nov):  4 PM ET = 20:00 UTC
//   - EST (Nov–Mar):  4 PM ET = 21:00 UTC
//
// We use 20:00 UTC as the conservative cutoff (catches an extra hour
// of EST after-hours news rather than missing EDT close-of-day news).

function defaultOvernightWindow(now = new Date()): { start: Date; end: Date } {
  const start = new Date(now)
  start.setUTCHours(20, 0, 0, 0)
  if (start >= now) {
    // If today's 20:00 UTC is in the future (e.g., it's only 18:00 UTC),
    // the relevant window is yesterday's 20:00 UTC → now.
    start.setUTCDate(start.getUTCDate() - 1)
  }
  return { start, end: now }
}

// =============================================================
// Pre-filter: keep news likely relevant to the ticker
// =============================================================

function buildRelevanceKeywords(
  ticker: string,
  sectorPeers: string[],
  sectorName: string | null,
  isFund: boolean,
): { ticker: string; peers: string[]; sectorTerms: string[]; macroTerms: string[]; underlying: string[] } {
  const t = ticker.toUpperCase()

  const peers = sectorPeers.map(p => p.toUpperCase()).filter(p => p && p !== t)

  const sectorTerms: string[] = []
  if (sectorName) sectorTerms.push(sectorName.toLowerCase())

  // Common macro keywords that move broad markets — included for ALL tickers
  // because a Fed rate decision affects everything overnight.
  const macroTerms = [
    'fed rate', 'fomc', 'interest rate decision',
    'cpi', 'inflation report', 'jobs report', 'nonfarm payroll',
    'recession', 'gdp report',
    'tariff', 'trade war',
    'china', 'taiwan',
  ]

  const underlying: string[] = []
  if (isFund) {
    const info = getFundInfo(ticker)
    if (info.tracksUnderlying) underlying.push(info.tracksUnderlying.toLowerCase())
  }

  return { ticker: t, peers, sectorTerms, macroTerms, underlying }
}

function filterRelevantNews(
  news: AlpacaNewsItem[],
  ticker: string,
  sectorPeers: string[],
  sectorName: string | null,
  isFund: boolean,
  windowStart: Date,
  windowEnd: Date,
): AlpacaNewsItem[] {
  const kw = buildRelevanceKeywords(ticker, sectorPeers, sectorName, isFund)

  return news.filter(item => {
    // Time window
    const t = new Date(item.created_at).getTime()
    if (t < windowStart.getTime() || t > windowEnd.getTime()) return false

    // Direct symbol match (Alpaca tags news with symbols array)
    if (item.symbols?.some(s => s.toUpperCase() === kw.ticker)) return true

    const haystack = `${item.headline} ${item.summary ?? ''}`.toLowerCase()

    // Ticker mention (in headline or summary, not just symbols array)
    if (haystack.includes(kw.ticker.toLowerCase())) return true

    // Peer mentions
    for (const p of kw.peers) {
      if (haystack.includes(p.toLowerCase())) return true
    }

    // Sector terms
    for (const s of kw.sectorTerms) {
      if (haystack.includes(s)) return true
    }

    // Macro terms (always relevant)
    for (const m of kw.macroTerms) {
      if (haystack.includes(m)) return true
    }

    // Fund-underlying terms (e.g., "crude oil" for USO)
    for (const u of kw.underlying) {
      if (haystack.includes(u)) return true
    }

    return false
  })
}

// =============================================================
// LLM synthesis prompt
// =============================================================

const SYSTEM_PROMPT = `You are an overnight news analyst preparing a pre-market brief for a single watched ticker. Your job is to identify which news items from overnight could materially affect the stock at tomorrow's open and synthesize them into a structured brief.

Be concise. Be specific. Cite the news items by their headline. Do not invent details or numbers not present in the news.

CRITICAL DISCIPLINE:
- "Material" means: could realistically move the stock by >0.5% at the open, or could trigger increased volume/volatility
- General market chatter, broad sector ETF news without specific ticker relevance, and stale rehashed analysis are NOT material
- Earnings reports, M&A news, regulatory events, supply chain shocks, executive changes, major product launches, geopolitical events affecting key markets, peer-stock surprises with read-through — these ARE material
- If nothing is material, return sentiment_skew: "quiet" with empty items array — that is the correct answer for slow news days
- For ETFs/funds, focus on the underlying (oil, gold, bonds, etc.) — do NOT cite "dilution" or operating-company concerns

OUTPUT FORMAT — return JSON only, no markdown fences:
{
  "summary": "2-3 sentences capturing the overnight narrative for this ticker. If quiet, say so.",
  "sentiment_skew": "bullish" | "bearish" | "mixed" | "neutral" | "quiet",
  "items": [
    {
      "severity": "high" | "medium" | "low",
      "direction": "bullish" | "bearish" | "uncertain",
      "headline": "exact headline from the news",
      "url": "the URL from the news, or null if absent",
      "source": "news source string, or null",
      "published_at": "ISO timestamp from the news",
      "reasoning": "ONE sentence on why this matters for THIS ticker specifically"
    }
  ]
}`

function buildUserPrompt(
  ticker: string,
  sectorContextStr: string,
  fundContextStr: string,
  news: AlpacaNewsItem[],
  windowStart: string,
  windowEnd: string,
): string {
  const newsBlock = news.length === 0
    ? '(No news items in the overnight window matched relevance filters.)'
    : news.slice(0, 30).map((n, i) => {
        const summary = n.summary ? `\n   ${n.summary.slice(0, 280)}` : ''
        return `${i + 1}. (${n.created_at}) ${n.headline}\n   url: ${n.url ?? 'n/a'}${summary}`
      }).join('\n\n')

  return `TICKER: ${ticker}
NEWS WINDOW: ${windowStart} → ${windowEnd}
${sectorContextStr}${fundContextStr}

OVERNIGHT NEWS ITEMS (pre-filtered for relevance):
${newsBlock}

Generate the structured overnight brief in JSON format per the system instructions.`
}

// =============================================================
// Main entrypoint
// =============================================================

export async function generateOvernightBrief(
  ticker: string,
  options: {
    windowStart?: Date
    windowEnd?: Date
    newsLimit?: number
  } = {},
): Promise<OvernightBrief> {
  const startTime = Date.now()
  const t = ticker.toUpperCase()

  // Window
  const windowEnd = options.windowEnd ?? new Date()
  const { start: defaultStart } = defaultOvernightWindow(windowEnd)
  const windowStart = options.windowStart ?? defaultStart

  // 1. Sector context (cached, fast)
  let sectorPeers: string[] = []
  let sectorName: string | null = null
  let sectorContextStr = ''
  try {
    const sc = await getSectorContext(t)
    sectorName = sc.sector
    sectorPeers = (sc.peers ?? []).map(p => p.ticker).filter(Boolean)
    if (sc.promptContext) {
      sectorContextStr = sc.promptContext
    } else if (sectorName) {
      sectorContextStr = `\n\nSECTOR CONTEXT:\nSector: ${sectorName}${sectorPeers.length ? `\nPeers: ${sectorPeers.join(', ')}` : ''}`
    }
  } catch (e) {
    console.warn(`[overnight-brief] sector lookup failed for ${t}:`, e)
  }

  // 2. Fund detection
  const isFund = isFundTicker(t)
  let fundContextStr = ''
  if (isFund) {
    const info = getFundInfo(t)
    fundContextStr = `\n\nFUND TYPE: ${info.description} (tracks ${info.tracksUnderlying})`
  }

  // 3. Fetch news (Alpaca returns up to `limit` most-recent items)
  let allNews: AlpacaNewsItem[] = []
  try {
    allNews = await fetchNews(t, options.newsLimit ?? 50)
  } catch (e) {
    console.error(`[overnight-brief] news fetch failed for ${t}:`, e)
  }

  // 4. Filter to overnight window + relevance
  const relevantNews = filterRelevantNews(
    allNews, t, sectorPeers, sectorName, isFund, windowStart, windowEnd,
  )

  // 5. Short-circuit if nothing relevant (saves an LLM call)
  if (relevantNews.length === 0) {
    return {
      ticker: t,
      brief_date: windowEnd.toISOString().slice(0, 10),
      summary: `No material overnight news for ${t}. Quiet session ahead — watch for general market direction at the open.`,
      sentiment_skew: 'quiet',
      items: [],
      news_count: allNews.length,
      news_window_start: windowStart.toISOString(),
      news_window_end: windowEnd.toISOString(),
      generation_ms: Date.now() - startTime,
    }
  }

  // 6. LLM synthesis
  const userPrompt = buildUserPrompt(
    t, sectorContextStr, fundContextStr, relevantNews,
    windowStart.toISOString(), windowEnd.toISOString(),
  )

  let summary = ''
  let sentimentSkew: OvernightBrief['sentiment_skew'] = 'neutral'
  let items: BriefItem[] = []
  let inputTokens: number | undefined
  let outputTokens: number | undefined

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })

    inputTokens = msg.usage?.input_tokens
    outputTokens = msg.usage?.output_tokens

    type TextBlock = { type: string; text?: string }
    const text = (msg.content as TextBlock[])
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text!)
      .join('\n')

    const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
    const parsed = JSON.parse(cleaned)

    summary = String(parsed.summary ?? `Overnight brief for ${t}.`)
    sentimentSkew = (
      ['bullish', 'bearish', 'mixed', 'neutral', 'quiet'].includes(parsed.sentiment_skew)
        ? parsed.sentiment_skew
        : 'neutral'
    ) as OvernightBrief['sentiment_skew']

    if (Array.isArray(parsed.items)) {
      items = parsed.items
        .filter((i: unknown) => i && typeof i === 'object')
        .map((raw: Record<string, unknown>) => ({
          severity: (
            ['high', 'medium', 'low'].includes(raw.severity as string)
              ? raw.severity
              : 'low'
          ) as BriefItem['severity'],
          direction: (
            ['bullish', 'bearish', 'uncertain'].includes(raw.direction as string)
              ? raw.direction
              : 'uncertain'
          ) as BriefItem['direction'],
          headline: String(raw.headline ?? '').slice(0, 500),
          url: raw.url ? String(raw.url).slice(0, 500) : null,
          source: raw.source ? String(raw.source).slice(0, 100) : null,
          published_at: String(raw.published_at ?? windowEnd.toISOString()),
          reasoning: String(raw.reasoning ?? '').slice(0, 500),
        }))
        .slice(0, 8)  // cap at 8 items per brief
    }
  } catch (e) {
    console.error(`[overnight-brief] LLM synthesis failed for ${t}:`, e)
    summary = `Brief generation encountered an error. ${relevantNews.length} relevant news items were found in the overnight window — please check the news feed manually.`
    sentimentSkew = 'neutral'
    items = []
  }

  return {
    ticker: t,
    brief_date: windowEnd.toISOString().slice(0, 10),
    summary,
    sentiment_skew: sentimentSkew,
    items,
    news_count: allNews.length,
    news_window_start: windowStart.toISOString(),
    news_window_end: windowEnd.toISOString(),
    llm_input_tokens: inputTokens,
    llm_output_tokens: outputTokens,
    generation_ms: Date.now() - startTime,
  }
}
