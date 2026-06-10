// ═════════════════════════════════════════════════════════════
// app/lib/data/forex-cot.ts
//
// CFTC Commitments of Traders (COT) data for currency futures.
//
// Replaces the empty "No 13F holder data available" stub that was
// landing in the forex smart-money block — equity-shaped positioning
// data was always going to be empty for currency pairs.
//
// Data source: CFTC public reporting API (Socrata, no auth required)
//   - Legacy Futures Only report: dataset 6dca-aqww
//   - Updates weekly, Friday ~3:30 PM ET (Tuesday's positions)
//   - Public, free, no API key
//
// Cache: in-memory, ~24h TTL. COT only updates once weekly so this
// is plenty fresh. Resets on Railway restart but per-pair refetch is
// <1s so the cold-start hit is negligible.
//
// Mapping: each currency code in a forex pair maps to a CFTC contract
// name. For pair "EURUSD", we fetch the EUR contract (USD is the
// implicit counter, not separately reported). For "USDJPY" we fetch
// the JPY contract and note USD is the inverse leg.
// ═════════════════════════════════════════════════════════════

const CFTC_LEGACY_FUTURES_URL = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json'

// Currency code → CFTC contract_market_name. Names match the
// "contract_market_name" field exactly as returned by the API.
// Cross-checked against actual COT reports (https://www.cftc.gov/MarketReports/CommitmentsofTraders).
const CURRENCY_TO_CFTC_CONTRACT: Record<string, string> = {
  EUR: 'EURO FX',
  JPY: 'JAPANESE YEN',
  GBP: 'BRITISH POUND',
  AUD: 'AUSTRALIAN DOLLAR',
  CAD: 'CANADIAN DOLLAR',
  CHF: 'SWISS FRANC',
  NZD: 'NEW ZEALAND DOLLAR',
  MXN: 'MEXICAN PESO',
  // USD has no standalone CFTC currency-future contract. It's the
  // implicit other side of every pair above. When we fetch the EUR
  // contract for EURUSD, longs in EUR are inherently shorts in USD.
}

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface CotPosition {
  // Most recent week
  reportDate: string                   // YYYY-MM-DD
  contractName: string                 // e.g. "EURO FX"
  nonCommLong: number                  // speculative longs
  nonCommShort: number                 // speculative shorts
  nonCommNet: number                   // longs - shorts
  commLong: number                     // commercial longs (hedgers)
  commShort: number                    // commercial shorts
  commNet: number                      // longs - shorts
  openInterest: number                 // total open interest
  // Week-over-week change in net speculative positioning
  nonCommNetChangeWoW: number | null   // null if no prior data
  // Net speculative as % of OI (sentiment intensity)
  nonCommNetPctOfOI: number            // e.g. +12.5 means specs are +12.5% net long
}

// Raw Socrata row shape
interface CotRow {
  report_date_as_yyyy_mm_dd?: string
  contract_market_name?: string
  noncomm_positions_long_all?: string
  noncomm_positions_short_all?: string
  comm_positions_long_all?: string
  comm_positions_short_all?: string
  open_interest_all?: string
}

// ─────────────────────────────────────────────────────────────
// In-memory cache (24h TTL — COT updates weekly so this is plenty)
// ─────────────────────────────────────────────────────────────

interface CacheEntry {
  data: CotPosition | null
  expiresAt: number
}
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h

function cacheGet(key: string): CotPosition | null | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    return undefined
  }
  return entry.data
}

function cacheSet(key: string, data: CotPosition | null): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ─────────────────────────────────────────────────────────────
// Forex ticker parsing
// ─────────────────────────────────────────────────────────────

/**
 * Parse a forex ticker into base and quote currencies.
 * "EURUSD" → { base: "EUR", quote: "USD" }
 * "USDJPY" → { base: "USD", quote: "JPY" }
 * Returns null for non-standard symbols.
 */
export function parseForexPair(ticker: string): { base: string; quote: string } | null {
  const t = ticker.toUpperCase().replace(/[^A-Z]/g, '')
  if (t.length !== 6) return null
  return { base: t.slice(0, 3), quote: t.slice(3, 6) }
}

/**
 * Which currency in the pair has a CFTC futures contract?
 * For EURUSD we fetch EUR (USD has no standalone contract).
 * For USDJPY we fetch JPY.
 * For EURJPY we fetch EUR (closer to a pure euro signal than JPY-inverse).
 * Returns null if neither currency has a CFTC contract.
 */
