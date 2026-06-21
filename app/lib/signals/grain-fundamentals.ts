// =============================================================
// app/lib/signals/grain-fundamentals.ts (Layer 7)
//
// Builds a GrainFundamentals snapshot for a grain futures contract
// using USDA NASS crop progress/condition + NOAA weather data.
//
// Scope: ZC (corn), ZS (soybeans), ZW (SRW wheat), KE (HRW wheat),
//        ZM (soymeal), ZL (soyoil)
//
// ZM/ZL inherit from ZS since they are crush products.
// Weather aggregates major growing states for the relevant commodity.
// =============================================================

import {
  fetchNassRecords,
  nassCommodityForRoot,
  type NassRecord,
} from '../data/usda-client'
import {
  fetchNoaaDaily,
  STATE_STATIONS,
  convertNoaaValue,
  type NoaaObservation,
} from '../data/noaa-client'

export interface CropProgressMetric {
  metric: 'planted' | 'emerged' | 'silking' | 'dough' | 'denting' | 'mature' | 'harvested' | 'condition_good_excellent' | 'condition_poor_very_poor'
  label: string
  pctNational: number | null         // national average, e.g. 67 for 67%
  weekEnding: string                 // YYYY-MM-DD
  fiveYearAvg: number | null         // historical 5Y average for this week (if computable)
  vsFiveYearAvg: number | null       // pctNational - fiveYearAvg
  interpretation: string             // short Council-readable note
}

export interface StateWeatherSnapshot {
  stateAlpha: string
  cityName: string
  stationId: string
  last7DayPrcp: number | null        // mm total over last 7 days
  last30DayPrcp: number | null       // mm total over last 30 days
  recentTmaxAvg: number | null       // °C average max over last 7 days
  recentTminAvg: number | null       // °C average min over last 7 days
  observationCount: number
  note: string                       // e.g. "dry stretch" | "above-normal heat"
}

export interface GrainFundamentalsSnapshot {
  commodity: string                  // 'CORN' | 'SOYBEANS' | 'WHEAT'
  futuresRoot: string
  fetchedAt: string                  // ISO
  inheritedFrom?: string             // for ZM/ZL → 'ZS'

  cropProgress: CropProgressMetric[]
  weatherByState: StateWeatherSnapshot[]

