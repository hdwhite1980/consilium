// =============================================================
// app/lib/data/sector-context.ts
//
// Computes sector + peer context for the Council.
//
// Surfaces:
//   - Sector ETF performance (1D, 5D)
//   - Top 3 peer performances (1D)
//   - Single-name divergence detection (ticker moves opposite to
//     sector by >2% on the day)
//
// Caching strategy (hybrid):
//   - First lookup: query Finnhub /stock/peers + /stock/profile2,
//     store in ticker_sector_peers table
//   - Subsequent lookups within 30 days: hit cache, skip Finnhub
//   - Stale entries (>30d): re-fetch lazily on next analysis
//   - Unknown tickers (crypto, OTC, delisted): tombstoned with
//     not_found=true to avoid retry storms
//
// Performance bars come from Alpaca SIP feed (already used elsewhere).
// =============================================================

import { createClient } from '@supabase/supabase-js'
import { fetchMultiBars } from './alpaca'

const FINNHUB_BASE = 'https://finnhub.io/api/v1'
const CACHE_DAYS = 30
const PEER_COUNT = 5

// =============================================================
// Sector -> Sector ETF mapping
// =============================================================
//
// Finnhub returns a `finnhubIndustry` string. We map it to the
// dominant SPDR sector ETF for relative-performance comparison.
//
// Mapping is intentionally simple and stable. When in doubt,
// fall through to SPY (broad market).

const SECTOR_TO_ETF: Record<string, string> = {
  // Technology
  'Technology': 'XLK',
  'Software': 'XLK',
  'Hardware': 'XLK',
  'Semiconductors': 'SOXX',
  'IT Services': 'XLK',
  'Communication Services': 'XLC',
  'Media': 'XLC',
  'Telecommunications Services': 'XLC',
  'Telecommunication': 'XLC',

  // Financial
  'Financial Services': 'XLF',
  'Banking': 'XLF',
  'Insurance': 'XLF',
  'Capital Markets': 'XLF',
  'Diversified Financials': 'XLF',
  'Real Estate': 'XLRE',
  'REIT': 'XLRE',

  // Energy / Materials / Industrials
  'Energy': 'XLE',
  'Oil & Gas': 'XLE',
  'Materials': 'XLB',
  'Chemicals': 'XLB',
  'Metals & Mining': 'XLB',
  'Industrials': 'XLI',
  'Aerospace & Defense': 'ITA',
  'Transportation': 'XTN',
  'Airlines': 'XTN',

  // Consumer
  'Consumer Discretionary': 'XLY',
  'Retail': 'XLY',
  'Automobiles': 'XLY',
  'Hotels Restaurants & Leisure': 'XLY',
  'Consumer Staples': 'XLP',
  'Food Beverage & Tobacco': 'XLP',
  'Household Products': 'XLP',

  // Healthcare
  'Health Care': 'XLV',
  'Healthcare': 'XLV',
  'Pharmaceuticals': 'XLV',
  'Biotechnology': 'IBB',
  'Medical Devices': 'XLV',

  // Utilities
  'Utilities': 'XLU',
}

function sectorToETF(industry: string | null | undefined): string | null {
  if (!industry) return null
  // Try exact match first
  if (industry in SECTOR_TO_ETF) return SECTOR_TO_ETF[industry]
  // Try partial match (Finnhub uses inconsistent capitalization/wording)
  const lower = industry.toLowerCase()
  for (const [key, etf] of Object.entries(SECTOR_TO_ETF)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return etf
    }
  }
  return null  // Falls through; helper will return empty string
}

// =============================================================
// Types
// =============================================================

export interface SectorContext {
  ticker: string

  /** Sector classification ("Semiconductors", "Banking", etc.) */
  sector: string | null

  /** Sector ETF symbol (SOXX, XLK, XLF, etc.) */
  sectorETF: string | null

  /** Sector ETF 1-day % change */
  sectorChange1D: number | null

  /** Sector ETF 5-day % change */
  sectorChange5D: number | null

  /** Top peer tickers and their 1-day % change */
  peers: Array<{ ticker: string; change1D: number | null }>

  /** Ticker's own 1-day % change (for divergence detection) */
  tickerChange1D: number | null

  /** True if ticker moves opposite to sector by >2% (single-name divergence) */
  divergent: boolean

  /** Plain-text context for prompt injection. Empty if no usable data. */
  promptContext: string
}

interface FinnhubProfile {
  finnhubIndustry?: string
  ticker?: string
  name?: string
}

