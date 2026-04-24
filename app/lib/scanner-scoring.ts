// ═════════════════════════════════════════════════════════════
// app/lib/scanner-scoring.ts
//
// Rule-based scoring of tickers for the scanner. Pure functions —
// no LLM, no DB, no async calls. Runs in microseconds per ticker.
//
// Two sub-scores combine into a composite:
//
//   directionalScore (0-100)
//     - How strongly do multiple technical indicators AGREE on direction
//     - Bullish: price trending up, MACD positive, RSI healthy, above MAs
//     - Bearish: price trending down, MACD negative, RSI weak, below MAs
//
//   relStrengthScore (0-100)
//     - How much has this stock outperformed SPY over recent windows
//     - Uses 10-day and 30-day price changes vs SPY
//
// Composite = 0.60 * directional + 0.40 * rel_strength
//
// Every score includes reasons + key-setup string so UI can show
// the "why" without any LLM call.
// ═════════════════════════════════════════════════════════════

import type { TechnicalSignals } from '@/app/lib/signals/technicals'

export type Direction = 'bullish' | 'bearish' | 'mixed'

export interface TickerScore {
  ticker: string
  compositeScore: number        // 0-100 (weighted directional + rel strength)
  directionalScore: number      // 0-100 (absolute value, direction separate)
  relStrengthScore: number      // 0-100 (50 = neutral, >50 = outperform)
  direction: Direction
  keySetup: string              // one-line summary: "Bullish trend + MACD cross + RSI 62"
  reasons: string[]             // 3-5 short bullet reasons for the score
  // Quick-display fields for UI
  rsi: number
  priceVsSma20: number
  priceVsSma50: number
  macdTrend: 'bullish' | 'bearish' | 'neutral'
  volumeRatio: number
  technicalBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  currentPrice: number
  priceChange1d: number
  // Relative strength detail
  priceChange10d: number
  priceChange30d: number
  spyChange10d: number
  spyChange30d: number
  relStrength10d: number        // ticker 10d - spy 10d
  relStrength30d: number        // ticker 30d - spy 30d
}

// ─────────────────────────────────────────────────────────────
// Compute price change N days ago from technicals
// Uses the bar window behind calculateTechnicals
// ─────────────────────────────────────────────────────────────
function pctChangeOverDays(t: TechnicalSignals, days: number): number {
  // calculateTechnicals already computes priceChangePeriod for the full window.
  // For ROC we have 10d and 20d directly.
  if (days === 10 && typeof t.roc10 === 'number') return t.roc10
  if (days === 20 && typeof t.roc20 === 'number') return t.roc20
  // Fallback — use priceChangePeriod for the full window if it's close
  return t.priceChangePeriod
}

// ═════════════════════════════════════════════════════════════
// DIRECTIONAL SCORE — how strongly indicators agree on direction
// ═════════════════════════════════════════════════════════════

interface DirectionalResult {
  score: number                  // 0-100, absolute strength
  direction: Direction
  factors: Record<string, number>  // individual contributions for debugging
  reasons: string[]
}

