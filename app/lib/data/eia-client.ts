// =============================================================
// app/lib/data/eia-client.ts (Layer 6)
//
// EIA API v2 client. Uses the legacy series-id translation
// endpoint (/v2/seriesid/{SERIES_ID}) for stable backwards
// compatibility with the well-documented v1 series IDs.
//
// API key from env: EIA_API_KEY
// Base URL: https://api.eia.gov/v2
//
// Notes:
//   - As of v2.1.6 (Jan 2024), data values are returned as STRINGS.
//     Always coerce with Number() before arithmetic.
//   - EIA throttles per-second + per-hour. We cache aggressively
//     (24h) since the underlying weekly data only updates Wed/Thu.
//   - Series we use:
//       PET.WCESTUS1.W  — Weekly U.S. Crude Oil Stocks (excl. SPR), kbbl
//       PET.WCSSTUS1.W  — Weekly U.S. Crude Oil Stocks in SPR, kbbl
//       PET.WGTSTUS1.W  — Weekly U.S. Gasoline Stocks, kbbl
//       PET.WDISTUS1.W  — Weekly U.S. Distillate Stocks, kbbl
//       PET.WPULEUS3.W  — Weekly U.S. Refinery Utilization, %
//       NG.NW2_EPG0_SWO_R48_BCF.W — Weekly NG Working Storage L48, Bcf
// =============================================================

const EIA_BASE = 'https://api.eia.gov/v2'
const REQUEST_TIMEOUT_MS = 12_000

// In-memory cache. Module-level — survives within a single Node process.
// Cleared by Railway redeploy. 24h TTL since EIA data updates weekly.
const cache = new Map<string, { fetchedAt: number; data: EiaSeriesPoint[] }>()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h

export interface EiaSeriesPoint {
  period: string       // e.g. "2026-06-13" for weekly data
  value: number        // coerced to number
}

export interface EiaSeriesResult {
  seriesId: string
  units: string | null
  frequency: string | null
  points: EiaSeriesPoint[]  // newest first
  fetchedAt: number          // unix ms when we fetched
  cached: boolean
}

interface EiaApiResponse {
  response?: {
    total?: string | number
    dateFormat?: string
    frequency?: string
    data?: Array<{
      period: string
      value: string | number | null
      [key: string]: unknown
    }>
  }
  error?: string
  warning?: string
  request?: unknown
  apiVersion?: string
}

/**
 * Fetch a single EIA series by its v1-style series ID.
 * Uses the /v2/seriesid/{ID} translation endpoint.
 *
 * @param seriesId  e.g. "PET.WCESTUS1.W"
 * @param length    How many rows to fetch (default 52 = one year weekly)
 */
export async function fetchEiaSeries(seriesId: string, length = 52): Promise<EiaSeriesResult | null> {
  const apiKey = process.env.EIA_API_KEY
  if (!apiKey) {
    console.warn('[eia-client] EIA_API_KEY not set; skipping fetch')
    return null
  }

  const cacheKey = `${seriesId}::${length}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return {
      seriesId,
      units: null,
      frequency: null,
      points: cached.data,
      fetchedAt: cached.fetchedAt,
      cached: true,
    }
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    'data[0]': 'value',
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: String(length),
  })
  const url = `${EIA_BASE}/seriesid/${encodeURIComponent(seriesId)}?${params.toString()}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      console.warn(`[eia-client] ${seriesId} HTTP ${res.status}`)
      return null
    }
    const json = (await res.json()) as EiaApiResponse
    if (json.error) {
      console.warn(`[eia-client] ${seriesId} API error: ${json.error}`)
      return null
    }
    const rows = json.response?.data ?? []
    if (rows.length === 0) {
      console.warn(`[eia-client] ${seriesId} returned 0 rows`)
      return null
    }
    const points: EiaSeriesPoint[] = rows
      .map(r => ({
        period: String(r.period ?? ''),
        value: Number(r.value),
      }))
      .filter(p => p.period.length > 0 && Number.isFinite(p.value))

    if (points.length === 0) {
      console.warn(`[eia-client] ${seriesId}: all rows had unparseable values`)
      return null
    }

    cache.set(cacheKey, { fetchedAt: Date.now(), data: points })
    return {
      seriesId,
      units: null,  // could be parsed from rows[0]['value-units'] but we don't need it for the Council
      frequency: json.response?.frequency ?? null,
      points,
      fetchedAt: Date.now(),
      cached: false,
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      console.warn(`[eia-client] ${seriesId} timeout`)
    } else {
      console.warn(`[eia-client] ${seriesId} error:`, e instanceof Error ? e.message : e)
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Health check — verify EIA API key is reachable and returning data.
 * Used by the admin /api/admin/api-health route.
 * Returns { ok: true } on a clean fetch, { ok: false, error } otherwise.
 */
export async function checkEiaHealth(): Promise<{ ok: boolean; error?: string; sample?: { period: string; value: number } }> {
  if (!process.env.EIA_API_KEY) {
    return { ok: false, error: 'EIA_API_KEY not configured' }
  }
  const result = await fetchEiaSeries('PET.WCESTUS1.W', 1)
  if (!result || result.points.length === 0) {
    return { ok: false, error: 'EIA fetch returned no data (key may be invalid or API down)' }
  }
  return {
    ok: true,
    sample: { period: result.points[0].period, value: result.points[0].value },
  }
}

// ─────────────────────────────────────────────────────────────
// Series ID constants for the contracts we wire in Layer 6
// ─────────────────────────────────────────────────────────────

export const EIA_SERIES = {
  CRUDE_STOCKS_EX_SPR:    'PET.WCESTUS1.W',  // for CL/MCL
  CRUDE_STOCKS_SPR:       'PET.WCSSTUS1.W',  // SPR context for CL
  GASOLINE_STOCKS:        'PET.WGTSTUS1.W',  // RB (mentioned as proxy)
  DISTILLATE_STOCKS:      'PET.WDISTUS1.W',  // HO (mentioned as proxy)
  REFINERY_UTILIZATION:   'PET.WPULEUS3.W',  // Refinery throughput context for CL
  NATGAS_WORKING_STORAGE: 'NG.NW2_EPG0_SWO_R48_BCF.W',  // for NG/QG
} as const
