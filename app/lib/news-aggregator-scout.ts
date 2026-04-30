// ─────────────────────────────────────────────────────────────
// app/lib/news-aggregator-scout.ts
//
// SECONDARY NEWS SCOUT — runs in parallel to the primary Gemini News Scout.
// Pulls from real APIs (Stocktwits, NewsAPI, optional Marketaux), then uses
// Gemini to synthesize a structured brief in the same shape as the primary
// scout. Output flows into the Lead Analyst, Devil's Advocate, and Judge
// alongside the primary News Scout's output.
//
// Design principles:
//   - Fail soft: if any source is unavailable, the others still run. If no
//     real data was fetched, return emptyAggregatorResult() with isFallback
//     so downstream stages know to weight it to zero.
//   - Required sources: Stocktwits + NewsAPI. If both fail/missing, the
//     scout returns a fallback. Marketaux is optional — additive layer.
//   - Stocktwits public endpoints don't require auth, but rate-limit. We
//     use a short timeout and no retries.
//   - NewsAPI requires NEWSAPI_KEY in env.
//   - Marketaux requires MARKETAUX_API_KEY in env (optional).
//   - Gemini synthesizes structured output mirroring GeminiResult shape.
//
// ─────────────────────────────────────────────────────────────

import { GoogleGenerativeAI } from '@google/generative-ai'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface AggregatorScoutResult {
  summary: string                    // 3-sentence overview synthesized by Gemini
  headlines: string[]                // top 4-5 headlines surfaced by sources
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed'
  confidence: number                 // 0-100
  keyEvents: string[]                // 2-4 near-term catalysts identified
  retailChatter: {                   // Stocktwits-specific signal
    bullishCount: number
    bearishCount: number
    trending: boolean
    note: string                     // e.g. "trending on Stocktwits, 3:1 bullish skew"
  } | null
  sourcesUsed: Array<'stocktwits' | 'newsapi' | 'marketaux'>
  rawHeadlineCount: number           // total raw headlines aggregated before synthesis
  collectedAt: string
  isFallback?: boolean               // true if synthesis was skipped due to no data
}

interface RawHeadline {
  source: 'stocktwits' | 'newsapi' | 'marketaux'
  headline: string
  summary?: string
  url?: string
  publishedAt?: string
  outlet?: string
  sentiment?: number                 // -1 to +1 if source provides it
}

// ─────────────────────────────────────────────────────────────
// Fallback for when no real data is available
// ─────────────────────────────────────────────────────────────

export function emptyAggregatorResult(): AggregatorScoutResult {
  return {
    summary: 'Aggregator scout data unavailable for this analysis.',
    headlines: [],
    sentiment: 'neutral',
    confidence: 0,
    keyEvents: [],
    retailChatter: null,
    sourcesUsed: [],
    rawHeadlineCount: 0,
    collectedAt: new Date().toISOString(),
    isFallback: true,
  }
}

// ─────────────────────────────────────────────────────────────
// Source 1: Stocktwits (no auth required, public endpoints)
//
// Endpoints:
//   GET /streams/symbol/{ticker}.json — recent messages on a ticker
//   GET /trending/symbols.json — globally trending tickers
// Rate limit: 200 req/hour for unauthenticated; we make 1 req per scout run.
// ─────────────────────────────────────────────────────────────

interface StocktwitsResult {
  headlines: RawHeadline[]
  bullishCount: number
  bearishCount: number
  totalMessages: number
}

