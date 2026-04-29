// ═════════════════════════════════════════════════════════════
// app/lib/scanner-momentum.ts
//
// Momentum + coiled-spring scoring for the "Fast Movers" scanner mode.
//
// Surfaces tickers that look ready to move FAST — both:
//   - ALREADY MOVING: breakouts in progress, volume surges, expansion
//   - COILED: tight squeezes near key levels, drying volume, low vol
//
// Both kinds get scored on the same 0-100 scale. UI labels which
// kind via `setupType`. A high momentum score doesn't favor one type
// over the other.
//
// Pure functions — no LLM, no DB, no async calls.
//
// COMPOSED COMPOSITE (when used alongside the directional scanner):
//   directionalScore (0.40) + momentumScore (0.60)  for fast-mover mode
//   (the regular scanner uses 0.60 directional + 0.40 rel-strength)
//
// HORIZON
//   'day'  — weight today's volume + intraday move + gap potential
//   'week' — weight 5-day move + squeeze proximity + chart setup
// ═════════════════════════════════════════════════════════════

import type { TechnicalSignals } from '@/app/lib/signals/technicals'

export type Horizon = 'day' | 'week'
export type SetupType = 'breakout' | 'coiled' | 'continuation' | 'mixed'

export interface MomentumScoreInput {
  technicals: TechnicalSignals
  horizon: Horizon
  /** True 5-day percent change computed from bar closes (caller-supplied). */
  change5d: number
}

export interface MomentumScoreResult {
  /** 0-100 — how strongly this looks like a fast mover (any kind). */
  score: number
  /** Which kind of setup is the dominant signal. */
  setupType: SetupType
  /** Direction the move is most likely to go. */
  direction: 'bullish' | 'bearish' | 'unclear'
  /** Up to 5 short bullets explaining the score. */
  reasons: string[]
  /** Sub-scores for diagnostics / UI. */
  parts: {
    activeMomentum: number    // 0-100
    coiledPotential: number   // 0-100
    setupQuality: number      // 0-100
  }
}

// ═════════════════════════════════════════════════════════════
// Active momentum — already moving
// ═════════════════════════════════════════════════════════════
//
// Signals:
//   - Big 1-day move on heavy volume        (strongest day-trade signal)
//   - 5-day move accelerating               (continuation)
//   - ROC10 strongly positive or negative   (momentum already in place)
//   - MACD recently crossed                  (fresh momentum trigger)
//   - BB expansion                          (volatility just unlocked)
//   - Volume surge                          (interest is real)

interface ActiveMomentumResult {
  score: number              // 0-100 absolute strength
  bullSign: number           // -1 / 0 / +1
  reasons: string[]
}

