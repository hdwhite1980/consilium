/**
 * app/lib/market-monitor.ts
 *
 * Real-Time Market Intelligence Monitor
 *
 * Runs every 3 minutes via cron (or manual trigger).
 * For each run:
 *   1. Fetch latest news from Alpaca + Finnhub since last run
 *   2. Check social signals (Trump/Elon/Powell/Buffett headlines)
 *   3. Deduplicate against what's already been seen
 *   4. Batch-evaluate new items with Claude — filter to significant only
 *   5. Write significant items to monitor_alerts table
 *   6. Update monitor_state with last seen item
 *
 * Significance threshold:
 *   - Any Trump/Elon/Fed/Buffett mention → always evaluate
 *   - Earnings surprise / guidance change → always evaluate
 *   - M&A, leadership change, SEC action → always evaluate
 *   - General news → only if Claude rates impact_magnitude 'high'
 *
 * Pipeline injection:
 *   getMonitorContext() → recent critical/high alerts formatted for AI bundle
 */

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

const getAdmin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Social keyword triggers ───────────────────────────────────────────────────
const SOCIAL_TRIGGERS = [
  // Political / policy
  'trump', 'donald trump', 'president trump', 'white house announces',
  'executive order', 'trump tariff', 'trump trade', 'trump signs',
  // Fed
  'jerome powell', 'powell says', 'fed chair', 'fomc', 'rate cut', 'rate hike',
  'federal reserve', 'fed minutes', 'fed decision', 'monetary policy',
  // Elon
  'elon musk', 'elon', '@elonmusk', 'tesla ceo musk',
  // Buffett / major investors
  'warren buffett', 'berkshire hathaway', 'berkshire', 'charlie munger',
  'michael burry', 'scion capital', 'bill ackman', 'ray dalio',
  'cathie wood', 'ark invest', 'nancy pelosi',
]

// ── High-signal news keywords ─────────────────────────────────────────────────
const HIGH_SIGNAL_KEYWORDS = [
  // Market-moving events
  'earnings beat', 'earnings miss', 'guidance raised', 'guidance cut', 'guidance withdrawn',
  'revenue beat', 'revenue miss', 'eps beat', 'eps miss',
  'merger', 'acquisition', 'takeover', 'buyout', 'deal', 'bid for',
  'ipo', 'spinoff', 'split', 'bankruptcy', 'chapter 11', 'default',
  'ceo resigns', 'ceo fired', 'ceo steps down', 'cfo departs',
  'fda approval', 'fda rejection', 'fda decision', 'clinical trial',
  'sec investigation', 'sec charges', 'doj investigation', 'antitrust',
  'data breach', 'cyberattack', 'hack',
  'dividend cut', 'dividend raised', 'buyback', 'share repurchase',
  'layoffs', 'job cuts', 'restructuring',
  'partnership', 'contract win', 'government contract',
  'short seller', 'hindenburg', 'citron',
  // Macro
  'inflation', 'cpi', 'ppi', 'jobs report', 'nonfarm payroll',
  'gdp', 'recession', 'rate decision', 'treasury yield',
  'oil price', 'crude oil', 'opec',
]

// ── Fetch new Alpaca news since last run ──────────────────────────────────────
async function fetchNewAlpacaNews(lastItemId: string | null): Promise<Array<{
  id: string; headline: string; summary: string; url: string; created_at: string; symbols: string[]
}>> {
  const key    = process.env.ALPACA_API_KEY
  const secret = process.env.ALPACA_SECRET_KEY
  if (!key || !secret) return []

  try {
    // Fetch last 10 minutes of news
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const res = await fetch(
      `https://data.alpaca.markets/v1beta1/news?limit=50&sort=desc&start=${since}`,
      { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } }
    )
    if (!res.ok) return []
    const data = await res.json()
    const news = data.news || []

    // Filter to only items we haven't seen
    const filtered = lastItemId
      ? news.filter((n: any) => String(n.id) !== lastItemId)
      : news

    return filtered.map((n: any) => ({
      id: String(n.id),
      headline: n.headline || '',
      summary: n.summary || '',
      url: n.url || '',
      created_at: n.created_at || new Date().toISOString(),
      symbols: n.symbols || [],
    }))
  } catch { return [] }
}

// ── Fetch new Finnhub general news ────────────────────────────────────────────
async function fetchNewFinnhubNews(lastHeadline: string | null): Promise<Array<{
  id: string; headline: string; summary: string; url: string; created_at: string
}>> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return []

  try {
    const res = await fetch(`https://finnhub.io/api/v1/news?category=general&minId=0&token=${key}`)
    if (!res.ok) return []
    const data = await res.json()

    // Deduplicate against last seen headline
    const items = data || []
    const lastIdx = lastHeadline
      ? items.findIndex((n: any) => n.headline === lastHeadline)
      : items.length

    const newItems = lastIdx > 0 ? items.slice(0, lastIdx) : items.slice(0, 20)

    return newItems.map((n: any) => ({
      id: String(n.id || n.datetime),
      headline: n.headline || '',
      summary: n.summary || '',
      url: n.url || '',
      created_at: n.datetime ? new Date(n.datetime * 1000).toISOString() : new Date().toISOString(),
    }))
  } catch { return [] }
}