  interpretation: string             // overall Council-readable interpretation
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export async function buildGrainFundamentals(
  futuresRoot: string,
): Promise<GrainFundamentalsSnapshot | null> {
  const mapping = nassCommodityForRoot(futuresRoot)
  if (!mapping) return null  // Not a wired grain root

  // ZM and ZL inherit from ZS (soybeans crush products)
  const inheritedFrom = (futuresRoot === 'ZM' || futuresRoot === 'ZL') ? 'ZS' : undefined

  const [cropProgress, weatherByState] = await Promise.all([
    fetchCropProgress(mapping.commodity, futuresRoot),
    fetchWeatherForStates(mapping.states),
  ])

  if (cropProgress.length === 0 && weatherByState.length === 0) {
    console.warn(`[grain-fundamentals] ${futuresRoot}: both USDA and NOAA returned empty`)
    return null
  }

  const interpretation = buildInterpretation(mapping.commodity, cropProgress, weatherByState)

  return {
    commodity: mapping.commodity,
    futuresRoot,
    fetchedAt: new Date().toISOString(),
    inheritedFrom,
    cropProgress,
    weatherByState,
    interpretation,
  }
}

// ─────────────────────────────────────────────────────────────
// Crop progress fetcher
// ─────────────────────────────────────────────────────────────

async function fetchCropProgress(commodity: string, futuresRoot: string): Promise<CropProgressMetric[]> {
  const currentYear = new Date().getFullYear()
  const records = await fetchNassRecords({
    commodity_desc: commodity,
    statisticcat_desc: 'PROGRESS',
    year__GE: String(currentYear - 5),  // get 5 years for seasonal comparison
  }, 1000)

  if (!records || records.length === 0) return []

  // Also fetch condition ratings
  const conditionRecords = await fetchNassRecords({
    commodity_desc: commodity,
    statisticcat_desc: 'CONDITION',
    year__GE: String(currentYear - 5),
  }, 1000)

  const metrics: CropProgressMetric[] = []

  // Extract latest progress metrics (national level only)
  // National rows have agg_level_desc='NATIONAL' but we'll just take state_alpha=''
  const nationalProgress = records.filter(r => !r.state_alpha)
  const grouped = groupByShortDesc(nationalProgress)

  for (const [shortDesc, rows] of Object.entries(grouped)) {
    const metric = parseProgressMetric(shortDesc)
    if (!metric) continue

    // Most recent row for this metric in current year
    const latestThisYear = rows
      .filter(r => r.year === String(currentYear))
      .sort((a, b) => (b.week_ending || '').localeCompare(a.week_ending || ''))[0]

    if (!latestThisYear) continue

    const pct = parseInt(latestThisYear.Value, 10)
    if (!Number.isFinite(pct)) continue

    // Compute 5Y average for this week
    const weekEnding = latestThisYear.week_ending
    const weekNumber = latestThisYear.reference_period_desc  // "WEEK #N"
    const historicalSameWeek = rows.filter(r =>
      r.year !== String(currentYear) &&
      r.reference_period_desc === weekNumber,
    )
    const fiveYearAvg = historicalSameWeek.length >= 2
      ? historicalSameWeek.reduce((s, r) => s + (parseInt(r.Value, 10) || 0), 0) / historicalSameWeek.length
      : null

    metrics.push({
      metric,
      label: shortDesc,
      pctNational: pct,
      weekEnding,
      fiveYearAvg: fiveYearAvg !== null ? Math.round(fiveYearAvg) : null,
      vsFiveYearAvg: fiveYearAvg !== null ? pct - Math.round(fiveYearAvg) : null,
      interpretation: interpretProgressDelta(metric, pct, fiveYearAvg),
    })
  }

  // Process condition ratings
  if (conditionRecords && conditionRecords.length > 0) {
    const nationalCond = conditionRecords.filter(r => !r.state_alpha && r.year === String(currentYear))

    // % Good + Excellent (combined bullish health metric)
    const goodExcellent = sumConditionPct(nationalCond, ['GOOD', 'EXCELLENT'])
    // % Poor + Very Poor (combined bearish stress metric)
    const poorVeryPoor = sumConditionPct(nationalCond, ['POOR', 'VERY POOR'])

    const latestCondRow = nationalCond
      .sort((a, b) => (b.week_ending || '').localeCompare(a.week_ending || ''))[0]
    const weekEnding = latestCondRow?.week_ending || ''

    if (goodExcellent !== null) {
      metrics.push({
        metric: 'condition_good_excellent',
        label: `${commodity} CONDITION - PCT GOOD + EXCELLENT`,
        pctNational: goodExcellent,
        weekEnding,
        fiveYearAvg: null,  // condition 5Y avg is harder; skip for v1
        vsFiveYearAvg: null,
        interpretation: goodExcellent >= 70 ? 'Strong crop health (bearish for prices, supply secure)'
          : goodExcellent >= 55 ? 'Average crop health'
          : 'Below-average crop health (bullish for prices, supply concern)',
      })
    }
    if (poorVeryPoor !== null) {
      metrics.push({
        metric: 'condition_poor_very_poor',
        label: `${commodity} CONDITION - PCT POOR + VERY POOR`,
        pctNational: poorVeryPoor,
        weekEnding,
        fiveYearAvg: null,
        vsFiveYearAvg: null,
        interpretation: poorVeryPoor <= 10 ? 'Low stress signal (bearish for prices)'
          : poorVeryPoor <= 20 ? 'Moderate stress'
          : 'Elevated stress (bullish — crop loss potential)',
      })
    }
  }

  void futuresRoot  // silence unused-param lint for now
  return metrics
}

function groupByShortDesc(records: NassRecord[]): Record<string, NassRecord[]> {
  const grouped: Record<string, NassRecord[]> = {}
  for (const r of records) {
    if (!grouped[r.short_desc]) grouped[r.short_desc] = []
    grouped[r.short_desc].push(r)
  }
  return grouped
}

function parseProgressMetric(shortDesc: string): CropProgressMetric['metric'] | null {
  const upper = shortDesc.toUpperCase()
  if (upper.includes('PCT PLANTED')) return 'planted'
  if (upper.includes('PCT EMERGED')) return 'emerged'
  if (upper.includes('PCT SILKING')) return 'silking'
  if (upper.includes('PCT DOUGH')) return 'dough'
  if (upper.includes('PCT DENTED') || upper.includes('PCT DENTING')) return 'denting'
  if (upper.includes('PCT MATURE')) return 'mature'
  if (upper.includes('PCT HARVESTED')) return 'harvested'
  return null
}

function interpretProgressDelta(metric: CropProgressMetric['metric'], pct: number, fiveYearAvg: number | null): string {
  if (fiveYearAvg === null) return `${metric}: ${pct}% (no 5Y comparison)`
  const delta = pct - fiveYearAvg
  const ahead = delta > 0
  const direction = ahead ? 'ahead of' : 'behind'
  const absDelta = Math.abs(delta)
  if (absDelta < 3) return `${metric}: ${pct}% (in line with 5Y avg of ${fiveYearAvg}%)`
  if (absDelta < 8) return `${metric}: ${pct}% (${absDelta}pp ${direction} 5Y avg ${fiveYearAvg}%)`
  return `${metric}: ${pct}% (${absDelta}pp ${direction} 5Y avg ${fiveYearAvg}% — notable)`
}

function sumConditionPct(records: NassRecord[], levels: string[]): number | null {
  let total = 0
  let foundAny = false
  // Get the latest week's rows
  const latestWeek = records
    .map(r => r.week_ending)
    .sort()
    .reverse()[0]
  if (!latestWeek) return null
  const latestRows = records.filter(r => r.week_ending === latestWeek)

  for (const lvl of levels) {
    const row = latestRows.find(r => r.short_desc.toUpperCase().includes(lvl) && r.short_desc.toUpperCase().includes('PCT'))
    if (row) {
      const v = parseInt(row.Value, 10)
      if (Number.isFinite(v)) {
        total += v
        foundAny = true
      }
    }
  }
  return foundAny ? total : null
}

// ─────────────────────────────────────────────────────────────
// Weather fetcher
// ─────────────────────────────────────────────────────────────

async function fetchWeatherForStates(states: readonly string[]): Promise<StateWeatherSnapshot[]> {
  const today = new Date()
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)

