/**
 * Wali-OS — Legislative & Regulatory Intelligence
 *
 * Data sources (all free, no API keys except Congress.gov):
 * - Congress.gov API  — bills, committee votes, floor activity
 * - Federal Register  — Executive Orders, agency rules, proclamations
 * - House STOCK Act   — congressional member trades (house.gov)
 * - Senate eFD        — senate financial disclosures (efts.sec.gov)
 *
 * Add CONGRESS_API_KEY to Railway env vars (free at api.congress.gov/sign-up)
 */

import { createClient } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '@google/generative-ai'

const FR_BASE = 'https://www.federalregister.gov/api/v1'
const CONGRESS_BASE = 'https://api.congress.gov/v3'
const STOCK_ACT_HOUSE = 'https://disclosures-clerk.house.gov/public_disc/financial-pdfs'
const SENATE_EFD = 'https://efts.sec.gov/LATEST/search-index'
const HOUSE_TRADES_XML = 'https://disclosures-clerk.house.gov/public_disc/ptr-pdfs'

const FR_HEADERS = { 'User-Agent': 'Wali-OS/1.0 support@wali-os.com' }

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// ── Sector → keyword mappings for bill relevance ──────────────────────────────

const SECTOR_KEYWORDS: Record<string, string[]> = {
  technology:    ['semiconductor', 'artificial intelligence', 'AI', 'chip', 'technology', 'cyber', 'digital', 'broadband', 'data', 'privacy', 'antitrust'],
  energy:        ['oil', 'gas', 'petroleum', 'pipeline', 'LNG', 'renewable', 'solar', 'wind', 'nuclear', 'coal', 'carbon', 'climate', 'energy'],
  defense:       ['defense', 'military', 'pentagon', 'weapons', 'NATO', 'national security', 'armed forces', 'NDAA'],
  financials:    ['bank', 'financial', 'securities', 'derivatives', 'crypto', 'stablecoin', 'Fed', 'interest rate', 'FDIC', 'mortgage'],
  healthcare:    ['health', 'pharma', 'drug', 'FDA', 'Medicare', 'Medicaid', 'insurance', 'biotech', 'hospital'],
  industrials:   ['infrastructure', 'manufacturing', 'steel', 'aluminum', 'tariff', 'trade', 'supply chain'],
  consumer:      ['consumer', 'retail', 'food', 'agriculture', 'labor', 'minimum wage', 'housing'],
  mining:        ['mining', 'critical minerals', 'lithium', 'cobalt', 'copper', 'rare earth'],
}

// Tickers associated with major legislative themes
const THEME_TICKERS: Record<string, string[]> = {
  semiconductor:   ['NVDA', 'AMD', 'INTC', 'QCOM', 'TSM', 'ASML', 'AMAT', 'LRCX'],
  ai:             ['NVDA', 'MSFT', 'GOOGL', 'META', 'AMZN', 'AAPL'],
  energy:         ['XOM', 'CVX', 'OXY', 'COP', 'SLB', 'HAL', 'EOG'],
  defense:        ['LMT', 'RTX', 'NOC', 'GD', 'BA', 'HII', 'L3H'],
  pharma:         ['JNJ', 'PFE', 'MRK', 'ABBV', 'BMY', 'LLY', 'AMGN'],
  bank:           ['JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'USB'],
  crypto:         ['COIN', 'MSTR', 'RIOT', 'MARA', 'HUT'],
  tariff:         ['F', 'GM', 'STLD', 'NUE', 'X', 'AA'],
  'clean energy': ['ENPH', 'SEDG', 'FSLR', 'NEE', 'BEP', 'PLUG', 'BE'],
}

function classifyContent(text: string): { sectors: string[]; tickers: string[]; relevance: 'high' | 'medium' | 'low' | 'none' } {
  const lower = text.toLowerCase()
  const sectors: string[] = []
  const tickerSet = new Set<string>()

  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw.toLowerCase()))) {
      sectors.push(sector)
    }
  }

  for (const [theme, tickers] of Object.entries(THEME_TICKERS)) {
    if (lower.includes(theme.toLowerCase())) {
      tickers.forEach(t => tickerSet.add(t))
    }
  }

  const relevance = sectors.length >= 2 ? 'high' :
    sectors.length === 1 ? 'medium' :
    tickerSet.size > 0 ? 'medium' : 'none'

  return { sectors, tickers: [...tickerSet], relevance }
}