function scoreDirection(t: TechnicalSignals): DirectionalResult {
  let bullPoints = 0
  let bearPoints = 0
  const factors: Record<string, number> = {}
  const reasons: string[] = []

  // ── 1. Trend alignment (25 points max) ────────────────────
  // Price above/below moving averages
  if (t.priceVsSma20 > 0) bullPoints += 4
  else bearPoints += 4
  if (t.priceVsSma50 > 0) bullPoints += 5
  else bearPoints += 5
  if (t.priceVsSma200 > 0) bullPoints += 6
  else bearPoints += 6

  // Golden/Death cross
  if (t.goldenCross) {
    bullPoints += 10
    reasons.push('Golden Cross (SMA50 above SMA200)')
  }
  if (t.deathCross) {
    bearPoints += 10
    reasons.push('Death Cross (SMA50 below SMA200)')
  }

  factors.trend = bullPoints - bearPoints

  // ── 2. Momentum indicators (25 points max) ────────────────
  let momBull = 0, momBear = 0

  // RSI — 50-70 bullish, 30-50 bearish, extremes reverse
  if (t.rsi > 70) {
    momBear += 3
    reasons.push(`RSI ${t.rsi.toFixed(0)} overbought`)
  } else if (t.rsi > 55) {
    momBull += 5
    reasons.push(`RSI ${t.rsi.toFixed(0)} bullish`)
  } else if (t.rsi < 30) {
    momBull += 2 // oversold bounce potential, but usually means trouble
    reasons.push(`RSI ${t.rsi.toFixed(0)} oversold`)
  } else if (t.rsi < 45) {
    momBear += 5
    reasons.push(`RSI ${t.rsi.toFixed(0)} bearish`)
  }

  // MACD crossover
  if (t.macdCrossover === 'bullish') {
    momBull += 8
    reasons.push('MACD bullish cross')
  } else if (t.macdCrossover === 'bearish') {
    momBear += 8
    reasons.push('MACD bearish cross')
  }
  if (t.macdHistogram > 0) momBull += 2
  else momBear += 2

  // ROC 10d
  if (t.roc10 > 5) {
    momBull += 4
  } else if (t.roc10 > 0) {
    momBull += 2
  } else if (t.roc10 < -5) {
    momBear += 4
  } else if (t.roc10 < 0) {
    momBear += 2
  }

  // Stochastic
  if (t.stochCrossover === 'bullish') momBull += 3
  else if (t.stochCrossover === 'bearish') momBear += 3

  // Williams %R
  if (t.williamsR > -20) momBear += 2 // overbought
  else if (t.williamsR < -80) momBull += 2 // oversold

  bullPoints += Math.min(25, momBull)
  bearPoints += Math.min(25, momBear)
  factors.momentum = momBull - momBear

  // ── 3. Volume confirmation (15 points max) ────────────────
  let volBull = 0, volBear = 0

  if (t.volumeSignal === 'high') {
    // High volume confirms whatever direction price is moving
    if (t.priceChange1D > 0) {
      if (t.volumeRatio >= 2.0) {
        volBull += 10
        reasons.push(`Volume surge ${t.volumeRatio.toFixed(1)}x on up day`)
      } else {
        volBull += 6
        reasons.push(`Above-avg volume ${t.volumeRatio.toFixed(1)}x on up day`)
      }
    } else if (t.priceChange1D < 0) {
      if (t.volumeRatio >= 2.0) {
        volBear += 10
        reasons.push(`Volume surge ${t.volumeRatio.toFixed(1)}x on down day`)
      } else {
        volBear += 6
        reasons.push(`Above-avg volume ${t.volumeRatio.toFixed(1)}x on down day`)
      }
    }
  } else if (t.volumeSignal === 'low') {
    volBull -= 2
    volBear -= 2
  }

  // OBV divergence
  if (t.obvDivergence === 'bullish') {
    volBull += 5
    reasons.push('Bullish OBV divergence')
  } else if (t.obvDivergence === 'bearish') {
    volBear += 5
    reasons.push('Bearish OBV divergence')
  }

  bullPoints += Math.max(0, Math.min(15, volBull))
  bearPoints += Math.max(0, Math.min(15, volBear))
  factors.volume = volBull - volBear

  // ── 4. Volatility quality (10 points) ─────────────────────
  // Penalize extreme volatility (both directions) — we want clean moves
  if (t.atrPct > 8) {
    bullPoints -= 3
    bearPoints -= 3
  } else if (t.atrPct < 1) {
    // Very low volatility — compression, could break either way but not actionable now
    bullPoints -= 2
    bearPoints -= 2
  }

  // Bollinger squeeze can be bonus — pending directional break
  if (t.bbSignal === 'squeeze') {
    reasons.push('Bollinger squeeze (compression)')
  } else if (t.bbSignal === 'expansion' && t.priceChange1D > 0) {
    bullPoints += 3
    reasons.push('Bollinger expansion up')
  } else if (t.bbSignal === 'expansion' && t.priceChange1D < 0) {
    bearPoints += 3
    reasons.push('Bollinger expansion down')
  }

  // ── 5. Pattern bonuses (up to 10 points) ──────────────────
  if (t.candlePattern) {
    if (t.candlePattern.type === 'bullish') {
      bullPoints += 4
      reasons.push(`${t.candlePattern.name} (bullish)`)
    } else if (t.candlePattern.type === 'bearish') {
      bearPoints += 4
      reasons.push(`${t.candlePattern.name} (bearish)`)
    }
  }
  if (t.chartPattern) {
    if (t.chartPattern.type === 'bullish') {
      bullPoints += 5
      reasons.push(`${t.chartPattern.name} pattern`)
    } else if (t.chartPattern.type === 'bearish') {
      bearPoints += 5
      reasons.push(`${t.chartPattern.name} pattern`)
    }
  }

  // ── 6. Ichimoku confirmation (up to 5 points) ──────────────
  if (t.ichimokuSignal === 'above_cloud') {
    bullPoints += 3
    reasons.push('Above Ichimoku cloud')
  } else if (t.ichimokuSignal === 'below_cloud') {
    bearPoints += 3
    reasons.push('Below Ichimoku cloud')
  }
  if (t.ichimokuCross === 'bullish') bullPoints += 2
  else if (t.ichimokuCross === 'bearish') bearPoints += 2

  // ── Compile final score ────────────────────────────────────
  const diff = bullPoints - bearPoints
  const direction: Direction = diff > 10 ? 'bullish' : diff < -10 ? 'bearish' : 'mixed'
  const absStrength = Math.abs(diff)
  // Scale: typical max is ~80 in each direction, so normalize to 0-100
  const score = Math.max(0, Math.min(100, Math.round((absStrength / 80) * 100)))

  return {
    score,
    direction,
    factors,
    reasons: reasons.slice(0, 5),
  }
}

// ═════════════════════════════════════════════════════════════
// RELATIVE STRENGTH SCORE — how much has ticker outperformed SPY
// ═════════════════════════════════════════════════════════════

interface RelStrengthResult {
  score: number                  // 0-100, where 50 = matches SPY
  relStrength10d: number
  relStrength30d: number
}

