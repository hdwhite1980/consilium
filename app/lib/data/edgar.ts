/**
 * Wali-OS — SEC EDGAR XBRL Data Fetcher
 *
 * Pulls verified fundamental data directly from SEC EDGAR.
 * No API key required. Rate limit: 10 req/s (we stay well under via caching).
 *
 * Strategy:
 * 1. Check Supabase cache first (90-day TTL)
 * 2. On cache miss, fetch from EDGAR, store, return
 * 3. Never hit EDGAR during a live analysis — always async/background
 */

import { createClient } from '@supabase/supabase-js'

// SEC requires a User-Agent header identifying the app
const EDGAR_HEADERS = {
  'User-Agent': 'Wali-OS/1.0 support@wali-os.com',
  'Accept': 'application/json',
}

const EDGAR_BASE = 'https://data.sec.gov'
const SEC_BASE = 'https://www.sec.gov'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EdgarFundamentals {
  ticker: string
  cik: string
  company_name: string | null

  // TTM figures
  revenue_ttm: number | null
  net_income_ttm: number | null
  eps_diluted_ttm: number | null
  operating_income_ttm: number | null
  gross_profit_ttm: number | null
  rd_expense_ttm: number | null

  // Balance sheet
  cash: number | null
  total_debt: number | null
  shares_outstanding: number | null
  book_value_per_share: number | null

  // Growth
  revenue_yoy_pct: number | null
  net_income_yoy_pct: number | null
  eps_yoy_pct: number | null

  // Signals
  earnings_trend: string | null
  debt_trend: string | null
  cash_trend: string | null

  // Metadata
  last_filing_date: string | null
  last_filing_type: string | null
  data_source: string
  fetched_at: string
}

// ── CIK Map ───────────────────────────────────────────────────────────────────

// In-memory CIK cache to avoid repeated DB lookups in the same request
const cikMemCache = new Map<string, string>()

export async function getCIK(ticker: string): Promise<string | null> {
  const t = ticker.toUpperCase().replace(/[^A-Z.]/g, '')

  // Check memory cache
  if (cikMemCache.has(t)) return cikMemCache.get(t)!

  const admin = getAdmin()

  // Check DB cache
  const { data } = await admin
    .from('edgar_cik_map')
    .select('cik_padded')
    .eq('ticker', t)
    .maybeSingle()

  if (data?.cik_padded) {
    cikMemCache.set(t, data.cik_padded)
    return data.cik_padded
  }

  // Fetch full CIK map from SEC (one request covers all companies)
  try {
    const res = await fetch(`${SEC_BASE}/files/company_tickers.json`, {
      headers: EDGAR_HEADERS,
    })
    if (!res.ok) return null

    const json = await res.json()

    // SEC returns an object keyed by index: { "0": { cik_str, ticker, title }, ... }
    const rows: Array<{ ticker: string; cik_padded: string; name: string }> = []
    for (const entry of Object.values(json) as any[]) {
      const cikPadded = `CIK${String(entry.cik_str).padStart(10, '0')}`
      rows.push({
        ticker: entry.ticker.toUpperCase(),
        cik_padded: cikPadded,
        name: entry.title,
      })
      cikMemCache.set(entry.ticker.toUpperCase(), cikPadded)
    }

    // Upsert entire map to DB in batches
    const batchSize = 500
    for (let i = 0; i < rows.length; i += batchSize) {
      await admin
        .from('edgar_cik_map')
        .upsert(
          rows.slice(i, i + batchSize).map(r => ({
            ticker: r.ticker,
            cik: r.cik_padded.replace('CIK', '').replace(/^0+/, ''),
            cik_padded: r.cik_padded,
            name: r.name,
            updated_at: new Date().toISOString(),
          })),
          { onConflict: 'ticker' }
        )
    }

    return cikMemCache.get(t) || null
  } catch (e) {
    console.error('[edgar] CIK fetch error:', e)
    return null
  }
}

// ── XBRL Fetcher ──────────────────────────────────────────────────────────────

interface XBRLFact {
  val: number
  end: string    // YYYY-MM-DD period end
  form: string   // 10-K, 10-Q etc
  filed: string  // YYYY-MM-DD filed date
  accn?: string  // accession number
  frame?: string
}