async function fetchStocktwits(ticker: string): Promise<StocktwitsResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 6000)
  try {
    const res = await fetch(
      `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(ticker)}.json`,
      { signal: ctrl.signal, cache: 'no-store' }
    )
    if (!res.ok) return { headlines: [], bullishCount: 0, bearishCount: 0, totalMessages: 0 }
    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = (data.messages ?? []) as any[]

    let bull = 0
    let bear = 0
    const headlines: RawHeadline[] = []

    for (const m of messages.slice(0, 30)) {
      const sentiment = m?.entities?.sentiment?.basic
      if (sentiment === 'Bullish') bull++
      else if (sentiment === 'Bearish') bear++

      // Pull the most informative messages (those with sentiment or links) into
      // headlines. Twit messages are short — we treat them as mini-headlines.
      const body = typeof m?.body === 'string' ? m.body : ''
      if (!body || body.length < 10) continue

      // Strip the $TICKER cashtag at the start; trim
      const cleanBody = body
        .replace(new RegExp(`\\$${ticker}\\b`, 'gi'), '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)

      if (cleanBody.length < 10) continue

      headlines.push({
        source: 'stocktwits',
        headline: cleanBody,
        url: typeof m?.id === 'number' ? `https://stocktwits.com/symbol/${ticker}/message/${m.id}` : undefined,
        publishedAt: typeof m?.created_at === 'string' ? m.created_at : undefined,
        outlet: typeof m?.user?.username === 'string' ? `@${m.user.username}` : undefined,
        sentiment: sentiment === 'Bullish' ? 1 : sentiment === 'Bearish' ? -1 : undefined,
      })
    }

    return {
      headlines: headlines.slice(0, 10),
      bullishCount: bull,
      bearishCount: bear,
      totalMessages: messages.length,
    }
  } catch {
    return { headlines: [], bullishCount: 0, bearishCount: 0, totalMessages: 0 }
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Source 2: NewsAPI.org (requires NEWSAPI_KEY)
//
// /v2/everything endpoint with q={ticker}+stock and source filter to credible
// outlets. Free tier: 100 requests/day, headlines only (no full content).
// ─────────────────────────────────────────────────────────────

async function fetchNewsAPI(ticker: string): Promise<RawHeadline[]> {
  const key = process.env.NEWSAPI_KEY
  if (!key) return []

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 7000)

  try {
    // Search for ticker + "stock" to filter out non-financial homonyms
    // (e.g. "AAPL" alone is unique, but "META" matches non-Meta news).
    // domains parameter restricts to credible financial outlets.
    const domains = [
      'reuters.com', 'bloomberg.com', 'wsj.com', 'cnbc.com',
      'marketwatch.com', 'ft.com', 'barrons.com', 'forbes.com',
      'businessinsider.com', 'finance.yahoo.com', 'investors.com',
      'benzinga.com', 'seekingalpha.com',
    ].join(',')

    const fromDate = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]

    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(ticker + ' stock')}` +
      `&domains=${domains}` +
      `&from=${fromDate}` +
      `&language=en` +
      `&sortBy=publishedAt` +
      `&pageSize=15` +
      `&apiKey=${key}`

    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) return []
    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const articles = (data.articles ?? []) as any[]

    return articles.slice(0, 10).map((a) => ({
      source: 'newsapi' as const,
      headline: String(a?.title ?? '').slice(0, 250),
      summary: a?.description ? String(a.description).slice(0, 300) : undefined,
      url: typeof a?.url === 'string' ? a.url : undefined,
      publishedAt: typeof a?.publishedAt === 'string' ? a.publishedAt : undefined,
      outlet: typeof a?.source?.name === 'string' ? a.source.name : undefined,
    })).filter(h => h.headline.length > 5)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Source 3: Marketaux (optional, requires MARKETAUX_API_KEY)
//
// Aggregates Benzinga, MarketWatch, Reuters, Bloomberg etc. with sentiment
// scoring per ticker. Free tier: 100 requests/day, 3 articles per request.
// ─────────────────────────────────────────────────────────────

async function fetchMarketaux(ticker: string): Promise<RawHeadline[]> {
  const key = process.env.MARKETAUX_API_KEY
  if (!key) return []

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 7000)

  try {
    const url = `https://api.marketaux.com/v1/news/all` +
      `?symbols=${encodeURIComponent(ticker)}` +
      `&filter_entities=true` +
      `&language=en` +
      `&limit=10` +
      `&api_token=${key}`

    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) return []
    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = (data.data ?? []) as any[]

    return items.map((i) => {
      // Sentiment is per-entity in marketaux. Average across entities for this ticker.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entities = (i?.entities ?? []) as any[]
      const tickerEntities = entities.filter(e =>
        typeof e?.symbol === 'string' && e.symbol.toUpperCase() === ticker.toUpperCase()
      )
      const sentScores = tickerEntities
        .map(e => typeof e?.sentiment_score === 'number' ? e.sentiment_score : null)
        .filter((s): s is number => s !== null)
      const avgSent = sentScores.length > 0
        ? sentScores.reduce((a, b) => a + b, 0) / sentScores.length
        : undefined

      return {
        source: 'marketaux' as const,
        headline: String(i?.title ?? '').slice(0, 250),
        summary: i?.snippet ? String(i.snippet).slice(0, 300)
          : i?.description ? String(i.description).slice(0, 300)
          : undefined,
        url: typeof i?.url === 'string' ? i.url : undefined,
        publishedAt: typeof i?.published_at === 'string' ? i.published_at : undefined,
        outlet: typeof i?.source === 'string' ? i.source : undefined,
        sentiment: avgSent,
      }
    }).filter(h => h.headline.length > 5)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Synthesis: Gemini reads aggregated headlines + sentiment and produces
