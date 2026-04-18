/**
 * app/lib/social-signals.ts
 *
 * Social Signal Intelligence — tracks market-moving personalities
 *
 * Monitored figures:
 *   - President Trump (Truth Social / statements) — tariffs, trade, sector policy
 *   - Elon Musk (X/Twitter) — TSLA, DOGE, crypto, regulatory
 *   - Warren Buffett — major position changes, market commentary
 *   - Jerome Powell / Fed officials — rate signals
 *   - Nancy Pelosi — congressional trades pattern
 *
 * How it works:
 *   1. Fetches recent news from Alpaca + Finnhub general news
 *   2. Scans headlines for monitored names using keyword matching
 *   3. Claude analyzes each hit for market impact, affected tickers/sectors
 *   4. Stores in social_signals table with action signal
 *   5. getLatestSocialContext() formats for pipeline injection
 */

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

const getAdmin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Monitored personalities ───────────────────────────────────────────────────
const MONITORED_PEOPLE: Array<{
  key: string
  label: string
  platform: string
  keywords: string[]
  defaultSectors: string[]
}> = [
  {
    key: 'trump',
    label: 'President Trump',
    platform: 'truth_social',
    keywords: [
      'trump', 'donald trump', 'president trump', 'truth social',
      'white house', 'executive order trump', 'trump tariff',
      'trump trade', 'trump post', 'trump says', 'trump announces',
      'mar-a-lago', 'trump administration',
    ],
    defaultSectors: ['Industrials', 'Energy', 'Financials', 'Technology', 'Consumer Staples'],
  },
  {
    key: 'elon_musk',
    label: 'Elon Musk',
    platform: 'x_twitter',
    keywords: [
      'elon musk', 'elon', 'musk', '@elonmusk', 'elon musk says',
      'elon musk posts', 'tesla ceo', 'spacex', 'doge', 'dogecoin musk',
      'elon musk tweet', 'musk x post', 'elon musk announces',
    ],
    defaultSectors: ['Technology', 'Consumer Discretionary', 'Communications'],
  },
  {
    key: 'warren_buffett',
    label: 'Warren Buffett',
    platform: 'statement',
    keywords: [
      'warren buffett', 'buffett', 'berkshire hathaway', 'berkshire',
      'buffett says', 'buffett buys', 'buffett sells', 'oracle of omaha',
      'charlie munger', 'berkshire annual',
    ],
    defaultSectors: ['Financials', 'Consumer Staples', 'Energy'],
  },
  {
    key: 'powell',
    label: 'Jerome Powell (Fed)',
    platform: 'statement',
    keywords: [
      'jerome powell', 'powell', 'federal reserve', 'fed chair',
      'fed says', 'fomc', 'powell says', 'rate cut', 'rate hike',
      'fed decision', 'monetary policy', 'fed minutes', 'powell speech',
    ],
    defaultSectors: ['Financials', 'Real Estate', 'Utilities'],
  },
  {
    key: 'pelosi',
    label: 'Nancy Pelosi',
    platform: 'filing',
    keywords: [
      'pelosi', 'nancy pelosi', 'pelosi trades', 'pelosi buys',
      'pelosi stock', 'congressional trade pelosi',
    ],
    defaultSectors: ['Technology', 'Semiconductors'],
  },
  {
    key: 'michael_burry',
    label: 'Michael Burry',
    platform: 'filing',
    keywords: [
      'michael burry', 'burry', 'scion capital', 'michael burry bets',
      'burry shorts', 'big short burry',
    ],
    defaultSectors: ['Technology', 'Financials'],
  },
]

// ── Fetch news from Alpaca ────────────────────────────────────────────────────
async function fetchAlpacaGeneralNews(): Promise<Array<{headline: string; summary: string; url: string; source: string}>> {
  const key    = process.env.ALPACA_API_KEY
  const secret = process.env.ALPACA_SECRET_KEY
  if (!key || !secret) return []

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    // Fetch general market news
    const res = await fetch(
      `https://data.alpaca.markets/v1beta1/news?limit=50&sort=desc&start=${since}`,
      { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } }
    )
    if (!res.ok) return []
    const data = await res.json()
    return (data.news || []).map((n: any) => ({
      headline: n.headline || '',
      summary: n.summary || '',
      url: n.url || '',
      source: 'alpaca',
    }))
  } catch { return [] }
}

