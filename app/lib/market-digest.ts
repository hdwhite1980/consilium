/**
 * app/lib/market-digest.ts
 *
 * End-of-day market digest engine.
 *
 * Flow:
 *   1. Fetch day's sector performance, top movers, volume data from Finnhub
 *   2. Pull day's news headlines from Alpaca
 *   3. Pull macro/legislative events from DB (EOs, bills, congressional activity)
 *   4. Pull institutional holdings changes from DB
 *   5. Claude Sonnet runs deep analysis → structured digest
 *   6. Store in market_digests table
 *
 * Pre-market:
 *   1. Load last digest
 *   2. Fetch overnight futures, Asia/Europe moves
 *   3. Claude synthesizes into actionable pre-market brief
 *   4. Store in premarket_sentiment table
 *
 * Pipeline injection:
 *   getLatestDigestContext() → returns formatted string
 *   injected into every analysis as === MARKET REGIME CONTEXT ===
 */

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

const getAdmin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const FINNHUB = process.env.FINNHUB_API_KEY

// ── Sector ETFs ───────────────────────────────────────────────────────────────
const SECTOR_ETFS: Record<string, string> = {
  Technology:    'XLK', Healthcare:  'XLV', Financials:  'XLF',
  Energy:        'XLE', Industrials: 'XLI', 'Consumer Disc': 'XLY',
  'Consumer Stap':'XLP', Materials:  'XLB', Utilities:   'XLU',
  'Real Estate': 'XLRE', Communications: 'XLC',
}

const BROAD_MARKET = ['SPY', 'QQQ', 'IWM', 'DIA', 'VIX', 'TLT', 'GLD', 'DXY']

