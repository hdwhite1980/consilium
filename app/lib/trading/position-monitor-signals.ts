// =============================================================
// app/lib/trading/position-monitor-signals.ts
//
// Pure functions that take TechnicalSignals output (from
// calculateTechnicals) and return bearish/bullish signal counts
// for use by the position-monitor cron's rule engine.
//
// No DB, no side effects, no LLM. Easy to unit-test.
//
// Each signal is a discrete check that returns boolean. The total
// count is what the rule engine uses to decide HOLD/TIGHTEN/EXIT.
// =============================================================

import type { TechnicalSignals } from '@/app/lib/signals/technicals'

export type Side = 'buy' | 'sell'

export interface SignalSnapshot {
  /** Total count of bearish signals (for a long position) — also = bullish count for short positions */
  bearishCount: number
  /** Total count of bullish signals (for a long position) */
  bullishCount: number
  /** Names of the bearish signals that fired (e.g. 'macd_bearish_cross') */
  bearishSignals: string[]
  /** Names of the bullish signals that fired */
  bullishSignals: string[]
}

// ─────────────────────────────────────────────────────────────
// Main scoring function
// ─────────────────────────────────────────────────────────────

/**
 * Count discrete bearish/bullish signals from a TechnicalSignals object.
 *
 * For a LONG position, "bearish" signals are the ones we care about for exit.
 * For a SHORT position, "bullish" signals would matter (we don't currently
 * short stocks, but the function is symmetric so it's future-proof).
 *
 * The caller decides what to do with the counts.
 */
export function countSignals(t: TechnicalSignals, side: Side): SignalSnapshot {
  const bearishSignals: string[] = []
  const bullishSignals: string[] = []

  // ─── BEARISH SIGNALS (relevant for long positions) ───

  // 1. MACD bearish crossover (the most-watched MACD signal)
  if (t.macdCrossover === 'bearish') {
    bearishSignals.push('macd_bearish_cross')
  }

  // 2. MACD histogram negative (momentum has flipped)
  // Different from #1 — histogram can be negative even without a fresh cross
  if (t.macdHistogram < 0) {
    bearishSignals.push('macd_histogram_negative')
  }

  // 3. Price broke below SMA20 (short-term trend break)
  if (t.priceVsSma20 < 0) {
    bearishSignals.push('below_sma20')
  }

  // 4. RSI overbought signal (rejection from extreme)
  // We don't fire this on plain "overbought" because that can persist for days
  // in strong uptrends. Only fire when RSI is dropping out of overbought.
  if (t.rsiSignal === 'overbought' && t.rsi < 75) {
    // Was overbought-territory, now coming back down
    bearishSignals.push('rsi_overbought_rejection')
  }

  // 5. Stochastic bearish crossover
  if (t.stochCrossover === 'bearish') {
    bearishSignals.push('stoch_bearish_cross')
  }

  // 6. Support break (close below identified support level)
  // We only fire if support is materially above the current price
  // (avoids firing on stocks that have no clear support)
  if (t.support > 0 && t.currentPrice < t.support && (t.support - t.currentPrice) / t.support > 0.005) {
    bearishSignals.push('support_break')
  }

  // 7. Bollinger Bands: price closed below the lower band (extreme weakness)
  // Don't fire if BB squeeze (low vol = unreliable signal)
  if (t.currentPrice < t.bbLower && t.bbSignal !== 'squeeze') {
    bearishSignals.push('below_bb_lower')
  }

  // 8. VWAP — price below VWAP signals institutional selling pressure
  if (t.vwapSignal === 'below' && t.priceVsVwap < -1) {
    bearishSignals.push('below_vwap')
  }

  // 9. EMA9 crossed below EMA20 (fast bearish cross — very short-term)
  if (t.ema9CrossEma20 === 'bearish') {
    bearishSignals.push('ema9_cross_ema20_bearish')
  }

  // 10. OBV (volume-weighted) showing distribution
  if (t.obvDivergence === 'bearish') {
    bearishSignals.push('obv_bearish_divergence')
  }

  // ─── BULLISH SIGNALS (used for "should we hold" confirmation) ───

  if (t.macdCrossover === 'bullish') {
    bullishSignals.push('macd_bullish_cross')
  }
  if (t.macdHistogram > 0) {
    bullishSignals.push('macd_histogram_positive')
  }
  if (t.priceVsSma20 > 0) {
    bullishSignals.push('above_sma20')
  }
  if (t.priceVsSma50 > 0) {
    bullishSignals.push('above_sma50')
  }
  if (t.stochCrossover === 'bullish') {
    bullishSignals.push('stoch_bullish_cross')
  }
  if (t.vwapSignal === 'above' && t.priceVsVwap > 1) {
    bullishSignals.push('above_vwap')
  }
  if (t.ema9CrossEma20 === 'bullish') {
    bullishSignals.push('ema9_cross_ema20_bullish')
  }
  if (t.ichimokuSignal === 'above_cloud') {
    bullishSignals.push('above_ichimoku_cloud')
  }
  if (t.obvTrend === 'rising') {
    bullishSignals.push('obv_rising')
  }
  if (t.candlePattern?.type === 'bullish') {
    bullishSignals.push(`candle_${t.candlePattern.name.toLowerCase().replace(/\s+/g, '_')}`)
  }

  // For SHORT positions, invert: bullish signals become "exit" relevant.
  // We don't currently take short stock positions, but flip the lists if/when we do.
  if (side === 'sell') {
    return {
      bearishCount: bullishSignals.length,
      bullishCount: bearishSignals.length,
      bearishSignals: bullishSignals,
      bullishSignals: bearishSignals,
    }
  }

  return {
    bearishCount: bearishSignals.length,
    bullishCount: bullishSignals.length,
    bearishSignals,
    bullishSignals,
  }
}

