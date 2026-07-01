// Single source of truth for track-record statistics. Both the track-record
// stats page and the public verdict feed import this, so their headline numbers
// (hit rate, direction, graded count, expectancy) are guaranteed identical and
// can never silently drift apart again.

export interface VRow {
  outcome_1w_strict: string | null
  outcome_1w_directional: string | null
  outcome_1w_price: number | string | null
  signal: string | null
  entry_price: number | string | null
  stop_loss: number | string | null
  take_profit: number | string | null
  ticker: string | null
  spy_return_1w: number | string | null
}

export interface BucketStats {
  hitRate1w: number | null          // strict: hit target before stop (1W)
  directionAcc1w: number | null     // directional: was the call's direction right (1W)
  totalVerdicts: number
  gradedVerdicts: number            // strict wins + losses (the expectancy population)
  expectancyR: number | null
  profitFactor: number | null
  payoffRatio: number | null
  avgWinR: number | null
  totalR: number | null
  avgReturnPct: number | null
  medianReturnPct: number | null
  avgAlphaPct: number | null
  medianAlphaPct: number | null
  beatSpyRate: number | null
  benchmarkedCount: number
}

// Below this many graded outcomes, per-asset stats are noise and must not be
// shown (e.g. 1 crypto sample producing a -98060% "median return"). Callers use
// this to suppress low-sample asset rows on customer-facing surfaces.
export const MIN_ASSET_GRADED = 10

export function round(n: number | null | undefined, dp = 2): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  const f = Math.pow(10, dp)
  return Math.round(n * f) / f
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function assetOf(ticker: string | null): 'crypto' | 'forex' | 'stock' {
  const t = (ticker ?? '').toUpperCase()
  if (t.endsWith('USD') && t.length > 6) return 'crypto'      // e.g. BTCUSD, RAVEUSD
  if (/^[A-Z]{6}$/.test(t) && (t.startsWith('EUR') || t.startsWith('GBP') || t.startsWith('USD') ||
      t.startsWith('AUD') || t.startsWith('NZD') || t.startsWith('XAU') || t.endsWith('JPY') ||
      t.endsWith('CAD') || t.endsWith('CHF'))) return 'forex'
  if (/USD$/.test(t) && t.length === 6) return 'forex'
  return 'stock'
}

/** Compute the full expectancy suite for any subset of verdict rows. */
export function bucketStats(rows: VRow[]): BucketStats {
  let wins = 0, losses = 0, dirC = 0, dirI = 0
  let grossWinR = 0, grossLossR = 0, winCountR = 0, lossCountR = 0
  const rets: number[] = []
  const alphas: number[] = []

  for (const r of rows) {
    if (r.outcome_1w_strict === 'win') wins++
    else if (r.outcome_1w_strict === 'loss') losses++
    if (r.outcome_1w_directional === 'win') dirC++
    else if (r.outcome_1w_directional === 'loss') dirI++

    const entry = Number(r.entry_price), stop = Number(r.stop_loss), tgt = Number(r.take_profit)
    const risk = Math.abs(entry - stop)
    const validRisk = entry > 0 && risk > 0 && risk / entry >= 0.001   // guard junk (entry≈stop)
    if (validRisk && r.outcome_1w_strict === 'win' && tgt > 0) {
      grossWinR += Math.min(10, Math.abs(tgt - entry) / risk); winCountR++   // cap absurd outliers
    } else if (validRisk && r.outcome_1w_strict === 'loss') {
      grossLossR += 1; lossCountR++
    }

    const p1w = Number(r.outcome_1w_price)
    if (entry > 0 && p1w > 0) {
      const stratRet = (r.signal === 'BEARISH' ? -1 : 1) * ((p1w - entry) / entry) * 100
      rets.push(stratRet)
      if (r.spy_return_1w !== null && r.spy_return_1w !== undefined) {
        alphas.push(stratRet - Number(r.spy_return_1w) * 100)
      }
    }
  }

  const graded = wins + losses
  const dirGraded = dirC + dirI
  const nR = winCountR + lossCountR
  const avgWinR = winCountR > 0 ? grossWinR / winCountR : null
  return {
    hitRate1w: graded > 0 ? round((wins / graded) * 100) : null,
    directionAcc1w: dirGraded > 0 ? round((dirC / dirGraded) * 100) : null,
    totalVerdicts: rows.length,
    gradedVerdicts: graded,
    expectancyR: nR > 0 ? round((grossWinR - grossLossR) / nR, 3) : null,
    profitFactor: grossLossR > 0 ? round(grossWinR / grossLossR) : null,
    payoffRatio: round(avgWinR),
    avgWinR: round(avgWinR),
    totalR: nR > 0 ? round(grossWinR - grossLossR, 1) : null,
    avgReturnPct: rets.length > 0 ? round(rets.reduce((a, b) => a + b, 0) / rets.length) : null,
    medianReturnPct: round(median(rets)),
    avgAlphaPct: alphas.length > 0 ? round(alphas.reduce((a, b) => a + b, 0) / alphas.length) : null,
    medianAlphaPct: round(median(alphas)),
    beatSpyRate: alphas.length > 0 ? round((alphas.filter(a => a > 0).length / alphas.length) * 100) : null,
    benchmarkedCount: alphas.length,
  }
}
