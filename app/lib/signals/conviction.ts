// ─────────────────────────────────────────────────────────────
// PHASE 5 — Conviction Engine
// Regime detection, narrative scoring, signal convergence,
// invalidation triggers, and 3-scenario probability output
// ─────────────────────────────────────────────────────────────

import type { TechnicalSignals } from './technicals'
import type { FundamentalSignals } from './fundamentals'
import type { SmartMoneySignals } from './smart-money'
import type { OptionsFlowSignals } from './options-flow'
import type { MarketContext } from './market-context'

export interface ConvictionOutput {
  // Regime
  regime: string
  regimeAdjustment: number    // multiplier applied to all signals (-1 to +1)

  // Signal convergence matrix
  signals: SignalRow[]
  convergenceScore: number    // -100 to +100
  convergingSignals: number   // count of signals pointing same direction
  divergingSignals: number

  // Final conviction
  conviction: 'very_high' | 'high' | 'moderate' | 'low' | 'mixed'
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidencePct: number

  // Three scenarios
  scenarios: Scenario[]

  // Invalidation trigger — what makes this thesis wrong
  invalidationTrigger: string
  invalidationConditions: string[]

  // Narrative momentum
  narrative: string
  narrativePhase: 'early' | 'middle' | 'late' | 'exhausted'

  // Summary for AI judge
  summary: string
}

export interface SignalRow {
  category: string
  signal: string
  direction: 'bullish' | 'bearish' | 'neutral'
  weight: number       // 1-10 importance
  score: number        // -10 to +10
}

export interface Scenario {
  label: 'bull' | 'base' | 'bear'
  probability: number     // 0-100
  priceTarget: string
  timeframe: string
  trigger: string
  description: string
}

// ── Regime Adjustments ────────────────────────────────────────
// In a bear regime, bullish signals are discounted
// In a bull regime, bearish signals are discounted
const REGIME_MULTIPLIERS: Record<string, number> = {
  risk_on_bull:      0.3,    // add 30% to bullish score
  risk_on_volatile:  0.1,
  neutral:           0,
  risk_off_bear:    -0.2,   // subtract 20% from bullish score
  high_fear:        -0.4,
}