// a structured brief mirroring the primary News Scout's output shape.
// ─────────────────────────────────────────────────────────────

async function synthesizeWithGemini(
  ticker: string,
  currentPrice: number,
  timeframe: string,
  headlines: RawHeadline[],
  stRetail: StocktwitsResult | null,
): Promise<Pick<AggregatorScoutResult, 'summary' | 'headlines' | 'sentiment' | 'confidence' | 'keyEvents'>> {
  const key = process.env.GEMINI_API_KEY
  if (!key) {
    return {
      summary: 'Gemini synthesis unavailable (no API key).',
      headlines: headlines.slice(0, 5).map(h => h.headline),
      sentiment: 'neutral',
      confidence: 0,
      keyEvents: [],
    }
  }

  // Build a compact prompt block from the raw data
  const formatted = headlines.slice(0, 25).map((h, i) => {
    const ts = h.publishedAt
      ? new Date(h.publishedAt).toISOString().slice(5, 16).replace('T', ' ')
      : '?'
    const outlet = h.outlet ? ` (${h.outlet})` : ''
    const sent = typeof h.sentiment === 'number'
      ? ` [sent: ${h.sentiment > 0 ? '+' : ''}${h.sentiment.toFixed(2)}]`
      : ''
    const summary = h.summary ? ` — ${h.summary}` : ''
    return `[${i + 1}] [${h.source}${outlet}] [${ts}]${sent} ${h.headline}${summary}`
  }).join('\n')

  const retailBlock = stRetail && (stRetail.bullishCount + stRetail.bearishCount) > 0
    ? `\nSTOCKTWITS RETAIL CHATTER:
- ${stRetail.bullishCount} bullish-tagged messages, ${stRetail.bearishCount} bearish-tagged, ${stRetail.totalMessages} total recent messages
- Skew: ${stRetail.bullishCount > stRetail.bearishCount * 2 ? 'strongly bullish' : stRetail.bearishCount > stRetail.bullishCount * 2 ? 'strongly bearish' : 'mixed'}`
    : ''

  const tfFocus: Record<string, string> = {
    '1D': 'Focus on TODAY only — intraday news and breaking catalysts.',
    '1W': 'Focus on THIS WEEK — earnings/data this week.',
    '1M': 'Focus on THIS MONTH — upcoming earnings and analyst actions.',
    '3M': 'Focus on NEXT QUARTER — earnings trajectory and macro tailwinds/headwinds.',
  }

  const prompt = `You are a secondary news aggregator covering ${ticker} (currently $${currentPrice.toFixed(2)}). The primary News Scout uses Alpaca/Finnhub/grounded search; you cover Stocktwits retail chatter, NewsAPI mainstream outlets, and (if present) Marketaux sentiment-scored coverage. Your job is to surface what those sources reveal that the primary scout might miss — particularly retail sentiment intensity and any credible-outlet coverage from the past week.

TIMEFRAME: ${timeframe} — ${tfFocus[timeframe] ?? tfFocus['1W']}

RAW HEADLINES (${headlines.length} total):
${formatted}
${retailBlock}

Synthesize. Return JSON ONLY (no fences, no prose):
{
  "summary": "3-sentence overview of what these sources are saying. Reference Stocktwits retail skew if notable. Cite outlet names.",
  "headlines": ["top 4-5 most informative headlines, lightly cleaned"],
  "sentiment": "positive|negative|neutral|mixed",
  "confidence": <0-100, integer>,
  "keyEvents": ["2-4 near-term catalysts identifiable from the headlines"]
}

Rules:
- If the headlines are weak (all old, all duplicates, or vague), set confidence below 40 and say so in the summary.
- Do NOT invent catalysts. Only list events the headlines actually mention.
- "sentiment" should reflect the weighted tone of the headlines — Stocktwits skew is one input but a single bullish skew on Stocktwits doesn't override negative mainstream coverage.`

  try {
    const genAI = new GoogleGenerativeAI(key)
    const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']
    let lastErr: Error | null = null

    for (const modelName of GEMINI_MODELS) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
        })
        const result = await model.generateContent(prompt)
        const text = result.response.text()
        const clean = text.replace(/```json|```/g, '').trim()
        const start = clean.indexOf('{')
        const end = clean.lastIndexOf('}')
        if (start === -1 || end === -1) throw new Error('No JSON in response')
        const parsed = JSON.parse(clean.slice(start, end + 1))

        const validSentiment = ['positive', 'negative', 'neutral', 'mixed']
        const sentiment = validSentiment.includes(parsed.sentiment) ? parsed.sentiment : 'neutral'
        const confidence = typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(100, Math.round(parsed.confidence)))
          : 50

        return {
          summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 600) : '',
          headlines: Array.isArray(parsed.headlines)
            ? parsed.headlines.filter((h: unknown) => typeof h === 'string').slice(0, 5)
            : [],
          sentiment: sentiment as AggregatorScoutResult['sentiment'],
          confidence,
          keyEvents: Array.isArray(parsed.keyEvents)
            ? parsed.keyEvents.filter((e: unknown) => typeof e === 'string').slice(0, 4)
            : [],
        }
      } catch (e) {
        lastErr = e as Error
        const msg = (e as Error).message ?? ''
        const isLast = modelName === GEMINI_MODELS[GEMINI_MODELS.length - 1]
        if (isLast) throw e
        // Try next model on 503/overload/404
        if (!msg.includes('503') && !msg.includes('overload') && !msg.includes('404')) throw e
      }
    }
    throw lastErr ?? new Error('All Gemini models failed')
  } catch (e) {
    console.warn(`[aggregator-scout] Gemini synthesis failed: ${(e as Error).message?.slice(0, 200)}`)
    // Fall back to a deterministic summary built from the raw data
    return {
      summary: `Aggregator pulled ${headlines.length} headlines but Gemini synthesis was unavailable.`,
      headlines: headlines.slice(0, 5).map(h => h.headline),
      sentiment: 'neutral',
      confidence: 30,
      keyEvents: [],
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Public entrypoint: per-ticker aggregator scout
//
// Mirrors runSocialScout's signature. Never throws — returns
// emptyAggregatorResult() with isFallback on failure.
// ─────────────────────────────────────────────────────────────

export async function runAggregatorScout(
  ticker: string,
  currentPrice: number,
  timeframe: string = '1W',
): Promise<AggregatorScoutResult> {
  const started = Date.now()

  // Stocktwits doesn't need a key — it's the floor of "do we have any data."
  // NewsAPI is the other required source.
  // Marketaux is optional: skipped silently if no key.
  const stocktwitsP = fetchStocktwits(ticker)
  const newsapiP = fetchNewsAPI(ticker)
  const marketauxP = process.env.MARKETAUX_API_KEY ? fetchMarketaux(ticker) : Promise.resolve([])

  const [st, na, ma] = await Promise.all([stocktwitsP, newsapiP, marketauxP])

  const allHeadlines: RawHeadline[] = [...st.headlines, ...na, ...ma]
  const sourcesUsed: AggregatorScoutResult['sourcesUsed'] = []
  if (st.headlines.length > 0 || st.totalMessages > 0) sourcesUsed.push('stocktwits')
  if (na.length > 0) sourcesUsed.push('newsapi')
  if (ma.length > 0) sourcesUsed.push('marketaux')

  // If we got nothing at all from required sources, return fallback.
  // Stocktwits or NewsAPI must have produced something.
  const requiredOk = (st.headlines.length > 0 || st.totalMessages > 0) || na.length > 0
  if (!requiredOk) {
    const elapsed = Date.now() - started
    console.warn(`[aggregator-scout] ${ticker}: no data from required sources (stocktwits + newsapi). ${elapsed}ms`)
    return {
      ...emptyAggregatorResult(),
      sourcesUsed,
    }
  }

  // Sort headlines by publishedAt desc (within source) for the prompt
  allHeadlines.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0
    return tb - ta
  })

  // Synthesize via Gemini
  const synth = await synthesizeWithGemini(ticker, currentPrice, timeframe, allHeadlines, st)

  // Build retail chatter block if Stocktwits had useful messages
  const retailChatter = st.bullishCount + st.bearishCount > 0
    ? {
      bullishCount: st.bullishCount,
      bearishCount: st.bearishCount,
      trending: st.totalMessages > 20,
      note: st.bullishCount > st.bearishCount * 2
        ? `${st.bullishCount} bullish vs ${st.bearishCount} bearish messages — strong bullish skew`
        : st.bearishCount > st.bullishCount * 2
        ? `${st.bullishCount} bullish vs ${st.bearishCount} bearish messages — strong bearish skew`
        : `${st.bullishCount} bullish vs ${st.bearishCount} bearish messages — mixed`,
    }
    : null

  const elapsed = Date.now() - started
  console.log(`[aggregator-scout] ${ticker}: ${allHeadlines.length} headlines in ${elapsed}ms (st:${st.headlines.length}+${st.bullishCount}b/${st.bearishCount}b na:${na.length} ma:${ma.length})`)

  return {
    ...synth,
    retailChatter,
    sourcesUsed,
    rawHeadlineCount: allHeadlines.length,
    collectedAt: new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────
// Prompt formatter — mirrors formatSocialSentimentForPrompt pattern
// ─────────────────────────────────────────────────────────────

export function formatAggregatorForPrompt(
  agg: AggregatorScoutResult,
  role: 'lead' | 'devil' | 'judge',
): string {
  if (agg.isFallback || agg.confidence < 30) {
    return `AGGREGATOR SCOUT (Stocktwits + NewsAPI${agg.sourcesUsed.includes('marketaux') ? ' + Marketaux' : ''}): Insufficient signal (confidence: ${agg.confidence}). Do not weight this dimension in your analysis.`
  }

  const roleDirective = {
    lead: `When the aggregator scout reinforces or contradicts your thesis, cite it with phrases like "Aggregator coverage shows...", "Per Stocktwits chatter...", or "Mainstream outlets report...". This is a SECONDARY source — the primary News Scout already covered Alpaca/Finnhub. Use the aggregator to either confirm consensus or flag retail-only narratives the news flow missed.`,
    devil: `Use the aggregator scout to find narratives the Lead Analyst's preferred sources missed. Stocktwits retail chatter often surfaces concerns or hype that mainstream outlets don't yet cover. If the aggregator's sentiment diverges from the primary News Scout, that divergence is itself an argument worth raising.`,
    judge: `The aggregator scout is a secondary signal. Weight it less than the primary News Scout but use it to confirm or contradict consensus. If aggregator and primary disagree on sentiment, surface the disagreement explicitly in your verdict and note which side you found more persuasive and why.`,
  }[role]

  const retail = agg.retailChatter
    ? `\nRetail chatter (Stocktwits): ${agg.retailChatter.note}${agg.retailChatter.trending ? ' (trending)' : ''}.`
    : ''

  const events = agg.keyEvents.length > 0
    ? `\nKey events flagged: ${agg.keyEvents.join('; ')}`
    : ''

  return `AGGREGATOR SCOUT (sources: ${agg.sourcesUsed.join(', ')} — ${agg.rawHeadlineCount} headlines, confidence: ${agg.confidence}/100, sentiment: ${agg.sentiment}):
${agg.summary}${retail}${events}

Top headlines:
${agg.headlines.map((h, i) => `  ${i + 1}. ${h}`).join('\n')}

${roleDirective}`
}
