// ═════════════════════════════════════════════════════════════
// app/lib/trader.ts
//
// THE TRADER FILTER
//
// Runs after the Judge produces a verdict. Evaluates the trade-worthiness
// of the Council's setup using professional trading rules:
//   - R:R minimum (per timeframe)
//   - Confidence floor (per setup type)
//   - Conflict detection (smart money vs verdict, technical vs verdict)
//   - Setup quality grading (A/B/C)
//   - Position sizing recommendation
//
// Output: TraderVerdict — TAKE (with grade + size), PASS (with reasons),
// or WAIT (with conditions that would change it to TAKE).
//
// Architecture: deterministic rules produce the verdict + grade + size.
// A small LLM call generates the plain-English rationale wrapping the
// rules-based decision. The math is auditable; the prose is helpful.
//
// IMPORTANT: This is NOT a separate analysis. The Trader does not
// re-evaluate the underlying signals. It takes the Council's output
// and applies trading discipline on top.
// ═════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk'
import { parsePrice } from './trading/parse-price'
import type { SignalBundle } from './aggregator'
import type { JudgeResult, Signal } from './pipeline'

function getAnthropic() { return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: globalThis.fetch as any }) }

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type TraderDecision = 'TAKE' | 'PASS' | 'WAIT'
export type SetupGrade = 'A' | 'B' | 'C'

export interface TraderVerdict {
  decision: TraderDecision
  grade: SetupGrade | null              // only set when decision === 'TAKE'
  positionSizePct: number               // 0-1; fraction of normal position size
  riskReward: number | null             // computed R:R ratio
  passReasons: string[]                 // when PASS — specific reasons (1 per line)
  passReasonSeverities: ('hard' | 'soft')[]  // parallel to passReasons; same length. 'hard' = blocking failure (no entry, earnings tonight, R:R way below floor). 'soft' = within ~25% of threshold ("almost made it"). Used by frontend to choose grey-out vs warning treatment.
  waitConditions: string[]              // when WAIT — what would flip this to TAKE
  rationale: string                     // LLM-written plain-English explanation
  evaluatedAt: string

  // Internal diagnostics — useful for debugging and the May 30 review
  diagnostics: {
    timeframe: string
    signal: Signal
    confidence: number
    setupType: 'trend_following' | 'counter_trend' | 'range_bound' | 'unknown'
    rrThresholdC: number
    rrThresholdB: number
    rrThresholdA: number
    confidenceFloor: number
    conflicts: string[]
    convictionDirection: string         // from bundle.conviction.direction
    convergenceScore: number            // from bundle.conviction.convergenceScore
  }
}

// ─────────────────────────────────────────────────────────────
// RULES — All thresholds in one place for easy tuning post-30-day review
// ─────────────────────────────────────────────────────────────

const TRADER_RULES = {
  // R:R thresholds per timeframe and grade tier
  // Below the C threshold = automatic PASS regardless of other factors
  rrThresholds: {
    '1D': { C: 1.5, B: 2.0, A: 3.0 },
    '1W': { C: 1.5, B: 2.0, A: 3.0 },
    '1M': { C: 2.0, B: 3.0, A: 5.0 },
    '3M': { C: 3.0, B: 5.0, A: 8.0 },
    // Max mode (day_shark): day-trade momentum/continuation profile. Lower floor
    // than the swing-built 1D bar so quicker, higher-probability pops aren't
    // auto-PASSed. Still positive expectancy — 1.2:1 is the floor, not the target.
    'day_shark': { C: 1.2, B: 1.6, A: 2.4 },
  } as Record<string, { C: number; B: number; A: number }>,

  // Confidence floors per setup type (verdict against trend = higher floor)
  confidenceFloors: {
    trend_following: 55,    // signal aligns with primary trend
    counter_trend: 70,      // signal AGAINST primary trend = stricter
    range_bound: 60,        // mixed/sideways environment
    unknown: 60,            // default when classification unclear
  },

  // Position size by grade (fraction of "normal" size)
  positionSize: {
    A: 1.0,
    B: 0.66,
    C: 0.33,
  } as Record<SetupGrade, number>,

  // Earnings proximity rules — binary risk reduces position
  earningsProximityDays: {
    block: 1,         // <=1 day: PASS regardless
    reduce: 3,        // <=3 days: cap grade at C
  },

  // Conflict thresholds
  conflictRules: {
    // If smart money is OPPOSITE to verdict and signal is "strong" — flag
    smartMoneyOppositeStrong: ['strong_buy', 'strong_sell'],
    // Convergence score divergence — verdict signal vs bundle.conviction.direction
    // If they disagree by more than this much, flag a conflict
    convictionDisagreementThreshold: 30,
  },
} as const