// =============================================================
// Supabase client (server-only, service role)
// =============================================================

let _supabase: ReturnType<typeof createClient> | null = null
function getSupabase() {
  if (_supabase) return _supabase
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not configured')
  _supabase = createClient(url, key, { auth: { persistSession: false } })
  return _supabase
}

// =============================================================
// Finnhub fetchers
// =============================================================

async function fetchFinnhubPeers(ticker: string): Promise<string[]> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return []
  try {
    const res = await fetch(
      `${FINNHUB_BASE}/stock/peers?symbol=${ticker}&token=${key}`,
      { next: { revalidate: 86400 } },
    )
    if (!res.ok) return []
    const peers = (await res.json()) as string[]
    if (!Array.isArray(peers)) return []
    // Filter out self + non-equities, return top N
    return peers
      .filter(p => typeof p === 'string' && p !== ticker && /^[A-Z.\-]{1,8}$/.test(p))
      .slice(0, PEER_COUNT * 2)  // grab extra so we can drop nulls later
  } catch {
    return []
  }
}

async function fetchFinnhubProfile(ticker: string): Promise<FinnhubProfile | null> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return null
  try {
    const res = await fetch(
      `${FINNHUB_BASE}/stock/profile2?symbol=${ticker}&token=${key}`,
      { next: { revalidate: 86400 } },
    )
    if (!res.ok) return null
    const data = (await res.json()) as FinnhubProfile
    return data && Object.keys(data).length > 0 ? data : null
  } catch {
    return null
  }
}

// =============================================================
// Cache layer
// =============================================================

interface CacheRow {
  ticker: string
  sector: string | null
  industry: string | null
  sector_etf: string | null
  peers: string[]
  fetched_at: string
  not_found: boolean
}

async function getCachedClassification(ticker: string): Promise<CacheRow | null> {
  try {
    const sb = getSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (sb as any)
      .from('ticker_sector_peers')
      .select('*')
      .eq('ticker', ticker)
      .maybeSingle()
    if (error || !data) return null
    return data as CacheRow
  } catch {
    return null
  }
}

async function upsertClassification(
  ticker: string,
  sector: string | null,
  industry: string | null,
  sectorETF: string | null,
  peers: string[],
  notFound: boolean,
): Promise<void> {
  try {
    const sb = getSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sb as any).from('ticker_sector_peers').upsert({
      ticker,
      sector,
      industry,
      sector_etf: sectorETF,
      peers,
      fetched_at: new Date().toISOString(),
      not_found: notFound,
    })
  } catch {
    // Cache write failures are non-fatal — we just won't cache this turn.
  }
}

function isCacheStale(fetchedAt: string): boolean {
  const fetchedMs = new Date(fetchedAt).getTime()
  const ageDays = (Date.now() - fetchedMs) / 86400000
  return ageDays > CACHE_DAYS
}

// =============================================================
// Resolver: cache OR fetch
// =============================================================

async function resolveClassification(ticker: string): Promise<CacheRow | null> {
  const cached = await getCachedClassification(ticker)

  // Cache hit, fresh, and we already know the answer (positive or negative)
  if (cached && !isCacheStale(cached.fetched_at)) {
    return cached
  }

  // Cache miss or stale — fetch from Finnhub in parallel
  const [profile, peers] = await Promise.all([
    fetchFinnhubProfile(ticker),
    fetchFinnhubPeers(ticker),
  ])

  // No data → tombstone so we don't refetch every analysis
  if (!profile && peers.length === 0) {
    await upsertClassification(ticker, null, null, null, [], true)
    return cached  // return stale data if we have it, else null
  }

  const industry = profile?.finnhubIndustry ?? null
  const sectorETF = sectorToETF(industry)

  await upsertClassification(ticker, industry, industry, sectorETF, peers, false)

  return {
    ticker,
    sector: industry,
    industry,
    sector_etf: sectorETF,
    peers,
    fetched_at: new Date().toISOString(),
    not_found: false,
  }
}

// =============================================================
// Performance computation
// =============================================================

interface BarLite {
  c: number
  o: number
}

function computePctChange(bars: BarLite[] | undefined, lookback: number): number | null {
  if (!bars || bars.length < lookback + 1) return null
  const last = bars[bars.length - 1].c
  const prior = bars[bars.length - 1 - lookback].c
  if (!prior || prior === 0) return null
  return ((last - prior) / prior) * 100
}

// =============================================================
// Main
// =============================================================