  const results = await Promise.all(
    states.map(async state => {
      const stn = STATE_STATIONS[state]
      if (!stn) return null
      const obs = await fetchNoaaDaily(stn.stationId, fmt(thirtyDaysAgo), fmt(today), ['PRCP', 'TMAX', 'TMIN'])
      if (!obs || obs.length === 0) return null
      return buildStateWeatherSnapshot(state, stn.cityName, stn.stationId, obs, today)
    }),
  )

  return results.filter((r): r is StateWeatherSnapshot => r !== null)
}

function buildStateWeatherSnapshot(
  stateAlpha: string,
  cityName: string,
  stationId: string,
  obs: NoaaObservation[],
  today: Date,
): StateWeatherSnapshot {
  const sevenDayCutoff = new Date(today.getTime() - 7 * 86400000)

  let last7DayPrcp = 0
  let last30DayPrcp = 0
  let tmaxSum = 0, tmaxCnt = 0
  let tminSum = 0, tminCnt = 0

  for (const o of obs) {
    const date = new Date(o.date)
    const value = convertNoaaValue(o.datatype, o.value)
    const inLast7 = date.getTime() >= sevenDayCutoff.getTime()

    if (o.datatype === 'PRCP') {
      last30DayPrcp += value
      if (inLast7) last7DayPrcp += value
    } else if (o.datatype === 'TMAX' && inLast7) {
      tmaxSum += value
      tmaxCnt++
    } else if (o.datatype === 'TMIN' && inLast7) {
      tminSum += value
      tminCnt++
    }
  }

  const recentTmaxAvg = tmaxCnt > 0 ? tmaxSum / tmaxCnt : null
  const recentTminAvg = tminCnt > 0 ? tminSum / tminCnt : null

  let note = ''
  if (last7DayPrcp < 5) note = 'dry week (<5mm precip)'
  else if (last7DayPrcp > 50) note = 'very wet week (>50mm precip)'
  else if (last7DayPrcp > 25) note = 'wet week (>25mm precip)'
  else note = 'normal precipitation'

  if (recentTmaxAvg !== null && recentTmaxAvg > 32) note += '; high heat stress (avg max >32°C)'
  else if (recentTmaxAvg !== null && recentTmaxAvg > 28) note += '; warm week'

  return {
    stateAlpha,
    cityName,
    stationId,
    last7DayPrcp: Math.round(last7DayPrcp * 10) / 10,
    last30DayPrcp: Math.round(last30DayPrcp * 10) / 10,
    recentTmaxAvg: recentTmaxAvg !== null ? Math.round(recentTmaxAvg * 10) / 10 : null,
    recentTminAvg: recentTminAvg !== null ? Math.round(recentTminAvg * 10) / 10 : null,
    observationCount: obs.length,
    note,
  }
}