// ─────────────────────────────────────────────────────────────
// Helpers — extract numeric values from Judge's prose fields
// ─────────────────────────────────────────────────────────────

/**
 * Extract the FIRST $-prefixed positive number from a string.
 * Same regex pattern used in app/page.tsx and analyze/route.ts.
 */
function extractPrice(s: string | undefined | null): number | null {
  // Shared parser: fixes comma ("$1,698.50" → 1), sub-penny truncation, and
  // bare-number cases the old inline regex got wrong. See parse-price.ts.
  return parsePrice(typeof s === 'string' ? s : null)
}

/**
 * Compute risk-to-reward ratio from entry/stop/target.
 * Returns null if any value is missing or the geometry is invalid.
 *
 * For BULLISH: target > entry > stop. risk = entry - stop, reward = target - entry.
 * For BEARISH: stop > entry > target. risk = stop - entry, reward = entry - target.
 */
function computeRiskReward(
  signal: Signal,
  entry: number | null,
  stop: number | null,
  target: number | null,
): number | null {
  if (entry === null || stop === null || target === null) return null
  if (entry <= 0 || stop <= 0 || target <= 0) return null

  if (signal === 'BULLISH') {
    if (stop >= entry || target <= entry) return null  // invalid geometry
    const risk = entry - stop
    const reward = target - entry
    return risk > 0 ? reward / risk : null
  } else if (signal === 'BEARISH') {
    if (stop <= entry || target >= entry) return null  // invalid geometry
    const risk = stop - entry
    const reward = entry - target
    return risk > 0 ? reward / risk : null
  }
  return null  // NEUTRAL has no R:R
}

/**
 * Classify the setup type based on signal direction vs primary trend indicators.
 *
 * trend_following: signal aligns with major MAs and conviction direction
 * counter_trend: signal opposes major MAs (e.g., BULLISH against death cross)
 * range_bound: trend indicators are mixed
 *
 * Uses bundle.technicals.goldenCross / deathCross / priceVsSma200 / priceVsSma50
 * combined with bundle.conviction.direction.
 */
function classifySetup(
  signal: Signal,
  bundle: SignalBundle,
): 'trend_following' | 'counter_trend' | 'range_bound' | 'unknown' {
  const t = bundle.technicals
  if (!t) return 'unknown'

  // Determine primary trend from MA alignment
  let primaryTrend: 'up' | 'down' | 'sideways' = 'sideways'

  if (t.goldenCross && t.priceVsSma200 > 0 && t.priceVsSma50 > 0) {
    primaryTrend = 'up'
  } else if (t.deathCross && t.priceVsSma200 < 0 && t.priceVsSma50 < 0) {
    primaryTrend = 'down'
  } else if (t.priceVsSma200 > 5) {
    primaryTrend = 'up'
  } else if (t.priceVsSma200 < -5) {
    primaryTrend = 'down'
  }

  // Cross-check with conviction engine direction
  const convictionDir = bundle.conviction?.direction ?? 'NEUTRAL'

  if (primaryTrend === 'sideways' || convictionDir === 'NEUTRAL') {
    return 'range_bound'
  }

  if ((signal === 'BULLISH' && primaryTrend === 'up') ||
      (signal === 'BEARISH' && primaryTrend === 'down')) {
    return 'trend_following'
  }

  if ((signal === 'BULLISH' && primaryTrend === 'down') ||
      (signal === 'BEARISH' && primaryTrend === 'up')) {
    return 'counter_trend'
  }

  return 'unknown'
}