function scoreActiveMomentum(
  t: TechnicalSignals,
  change5d: number,
  horizon: Horizon,
): ActiveMomentumResult {
  let bull = 0
  let bear = 0
  const reasons: string[] = []

  // Day horizon weights today heavier; week horizon weights 5-day heavier.
  const todayWeight = horizon === 'day' ? 1.0 : 0.55
  const weekWeight  = horizon === 'day' ? 0.45 : 1.0

  // ── 1-day move with volume confirmation ─────────────────
  const todayMove = t.priceChange1D
  const volRatio  = t.volumeRatio
  if (todayMove > 4 && volRatio >= 1.5) {
    bull += 22 * todayWeight
    reasons.push(`+${todayMove.toFixed(1)}% today on ${volRatio.toFixed(1)}x volume`)
  } else if (todayMove > 2 && volRatio >= 1.2) {
    bull += 14 * todayWeight
    reasons.push(`+${todayMove.toFixed(1)}% today on ${volRatio.toFixed(1)}x volume`)
  } else if (todayMove < -4 && volRatio >= 1.5) {
    bear += 22 * todayWeight
    reasons.push(`${todayMove.toFixed(1)}% today on ${volRatio.toFixed(1)}x volume`)
  } else if (todayMove < -2 && volRatio >= 1.2) {
    bear += 14 * todayWeight
    reasons.push(`${todayMove.toFixed(1)}% today on ${volRatio.toFixed(1)}x volume`)
  } else if (Math.abs(todayMove) > 2 && volRatio < 0.8) {
    // Move without volume — weak conviction, slight penalty
    if (todayMove > 0) bull -= 4
    else bear -= 4
  }

  // ── 5-day move (week horizon weighted heavier) ─────────
  if (change5d > 12) {
    bull += 18 * weekWeight
    reasons.push(`+${change5d.toFixed(0)}% over 5 days`)
  } else if (change5d > 6) {
    bull += 10 * weekWeight
    reasons.push(`+${change5d.toFixed(0)}% over 5 days`)
  } else if (change5d < -12) {
    bear += 18 * weekWeight
    reasons.push(`${change5d.toFixed(0)}% over 5 days`)
  } else if (change5d < -6) {
    bear += 10 * weekWeight
    reasons.push(`${change5d.toFixed(0)}% over 5 days`)
  }

  // ── ROC10 — already-in-motion signal ────────────────────
  if (t.roc10 > 8 && t.rocSignal === 'accelerating') {
    bull += 10
    if (reasons.length < 5) reasons.push(`ROC10 +${t.roc10.toFixed(1)}% accelerating`)
  } else if (t.roc10 > 5) {
    bull += 6
  } else if (t.roc10 < -8 && t.rocSignal === 'accelerating') {
    bear += 10
    if (reasons.length < 5) reasons.push(`ROC10 ${t.roc10.toFixed(1)}% accelerating down`)
  } else if (t.roc10 < -5) {
    bear += 6
  }

  // ── MACD fresh cross — clean trigger ────────────────────
  if (t.macdCrossover === 'bullish') {
    bull += 8
    if (reasons.length < 5) reasons.push('MACD just crossed bullish')
  } else if (t.macdCrossover === 'bearish') {
    bear += 8
    if (reasons.length < 5) reasons.push('MACD just crossed bearish')
  }

  // ── BB expansion — vol just unlocked ────────────────────
  if (t.bbSignal === 'expansion') {
    if (todayMove > 0) {
      bull += 6
      if (reasons.length < 5) reasons.push('Bollinger expansion up')
    } else if (todayMove < 0) {
      bear += 6
      if (reasons.length < 5) reasons.push('Bollinger expansion down')
    }
  }

  // ── Pure volume surge with no direction yet — small hint ─
  if (volRatio >= 2.5 && Math.abs(todayMove) < 1) {
    // Big volume, no move yet — interest building
    bull += 3
    bear += 3
    if (reasons.length < 5) reasons.push(`Heavy volume ${volRatio.toFixed(1)}x but flat — interest building`)
  }

  const diff = bull - bear
  const absStrength = Math.abs(diff)
  // Typical cap is ~80, normalize to 0-100
  const score = Math.max(0, Math.min(100, Math.round((absStrength / 80) * 100)))
  const bullSign = diff > 4 ? 1 : diff < -4 ? -1 : 0

  return { score, bullSign, reasons }
}

// ═════════════════════════════════════════════════════════════
// Coiled potential — about to move
// ═════════════════════════════════════════════════════════════
//
// Signals:
//   - Bollinger squeeze (compression — quiet now, big move coming)
//   - Low ATR% with quiet price action (consolidation)
//   - Volume drying up (often precedes resolution)
//   - Price near key resistance with bullish lean
//   - Price near key support with bearish lean
//   - Tight chart pattern (ascending triangle, bull/bear flag)

interface CoiledResult {
  score: number              // 0-100
  bullSign: number           // -1 / 0 / +1 (lean direction if any)
  reasons: string[]
}