// ── Fetch general news from Finnhub ──────────────────────────────────────────
async function fetchFinnhubGeneralNews(): Promise<Array<{headline: string; summary: string; url: string; source: string}>> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return []

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/news?category=general&minId=0&token=${key}`
    )
    if (!res.ok) return []
    const data = await res.json()
    return (data || []).slice(0, 50).map((n: any) => ({
      headline: n.headline || '',
      summary: n.summary || '',
      url: n.url || '',
      source: 'finnhub',
    }))
  } catch { return [] }
}

// ── Match headlines to monitored people ──────────────────────────────────────
function matchPersonFromHeadline(
  headline: string,
  summary: string
): typeof MONITORED_PEOPLE[0] | null {
  const text = (headline + ' ' + summary).toLowerCase()
  for (const person of MONITORED_PEOPLE) {
    if (person.keywords.some(kw => text.includes(kw.toLowerCase()))) {
      return person
    }
  }
  return null
}

// ── Analyze a batch of matched headlines with Claude ─────────────────────────
async function analyzeSignals(
  hits: Array<{
    person: typeof MONITORED_PEOPLE[0]
    headline: string
    summary: string
    url: string
    source: string
  }>
): Promise<Array<{
  market_impact: string
  impact_magnitude: string
  affected_tickers: string[]
  affected_sectors: string[]
  analysis: string
  action_signal: string
}>> {
  if (!hits.length) return []

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  const items = hits.map((h, i) =>
    `[${i + 1}] ${h.person.label}:\nHeadline: ${h.headline}\nSummary: ${h.summary || 'N/A'}`
  ).join('\n\n')

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are a market intelligence analyst. Analyze each news item below and determine the market impact of the statement or post.

${items}

For each item, respond with a JSON array (same order):
[
  {
    "market_impact": "bullish|bearish|neutral|mixed",
    "impact_magnitude": "high|medium|low",
    "affected_tickers": ["TSLA", "NVDA"],
    "affected_sectors": ["Technology", "Energy"],
    "analysis": "1-2 sentences explaining the market impact and why",
    "action_signal": "Specific action for traders e.g. 'Watch TSLA pre-market, tariff news could gap semiconductors down at open'"
  }
]

Rules:
- affected_tickers: only include tickers DIRECTLY mentioned or strongly implied (max 5)
- affected_sectors: use proper names like "Technology" not "XLK"
- analysis: be specific about the mechanism — WHY does this move markets?
- action_signal: be concrete and actionable with specific tickers and directions
- For Trump tariff/trade posts: always include relevant supply chain sectors
- For Elon Musk posts: always consider TSLA and DOGE unless clearly unrelated
- For Powell/Fed: always note rate sensitivity (TLT, financials, real estate)
JSON only.`,
    }],
  })

  try {
    const text = (msg.content.find((b: any) => b.type === 'text') as any)?.text || ''
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean.slice(clean.indexOf('['), clean.lastIndexOf(']') + 1))
  } catch {
    return hits.map(() => ({
      market_impact: 'neutral',
      impact_magnitude: 'low',
      affected_tickers: [],
      affected_sectors: [],
      analysis: 'Could not analyze',
      action_signal: '',
    }))
  }
}