async function fetchCompanyFacts(cikPadded: string): Promise<any | null> {
  try {
    const res = await fetch(
      `${EDGAR_BASE}/api/xbrl/companyfacts/${cikPadded}.json`,
      { headers: EDGAR_HEADERS }
    )
    if (!res.ok) return null
    return await res.json()
  } catch (e) {
    console.error('[edgar] companyfacts error:', e)
    return null
  }
}

// Extract the most recent N quarters of annual/quarterly facts for a concept
function extractQuarterlyFacts(facts: any, concept: string, n = 8): XBRLFact[] {
  const usgaap = facts?.facts?.['us-gaap']
  if (!usgaap) return []

  const conceptData = usgaap[concept]
  if (!conceptData) return []

  // Try all unit types — EPS uses 'USD/shares', revenue uses 'USD', share counts use 'shares'
  const unitKeys = Object.keys(conceptData.units || {})
  let units: any[] = []
  for (const key of ['USD', 'USD/shares', 'shares', ...unitKeys]) {
    if (conceptData.units?.[key]?.length > 0) {
      units = conceptData.units[key]
      break
    }
  }

  return (units as XBRLFact[])
    .filter(f => f.form === '10-Q' || f.form === '10-K')
    .filter(f => f.end && f.val != null)
    .sort((a, b) => new Date(b.end).getTime() - new Date(a.end).getTime())
    .slice(0, n)
}

// Get TTM (trailing 12 months) by summing the 4 most recent quarters
function calcTTM(facts: XBRLFact[]): number | null {
  // Filter to quarterly (10-Q) filings only for TTM sum
  const quarterly = facts
    .filter(f => f.form === '10-Q')
    .slice(0, 4)

  if (quarterly.length < 4) {
    // Fall back to annual if we have it
    const annual = facts.find(f => f.form === '10-K')
    return annual ? annual.val : null
  }

  return quarterly.reduce((sum, f) => sum + f.val, 0)
}

// Get most recent point-in-time value (balance sheet items)
function getMostRecent(facts: XBRLFact[]): number | null {
  return facts.length > 0 ? facts[0].val : null
}

// Calculate YoY growth between TTM and prior year TTM
function calcYoY(facts: XBRLFact[]): number | null {
  const quarterly = facts.filter(f => f.form === '10-Q')

  // Best case: 8 quarters available — compare last 4 vs prior 4
  if (quarterly.length >= 8) {
    const ttmCurrent = quarterly.slice(0, 4).reduce((s, f) => s + f.val, 0)
    const ttmPrior   = quarterly.slice(4, 8).reduce((s, f) => s + f.val, 0)
    if (ttmPrior !== 0) return parseFloat(((ttmCurrent - ttmPrior) / Math.abs(ttmPrior) * 100).toFixed(1))
  }

  // Fallback: compare two annual 10-K filings
  const annuals = facts.filter(f => f.form === '10-K').sort((a, b) => new Date(b.end).getTime() - new Date(a.end).getTime())
  if (annuals.length >= 2 && annuals[1].val !== 0) {
    return parseFloat(((annuals[0].val - annuals[1].val) / Math.abs(annuals[1].val) * 100).toFixed(1))
  }

  return null
}

// Determine trend from sequential values
function calcTrend(values: (number | null)[]): 'accelerating' | 'decelerating' | 'stable' | 'negative' | null {
  const valid = values.filter(v => v !== null) as number[]
  if (valid.length < 2) return null

  const latest = valid[0]
  const prior = valid[1]

  if (latest < 0) return 'negative'
  if (prior === 0) return 'stable'

  const change = (latest - prior) / Math.abs(prior) * 100
  if (change > 5) return 'accelerating'
  if (change < -5) return 'decelerating'
  return 'stable'
}

// ── Main fetch function ───────────────────────────────────────────────────────

