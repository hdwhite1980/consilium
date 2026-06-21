// =============================================================
// app/lib/signals/energy-fundamentals.ts (Layer 6)
//
// Builds an EnergyFundamentals snapshot for a futures contract
// using EIA weekly data.
//
// Scope:
//   - CL/MCL: full wiring (crude stocks + SPR + refinery util)
//   - NG/QG: full wiring (working gas storage)
//   - HO/RB/BZ: proxy-only — the EIA series exist (distillate/
//     gasoline stocks) but we DON'T build a snapshot for those
//     contracts in v1 because they're low-liquidity. The Council
//     prompt for those families still notes "EIA data exists but
//     not wired" — we only wire the high-volume contracts where
//     fundamentals genuinely change the verdict.
// =============================================================

import {
  fetchEiaSeries,
  EIA_SERIES,
  type EiaSeriesPoint,
} from '../data/eia-client'

export interface EnergyFundamentalsSnapshot {
  family: 'crude' | 'natgas'
  fetchedAt: string  // ISO timestamp
  // Primary metric for this family
  primary: {
    label: string
    units: string
    reportDate: string       // most recent EIA report date (YYYY-MM-DD)
    latest: number           // most recent value
    weekAgo: number | null   // previous week's value
    wowChange: number | null // latest - weekAgo
    wowChangePct: number | null
    yearAgo: number | null   // ~52 weeks back if available
    yoyChange: number | null
    yoyChangePct: number | null
    fiveYearMean: number | null
    fiveYearMin: number | null
    fiveYearMax: number | null
    positionInRange: '5y_low' | 'below_avg' | 'avg' | 'above_avg' | '5y_high' | 'unknown'
  }
  // Secondary metrics (context-only)
  secondary: Array<{
    label: string
    units: string
    reportDate: string
    latest: number
    wowChange: number | null
  }>
  // Council-readable interpretation
  interpretation: string
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Build an energy fundamentals snapshot for the given futures root.
 * Returns null if family isn't wired or if all EIA fetches fail.
 *
 * Wired families: CL/MCL (crude), NG/QG (natgas)
 * Other roots return null (Council prompt knows to skip).
 */
export async function buildEnergyFundamentals(
  futuresRoot: string,
): Promise<EnergyFundamentalsSnapshot | null> {
  switch (futuresRoot) {
    case 'CL':
    case 'MCL':
      return buildCrudeSnapshot()
    case 'NG':
    case 'QG':
      return buildNatGasSnapshot()
    default:
      return null  // HO/RB/BZ etc. — proxy-only in v1
  }
}

// ─────────────────────────────────────────────────────────────
// Crude oil snapshot
// ─────────────────────────────────────────────────────────────

async function buildCrudeSnapshot(): Promise<EnergyFundamentalsSnapshot | null> {
  const [crudeRes, sprRes, refineryRes] = await Promise.all([
    fetchEiaSeries(EIA_SERIES.CRUDE_STOCKS_EX_SPR, 260),  // 5y of weekly = ~260 rows
    fetchEiaSeries(EIA_SERIES.CRUDE_STOCKS_SPR, 8),
    fetchEiaSeries(EIA_SERIES.REFINERY_UTILIZATION, 8),
  ])

  if (!crudeRes || crudeRes.points.length < 2) {
    console.warn('[energy-fundamentals] crude: primary series fetch failed or insufficient data')
    return null
  }

  const primary = computePrimaryMetrics(
    crudeRes.points,
    'U.S. Crude Oil Stocks (excl. SPR)',
    'thousand barrels',
  )

  const secondary: EnergyFundamentalsSnapshot['secondary'] = []
  if (sprRes && sprRes.points.length >= 2) {
    secondary.push({
      label: 'Strategic Petroleum Reserve',
      units: 'thousand barrels',
      reportDate: sprRes.points[0].period,
      latest: sprRes.points[0].value,
      wowChange: sprRes.points[0].value - sprRes.points[1].value,
    })
  }
  if (refineryRes && refineryRes.points.length >= 2) {
    secondary.push({
      label: 'Refinery Utilization',
      units: 'percent of operable capacity',
      reportDate: refineryRes.points[0].period,
      latest: refineryRes.points[0].value,
      wowChange: refineryRes.points[0].value - refineryRes.points[1].value,
    })
  }

  return {
    family: 'crude',
    fetchedAt: new Date().toISOString(),
    primary,
    secondary,
    interpretation: interpretCrude(primary, secondary),
  }
}

// ─────────────────────────────────────────────────────────────
// Natural gas snapshot
// ─────────────────────────────────────────────────────────────

async function buildNatGasSnapshot(): Promise<EnergyFundamentalsSnapshot | null> {
  const storageRes = await fetchEiaSeries(EIA_SERIES.NATGAS_WORKING_STORAGE, 260)
  if (!storageRes || storageRes.points.length < 2) {
    console.warn('[energy-fundamentals] natgas: storage series fetch failed')
    return null
  }

  const primary = computePrimaryMetrics(
    storageRes.points,
    'Lower 48 Working Gas in Underground Storage',
    'billion cubic feet',
  )

  return {
    family: 'natgas',
    fetchedAt: new Date().toISOString(),
    primary,
    secondary: [],
    interpretation: interpretNatGas(primary),
  }
}

// ─────────────────────────────────────────────────────────────
// Generic primary-metrics computation
// ─────────────────────────────────────────────────────────────

function computePrimaryMetrics(
  points: EiaSeriesPoint[],   // newest-first
  label: string,
  units: string,
): EnergyFundamentalsSnapshot['primary'] {
  const latest = points[0].value
  const weekAgo = points[1]?.value ?? null
  const wowChange = weekAgo !== null ? latest - weekAgo : null
  const wowChangePct = weekAgo !== null && weekAgo !== 0 ? (wowChange! / weekAgo) * 100 : null

  // YoY: prefer the 52nd-back point if available
  const yearAgo = points[52]?.value ?? null
  const yoyChange = yearAgo !== null ? latest - yearAgo : null
  const yoyChangePct = yearAgo !== null && yearAgo !== 0 ? (yoyChange! / yearAgo) * 100 : null

  // 5-year band: match the current report week across prior 5 years.
  // EIA data is weekly so an exact week match doesn't exist; we use a
  // ±2-week window centered on the same week-of-year.
  const fiveYearStats = computeFiveYearBand(points)

  // Position in 5-year range
  let positionInRange: EnergyFundamentalsSnapshot['primary']['positionInRange'] = 'unknown'
  if (fiveYearStats.min !== null && fiveYearStats.max !== null && fiveYearStats.mean !== null) {
    const range = fiveYearStats.max - fiveYearStats.min
    if (range > 0) {
      const relPos = (latest - fiveYearStats.min) / range
      if (latest >= fiveYearStats.max) positionInRange = '5y_high'
      else if (latest <= fiveYearStats.min) positionInRange = '5y_low'
      else if (relPos > 0.65) positionInRange = 'above_avg'
      else if (relPos < 0.35) positionInRange = 'below_avg'
      else positionInRange = 'avg'
    }
  }

  return {
    label,
    units,
    reportDate: points[0].period,
    latest,
    weekAgo,
    wowChange,
    wowChangePct,
    yearAgo,
    yoyChange,
    yoyChangePct,
    fiveYearMean: fiveYearStats.mean,
    fiveYearMin: fiveYearStats.min,
    fiveYearMax: fiveYearStats.max,
    positionInRange,
  }
}

function computeFiveYearBand(
  points: EiaSeriesPoint[],
): { mean: number | null; min: number | null; max: number | null } {
  if (points.length < 200) {
    // Not enough data for a real 5-year band; use what we have
    if (points.length < 8) return { mean: null, min: null, max: null }
    const values = points.map(p => p.value)
    return {
      mean: values.reduce((s, v) => s + v, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
    }
  }

  // Find the same week of year in each prior year. Points are weekly,
  // newest-first. Same-week-of-year occurs roughly every 52 rows back.
  // Take ±2 weeks around each anniversary for a seasonal band.
  const sameWeekValues: number[] = [points[0].value]
  for (const yearsBack of [1, 2, 3, 4, 5]) {
    const centerIdx = yearsBack * 52
    for (let offset = -2; offset <= 2; offset++) {
      const idx = centerIdx + offset
      if (idx >= 0 && idx < points.length) {
        sameWeekValues.push(points[idx].value)
      }
    }
  }
  if (sameWeekValues.length < 5) return { mean: null, min: null, max: null }
  return {
    mean: sameWeekValues.reduce((s, v) => s + v, 0) / sameWeekValues.length,
    min: Math.min(...sameWeekValues),
    max: Math.max(...sameWeekValues),
  }
}

// ─────────────────────────────────────────────────────────────
// Interpretation generators (Council-readable)
// ─────────────────────────────────────────────────────────────

function interpretCrude(
  primary: EnergyFundamentalsSnapshot['primary'],
  secondary: EnergyFundamentalsSnapshot['secondary'],
): string {
  const parts: string[] = []

  // WoW direction is the dominant short-term signal
  if (primary.wowChange !== null) {
    const direction = primary.wowChange > 0 ? 'BUILD' : 'DRAW'
    const magnitude = Math.abs(primary.wowChange / 1000).toFixed(1)  // kbbl → Mbbl
    parts.push(`WoW: ${magnitude}M bbl ${direction} (raw signal — consensus expectation NOT in data layer)`)
    // Tag size of move
    const absMM = Math.abs(primary.wowChange / 1000)
    if (absMM > 5) parts.push(`Large WoW move (>5M bbl)`)
    else if (absMM > 3) parts.push(`Notable WoW move (>3M bbl)`)
  }

  // 5-year range position
  if (primary.positionInRange === '5y_high') {
    parts.push('Stocks at 5Y seasonal high — historically bearish for crude prices')
  } else if (primary.positionInRange === '5y_low') {
    parts.push('Stocks at 5Y seasonal low — historically bullish for crude prices')
  } else if (primary.positionInRange === 'above_avg') {
    parts.push('Stocks above 5Y seasonal average')
  } else if (primary.positionInRange === 'below_avg') {
    parts.push('Stocks below 5Y seasonal average')
  }

  // YoY context
  if (primary.yoyChangePct !== null) {
    const dir = primary.yoyChangePct > 0 ? 'higher' : 'lower'
    parts.push(`YoY: ${Math.abs(primary.yoyChangePct).toFixed(1)}% ${dir}`)
  }

  // Refinery utilization context
  const refinery = secondary.find(s => s.label === 'Refinery Utilization')
  if (refinery) {
    if (refinery.latest >= 92) parts.push(`Refinery utilization ${refinery.latest.toFixed(1)}% (high — supportive of crude demand)`)
    else if (refinery.latest <= 80) parts.push(`Refinery utilization ${refinery.latest.toFixed(1)}% (low — bearish crude demand)`)
    else parts.push(`Refinery utilization ${refinery.latest.toFixed(1)}% (normal)`)
  }

  return parts.join('. ')
}

function interpretNatGas(primary: EnergyFundamentalsSnapshot['primary']): string {
  const parts: string[] = []

  if (primary.wowChange !== null) {
    const direction = primary.wowChange > 0 ? 'INJECTION' : 'WITHDRAWAL'
    parts.push(`WoW: ${Math.abs(primary.wowChange).toFixed(0)} Bcf ${direction} (raw signal — consensus expectation NOT in data layer)`)
  }

  if (primary.positionInRange === '5y_high') {
    parts.push('Storage at 5Y seasonal high — historically bearish for NG prices')
  } else if (primary.positionInRange === '5y_low') {
    parts.push('Storage at 5Y seasonal low — historically bullish for NG prices')
  } else if (primary.positionInRange === 'above_avg') {
    parts.push('Storage above 5Y seasonal average')
  } else if (primary.positionInRange === 'below_avg') {
    parts.push('Storage below 5Y seasonal average')
  }

  if (primary.yoyChangePct !== null) {
    const dir = primary.yoyChangePct > 0 ? 'higher' : 'lower'
    parts.push(`YoY storage: ${Math.abs(primary.yoyChangePct).toFixed(1)}% ${dir}`)
  }

  return parts.join('. ')
}

// ─────────────────────────────────────────────────────────────
// Council-readable formatting (used by futures-prompts.ts)
// ─────────────────────────────────────────────────────────────

/**
 * Format an EnergyFundamentalsSnapshot as a multi-line block for
 * inclusion in the futures Council prompts.
 */
export function formatEnergyFundamentalsForPrompt(snap: EnergyFundamentalsSnapshot): string {
  const lines: string[] = []
  lines.push(`EIA ${snap.family === 'crude' ? 'WEEKLY PETROLEUM STATUS' : 'WEEKLY NATURAL GAS STORAGE'} (as of ${snap.primary.reportDate}):`)
  lines.push(`  ${snap.primary.label}: ${formatValue(snap.primary.latest, snap.primary.units)}`)
  if (snap.primary.wowChange !== null) {
    const sign = snap.primary.wowChange > 0 ? '+' : ''
    lines.push(`  WoW change: ${sign}${snap.primary.wowChange.toFixed(0)} ${snap.primary.units}`)
  }
  if (snap.primary.fiveYearMean !== null && snap.primary.fiveYearMin !== null && snap.primary.fiveYearMax !== null) {
    lines.push(`  5Y seasonal band: ${snap.primary.fiveYearMin.toFixed(0)} - ${snap.primary.fiveYearMax.toFixed(0)} (mean ${snap.primary.fiveYearMean.toFixed(0)})`)
    lines.push(`  Position in 5Y band: ${snap.primary.positionInRange}`)
  }
  for (const s of snap.secondary) {
    const sign = s.wowChange !== null && s.wowChange > 0 ? '+' : ''
    const wow = s.wowChange !== null ? ` (WoW ${sign}${s.wowChange.toFixed(1)})` : ''
    lines.push(`  ${s.label}: ${formatValue(s.latest, s.units)}${wow}`)
  }
  lines.push(`  Interpretation: ${snap.interpretation}`)
  lines.push(`  NOTE: Consensus expectations NOT in data layer. Treat builds/draws as raw signal; the actual market-moving signal is actual vs. consensus.`)
  return lines.join('\n')
}

function formatValue(v: number, units: string): string {
  if (units === 'thousand barrels') {
    return `${(v / 1000).toFixed(1)}M bbl`
  }
  if (units === 'billion cubic feet') {
    return `${v.toFixed(0)} Bcf`
  }
  if (units.includes('percent')) {
    return `${v.toFixed(1)}%`
  }
  return `${v.toFixed(1)} ${units}`
}