// ── Fetch sector + broad market data ─────────────────────────────────────────
async function fetchMarketData(): Promise<string> {
  if (!FINNHUB) return ''
  const allTickers = [...Object.values(SECTOR_ETFS), ...BROAD_MARKET]
  const parts: string[] = []

  // Batch fetch quotes
  const quotes = await Promise.all(
    allTickers.map(async sym => {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB}`)
        if (!r.ok) return null
        const q = await r.json()
        if (!q.c) return null
        const chg = q.pc > 0 ? ((q.c - q.pc) / q.pc * 100) : 0
        return { sym, price: q.c, change: parseFloat(chg.toFixed(2)), volume: q.v }
      } catch { return null }
    })
  )

  // Broad market summary
  const broadLines: string[] = []
  for (const q of quotes) {
    if (!q) continue
    if (BROAD_MARKET.includes(q.sym)) {
      broadLines.push(`${q.sym}: $${q.price} (${q.change >= 0 ? '+' : ''}${q.change}%)`)
    }
  }
  if (broadLines.length) parts.push(`BROAD MARKET:\n${broadLines.join('\n')}`)

  // Sector performance
  const sectorLines: string[] = []
  for (const [name, etf] of Object.entries(SECTOR_ETFS)) {
    const q = quotes.find(x => x?.sym === etf)
    if (!q) continue
    const arrow = q.change > 1 ? '▲' : q.change < -1 ? '▼' : '→'
    sectorLines.push(`${arrow} ${name} (${etf}): ${q.change >= 0 ? '+' : ''}${q.change}%`)
  }
  if (sectorLines.length) {
    const sorted = sectorLines.sort((a, b) => {
      const aVal = parseFloat(a.match(/([+-]?\d+\.?\d*)%/)?.[1] || '0')
      const bVal = parseFloat(b.match(/([+-]?\d+\.?\d*)%/)?.[1] || '0')
      return bVal - aVal
    })
    parts.push(`SECTOR PERFORMANCE (sorted best to worst):\n${sorted.join('\n')}`)
  }

  return parts.join('\n\n')
}

// ── Fetch top movers ──────────────────────────────────────────────────────────
async function fetchTopMovers(): Promise<string> {
  if (!FINNHUB) return ''
  try {
    const r = await fetch(`https://finnhub.io/api/v1/stock/market-status?exchange=US&token=${FINNHUB}`)
    // Get active tickers via market overview approach — use multiple sector scans
    const watchList = [
      'NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','NFLX',
      'JPM','GS','BAC','MS','WFC',
      'XOM','CVX','COP','SLB',
      'JNJ','PFE','UNH','ABBV','MRK',
      'BA','CAT','DE','HON','LMT',
      'COIN','HOOD','MSTR','PLTR','SNOW',
      'SPY','QQQ','IWM',
    ]

    const quotes = await Promise.all(
      watchList.map(async sym => {
        try {
          const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB}`)
          if (!res.ok) return null
          const q = await res.json()
          if (!q.c || !q.pc) return null
          const chg = (q.c - q.pc) / q.pc * 100
          return { sym, price: parseFloat(q.c.toFixed(2)), change: parseFloat(chg.toFixed(2)), volume: q.v || 0 }
        } catch { return null }
      })
    )

    const valid = quotes.filter(Boolean) as Array<{sym:string;price:number;change:number;volume:number}>
    const gainers = valid.filter(q => q.change > 0).sort((a,b) => b.change - a.change).slice(0, 7)
    const losers  = valid.filter(q => q.change < 0).sort((a,b) => a.change - b.change).slice(0, 7)

    const lines: string[] = []
    if (gainers.length) lines.push(`TOP GAINERS:\n${gainers.map(q => `  ${q.sym}: +${q.change}% ($${q.price})`).join('\n')}`)
    if (losers.length)  lines.push(`TOP LOSERS:\n${losers.map(q => `  ${q.sym}: ${q.change}% ($${q.price})`).join('\n')}`)
    return lines.join('\n\n')
  } catch { return '' }
}

// ── Fetch today's news headlines ──────────────────────────────────────────────
async function fetchDayNews(): Promise<string> {
  try {
    const alpacaKey    = process.env.ALPACA_API_KEY
    const alpacaSecret = process.env.ALPACA_SECRET_KEY
    if (!alpacaKey || !alpacaSecret) return ''

    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
    const today     = new Date().toISOString().split('T')[0]

    // Fetch broad market news
    const r = await fetch(
      `https://data.alpaca.markets/v1beta1/news?start=${yesterday}&end=${today}&limit=30&sort=desc`,
      { headers: { 'APCA-API-KEY-ID': alpacaKey, 'APCA-API-SECRET-KEY': alpacaSecret } }
    )
    if (!r.ok) return ''
    const data = await r.json()
    const news: any[] = data.news || []

    const headlines = news.slice(0, 20).map(n => `• ${n.headline}${n.summary ? ` — ${n.summary.slice(0, 100)}` : ''}`).join('\n')
    return headlines ? `TODAY'S KEY HEADLINES:\n${headlines}` : ''
  } catch { return '' }
}

// ── Pull DB context (legislative, macro, institutional) ───────────────────────
async function fetchDBContext(): Promise<string> {
  const admin = getAdmin()
  const parts: string[] = []

  // Today's legislative events
  const today = new Date().toISOString().split('T')[0]
  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0]

  const { data: legEvents } = await admin
    .from('legislative_events')
    .select('source, event_type, event_date, title, market_relevance, affected_sectors, sentiment, summary')
    .gte('event_date', threeDaysAgo)
    .order('event_date', { ascending: false })
    .limit(10)

  if (legEvents?.length) {
    const lines = legEvents.map(e =>
      `[${e.source?.toUpperCase()} ${e.event_type}] ${e.event_date}: ${e.title}` +
      (e.affected_sectors?.length ? ` | Sectors: ${e.affected_sectors.join(', ')}` : '') +
      (e.sentiment ? ` | ${e.sentiment}` : '') +
      (e.summary ? `\n  ${e.summary}` : '')
    )
    parts.push(`LEGISLATIVE & REGULATORY ACTIVITY (last 3 days):\n${lines.join('\n')}`)
  }

  // Recent congressional trades
  const { data: trades } = await admin
    .from('congressional_trades')
    .select('member_name, party, ticker, trade_type, amount_range, trade_date, disclosure_date')
    .gte('trade_date', new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0])
    .order('trade_date', { ascending: false })
    .limit(10)

  if (trades?.length) {
    const lines = trades.map(t =>
      `${t.member_name} (${t.party}): ${t.trade_type?.toUpperCase()} ${t.ticker} — ${t.amount_range} on ${t.trade_date}`
    )
    parts.push(`CONGRESSIONAL TRADES (last 7 days):\n${lines.join('\n')}`)
  }

  // Recent significant SEC filings
  const { data: filings } = await admin
    .from('sec_filings')
    .select('ticker, form_type, title, significance, sentiment, filed_at, summary')
    .eq('significance', 'high')
    .gte('filed_at', new Date(Date.now() - 2 * 86400000).toISOString())
    .order('filed_at', { ascending: false })
    .limit(8)

  if (filings?.length) {
    const lines = filings.map(f =>
      `[${f.form_type}] ${f.ticker}: ${f.title}` +
      (f.summary ? ` — ${f.summary.slice(0, 120)}` : '')
    )
    parts.push(`SIGNIFICANT SEC FILINGS (last 48h):\n${lines.join('\n')}`)
  }

  // Recent macro events
  const { data: macroEvents } = await admin
    .from('macro_events')
    .select('event_type, severity, title, description, affected_sectors')
    .gte('event_date', threeDaysAgo)
    .order('severity', { ascending: false })
    .limit(5)

  if (macroEvents?.length) {
    const lines = macroEvents.map(e =>
      `[Severity ${e.severity}] ${e.title}: ${e.description?.slice(0, 120) || ''}`
    )
    parts.push(`MACRO EVENTS:\n${lines.join('\n')}`)
  }

  return parts.join('\n\n')
}

// ── Fetch overnight futures + Asia/Europe ─────────────────────────────────────
async function fetchOvernightContext(): Promise<string> {
  if (!FINNHUB) return ''
  try {
    // Use futures ETF proxies — available pre-market
    const proxies = ['SPY', 'QQQ', 'IWM', 'TLT', 'GLD', 'VIXY']
    const quotes = await Promise.all(
      proxies.map(async sym => {
        try {
          const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB}`)
          if (!r.ok) return null
          const q = await r.json()
          const chg = q.pc > 0 ? (q.c - q.pc) / q.pc * 100 : 0
          return { sym, price: q.c, change: parseFloat(chg.toFixed(2)) }
        } catch { return null }
      })
    )
    const lines = quotes.filter(Boolean).map(q => `${q!.sym}: ${q!.change >= 0 ? '+' : ''}${q!.change}%`)
    return lines.length ? `OVERNIGHT/PRE-MARKET PROXIES:\n${lines.join('  |  ')}` : ''
  } catch { return '' }
}

// ── Run end-of-day digest ─────────────────────────────────────────────────────
export async function runMarketDigest(digestDate?: string): Promise<{ id: string; date: string }> {
  const admin = getAdmin()
  const targetDate = digestDate || new Date().toISOString().split('T')[0]

  console.log(`[digest] Starting end-of-day digest for ${targetDate}`)

  // Check if already exists
  const { data: existing } = await admin
    .from('market_digests')
    .select('id')
    .eq('digest_date', targetDate)
    .maybeSingle()

  // Fetch all data in parallel
  console.log('[digest] Fetching market data, news, DB context...')
  const [marketData, topMovers, newsHeadlines, dbContext] = await Promise.all([
    fetchMarketData(),
    fetchTopMovers(),
    fetchDayNews(),
    fetchDBContext(),
  ])

  // Build the full context for Claude
  const sections = [
    `MARKET DIGEST REQUEST — ${targetDate}`,
    marketData,
    topMovers,
    newsHeadlines,
    dbContext,
  ].filter(Boolean).join('\n\n---\n\n')

  console.log(`[digest] Context assembled (${sections.length} chars), running Claude analysis...`)

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  const prompt = `You are a senior market analyst writing an end-of-day institutional market digest for ${targetDate}.

Analyze ALL of the following data and produce a comprehensive, deep analysis that will be used by AI models tomorrow morning to understand market sentiment and context before the open.

${sections}

Write a complete market digest covering:

1. EXECUTIVE SUMMARY — 3-4 sentences on the overall day. What was the dominant theme? Bull/bear bias?

2. SECTOR BREAKDOWN — For every sector that moved significantly (>0.5%), explain:
   - What drove the move
   - Key names within the sector
   - Whether this looks like rotation, momentum, or news-driven
   - Outlook for tomorrow

3. TOP MOVERS ANALYSIS — For each significant gainer and loser:
   - The specific catalyst (earnings, news, macro, technical)
   - Whether this is a one-day event or developing trend
   - What it signals about the broader market

4. MACRO & REGULATORY IMPACT — How did today's legislative activity, EOs, Fed language, or economic data affect markets? What sectors/tickers are most exposed to these forces?

5. SMART MONEY SIGNALS — What do institutional positioning, congressional trades, and significant SEC filings suggest about where smart money is moving?

6. MARKET REGIME ASSESSMENT — Are we in risk-on or risk-off? Trending or choppy? What's the volatility regime? Is breadth healthy or narrow?

7. OVERNIGHT RISKS — Specific things that could move markets before the open tomorrow (earnings after hours, international developments, scheduled economic releases, Fed speakers)

8. TOMORROW'S SETUP — Based on everything above:
   - Expected market direction at open (gap up / flat / gap down)
   - Sectors most likely to outperform
   - Sectors most likely to underperform  
   - 5-7 specific tickers with clear setups
   - Key levels to watch on SPY/QQQ

Then output a structured JSON summary at the end (after your full analysis) in this exact format:
<json>
{
  "sentiment_score": <integer -100 to +100>,
  "sentiment_label": "<strongly_bullish|bullish|neutral|bearish|strongly_bearish>",
  "key_themes": ["theme1", "theme2", "theme3"],
  "open_direction": "<gap_up|flat|gap_down>",
  "expected_spy_move": <decimal like 0.8 for 0.8%>,
  "sectors_to_watch": ["sector1", "sector2", "sector3"],
  "sectors_bullish": ["sector1", "sector2"],
  "sectors_bearish": ["sector1", "sector2"],
  "tickers_to_watch": ["TICK1", "TICK2", "TICK3", "TICK4", "TICK5"],
  "overnight_risks": ["risk1", "risk2", "risk3"],
  "market_regime": "<risk_on|risk_off|mixed|transitioning>"
}
</json>

Be specific with numbers. Reference actual tickers and percentages. This analysis will be read by AI models, not humans, so precision and completeness matter more than readability.`

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 6000,
    messages: [{ role: 'user', content: prompt }],
  })

  const fullText = (msg.content.find((b: any) => b.type === 'text') as any)?.text || ''
  console.log(`[digest] Analysis complete (${fullText.length} chars)`)

  // Parse JSON from analysis
  let structuredData: any = {}
  try {
    const jsonMatch = fullText.match(/<json>([\s\S]*?)<\/json>/i)
    if (jsonMatch) structuredData = JSON.parse(jsonMatch[1].trim())
  } catch (e) {
    console.error('[digest] JSON parse error:', e)
  }

  // Extract market summary (first paragraph)
  const marketSummary = fullText.split('\n\n').find((p: string) => p.includes('dominant') || p.includes('overall') || p.includes('EXECUTIVE')) || fullText.slice(0, 400)

  // Upsert digest
  const { data: saved, error } = await admin
    .from('market_digests')
    .upsert({
      digest_date: targetDate,
      generated_at: new Date().toISOString(),
      market_summary: marketSummary?.slice(0, 500),
      sentiment_score: structuredData.sentiment_score || 0,
      sentiment_label: structuredData.sentiment_label || 'neutral',
      key_themes: structuredData.key_themes || [],
      sector_analysis: { sectors_bullish: structuredData.sectors_bullish, sectors_bearish: structuredData.sectors_bearish },
      top_movers: { tickers: structuredData.tickers_to_watch },
      macro_events: { market_regime: structuredData.market_regime },
      legislative: {},
      overnight_risks: structuredData.overnight_risks || [],
      premarket_outlook: `Expected open: ${structuredData.open_direction || 'flat'}. SPY move: ${structuredData.expected_spy_move ? `±${structuredData.expected_spy_move}%` : 'uncertain'}`,
      sectors_to_watch: structuredData.sectors_to_watch || [],
      key_levels: {},
      catalysts_tomorrow: { tickers: structuredData.tickers_to_watch },
      full_analysis: fullText,
      model_used: 'claude-sonnet-4-20250514',
    }, { onConflict: 'digest_date' })
    .select('id')
    .single()

  if (error) throw error
  console.log(`[digest] Saved digest ${saved.id} for ${targetDate}`)
  return { id: saved.id, date: targetDate }
}

// ── Generate pre-market brief from last digest ────────────────────────────────
export async function generatePremarketBrief(briefDate?: string): Promise<void> {
  const admin = getAdmin()
  const targetDate = briefDate || new Date().toISOString().split('T')[0]

  console.log(`[premarket] Generating pre-market brief for ${targetDate}`)

  // Get last night's digest
  const { data: digest } = await admin
    .from('market_digests')
    .select('*')
    .lte('digest_date', targetDate)
    .order('digest_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!digest) {
    console.log('[premarket] No digest found — skipping pre-market brief')
    return
  }

  // Fetch overnight data
  const [overnightContext, freshNews] = await Promise.all([
    fetchOvernightContext(),
    fetchDayNews(),
  ])

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  const prompt = `You are generating a pre-market brief for ${targetDate} for institutional traders.

LAST NIGHT'S MARKET DIGEST (${digest.digest_date}):
Sentiment: ${digest.sentiment_label} (score: ${digest.sentiment_score})
Key themes: ${digest.key_themes?.join(', ')}
Overnight risks identified: ${digest.overnight_risks?.join(', ')}
Expected open: ${digest.premarket_outlook}
Sectors to watch: ${digest.sectors_to_watch?.join(', ')}

FULL PRIOR ANALYSIS:
${(digest.full_analysis || '').slice(0, 3000)}

CURRENT PRE-MARKET DATA:
${overnightContext}

OVERNIGHT NEWS:
${freshNews}

Generate a sharp, actionable pre-market brief covering:

1. OVERNIGHT SUMMARY — What happened since yesterday's close? Any surprises vs what was expected?

2. OPEN SETUP — How are we setting up for the open? Gap up/down/flat? Why?

3. SECTOR PLAYBOOK — For each sector, one-line view: buy/sell/avoid and why.

4. TOP SETUPS — 5-7 specific tickers with clear entry thesis based on overnight developments.

5. KEY LEVELS — SPY and QQQ: support, resistance, and the level that changes the day.

6. RISK FACTORS — What could make today worse than expected? What could make it better?

7. ONE-LINE VERDICT — The single most important thing to know before the open.

End with JSON:
<json>
{
  "headline": "<single line market outlook>",
  "sentiment_score": <-100 to +100>,
  "sentiment_label": "<label>",
  "open_direction": "<gap_up|flat|gap_down>",
  "expected_move": <decimal %>,
  "top_catalysts": ["cat1", "cat2", "cat3"],
  "sectors_bullish": ["s1", "s2"],
  "sectors_bearish": ["s1", "s2"],
  "tickers_to_watch": ["T1", "T2", "T3", "T4", "T5"]
}
</json>`

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  })

  const briefText = (msg.content.find((b: any) => b.type === 'text') as any)?.text || ''

  let structured: any = {}
  try {
    const m = briefText.match(/<json>([\s\S]*?)<\/json>/i)
    if (m) structured = JSON.parse(m[1].trim())
  } catch {}

  await admin.from('premarket_sentiment').upsert({
    brief_date: targetDate,
    generated_at: new Date().toISOString(),
    headline: structured.headline || `Market opens ${structured.open_direction || 'flat'} — ${digest.sentiment_label}`,
    sentiment_score: structured.sentiment_score || digest.sentiment_score,
    sentiment_label: structured.sentiment_label || digest.sentiment_label,
    open_direction: structured.open_direction || 'flat',
    expected_move: structured.expected_move || 0,
    overnight_summary: overnightContext,
    brief_text: briefText,
    top_catalysts: structured.top_catalysts || [],
    sectors_bullish: structured.sectors_bullish || [],
    sectors_bearish: structured.sectors_bearish || [],
    tickers_to_watch: structured.tickers_to_watch || [],
    digest_id: digest.id,
    model_used: 'claude-sonnet-4-20250514',
  }, { onConflict: 'brief_date' })

  console.log(`[premarket] Brief saved for ${targetDate}`)
}

// ── Get context for analysis pipeline injection ───────────────────────────────
export async function getLatestDigestContext(): Promise<string> {
  const admin = getAdmin()

  // Get latest digest (within last 2 days)
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0]
  const { data: digest } = await admin
    .from('market_digests')
    .select('digest_date, sentiment_label, sentiment_score, key_themes, sector_analysis, overnight_risks, full_analysis, premarket_outlook, sectors_to_watch, macro_events')
    .gte('digest_date', twoDaysAgo)
    .order('digest_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Get latest pre-market brief
  const { data: brief } = await admin
    .from('premarket_sentiment')
    .select('brief_date, headline, sentiment_label, sentiment_score, open_direction, expected_move, top_catalysts, sectors_bullish, sectors_bearish, tickers_to_watch, brief_text')
    .gte('brief_date', twoDaysAgo)
    .order('brief_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!digest && !brief) return ''

  const lines: string[] = ['=== MARKET REGIME CONTEXT ===']

  if (brief) {
    lines.push(`\nPRE-MARKET BRIEF (${brief.brief_date}):`)
    lines.push(`Headline: ${brief.headline}`)
    lines.push(`Sentiment: ${brief.sentiment_label} (${brief.sentiment_score > 0 ? '+' : ''}${brief.sentiment_score}/100)`)
    lines.push(`Open: ${brief.open_direction} | Expected move: ${brief.expected_move ? `±${brief.expected_move}%` : 'uncertain'}`)
    if (brief.top_catalysts?.length) lines.push(`Catalysts: ${brief.top_catalysts.join(', ')}`)
    if (brief.sectors_bullish?.length) lines.push(`Bullish sectors: ${brief.sectors_bullish.join(', ')}`)
    if (brief.sectors_bearish?.length) lines.push(`Bearish sectors: ${brief.sectors_bearish.join(', ')}`)
    if (brief.tickers_to_watch?.length) lines.push(`Tickers to watch: ${brief.tickers_to_watch.join(', ')}`)
    // Inject key excerpts from brief text
    if (brief.brief_text) {
      const excerpt = brief.brief_text.slice(0, 800)
      lines.push(`\nBrief excerpt:\n${excerpt}`)
    }
  }

  if (digest) {
    lines.push(`\nEND-OF-DAY DIGEST (${digest.digest_date}):`)
    lines.push(`Market sentiment: ${digest.sentiment_label} (${digest.sentiment_score > 0 ? '+' : ''}${digest.sentiment_score}/100)`)
    if (digest.key_themes?.length) lines.push(`Key themes: ${digest.key_themes.join(' | ')}`)
    const sectors = digest.sector_analysis as any
    if (sectors?.sectors_bullish?.length) lines.push(`Leading sectors: ${sectors.sectors_bullish.join(', ')}`)
    if (sectors?.sectors_bearish?.length) lines.push(`Lagging sectors: ${sectors.sectors_bearish.join(', ')}`)
    if (digest.overnight_risks?.length) lines.push(`Overnight risks: ${digest.overnight_risks.join(', ')}`)
    const macro = digest.macro_events as any
    if (macro?.market_regime) lines.push(`Market regime: ${macro.market_regime}`)
    // Key analysis excerpt
    if (digest.full_analysis) {
      const excerpt = digest.full_analysis.slice(0, 600)
      lines.push(`\nDigest excerpt:\n${excerpt}`)
    }
  }

  return lines.join('\n')
}
