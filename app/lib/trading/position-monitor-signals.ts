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

  // EXIT — overwhelming bearish on one timeframe, or multi-TF confirmation
  if (b15 >= exitThreshold15m && b5 >= 2) {
    return { decision: 'EXIT', reason: `multi-TF bearish: 5m=${b5}, 15m=${b15}` }
  }
  if (b5 >= exitThreshold5m) {
    return { decision: 'EXIT', reason: `5m overwhelming bearish: ${b5} signals` }
  }

  // ESCALATE — mixed signals across timeframes, ambiguous
  // Definition of "mixed": one TF strongly bearish AND the other clearly bullish
  if (escalateOnConflict) {
    const fifteenBearishButFiveBullish = b15 >= tightenThreshold15m && u5 >= 3
    const fiveBearishButFifteenBullish = b5 >= 3 && u15 >= 3
    if (fifteenBearishButFiveBullish || fiveBearishButFifteenBullish) {
      return {
        decision: 'ESCALATE',
        reason: `mixed signals: 5m b=${b5}/u=${u5}, 15m b=${b15}/u=${u15}`,
      }
    }
  }

  // TIGHTEN_STOP — 15m showing weakness (2+) but not enough to exit
  if (b15 >= tightenThreshold15m) {
    return { decision: 'TIGHTEN_STOP', reason: `15m weakening: ${b15} bearish signals` }
  }

  // HOLD — everything else
  if (b5 >= 2) {
    return { decision: 'HOLD', reason: `5m noise (${b5} bearish), 15m fine (${b15})` }
  }
  return { decision: 'HOLD', reason: `quiet: 5m=${b5}, 15m=${b15}` }
}