// ── Congress.gov Bills ─────────────────────────────────────────────────────────

export async function fetchRecentBills(daysBack = 30): Promise<void> {
  const apiKey = process.env.CONGRESS_API_KEY
  if (!apiKey) {
    console.warn('[legislative] No CONGRESS_API_KEY set — skipping bill fetch')
    return
  }

  const admin = getAdmin()
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  try {
    // Fetch bills with recent actions from market-relevant committees
    const marketCommittees = [
      'House Committee on Financial Services',
      'Senate Committee on Banking',
      'Senate Committee on Commerce',
      'House Committee on Energy and Commerce',
      'Senate Committee on Energy and Natural Resources',
      'House Armed Services Committee',
      'Senate Armed Services Committee',
      'House Committee on Ways and Means',
      'Senate Finance Committee',
      'Senate Judiciary Committee',
      'House Judiciary Committee',
    ]

    // Fetch recently updated bills
    const url = `${CONGRESS_BASE}/bill?sort=updateDate+desc&limit=50&fromDateTime=${since}T00:00:00Z&api_key=${apiKey}&format=json`
    const res = await fetch(url, { headers: FR_HEADERS })
    if (!res.ok) {
      console.warn(`[legislative] Congress API returned ${res.status}`)
      return
    }

    const data = await res.json()
    const bills = data.bills || []

    for (const bill of bills) {
      const externalId = `congress-${bill.number}-${bill.type}-${bill.congress}`

      const { data: existing } = await admin
        .from('legislative_events')
        .select('id, data')
        .eq('external_id', externalId)
        .maybeSingle()

      // Check if status changed
      const latestAction = bill.latestAction?.text || ''
      if (existing) {
        const prevAction = (existing.data as any)?.latest_action
        if (prevAction === latestAction) continue // no change
      }

      const titleText = bill.title || ''
      const fullText = `${titleText} ${latestAction}`
      const { sectors, tickers, relevance } = classifyContent(fullText)

      if (relevance === 'none') continue // skip irrelevant bills

      // Determine sentiment
      const bearishWords = ['restrict', 'ban', 'prohibit', 'tax', 'penalty', 'sanction', 'fine', 'limit']
      const bullishWords = ['fund', 'invest', 'incentive', 'credit', 'subsidy', 'support', 'expand', 'deregulat']
      const sentiment = bearishWords.some(w => fullText.toLowerCase().includes(w)) ? 'bearish' :
        bullishWords.some(w => fullText.toLowerCase().includes(w)) ? 'bullish' : 'neutral'

      // Determine significance from status
      const isBecameLaw = latestAction.toLowerCase().includes('signed') || latestAction.toLowerCase().includes('became public law')
      const passedChamber = latestAction.toLowerCase().includes('passed') || latestAction.toLowerCase().includes('agreed to')
      const committeeAction = latestAction.toLowerCase().includes('committee')

      const significance = isBecameLaw ? 'high' :
        passedChamber ? 'high' : committeeAction ? 'medium' : 'low'

      // AI summary for relevant bills
      let summary = `${titleText}. Latest action: ${latestAction}`
      if (relevance === 'high' && process.env.GEMINI_API_KEY) {
        try {
          const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
          const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' })
          const result = await model.generateContent(
            `Congress bill: "${titleText}". Status: ${latestAction}. ` +
            `In 2 sentences for an investor, explain: 1) What does this bill do? 2) Which stocks or sectors does it affect and how? Be specific.`
          )
          summary = result.response.text().trim().slice(0, 600)
        } catch { /* use default */ }
      }

      await admin.from('legislative_events').upsert({
        source: 'congress',
        event_type: 'bill',
        event_date: bill.latestAction?.actionDate || bill.introducedDate || new Date().toISOString().split('T')[0],
        title: titleText.slice(0, 500),
        summary,
        market_relevance: significance === 'high' ? 'high' : relevance,
        affected_sectors: sectors,
        affected_tickers: tickers,
        sentiment,
        url: bill.url || `https://www.congress.gov/bill/${bill.congress}th-congress/${bill.type?.toLowerCase()}/${bill.number}`,
        external_id: externalId,
        data: {
          bill_number: bill.number,
          bill_type: bill.type,
          congress: bill.congress,
          introduced_date: bill.introducedDate,
          latest_action: latestAction,
          sponsor: bill.sponsors?.[0]?.fullName,
          status: significance,
        },
      }, { onConflict: 'external_id' })

      await new Promise(r => setTimeout(r, 100))
    }
  } catch (e) {
    console.error('[legislative] Congress bills error:', e)
  }
}