// ── Main scan function ────────────────────────────────────────────────────────
export async function scanSocialSignals(): Promise<number> {
  const admin = getAdmin()
  const today = new Date().toISOString().split('T')[0]

  console.log('[social] Scanning for social signals...')

  // Fetch news from both sources in parallel
  const [alpacaNews, finnhubNews] = await Promise.all([
    fetchAlpacaGeneralNews(),
    fetchFinnhubGeneralNews(),
  ])

  const allNews = [...alpacaNews, ...finnhubNews]
  console.log(`[social] Fetched ${allNews.length} headlines`)

  // Deduplicate by headline
  const seen = new Set<string>()
  const unique = allNews.filter(n => {
    const key = n.headline.toLowerCase().slice(0, 60)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Match headlines to monitored people
  const hits: Array<{
    person: typeof MONITORED_PEOPLE[0]
    headline: string
    summary: string
    url: string
    source: string
  }> = []

  for (const news of unique) {
    const person = matchPersonFromHeadline(news.headline, news.summary)
    if (!person) continue

    // Check if we already have this headline stored
    const { data: existing } = await admin
      .from('social_signals')
      .select('id')
      .eq('headline', news.headline.slice(0, 200))
      .maybeSingle()

    if (existing) continue
    hits.push({ person, ...news })
  }

  if (!hits.length) {
    console.log('[social] No new signals found')
    return 0
  }

  console.log(`[social] Found ${hits.length} new signals, analyzing...`)

  // Analyze in batches of 5
  const batchSize = 5
  let written = 0

  for (let i = 0; i < hits.length; i += batchSize) {
    const batch = hits.slice(i, i + batchSize)
    const analyses = await analyzeSignals(batch)

    for (let j = 0; j < batch.length; j++) {
      const hit = batch[j]
      const analysis = analyses[j] || {}

      await admin.from('social_signals').insert({
        signal_date: today,
        person: hit.person.key,
        person_label: hit.person.label,
        platform: hit.person.platform,
        headline: hit.headline.slice(0, 500),
        summary: hit.summary?.slice(0, 1000),
        source_url: hit.url,
        market_impact: analysis.market_impact || 'neutral',
        impact_magnitude: analysis.impact_magnitude || 'low',
        affected_tickers: analysis.affected_tickers || [],
        affected_sectors: analysis.affected_sectors || [],
        analysis: analysis.analysis || '',
        action_signal: analysis.action_signal || '',
        news_source: hit.source,
        processed: true,
      })
      written++
    }
  }

  console.log(`[social] Wrote ${written} signals`)
  return written
}

// ── Get latest signals for pipeline injection ─────────────────────────────────
export async function getLatestSocialContext(ticker?: string): Promise<string> {
  const admin = getAdmin()

  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0]

  let query = admin
    .from('social_signals')
    .select('person_label, platform, headline, analysis, action_signal, market_impact, impact_magnitude, affected_tickers, affected_sectors, detected_at')
    .gte('signal_date', twoDaysAgo)
    .in('impact_magnitude', ['high', 'medium'])
    .order('detected_at', { ascending: false })
    .limit(10)

  // If ticker provided, also get ticker-specific signals
  if (ticker) {
    const { data: tickerSignals } = await admin
      .from('social_signals')
      .select('person_label, platform, headline, analysis, action_signal, market_impact, impact_magnitude, affected_tickers, affected_sectors, detected_at')
      .gte('signal_date', twoDaysAgo)
      .contains('affected_tickers', [ticker.toUpperCase()])
      .order('detected_at', { ascending: false })
      .limit(5)

    if (tickerSignals?.length) {
      const lines: string[] = [
        `=== SOCIAL & POLITICAL SIGNALS (${ticker}-specific) ===`,
      ]
      for (const s of tickerSignals) {
        lines.push(
          `[${s.impact_magnitude?.toUpperCase()} ${s.market_impact?.toUpperCase()}] ${s.person_label}: ${s.headline}`,
          `  Analysis: ${s.analysis}`,
          s.action_signal ? `  Action: ${s.action_signal}` : '',
        )
      }
      // Also append general signals below
      const { data: general } = await query
      if (general?.length) {
        lines.push('\nGENERAL MARKET SIGNALS:')
        for (const s of general) {
          lines.push(
            `[${s.impact_magnitude?.toUpperCase()} ${s.market_impact?.toUpperCase()}] ${s.person_label}: ${s.headline}`,
            `  ${s.analysis}`,
          )
        }
      }
      return lines.filter(Boolean).join('\n')
    }
  }

  const { data: signals } = await query
  if (!signals?.length) return ''

  const lines: string[] = ['=== SOCIAL & POLITICAL SIGNALS ===']
  for (const s of signals) {
    const tickers = s.affected_tickers?.length ? ` [${s.affected_tickers.join(', ')}]` : ''
    lines.push(
      `[${s.impact_magnitude?.toUpperCase()} ${s.market_impact?.toUpperCase()}] ${s.person_label}${tickers}: ${s.headline}`,
      `  Analysis: ${s.analysis}`,
      s.action_signal ? `  Action: ${s.action_signal}` : '',
    )
  }

  return lines.filter(Boolean).join('\n')
}

// ── Get signals for a specific ticker (for health check / analysis) ───────────
export async function getSignalsForTicker(ticker: string): Promise<Array<{
  person_label: string
  headline: string
  analysis: string
  market_impact: string
  impact_magnitude: string
  action_signal: string
  detected_at: string
}>> {
  const admin = getAdmin()
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0]

  const { data } = await admin
    .from('social_signals')
    .select('person_label, headline, analysis, market_impact, impact_magnitude, action_signal, detected_at')
    .gte('signal_date', twoDaysAgo)
    .contains('affected_tickers', [ticker.toUpperCase()])
    .order('detected_at', { ascending: false })
    .limit(5)

  return data || []
}