// ─────────────────────────────────────────────────────────────
// Decision rule engine
// ─────────────────────────────────────────────────────────────

export type Decision = 'HOLD' | 'TIGHTEN_STOP' | 'EXIT' | 'ESCALATE'

export interface DecisionInputs {
  snap5m: SignalSnapshot
  snap15m: SignalSnapshot
  tightenThreshold15m: number
  exitThreshold15m: number
  exitThreshold5m: number
  escalateOnConflict: boolean
}

export interface DecisionResult {
  decision: Decision
  reason: string
}

/**
 * Decide HOLD / TIGHTEN_STOP / EXIT / ESCALATE based on signal counts
 * across two timeframes. See spec in DEPLOY.md for the tiers.
 *
 * Returns the decision plus a one-line reason for the log.
 *
 * Rule order (first match wins):
 *   1. STRONG BULLISH OVERRIDE — if 15m has u15-b15 >= 2 AND u15 >= 4, the
 *      trend is fundamentally intact on the swing-trade timeframe. Bearish
 *      5m signals are noise within a strong uptrend. HOLD regardless of
 *      ANY bearish counts. This is checked BEFORE EXIT paths.
 *   2. EXIT  — overwhelming bearish (multi-TF or single-TF dominance)
 *   3. WEAK BULLISH OVERRIDE — 15m dominance >= 2 but u15 < 4 (decent but
 *      not strong). Holds if no EXIT fired above.
 *   4. ESCALATE — mixed signals (one TF bearish, other TF bullish), ask Council
 *   5. TIGHTEN_STOP — 15m bearish meets threshold, no override
 *   6. HOLD — everything else
 *
 * History (June 22, 2026 — KLAC bug):
 * v2 of this rule engine had bullish-override AFTER both EXIT paths. KLAC at
 * b15=1, u15=5, b5=4, u5=3 hit the b5 >= exitThreshold5m branch and fired
 * EXIT, even though the 15m was overwhelmingly bullish (5 vs 1, dominance +4).
 * Result: position was exited 6 minutes after market close, queueing a market
 * sell for Monday open and cancelling protective brackets. v3 fixes this by
 * checking strong bullish override BEFORE the single-TF 5m EXIT path. The
 * cron also adds a "no EXIT actions in last 5 min of trading" guard.
 */