export async function fetchEdgarFundamentals(
  ticker: string
): Promise<EdgarFundamentals | null> {
  const t = ticker.toUpperCase()
  const admin = getAdmin()

  // 1. Check cache
  const { data: cached } = await admin
    .from('edgar_fundamentals')
    .select('*')
    .eq('ticker', t)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (cached) return cached as EdgarFundamentals

  // 2. Get CIK
  const cikPadded = await getCIK(t)
  if (!cikPadded) {
    console.warn(`[edgar] No CIK found for ${t}`)
    return null
  }

  // 3. Fetch XBRL facts
  const facts = await fetchCompanyFacts(cikPadded)
  if (!facts) return null

  const companyName = facts.entityName || null

  // 4. Extract key metrics
  const revenueFacts    = extractQuarterlyFacts(facts, 'Revenues')
  const altRevFacts     = extractQuarterlyFacts(facts, 'RevenueFromContractWithCustomerExcludingAssessedTax')
  const revFacts        = revenueFacts.length > 0 ? revenueFacts : altRevFacts

  const netIncomeFacts  = extractQuarterlyFacts(facts, 'NetIncomeLoss')
  const epsFacts        = extractQuarterlyFacts(facts, 'EarningsPerShareDiluted')
  const altEpsFacts     = epsFacts.length > 0 ? epsFacts : extractQuarterlyFacts(facts, 'EarningsPerShareBasic')
  const opIncomeFacts   = extractQuarterlyFacts(facts, 'OperatingIncomeLoss')
  const grossFacts      = extractQuarterlyFacts(facts, 'GrossProfit')
  const rdFacts         = extractQuarterlyFacts(facts, 'ResearchAndDevelopmentExpense')
  const cashFacts       = extractQuarterlyFacts(facts, 'CashAndCashEquivalentsAtCarryingValue')
  const debtFacts       = extractQuarterlyFacts(facts, 'LongTermDebt')
  const sharesFacts     = extractQuarterlyFacts(facts, 'CommonStockSharesOutstanding')
  const bookValueFacts  = extractQuarterlyFacts(facts, 'StockholdersEquity')

  // 5. Compute values
  const revenueTTM      = calcTTM(revFacts)
  const netIncomeTTM    = calcTTM(netIncomeFacts)
  // EPS is already per-share — sum the quarterly EPS values to get TTM EPS
  const epsFactsToUse   = altEpsFacts
  const epsTTM          = calcTTM(epsFactsToUse)  // sum of 4 quarterly EPS = TTM EPS
  const opIncomeTTM     = calcTTM(opIncomeFacts)
  const grossProfitTTM  = calcTTM(grossFacts)
  const rdTTM           = calcTTM(rdFacts)

  const cash            = getMostRecent(cashFacts)
  const totalDebt       = getMostRecent(debtFacts)
  const sharesOut       = getMostRecent(sharesFacts)
  const bookValue       = getMostRecent(bookValueFacts)
  const bookValuePS     = sharesOut && bookValue ? parseFloat((bookValue / sharesOut).toFixed(2)) : null

  const revenueYoY      = calcYoY(revFacts)
  const netIncomeYoY    = calcYoY(netIncomeFacts)
  const epsYoY          = calcYoY(epsFactsToUse)

  // Trends
  const epsValues       = epsFactsToUse.slice(0, 4).map(f => f.val)
  const earningsTrend   = calcTrend(epsValues)
  const debtValues      = debtFacts.slice(0, 3).map(f => f.val)
  const debtTrend       = debtValues.length >= 2
    ? (debtValues[0] > debtValues[1] * 1.05 ? 'increasing'
       : debtValues[0] < debtValues[1] * 0.95 ? 'decreasing' : 'stable')
    : null
  const cashValues      = cashFacts.slice(0, 3).map(f => f.val)
  const cashTrend       = cashValues.length >= 2
    ? (cashValues[0] > cashValues[1] * 1.05 ? 'building'
       : cashValues[0] < cashValues[1] * 0.95 ? 'depleting' : 'stable')
    : null

  // Filing metadata
  const latestFiling    = [...revFacts, ...netIncomeFacts]
    .sort((a, b) => new Date(b.filed).getTime() - new Date(a.filed).getTime())[0]

  const result: EdgarFundamentals = {
    ticker: t,
    cik: cikPadded,
    company_name: companyName,
    revenue_ttm: revenueTTM,
    net_income_ttm: netIncomeTTM,
    eps_diluted_ttm: epsTTM,
    operating_income_ttm: opIncomeTTM,
    gross_profit_ttm: grossProfitTTM,
    rd_expense_ttm: rdTTM,
    cash,
    total_debt: totalDebt,
    shares_outstanding: sharesOut,
    book_value_per_share: bookValuePS,
    revenue_yoy_pct: revenueYoY,
    net_income_yoy_pct: netIncomeYoY,
    eps_yoy_pct: epsYoY,
    earnings_trend: earningsTrend,
    debt_trend: debtTrend,
    cash_trend: cashTrend,
    last_filing_date: latestFiling?.filed || null,
    last_filing_type: latestFiling?.form || null,
    data_source: 'SEC EDGAR XBRL',
    fetched_at: new Date().toISOString(),
  }

  // 6. Cache result
  await admin
    .from('edgar_fundamentals')
    .upsert({
      ...result,
      expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: 'ticker' })

  return result
}