// ── Federal Register — Executive Orders & Rules ────────────────────────────────

export async function fetchFederalRegisterActions(daysBack = 7): Promise<void> {
  const admin = getAdmin()
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  try {
    // Fetch Executive Orders
    const eoUrl = `${FR_BASE}/documents.json?` +
      `conditions[type][]=PRESDOCU&conditions[presidential_document_type][]=executive_order` +
      `&conditions[publication_date][gte]=${since}` +
      `&fields[]=title&fields[]=publication_date&fields[]=signing_date&fields[]=executive_order_number` +
      `&fields[]=abstract&fields[]=document_number&fields[]=html_url&fields[]=agencies` +
      `&per_page=20&order=newest`

    const eoRes = await fetch(eoUrl, { headers: FR_HEADERS })
    if (eoRes.ok) {
      const eoData = await eoRes.json()
      for (const eo of (eoData.results || [])) {
        await processRegisterDocument(eo, 'executive_order', admin)
        await new Promise(r => setTimeout(r, 200))
      }
    }

    // Fetch significant proposed rules from market-relevant agencies
    const marketAgencies = [
      'securities-and-exchange-commission',
      'federal-trade-commission',
      'federal-reserve-system',
      'department-of-commerce',
      'department-of-energy',
      'food-and-drug-administration',
      'department-of-defense',
      'environmental-protection-agency',
    ]

    for (const agency of marketAgencies.slice(0, 4)) { // limit to avoid rate issues
      const ruleUrl = `${FR_BASE}/documents.json?` +
        `conditions[type][]=RULE&conditions[agencies][]=${agency}` +
        `&conditions[publication_date][gte]=${since}` +
        `&fields[]=title&fields[]=publication_date&fields[]=abstract&fields[]=document_number` +
        `&fields[]=html_url&fields[]=agencies&fields[]=significant` +
        `&conditions[significant]=1` + // only significant rules
        `&per_page=5&order=newest`

      const ruleRes = await fetch(ruleUrl, { headers: FR_HEADERS })
      if (ruleRes.ok) {
        const ruleData = await ruleRes.json()
        for (const rule of (ruleData.results || [])) {
          await processRegisterDocument(rule, 'rule', admin)
          await new Promise(r => setTimeout(r, 200))
        }
      }

      await new Promise(r => setTimeout(r, 300))
    }

    // Fetch proclamations (often trade-related)
    const procUrl = `${FR_BASE}/documents.json?` +
      `conditions[type][]=PRESDOCU&conditions[presidential_document_type][]=proclamation` +
      `&conditions[publication_date][gte]=${since}` +
      `&fields[]=title&fields[]=publication_date&fields[]=signing_date&fields[]=document_number` +
      `&fields[]=abstract&fields[]=html_url` +
      `&per_page=10&order=newest`

    const procRes = await fetch(procUrl, { headers: FR_HEADERS })
    if (procRes.ok) {
      const procData = await procRes.json()
      for (const proc of (procData.results || [])) {
        const { relevance } = classifyContent(`${proc.title} ${proc.abstract || ''}`)
        if (relevance !== 'none') {
          await processRegisterDocument(proc, 'proclamation', admin)
          await new Promise(r => setTimeout(r, 200))
        }
      }
    }

  } catch (e) {
    console.error('[legislative] Federal Register error:', e)
  }
}

