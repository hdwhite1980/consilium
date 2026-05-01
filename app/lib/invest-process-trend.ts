// ═════════════════════════════════════════════════════════════
// app/lib/invest-process-trend.ts
//
// Computes the user's process-grade trend over time. Uses the same
// postmortem data as the skill gate, but for a different purpose:
// showing a "you're getting better" signal in the UI.
//
// USAGE
//   import { computeProcessTrend } from '@/app/lib/invest-process-trend'
//   const trend = computeProcessTrend(postmortems)
//   // trend.recentTrades, trend.trailing5Avg, trend.baselineAvg, ...
//
// DESIGN
// - Takes raw postmortem rows, returns a UI-ready shape
// - Sorted oldest to newest
// - Limited to last 20 trades to keep payload small
// - Trailing-5 vs baseline-5 comparison drives the "improving" signal
// ═════════════════════════════════════════════════════════════

export interface ProcessTrendPoint {
  closedAt: string  // ISO timestamp
  score: number     // 0-100
  grade: string     // 'A+'...'F'
  tradeId: string
}

export interface ProcessTrendInput {
  trade_id: string
  process_score: number
  grade: string
  outcome?: string
  generated_at?: string | null
}

export interface ProcessTrend {
  /** Up to last 20 closed trades, oldest to newest. */
  recentTrades: ProcessTrendPoint[]
  /** Total closed trades the user has reviewed. */
  totalReviewed: number
  /** Average of the most recent 5 process scores. Null if < 5 trades. */
  trailing5Avg: number | null
  /** Average of the FIRST 5 process scores. Null if < 5 trades total. */
  baselineAvg: number | null
  /** Letter grade equivalent of trailing5Avg. */
  trailing5Letter: string | null
  /** Letter grade equivalent of baselineAvg. */
  baselineLetter: string | null
  /** True when trailing5 ≥ baseline + 5 points (clear improvement signal). */
  isImproving: boolean
  /** True when trailing5 ≤ baseline - 5 (regressing — a real concern). */
  isRegressing: boolean
  /** ISO of newest trade if it closed within last 24h, else null. */
  freshSince: string | null
}

const LETTER_THRESHOLDS: Array<[number, string]> = [
  [95, 'A+'], [90, 'A'], [85, 'A-'],
  [80, 'B+'], [75, 'B'], [70, 'B-'],
  [65, 'C+'], [60, 'C'], [55, 'C-'],
  [40, 'D'], [0, 'F'],
]

function scoreToLetter(score: number): string {
  for (const [threshold, letter] of LETTER_THRESHOLDS) {
    if (score >= threshold) return letter
  }
  return 'F'
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

export function computeProcessTrend(postmortems: ProcessTrendInput[]): ProcessTrend {
  // Filter to valid scores and sort by generated_at ascending (oldest first)
  const valid = postmortems
    .filter(p =>
      typeof p.process_score === 'number'
      && p.process_score >= 0
      && p.process_score <= 100
      && p.trade_id
      && p.generated_at
    )
    .sort((a, b) => {
      const aT = a.generated_at ?? ''
      const bT = b.generated_at ?? ''
      return aT.localeCompare(bT)
    })

  if (valid.length === 0) {
    return {
      recentTrades: [],
      totalReviewed: 0,
      trailing5Avg: null,
      baselineAvg: null,
      trailing5Letter: null,
      baselineLetter: null,
      isImproving: false,
      isRegressing: false,
      freshSince: null,
    }
  }

  // Take last 20 for the chart (oldest to newest)
  const recent = valid.slice(-20)
  const recentTrades: ProcessTrendPoint[] = recent.map(p => ({
    closedAt: p.generated_at!,
    score: p.process_score,
    grade: p.grade || scoreToLetter(p.process_score),
    tradeId: p.trade_id,
  }))

  // Trailing 5 — needs at least 5 trades total
  const trailing5Avg = valid.length >= 5
    ? avg(valid.slice(-5).map(p => p.process_score))
    : null

  // Baseline = first 5 trades EVER. Only meaningful when we have > 5 trades
  // (otherwise baseline and trailing overlap).
  const baselineAvg = valid.length >= 10
    ? avg(valid.slice(0, 5).map(p => p.process_score))
    : null

  const isImproving = trailing5Avg !== null
    && baselineAvg !== null
    && trailing5Avg >= baselineAvg + 5

  const isRegressing = trailing5Avg !== null
    && baselineAvg !== null
    && trailing5Avg <= baselineAvg - 5

  // Freshness: was the newest trade closed within the last 24 hours?
  const newest = valid[valid.length - 1]
  const newestTime = newest.generated_at ? new Date(newest.generated_at).getTime() : 0
  const ageMs = Date.now() - newestTime
  const freshSince = (ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000)
    ? newest.generated_at!
    : null

  return {
    recentTrades,
    totalReviewed: valid.length,
    trailing5Avg: trailing5Avg !== null ? Math.round(trailing5Avg * 10) / 10 : null,
    baselineAvg: baselineAvg !== null ? Math.round(baselineAvg * 10) / 10 : null,
    trailing5Letter: trailing5Avg !== null ? scoreToLetter(trailing5Avg) : null,
    baselineLetter: baselineAvg !== null ? scoreToLetter(baselineAvg) : null,
    isImproving,
    isRegressing,
    freshSince,
  }
}

// Test fixture export
export const __TEST_scoreToLetter = scoreToLetter