export function decide(inputs: DecisionInputs): DecisionResult {
  const {
    snap5m, snap15m,
    tightenThreshold15m, exitThreshold15m, exitThreshold5m,
    escalateOnConflict,
  } = inputs

  const b5 = snap5m.bearishCount
  const b15 = snap15m.bearishCount
  const u5 = snap5m.bullishCount
  const u15 = snap15m.bullishCount

  // ── STRONG BULLISH OVERRIDE — check FIRST, before any EXIT path ──
  // The 15m is the primary swing-trade timeframe. If it shows strong bullish
  // structure (dominance >= 2 AND at least 4 bullish signals in absolute terms),
  // the trend is intact and a 5m bearish flurry is noise, not signal.
  // Don't let single-TF 5m exits fire under these conditions.
  //
  // The "u15 >= 4" guard prevents false override on low-volume periods where
  // dominance might be high in relative terms but the absolute bullish signal
  // count is weak (e.g. u15=3, b15=1, dominance=2 — not really strong, just
  // quiet).
  const dominance15m = u15 - b15
  const strongBullish15m = dominance15m >= 2 && u15 >= 4
  if (strongBullish15m) {
    return {
      decision: 'HOLD',
      reason: `15m strongly bullish: ${u15} bullish vs ${b15} bearish (dom +${dominance15m}); 5m noise (b=${b5}, u=${u5}) ignored`,
    }
  }

  // ── EXIT — overwhelming bearish on one timeframe, or multi-TF confirmation ──
  if (b15 >= exitThreshold15m && b5 >= 2) {
    return { decision: 'EXIT', reason: `multi-TF bearish: 5m=${b5}, 15m=${b15}` }
  }
  if (b5 >= exitThreshold5m) {
    return { decision: 'EXIT', reason: `5m overwhelming bearish: ${b5} signals (15m: ${b15}b/${u15}u — not strong enough to override)` }
  }

  // ── WEAK BULLISH OVERRIDE — dominance >= 2 but u15 < 4 ──
  // Decent bullish but not strong. Still holds (no EXIT fired above means
  // bearish wasn't overwhelming either).
  if (dominance15m >= 2) {
    return {
      decision: 'HOLD',
      reason: `15m net bullish: ${u15} bullish vs ${b15} bearish (+${dominance15m})`,
    }
  }

  // ── ESCALATE — mixed/ambiguous signals across timeframes ──
  // After the bullish override, ambiguous = bearish meets threshold AND bullish
  // is close behind (dominance is +1 or 0, not enough for override but enough
  // to warrant Council reasoning instead of mechanical tighten).
  if (escalateOnConflict) {
    // Case A: 15m bearish at threshold AND 5m clearly bullish — TFs disagree
    const fifteenBearishButFiveBullish = b15 >= tightenThreshold15m && u5 >= 3
    // Case B: 5m strongly bearish AND 15m clearly bullish — TFs disagree
    const fiveBearishButFifteenBullish = b5 >= 3 && u15 >= 3
    // Case C: 15m bearish meets threshold AND bullish nearly matches it on 15m
    // (dominance is +1 or 0, escapes the >=2 override but still ambiguous)
    const fifteenAmbiguous = b15 >= tightenThreshold15m && (u15 >= b15 || u15 === b15 - 1) && u15 >= 2
    if (fifteenBearishButFiveBullish || fiveBearishButFifteenBullish || fifteenAmbiguous) {
      return {
        decision: 'ESCALATE',
        reason: `mixed signals: 5m b=${b5}/u=${u5}, 15m b=${b15}/u=${u15}`,
      }
    }
  }

  // ── TIGHTEN_STOP — 15m showing real weakness, no bullish counterweight ──
  if (b15 >= tightenThreshold15m) {
    return {
      decision: 'TIGHTEN_STOP',
      reason: `15m weakening: ${b15} bearish vs ${u15} bullish (dominance ${dominance15m})`,
    }
  }

  // ── HOLD — everything else ──
  if (b5 >= 2) {
    return { decision: 'HOLD', reason: `5m noise (${b5} bearish), 15m fine (${b15})` }
  }
  return { decision: 'HOLD', reason: `quiet: 5m=${b5}, 15m=${b15}` }
}

// ─────────────────────────────────────────────────────────────
// Trailing stop — milestone-based gain locking
// ─────────────────────────────────────────────────────────────

export interface TrailingStopInputs {
  side: 'buy' | 'sell'
  entryPrice: number      // filled_avg_price or entry_price_est
  currentPrice: number    // live broker price
  currentStop: number     // current stop (may have been tightened previously)
  originalStop: number    // verdict's original stop (immutable reference)
}