async function processRegisterDocument(doc: any, type: string, admin: any): Promise<void> {
  const externalId = `fr-${doc.document_number}`

  const { data: existing } = await admin
    .from('legislative_events')
    .select('id')
    .eq('external_id', externalId)
    .maybeSingle()
  if (existing) return

  const titleText = doc.title || ''
  const abstract = doc.abstract || ''
  const fullText = `${titleText} ${abstract}`
  const { sectors, tickers, relevance } = classifyContent(fullText)

  const isEO = type === 'executive_order'
  const significance = isEO ? 'high' : relevance // EOs always high significance

  if (!isEO && relevance === 'none') return

  const bearishWords = ['restrict', 'ban', 'sanction', 'tariff', 'penalty', 'increase tax', 'phase out']
  const bullishWords = ['deregulat', 'reduce', 'streamline', 'expand', 'invest', 'fund', 'incentive']
  const sentiment = bearishWords.some(w => fullText.toLowerCase().includes(w)) ? 'bearish' :
    bullishWords.some(w => fullText.toLowerCase().includes(w)) ? 'bullish' : 'neutral'

  let summary = abstract ? abstract.slice(0, 400) : titleText
  if (isEO && process.env.GEMINI_API_KEY) {
    try {
      const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
      const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' })
      const result = await model.generateContent(
        `Executive Order: "${titleText}". Abstract: ${abstract?.slice(0, 400) || 'N/A'}. ` +
        `In 2 sentences for a stock trader: 1) What does this EO do? 2) Which sectors or stocks does this affect and why?`
      )
      summary = result.response.text().trim().slice(0, 600)
    } catch { /* use abstract */ }
  }

  await admin.from('legislative_events').insert({
    source: 'federal_register',
    event_type: type,
    event_date: doc.signing_date || doc.publication_date,
    title: titleText.slice(0, 500),
    summary,
    market_relevance: significance,
    affected_sectors: sectors,
    affected_tickers: tickers,
    sentiment,
    url: doc.html_url,
    external_id: externalId,
    data: {
      document_number: doc.document_number,
      eo_number: doc.executive_order_number,
      agencies: doc.agencies?.map((a: any) => a.name),
      publication_date: doc.publication_date,
      signing_date: doc.signing_date,
    },
  })
}

// ── Congressional Trading (House STOCK Act) ────────────────────────────────────

// QuiverQuant provides a structured feed of congressional trades
// as a free tier — no authentication for basic access
const QUIVERQUANT_BASE = 'https://api.quiverquant.com/beta'

export async function fetchCongressionalTrades(ticker?: string): Promise<void> {
  const admin = getAdmin()

  try {
    // Use House disclosure search (publicly accessible JSON)
    // QuiverQuant aggregates this for free
    const url = ticker
      ? `${QUIVERQUANT_BASE}/historical/congresstrading/${ticker.toUpperCase()}`
      : `${QUIVERQUANT_BASE}/live/congresstrading`

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Wali-OS/1.0 support@wali-os.com',
        'Authorization': process.env.QUIVERQUANT_API_KEY ? `Token ${process.env.QUIVERQUANT_API_KEY}` : '',
      }
    })

    if (!res.ok) {
      // Fall back to House disclosure XML if QuiverQuant unavailable
      await fetchHouseDisclosuresXML(ticker, admin)
      return
    }

    const trades = await res.json()
    for (const trade of (Array.isArray(trades) ? trades : []).slice(0, 100)) {
      const externalId = `ct-${trade.Representative || trade.Senator}-${trade.Ticker}-${trade.Date}-${trade.Transaction}`
      if (!externalId.includes('undefined')) {
        await processCongressionalTrade(trade, externalId, admin)
      }
      await new Promise(r => setTimeout(r, 50))
    }
  } catch (e) {
    console.error('[legislative] Congressional trades error:', e)
    // Always try fallback
    await fetchHouseDisclosuresXML(ticker, admin)
  }
}