export function buildConvictionOutput(
  ticker: string,
  currentPrice: number,
  technicals: TechnicalSignals,
  fundamentals: FundamentalSignals,
  smartMoney: SmartMoneySignals,
  optionsFlow: OptionsFlowSignals,
  market: MarketContext,
  timeframe = '1W',
): ConvictionOutput {
  // Weight multipliers per timeframe
  // 1D = intraday: technicals dominate, fundamentals near-irrelevant
  // 1W = swing: balanced with slight technical lean
  // 1M = position: equal weight
  // 3M = investment: fundamentals and smart money dominate
  const tw = {
    '1D': { tech: 1.6, fund: 0.2, smart: 0.3, options: 1.2 },
    '1W': { tech: 1.2, fund: 0.7, smart: 0.8, options: 1.0 },
    '1M': { tech: 1.0, fund: 1.0, smart: 1.0, options: 0.9 },
    '3M': { tech: 0.6, fund: 1.5, smart: 1.4, options: 0.6 },
  }[timeframe] ?? { tech: 1.0, fund: 1.0, smart: 1.0, options: 1.0 }

  // ── Build signal matrix ───────────────────────────────────
  const signals: SignalRow[] = []
  const add = (category: string, signal: string, direction: 'bullish'|'bearish'|'neutral', weight: number, score: number) =>
    signals.push({ category, signal, direction, weight, score })

  // Timeframe weight multipliers
  const tw_tech  = tw.tech
  const tw_fund  = tw.fund
  const tw_smart = tw.smart
  const tw_opts  = tw.options

  // Technical signals (weight 8)
  add('Technical', `RSI ${technicals.rsi.toFixed(0)} — ${technicals.rsiSignal}`,
    technicals.rsiSignal === 'oversold' ? 'bullish' : technicals.rsiSignal === 'overbought' ? 'bearish' : 'neutral', 8,
    technicals.rsiSignal === 'oversold' ? 6 : technicals.rsiSignal === 'overbought' ? -4 : 0)

  add('Technical', `MACD ${technicals.macdCrossover !== 'none' ? technicals.macdCrossover + ' crossover' : technicals.macdHistogram > 0 ? 'positive hist' : 'negative hist'}`,
    technicals.macdHistogram > 0 ? 'bullish' : 'bearish', 7,
    technicals.macdCrossover === 'bullish' ? 8 : technicals.macdCrossover === 'bearish' ? -8 : technicals.macdHistogram > 0 ? 4 : -4)

  add('Technical', `${technicals.goldenCross ? 'Golden cross' : 'Death cross'} (SMA50 vs SMA200)`,
    technicals.goldenCross ? 'bullish' : 'bearish', 9,
    technicals.goldenCross ? 7 : -7)

  add('Technical', `Price vs SMA200: ${technicals.priceVsSma200 >= 0 ? '+' : ''}${technicals.priceVsSma200.toFixed(1)}%`,
    technicals.priceVsSma200 > 0 ? 'bullish' : 'bearish', 8,
    Math.max(-8, Math.min(8, technicals.priceVsSma200 / 5)))

  add('Technical', `Volume: ${technicals.volumeRatio.toFixed(1)}x avg — ${technicals.volumeSignal}`,
    technicals.volumeSignal === 'high' && technicals.priceChange1D > 0 ? 'bullish' :
    technicals.volumeSignal === 'high' && technicals.priceChange1D < 0 ? 'bearish' : 'neutral', 6,
    technicals.volumeSignal === 'high' ? (technicals.priceChange1D > 0 ? 5 : -5) : 0)

  add('Technical', `Bollinger: ${technicals.bbSignal} (position ${(technicals.bbPosition*100).toFixed(0)}%)`,
    technicals.bbSignal === 'squeeze' ? 'bullish' : technicals.bbPosition > 0.85 ? 'bearish' : technicals.bbPosition < 0.15 ? 'bullish' : 'neutral', 5,
    technicals.bbSignal === 'squeeze' ? 4 : technicals.bbPosition > 0.85 ? -3 : technicals.bbPosition < 0.15 ? 3 : 0)

  // Fundamental signals (weight 7)
  if (fundamentals.analystConsensus !== 'unknown') {
    const aScore = { strong_buy: 8, buy: 5, hold: 0, sell: -5, strong_sell: -8 }[fundamentals.analystConsensus]
    add('Fundamental', `Analyst consensus: ${fundamentals.analystConsensus.replace('_',' ')}`,
      aScore > 0 ? 'bullish' : aScore < 0 ? 'bearish' : 'neutral', 7, aScore)
  }
  if (fundamentals.analystUpside !== null) {
    add('Fundamental', `Analyst target: ${fundamentals.analystUpside >= 0 ? '+' : ''}${fundamentals.analystUpside.toFixed(1)}% upside`,
      fundamentals.analystUpside > 10 ? 'bullish' : fundamentals.analystUpside < -10 ? 'bearish' : 'neutral', 6,
      Math.max(-7, Math.min(7, fundamentals.analystUpside / 5)))
  }
  if (fundamentals.consistentBeater) {
    add('Fundamental', `Consistent EPS beater (${fundamentals.avgSurprisePct !== null ? '+'+fundamentals.avgSurprisePct.toFixed(1)+'% avg' : ''})`,
      'bullish', 6, 5)
  }
  if (fundamentals.earningsRisk === 'high') {
    add('Fundamental', `Earnings in <7 days — binary event risk`,
      'neutral', 8, 0) // neutral but high uncertainty
  }
  if (fundamentals.recentUpgrades.length > fundamentals.recentDowngrades.length) {
    add('Fundamental', `${fundamentals.recentUpgrades.length} analyst upgrades vs ${fundamentals.recentDowngrades.length} downgrades (90d)`,
      'bullish', 7, 5)
  } else if (fundamentals.recentDowngrades.length > fundamentals.recentUpgrades.length) {
    add('Fundamental', `${fundamentals.recentDowngrades.length} analyst downgrades vs ${fundamentals.recentUpgrades.length} upgrades (90d)`,
      'bearish', 7, -5)
  }

  // Smart money signals (weight 9)
  const insiderScores = { strong_buy: 9, buy: 5, neutral: 0, sell: -5, strong_sell: -9 }
  add('Smart Money', `Insider signal: ${smartMoney.insiderSignal.replace('_',' ')}`,
    smartMoney.insiderSignal.includes('buy') ? 'bullish' : smartMoney.insiderSignal.includes('sell') ? 'bearish' : 'neutral',
    9, insiderScores[smartMoney.insiderSignal])

  if (smartMoney.congressSignal !== 'none') {
    add('Smart Money', `Congress is ${smartMoney.congressSignal}`,
      smartMoney.congressSignal === 'buying' ? 'bullish' : 'bearish', 6,
      smartMoney.congressSignal === 'buying' ? 4 : -4)
  }

  // Options signals (weight 8)
  if (optionsFlow.putCallRatio !== null) {
    add('Options', `P/C ratio ${optionsFlow.putCallRatio.toFixed(2)} — ${optionsFlow.putCallSignal}`,
      optionsFlow.putCallSignal, 8,
      optionsFlow.putCallSignal === 'bullish' ? 6 : optionsFlow.putCallSignal === 'bearish' ? -6 : 0)
  }
  if (optionsFlow.unusualActivity.length > 0) {
    const bullSweeps = optionsFlow.unusualActivity.filter(u => u.signal === 'bullish_sweep').length
    const bearSweeps = optionsFlow.unusualActivity.filter(u => u.signal === 'bearish_sweep').length
    if (bullSweeps > 0 || bearSweeps > 0) {
      add('Options', `${bullSweeps} bullish / ${bearSweeps} bearish unusual sweeps`,
        bullSweeps > bearSweeps ? 'bullish' : bearSweeps > bullSweeps ? 'bearish' : 'neutral', 9,
        (bullSweeps - bearSweeps) * 3)
    }
  }
  if (optionsFlow.shortSignal === 'squeeze_candidate') {
    add('Options', `Short squeeze candidate (${optionsFlow.shortInterestPct?.toFixed(0)}% float short)`,
      'bullish', 7, 6)
  } else if (optionsFlow.shortSignal === 'heavily_shorted') {
    add('Options', `Heavily shorted (${optionsFlow.shortInterestPct?.toFixed(0)}% float)`,
      'bearish', 6, -4)
  }

  // Market context (weight 6)
  const regimeScore = REGIME_MULTIPLIERS[market.regime] ?? 0
  add('Macro', `Market regime: ${market.regime.replace(/_/g, ' ')}`,
    regimeScore > 0 ? 'bullish' : regimeScore < 0 ? 'bearish' : 'neutral', 6,
    regimeScore * 10)

  add('Macro', `VIX: ${market.vix.description.split(' — ')[0]}`,
    market.vix.signal === 'greed' ? 'bullish' : market.vix.signal === 'fear' ? 'bearish' : 'neutral', 5,
    market.vix.signal === 'fear' ? -5 : market.vix.signal === 'greed' ? 3 : 0)

  add('Macro', `Sector (${market.sectorETF}): ${market.sector.trend} trend, RSI ${market.sector.rsi.toFixed(0)}`,
    market.sector.trend === 'up' ? 'bullish' : market.sector.trend === 'down' ? 'bearish' : 'neutral', 6,
    market.sector.changePeriod > 2 ? 5 : market.sector.changePeriod < -2 ? -5 : 0)

  // ── Apply timeframe weights to category scores ───────────
  // Scale each signal's weight by its category multiplier before scoring
  const categoryMult: Record<string, number> = {
    'Technical':   tw_tech,
    'Fundamental': tw_fund,
    'Smart Money': tw_smart,
    'Options':     tw_opts,
    'Macro':       1.0,  // macro is always relevant
  }
  const scaledSignals = signals.map(s => ({
    ...s,
    weight: s.weight * (categoryMult[s.category] ?? 1.0),
    score:  s.score  * (categoryMult[s.category] ?? 1.0),
  }))

  // ── Pattern signals ────────────────────────────────────────
  // Patterns are high-conviction signals — scored separately and added to scaledSignals
  if (technicals.candlePattern) {
    const strengthScore = technicals.candlePattern.strength === 'strong' ? 8 : technicals.candlePattern.strength === 'moderate' ? 5 : 2
    const dir = technicals.candlePattern.type === 'bullish' ? 'bullish' : technicals.candlePattern.type === 'bearish' ? 'bearish' : 'neutral'
    const s = dir === 'bullish' ? strengthScore : dir === 'bearish' ? -strengthScore : 0
    scaledSignals.push({ category: 'Technical', signal: `Candle: ${technicals.candlePattern.name}`, direction: dir, weight: 7 * tw_tech, score: s * tw_tech })
  }
  if (technicals.chartPattern) {
    const confScore = technicals.chartPattern.confidence === 'high' ? 10 : technicals.chartPattern.confidence === 'medium' ? 7 : 4
    const dir = technicals.chartPattern.type === 'bullish' ? 'bullish' : technicals.chartPattern.type === 'bearish' ? 'bearish' : 'neutral'
    const s = dir === 'bullish' ? confScore : dir === 'bearish' ? -confScore : 0
    scaledSignals.push({ category: 'Technical', signal: `Chart: ${technicals.chartPattern.name}`, direction: dir, weight: 9 * tw_tech, score: s * tw_tech })
  }
  if (technicals.gapPattern && !technicals.gapPattern.filled) {
    const dir = technicals.gapPattern.bullish ? 'bullish' : 'bearish'
    const s = dir === 'bullish' ? 5 : -5
    scaledSignals.push({ category: 'Technical', signal: `Unfilled ${technicals.gapPattern.type.replace('_', ' ')} ${technicals.gapPattern.size.toFixed(1)}%`, direction: dir, weight: 5 * tw_tech, score: s * tw_tech })
  }
  if (technicals.trendLines) {
    const tl = technicals.trendLines
    if (tl.higherHighs && tl.higherLows)
      scaledSignals.push({ category: 'Technical', signal: 'Trend structure: higher highs + higher lows', direction: 'bullish', weight: 6 * tw_tech, score: 5 * tw_tech })
    else if (tl.lowerHighs && tl.lowerLows)
      scaledSignals.push({ category: 'Technical', signal: 'Trend structure: lower highs + lower lows', direction: 'bearish', weight: 6 * tw_tech, score: -5 * tw_tech })
  }

  // ── Convergence score ─────────────────────────────────────
  const totalWeight = scaledSignals.reduce((s, r) => s + r.weight, 0)
  const weightedScore = scaledSignals.reduce((s, r) => s + r.score * r.weight, 0)
  const rawScore = totalWeight > 0 ? (weightedScore / totalWeight) * 10 : 0
  const regimeAdj = REGIME_MULTIPLIERS[market.regime] ?? 0
  const convergenceScore = Math.max(-100, Math.min(100, rawScore + regimeAdj * rawScore))

  const convergingSignals = scaledSignals.filter(s =>
    (convergenceScore > 0 && s.direction === 'bullish') ||
    (convergenceScore < 0 && s.direction === 'bearish')
  ).length
  const divergingSignals = scaledSignals.filter(s =>
    (convergenceScore > 0 && s.direction === 'bearish') ||
    (convergenceScore < 0 && s.direction === 'bullish')
  ).length

  // ── Conviction ────────────────────────────────────────────
  const absScore = Math.abs(convergenceScore)
  const direction: ConvictionOutput['direction'] =
    convergenceScore > 20 ? 'BULLISH' : convergenceScore < -20 ? 'BEARISH' : 'NEUTRAL'

  const conviction: ConvictionOutput['conviction'] =
    absScore > 70 ? 'very_high' : absScore > 50 ? 'high' : absScore > 30 ? 'moderate' :
    divergingSignals > convergingSignals ? 'mixed' : 'low'

  const confidencePct = Math.round(40 + absScore * 0.5)

  // ── Scenarios ─────────────────────────────────────────────
  const baseChange = convergenceScore * 0.15
  const bullChange = baseChange + Math.abs(convergenceScore) * 0.1 + 5
  const bearChange = baseChange - Math.abs(convergenceScore) * 0.1 - 5

  const pTarget = (pct: number) => {
    const target = currentPrice * (1 + pct / 100)
    return `$${target.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`
  }

  const bullProb = direction === 'BULLISH' ? 50 + absScore * 0.3 : 30 - absScore * 0.2
  const bearProb = direction === 'BEARISH' ? 50 + absScore * 0.3 : 20 - absScore * 0.1
  const baseProb = 100 - Math.max(0, bullProb) - Math.max(0, bearProb)

  const scenarios: Scenario[] = [
    {
      label: 'bull',
      probability: Math.round(Math.max(5, Math.min(85, bullProb))),
      priceTarget: pTarget(bullChange),
      timeframe: '2-4 weeks',
      trigger: direction === 'BULLISH'
        ? `Signal convergence plays out; ${convergingSignals} bullish signals confirm`
        : `Surprise positive catalyst or short squeeze`,
      description: `Strong buying pressure, technicals improve, sentiment shifts positive.`,
    },
    {
      label: 'base',
      probability: Math.round(Math.max(10, Math.min(70, baseProb))),
      priceTarget: pTarget(baseChange / 2),
      timeframe: '1-3 weeks',
      trigger: `Current conditions persist with no major surprises`,
      description: `Mixed signals resolve slowly; price action stays range-bound before a directional break.`,
    },
    {
      label: 'bear',
      probability: Math.round(Math.max(5, Math.min(85, bearProb))),
      priceTarget: pTarget(bearChange),
      timeframe: '1-3 weeks',
      trigger: direction === 'BEARISH'
        ? `Bearish momentum continues; ${divergingSignals} warning signs materialize`
        : `Macro deterioration or negative earnings surprise`,
      description: `Selling pressure increases; supports break; macro headwinds dominate.`,
    },
  ]

  // Normalize probabilities to 100%
  const totalProb = scenarios.reduce((s, sc) => s + sc.probability, 0)
  scenarios.forEach(sc => sc.probability = Math.round(sc.probability / totalProb * 100))

  // ── Invalidation trigger ──────────────────────────────────
  const invalidationConditions: string[] = []
  if (direction === 'BULLISH') {
    invalidationConditions.push(`Price closes below SMA200 ($${technicals.sma200.toFixed(2)}) on high volume`)
    invalidationConditions.push(`RSI drops below 40 from current ${technicals.rsi.toFixed(0)}`)
    if (fundamentals.nextEarningsDate) invalidationConditions.push(`Earnings miss + negative guidance on ${fundamentals.nextEarningsDate}`)
    invalidationConditions.push(`VIX spikes above 30 (currently ${market.vix.level.toFixed(0)})`)
    if (optionsFlow.putCallRatio !== null) invalidationConditions.push(`Put/call ratio rises above 1.5 (currently ${optionsFlow.putCallRatio.toFixed(2)})`)
  } else if (direction === 'BEARISH') {
    invalidationConditions.push(`Price reclaims SMA50 ($${technicals.sma50.toFixed(2)}) on strong volume`)
    invalidationConditions.push(`Positive earnings surprise or major analyst upgrade`)
    invalidationConditions.push(`Short squeeze triggers if ${optionsFlow.shortInterestPct ? optionsFlow.shortInterestPct.toFixed(0)+'%' : 'high'} short interest covers rapidly`)
    invalidationConditions.push(`MACD bullish crossover with volume confirmation`)
  } else {
    invalidationConditions.push(`Break above resistance at $${technicals.resistance.toFixed(2)} on volume`)
    invalidationConditions.push(`Break below support at $${technicals.support.toFixed(2)} on volume`)
    invalidationConditions.push(`RSI moves decisively above 60 or below 40`)
  }
  const invalidationTrigger = invalidationConditions[0]

  // ── Narrative phase ───────────────────────────────────────
  const narrativePhase: ConvictionOutput['narrativePhase'] =
    technicals.rsi < 40 && technicals.bbPosition < 0.2 ? 'early' :
    technicals.rsi > 70 && technicals.bbPosition > 0.85 ? 'exhausted' :
    absScore > 50 ? 'middle' : 'late'

  const narrativeMap = {
    early: `Early-stage move — most participants not yet positioned. Asymmetric risk/reward if thesis is correct.`,
    middle: `Middle of a trending move — momentum is building. Risk/reward is fair but entry timing matters.`,
    late: `Late-stage move — much of the move may be priced in. Tighter risk management warranted.`,
    exhausted: `Exhaustion signals — extended move likely near reversal. Fade territory for aggressive traders.`,
  }

  // ── Summary for AI judge ──────────────────────────────────
  const lines = [
    `=== CONVICTION ENGINE OUTPUT ===`,
    ``,
    `Direction: ${direction} | Conviction: ${conviction.toUpperCase()} | Score: ${convergenceScore.toFixed(0)}/100`,
    `Converging signals: ${convergingSignals} | Diverging: ${divergingSignals} | Total analyzed: ${signals.length}`,
    `Regime adjustment applied: ${regimeAdj >= 0 ? '+' : ''}${(regimeAdj * 100).toFixed(0)}%`,
    ``,
    `Signal matrix (top signals):`,
    ...signals
      .sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight))
      .slice(0, 8)
      .map(s => `  [${s.direction.toUpperCase().padStart(7)}] ${s.category}: ${s.signal}`),
    ``,
    `Scenarios:`,
    ...scenarios.map(s =>
      `  ${s.label.toUpperCase()} (${s.probability}%): ${s.priceTarget} — trigger: ${s.trigger}`
    ),
    ``,
    `Narrative phase: ${narrativePhase.toUpperCase()} — ${narrativeMap[narrativePhase]}`,
    ``,
    `INVALIDATION TRIGGER:`,
    ...invalidationConditions.map(c => `  • ${c}`),
  ]

  return {
    regime: market.regime,
    regimeAdjustment: regimeAdj,
    signals,
    convergenceScore,
    convergingSignals,
    divergingSignals,
    conviction,
    direction,
    confidencePct,
    scenarios,
    invalidationTrigger,
    invalidationConditions,
    narrative: narrativeMap[narrativePhase],
    narrativePhase,
    summary: lines.join('\n'),
  }
}