// ── Score items — filter to only those worth evaluating ───────────────────────
function shouldEvaluate(headline: string, summary: string): { evaluate: boolean; reason: string } {
  const text = (headline + ' ' + summary).toLowerCase()

  for (const kw of SOCIAL_TRIGGERS) {
    if (text.includes(kw)) return { evaluate: true, reason: `social:${kw}` }
  }
  for (const kw of HIGH_SIGNAL_KEYWORDS) {
    if (text.includes(kw)) return { evaluate: true, reason: `signal:${kw}` }
  }
  return { evaluate: false, reason: 'low_signal' }
}

// ── Batch evaluate with Claude ────────────────────────────────────────────────
async function evaluateBatch(items: Array<{
  headline: string; summary: string; url: string; symbols?: string[]; reason: string
}>): Promise<Array<{
  urgency: string
  market_impact: string
  ticker: string | null
  affected_tickers: string[]
  analysis: string
  action: string
  person: string | null
  skip: boolean
}>> {
  if (!items.length) return []

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  const itemList = items.map((item, i) =>
    `[${i + 1}] ${item.headline}\n${item.summary ? `Summary: ${item.summary.slice(0, 150)}` : ''}\n${item.symbols?.length ? `Mentioned tickers: ${item.symbols.join(', ')}` : ''}`
  ).join('\n\n')

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are a real-time market intelligence analyst. Evaluate each news item for immediate market impact.

${itemList}

For each item respond with a JSON array (same order):
[
  {
    "urgency": "critical|high|medium|low",
    "market_impact": "bullish|bearish|neutral|mixed",
    "ticker": "NVDA or null if broad market",
    "affected_tickers": ["NVDA", "AMD"],
    "analysis": "1 sentence: what happened and why it matters to traders RIGHT NOW",
    "action": "Specific action: e.g. 'Watch NVDA pre-market gap up, tariff exemption removes key overhang'",
    "person": "trump|elon_musk|powell|buffett|other or null",
    "skip": false
  }
]

Urgency rules:
- critical: requires immediate attention — major earnings miss/beat, M&A announcement, leadership change, Fed decision, Trump policy with immediate market effect
- high: significant — guidance change, major analyst rating, social media post from monitored person with clear market impact
- medium: notable — secondary earnings detail, minor news, unclear impact
- low / skip=true: noise — skip anything that doesn't affect a publicly traded asset

Be ruthless about skipping noise. Only critical and high urgency items should have detailed actions.
JSON only.`,
    }],
  })

  try {
    const text = (msg.content.find((b: any) => b.type === 'text') as any)?.text || ''
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean.slice(clean.indexOf('['), clean.lastIndexOf(']') + 1))
  } catch {
    return items.map(() => ({
      urgency: 'low', market_impact: 'neutral', ticker: null,
      affected_tickers: [], analysis: '', action: '', person: null, skip: true,
    }))
  }
}

// ── Main monitor run ──────────────────────────────────────────────────────────
export async function runMarketMonitor(): Promise<{
  newItems: number
  alertsCreated: number
  duration: number
}> {
  const start = Date.now()
  const admin = getAdmin()

  // Load monitor state
  const { data: states } = await admin
    .from('monitor_state')
    .select('*')
  const stateMap = new Map<string, any>()
  for (const s of (states || [])) stateMap.set(s.monitor_key, s)

  const alpacaState   = stateMap.get('alpaca_news')
  const finnhubState  = stateMap.get('finnhub_news')

  console.log('[monitor] Starting market monitor run...')

  // Fetch new items in parallel
  const [alpacaNews, finnhubNews] = await Promise.all([
    fetchNewAlpacaNews(alpacaState?.last_item_id || null),
    fetchNewFinnhubNews(finnhubState?.last_headline || null),
  ])

  console.log(`[monitor] Fetched: ${alpacaNews.length} Alpaca, ${finnhubNews.length} Finnhub`)

  // Merge and deduplicate
  const allItems: Array<{
    headline: string; summary: string; url: string
    symbols?: string[]; created_at: string; source: string
    alpacaId?: string; reason: string
  }> = []

  const seenHeadlines = new Set<string>()

  for (const n of alpacaNews) {
    const key = n.headline.toLowerCase().slice(0, 80)
    if (seenHeadlines.has(key)) continue
    const { evaluate, reason } = shouldEvaluate(n.headline, n.summary)
    if (!evaluate) continue
    seenHeadlines.add(key)
    allItems.push({ ...n, source: 'alpaca', alpacaId: n.id, reason })
  }

  for (const n of finnhubNews) {
    const key = n.headline.toLowerCase().slice(0, 80)
    if (seenHeadlines.has(key)) continue
    const { evaluate, reason } = shouldEvaluate(n.headline, n.summary)
    if (!evaluate) continue
    seenHeadlines.add(key)
    allItems.push({ ...n, source: 'finnhub', reason })
  }

  console.log(`[monitor] ${allItems.length} items passed keyword filter, evaluating...`)

  let alertsCreated = 0

  if (allItems.length > 0) {
    // Evaluate in batches of 8
    const batchSize = 8
    for (let i = 0; i < allItems.length; i += batchSize) {
      const batch = allItems.slice(i, i + batchSize)
      const evaluations = await evaluateBatch(batch)

      for (let j = 0; j < batch.length; j++) {
        const item = batch[j]
        const ev = evaluations[j]
        if (!ev || ev.skip || ev.urgency === 'low') continue

        // Check dedup — don't create alert if same headline already exists today
        const { data: existing } = await admin
          .from('monitor_alerts')
          .select('id')
          .eq('headline', item.headline.slice(0, 500))
          .gte('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
          .maybeSingle()
        if (existing) continue

        await admin.from('monitor_alerts').insert({
          alert_type: ev.person ? 'social' : 'news',
          urgency: ev.urgency,
          ticker: ev.ticker || null,
          headline: item.headline.slice(0, 500),
          summary: item.summary?.slice(0, 1000) || null,
          analysis: ev.analysis,
          action: ev.action,
          market_impact: ev.market_impact,
          source: item.source,
          source_url: item.url,
          person: ev.person || null,
          raw_data: {
            affected_tickers: ev.affected_tickers,
            symbols: item.symbols,
            reason: item.reason,
          },
        })
        alertsCreated++
      }
    }
  }

  // Update monitor state
  if (alpacaNews.length > 0) {
    await admin.from('monitor_state').upsert({
      monitor_key: 'alpaca_news',
      last_run: new Date().toISOString(),
      last_item_id: alpacaNews[0].id,
      last_headline: alpacaNews[0].headline,
      items_processed: (alpacaState?.items_processed || 0) + alpacaNews.length,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'monitor_key' })
  }

  if (finnhubNews.length > 0) {
    await admin.from('monitor_state').upsert({
      monitor_key: 'finnhub_news',
      last_run: new Date().toISOString(),
      last_headline: finnhubNews[0].headline,
      items_processed: (finnhubState?.items_processed || 0) + finnhubNews.length,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'monitor_key' })
  }

  const duration = Date.now() - start
  console.log(`[monitor] Done — ${allItems.length} evaluated, ${alertsCreated} alerts created (${duration}ms)`)

  return { newItems: allItems.length, alertsCreated, duration }
}

// ── Get recent alerts for pipeline injection ──────────────────────────────────
export async function getMonitorAlerts(ticker?: string, maxAgeMinutes = 120): Promise<string> {
  const admin = getAdmin()
  const since = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString()

  // Get critical + high alerts
  let query = admin
    .from('monitor_alerts')
    .select('urgency, alert_type, ticker, headline, analysis, action, market_impact, person, created_at, raw_data')
    .gte('created_at', since)
    .in('urgency', ['critical', 'high'])
    .order('created_at', { ascending: false })
    .limit(8)

  const { data: alerts } = await query

  // Also get ticker-specific medium alerts if ticker provided
  let tickerAlerts: any[] = []
  if (ticker) {
    const { data } = await admin
      .from('monitor_alerts')
      .select('urgency, alert_type, ticker, headline, analysis, action, market_impact, person, created_at, raw_data')
      .gte('created_at', since)
      .eq('ticker', ticker.toUpperCase())
      .order('created_at', { ascending: false })
      .limit(3)
    tickerAlerts = data || []
  }

  const allAlerts = [
    ...tickerAlerts,
    ...(alerts || []).filter(a => a.ticker !== ticker),
  ]

  if (!allAlerts.length) return ''

  const lines: string[] = ['=== BREAKING MARKET ALERTS (last 2 hours) ===']
  for (const a of allAlerts) {
    const age = Math.round((Date.now() - new Date(a.created_at).getTime()) / 60000)
    const tickers = (a.raw_data as any)?.affected_tickers?.length
      ? ` [${(a.raw_data as any).affected_tickers.join(', ')}]`
      : a.ticker ? ` [${a.ticker}]` : ''
    lines.push(
      `[${a.urgency.toUpperCase()} ${a.market_impact.toUpperCase()}${tickers} ${age}m ago] ${a.headline}`,
      `  ${a.analysis}`,
      a.action ? `  → ${a.action}` : '',
    )
  }
  return lines.filter(Boolean).join('\n')
}

// ── Get unacknowledged alerts for UI ─────────────────────────────────────────
export async function getUnacknowledgedAlerts(): Promise<any[]> {
  const admin = getAdmin()
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()

  const { data } = await admin
    .from('monitor_alerts')
    .select('*')
    .eq('acknowledged', false)
    .gte('created_at', twoHoursAgo)
    .order('created_at', { ascending: false })
    .limit(20)

  return data || []
}