function scoreCoiledPotential(
  t: TechnicalSignals,
  horizon: Horizon,
): CoiledResult {
  let strength = 0
  let bullLean = 0
  let bearLean = 0
  const reasons: string[] = []

  // Coiled signals are most actionable on week horizon
  // (day-trades often want stuff already moving).
  const horizonMod = horizon === 'week' ? 1.0 : 0.7

  // ── Bollinger squeeze — primary coiled signal ───────────
  if (t.bbSignal === 'squeeze') {
    strength += 35 * horizonMod
    reasons.push(`Bollinger squeeze (BBW ${(t.bbWidth * 100).toFixed(1)}%)`)

    // Direction lean: where in the band is price sitting?
    if (t.bbPosition >= 0.65) {
      bullLean += 1
    } else if (t.bbPosition <= 0.35) {
      bearLean += 1
    }
  }

  // ── Low ATR after consolidation — quiet base ────────────
  if (t.atrSignal === 'low_volatility' && t.bbSignal !== 'expansion') {
    strength += 15 * horizonMod
    if (reasons.length < 5) reasons.push(`Low volatility (ATR ${t.atrPct.toFixed(1)}% of price)`)
  }

  // ── Volume drying up — often precedes a break ───────────
  if (t.volumeRatio < 0.7 && t.bbSignal === 'squeeze') {
    strength += 10 * horizonMod
    if (reasons.length < 5) reasons.push(`Volume drying up (${t.volumeRatio.toFixed(1)}x)`)
  }

  // ── Near resistance with bullish trend lean ─────────────
  // distFromHigh small + above key MAs + decent recent action
  if (t.distFromHigh < 5 && t.priceVsSma50 > 0 && t.priceVsSma20 > 0) {
    strength += 12 * horizonMod
    bullLean += 1
    if (reasons.length < 5) reasons.push(`${t.distFromHigh.toFixed(1)}% from 52w high — coiled near resistance`)
  }

  // ── Near support with bearish lean ──────────────────────
  if (t.distFromLow < 5 && t.priceVsSma50 < 0 && t.priceVsSma20 < 0) {
    strength += 12 * horizonMod
    bearLean += 1
    if (reasons.length < 5) reasons.push(`${t.distFromLow.toFixed(1)}% from 52w low — coiled near support`)
  }

  // ── Bull/bear flags or triangles ────────────────────────
  if (t.chartPattern) {
    const pat = t.chartPattern
    if (pat.type === 'bullish' && /flag|triangle/i.test(pat.name)) {
      strength += 10
      bullLean += 1
      if (reasons.length < 5) reasons.push(`${pat.name} — coiled continuation`)
    } else if (pat.type === 'bearish' && /flag|triangle/i.test(pat.name)) {
      strength += 10
      bearLean += 1
      if (reasons.length < 5) reasons.push(`${pat.name} — coiled breakdown`)
    }
  }

  const score = Math.max(0, Math.min(100, Math.round(strength)))
  const bullSign = bullLean > bearLean ? 1 : bearLean > bullLean ? -1 : 0

  return { score, bullSign, reasons }
}

// ═════════════════════════════════════════════════════════════
// Setup quality — discount / bonus modifiers
// ═════════════════════════════════════════════════════════════
//
// These adjust both raw scores up or down based on contextual quality.
//
//   + Cleaner setups (above all MAs, no recent gap)
//   - Penalize extreme RSI (chasing exhausted moves)
//   - Penalize hyper-volatility ($-tier penny stock chop)

function scoreSetupQuality(t: TechnicalSignals): { quality: number; notes: string[] } {
  let q = 50
  const notes: string[] = []

  // RSI extremes — chasing late
  if (t.rsi > 80) {
    q -= 18
    notes.push(`RSI ${t.rsi.toFixed(0)} extreme — chasing risk`)
  } else if (t.rsi < 20) {
    q -= 14
    notes.push(`RSI ${t.rsi.toFixed(0)} extreme — falling-knife risk`)
  } else if (t.rsi > 70 || t.rsi < 30) {
    q -= 6
  }

  // Hyper-volatile — penny-stock chop
  if (t.atrPct > 10) {
    q -= 14
    notes.push(`ATR ${t.atrPct.toFixed(1)}% — extreme chop`)
  } else if (t.atrPct > 6) {
    q -= 6
  }

  // Aligned with longer trend = bonus
  if (t.priceVsSma200 > 0 && t.priceVsSma50 > 0 && t.priceVsSma20 > 0) {
    q += 12
  } else if (t.priceVsSma200 < 0 && t.priceVsSma50 < 0 && t.priceVsSma20 < 0) {
    q += 12
  }

  // Recent unresolved gap — adds risk
  if (t.gapPattern && Math.abs(t.priceChange1D) > 3) {
    q -= 4
  }

  return { quality: Math.max(0, Math.min(100, Math.round(q))), notes }
}