// ── Format for AI prompt ──────────────────────────────────────────────────────

export function formatEdgarForAI(data: EdgarFundamentals, currentPrice: number): string {
  const fmt = (n: number | null, prefix = '$', suffix = '') => {
    if (n === null || n === undefined) return 'N/A'
    const abs = Math.abs(n)
    const sign = n < 0 ? '-' : ''
    if (abs >= 1e9) return `${sign}${prefix}${(abs / 1e9).toFixed(1)}B${suffix}`
    if (abs >= 1e6) return `${sign}${prefix}${(abs / 1e6).toFixed(0)}M${suffix}`
    return `${sign}${prefix}${abs.toFixed(2)}${suffix}`
  }

  const pct = (n: number | null) => n !== null ? `${n > 0 ? '+' : ''}${n}%` : 'N/A'

  // Compute PE ratio
  const pe = data.eps_diluted_ttm && data.eps_diluted_ttm > 0
    ? (currentPrice / data.eps_diluted_ttm).toFixed(1)
    : 'N/A'

  // Profit margin
  const margin = data.revenue_ttm && data.net_income_ttm
    ? `${((data.net_income_ttm / data.revenue_ttm) * 100).toFixed(1)}%`
    : 'N/A'

  const lines = [
    `=== VERIFIED FUNDAMENTALS (Source: ${data.data_source}, filed ${data.last_filing_date || 'N/A'}) ===`,
    `Company: ${data.company_name || data.ticker} | Last filing: ${data.last_filing_type || 'N/A'}`,
    '',
    'INCOME (Trailing 12 Months):',
    `  Revenue TTM:         ${fmt(data.revenue_ttm)} | YoY: ${pct(data.revenue_yoy_pct)}`,
    `  Gross Profit TTM:    ${fmt(data.gross_profit_ttm)}`,
    `  Operating Income:    ${fmt(data.operating_income_ttm)}`,
    `  Net Income TTM:      ${fmt(data.net_income_ttm)} | YoY: ${pct(data.net_income_yoy_pct)} | Margin: ${margin}`,
    `  EPS Diluted TTM:     ${data.eps_diluted_ttm?.toFixed(2) ?? 'N/A'} | YoY: ${pct(data.eps_yoy_pct)} | P/E: ${pe}x`,
    `  R&D Spend TTM:       ${fmt(data.rd_expense_ttm)}`,
    '',
    'BALANCE SHEET (Latest Quarter):',
    `  Cash & Equivalents:  ${fmt(data.cash)} | Trend: ${data.cash_trend || 'N/A'}`,
    `  Long-term Debt:      ${fmt(data.total_debt)} | Trend: ${data.debt_trend || 'N/A'}`,
    `  Shares Outstanding:  ${fmt(data.shares_outstanding, '', '')}`,
    `  Book Value/Share:    ${data.book_value_per_share ? '$' + data.book_value_per_share : 'N/A'}`,
    '',
    'EARNINGS QUALITY:',
    `  Earnings trend:      ${data.earnings_trend || 'N/A'}`,
    `  Data verified from:  SEC EDGAR 10-Q/10-K XBRL filing`,
  ]

  return lines.join('\n')
}

// ── Background refresh ────────────────────────────────────────────────────────

// Called by nightly cron — refreshes expiring cache entries
export async function refreshExpiringEdgarCache(): Promise<{ refreshed: number; failed: number }> {
  const admin = getAdmin()
  const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // expiring in 7 days

  const { data: expiring } = await admin
    .from('edgar_fundamentals')
    .select('ticker')
    .lt('expires_at', soon)
    .order('fetched_at', { ascending: true })
    .limit(20) // batch of 20 per cron run to stay under rate limits

  let refreshed = 0
  let failed = 0

  for (const row of expiring || []) {
    // Delete cache entry to force fresh fetch
    await admin.from('edgar_fundamentals').delete().eq('ticker', row.ticker)

    const result = await fetchEdgarFundamentals(row.ticker).catch(() => null)
    if (result) refreshed++
    else failed++

    // 200ms delay between requests to stay well under 10 req/s
    await new Promise(r => setTimeout(r, 200))
  }

  return { refreshed, failed }
}