export interface TrailingStopResult {
  newStop: number
  milestone: '1R_breakeven' | '1_5R_lock_half' | '2R_lock_half' | '3R_lock_1_5R' | '4R_trail_1R'
  gainR: number
  reason: string
}

/**
 * Compute milestone-based trailing stop.
 *
 * Uses R-unit math where R = entryPrice - originalStop (per share risk taken
 * when entering). Milestones:
 *
 *   +1R gain → stop to breakeven (entry)
 *   +2R gain → stop to entry + 0.5R (lock half the gain)
 *   +3R gain → stop to entry + 1.5R (lock most of the gain)
 *   +4R+gain → trail by 1R below current (true trailing)
 *
 * Only moves stop UP (longs) or DOWN (shorts) — never the other direction.
 * Returns null when no milestone is crossed OR when the milestone's stop
 * isn't tighter than current.
 *
 * Defensive checks: skip if originalStop is invalid, riskPerShare is <0.1%
 * of entry (would cause noisy/runaway behavior), or any math goes NaN.
 */
export function computeTrailingStop(inputs: TrailingStopInputs): TrailingStopResult | null {
  const { side, entryPrice, currentPrice, currentStop, originalStop } = inputs

  if (side !== 'buy') {
    // Trailing for short positions is the mirror; we don't currently trade shorts,
    // so skip rather than risk wrong math. Future: implement sell-side mirror.
    return null
  }

  if (!Number.isFinite(entryPrice) || entryPrice <= 0 ||
      !Number.isFinite(currentPrice) || currentPrice <= 0 ||
      !Number.isFinite(currentStop) || currentStop <= 0 ||
      !Number.isFinite(originalStop) || originalStop <= 0) {
    return null
  }

  const riskPerShare = entryPrice - originalStop
  if (riskPerShare <= 0) {
    // Original stop wasn't below entry — broken data or short position miscoded
    return null
  }
  const riskPctOfEntry = riskPerShare / entryPrice
  if (riskPctOfEntry < 0.001) {
    // Stop too tight to entry — math would amplify noise into runaway trailing
    return null
  }

  const gainDollars = currentPrice - entryPrice
  if (gainDollars <= 0) {
    // Position not in profit yet — nothing to trail
    return null
  }
  const gainR = gainDollars / riskPerShare

  let proposedStop: number
  let milestone: TrailingStopResult['milestone']

  if (gainR >= 4) {
    // True trailing — stop sits 1R below current price
    proposedStop = currentPrice - riskPerShare
    milestone = '4R_trail_1R'
  } else if (gainR >= 3) {
    // Lock +1.5R gain
    proposedStop = entryPrice + (riskPerShare * 1.5)
    milestone = '3R_lock_1_5R'
  } else if (gainR >= 2) {
    // Lock +0.5R gain
    proposedStop = entryPrice + (riskPerShare * 0.5)
    milestone = '2R_lock_half'
  } else if (gainR >= 1.5) {
    // Lock +0.5R gain — closes the gap where +1R–+2R sat at breakeven and a
    // trade that ran to ~+1.8R then reversed gave back the entire gain.
    proposedStop = entryPrice + (riskPerShare * 0.5)
    milestone = '1_5R_lock_half'
  } else if (gainR >= 1) {
    // Move to breakeven
    proposedStop = entryPrice
    milestone = '1R_breakeven'
  } else {
    return null
  }

  // Only move stop UP — never widen
  if (proposedStop <= currentStop) return null

  // Sanity: don't propose a stop above current price minus a tiny buffer
  // (would be an instant-fill). 0.3% buffer matches applyTighten's minDistance.
  const maxAllowedStop = currentPrice * 0.997
  if (proposedStop >= maxAllowedStop) {
    proposedStop = maxAllowedStop
    // Recheck after clamp
    if (proposedStop <= currentStop) return null
  }

  return {
    newStop: proposedStop,
    milestone,
    gainR,
    reason: `trailing ${milestone} at +${gainR.toFixed(2)}R gain: stop ${currentStop.toFixed(2)} → ${proposedStop.toFixed(2)}`,
  }
}
