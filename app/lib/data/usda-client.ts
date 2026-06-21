// =============================================================
// app/lib/data/usda-client.ts (Layer 7)
//
// USDA NASS Quick Stats API client.
//
// API: https://quickstats.nass.usda.gov/api/api_GET/
// Auth: query param `key=API_KEY`
// Free tier: 50,000 records per call, no documented daily limit
//
// Key data series we use:
//   - Crop progress: planting/emergence/silking/harvest percentages
//   - Crop condition: % good/excellent vs poor/very poor
//
// Note: These are weekly during growing season (April-November).
// Out of season the most recent report is from last fall.
// =============================================================

const NASS_BASE = 'https://quickstats.nass.usda.gov/api/api_GET'
const REQUEST_TIMEOUT_MS = 12_000

// 24h cache — USDA reports release weekly
const cache = new Map<string, { fetchedAt: number; data: NassRecord[] }>()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface NassRecord {
  commodity_desc: string
  state_alpha: string         // 'US' for national rows, 2-letter state for state rows
  state_name: string
  year: string
  week_ending: string         // YYYY-MM-DD or empty
  reference_period_desc: string  // "WEEK #N" or "YEAR" etc.
  short_desc: string          // human-readable description, e.g. "CORN - PROGRESS, MEASURED IN PCT SILKING"
  unit_desc: string           // e.g. "PCT EXCELLENT", "PCT GOOD", "PCT FAIR", "PCT POOR", "PCT VERY POOR"
  Value: string               // numeric value as string (e.g. "67" for 67%)
  load_time: string
  agg_level_desc?: string     // 'NATIONAL' | 'STATE' | etc.
}

interface NassApiResponse {
  data?: NassRecord[]
  error?: string | string[]
}

interface NassQueryParams {
  commodity_desc: string         // 'CORN' | 'WHEAT' | 'SOYBEANS'
  statisticcat_desc?: string     // 'PROGRESS' | 'CONDITION' | 'YIELD'
  state_alpha?: string           // 'IA', 'IL', 'KS', etc.
  year__GE?: string              // '2026' to get 2026 onwards
  year__LE?: string              // '2025' to get up to and including 2025
  year?: string                  // exact year (e.g. '2026')
  short_desc__LIKE?: string      // wildcard match on short_desc
}

/**
 * Fetch records from the USDA NASS Quick Stats API.
 * Returns up to `maxRecords` records, newest first by load_time.
 */
export async function fetchNassRecords(params: NassQueryParams, maxRecords = 100): Promise<NassRecord[] | null> {
  const apiKey = process.env.USDA_API_KEY
  if (!apiKey) {
    console.warn('[usda-client] USDA_API_KEY not set; skipping fetch')
    return null
  }

  const queryParts: string[] = [`key=${apiKey}`, 'format=JSON']
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') {
      queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    }
  }
  const url = `${NASS_BASE}?${queryParts.join('&')}`

  const cacheKey = url.replace(apiKey, 'KEY')  // don't include API key in cache key text
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data.slice(0, maxRecords)
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal })
    if (!res.ok) {
      console.warn(`[usda-client] HTTP ${res.status} for query ${JSON.stringify(params)}`)
      return null
    }
    const json = (await res.json()) as NassApiResponse
    if (json.error) {
      const errStr = Array.isArray(json.error) ? json.error.join('; ') : json.error
      console.warn(`[usda-client] API error: ${errStr}`)
      return null
    }
    const rows = json.data ?? []
    if (rows.length === 0) {
      console.warn(`[usda-client] 0 rows for query ${JSON.stringify(params)}`)
      return null
    }
    cache.set(cacheKey, { fetchedAt: Date.now(), data: rows })
    return rows.slice(0, maxRecords)
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      console.warn(`[usda-client] timeout for query ${JSON.stringify(params)}`)
    } else {
      console.warn(`[usda-client] error:`, e instanceof Error ? e.message : e)
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Health check.
 */
export async function checkUsdaHealth(): Promise<{ ok: boolean; error?: string; sample?: { commodity: string; year: string; weekEnding: string; value: string } }> {
  if (!process.env.USDA_API_KEY) {
    return { ok: false, error: 'USDA_API_KEY not configured' }
  }
  // Fetch current-year corn progress and pick the most recent week
  // (the API's default order is by load_time, not week_ending,
  // so we have to sort client-side to find the latest report).
  const result = await fetchNassRecords({
    commodity_desc: 'CORN',
    statisticcat_desc: 'PROGRESS',
    year: String(new Date().getFullYear()),
  }, 1000)
  if (!result || result.length === 0) {
    return { ok: false, error: 'USDA fetch returned no data for current year (key valid but no data — could be early in season)' }
  }
  // Pick the row with the most recent week_ending AND a nonzero value
  // AND that's a national/US-total row (state_alpha='US' or agg_level_desc='NATIONAL').
  // Without the national filter, the sample can come from any state and not represent
  // the actual headline crop progress.
  const meaningful = result
    .filter(r => r.agg_level_desc === 'NATIONAL' || r.state_alpha === 'US')
    .filter(r => {
      const v = parseInt(r.Value, 10)
      return Number.isFinite(v) && v > 0
    })
    .sort((a, b) => (b.week_ending || '').localeCompare(a.week_ending || ''))
  const sample = meaningful[0] ?? result[0]
  return {
    ok: true,
    sample: {
      commodity: sample.commodity_desc,
      year: sample.year,
      weekEnding: sample.week_ending,
      value: sample.Value,
    },
  }
}

// ─────────────────────────────────────────────────────────────
// Commodity + state mappings for futures roots
// ─────────────────────────────────────────────────────────────

/**
 * Major growing states by commodity. The Council prompt cites these.
 */
export const GRAIN_GROWING_STATES = {
  CORN:     ['IA', 'IL', 'IN', 'NE', 'MN'],          // top 5
  SOYBEANS: ['IA', 'IL', 'IN', 'OH', 'MN'],          // top 5
  WHEAT_SRW: ['IL', 'OH', 'MO', 'IN', 'MI'],         // soft red winter (ZW)
  WHEAT_HRW: ['KS', 'OK', 'TX', 'CO', 'NE'],         // hard red winter (KE)
} as const

/**
 * Map futures root → NASS commodity_desc
 */
export function nassCommodityForRoot(root: string): { commodity: string; states: readonly string[] } | null {
  switch (root) {
    case 'ZC': return { commodity: 'CORN',     states: GRAIN_GROWING_STATES.CORN }
    case 'ZS': return { commodity: 'SOYBEANS', states: GRAIN_GROWING_STATES.SOYBEANS }
    case 'ZW': return { commodity: 'WHEAT',    states: GRAIN_GROWING_STATES.WHEAT_SRW }
    case 'KE': return { commodity: 'WHEAT',    states: GRAIN_GROWING_STATES.WHEAT_HRW }
    // ZM (soymeal) and ZL (soyoil) inherit from soybeans
    case 'ZM': return { commodity: 'SOYBEANS', states: GRAIN_GROWING_STATES.SOYBEANS }
    case 'ZL': return { commodity: 'SOYBEANS', states: GRAIN_GROWING_STATES.SOYBEANS }
    default:   return null
  }
}