/**
 * Detect conflicts between the Council verdict and key data signals.
 * Returns an array of conflict descriptions (empty = no conflicts).
 */
function detectConflicts(
  signal: Signal,
  confidence: number,
  bundle: SignalBundle,
): string[] {
  const conflicts: string[] = []

  // Smart money conflict
  const insiderSig = bundle.smartMoney?.insiderSignal ?? 'neutral'
  const isStrongOpposite =
    (signal === 'BULLISH' && insiderSig.includes('sell')) ||
    (signal === 'BEARISH' && insiderSig.includes('buy'))

  if (isStrongOpposite) {
    const strength = (TRADER_RULES.conflictRules.smartMoneyOppositeStrong as readonly string[]).includes(insiderSig)
      ? 'strongly'
      : ''
    conflicts.push(
      `Insider signal (${insiderSig.replace('_', ' ')}) ${strength} contradicts ${signal} verdict — insiders are voting with their wallets in the opposite direction`
    )
  }

  // Congressional trade conflict (weaker signal)
  const congSig = bundle.smartMoney?.congressSignal ?? 'none'
  if (signal === 'BULLISH' && congSig === 'selling') {
    conflicts.push('Congressional members net selling while verdict is BULLISH')
  } else if (signal === 'BEARISH' && congSig === 'buying') {
    conflicts.push('Congressional members net buying while verdict is BEARISH')
  }

  // Conviction engine disagreement
  const convDir = bundle.conviction?.direction ?? 'NEUTRAL'
  const convScore = bundle.conviction?.convergenceScore ?? 0

  if (convDir !== 'NEUTRAL' && convDir !== signal && Math.abs(convScore) >= TRADER_RULES.conflictRules.convictionDisagreementThreshold) {
    conflicts.push(
      `Quantitative conviction engine says ${convDir} (score ${convScore.toFixed(0)}) but verdict is ${signal} — material divergence between data-driven score and Council debate outcome`
    )
  }

  // Earnings binary risk
  const days = bundle.fundamentals?.daysToEarnings
  if (days !== null && days !== undefined && days >= 0 && days <= TRADER_RULES.earningsProximityDays.reduce) {
    conflicts.push(
      `Earnings in ${days} day${days === 1 ? '' : 's'} — directional trades face binary catalyst risk that R:R math doesn't capture`
    )
  }

  // Analyst consensus conflict
  const analystCons = bundle.fundamentals?.analystConsensus
  if (analystCons === 'strong_sell' && signal === 'BULLISH') {
    conflicts.push('Analyst consensus is STRONG SELL while verdict is BULLISH')
  } else if (analystCons === 'strong_buy' && signal === 'BEARISH') {
    conflicts.push('Analyst consensus is STRONG BUY while verdict is BEARISH')
  }

  return conflicts
}

// ─────────────────────────────────────────────────────────────
// Core decision logic
// ─────────────────────────────────────────────────────────────

interface RulesDecision {
  decision: TraderDecision
  grade: SetupGrade | null
  positionSizePct: number
  passReasons: string[]
  passReasonSeverities: ('hard' | 'soft')[]
  waitConditions: string[]
  diagnostics: TraderVerdict['diagnostics']
}