function pickCftcCurrency(base: string, quote: string): { currency: string; inverse: boolean } | null {
  // Prefer the non-USD side first (more interesting positioning)
  if (base !== 'USD' && CURRENCY_TO_CFTC_CONTRACT[base]) {
    return { currency: base, inverse: false }
  }
  if (quote !== 'USD' && CURRENCY_TO_CFTC_CONTRACT[quote]) {
    return { currency: quote, inverse: true }  // pair is XXX/QUOTE, COT is on QUOTE — invert
  }
  // Fallback: try base, then quote, regardless of USD
  if (CURRENCY_TO_CFTC_CONTRACT[base]) return { currency: base, inverse: false }
  if (CURRENCY_TO_CFTC_CONTRACT[quote]) return { currency: quote, inverse: true }
  return null
}

// ─────────────────────────────────────────────────────────────
// CFTC fetch
// ─────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, timeoutMs = 6000): Promise<Response | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Wali-OS forex analysis (alerts@wali-os.com)' },
    })
    clearTimeout(t)
    return res
  } catch {
    return null
  }
}

/**
 * Fetch the most recent two weekly COT reports for a CFTC contract,
 * compute week-over-week change.
 */
async function fetchCotForContract(contractName: string): Promise<CotPosition | null> {
  // Socrata SoQL: filter by contract name, sort newest first, take 2 weeks
  // to compute WoW delta. Names contain spaces; encode as %20 or '+' both work.
  const where = encodeURIComponent(`contract_market_name='${contractName}'`)
  const url = `${CFTC_LEGACY_FUTURES_URL}?$where=${where}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=2`

  const res = await fetchWithTimeout(url, 6000)
  if (!res || !res.ok) {
    if (res) {
      console.warn(`[forex-cot] CFTC returned ${res.status} for ${contractName}`)
    }
    return null
  }

  let rows: CotRow[]
  try {
    rows = await res.json() as CotRow[]
  } catch {
    return null
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    console.warn(`[forex-cot] CFTC returned 0 rows for ${contractName}`)
    return null
  }

  const latest = rows[0]
  const prior = rows.length > 1 ? rows[1] : null

  const num = (v: string | undefined): number => {
    const n = parseInt(v ?? '0', 10)
    return Number.isFinite(n) ? n : 0
  }

  const ncLong = num(latest.noncomm_positions_long_all)
  const ncShort = num(latest.noncomm_positions_short_all)
  const ncNet = ncLong - ncShort
  const cLong = num(latest.comm_positions_long_all)
  const cShort = num(latest.comm_positions_short_all)
  const cNet = cLong - cShort
  const oi = num(latest.open_interest_all)

  let ncNetChangeWoW: number | null = null
  if (prior) {
    const priorNcLong = num(prior.noncomm_positions_long_all)
    const priorNcShort = num(prior.noncomm_positions_short_all)
    ncNetChangeWoW = ncNet - (priorNcLong - priorNcShort)
  }

  const reportDate = (latest.report_date_as_yyyy_mm_dd ?? '').split('T')[0] || ''

  return {
    reportDate,
    contractName: latest.contract_market_name ?? contractName,
    nonCommLong: ncLong,
    nonCommShort: ncShort,
    nonCommNet: ncNet,
    commLong: cLong,
    commShort: cShort,
    commNet: cNet,
    openInterest: oi,
    nonCommNetChangeWoW: ncNetChangeWoW,
    nonCommNetPctOfOI: oi > 0 ? parseFloat(((ncNet / oi) * 100).toFixed(2)) : 0,
  }
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Fetch COT positioning for a forex pair. Returns null if the pair
 * doesn't have a tracked CFTC contract or if the fetch fails.
 *
 * @param ticker  forex pair symbol (e.g. "EURUSD")
 */
export async function fetchForexCot(ticker: string): Promise<CotPosition | null> {
  const parsed = parseForexPair(ticker)
  if (!parsed) return null
  const pick = pickCftcCurrency(parsed.base, parsed.quote)
  if (!pick) return null

  const contractName = CURRENCY_TO_CFTC_CONTRACT[pick.currency]
  const cacheKey = `${contractName}|${pick.inverse}`
  const cached = cacheGet(cacheKey)
  if (cached !== undefined) return cached

  const data = await fetchCotForContract(contractName)
  if (!data) {
    cacheSet(cacheKey, null)
    return null
  }

  // If we fetched the quote currency (e.g. JPY for USDJPY), the positioning
  // signal is inverted relative to the pair: net long JPY = net short USDJPY.
  // We don't mutate the numbers; we just record inverse so the formatter
  // can describe it correctly.
  cacheSet(cacheKey, data)
  return data
}

/**
 * Format COT positioning as a smart-money summary block for the bundle.
 * If no data is available, returns an honest "not available" string
 * (much better than equity-shaped "No 13F data" emptiness).
 */
export async function buildForexSmartMoneyContext(ticker: string): Promise<string> {
  const parsed = parseForexPair(ticker)
  if (!parsed) {
    return `=== SMART MONEY (FOREX) ===
Forex pair format not recognized — positioning data unavailable.
Focus on central bank policy signals, economic data releases, and technical structure.`
  }

  const pick = pickCftcCurrency(parsed.base, parsed.quote)
  if (!pick) {
    return `=== SMART MONEY (FOREX) ===
No CFTC-tracked futures contract for ${ticker} — positioning data unavailable for this pair.
Focus on central bank policy signals, economic data releases, and technical structure.`
  }

  const cot = await fetchForexCot(ticker).catch(() => null)
  if (!cot) {
    return `=== SMART MONEY (FOREX) ===
CFTC COT data fetch failed for ${pick.currency} (network/timeout).
Focus on central bank policy signals, economic data releases, and technical structure.`
  }

  // Interpret the data. nonCommNetPctOfOI tells us sentiment intensity:
  //   > +20%: strong net long (specs piled in)
  //   +5 to +20: moderate long
  //   -5 to +5: neutral
  //   -20 to -5: moderate short
  //   < -20%: strong net short
  const pct = cot.nonCommNetPctOfOI
  const intensity =
    pct > 20  ? 'STRONG NET LONG'  :
    pct > 5   ? 'Moderate net long' :
    pct > -5  ? 'Roughly neutral'  :
    pct > -20 ? 'Moderate net short' :
                'STRONG NET SHORT'

  // WoW change interpretation
  let wowLine = ''
  if (cot.nonCommNetChangeWoW !== null) {
    const wow = cot.nonCommNetChangeWoW
    const direction = wow > 0 ? 'added longs' : 'added shorts'
    const magnitude = Math.abs(wow) > 5000 ? 'significantly' :
                      Math.abs(wow) > 1000 ? 'moderately' : 'modestly'
    wowLine = `Week-over-week shift: ${magnitude} ${direction} (${wow > 0 ? '+' : ''}${wow.toLocaleString()} contracts).`
  }

  // Inverse handling: if we fetched the quote currency, flip the framing
  const pairFraming = pick.inverse
    ? `Note: positioning is on the ${pick.currency} contract (quote side of ${ticker}). Net long ${pick.currency} = net SHORT ${ticker}, and vice versa.`
    : `Positioning is on the ${pick.currency} contract (base side of ${ticker}). Net long ${pick.currency} = net long ${ticker}.`

  return `=== SMART MONEY (FOREX) — CFTC COT POSITIONING ===
Source: CFTC Commitments of Traders (Legacy Futures Only), report dated ${cot.reportDate}
Contract: ${cot.contractName}
${pairFraming}

NON-COMMERCIAL (speculative — hedge funds, CTAs, large specs):
  Long: ${cot.nonCommLong.toLocaleString()} contracts
  Short: ${cot.nonCommShort.toLocaleString()} contracts
  Net: ${cot.nonCommNet > 0 ? '+' : ''}${cot.nonCommNet.toLocaleString()} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}% of OI) — ${intensity}
${wowLine ? '  ' + wowLine : ''}

COMMERCIAL (hedgers — corporates, banks):
  Long: ${cot.commLong.toLocaleString()} contracts
  Short: ${cot.commShort.toLocaleString()} contracts
  Net: ${cot.commNet > 0 ? '+' : ''}${cot.commNet.toLocaleString()}

TOTAL OPEN INTEREST: ${cot.openInterest.toLocaleString()} contracts

Caveats: COT is weekly (Tuesday positions, released Friday). Data may be 1-5 days stale.
DO NOT cite 13F filings, insider transactions, or stock-style institutional ownership — those don't exist for currency futures.`
}