function scoreRelStrength(
  tickerChange10d: number,
  tickerChange30d: number,
  spyChange10d: number,
  spyChange30d: number,
): RelStrengthResult {
  // Outperformance on each window
  const rel10 = tickerChange10d - spyChange10d
  const rel30 = tickerChange30d - spyChange30d

  // Weight 30d more heavily (trend), 10d confirms
  const weightedRel = 0.4 * rel10 + 0.6 * rel30

  // Score mapping: +15% outperformance = 90, 0 = 50, -15% = 10
  // Linear scaling centered on 50
  const score = Math.max(0, Math.min(100, Math.round(50 + (weightedRel / 15) * 40)))

  return {
    score,
    relStrength10d: Math.round(rel10 * 10) / 10,
    relStrength30d: Math.round(rel30 * 10) / 10,
  }
}

// ═════════════════════════════════════════════════════════════
// Combined scoring entrypoint
// ═════════════════════════════════════════════════════════════

export interface ScoreInput {
  ticker: string
  technicals: TechnicalSignals
  spyChange10d: number      // % change SPY over last 10 days
  spyChange30d: number      // % change SPY over last 30 days
}

export function scoreTicker(input: ScoreInput): TickerScore {
  const { ticker, technicals, spyChange10d, spyChange30d } = input

  // Directional score
  const dir = scoreDirection(technicals)

  // Relative strength score
  const tickerChange10d = technicals.roc10 ?? 0
  const tickerChange30d = technicals.priceChangePeriod ?? 0
  const rel = scoreRelStrength(tickerChange10d, tickerChange30d, spyChange10d, spyChange30d)

  // Composite — weight direction more, but adjust UP if direction agrees with rel strength
  let composite = 0.60 * dir.score + 0.40 * rel.score

  // Alignment bonus: strong bullish AND outperforming = add up to 5 points
  if (dir.direction === 'bullish' && rel.score > 60) {
    composite += Math.min(5, (rel.score - 60) / 8)
  } else if (dir.direction === 'bearish' && rel.score < 40) {
    composite += Math.min(5, (40 - rel.score) / 8)
  }
  composite = Math.round(Math.max(0, Math.min(100, composite)))

  // Build key setup string (one-liner summary)
  const direction = dir.direction
  let keySetup = ''
  if (direction === 'bullish') {
    const parts: string[] = []
    if (technicals.priceVsSma50 > 0) parts.push(`+${technicals.priceVsSma50.toFixed(0)}% vs SMA50`)
    if (technicals.macdCrossover === 'bullish') parts.push('MACD bullish')
    else if (technicals.macdHistogram > 0) parts.push('MACD pos')
    if (technicals.rsi >= 50 && technicals.rsi <= 70) parts.push(`RSI ${technicals.rsi.toFixed(0)}`)
    if (rel.relStrength30d > 5) parts.push(`RS +${rel.relStrength30d.toFixed(0)}% vs SPY`)
    keySetup = parts.slice(0, 3).join(' · ') || 'Bullish bias'
  } else if (direction === 'bearish') {
    const parts: string[] = []
    if (technicals.priceVsSma50 < 0) parts.push(`${technicals.priceVsSma50.toFixed(0)}% vs SMA50`)
    if (technicals.macdCrossover === 'bearish') parts.push('MACD bearish')
    else if (technicals.macdHistogram < 0) parts.push('MACD neg')
    if (technicals.rsi < 50) parts.push(`RSI ${technicals.rsi.toFixed(0)}`)
    if (rel.relStrength30d < -5) parts.push(`RS ${rel.relStrength30d.toFixed(0)}% vs SPY`)
    keySetup = parts.slice(0, 3).join(' · ') || 'Bearish bias'
  } else {
    keySetup = 'Mixed signals'
  }

  return {
    ticker,
    compositeScore: composite,
    directionalScore: dir.score,
    relStrengthScore: rel.score,
    direction,
    keySetup,
    reasons: dir.reasons,
    rsi: Math.round(technicals.rsi * 10) / 10,
    priceVsSma20: Math.round(technicals.priceVsSma20 * 10) / 10,
    priceVsSma50: Math.round(technicals.priceVsSma50 * 10) / 10,
    macdTrend: technicals.macdHistogram > 0 ? 'bullish' : technicals.macdHistogram < 0 ? 'bearish' : 'neutral',
    volumeRatio: Math.round(technicals.volumeRatio * 100) / 100,
    technicalBias: technicals.technicalBias,
    currentPrice: Math.round(technicals.currentPrice * 100) / 100,
    priceChange1d: Math.round(technicals.priceChange1D * 100) / 100,
    priceChange10d: Math.round(tickerChange10d * 10) / 10,
    priceChange30d: Math.round(tickerChange30d * 10) / 10,
    spyChange10d: Math.round(spyChange10d * 10) / 10,
    spyChange30d: Math.round(spyChange30d * 10) / 10,
    relStrength10d: rel.relStrength10d,
    relStrength30d: rel.relStrength30d,
  }
}