// ─────────────────────────────────────────────────────────────
// Overall interpretation
// ─────────────────────────────────────────────────────────────

function buildInterpretation(
  commodity: string,
  cropProgress: CropProgressMetric[],
  weatherByState: StateWeatherSnapshot[],
): string {
  const parts: string[] = []

  // Crop condition is the dominant supply signal
  const goodExcellent = cropProgress.find(m => m.metric === 'condition_good_excellent')
  const poorVeryPoor = cropProgress.find(m => m.metric === 'condition_poor_very_poor')

  if (goodExcellent !== null && goodExcellent !== undefined) {
    parts.push(`${commodity} crop condition: ${goodExcellent.pctNational}% good+excellent (week ending ${goodExcellent.weekEnding})`)
  }
  if (poorVeryPoor !== null && poorVeryPoor !== undefined) {
    parts.push(`${poorVeryPoor.pctNational}% poor+very poor`)
  }

  // Progress vs 5Y avg
  const progressMetrics = cropProgress.filter(m =>
    m.metric !== 'condition_good_excellent' && m.metric !== 'condition_poor_very_poor'
  )
  for (const pm of progressMetrics) {
    if (pm.vsFiveYearAvg !== null && Math.abs(pm.vsFiveYearAvg) >= 3) {
      const dir = pm.vsFiveYearAvg > 0 ? 'ahead of' : 'behind'
      parts.push(`${pm.metric} ${pm.pctNational}% (${Math.abs(pm.vsFiveYearAvg)}pp ${dir} 5Y avg)`)
    }
  }

  // Weather aggregates
  if (weatherByState.length > 0) {
    const dryStates = weatherByState.filter(w => w.note.includes('dry')).map(w => w.stateAlpha)
    const wetStates = weatherByState.filter(w => w.note.includes('very wet')).map(w => w.stateAlpha)
    const heatStates = weatherByState.filter(w => w.note.includes('heat stress')).map(w => w.stateAlpha)

    if (heatStates.length > 0) parts.push(`HEAT STRESS in: ${heatStates.join(', ')} (bullish — yield risk)`)
    if (dryStates.length >= 2) parts.push(`DRY STRETCH in: ${dryStates.join(', ')} (bullish if persistent)`)
    if (wetStates.length >= 2) parts.push(`HEAVY RAIN in: ${wetStates.join(', ')} (planting/harvest delay if untimely)`)
    if (heatStates.length === 0 && dryStates.length < 2 && wetStates.length === 0) {
      parts.push(`Weather in growing regions: largely normal`)
    }
  }

  parts.push(`NOTE: WASDE supply/demand balances and export sales NOT in data layer — treat as background only.`)
  return parts.join('. ')
}

// ─────────────────────────────────────────────────────────────
// Council-readable formatting
// ─────────────────────────────────────────────────────────────

export function formatGrainFundamentalsForPrompt(snap: GrainFundamentalsSnapshot): string {
  const lines: string[] = []
  lines.push(`USDA NASS + NOAA WEATHER (commodity: ${snap.commodity}${snap.inheritedFrom ? `, inherited from ${snap.inheritedFrom}` : ''}):`)

  if (snap.cropProgress.length > 0) {
    lines.push(`  Crop progress (latest weekly report):`)
    for (const m of snap.cropProgress) {
      const vs5y = m.vsFiveYearAvg !== null ? ` vs 5Y avg ${m.fiveYearAvg}% (${m.vsFiveYearAvg > 0 ? '+' : ''}${m.vsFiveYearAvg}pp)` : ''
      lines.push(`    ${m.metric}: ${m.pctNational}% (week ${m.weekEnding})${vs5y}`)
    }
  } else {
    lines.push(`  Crop progress: no recent USDA NASS data (likely out of growing season or fetch failed)`)
  }

  if (snap.weatherByState.length > 0) {
    lines.push(`  Weather in key states (NOAA daily summaries, last 7/30 days):`)
    for (const w of snap.weatherByState) {
      const tmax = w.recentTmaxAvg !== null ? `, avg max ${w.recentTmaxAvg}°C` : ''
      lines.push(`    ${w.cityName}: 7d ${w.last7DayPrcp}mm / 30d ${w.last30DayPrcp}mm precip${tmax} — ${w.note}`)
    }
  } else {
    lines.push(`  Weather: NOAA data not available this run`)
  }

  lines.push(`  Interpretation: ${snap.interpretation}`)
  return lines.join('\n')
}
