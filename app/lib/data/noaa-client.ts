// =============================================================
// app/lib/data/noaa-client.ts (Layer 7)
//
// NOAA Climate Data Online (CDO) API v2 client.
//
// API: https://www.ncei.noaa.gov/cdo-web/api/v2/data
// Auth: HTTP header `token: <KEY>` (NOT a query param)
// Rate limit: 5 requests/sec, 10,000/day
//
// Dataset we use: GHCND (Global Historical Climatology Network — Daily)
// Data types we use:
//   - PRCP — precipitation (tenths of mm)
//   - TMAX — max daily temperature (tenths of °C)
//   - TMIN — min daily temperature (tenths of °C)
//
// We query by station ID. Each grain state has one canonical station.
// =============================================================

const NOAA_BASE = 'https://www.ncei.noaa.gov/cdo-web/api/v2'
const REQUEST_TIMEOUT_MS = 15_000  // NOAA can be slow

// 24h cache — weather updates daily; we don't need higher precision
const cache = new Map<string, { fetchedAt: number; data: NoaaObservation[] }>()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface NoaaObservation {
  date: string         // ISO YYYY-MM-DDTHH:mm:ss
  datatype: string     // 'PRCP' | 'TMAX' | 'TMIN'
  station: string
  attributes: string
  value: number        // raw value — PRCP in tenths of mm, T in tenths of °C
}

interface NoaaApiResponse {
  metadata?: {
    resultset?: { offset: number; count: number; limit: number }
  }
  results?: NoaaObservation[]
}

/**
 * Fetch daily summaries from NOAA CDO for a station and date range.
 */
export async function fetchNoaaDaily(
  stationId: string,
  startDate: string,  // YYYY-MM-DD
  endDate: string,    // YYYY-MM-DD
  datatypes: Array<'PRCP' | 'TMAX' | 'TMIN'> = ['PRCP', 'TMAX', 'TMIN'],
): Promise<NoaaObservation[] | null> {
  const token = process.env.NOAA_API_TOKEN
  if (!token) {
    console.warn('[noaa-client] NOAA_API_TOKEN not set; skipping fetch')
    return null
  }

  const queryParts: string[] = [
    `datasetid=GHCND`,
    `stationid=${encodeURIComponent(stationId)}`,
    `startdate=${startDate}`,
    `enddate=${endDate}`,
    `limit=1000`,
    `units=metric`,  // PRCP in mm, T in °C (still tenths)
  ]
  for (const dt of datatypes) {
    queryParts.push(`datatypeid=${dt}`)
  }
  const url = `${NOAA_BASE}/data?${queryParts.join('&')}`

  const cacheKey = url
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        token,
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      console.warn(`[noaa-client] HTTP ${res.status} for station ${stationId}`)
      return null
    }
    const json = (await res.json()) as NoaaApiResponse
    const results = json.results ?? []
    if (results.length === 0) {
      console.warn(`[noaa-client] 0 observations for station ${stationId} ${startDate}..${endDate}`)
      return null
    }
    cache.set(cacheKey, { fetchedAt: Date.now(), data: results })
    return results
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      console.warn(`[noaa-client] timeout for station ${stationId}`)
    } else {
      console.warn(`[noaa-client] error:`, e instanceof Error ? e.message : e)
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Health check.
 */
export async function checkNoaaHealth(): Promise<{ ok: boolean; error?: string; sample?: { station: string; date: string; datatype: string; value: number } }> {
  if (!process.env.NOAA_API_TOKEN) {
    return { ok: false, error: 'NOAA_API_TOKEN not configured' }
  }
  // Fetch last week from Des Moines (Iowa)
  const today = new Date()
  const weekAgo = new Date(today.getTime() - 7 * 86400000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const result = await fetchNoaaDaily('GHCND:USW00014933', fmt(weekAgo), fmt(today), ['PRCP'])
  if (!result || result.length === 0) {
    return { ok: false, error: 'NOAA fetch returned no data (key may be invalid or station unavailable)' }
  }
  const r = result[0]
  return {
    ok: true,
    sample: { station: r.station, date: r.date, datatype: r.datatype, value: r.value },
  }
}

// ─────────────────────────────────────────────────────────────
// Canonical weather stations for grain growing regions
// ─────────────────────────────────────────────────────────────

/**
 * One representative GHCND station per major grain state.
 * Selected for long historical record + central state location.
 * Station ID format: GHCND:USWNNNNNNNNN or GHCND:USCNNNNNNNNN
 */
export const STATE_STATIONS: Record<string, { stationId: string; cityName: string }> = {
  // Corn belt
  IA: { stationId: 'GHCND:USW00014933', cityName: 'Des Moines, IA' },
  IL: { stationId: 'GHCND:USW00094846', cityName: 'Chicago O\'Hare, IL' },
  IN: { stationId: 'GHCND:USW00093819', cityName: 'Indianapolis, IN' },
  NE: { stationId: 'GHCND:USW00014935', cityName: 'Omaha, NE' },
  MN: { stationId: 'GHCND:USW00014922', cityName: 'Minneapolis, MN' },
  // Soybean belt (largely overlaps with corn)
  OH: { stationId: 'GHCND:USW00014820', cityName: 'Columbus, OH' },
  // Wheat — HRW
  KS: { stationId: 'GHCND:USW00003928', cityName: 'Topeka, KS' },
  OK: { stationId: 'GHCND:USW00013967', cityName: 'Oklahoma City, OK' },
  TX: { stationId: 'GHCND:USW00013904', cityName: 'Dallas-Fort Worth, TX' },
  CO: { stationId: 'GHCND:USW00003017', cityName: 'Denver, CO' },
  // Wheat — SRW additional
  MO: { stationId: 'GHCND:USW00013994', cityName: 'St. Louis, MO' },
  MI: { stationId: 'GHCND:USW00094847', cityName: 'Detroit, MI' },
}

/**
 * Convert raw NOAA values to friendly units.
 * Even with units=metric, GHCND values are still in tenths.
 *
 *   PRCP: tenths of mm → mm
 *   TMAX/TMIN: tenths of °C → °C
 */
export function convertNoaaValue(datatype: string, rawValue: number): number {
  if (datatype === 'PRCP' || datatype === 'TMAX' || datatype === 'TMIN') {
    return rawValue / 10
  }
  return rawValue
}