// ═════════════════════════════════════════════════════════════
// Main entrypoint
// ═════════════════════════════════════════════════════════════

export function scoreMomentum(input: MomentumScoreInput): MomentumScoreResult {
  const { technicals: t, horizon, change5d } = input

  const active = scoreActiveMomentum(t, change5d, horizon)
  const coiled = scoreCoiledPotential(t, horizon)
  const quality = scoreSetupQuality(t)

  // Combine the two raw scores. We don't add — we want the BETTER
  // signal to drive the score, with a small bonus when both agree.
  const better = Math.max(active.score, coiled.score)
  const both = Math.min(active.score, coiled.score)
  let raw = better + both * 0.25

  // Quality multiplier — 0.7x at quality=20, 1.15x at quality=80
  const qMult = 0.7 + (quality.quality / 100) * 0.6
  raw = raw * qMult

  const score = Math.max(0, Math.min(100, Math.round(raw)))

  // Determine setup type from which sub-score dominates
  let setupType: SetupType
  if (active.score >= coiled.score + 20) {
    // Active dominates — is it a fresh breakout or just continuation?
    setupType = t.bbSignal === 'expansion' || t.macdCrossover !== 'none'
      ? 'breakout'
      : 'continuation'
  } else if (coiled.score >= active.score + 10) {
    setupType = 'coiled'
  } else {
    setupType = 'mixed'
  }

  // Direction — prefer active if strong, else coiled lean
  let direction: 'bullish' | 'bearish' | 'unclear'
  if (active.score >= 25 && active.bullSign !== 0) {
    direction = active.bullSign > 0 ? 'bullish' : 'bearish'
  } else if (coiled.bullSign !== 0) {
    direction = coiled.bullSign > 0 ? 'bullish' : 'bearish'
  } else {
    direction = 'unclear'
  }

  // Combined reasons — interleave, dedupe, cap at 5
  const reasonSet = new Set<string>()
  const allReasons = [...active.reasons, ...coiled.reasons, ...quality.notes]
  const reasons: string[] = []
  for (const r of allReasons) {
    if (!reasonSet.has(r)) {
      reasonSet.add(r)
      reasons.push(r)
      if (reasons.length >= 5) break
    }
  }

  return {
    score,
    setupType,
    direction,
    reasons,
    parts: {
      activeMomentum: active.score,
      coiledPotential: coiled.score,
      setupQuality: quality.quality,
    },
  }
}

// ═════════════════════════════════════════════════════════════
// Liquidity classification
// ═════════════════════════════════════════════════════════════
//
// Computes dollar volume from the technicals struct and returns a
// human-readable badge. No filtering — the user asked for "no floor"
// so we surface this as information, not a gate.

export type LiquidityTier = 'high' | 'moderate' | 'low' | 'illiquid'

export interface LiquidityInfo {
  /** Today's dollar volume = lastVolume × currentPrice */
  dollarVolumeToday: number
  /** 20-day average dollar volume = avgVolume20 × currentPrice */
  avgDollarVolume: number
  tier: LiquidityTier
  /** Short label like "$3.2M/day" suitable for a UI badge */
  label: string
}

export function computeLiquidity(t: TechnicalSignals): LiquidityInfo {
  const dollarVolumeToday = (t.lastVolume ?? 0) * (t.currentPrice ?? 0)
  const avgDollarVolume = (t.avgVolume20 ?? 0) * (t.currentPrice ?? 0)

  // Classify on AVERAGE dollar volume — today might be a one-off spike.
  let tier: LiquidityTier
  if (avgDollarVolume >= 5_000_000) tier = 'high'
  else if (avgDollarVolume >= 1_000_000) tier = 'moderate'
  else if (avgDollarVolume >= 250_000) tier = 'low'
  else tier = 'illiquid'

  // Build short label
  const formatM = (n: number): string => {
    if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B/day`
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M/day`
    if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K/day`
    return `$${n.toFixed(0)}/day`
  }

  return {
    dollarVolumeToday: Math.round(dollarVolumeToday),
    avgDollarVolume: Math.round(avgDollarVolume),
    tier,
    label: formatM(avgDollarVolume),
  }
}