export async function getSectorContext(ticker: string): Promise<SectorContext> {
  const empty: SectorContext = {
    ticker,
    sector: null,
    sectorETF: null,
    sectorChange1D: null,
    sectorChange5D: null,
    peers: [],
    tickerChange1D: null,
    divergent: false,
    promptContext: '',
  }

  const classification = await resolveClassification(ticker)
  if (!classification || classification.not_found) {
    return empty
  }

  const sectorETF = classification.sector_etf
  const peerList = (classification.peers ?? []).slice(0, PEER_COUNT)

  // Fetch performance bars: ticker, sector ETF, peers
  // Use 1W timeframe = 1Hour bars for last 90 days, plenty for 1D and 5D
  const symbolsToFetch: string[] = [ticker]
  if (sectorETF) symbolsToFetch.push(sectorETF)
  symbolsToFetch.push(...peerList)

  let multiBars: Record<string, BarLite[]> = {}
  try {
    // Use 1M timeframe (= daily bars) for clean day-over-day comparison
    multiBars = await fetchMultiBars(symbolsToFetch, '1M') as Record<string, BarLite[]>
  } catch {
    return empty
  }

  // Compute changes
  const tickerChange1D = computePctChange(multiBars[ticker], 1)
  const sectorChange1D = sectorETF ? computePctChange(multiBars[sectorETF], 1) : null
  const sectorChange5D = sectorETF ? computePctChange(multiBars[sectorETF], 5) : null

  const peerChanges = peerList.map(p => ({
    ticker: p,
    change1D: computePctChange(multiBars[p], 1),
  }))

  // Divergence: ticker moves opposite to sector by >2%
  const divergent = (
    sectorChange1D !== null &&
    tickerChange1D !== null &&
    Math.sign(sectorChange1D) !== Math.sign(tickerChange1D) &&
    Math.abs(tickerChange1D - sectorChange1D) > 2.0
  )

  const promptContext = buildPromptContext(
    classification.sector,
    sectorETF,
    sectorChange1D,
    sectorChange5D,
    peerChanges,
    tickerChange1D,
    divergent,
  )

  return {
    ticker,
    sector: classification.sector,
    sectorETF,
    sectorChange1D,
    sectorChange5D,
    peers: peerChanges,
    tickerChange1D,
    divergent,
    promptContext,
  }
}

// =============================================================
// Prompt formatter
// =============================================================

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'n/a'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function buildPromptContext(
  sector: string | null,
  sectorETF: string | null,
  sectorChange1D: number | null,
  sectorChange5D: number | null,
  peers: Array<{ ticker: string; change1D: number | null }>,
  tickerChange1D: number | null,
  divergent: boolean,
): string {
  // No data to surface
  if (!sectorETF && peers.length === 0) return ''

  const parts: string[] = []

  if (sector && sectorETF) {
    parts.push(`Sector: ${sector} (proxy: ${sectorETF} ${fmtPct(sectorChange1D)} 1D, ${fmtPct(sectorChange5D)} 5D).`)
  }

  if (peers.length > 0) {
    const peerStr = peers
      .filter(p => p.change1D !== null)
      .map(p => `${p.ticker} ${fmtPct(p.change1D)}`)
      .join(', ')
    if (peerStr) {
      parts.push(`Peers: ${peerStr}.`)
    }
  }

  // Divergence call-out (most actionable signal)
  if (divergent && sectorChange1D !== null && tickerChange1D !== null) {
    if (tickerChange1D > sectorChange1D) {
      parts.push(`SINGLE-NAME DIVERGENCE: ticker outperforming sector by ${(tickerChange1D - sectorChange1D).toFixed(2)}pp \u2014 the move is name-specific, not sector-driven. Consider what stock-specific catalyst is in play.`)
    } else {
      parts.push(`SINGLE-NAME DIVERGENCE: ticker underperforming sector by ${(sectorChange1D - tickerChange1D).toFixed(2)}pp \u2014 the move is name-specific, not sector-driven. Consider what stock-specific risk is in play.`)
    }
  } else if (sectorChange1D !== null && Math.abs(sectorChange1D) > 1.5) {
    parts.push(`Sector context: ticker is moving with broader sector (sector ${sectorChange1D > 0 ? 'rallying' : 'selling off'}). Verdict should account for whether the sector trend is sustainable.`)
  }

  if (parts.length === 0) return ''
  return `\n\nSECTOR CONTEXT:\n${parts.join(' ')}`
}