function applyRules(
  judge: JudgeResult,
  bundle: SignalBundle,
  timeframe: string,
): RulesDecision {
  const signal = judge.signal
  const confidence = judge.confidence

  const entry = extractPrice(judge.entryPrice)
  const stop = extractPrice(judge.stopLoss)
  const target = extractPrice(judge.takeProfit)
  const rr = computeRiskReward(signal, entry, stop, target)

  const setupType = classifySetup(signal, bundle)
  const conflicts = detectConflicts(signal, confidence, bundle)

  // Max mode: day_shark verdicts use the day-trade R:R profile instead of the
  // swing-built timeframe floor. Falls back to the timeframe rules if absent.
  const ruleKey = bundle.source === 'day_shark' ? 'day_shark' : timeframe
  const tfRules = TRADER_RULES.rrThresholds[ruleKey]
    ?? TRADER_RULES.rrThresholds[timeframe]
    ?? TRADER_RULES.rrThresholds['1W']
  const confFloor = TRADER_RULES.confidenceFloors[setupType] ?? TRADER_RULES.confidenceFloors.unknown

  const diagnostics: TraderVerdict['diagnostics'] = {
    timeframe,
    signal,
    confidence,
    setupType,
    rrThresholdC: tfRules.C,
    rrThresholdB: tfRules.B,
    rrThresholdA: tfRules.A,
    confidenceFloor: confFloor,
    conflicts,
    convictionDirection: bundle.conviction?.direction ?? 'NEUTRAL',
    convergenceScore: bundle.conviction?.convergenceScore ?? 0,
  }

  const passReasons: string[] = []
  const passReasonSeverities: ('hard' | 'soft')[] = []
  const waitConditions: string[] = []

  /** Push a pass reason with explicit severity. Keeps the two parallel arrays in lockstep. */
  function addPassReason(text: string, severity: 'hard' | 'soft'): void {
    passReasons.push(text)
    passReasonSeverities.push(severity)
  }

  // ── Hard PASS conditions ──

  // Earnings within 1 day = automatic PASS (HARD — binary risk overrides analytical edge)
  const daysToEarnings = bundle.fundamentals?.daysToEarnings
  if (daysToEarnings !== null && daysToEarnings !== undefined && daysToEarnings >= 0 && daysToEarnings <= TRADER_RULES.earningsProximityDays.block) {
    addPassReason(
      `Earnings ${daysToEarnings === 0 ? 'today' : 'tomorrow'} — directional trades have binary risk that overrides the analytical edge. Wait for post-earnings price discovery.`,
      'hard',
    )
  }

  // Missing trade plan = automatic PASS (HARD — can't evaluate what isn't there)
  if (entry === null) {
    addPassReason('No valid entry price in the verdict — cannot evaluate trade quality without a defined entry.', 'hard')
  }
  if (signal !== 'NEUTRAL' && (stop === null || target === null)) {
    addPassReason(`Trade plan incomplete — ${stop === null ? 'stop' : 'target'} not specified or could not be parsed.`, 'hard')
  }

  // R:R below the C threshold = PASS. Severity depends on HOW far below.
  // "Soft" = R:R is at least 75% of threshold (the "5% below comfort" case the user flagged).
  // "Hard" = R:R is way below threshold — trade economics genuinely don't work.
  if (rr !== null && rr < tfRules.C) {
    const isSoftRR = rr >= tfRules.C * 0.75
    addPassReason(
      `Risk-to-reward ratio of ${rr.toFixed(2)}:1 is below the ${tfRules.C}:1 minimum for ${timeframe} timeframe. Even a winning thesis loses money over many trades at this R:R.`,
      isSoftRR ? 'soft' : 'hard',
    )

    // If R:R is just barely below C, suggest a WAIT condition
    if (rr >= tfRules.C * 0.85 && entry !== null && target !== null && stop !== null) {
      const needed = tfRules.C
      if (signal === 'BULLISH') {
        const newStopForC = entry - (target - entry) / needed
        waitConditions.push(
          `Tighten stop to $${newStopForC.toFixed(2)} (or wait for entry below $${(entry * 0.99).toFixed(2)}) to reach the ${needed.toFixed(1)}:1 R:R minimum.`
        )
      } else if (signal === 'BEARISH') {
        const newStopForC = entry + (entry - target) / needed
        waitConditions.push(
          `Tighten stop to $${newStopForC.toFixed(2)} (or wait for entry above $${(entry * 1.01).toFixed(2)}) to reach the ${needed.toFixed(1)}:1 R:R minimum.`
        )
      }
    }
  }

  // Confidence below floor = PASS. Severity depends on how far below.
  // "Soft" = within 5 points of floor (the existing WAIT-suggestion threshold).
  // "Hard" = more than 5 points below — Council itself isn't confident enough.
  if (confidence < confFloor) {
    const gap = confFloor - confidence
    const isSoftConf = gap <= 5
    addPassReason(
      `Confidence (${confidence}%) is below the ${confFloor}% floor for ${setupType.replace('_', '-')} setups. ${setupType === 'counter_trend' ? 'Counter-trend trades require higher conviction because you\'re fighting the dominant flow.' : 'The Council\'s own confidence does not justify taking this trade.'}`,
      isSoftConf ? 'soft' : 'hard',
    )

    // If confidence is just barely below, that's a WAIT condition
    if (gap <= 5) {
      waitConditions.push(
        `Confidence is ${gap} point${gap === 1 ? '' : 's'} below the ${confFloor}% floor for this setup type. New evidence reinforcing the thesis could push it over.`
      )
    }
  }

  // Strong conflict (smart money strongly opposing) = PASS (HARD — directional contradiction)
  const insiderSig = bundle.smartMoney?.insiderSignal ?? 'neutral'
  const strongInsiderConflict =
    (signal === 'BULLISH' && insiderSig === 'strong_sell') ||
    (signal === 'BEARISH' && insiderSig === 'strong_buy')
  if (strongInsiderConflict) {
    addPassReason(
      `Insider signal is ${insiderSig.replace('_', ' ')} — directly contradicts the ${signal} verdict. When insiders are putting their own money in the opposite direction, the verdict needs much stronger conviction to override.`,
      'hard',
    )
  }

  // ── If we have any pass reasons, we're done — return PASS or WAIT ──
  if (passReasons.length > 0) {
    // If there are WAIT conditions AND the only failures are "almost made it",
    // return WAIT. Otherwise PASS.
    const onlySoftFailures = passReasons.length <= 2 && waitConditions.length > 0
    if (onlySoftFailures) {
      return {
        decision: 'WAIT',
        grade: null,
        positionSizePct: 0,
        passReasons,
        passReasonSeverities,
        waitConditions,
        diagnostics,
      }
    }

    return {
      decision: 'PASS',
      grade: null,
      positionSizePct: 0,
      passReasons,
      passReasonSeverities,
      waitConditions: [],
      diagnostics,
    }
  }

  // ── Setup passes minimums — determine grade ──
  let grade: SetupGrade = 'C'

  // Grade depends on R:R + confidence + conflict count
  const conflictCount = conflicts.length
  const isAGradeRR = rr !== null && rr >= tfRules.A
  const isBGradeRR = rr !== null && rr >= tfRules.B
  const isAGradeConfidence = confidence >= 75
  const isBGradeConfidence = confidence >= 65

  if (isAGradeRR && isAGradeConfidence && conflictCount === 0) {
    grade = 'A'
  } else if (isBGradeRR && isBGradeConfidence && conflictCount <= 1) {
    grade = 'B'
  } else {
    grade = 'C'
  }

  // Earnings within reduce window caps grade at C
  if (daysToEarnings !== null && daysToEarnings !== undefined && daysToEarnings >= 0 && daysToEarnings <= TRADER_RULES.earningsProximityDays.reduce) {
    if (grade === 'A' || grade === 'B') {
      grade = 'C'
    }
  }

  return {
    decision: 'TAKE',
    grade,
    positionSizePct: TRADER_RULES.positionSize[grade],
    passReasons: [],
    passReasonSeverities: [],
    waitConditions: [],
    diagnostics,
  }
}