async function fetchHouseDisclosuresXML(ticker: string | undefined, admin: any): Promise<void> {
  // House periodically publishes XML of recent PTR (Periodic Transaction Reports)
  try {
    const year = new Date().getFullYear()
    const xmlUrl = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/ptr.xml`

    const res = await fetch(xmlUrl, { headers: FR_HEADERS })
    if (!res.ok) return

    const xml = await res.text()
    const memberBlocks = xml.match(/<Member>[\s\S]*?<\/Member>/g) || []

    for (const block of memberBlocks.slice(0, 200)) {
      const name = block.match(/<Name>(.*?)<\/Name>/)?.[1] || ''
      const tickerMatch = block.match(/<Ticker>(.*?)<\/Ticker>/)?.[1] || ''
      const txDate = block.match(/<TransactionDate>(.*?)<\/TransactionDate>/)?.[1] || ''
      const txType = block.match(/<Type>(.*?)<\/Type>/)?.[1] || ''
      const amount = block.match(/<Amount>(.*?)<\/Amount>/)?.[1] || ''
      const discDate = block.match(/<StatePTR>(.*?)<\/StatePTR>/)?.[1] || txDate

      if (!tickerMatch || !name) continue
      if (ticker && tickerMatch.toUpperCase() !== ticker.toUpperCase()) continue

      const externalId = `house-${name}-${tickerMatch}-${txDate}-${txType}`

      const { data: existing } = await admin
        .from('congressional_trades')
        .select('id')
        .eq('external_id', externalId)
        .maybeSingle()
      if (existing) continue

      // Parse amount range
      const amountRanges: Record<string, [number, number]> = {
        '$1,001 - $15,000': [1001, 15000],
        '$15,001 - $50,000': [15001, 50000],
        '$50,001 - $100,000': [50001, 100000],
        '$100,001 - $250,000': [100001, 250000],
        '$250,001 - $500,000': [250001, 500000],
        '$500,001 - $1,000,000': [500001, 1000000],
        '$1,000,001 - $5,000,000': [1000001, 5000000],
        '$5,000,001 - $25,000,000': [5000001, 25000000],
      }

      const [amountLow, amountHigh] = amountRanges[amount] || [null, null]
      const tradeDate = txDate ? new Date(txDate) : null
      const disclosureDate = discDate ? new Date(discDate) : new Date()
      const lagDays = tradeDate ? Math.floor((disclosureDate.getTime() - tradeDate.getTime()) / 86400000) : null

      await admin.from('congressional_trades').upsert({
        member_name: name,
        chamber: 'House',
        ticker: tickerMatch.toUpperCase(),
        trade_type: txType.toLowerCase().includes('purchase') ? 'purchase' : txType.toLowerCase().includes('sale') ? 'sale' : 'exchange',
        trade_date: tradeDate?.toISOString().split('T')[0],
        disclosure_date: disclosureDate.toISOString().split('T')[0],
        disclosure_lag_days: lagDays,
        amount_low: amountLow,
        amount_high: amountHigh,
        external_id: externalId,
      }, { onConflict: 'external_id' })

      // Log significant trades (>$100K) to legislative events
      if (amountLow && amountLow >= 100000) {
        await admin.from('legislative_events').upsert({
          source: 'congressional_trade',
          event_type: 'trade',
          event_date: tradeDate?.toISOString().split('T')[0] || disclosureDate.toISOString().split('T')[0],
          title: `Congressional Trade: ${name} ${txType.toLowerCase()} ${tickerMatch}`,
          summary: `${name} (House) ${txType.toLowerCase()} $${(amountLow / 1000).toFixed(0)}K-$${((amountHigh || amountLow) / 1000).toFixed(0)}K of ${tickerMatch}${lagDays ? `. Disclosed ${lagDays} days after trade.` : '.'}`,
          market_relevance: amountLow >= 500000 ? 'high' : 'medium',
          affected_tickers: [tickerMatch.toUpperCase()],
          affected_sectors: [],
          sentiment: txType.toLowerCase().includes('purchase') ? 'bullish' : 'bearish',
          external_id: `ct-event-${externalId}`,
          data: { member: name, chamber: 'House', amount_low: amountLow, amount_high: amountHigh, lag_days: lagDays },
        }, { onConflict: 'external_id' })
      }
    }
  } catch (e) {
    console.error('[legislative] House XML fallback error:', e)
  }
}

async function processCongressionalTrade(trade: any, externalId: string, admin: any): Promise<void> {
  const { data: existing } = await admin
    .from('congressional_trades')
    .select('id')
    .eq('external_id', externalId)
    .maybeSingle()
  if (existing) return

  const tradeDate = trade.Date ? new Date(trade.Date) : null
  const discDate = trade.Filed ? new Date(trade.Filed) : new Date()
  const lagDays = tradeDate ? Math.floor((discDate.getTime() - tradeDate.getTime()) / 86400000) : null

  const ticker = (trade.Ticker || '').toUpperCase()
  const txType = (trade.Transaction || '').toLowerCase()
  const amountStr = trade.Range || ''
  const member = trade.Representative || trade.Senator || ''
  const chamber = trade.Senator ? 'Senate' : 'House'

  // Parse amount
  const amountMatch = amountStr.match(/\$([\d,]+)\s*-\s*\$([\d,]+)/)
  const amountLow = amountMatch ? parseInt(amountMatch[1].replace(/,/g, '')) : null
  const amountHigh = amountMatch ? parseInt(amountMatch[2].replace(/,/g, '')) : null

  await admin.from('congressional_trades').upsert({
    member_name: member,
    party: trade.Party,
    chamber,
    state: trade.State,
    ticker,
    asset_name: trade.Asset,
    trade_type: txType.includes('purchase') ? 'purchase' : txType.includes('sale') ? 'sale' : 'exchange',
    trade_date: tradeDate?.toISOString().split('T')[0],
    disclosure_date: discDate.toISOString().split('T')[0],
    disclosure_lag_days: lagDays,
    amount_low: amountLow,
    amount_high: amountHigh,
    is_spouse: (trade.Description || '').toLowerCase().includes('spouse'),
    external_id: externalId,
  }, { onConflict: 'external_id' })

  // Flag significant buys to legislative events
  if (amountLow && amountLow >= 100000 && !txType.includes('sale')) {
    await admin.from('legislative_events').upsert({
      source: 'congressional_trade',
      event_type: 'trade',
      event_date: tradeDate?.toISOString().split('T')[0] || discDate.toISOString().split('T')[0],
      title: `${chamber} ${txType}: ${member} in ${ticker}`,
      summary: `${member} (${trade.Party || '?'}, ${chamber}) ${txType}d $${(amountLow / 1000).toFixed(0)}K-$${((amountHigh || amountLow) / 1000).toFixed(0)}K of ${ticker}${lagDays && lagDays > 30 ? ` — disclosed ${lagDays} days after trade (late disclosure ⚠)` : ''}.`,
      market_relevance: amountLow >= 500000 ? 'high' : 'medium',
      affected_tickers: [ticker],
      affected_sectors: [],
      sentiment: txType.includes('purchase') ? 'bullish' : 'bearish',
      external_id: `ct-event-${externalId}`,
      data: { member, party: trade.Party, chamber, amount_low: amountLow, lag_days: lagDays },
    }, { onConflict: 'external_id' })
  }
}

// ── Master refresh ─────────────────────────────────────────────────────────────

export async function refreshLegislativeIntelligence(): Promise<void> {
  console.log('[legislative] Starting full refresh...')
  await fetchRecentBills(7)
  await new Promise(r => setTimeout(r, 1000))
  await fetchFederalRegisterActions(3)
  await new Promise(r => setTimeout(r, 1000))
  await fetchCongressionalTrades()
  console.log('[legislative] Refresh complete')
}

// ── Query helpers ──────────────────────────────────────────────────────────────

export async function getLegislativeEventsForTicker(ticker: string, limit = 10) {
  const admin = getAdmin()
  const { data } = await admin
    .from('legislative_events')
    .select('*')
    .contains('affected_tickers', [ticker.toUpperCase()])
    .order('event_date', { ascending: false })
    .limit(limit)
  return data || []
}

export async function getCongressionalTradesForTicker(ticker: string, days = 180) {
  const admin = getAdmin()
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const { data } = await admin
    .from('congressional_trades')
    .select('*')
    .eq('ticker', ticker.toUpperCase())
    .gte('trade_date', since)
    .order('trade_date', { ascending: false })
    .limit(20)
  return data || []
}

export async function getRecentHighImpactEvents(limit = 10) {
  const admin = getAdmin()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const { data } = await admin
    .from('legislative_events')
    .select('*')
    .eq('market_relevance', 'high')
    .gte('event_date', thirtyDaysAgo)
    .order('event_date', { ascending: false })
    .limit(limit)
  return data || []
}

// ── AI context builder ─────────────────────────────────────────────────────────

export async function buildLegislativeContext(ticker: string, sectors: string[] = []): Promise<string> {
  const [tickerEvents, congressTrades, highImpact] = await Promise.all([
    getLegislativeEventsForTicker(ticker, 5),
    getCongressionalTradesForTicker(ticker, 90),
    getRecentHighImpactEvents(5),
  ])

  // Also get sector-relevant events
  const admin = getAdmin()
  let sectorEvents: any[] = []
  if (sectors.length > 0) {
    const { data } = await admin
      .from('legislative_events')
      .select('*')
      .overlaps('affected_sectors', sectors)
      .gte('event_date', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
      .order('event_date', { ascending: false })
      .limit(5)
    sectorEvents = data || []
  }

  const allEmpty = tickerEvents.length === 0 && congressTrades.length === 0 &&
    highImpact.length === 0 && sectorEvents.length === 0
  if (allEmpty) return ''

  const lines: string[] = ['=== LEGISLATIVE & REGULATORY INTELLIGENCE ===']

  // High-impact events (EOs, major bills)
  const highImpactFiltered = highImpact.filter(e =>
    !tickerEvents.some(te => te.id === e.id) &&
    !sectorEvents.some(se => se.id === e.id)
  )
  if (highImpactFiltered.length > 0) {
    lines.push('\nHIGH-IMPACT GOVERNMENT ACTIONS (last 30 days):')
    for (const e of highImpactFiltered.slice(0, 3)) {
      lines.push(`• [${e.event_type.toUpperCase()}] ${e.event_date} — ${e.title}`)
      if (e.summary) lines.push(`  ${e.summary}`)
    }
  }

  // Ticker-specific events
  if (tickerEvents.length > 0) {
    lines.push(`\nLEGISLATION DIRECTLY AFFECTING ${ticker}:`)
    for (const e of tickerEvents) {
      lines.push(`• [${e.source.toUpperCase()}] ${e.event_date} — ${e.title} [${e.sentiment}]`)
      if (e.summary) lines.push(`  ${e.summary}`)
    }
  }

  // Sector events
  if (sectorEvents.length > 0) {
    const sectorFiltered = sectorEvents.filter(e => !tickerEvents.some(te => te.id === e.id))
    if (sectorFiltered.length > 0) {
      lines.push(`\nSECTOR LEGISLATION (relevant to ${sectors.join(', ')}):`)
      for (const e of sectorFiltered.slice(0, 3)) {
        lines.push(`• ${e.event_date} — ${e.title} [${e.sentiment}]`)
        if (e.summary) lines.push(`  ${e.summary}`)
      }
    }
  }

  // Congressional trading
  if (congressTrades.length > 0) {
    const purchases = congressTrades.filter((t: any) => t.trade_type === 'purchase')
    const sales = congressTrades.filter((t: any) => t.trade_type === 'sale')
    const totalBuy = purchases.reduce((s: number, t: any) => s + (t.amount_low || 0), 0)
    const totalSell = sales.reduce((s: number, t: any) => s + (t.amount_low || 0), 0)

    lines.push(`\nCONGRESSIONAL TRADING IN ${ticker} (last 90 days, STOCK Act verified):`)
    if (purchases.length > 0) {
      lines.push(`  Purchases: ${purchases.length} members, minimum $${(totalBuy / 1000).toFixed(0)}K total`)
      for (const t of purchases.slice(0, 3)) {
        const lag = t.disclosure_lag_days ? ` (disclosed ${t.disclosure_lag_days}d after trade)` : ''
        lines.push(`  • ${t.member_name} (${t.party || '?'}, ${t.chamber}): Purchased $${((t.amount_low || 0) / 1000).toFixed(0)}K-$${((t.amount_high || 0) / 1000).toFixed(0)}K on ${t.trade_date}${lag}`)
      }
    }
    if (sales.length > 0) {
      lines.push(`  Sales: ${sales.length} members, minimum $${(totalSell / 1000).toFixed(0)}K total`)
      if (sales.some((t: any) => (t.amount_low || 0) > 500000)) {
        lines.push(`  ⚠ Significant congressional selling detected`)
      }
    }
    if (purchases.length > 0 && sales.length === 0) {
      lines.push(`  ⭐ Pure buying pressure from Congress — no sales in 90 days`)
    }
  }

  lines.push('\nINSTRUCTION: Weight this data heavily. Executive Orders and signed legislation have direct market impact. Congressional purchases are legally significant signals — members have 45 days to disclose but must report. Late disclosures may indicate foreknowledge of pending legislation.')

  return lines.join('\n')
}