// ─────────────────────────────────────────────────────────────
// LLM rationale wrapper
//
// Given the rules-based decision, generate a plain-English rationale
// that reads like an experienced trader explaining their reasoning.
// Uses Claude Haiku for cost — this is a small wrapper call, not analysis.
// ─────────────────────────────────────────────────────────────

async function generateRationale(
  decision: RulesDecision,
  judge: JudgeResult,
  bundle: SignalBundle,
  timeframe: string,
): Promise<string> {
  const rr = computeRiskReward(
    judge.signal,
    extractPrice(judge.entryPrice),
    extractPrice(judge.stopLoss),
    extractPrice(judge.takeProfit),
  )

  const sysPrompt = `You are an experienced swing trader with 20 years of professional experience. You've just evaluated a setup against your trading discipline rules and reached a decision. Write a 3-5 sentence rationale that explains the decision in plain trader language — direct, honest, no jargon for jargon's sake.

The decision has already been made by the rules. You are NOT re-evaluating. You are EXPLAINING why this decision is the right one given the data.

Tone: conversational but professional. Like talking to a smart trading buddy. Use "I" perspective. No hedging, no "well it could go either way" — the rules made the call, you're explaining it.

Length: 3-5 sentences. Be concrete. Reference specific numbers from the data (R:R, confidence, the specific conflict if any).`

  const userPrompt = `TICKER: ${bundle.ticker}
TIMEFRAME: ${timeframe}
COUNCIL VERDICT: ${judge.signal} at ${judge.confidence}% confidence
TRADE PLAN: Entry ${judge.entryPrice ?? 'none'}, Stop ${judge.stopLoss ?? 'none'}, Target ${judge.takeProfit ?? 'none'}
R:R: ${rr !== null ? rr.toFixed(2) + ':1' : 'cannot compute'}

SETUP TYPE: ${decision.diagnostics.setupType.replace('_', '-')}
PRIMARY TREND CONTEXT: Conviction engine says ${decision.diagnostics.convictionDirection} (score ${decision.diagnostics.convergenceScore.toFixed(0)})

CONFLICTS DETECTED:
${decision.diagnostics.conflicts.length > 0 ? decision.diagnostics.conflicts.map(c => `  - ${c}`).join('\n') : '  (none)'}

YOUR DECISION: ${decision.decision}${decision.grade ? ` (Grade ${decision.grade}, ${(decision.positionSizePct * 100).toFixed(0)}% position size)` : ''}

${decision.passReasons.length > 0 ? `WHY YOU'RE PASSING/WAITING:\n${decision.passReasons.map(r => `  - ${r}`).join('\n')}` : ''}
${decision.waitConditions.length > 0 ? `\nCONDITIONS THAT WOULD CHANGE YOUR MIND:\n${decision.waitConditions.map(w => `  - ${w}`).join('\n')}` : ''}

Write your rationale. Plain English, no preamble like "I'm an experienced trader and..." — just dive in. ${decision.decision === 'TAKE' ? 'Explain why this is a Grade ' + decision.grade + ' setup worth taking.' : decision.decision === 'WAIT' ? 'Explain what you\'re waiting for and why the current setup isn\'t quite there.' : 'Explain why you\'re passing on this trade. Be honest — sometimes the best trade is no trade.'}`

  try {
    const msg = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: sysPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = msg.content.find((b: any) => b.type === 'text') as { type: 'text'; text: string } | undefined
    if (!block) return defaultRationale(decision)
    return block.text.trim()
  } catch (e) {
    console.warn('[trader] rationale LLM call failed:', (e as Error).message?.slice(0, 200))
    return defaultRationale(decision)
  }
}

/**
 * Deterministic fallback rationale when the LLM call fails.
 * Always produces a useful sentence even without the LLM.
 */
function defaultRationale(decision: RulesDecision): string {
  if (decision.decision === 'PASS') {
    return `Passing on this setup. ${decision.passReasons[0] ?? 'The setup does not meet trade-quality minimums.'}`
  }
  if (decision.decision === 'WAIT') {
    return `Holding off on this one — close, but not quite. ${decision.waitConditions[0] ?? 'A small change would make this tradeable.'}`
  }
  // TAKE
  const sizePctStr = `${(decision.positionSizePct * 100).toFixed(0)}%`
  return `Grade ${decision.grade} setup. Taking it at ${sizePctStr} of normal position size. R:R clears the threshold, confidence holds up, conflicts are manageable.`
}

// ─────────────────────────────────────────────────────────────
// Public entrypoint
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate a Council verdict against trader discipline rules.
 *
 * Returns a TraderVerdict that's separate from the Judge's verdict.
 * Never throws — on any failure, returns a fallback TraderVerdict
 * indicating evaluation couldn't complete.
 *
 * @param judge The Judge's final verdict (with calibration applied)
 * @param bundle The full SignalBundle (for context — smart money, conviction, etc)
 * @param timeframe '1D' | '1W' | '1M' | '3M'
 */
export async function evaluateTrade(
  judge: JudgeResult,
  bundle: SignalBundle,
  timeframe: string,
): Promise<TraderVerdict> {
  const startedAt = Date.now()

  try {
    // NEUTRAL verdicts don't go through trader filtering — they're already
    // "no directional call." Return a TraderVerdict that reflects that.
    if (judge.signal === 'NEUTRAL') {
      return {
        decision: 'PASS',
        grade: null,
        positionSizePct: 0,
        riskReward: null,
        passReasons: ['Council returned NEUTRAL — no directional thesis to trade against. The honest answer here is to wait for clearer signals.'],
        passReasonSeverities: ['hard'],
        waitConditions: [],
        rationale: 'No trade. The Council itself didn\'t reach a directional verdict, so there\'s nothing to evaluate or take. Wait for the data to clarify.',
        evaluatedAt: new Date().toISOString(),
        diagnostics: {
          timeframe,
          signal: 'NEUTRAL',
          confidence: judge.confidence,
          setupType: 'unknown',
          rrThresholdC: 0,
          rrThresholdB: 0,
          rrThresholdA: 0,
          confidenceFloor: 0,
          conflicts: [],
          convictionDirection: bundle.conviction?.direction ?? 'NEUTRAL',
          convergenceScore: bundle.conviction?.convergenceScore ?? 0,
        },
      }
    }

    // Run deterministic rules
    const decision = applyRules(judge, bundle, timeframe)

    // Generate LLM rationale (fail-soft — uses default if LLM fails)
    const rationale = await generateRationale(decision, judge, bundle, timeframe)

    // Compute R:R for the persisted output
    const rr = computeRiskReward(
      judge.signal,
      extractPrice(judge.entryPrice),
      extractPrice(judge.stopLoss),
      extractPrice(judge.takeProfit),
    )

    const elapsed = Date.now() - startedAt
    console.log(`[trader] ${bundle.ticker} ${timeframe}: ${decision.decision}${decision.grade ? ' Grade ' + decision.grade : ''} in ${elapsed}ms`)

    return {
      decision: decision.decision,
      grade: decision.grade,
      positionSizePct: decision.positionSizePct,
      riskReward: rr,
      passReasons: decision.passReasons,
      passReasonSeverities: decision.passReasonSeverities,
      waitConditions: decision.waitConditions,
      rationale,
      evaluatedAt: new Date().toISOString(),
      diagnostics: decision.diagnostics,
    }
  } catch (e) {
    console.error('[trader] evaluation failed:', (e as Error).message?.slice(0, 200))
    return {
      decision: 'PASS',
      grade: null,
      positionSizePct: 0,
      riskReward: null,
      passReasons: ['Trader evaluation failed due to an internal error. Defaulting to PASS for safety.'],
      passReasonSeverities: ['hard'],
      waitConditions: [],
      rationale: 'Trader filter could not complete its evaluation. When the system can\'t evaluate a trade, the safe default is to pass.',
      evaluatedAt: new Date().toISOString(),
      diagnostics: {
        timeframe,
        signal: judge.signal,
        confidence: judge.confidence,
        setupType: 'unknown',
        rrThresholdC: 0,
        rrThresholdB: 0,
        rrThresholdA: 0,
        confidenceFloor: 0,
        conflicts: [],
        convictionDirection: 'NEUTRAL',
        convergenceScore: 0,
      },
    }
  }
}

/**
 * Empty TraderVerdict — used when we want to skip the Trader entirely
 * (e.g., for cached verdicts where we didn't run the Trader stage).
 */
export function emptyTraderVerdict(): TraderVerdict {
  return {
    decision: 'PASS',
    grade: null,
    positionSizePct: 0,
    riskReward: null,
    passReasons: [],
    passReasonSeverities: [],
    waitConditions: [],
    rationale: '',
    evaluatedAt: new Date().toISOString(),
    diagnostics: {
      timeframe: '',
      signal: 'NEUTRAL',
      confidence: 0,
      setupType: 'unknown',
      rrThresholdC: 0,
      rrThresholdB: 0,
      rrThresholdA: 0,
      confidenceFloor: 0,
      conflicts: [],
      convictionDirection: 'NEUTRAL',
      convergenceScore: 0,
    },
  }
}
