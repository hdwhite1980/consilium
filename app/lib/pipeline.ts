// ─────────────────────────────────────────────────────────────
// AI Pipeline v2 --- All 5 phases integrated
// Each AI receives the full signal bundle, not just price text
// ─────────────────────────────────────────────────────────────
//
// Changelog:
//   Apr 19 (a58f): Gap #1 --- Sequential debate (Lead → Devil → Rebuttal → Counter)
//   Apr 19 (a58f): Gap #2 --- Gemini 2.5 Pro Judge + GEMINI_JUDGE toggle + fallback
//   Apr 19 (b*):   Gap #3 --- Calibrated adversarial Devil's Advocate
//   Apr 19 (b*):   Gap #4 --- Symmetric Judge presentation
//   Apr 19 (c*):   Gap #5 --- Multi-source Round 2 research (Alpaca+Finnhub+Grok)
//   Apr 19 (c*):   Gap #6 --- Judge correction logging to judge_corrections table
//   Apr 19 (d*):   Gap #7 --- Structural personas:
//                  - Lead sees opposite-dimension data as "background noise" unless
//                    catalyst overrides trigger (earnings <=3d, 5% gap, death/golden cross)
//                  - Devil cross-pressures: technical Lead gets fundamental Devil,
//                    fundamental Lead gets technical Devil, balanced Lead gets weakest
//                  - Judge stays neutral across all personas (removed persona weighting)
//                  - Required citation list becomes persona-specific
//                  - User persona choice overrides timeframe defaults; timeframe
//                    defaults only apply when user selected "balanced"
//
// ─────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { generateWithFallback } from './gemini-helper'
import { buildMacroIntelligenceContext } from './macro-intelligence'
import type { SignalBundle } from './aggregator'
import { isFundTicker, getFundInfo, buildFundContext } from './data/fund-detection'
import { runSocialScout, formatSocialSentimentForPrompt, type SocialSentiment } from './social-scout'
import { runAggregatorScout, formatAggregatorForPrompt, type AggregatorScoutResult } from './news-aggregator-scout'
import { evaluateTrade, type TraderVerdict } from './trader'
import { callGrok } from './grok'
import { verifyFactualClaims, type VerificationResult } from './verification'

function getAnthropic() { return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) }
function getOpenAI()    { return new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) }
function getGenAI()     { return new GoogleGenerativeAI(process.env.GEMINI_API_KEY!) }

export type Signal = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
export type PersonaKey = 'balanced' | 'technical' | 'fundamental'

export interface GeminiResult {
  summary: string
  headlines: string[]
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed'
  confidence: number
  keyEvents: string[]
  macroFactors: string[]
  regimeAssessment: string
}

export interface ClaudeResult {
  signal: Signal
  reasoning: string
  target: string
  confidence: number
  technicalBasis: string
  fundamentalBasis: string
  catalysts: string[]
  keyRisks: string[]
}

export interface GptResult {
  agrees: boolean
  signal: Signal
  reasoning: string
  confidence: number
  challenges: string[]
  alternateScenario: string
  strongestCounterArgument: string
}

export interface RebuttalResult {
  signal: Signal
  confidence: number
  /** @deprecated Bug 19: replaced by researchQuestions; kept for legacy transcript compat */
  researchQuestion?: string
  /** @deprecated Bug 19: replaced by researchAnswers; kept for legacy transcript compat */
  researchAnswer?: string
  // Bug 19: arrays of paired Q&A from R2 News Scout consultations.
  // Always 2 entries (Lead asks two questions in parallel).
  researchQuestions: string[]
  researchAnswers: string[]
  rebuttal: string
  concedes: string[]
  maintains: string[]
  updatedTarget: string
  finalStance: string
}

export interface CounterResult {
  /** @deprecated Bug 19: replaced by researchQuestions; kept for legacy transcript compat */
  researchQuestion?: string
  /** @deprecated Bug 19: replaced by researchAnswers; kept for legacy transcript compat */
  researchAnswer?: string
  // Bug 19: arrays of paired Q&A from R2 News Scout consultations.
  // Always 2 entries (Devil asks two questions in parallel).
  researchQuestions: string[]
  researchAnswers: string[]
  finalChallenge: string
  yieldsOn: string[]
  pressesOn: string[]
  closingArgument: string
}

/**
 * Output of the Judge Reviewer stage — the procedural safety net that runs
 * AFTER the draft Judge and BEFORE the final Judge re-run. Evaluates the
 * draft against a 5-rule checklist:
 *
 *   Rule 1: Re-analysis instead of judging (procedural)
 *   Rule 2: Confidence calibration mismatch (calibration)  ← legacy CalibrationResult covered only this
 *   Rule 3: Trade plan structural issues (math broken)
 *   Rule 4: Options strategy format violations
 *   Rule 5: Verdict signal contradicts debate weight
 *
 * Rules 3 and 5 are MATERIAL — they trigger a one-shot retry of the Judge
 * with corrective context. Rule 2 is material only when severe (delta >=15).
 * Rules 1 and 4 are SURFACED to the user as inline notes but never trigger
 * retry — the verdict is usable, just imperfect.
 *
 * Retain CalibrationResult fields verbatim so existing callers continue to
 * work without code changes (it's a strict superset).
 */
export interface JudgeReviewResult {
  // ── Rule 2: Calibration (legacy CalibrationResult fields) ──
  draftConfidence: number
  draftSignal: Signal
  recommendedConfidence: number
  adjustmentDelta: number
  adjustmentDirection: 'up' | 'down' | 'unchanged'
  confidenceBand: { low: number; high: number }
  reasoning: string
  overconfidenceFlags: string[]
  underconfidenceFlags: string[]
  mutualConcessions: boolean
  unresolvedChallenge: string | null

  // ── New: Rules 1, 3, 4, 5, 6 ──
  /** Rule 1: did the Judge re-analyze instead of judging? */
  reAnalysisFlags: string[]
  /** Rule 3: trade plan math problems (entry/stop/target inconsistencies, missing prices, etc.) */
  tradePlanIssues: string[]
  /** Rule 4: options strategy missing required components (per Bug 25 format requirements) */
  optionsStrategyIssues: string[]
  /** Rule 5: does signal direction contradict where evidence landed? Single-string description or null when clean. */
  signalMismatchConcern: string | null
  /** Rule 6: did the Judge's draft acknowledge that the debate built on fabricated,
   *  hallucinated, or verification-failed sources? Each entry describes a specific
   *  contaminated claim that influenced the draft. Empty when clean. */
  sourceIntegrityIssues: string[]

  // ── Overall status determines retry behavior ──
  /** clean = no flags fired
   *  minor_notes = flags fired but only on rules 1, 4, or small Rule 2 — surface only
   *  material_concerns = rules 3, 5, 6, or high-severity Rule 2 fired — triggers Judge retry */
  overallStatus: 'clean' | 'minor_notes' | 'material_concerns'

  // ── Metadata ──
  /** Which rules triggered the material_concerns status, if any */
  materialRuleNumbers: number[]
  calibratorModel: string
}

/** Backwards-compat alias. CalibrationResult was the previous name; we kept
 *  the legacy field shape in JudgeReviewResult so all existing readers
 *  continue to work without modification. */
export type CalibrationResult = JudgeReviewResult

export interface JudgeResult {
  signal: Signal
  confidence: number
  target: string
  risk: string
  summary: string
  winningArgument: string
  dissent: string
  scenarios: Array<{ label: string; probability: number; trigger: string }>
  invalidationTrigger: string
  rounds: number
  entryPrice: string
  stopLoss: string
  takeProfit: string
  timeHorizon: string
  plainEnglish: string
  technicalsExplained: string
  fundamentalsExplained: string
  smartMoneyExplained: string
  actionPlan: string
  optionsStrategy?: string
  judgeModel?: string
}

export interface PipelineResult {
  gemini: GeminiResult
  claude: ClaudeResult
  gpt: GptResult
  rebuttal?: RebuttalResult
  counter?: CounterResult
  judge: JudgeResult
  calibration?: CalibrationResult
  aggregator: AggregatorScoutResult
  verifications?: {
    lead?: VerificationResult
    devil?: VerificationResult
    rebuttal?: VerificationResult
    counter?: VerificationResult
    totalVerified: number
    totalStripped: number
    allSourceUrls: string[]
  }
  transcript: TranscriptMessage[]
  social: SocialSentiment
  trader: TraderVerdict
}

export interface TranscriptMessage {
  role: 'gemini' | 'claude' | 'gpt' | 'judge'
  stage: string
  content: string
  signal?: string
  confidence?: number
  timestamp: string
}

function ts() { return new Date().toISOString() }

// ─────────────────────────────────────────────────────────────
// GAP #7 --- Persona + catalyst override logic
// ─────────────────────────────────────────────────────────────

/**
 * Resolve the ACTIVE lens for structural filtering.
 *
 * Precedence rules:
 *   1. User explicitly picked technical OR fundamental -> that wins
 *   2. User picked balanced -> lean by timeframe:
 *        1D, 1W -> technical-leaning (intraday/swing)
 *        1M, 3M -> fundamental-leaning (position/investment)
 *   3. Default -> balanced
 *
 * The resolved lens determines which section is "primary" and which is
 * "background noise" in the Lead Analyst's evidence mix.
 */
function resolveLens(persona: PersonaKey, timeframe: string): 'technical' | 'fundamental' | 'balanced' {
  if (persona === 'technical')   return 'technical'
  if (persona === 'fundamental') return 'fundamental'
  // balanced -> timeframe default
  if (timeframe === '1D' || timeframe === '1W') return 'technical'
  return 'fundamental'
}

/**
 * Does the user's EXPLICIT persona differ from the balanced default for
 * this timeframe? We use this only for labeling ("user overrode default").
 */
function isPersonaExplicit(persona: PersonaKey): boolean {
  return persona === 'technical' || persona === 'fundamental'
}

interface CatalystOverrides {
  triggered: boolean
  reasons: string[]  // why the override fired --- feeds the Lead's prompt as warning
}

/**
 * Detect catalyst overrides that force the Lead Analyst to factor in the
 * opposite-dimension data REGARDLESS of their persona lens.
 *
 * Technical persona: we normally deprioritize fundamentals, BUT:
 *   - Earnings within 3 days -> must consider
 *   - Analyst consensus changed significantly -> must consider
 *   - Strong insider signal -> must consider
 *
 * Fundamental persona: we normally deprioritize technicals, BUT:
 *   - 5%+ gap today -> must consider
 *   - At 52-week high/low -> must consider
 *   - Recent death/golden cross -> must consider
 */
function detectOverrides(
  bundle: SignalBundle,
  lens: 'technical' | 'fundamental' | 'balanced'
): CatalystOverrides {
  const reasons: string[] = []

  // Shared: always compute both, only surface those relevant to the lens
  const daysToEarnings = bundle.fundamentals?.daysToEarnings ?? null
  const analystBuy     = bundle.fundamentals?.analystBuy ?? 0
  const analystSell    = bundle.fundamentals?.analystSell ?? 0
  const insiderSignal  = bundle.fundamentals?.insiderSignal ?? 'neutral'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tech = bundle.technicals as any
  const priceChangePct = tech?.priceChangeTodayPct ?? tech?.priceChange1DPct ?? null
  const pct52wHigh     = tech?.pctFrom52wHigh ?? null
  const pct52wLow      = tech?.pctFrom52wLow ?? null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const goldenCrossDays = tech?.daysSinceGoldenCross ?? null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deathCrossDays  = tech?.daysSinceDeathCross ?? null

  if (lens === 'technical') {
    // Fundamental overrides force the technical Lead to look at fundamentals
    if (daysToEarnings !== null && daysToEarnings >= 0 && daysToEarnings <= 3) {
      reasons.push(`Earnings in ${daysToEarnings} day${daysToEarnings === 1 ? '' : 's'} --- fundamental risk cannot be ignored regardless of chart setup`)
    }
    // Analyst consensus shift: if the balance is lopsided toward sells
    if (analystSell > 0 && analystBuy > 0 && analystSell >= analystBuy) {
      reasons.push(`Analyst consensus has turned bearish (${analystSell} sell vs ${analystBuy} buy) --- reconcile with your chart thesis`)
    }
    // Strong insider signal (either direction)
    if (insiderSignal === 'buying' || insiderSignal === 'selling') {
      reasons.push(`Insider ${insiderSignal === 'buying' ? 'buying activity' : 'selling activity'} detected --- insiders know something the chart may not show yet`)
    }
  }

  if (lens === 'fundamental') {
    // Technical overrides force the fundamental Lead to look at the chart
    if (priceChangePct !== null && Math.abs(priceChangePct) >= 5) {
      reasons.push(`Price moved ${priceChangePct.toFixed(1)}% today --- cannot ignore this chart event regardless of valuation thesis`)
    }
    if (pct52wHigh !== null && pct52wHigh >= -2) {
      reasons.push(`At/near 52-week high (within ${Math.abs(pct52wHigh).toFixed(1)}%) --- technical resistance matters even for long-term thesis`)
    }
    if (pct52wLow !== null && pct52wLow <= 2) {
      reasons.push(`At/near 52-week low (within ${pct52wLow.toFixed(1)}%) --- potential technical capitulation signal, reconcile with fundamental view`)
    }
    if (goldenCrossDays !== null && goldenCrossDays >= 0 && goldenCrossDays <= 5) {
      reasons.push(`Golden cross ${goldenCrossDays} day${goldenCrossDays === 1 ? '' : 's'} ago --- major trend signal even if fundamentals haven't changed`)
    }
    if (deathCrossDays !== null && deathCrossDays >= 0 && deathCrossDays <= 5) {
      reasons.push(`Death cross ${deathCrossDays} day${deathCrossDays === 1 ? '' : 's'} ago --- major trend signal even if fundamentals haven't changed`)
    }
  }

  return { triggered: reasons.length > 0, reasons }
}

/**
 * Build the persona-aware evidence block for the Lead Analyst.
 *
 * For technical lens: technicals + options + market = primary,
 *                     fundamentals + smart money = "background only"
 *                     UNLESS catalyst override fires, then full visibility.
 *
 * For fundamental lens: fundamentals + smart money + earnings = primary,
 *                       technicals = "background only"
 *                       UNLESS catalyst override fires.
 *
 * For balanced lens: everything at full weight (current behavior).
 */
function buildLeadEvidenceBlock(
  bundle: SignalBundle,
  lens: 'technical' | 'fundamental' | 'balanced',
  overrides: CatalystOverrides,
): string {
  const ctx = bundle.aiContext

  // Balanced lens: full data, no filtering
  if (lens === 'balanced') {
    return [
      ctx.technicalsSection,
      ctx.fundamentalsSection,
      ctx.smartMoneySection,
      ctx.optionsSection,
      ctx.convictionSection,
    ].filter(Boolean).join('\n\n')
  }

  // Technical lens
  if (lens === 'technical') {
    const primary = [
      ctx.technicalsSection,
      ctx.optionsSection,
      ctx.convictionSection,
    ].filter(Boolean).join('\n\n')

    // Opposite section: full if override, truncated background otherwise
    let secondary: string
    if (overrides.triggered) {
      secondary = `━━━ FUNDAMENTAL OVERRIDE IN EFFECT ━━━
Your technical lens normally deprioritizes fundamentals, but the following conditions REQUIRE you to factor them in:
${overrides.reasons.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}

FULL FUNDAMENTAL DATA:
${ctx.fundamentalsSection}

${ctx.smartMoneySection}`
    } else {
      secondary = `━━━ BACKGROUND ONLY --- treat as noise unless it contradicts your chart thesis ━━━
${(ctx.fundamentalsSection || '').slice(0, 700)}

${(ctx.smartMoneySection || '').slice(0, 400)}`
    }

    return `${primary}\n\n${secondary}`
  }

  // Fundamental lens
  if (lens === 'fundamental') {
    const primary = [
      ctx.fundamentalsSection,
      ctx.smartMoneySection,
      ctx.convictionSection,
    ].filter(Boolean).join('\n\n')

    let secondary: string
    if (overrides.triggered) {
      secondary = `━━━ TECHNICAL OVERRIDE IN EFFECT ━━━
Your fundamental lens normally deprioritizes technicals, but the following conditions REQUIRE you to factor them in:
${overrides.reasons.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}

FULL TECHNICAL DATA:
${ctx.technicalsSection}

${ctx.optionsSection}`
    } else {
      secondary = `━━━ BACKGROUND ONLY --- treat as noise unless price moved 5%+ today or broke a major level ━━━
${(ctx.technicalsSection || '').slice(0, 700)}

${(ctx.optionsSection || '').slice(0, 400)}`
    }

    return `${primary}\n\n${secondary}`
  }

  // Fallback
  return [ctx.technicalsSection, ctx.fundamentalsSection, ctx.smartMoneySection, ctx.optionsSection, ctx.convictionSection].filter(Boolean).join('\n\n')
}

/**
 * Persona-specific REQUIRED citation list for the Lead Analyst.
 * Ensures the Lead anchors on the indicators that matter for their lens.
 */
function buildCitationRequirements(lens: 'technical' | 'fundamental' | 'balanced'): string {
  if (lens === 'technical') {
    return `REQUIRED CITATIONS (technical lens): Your technicalBasis MUST cite at least 3 of: Ichimoku cloud position, ATR-derived stop/target levels, Williams %R, CCI, ROC momentum direction, RSI level, MACD signal, relative strength vs sector. Your fundamentalBasis may be brief ("background only" or one sentence) unless a catalyst override fired.
PATTERNS: If the data shows candle/chart patterns, gaps, trend structure (higher highs/lower lows), you MUST cite them by name. Patterns are your primary signal.`
  }
  if (lens === 'fundamental') {
    return `REQUIRED CITATIONS (fundamental lens): Your fundamentalBasis MUST cite at least 3 of: earnings date, days to earnings, analyst consensus, analyst target upside, P/E vs history, EPS growth, insider signal, congressional trade signal, earnings implied move vs historical. Your technicalBasis may be brief unless a catalyst override fired.
PATTERNS: Fundamental patterns (consistent earnings beats, margin expansion, revenue acceleration, institutional accumulation) matter more than chart patterns for this lens --- cite them if present.`
  }
  // balanced
  return `REQUIRED CITATIONS (balanced lens): Your technicalBasis MUST reference at least 2 of: Ichimoku cloud position, ATR-derived stop/target, Williams %R, CCI, ROC momentum, relative strength vs sector. Your fundamentalBasis MUST reference at least 2 of: analyst consensus, earnings proximity, P/E context, insider signal. When technicals and fundamentals conflict, note the conflict explicitly.
PATTERNS: If the data includes a candle pattern, chart pattern, gap, or trend structure, you MUST cite it by name.`
}

/**
 * GROUNDING_RULE — defense against the hallucination pattern observed in
 * LI/AI/NRG cases (May 2026). Both Lead and Devil were caught citing
 * fabricated institutional positions (e.g. "Berkshire holds 39.81M LI
 * shares"), 13F filings that don't exist, fake insider transactions, and
 * fake congressional trades. The pattern: LLMs pattern-match from training
 * data to produce plausible-sounding specifics for institutional holdings
 * and regulatory filings — categories where the user/Council can't tell
 * fact from fabrication without verification.
 *
 * The fix: when citing SPECIFIC named institutional/regulatory/insider
 * facts, those facts must originate in the bundle data the persona was
 * given. The bundle's smartMoney section has insider transactions and
 * institutional ownership. The bundle's fundamentals section has analyst
 * consensus. Anything not in the bundle should NOT be cited by name.
 *
 * Injected into Lead system prompts and Devil's baseCalibration. */
const GROUNDING_RULE = `CRITICAL --- GROUNDING RULE FOR SPECIFIC CITATIONS: When citing specific named institutional positions (e.g., "Berkshire Hathaway holds X shares"), specific 13F or 13D/G filings, specific congressional trades (e.g., "Nancy Pelosi bought X"), specific named insider transactions, or specific named analyst price targets --- these MUST appear in the bundle data you were given. Look in the smartMoney section (insider transactions, institutional ownership, notable holders) and the fundamentals section (analyst consensus, price targets). If the specific claim is not in the bundle, do NOT cite it. You may say "I don't have specific institutional ownership data for this ticker" or "the bundle doesn't surface a named analyst target" --- both are fine. You may NOT invent, recall from training data, or pattern-match specific positions, filings, or holdings from outside the bundle. This applies to BOTH your initial analysis AND any Round 2 rebuttal. If the other side cites a specific institutional position you don't see in the bundle, do NOT validate it by repeating it as fact --- challenge it as unverified.`

/**
 * Persona-specific system prompt for the Lead Analyst.
 * This is the WHO the Lead is --- their analytical identity.
 */
function buildLeadSystemPrompt(bundle: SignalBundle, lens: 'technical' | 'fundamental' | 'balanced', overrides: CatalystOverrides): string {
  const isForexPair = bundle.ticker.length === 6 && /^[A-Z]{6}$/.test(bundle.ticker) && ['USD','EUR','GBP','JPY','AUD','CAD','NZD','CHF','SEK','NOK','DKK','SGD','HKD','MXN','ZAR','TRY'].some(c => bundle.ticker.startsWith(c) || bundle.ticker.endsWith(c))

  if (isForexPair) {
    return `You are the Lead Analyst in an elite AI council analyzing ${bundle.ticker}. This is a FOREX currency pair. Analysis focuses on: central bank policy divergence, macroeconomic data (inflation, employment, GDP), interest rate differentials, technical price action, and global risk sentiment. There are no earnings, P/E, or insider data for forex. Be decisive. Support every claim with specific data. Your analysis will be challenged by the Devil's Advocate. Never mention missing or unavailable data --- only use what you have. CRITICAL: Absence of data is not evidence. If a metric, disclosure, or detail is unavailable, that is a research limitation --- not a directional argument. Never use phrases like "the lack of X suggests Y" or "the absence of Z validates" to support a directional case. If you cannot find data confirming a hypothesis, the honest answer is "cannot confirm" --- not "therefore the opposite is true." This rule applies even when research returns SOME information but misses a specific sub-question. Phrases like "lacks management explanation," "no commentary on X was provided," or "the data does not address Y" are research gaps, NOT findings. Do not use partial-null answers as red flags or confirmations. If a sub-question wasn't answered, ignore that gap and reason from the parts that WERE answered. IMPORTANT: If price data shows period change >±200%, treat as potential data error.

${GROUNDING_RULE}

CRITICAL --- POST-CATALYST AWARENESS: For forex, the catalysts are FOMC decisions, NFP releases, CPI prints, ECB/BOJ/BOE meetings, and major GDP/PMI data. If one of these occurred within the last 3 trading days AND the pair is still trading near or above the post-event high (for bullish moves) or near/below the post-event low (for bearish moves), you are writing a CONTINUATION thesis, not a fresh-setup thesis. State this distinction explicitly. Continuation trades have meaningfully lower hit rates (~55%) than pre-catalyst setups (~65-70%) because the original catalyst is already reflected in price. Calibrate confidence accordingly. If you maintain a directional call, your trade plan must require a pullback entry (BULLISH) or relief-bounce entry (BEARISH), not at-market chasing of an already-extended move.

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}`
  }

  // Fund-type tickers (ETFs, commodity ETFs, volatility ETPs, bond funds, leveraged funds)
  // get a different analytical framework --- they are NOT operating companies.
  if (isFundTicker(bundle.ticker)) {
    const fundInfo = getFundInfo(bundle.ticker)
    const fundContext = buildFundContext(fundInfo)
    return `You are the Lead Analyst in an elite AI council analyzing ${bundle.ticker}.

${fundContext}

Be decisive. Support every claim with specific data. Your analysis will be challenged by the Devil's Advocate. Never mention missing or unavailable data --- only use what you have. CRITICAL: Absence of data is not evidence. If a metric, disclosure, or detail is unavailable, that is a research limitation --- not a directional argument. Never use phrases like "the lack of X suggests Y" or "the absence of Z validates" to support a directional case. If you cannot find data confirming a hypothesis, the honest answer is "cannot confirm" --- not "therefore the opposite is true." This rule applies even when research returns SOME information but misses a specific sub-question. Phrases like "lacks management explanation," "no commentary on X was provided," or "the data does not address Y" are research gaps, NOT findings. Do not use partial-null answers as red flags or confirmations. If a sub-question wasn't answered, ignore that gap and reason from the parts that WERE answered. IMPORTANT: If price data shows period change >±200%, treat as potential data error.

${GROUNDING_RULE}

CRITICAL --- POST-CATALYST AWARENESS: For funds, the catalysts are FOMC decisions, sector rotation events, ETF rebalances, major macro data (CPI, NFP, PMI), and component-level news for thematic ETFs. If a catalyst occurred within the last 3 trading days AND the fund is still trading near or above the post-event high (for bullish moves) or near/below the post-event low (for bearish moves), you are writing a CONTINUATION thesis, not a fresh-setup thesis. State this distinction explicitly. Continuation trades on funds have meaningfully lower hit rates (~55%) than pre-catalyst setups (~65-70%) because the catalyst is already reflected in price. Calibrate confidence accordingly. If you maintain a directional call, your trade plan must require a pullback entry (BULLISH) or relief-bounce entry (BEARISH), not at-market chasing of an already-extended move.

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}`
  }

  const personaIdentity = {
    technical: `You are the Lead Analyst (TECHNICAL lens) in an elite AI council for ${bundle.ticker}. You are a price-action trader who believes the chart leads everything else. A death cross is bearish regardless of P/E ratio. RSI divergences warn before fundamentals catch up. Moving averages, volume, and pattern breaks are your primary evidence. Fundamentals are background noise unless a catalyst forces your attention --- then, and only then, do you factor them in.`,
    fundamental: `You are the Lead Analyst (FUNDAMENTAL lens) in an elite AI council for ${bundle.ticker}. You are a value-focused analyst who believes business quality and earnings drive long-term price. A 30% drawdown in a high-quality business with strong fundamentals is an opportunity, not a sell signal. Analyst consensus, insider signals, earnings trajectory, and valuation vs history are your primary evidence. Technical chart patterns are background noise unless a major technical event (5%+ gap, 52-week break, death/golden cross) forces your attention.`,
    balanced: `You are the Lead Analyst (BALANCED lens) in an elite AI council for ${bundle.ticker}. You weight technical and fundamental signals equally. When they conflict, note it explicitly and let data quality determine conviction. A clean chart with weak fundamentals and a strong business with a weak chart are BOTH worth flagging --- the Judge wants to see how you reconcile them.`,
  }[lens]

  const overrideNote = overrides.triggered
    ? `\n\nCATALYST OVERRIDE ACTIVE: The data contains conditions that require you to look beyond your normal lens. These overrides will be flagged in the evidence section below. Do NOT dismiss them as background noise --- address them directly in your reasoning.`
    : ''

  return `${personaIdentity}${overrideNote}

Be decisive. Support every claim with specific data. Your analysis will be challenged by the Devil's Advocate. Never mention missing or unavailable data --- only use what you have. CRITICAL: Absence of data is not evidence. If a metric, disclosure, or detail is unavailable, that is a research limitation --- not a directional argument. Never use phrases like "the lack of X suggests Y" or "the absence of Z validates" to support a directional case. If you cannot find data confirming a hypothesis, the honest answer is "cannot confirm" --- not "therefore the opposite is true." This rule applies even when research returns SOME information but misses a specific sub-question. Phrases like "lacks management explanation," "no commentary on X was provided," or "the data does not address Y" are research gaps, NOT findings. Do not use partial-null answers as red flags or confirmations. If a sub-question wasn't answered, ignore that gap and reason from the parts that WERE answered. CRITICAL: Sub-threshold data is not evidence either. If the bundle text labels a metric with "DO NOT CITE" --- e.g., insider activity that is sub-threshold relative to market cap --- treat that metric as effectively zero and do NOT cite it as supporting any directional thesis. A $0.8M officer sale on a $30B-cap company is statistical noise, not a "fundamental headwind." Even if the sign is "selling" or "buying," sub-threshold magnitude means the operational signal does not exist. CRITICAL: For cash, runway, and burn rate claims --- use the "Cash & runway" line from the bundle's fundamentals section directly. The bundle reports a pre-computed runwayQuarters figure based on free cash flow (the correct measure of cash burn). Do NOT compute runway from net income. Net income is NOT cash burn --- it includes large non-cash items (stock-based compensation, depreciation, amortization) that particularly distort runway estimates for tech and software companies, often by an order of magnitude. If the bundle's runway field is null, the company is self-funding (positive FCF) or cash data is unavailable; either way, do not invent a runway figure. IMPORTANT: If the price data shows a period change exceeding ±200%, treat this as a potential data error and note it explicitly rather than building your analysis on it.

${GROUNDING_RULE}

CRITICAL --- POST-CATALYST AWARENESS: Before forming your thesis, identify whether the catalyst-driven move you're describing has ALREADY happened or is YET TO HAPPEN. If a major catalyst (earnings beat/miss, analyst upgrade/downgrade, M&A news, guidance raise/cut) occurred within the last 3 trading days AND the stock is still trading near or above its post-catalyst high (for bullish moves) or near/below its post-catalyst low (for bearish moves), then you are writing a CONTINUATION thesis, not a fresh-setup thesis. State this distinction explicitly in your reasoning --- do not describe an already-completed move as if it's still ahead. Continuation trades historically have meaningfully lower hit rates (~55%) than pre-catalyst setups (~65-70%) because the original catalyst is already reflected in price; the trade is now a momentum-extension bet, not a directional edge call. Calibrate confidence accordingly --- 80%+ confidence on pure continuation theses (no second independent catalyst) overstates the edge. If you maintain a directional call, your trade plan MUST require a pullback entry (for BULLISH) or a relief-bounce entry (for BEARISH) at a level meaningfully below/above current price --- never at-market chasing of an already-extended move.

NEWS RECENCY: Weight news by freshness. Last 24 hours is current and actionable. Last 48-72 hours is recent context. Anything older is background unless it's a structural development (M&A close, leadership change, regulatory ruling). Breaking news from the last 6 hours overrides older narrative coverage.

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}`
}

/**
 * Persona-specific Devil's Advocate system prompt.
 * Cross-pressure: the Devil attacks from the OPPOSITE dimension of the Lead.
 *   Technical Lead -> Devil attacks on fundamental grounds
 *   Fundamental Lead -> Devil attacks on technical grounds
 *   Balanced Lead -> Devil attacks on whichever dimension is weakest (original behavior)
 */
function buildDevilSystemPrompt(bundle: SignalBundle, lens: 'technical' | 'fundamental' | 'balanced'): string {
  // Fund-type tickers get specialized cross-pressure guidance that excludes
  // operating-company concerns (P/E, dilution, earnings) and substitutes
  // fund-specific risks (contango drag, tracking error, structural decay).
  if (isFundTicker(bundle.ticker)) {
    const fundInfo = getFundInfo(bundle.ticker)
    const fundContext = buildFundContext(fundInfo)
    return `You are the Devil's Advocate in an elite AI council for ${bundle.ticker}. The Lead Analyst will present a thesis for this fund --- your role is to stress-test it.

${fundContext}

CALIBRATION RULES --- follow these carefully:

1. The Lead Analyst's thesis is wrong by default until proven right by data. However, if you cannot find compelling data-backed counter-evidence, you MUST return NEUTRAL with honest reasoning --- do NOT manufacture disagreement. Honest NEUTRAL is the correct answer when data supports the Lead.

2. CATEGORY DISCIPLINE: This is a FUND, not an operating company. NEVER cite operating-company concerns (P/E ratio, EPS misses, dilution from prospectus filings, insider transactions, "negative revenue", "net income losses") --- these don't apply to funds. Routine 424B3 prospectus filings are continuous ETF mechanics, NOT dilution events. Citing these is a category error and will weaken your case in the Judge's eyes.

3. APPROPRIATE CROSS-PRESSURE for funds:
   - Contango/backwardation in futures curves (especially for commodity, volatility, leveraged products)
   - Structural decay (volatility drag for leveraged funds, roll costs for futures-based ETFs)
   - Tracking error vs the underlying
   - Macro regime mismatch (e.g., rate-hike risk for bond ETFs, regime-shift for volatility products)
   - Mean reversion at extreme levels
   - Sector-level rotation risk (for sector ETFs)
   - Concentration risk in top holdings (for thematic equity ETFs)

4. Timeframe honesty. Lead's target may be achievable but not within the ${bundle.timeframe} window --- challenge time-to-target alignment.

5. Reflexivity check. Strong technical setups at all-time highs in commodity/leveraged/volatility products are where retail traders get trapped.

6. Absence of a metric is not evidence. Never mention unavailable data --- only argue with what you actually have.

7. Quality over volume. Two rigorous fund-appropriate challenges beat five operating-company challenges that don't apply.

8. Post-catalyst framing check. If the Lead's thesis describes a move that has ALREADY happened (e.g., "fund rallied 5% on FOMC pivot, target X% higher" or "rotation into this sector confirmed"), this is a CONTINUATION thesis with historically lower hit rates than fresh setups. Press the Lead on whether the catalyst is already priced in. Their confidence should reflect that pure momentum-continuation on funds is closer to a coin flip than a high-conviction call. If they maintain a directional call at 80%+ confidence on pure continuation or write at-market entries on a fund already extended from a recent macro/sector catalyst, that is a meaningful weakness to surface. Do NOT manufacture this objection if the Lead has already acknowledged the framing.

9. ${GROUNDING_RULE}

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}`
  }

  const baseCalibration = `CALIBRATION RULES --- follow these carefully:

1. The Lead Analyst's thesis is wrong by default until proven right by data. Your job is to find the specific reasons it might fail. However, if you cannot find compelling data-backed counter-evidence, you MUST return NEUTRAL with honest reasoning --- do NOT weakly agree with the Lead Analyst, and do NOT manufacture disagreement. Honest NEUTRAL is the correct answer when the data genuinely supports the Lead.

2. Timeframe honesty. The Lead Analyst's target may be achievable on paper but not within the stated ${bundle.timeframe} window. Challenge time-to-target alignment, not just direction.

3. Reflexivity check. Strong technical setups at all-time highs are where retail traders get trapped. Strong fundamental setups after 40%+ runs are where late money gets burned. If the Lead is BULLISH on a stock already up significantly, your burden of proof to agree should be higher.

4. Absence of a metric is not evidence. Never mention unavailable data --- only argue with what you actually have.

5. Sub-threshold data is not evidence either. If the bundle text labels a metric with "DO NOT CITE" (e.g., insider activity that is sub-threshold relative to market cap), treat that metric as effectively zero. Do NOT cite it as supporting your cross-pressure thesis. A $0.8M officer sale on a $30B-cap company is statistical noise, not a "fundamental headwind" --- even if the sign is "selling." Manufacturing pressure from sub-threshold signals weakens the Judge's assessment of your case.

6. Cash and runway claims must come from the bundle's "Cash & runway" line. The bundle reports a pre-computed runwayQuarters figure based on free cash flow (the correct measure of burn). Do NOT compute runway from net income --- net income is not cash burn (it includes non-cash items like SBC and D&A that distort runway by an order of magnitude for software/AI companies). If the bundle's runway field is unstated, the company is self-funding or cash data is unavailable; do not invent a runway figure to manufacture bearish pressure.

7. Quality over volume. The Judge weighs the STRENGTH of your challenges, not the count. Two rigorous data-backed challenges beat five weak ones.

8. Post-catalyst framing check. If the Lead's thesis describes a move that has ALREADY happened (e.g., "earnings beat drove a 7% gap, target X% higher" or "pattern target achieved" or "neckline break confirmed targeting $X"), this is a CONTINUATION thesis with historically lower hit rates than fresh setups. Press the Lead on this distinction. Their confidence should reflect that the original catalyst is already priced in --- the trade is now a momentum-continuation bet, which is closer to a coin flip (~55%) than a high-conviction directional call (~65-70%). If they maintain BULLISH/BEARISH at 80%+ confidence on pure continuation (no second independent catalyst) or write at-market entries on a stock already extended from a recent catalyst, that is a meaningful weakness to surface. Do NOT manufacture this objection if the Lead has already acknowledged the framing and calibrated confidence appropriately --- this rule fires when the Lead is treating a continuation trade as a fresh setup.

9. ${GROUNDING_RULE}`

  if (lens === 'technical') {
    return `You are the Devil's Advocate in an elite AI stock council for ${bundle.ticker}. The Lead Analyst is running a TECHNICAL LENS --- they are anchored on chart signals, price action, and momentum. Your role is to CROSS-PRESSURE their thesis from the FUNDAMENTAL side --- the dimension they have structurally deprioritized.

CROSS-PRESSURE STRATEGY:
- Their chart looks clean? Fine. Are earnings coming up? What's the implied move vs their target? Are analysts cutting estimates? Has the insider signal turned? Is valuation already priced in?
- Their momentum is strong? Fine. Is this late-cycle momentum? What's the revenue growth trajectory vs the price? Is the stock trading at a premium to history without earnings support?
- Their breakout is confirmed? Fine. What happens to the breakout if earnings miss by 2 cents? Is the options market pricing more volatility than their target implies?

Your job is to make the Lead DEFEND their technical thesis against the fundamental risks they've structurally underweighted. You are not replacing their lens --- you are stress-testing it from the OPPOSITE side.

${baseCalibration}

10. Cross-pressure discipline: Your challenges should primarily cite fundamental/earnings/analyst/valuation evidence, not re-argue the chart. Let the Lead have their chart --- attack on fundamentals.
11. Earnings proximity: When earnings are within 7 days (see EARNINGS PROXIMITY context if present), pressure-test specifically how much earnings risk is being priced in. A bullish technical thesis 3 days before a print needs to address: (a) what's the implied move? (b) what's analyst revision trend? (c) is the entry level above or below the implied-move band? Don't let the Lead skip past binary catalyst risk.
12. News recency: Weight news by freshness same as the Lead --- last 24h current, 24-72h recent, older background. Don't cite stale narrative as a reason to disagree.

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}`
  }

  if (lens === 'fundamental') {
    return `You are the Devil's Advocate in an elite AI stock council for ${bundle.ticker}. The Lead Analyst is running a FUNDAMENTAL LENS --- they are anchored on earnings quality, valuation, analyst consensus, and insider signals. Your role is to CROSS-PRESSURE their thesis from the TECHNICAL side --- the dimension they have structurally deprioritized.

CROSS-PRESSURE STRATEGY:
- Their fundamental thesis is strong? Fine. What is the chart actually doing RIGHT NOW? Is it in a downtrend? Below key moving averages? Showing RSI divergence? Death cross? Breaking key support?
- Their valuation is cheap? Fine. Cheap can get cheaper. Is there chart evidence of continued weakness? Has momentum turned? Is relative strength vs sector negative?
- Their earnings trajectory is strong? Fine. But stocks often peak before the best earnings are reported. What is the chart saying about forward expectations --- is smart money already distributing?

Your job is to make the Lead DEFEND their fundamental thesis against the technical risks they've structurally underweighted. You are not replacing their lens --- you are stress-testing it from the OPPOSITE side.

${baseCalibration}

10. Cross-pressure discipline: Your challenges should primarily cite chart patterns, price action, technical indicators, and flow evidence --- not re-argue the fundamentals. Let the Lead have their fundamental thesis --- attack on technicals.

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}`
  }

  // balanced --- original calibrated prompt (attack on whatever is weakest)
  return `You are the Devil's Advocate in an elite AI stock council for ${bundle.ticker}. The Lead Analyst is running a BALANCED LENS --- they considered both technicals and fundamentals. Your role is to identify the SPECIFIC dimension where their case is weakest and press there.

SELECTION DISCIPLINE:
- If their technical case is strong but fundamentals are weak, attack on fundamentals
- If their fundamental case is strong but technicals are weak, attack on technicals
- If both look strong, attack on risk/timeframe alignment or broader macro
- Do not try to attack everything --- one deep well-argued challenge beats five scattered ones

${baseCalibration}

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}`
}

function timeframeContext(tf: string): string {
  switch (tf) {
    case '1D': return `TIMEFRAME CONTEXT: This is a 1-DAY intraday analysis. Bars are 15-minute candles.
FOCUS ON: intraday momentum, VWAP position, 15-min RSI, short-term support/resistance, volume spikes.
WEIGHT HEAVILY: RSI on 15-min, VWAP deviation, Williams %R, intraday price action.
DOWNWEIGHT: SMA200 (lagging), fundamental P/E ratios (irrelevant for day), congressional trades (too slow).
TARGETS/STOPS: Use tight ATR-based levels (0.5–1× ATR). Time horizon: same day to next 1-2 sessions.
DO NOT: Suggest multi-week holds. Entry/stop/target should reflect intraday or overnight moves only.`

    case '1W': return `TIMEFRAME CONTEXT: This is a 1-WEEK swing trade analysis. Bars are 1-hour candles.
FOCUS ON: 1-3 week swing setups, hourly trend direction, key daily support/resistance levels.
WEIGHT HEAVILY: RSI on hourly, EMA 9/20 crossovers, MACD crossovers, volume confirmation, nearby earnings.
WEIGHT NORMALLY: SMA50, fundamentals (as catalyst, not primary driver), options flow.
DOWNWEIGHT: SMA200 crossovers (too slow for 1W), 3-month fundamental trends.
TARGETS/STOPS: Use 1.5–2× ATR. Time horizon: 3-10 trading days.`

    case '1M': return `TIMEFRAME CONTEXT: This is a 1-MONTH position trade analysis. Bars are daily candles.
FOCUS ON: Monthly trend, daily SMA50/200 position, fundamentals as primary thesis driver.
WEIGHT HEAVILY: SMA50/200 position and crossovers, golden/death cross, Ichimoku cloud, earnings catalyst, analyst upgrades.
WEIGHT HEAVILY: Fundamentals --- P/E vs history, EPS growth, analyst consensus and price targets.
WEIGHT NORMALLY: RSI (for entry timing only), MACD on daily.
TARGETS/STOPS: Use 2–3× ATR, align with key monthly S/R. Time horizon: 3-6 weeks.`

    case '3M': return `TIMEFRAME CONTEXT: This is a 3-MONTH investment analysis. Bars are daily candles with full trend context.
FOCUS ON: Macro trend, structural support/resistance, fundamental quality vs valuation, institutional flows.
WEIGHT HEAVILY: Fundamentals --- earnings growth, margins, revenue trajectory, analyst target vs current price.
WEIGHT HEAVILY: Ichimoku cloud (structural trend), SMA200 (long-term bias), relative strength vs sector.
WEIGHT HEAVILY: Smart money --- institutional holdings, insider buying, congressional trades.
WEIGHT NORMALLY: Short-term technicals (for entry timing only).
TARGETS/STOPS: Wider stops (3–4× ATR), align with major monthly S/R. Time horizon: 6-13 weeks.
NOTE: Minor technical noise is acceptable in a strong fundamental thesis. What matters is the 3-month trajectory.`

    default: return ''
  }
}

/**
 * Extended-hours context for prompts.
 * Returns a markdown-formatted section ready to inject after timeframeContext().
 * Empty string when there's nothing meaningful (regular session, no significant move).
 *
 * Wired into all 9 prompt assembly sites in this file.
 */
function extendedHoursContext(bundle: SignalBundle): string {
  const eh = bundle.extendedHours
  if (!eh || !eh.promptContext) return ''
  return `\n\nEXTENDED HOURS CONTEXT:\n${eh.promptContext}`
}

/**
 * Earnings-time awareness for prompts.
 *
 * Surfaces granular earnings proximity so the Council can adjust
 * weight on technicals vs catalysts. Pre-earnings windows have
 * structurally different price dynamics than mid-quarter periods.
 *
 * Wired into all 9 prompt assembly sites alongside extendedHoursContext.
 *
 * Tier breakdown:
 *   today       --- earnings reporting today (highest catalyst risk)
 *   tomorrow    --- earnings tomorrow (positioning dominates)
 *   imminent    --- earnings in 2-3 days (implied move pricing in)
 *   this_week   --- earnings in 4-7 days (drift + IV expansion)
 *   next_week   --- earnings in 8-14 days (approaching catalyst)
 *   this_month  --- earnings in 15-30 days (on horizon)
 *   distant     --- >30 days or unknown (no injection)
 */
function earningsContext(bundle: SignalBundle): string {
  const days = bundle.fundamentals?.daysToEarnings
  if (days === null || days === undefined || days < 0 || days > 30) return ''

  const impliedMove = bundle.fundamentals?.earningsImpliedMove ?? null
  const historicalMove = bundle.fundamentals?.earningsHistoricalMove ?? null
  const earningsDate = bundle.fundamentals?.nextEarningsDate ?? null
  const dateStr = earningsDate ? ` on ${earningsDate}` : ''
  const moveCtx = (impliedMove !== null && historicalMove !== null)
    ? ` Options market is pricing a ±${impliedMove.toFixed(1)}% move (historical avg: ±${historicalMove.toFixed(1)}%).`
    : (impliedMove !== null)
    ? ` Options market is pricing a ±${impliedMove.toFixed(1)}% move.`
    : ''

  let header: string
  let guidance: string

  if (days === 0) {
    header = `EARNINGS REPORTING TODAY${dateStr}.`
    guidance = `Technical patterns and chart-based targets are unreliable through the print. Pre-earnings drift may already be baked in. Catalysts dominate price action for the next session.`
  } else if (days === 1) {
    header = `EARNINGS TOMORROW${dateStr}.`
    guidance = `The next 24h price action is dominated by positioning into the print, not technicals. Targets and stops should reflect post-earnings volatility, not chart levels.`
  } else if (days >= 2 && days <= 3) {
    header = `EARNINGS IN ${days} DAYS${dateStr}.`
    guidance = `Pre-earnings positioning is active. Implied move should bound any near-term price target. Bullish technical setups face binary catalyst risk in 48-72h.`
  } else if (days >= 4 && days <= 7) {
    header = `EARNINGS IN ${days} DAYS${dateStr}.`
    guidance = `Earnings within the analysis window. Pre-earnings drift can dominate intraday signals. Options flow and analyst revisions become primary signal; pure chart patterns are weaker than usual.`
  } else if (days >= 8 && days <= 14) {
    header = `EARNINGS IN ${days} DAYS${dateStr}.`
    guidance = `Approaching catalyst. IV expansion likely in coming sessions. Multi-week swing targets must factor in event risk before fill.`
  } else {
    header = `EARNINGS IN ${days} DAYS${dateStr}.`
    guidance = `Catalyst on horizon but not immediate. Note for time-horizon planning, especially on multi-week setups.`
  }

  return `\n\nEARNINGS PROXIMITY: ${header}${moveCtx} ${guidance}`
}

/**
 * Sector + correlated-stock context for prompts.
 * Surfaces sector ETF perf, peer perf, and single-name divergence
 * so the Council can distinguish ticker-specific moves from sector-wide ones.
 *
 * Wired into all 9 prompt assembly sites alongside extendedHoursContext + earningsContext.
 *
 * Returns empty string when no sector data is available (crypto, OTC, unmapped sectors).
 */
function sectorContextString(bundle: SignalBundle): string {
  const sc = bundle.sectorContext
  if (!sc || !sc.promptContext) return ''
  return sc.promptContext
}




// ─────────────────────────────────────────────────────────────
// Verification results formatter for Judge prompt
// ─────────────────────────────────────────────────────────────
// Surfaces specific stripped claims (those that failed Google-search
// verification against credible sources) to the Judge so it can
// discount those claims when weighing the debate. Returns empty
// string if there are no stripped claims to surface — keeps the
// prompt clean when verification was clean or unavailable.
type VerificationsByStage = {
  lead?: VerificationResult
  devil?: VerificationResult
  rebuttal?: VerificationResult
  counter?: VerificationResult
}

function formatVerificationBlockForJudge(v: VerificationsByStage | undefined): string {
  if (!v) return ''

  const stages: Array<{ label: string; result: VerificationResult | undefined }> = [
    { label: 'LEAD ANALYST',     result: v.lead     },
    { label: "DEVIL'S ADVOCATE", result: v.devil    },
    { label: 'REBUTTAL',         result: v.rebuttal },
    { label: 'COUNTER',          result: v.counter  },
  ]

  // Collect stages with at least one stripped claim
  const stagesWithStrips = stages.filter(s => (s.result?.strippedCount ?? 0) > 0)
  if (stagesWithStrips.length === 0) return ''

  // Build the formatted block. Include the stripped claim text and a brief
  // reason (truncated). Keep total verbose enough to inform without bloating
  // the prompt too much --- cap each stage at the top 4 strips.
  const sections = stagesWithStrips.map(s => {
    const strips = (s.result?.strippedClaims ?? []).slice(0, 4)
    const lines = strips.map(c => {
      const reason = (c.reasoning ?? '').slice(0, 180).trim()
      return `  - "${c.claim.slice(0, 200)}"${reason ? ` (rejected: ${reason})` : ''}`
    })
    return `${s.label} stripped claims:\n${lines.join('\n')}`
  })

  return `

━━━ Verification Results ━━━

The following specific factual claims from the debate FAILED external verification (Google search against credible non-social-media sources). Each entry includes the rejection reason — USE THE REASON to calibrate how much to discount the claim. NOT all stripped claims are equally invalid:

${sections.join('\n\n')}

CALIBRATION GUIDANCE — read each rejection reason carefully:

1. CONTRADICTED BY DATA (full discount, treat as false): Apply ONLY when the rejection reason contains explicit contradiction language:
   - "credible sources show X instead of Y"
   - "multiple outlets report X, contradicting the claim"
   - "primary sources confirm X (not Y)"
   - "Bundle contradicts: claim cites X but [authoritative source] shows Y"
   - The reason names a specific opposing value or fact.
   The claim is likely a hallucination or stale training data. Treat it as factually wrong. The argument it supported is materially weakened.

2. UNVERIFIABLE BUT POSSIBLY REAL (partial discount, DEFAULT for ambiguous cases): Apply when the rejection reason indicates absence-of-evidence rather than counter-evidence:
   - "do not report"
   - "no credible source found"
   - "could not corroborate"
   - "insufficient evidence"
   - "source not in credible whitelist"
   - "0 credible grounding sources found"
   - "Possible structured-output glitch"
   The claim may be real internal data the council had access to that just isn't on the public web, or a derived figure (like net insider flow) that aggregators don't typically publish as a single number. Apply moderate skepticism but DO NOT treat as false. The directional argument may still be valid.
   IMPORTANT: When the rejection reason is ambiguous between Category 1 and Category 2, default to Category 2. False-negative verification (missing real facts) is more common than false-positive (manufactured facts), and the cost of mis-categorizing real data as wrong is high.

3. SPECIFIC NUMBER WRONG, DIRECTION RIGHT (minor discount on the number only): If the rejection reason cites a RANGE of values from credible sources — e.g., "claim was 133.8x but sources show range 130-206x" — the model picked an unverifiable specific number, but the directional claim it was supporting (e.g., "expensively valued") is still valid. Discount only the precise figure, not the overall point.

Apply these distinctions when weighing each side's case. If a side's thesis hinges on a category-1 claim (factually contradicted), that side's case is materially weaker. If it relies on a category-2 (unverifiable) or category-3 (figure-only) claim, the weakening is partial. Do not redo the analysis yourself --- just adjust how much credit each side earns based on which kind of failure their evidence had.

DO NOT write phrases like "proven factually incorrect" or "shown to be false" unless the strip falls squarely into Category 1 with explicit contradiction language. For Category 2 strips, use phrases like "could not be independently verified" or "lacked corroborating credible sources."`
}


function repairJSON(raw: string): string {
  let s = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  let result = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (escaped) { result += ch; escaped = false; continue }
    if (ch === '\\') { result += ch; escaped = true; continue }
    if (ch === '"') { inString = !inString; result += ch; continue }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue }
      if (ch === '\r') { result += '\\r'; continue }
      if (ch === '\t') { result += '\\t'; continue }
    }
    result += ch
  }
  return result
}

function parseJSON<T>(text: string): T {
  if (!text || typeof text !== 'string') throw new Error('No JSON in response --- empty or non-string input')
  const clean = text.replace(/```json|```/g, '').trim()
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start === -1 || end === -1) {
    console.error('[parseJSON] No JSON found in:', clean.slice(0, 200))
    throw new Error('No JSON in response')
  }
  const slice = clean.slice(start, end + 1)
  try {
    return JSON.parse(slice) as T
  } catch {
    try {
      const repaired = repairJSON(slice)
      return JSON.parse(repaired) as T
    } catch (e2) {
      console.error('[parseJSON] Parse failed even after repair. First 300 chars:', slice.slice(0, 300))
      throw new Error('JSON parse failed: ' + (e2 instanceof Error ? e2.message : String(e2)))
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(content: any[]): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const block = content.find((b: any) => b.type === 'text') as { text: string } | undefined
  if (!block) throw new Error('No text block in Anthropic response')
  return block.text
}

// ─────────────────────────────────────────────────────────────
// Multi-source Round 2 research helpers (Gap #5)
// ─────────────────────────────────────────────────────────────

async function fetchFreshAlpacaNews(ticker: string, hours = 6): Promise<string[]> {
  const key = process.env.ALPACA_API_KEY
  const secret = process.env.ALPACA_SECRET_KEY
  if (!key || !secret) return []
  const since = new Date(Date.now() - hours * 3600000).toISOString()
  try {
    const res = await fetch(
      `https://data.alpaca.markets/v1beta1/news?symbols=${ticker}&limit=10&start=${since}&sort=desc`,
      { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } }
    )
    if (!res.ok) return []
    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((data.news as any[]) || []).slice(0, 5).map((n: { created_at: string; headline: string; summary?: string }) => {
      const ts = new Date(n.created_at).toISOString().slice(5, 16).replace('T', ' ')
      const headline = (n.headline || '').slice(0, 140)
      const summary  = (n.summary  || '').slice(0, 140)
      return `[${ts}] ${headline}${summary ? ' --- ' + summary : ''}`
    })
  } catch { return [] }
}

async function fetchFreshFinnhubNews(ticker: string, hours = 6): Promise<string[]> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return []
  const daysBack = Math.max(1, Math.ceil(hours / 24))
  const from = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0]
  const to   = new Date().toISOString().split('T')[0]
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${key}`
    )
    if (!res.ok) return []
    const data = await res.json()
    const cutoff = Date.now() - hours * 3600000
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ((data as any[]) || [])
      .filter((n: { datetime: number }) => (n.datetime * 1000) >= cutoff)
      .sort((a: { datetime: number }, b: { datetime: number }) => b.datetime - a.datetime)
      .slice(0, 5)
      .map((n: { datetime: number; headline: string; summary?: string }) => {
        const ts = new Date(n.datetime * 1000).toISOString().slice(5, 16).replace('T', ' ')
        const headline = (n.headline || '').slice(0, 140)
        const summary  = (n.summary  || '').slice(0, 140)
        return `[${ts}] ${headline}${summary ? ' --- ' + summary : ''}`
      })
  } catch { return [] }
}

async function fetchGrokSentiment(ticker: string, question: string): Promise<string> {
  try {
    const result = await callGrok(
      [
        {
          role: 'system',
          content: `You analyze live X (Twitter) posts and social sentiment for ${ticker}. A council member is running a stock debate and has a specific question. Answer in 2-3 sentences, citing specific notable posts or aggregated retail reactions you can verify. If you cannot find at least 3 distinct recent posts addressing this, return exactly: "Insufficient live sentiment signal."`,
        },
        { role: 'user', content: question },
      ],
      { temperature: 0.3, maxTokens: 400, searchEnabled: true, timeoutMs: 45000 }
    )
    const clean = result.trim()
    if (clean.length < 20 || clean.toLowerCase().includes('insufficient live sentiment')) return ''
    return clean.slice(0, 600)
  } catch (e) {
    console.warn('[grok-sentiment] failed:', (e as Error).message?.slice(0, 100))
    return ''
  }
}

function dedupeHeadlines(all: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const h of all) {
    const body = h.replace(/^\[[^\]]+\]\s*/, '').toLowerCase()
    const key  = body.slice(0, 60)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(h)
    if (out.length >= 6) break
  }
  return out
}

export async function runTargetedResearch(
  bundle: SignalBundle,
  question: string,
  context: string
): Promise<string> {

  const q = question.toLowerCase()

  const needsNews          = q.includes('news') || q.includes('recent') || q.includes('latest') || q.includes('announced') || q.includes('report') || q.includes('catalyst') || q.includes('breaking')
  const needsFundamentals  = q.includes('earnings') || q.includes('revenue') || q.includes('pe ') || q.includes('p/e') || q.includes('margin') || q.includes('eps') || q.includes('guidance') || q.includes('analyst') || q.includes('upgrade') || q.includes('downgrade') || q.includes('target')
  const needsOptions       = q.includes('option') || q.includes('put') || q.includes('call') || q.includes('iv ') || q.includes('implied vol') || q.includes('short interest') || q.includes('unusual')
  const needsTechnicals    = q.includes('support') || q.includes('resistance') || q.includes('rsi') || q.includes('macd') || q.includes('volume') || q.includes('moving average') || q.includes('trend') || q.includes('vwap') || q.includes('breakout') || q.includes('breakdown')
  const needsMacro         = q.includes('vix') || q.includes('fed') || q.includes('rate') || q.includes('market') || q.includes('sector') || q.includes('spy') || q.includes('inflation') || q.includes('macro')
  const needsSentiment     = q.includes('sentiment') || q.includes('narrative') || q.includes('saying') || q.includes('buzz') || q.includes('reaction') ||
                             q.includes('twitter') || q.includes('x post') || q.includes('crowd') || q.includes('retail') ||
                             q.includes('fomo') || q.includes('bearish talk') || q.includes('bullish talk') ||
                             q.includes('management said') || q.includes('conference call') || q.includes('reacting')

  // Smart-money branches added May 2026 — prior to this fix the keyword
  // router had no handlers for insider / congressional / institutional
  // questions, so the persona's research call would silently fall back
  // to a generic answer ("data not available in this bundle") even
  // though the bundle's smartMoney object had detailed records the
  // whole time. Now we surface that data directly.
  const needsInsider       = q.includes('insider') || q.includes('10b5-1') || q.includes('form 4') || q.includes('executive sold') || q.includes('executive bought') || q.includes('officer sold') || q.includes('officer bought') || q.includes('director sold') || q.includes('director bought') || q.includes('who sold') || q.includes('who bought')
  const needsCongress      = q.includes('congress') || q.includes('senator') || q.includes('representative') || q.includes('house member') || q.includes('pelosi') || q.includes('political')
  const needsInstitutional = q.includes('institutional') || q.includes('hedge fund') || q.includes('13f') || q.includes('13-f') || q.includes('fund holding') || q.includes('big holder') || q.includes('top holder')

  const liveDataParts: string[] = []

  // ── Bundle-sourced smart-money data (no external calls) ───────────
  // The bundle already carries detailed insider transactions, congressional
  // trades, and institutional holdings. Surface them here so personas
  // doing fresh research get authoritative data instead of a "not
  // available" fallback. EDGAR-sourced (Form 4 + 13F) and Finnhub
  // congressional — these are the source-of-truth numbers the council
  // should anchor on.

  if (needsInsider) {
    const txns = bundle.smartMoney?.insiderTransactions ?? []
    const buyValue = txns.filter(t => t.type === 'buy').reduce((s, t) => s + (t.totalValue ?? 0), 0)
    const sellValue = txns.filter(t => t.type === 'sell').reduce((s, t) => s + (t.totalValue ?? 0), 0)
    if (txns.length > 0) {
      const fmt = (n: number) => n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}K` : `$${n.toFixed(0)}`
      const lines = [
        `INSIDER TRANSACTIONS (last 90 days, EDGAR Form 4 — open-market only):`,
        `  Aggregate: bought ${fmt(buyValue)} | sold ${fmt(sellValue)} | net ${fmt(buyValue - sellValue)}`,
        `  Per-transaction detail (most recent first):`,
        ...txns.slice(0, 15).map(t => {
          const action = t.type === 'buy' ? 'BOUGHT' : 'SOLD'
          return `    • ${t.date} — ${t.name} (${t.title || 'Insider'}) ${action} ${t.shares.toLocaleString()} shares @ $${t.pricePerShare.toFixed(2)} = ${fmt(t.totalValue)}`
        }),
      ]
      liveDataParts.push(lines.join('\n'))
    } else {
      liveDataParts.push(`INSIDER TRANSACTIONS: No open-market Form 4 filings in the last 90 days.`)
    }
  }

  if (needsCongress) {
    const trades = bundle.smartMoney?.congressionalTrades ?? []
    if (trades.length > 0) {
      const buys = trades.filter(t => t.type === 'purchase').length
      const sells = trades.filter(t => t.type === 'sale').length
      const lines = [
        `CONGRESSIONAL TRADES (last 365 days):`,
        `  Total: ${trades.length} (${buys} purchases / ${sells} sales)`,
        `  Per-trade detail:`,
        ...trades.slice(0, 10).map(t =>
          `    • ${t.date} — ${t.member} (${t.chamber}) ${t.type.toUpperCase()} ${t.amount}`
        ),
      ]
      liveDataParts.push(lines.join('\n'))
    } else {
      liveDataParts.push(`CONGRESSIONAL TRADES: No reported trades in the last 365 days.`)
    }
  }

  if (needsInstitutional) {
    const holders = bundle.smartMoney?.institutionalOwnership ?? []
    const notable = bundle.smartMoney?.notableHolders ?? []
    if (holders.length > 0) {
      const lines = [
        `INSTITUTIONAL OWNERSHIP (latest 13F):`,
        `  Top holders (by share count):`,
        ...holders.slice(0, 5).map(h => {
          const dir = h.changeInShares > 0 ? `added ${h.changeInShares.toLocaleString()}`
                    : h.changeInShares < 0 ? `reduced by ${Math.abs(h.changeInShares).toLocaleString()}`
                    : 'unchanged'
          return `    • ${h.name}: ${h.sharesHeld.toLocaleString()} shares — ${dir}`
        }),
      ]
      if (notable.length > 0) lines.push(`  Notable holders flagged: ${notable.join(', ')}`)
      liveDataParts.push(lines.join('\n'))
    } else {
      liveDataParts.push(`INSTITUTIONAL OWNERSHIP: No 13F holder data available.`)
    }
  }

  if (needsTechnicals || needsFundamentals) {
    try {
      const key = process.env.FINNHUB_API_KEY
      if (key) {
        const [quoteRes, metricRes] = await Promise.all([
          fetch(`https://finnhub.io/api/v1/quote?symbol=${bundle.ticker}&token=${key}`),
          fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${bundle.ticker}&metric=all&token=${key}`)
        ])
        if (quoteRes.ok) {
          const q2 = await quoteRes.json()
          liveDataParts.push(`LIVE QUOTE: Current $${q2.c}, Open $${q2.o}, High $${q2.h}, Low $${q2.l}, Prev close $${q2.pc}, Change ${((q2.c-q2.pc)/q2.pc*100).toFixed(2)}%`)
        }
        if (metricRes.ok) {
          const m = await metricRes.json()
          const met = m.metric ?? {}
          liveDataParts.push(`KEY METRICS: 52wk high $${met['52WeekHigh']}, 52wk low $${met['52WeekLow']}, Beta ${met.beta?.toFixed(2)}, P/E ${met.peBasicExclExtraTTM?.toFixed(1)}, EPS TTM $${met.epsTTM?.toFixed(2)}, Revenue growth YoY ${met.revenueGrowthTTMYoy?.toFixed(1)}%, Gross margin ${met.grossMarginTTM?.toFixed(1)}%`)
        }
      }
    } catch { /* non-critical */ }
  }

  if (needsFundamentals) {
    try {
      const key = process.env.FINNHUB_API_KEY
      if (key) {
        const [recRes, ptRes, earningsRes] = await Promise.all([
          fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${bundle.ticker}&token=${key}`),
          fetch(`https://finnhub.io/api/v1/stock/price-target?symbol=${bundle.ticker}&token=${key}`),
          fetch(`https://finnhub.io/api/v1/calendar/earnings?symbol=${bundle.ticker}&token=${key}`)
        ])
        if (recRes.ok) {
          const recs = await recRes.json()
          const r = recs[0]
          if (r) liveDataParts.push(`ANALYST CONSENSUS (latest): ${r.buy + r.strongBuy} buy, ${r.hold} hold, ${r.sell + r.strongSell} sell (${r.period})`)
        }
        if (ptRes.ok) {
          const pt = await ptRes.json()
          if (pt.targetMean) liveDataParts.push(`PRICE TARGETS: Mean $${pt.targetMean?.toFixed(2)}, High $${pt.targetHigh?.toFixed(2)}, Low $${pt.targetLow?.toFixed(2)} (${pt.lastUpdated})`)
        }
        if (earningsRes.ok) {
          const cal = await earningsRes.json()
          const next = (cal.earningsCalendar ?? []).find((e: {date: string}) => new Date(e.date) >= new Date())
          if (next) liveDataParts.push(`NEXT EARNINGS: ${next.date} --- EPS estimate $${next.epsEstimate ?? 'N/A'}, Revenue estimate $${next.revenueEstimate ? (next.revenueEstimate/1e9).toFixed(2)+'B' : 'N/A'}`)
        }
      }
    } catch { /* non-critical */ }
  }

  if (needsNews || needsSentiment) {
    try {
      const [alpacaHeadlines, finnhubHeadlines] = await Promise.all([
        fetchFreshAlpacaNews(bundle.ticker, 6),
        fetchFreshFinnhubNews(bundle.ticker, 6),
      ])
      const deduped = dedupeHeadlines([...alpacaHeadlines, ...finnhubHeadlines])
      if (deduped.length > 0) {
        liveDataParts.push(`FRESH HEADLINES (last 6h, deduped across Alpaca + Finnhub):\n${deduped.join('\n')}`)
      }
    } catch { /* non-critical */ }
  }

  if (needsSentiment) {
    const grokAnswer = await fetchGrokSentiment(bundle.ticker, question)
    if (grokAnswer) {
      liveDataParts.push(`LIVE X SENTIMENT (Grok x_search):\n${grokAnswer}`)
    }
  }

  if (needsOptions) {
    // ── Bundle options data (computed at bundle build) ────────────
    // Surface the pre-computed P/C ratio, max pain, GEX, IV signal,
    // short interest, and unusual activity sweeps. The persona should
    // anchor on these numbers rather than infer them from the live
    // Tradier chain pull below — the bundle's analysis already
    // applied volume/OI/IV thresholds and dealer-positioning logic.
    const of = bundle.optionsFlow
    if (of) {
      const lines = ['BUNDLE OPTIONS ANALYSIS (pre-computed, source-of-truth):']
      if (of.putCallRatio !== null && of.putCallRatio !== undefined) {
        lines.push(`  Put/Call Vol ratio: ${of.putCallRatio.toFixed(2)} (signal: ${of.putCallSignal?.toUpperCase() ?? 'N/A'})`)
      }
      if (of.putCallOIRatio !== null && of.putCallOIRatio !== undefined) {
        lines.push(`  Put/Call OI ratio: ${of.putCallOIRatio.toFixed(2)}`)
      }
      lines.push(`  Open interest: ${of.totalCallOI?.toLocaleString() ?? 'N/A'} calls / ${of.totalPutOI?.toLocaleString() ?? 'N/A'} puts`)
      if (of.maxPainStrike !== null && of.maxPainStrike !== undefined) {
        lines.push(`  Max pain strike: $${of.maxPainStrike.toFixed(2)} (price gravitates here at expiry)`)
      }
      if (of.ivSkew !== null && of.ivSkew !== undefined) {
        lines.push(`  IV skew (put-call): ${(of.ivSkew * 100).toFixed(1)}% — market sentiment: ${of.ivSignal?.toUpperCase() ?? 'N/A'}`)
      }
      if (of.gex !== null && of.gex !== undefined) {
        lines.push(`  Gamma exposure: $${of.gex.toFixed(0)}M (${of.gexSignal?.toUpperCase() ?? 'N/A'})`)
        if (of.gexNote) lines.push(`    ${of.gexNote}`)
      }
      if (of.shortInterestPct !== null && of.shortInterestPct !== undefined) {
        lines.push(`  Short interest: ${of.shortInterestPct.toFixed(1)}% of float (signal: ${of.shortSignal?.toUpperCase().replace('_', ' ') ?? 'N/A'})`)
      } else {
        lines.push(`  Short interest: not available`)
      }
      if (of.unusualActivity && of.unusualActivity.length > 0) {
        lines.push(`  Unusual activity flagged (${of.unusualActivity.length} sweep${of.unusualActivity.length === 1 ? '' : 's'}):`)
        for (const u of of.unusualActivity.slice(0, 5)) {
          lines.push(`    • ${u.signal?.replace('_', ' ').toUpperCase() ?? 'UNUSUAL'}: $${u.strike} ${u.type} expiring ${u.expiry} — vol ${u.volume?.toLocaleString() ?? '?'} vs OI ${u.openInterest?.toLocaleString() ?? '?'} (${u.volOIRatio?.toFixed(1) ?? '?'}× vol/OI ratio, IV ${u.ivPct?.toFixed(0) ?? '?'}%)`)
        }
      } else {
        lines.push(`  Unusual activity: none flagged in bundle`)
      }
      liveDataParts.push(lines.join('\n'))
    }

    // ── Live Tradier chain (intraday snapshot) ────────────────────
    // Adds current chain volume + high-IV strikes on top of the bundle
    // analysis. Useful for confirming or contradicting bundle figures.
    try {
      const tradierKey = process.env.TRADIER_API_KEY
      const tradierBase = tradierKey ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1'
      const expRes = await fetch(
        `${tradierBase}/markets/options/expirations?symbol=${bundle.ticker}&includeAllRoots=true`,
        { headers: { Authorization: `Bearer ${tradierKey}`, Accept: 'application/json' } }
      )
      if (expRes.ok) {
        const expData = await expRes.json()
        const expiries: string[] = expData.expirations?.date ?? []
        if (expiries[0]) {
          const chainRes = await fetch(
            `${tradierBase}/markets/options/chains?symbol=${bundle.ticker}&expiration=${expiries[0]}&greeks=true`,
            { headers: { Authorization: `Bearer ${tradierKey}`, Accept: 'application/json' } }
          )
          if (chainRes.ok) {
            const chain = await chainRes.json()
            const options = chain.options?.option ?? []
            const calls = options.filter((o: {option_type: string}) => o.option_type === 'call')
            const puts  = options.filter((o: {option_type: string}) => o.option_type === 'put')
            const callVol = calls.reduce((s: number, o: {volume: number}) => s + (o.volume || 0), 0)
            const putVol  = puts.reduce((s: number, o: {volume: number}) => s + (o.volume || 0), 0)
            const pcr = callVol > 0 ? (putVol / callVol).toFixed(2) : 'N/A'
            const highIV = options
              .filter((o: {greeks?: {mid_iv: number}}) => o.greeks?.mid_iv)
              .sort((a: {greeks: {mid_iv: number}}, b: {greeks: {mid_iv: number}}) => b.greeks.mid_iv - a.greeks.mid_iv)
              .slice(0, 3)
              .map((o: {strike: number; option_type: string; greeks: {mid_iv: number}; volume: number}) =>
                `$${o.strike} ${o.option_type} IV ${(o.greeks.mid_iv * 100).toFixed(0)}% vol ${o.volume}`)
            liveDataParts.push(`LIVE OPTIONS CHAIN (${expiries[0]}): P/C ratio ${pcr}, Call vol ${callVol}, Put vol ${putVol}`)
            if (highIV.length) liveDataParts.push(`HIGH IV OPTIONS: ${highIV.join(' | ')}`)
          }
        }
      }
    } catch { /* non-critical */ }
  }

  if (needsMacro) {
    try {
      const key = process.env.FINNHUB_API_KEY
      if (key) {
        const [spyRes, vixRes] = await Promise.all([
          fetch(`https://finnhub.io/api/v1/quote?symbol=SPY&token=${key}`),
          fetch(`https://finnhub.io/api/v1/quote?symbol=VIXY&token=${key}`)
        ])
        if (spyRes.ok) {
          const spy = await spyRes.json()
          liveDataParts.push(`SPY: $${spy.c} (${((spy.c-spy.pc)/spy.pc*100).toFixed(2)}% today)`)
        }
        if (vixRes.ok) {
          const vix = await vixRes.json()
          liveDataParts.push(`VIX PROXY (VIXY): $${vix.c} (${((vix.c-vix.pc)/vix.pc*100).toFixed(2)}% today)`)
        }
      }
    } catch { /* non-critical */ }
  }

  const liveData = liveDataParts.length > 0
    ? `\nFRESH LIVE DATA (just fetched):\n${liveDataParts.join('\n\n')}`
    : ''

  const sections: string[] = []
  if (needsNews || !needsTechnicals) sections.push(bundle.aiContext.newsSection)
  if (needsTechnicals) sections.push(bundle.aiContext.technicalsSection)
  if (needsFundamentals) sections.push(bundle.aiContext.fundamentalsSection)
  if (needsOptions) sections.push(bundle.aiContext.optionsSection)
  if (needsMacro) sections.push(bundle.aiContext.marketSection)
  if (needsOptions || needsTechnicals) sections.push(bundle.aiContext.smartMoneySection)
  if (context && !sections.some(s => s === context)) sections.push(context)

  const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']
  for (const modelName of GEMINI_MODELS) {
    try {
      const model = getGenAI().getGenerativeModel({ model: modelName })
      const result = await model.generateContent(`You are the News Scout providing urgent real-time research during a live stock debate about ${bundle.ticker} (currently $${bundle.currentPrice.toFixed(2)}).
DEBATE TIMEFRAME: ${bundle.timeframe} --- keep your answer relevant to this horizon.

A council member has asked: "${question}"
${liveData}

SIGNAL DATA FROM BUNDLE:
${sections.join('\n\n')}

Answer in 2-4 sentences using the freshest data available, prioritizing the LIVE DATA section if present. When FRESH HEADLINES are shown, cite at least one by timestamp if it's directly relevant. When LIVE X SENTIMENT is shown, reference it explicitly. Include specific numbers, dates, and percentages. Be direct and decisive --- this goes straight into the debate. If the data genuinely doesn't support the question, say so clearly.`)
      return result.response.text().trim().slice(0, 700)
    } catch (e) {
      const msg = (e as Error).message ?? ''
      if (!msg.includes('503') && !msg.includes('overload') && !msg.includes('404')) throw e
    }
  }
  return 'Research unavailable at this time.'
}

export async function runGemini(bundle: SignalBundle): Promise<GeminiResult> {
  const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']
  let lastError: Error | null = null
  for (const modelName of GEMINI_MODELS) {
    try {
      const model = getGenAI().getGenerativeModel({ model: modelName })
      const tfFocus: Record<string, string> = {
        '1D': 'FOCUS on TODAY only --- intraday news, pre/post-market moves, breaking catalysts. Ignore multi-week trends.',
        '1W': 'FOCUS on THIS WEEK --- earnings this week, analyst actions, macro data releases in the next 5 days.',
        '1M': 'FOCUS on THIS MONTH --- upcoming earnings date, recent upgrades/downgrades, sector rotation.',
        '3M': 'FOCUS on NEXT QUARTER --- earnings trajectory, macro tailwinds/headwinds, institutional positioning.',
      }
      const newsInput = (bundle.aiContext.newsSection || '').slice(0, 6000)
      const marketInput = (bundle.aiContext.marketSection || '').slice(0, 2000)

      const result = await model.generateContent(`You are the News Scout and Macro Analyst for an elite AI stock council.

Analyze all news, macro, and market context for ${bundle.ticker}. You go first. Be specific.
TIMEFRAME: ${bundle.timeframe} --- ${tfFocus[bundle.timeframe] ?? ''}

${newsInput}

${marketInput}

Respond JSON ONLY (no fences):
{"summary":"3 sentence overview","headlines":["top 4-5 headlines"],"sentiment":"positive|negative|neutral|mixed","confidence":<0-100>,"keyEvents":["2-4 near-term catalysts relevant to the ${bundle.timeframe} timeframe"],"macroFactors":["2-3 macro conditions"],"regimeAssessment":"1 sentence on regime impact"}`)
      const rawText = result.response.text()
      return parseJSON<GeminiResult>(rawText)
    } catch (e) {
      lastError = e as Error
      const msg = (e as Error).message ?? ''
      const isLastModel = modelName === GEMINI_MODELS[GEMINI_MODELS.length - 1]
      if (isLastModel) throw e
      console.warn(`News Scout model ${modelName} failed (${msg.slice(0,60)}), trying next...`)
    }
  }
  throw lastError ?? new Error('News Scout unavailable --- all models failed')
}

// ─────────────────────────────────────────────────────────────
// LEAD ANALYST --- persona-aware evidence filtering (Gap #7)
// ─────────────────────────────────────────────────────────────
export async function runClaude(bundle: SignalBundle, gemini: GeminiResult, social?: SocialSentiment, aggregator?: AggregatorScoutResult): Promise<ClaudeResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const persona = ((bundle as any).persona ?? 'balanced') as PersonaKey
  const lens = resolveLens(persona, bundle.timeframe)
  const overrides = detectOverrides(bundle, lens)

  const systemPrompt = buildLeadSystemPrompt(bundle, lens, overrides)
  const evidenceBlock = buildLeadEvidenceBlock(bundle, lens, overrides)
  const citationReqs = buildCitationRequirements(lens)

  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `TICKER: ${bundle.ticker} | TIMEFRAME: ${bundle.timeframe} | PRICE: $${bundle.currentPrice.toFixed(2)} | LENS: ${lens.toUpperCase()}${isPersonaExplicit(persona) ? ' (user-selected)' : ' (timeframe default)'}

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}

NEWS SCOUT BRIEF:
${gemini.summary}
Sentiment: ${gemini.sentiment} | Regime: ${gemini.regimeAssessment}
Events: ${gemini.keyEvents.join('; ')}

${social ? formatSocialSentimentForPrompt(social, 'lead') : ''}

${aggregator ? formatAggregatorForPrompt(aggregator, 'lead') : ''}

YOUR EVIDENCE (filtered for ${lens} lens):
${evidenceBlock}

${/* eslint-disable-next-line @typescript-eslint/no-explicit-any */ ''}${(bundle.aiContext as any).macroIntelligenceSection ? (bundle.aiContext as any).macroIntelligenceSection + '\n\n' : ''}${citationReqs}

JSON ONLY:
{"signal":"BULLISH|BEARISH|NEUTRAL","reasoning":"4-5 sentences integrating all signals through your ${lens} lens","target":"price target e.g. $195","confidence":<0-100>,"technicalBasis":"2-3 sentences${lens === 'technical' ? ' --- this is your primary evidence' : lens === 'fundamental' ? ' --- brief, this is background unless override fired' : ''}","fundamentalBasis":"2 sentences${lens === 'fundamental' ? ' --- this is your primary evidence' : lens === 'technical' ? ' --- brief, this is background unless override fired' : ''}","catalysts":["2-3 catalysts"],"keyRisks":["2-3 risks"]}`
    }]
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return parseJSON<ClaudeResult>(extractText(msg.content as any[]))
}

// ─────────────────────────────────────────────────────────────
// DEVIL'S ADVOCATE --- cross-pressure by Lead's lens (Gap #7)
// ─────────────────────────────────────────────────────────────
export async function runGPT(bundle: SignalBundle, gemini: GeminiResult, claude: ClaudeResult, social?: SocialSentiment, aggregator?: AggregatorScoutResult): Promise<GptResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const persona = ((bundle as any).persona ?? 'balanced') as PersonaKey
  const lens = resolveLens(persona, bundle.timeframe)
  const devilSystemPrompt = buildDevilSystemPrompt(bundle, lens)

  // Evidence block: Devil sees FULL data regardless of Lead's lens,
  // with emphasis on the opposite-dimension data for cross-pressure
  let devilEvidence = ''
  if (lens === 'technical') {
    devilEvidence = `━━━ CROSS-PRESSURE TARGETS (use these to attack the technical Lead) ━━━

FUNDAMENTALS (the Lead deprioritized these --- you should exploit them):
${bundle.aiContext.fundamentalsSection}

${bundle.aiContext.smartMoneySection}

━━━ Technical context the Lead anchored on (for reference only) ━━━
${bundle.aiContext.technicalsSection}

${bundle.aiContext.optionsSection}

${bundle.aiContext.convictionSection}`
  } else if (lens === 'fundamental') {
    devilEvidence = `━━━ CROSS-PRESSURE TARGETS (use these to attack the fundamental Lead) ━━━

TECHNICALS (the Lead deprioritized these --- you should exploit them):
${bundle.aiContext.technicalsSection}

${bundle.aiContext.optionsSection}

━━━ Fundamental context the Lead anchored on (for reference only) ━━━
${bundle.aiContext.fundamentalsSection}

${bundle.aiContext.smartMoneySection}

${bundle.aiContext.convictionSection}`
  } else {
    // balanced --- Devil sees everything equally
    devilEvidence = `${bundle.aiContext.technicalsSection}
${bundle.aiContext.fundamentalsSection}
${bundle.aiContext.optionsSection}
${bundle.aiContext.convictionSection}`
  }

  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1000,
    messages: [
      { role: 'system', content: devilSystemPrompt },
      { role: 'user', content: `TICKER: ${bundle.ticker} | PRICE: $${bundle.currentPrice.toFixed(2)} | LEAD'S LENS: ${lens.toUpperCase()}

NEWS SCOUT: ${gemini.sentiment} sentiment, ${gemini.confidence}% confidence
${gemini.summary}

LEAD ANALYST (${claude.signal}, ${claude.confidence}%): ${claude.reasoning}
Target: ${claude.target} | Risks: ${claude.keyRisks.join('; ')}

${social ? formatSocialSentimentForPrompt(social, 'devil') : ''}

${aggregator ? formatAggregatorForPrompt(aggregator, 'devil') : ''}

${devilEvidence}

Before you respond, ask yourself: "If the Lead Analyst is right, what specific data would I expect to see? Do I see it?" If the answer is "yes, I see it," return NEUTRAL with that honest reasoning. Do not invent opposition.

JSON ONLY:
{"agrees":<true|false>,"signal":"BULLISH|BEARISH|NEUTRAL","reasoning":"4 sentences --- if returning NEUTRAL because data supports the Lead, be explicit about that","confidence":<0-100>,"challenges":["2-4 specific data-backed challenges${lens !== 'balanced' ? ` --- cite ${lens === 'technical' ? 'fundamental/earnings/analyst/valuation' : 'chart/momentum/flow/technical'} evidence per your cross-pressure discipline` : ''}; if no substantive challenges exist, return 1-2 items describing why the Lead's confidence should be lower"],"alternateScenario":"scenario the Lead Analyst underweights --- or 'none, the Lead's scenario accounts for known risks'","strongestCounterArgument":"single most compelling counter --- or 'no compelling counter; the thesis survives scrutiny'"}` }
    ]
  })
  return parseJSON<GptResult>(completion.choices[0].message.content!)
}

// ─────────────────────────────────────────────────────────────
// BUG 19: Research cache — pulls prior R2 research questions for
// the same ticker from analyses.transcript within a time window.
// Allows Lead/Devil to know what's already been asked and
// generate NEW questions exploring different angles.
// ─────────────────────────────────────────────────────────────

/**
 * Parse a numbered list of questions from LLM output.
 * Robust to: "1. Q\n2. Q", "1) Q\n2) Q", lone questions, missing numbering.
 * Always returns exactly `expected` entries; pads/trims as needed.
 */
function parseNumberedQuestions(text: string, expected: number): string[] {
  const trimmed = (text || '').trim()
  if (!trimmed) return Array(expected).fill('What is the most important recent data point for this ticker?')
  // Try to match "1. Question\n2. Question" or "1) Question\n2) Question"
  const lineMatches = trimmed.split(/\r?\n/).map(line => {
    const m = line.match(/^\s*\d+\s*[.)\]]\s*(.+?)\s*$/)
    return m ? m[1].trim() : line.trim()
  }).filter(s => s.length > 8 && s.includes('?'))
  if (lineMatches.length >= expected) return lineMatches.slice(0, expected)
  // Fallback: split on sentence boundaries with question marks
  const sentenceMatches = trimmed.split(/(?<=\?)\s+/).map(s => s.trim()).filter(s => s.endsWith('?') && s.length > 8)
  if (sentenceMatches.length >= expected) return sentenceMatches.slice(0, expected)
  // Combine what we have, pad with generic if short
  const collected = [...lineMatches, ...sentenceMatches.filter(s => !lineMatches.includes(s))]
  while (collected.length < expected) {
    collected.push(`What additional data should I know about ${collected.length === 0 ? 'this thesis' : 'unresolved aspects'}?`)
  }
  return collected.slice(0, expected)
}
const RESEARCH_CACHE_WINDOW_MINUTES = Number(process.env.RESEARCH_CACHE_WINDOW_MINUTES ?? '60')
const RESEARCH_CACHE_MAX_ROWS = 3   // pull from up to 3 most-recent prior runs

interface CachedResearchEntry {
  question: string
  answer: string
  ageMinutes: number
}

/**
 * Fetch prior R2 research Q&A pairs for a ticker within the configured window.
 * Used by runRebuttal and runCounter to inform their question-generation.
 * Returns empty array on any error (cache miss is non-fatal).
 */
async function getCachedResearchQuestions(
  ticker: string,
  forRole: 'claude' | 'gpt',   // whose prior questions we want
): Promise<CachedResearchEntry[]> {
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) return []
    const admin = createClient(url, key)
    const cutoff = new Date(Date.now() - RESEARCH_CACHE_WINDOW_MINUTES * 60 * 1000).toISOString()
    const { data, error } = await admin
      .from('analyses')
      .select('created_at, transcript')
      .eq('ticker', ticker)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(RESEARCH_CACHE_MAX_ROWS)
    if (error || !data) return []
    const stage = forRole === 'claude' ? 'rebuttal' : 'counter'
    const out: CachedResearchEntry[] = []
    for (const row of data) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transcript = row.transcript as any[]
      if (!Array.isArray(transcript)) continue
      const entry = transcript.find(t => t?.stage === stage && t?.role === forRole)
      if (!entry) continue
      const ageMs = Date.now() - new Date(row.created_at).getTime()
      const ageMinutes = Math.floor(ageMs / 60_000)
      // Read both new (researchQuestions[]) and legacy (researchQuestion) shapes
      const qs: string[] = Array.isArray(entry.researchQuestions)
        ? entry.researchQuestions
        : (typeof entry.researchQuestion === 'string' ? [entry.researchQuestion] : [])
      const as: string[] = Array.isArray(entry.researchAnswers)
        ? entry.researchAnswers
        : (typeof entry.researchAnswer === 'string' ? [entry.researchAnswer] : [])
      const n = Math.min(qs.length, as.length)
      for (let i = 0; i < n; i++) {
        if (qs[i] && as[i]) {
          out.push({ question: qs[i], answer: as[i], ageMinutes })
        }
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Format cached research as a prompt block for the Lead/Devil to see what's
 * already been asked. Empty string when no cached entries.
 */
function formatCachedResearchBlock(cached: CachedResearchEntry[]): string {
  if (cached.length === 0) return ''
  const lines = cached.slice(0, 6).map((c, i) =>
    `${i + 1}. (${c.ageMinutes}min ago) "${c.question}"\n   Answer: ${c.answer.slice(0, 400)}${c.answer.length > 400 ? '...' : ''}`
  )
  return `

PREVIOUSLY ASKED RESEARCH (within last ${RESEARCH_CACHE_WINDOW_MINUTES}min, do NOT re-ask these):
${lines.join('\n')}

Generate questions exploring DIFFERENT angles than what's listed above.`
}

// Lead Analyst rebuts the Devil's Advocate challenges
export async function runRebuttal(
  bundle: SignalBundle,
  claude: ClaudeResult,
  gpt: GptResult
): Promise<RebuttalResult> {

  // Bug 19: pull cached prior research for this ticker so we don't re-ask
  const cachedResearch = await getCachedResearchQuestions(bundle.ticker, 'claude')
  const cacheBlock = formatCachedResearchBlock(cachedResearch)

  const researchAsk = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 250,
    system: `You are the Lead Analyst in a stock debate about ${bundle.ticker}. You can send TWO research questions to the News Scout (who has access to real-time news, fundamentals, options flow, and market data) before you respond to the Devil's Advocate. Choose two questions that target the most important data points to resolve the Devil's strongest challenges. The two questions should explore DIFFERENT angles --- do not ask variations of the same thing. Return them as a numbered list, ONE QUESTION PER LINE: "1. <question>\\n2. <question>". Nothing else.`,
    messages: [{
      role: 'user',
      content: `YOUR ORIGINAL CALL: ${claude.signal} at $${bundle.currentPrice.toFixed(2)}, target ${claude.target}

DEVIL'S ADVOCATE CHALLENGES:
${gpt.challenges.map((c, i) => `${i+1}. ${c}`).join('\n')}
STRONGEST COUNTER: ${gpt.strongestCounterArgument}${cacheBlock}

What TWO questions should the News Scout research right now to help you respond? Format as:
1. <first question>
2. <second question>`
    }]
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const researchAskText = extractText(researchAsk.content as any[]).trim()
  const researchQuestions = parseNumberedQuestions(researchAskText, 2)

  const researchContext = `${bundle.aiContext.technicalsSection}\n${bundle.aiContext.fundamentalsSection}\n${bundle.aiContext.smartMoneySection}\n${bundle.aiContext.optionsSection}\n${bundle.aiContext.marketSection}`
  // Run both research calls in parallel — News Scout is independent per question
  const researchAnswers = await Promise.all(
    researchQuestions.map(q => runTargetedResearch(bundle, q, researchContext))
  )

  const researchBlock = researchQuestions.map((q, i) =>
    `Question ${i + 1}: "${q}"\nAnswer ${i + 1}: ${researchAnswers[i]}`
  ).join('\n\n')

  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: `You are the Lead Analyst in an elite AI stock council for ${bundle.ticker}. The News Scout just provided fresh research from TWO of your questions. Use both responses. Defend your position where data supports you, concede where the Devil's Advocate is correct. Intellectual honesty wins with the Judge --- a thoughtful concession beats a dishonest defense.`,
    messages: [{
      role: 'user',
      content: `YOUR ORIGINAL CALL: ${claude.signal} on ${bundle.ticker} at $${bundle.currentPrice.toFixed(2)}, target ${claude.target}
YOUR REASONING: ${claude.reasoning}

DEVIL'S ADVOCATE CHALLENGES:
${gpt.challenges.map((c, i) => `${i+1}. ${c}`).join('\n')}
STRONGEST COUNTER: ${gpt.strongestCounterArgument}
ALTERNATE SCENARIO: ${gpt.alternateScenario}

NEWS SCOUT RESEARCH (fresh data from TWO questions, just retrieved):
${researchBlock}

Now respond directly to each challenge. Reference the fresh research where relevant. Concede valid points --- you are not required to defend every position. Defend positions backed by data. Update your price target if warranted. CRITICAL: If the research came back inconclusive ("data not available," "not disclosed in filings," or otherwise failed to confirm or deny what was asked), treat that as a null finding --- NOT as evidence for or against your thesis. Do not write "the lack of X confirms my view" or similar constructions. If research was inconclusive, say so plainly and rely on your other evidence. This applies to PARTIAL nulls too. If the research returned some content but didn't address one of your sub-questions (e.g., gave you company financials but no comment on insider behavior), do not flag the missing sub-question as a "red flag" or use phrases like "notably lacks explanation." Use what the research DID provide; ignore what it didn't.

JSON ONLY (do NOT echo the research questions or answers — they are already known on the server):
{
  "signal": "BULLISH|BEARISH|NEUTRAL",
  "confidence": <0-100>,
  "rebuttal": "3-4 sentences directly responding to the challenges, referencing the fresh research",
  "concedes": ["specific points you now agree the Devil's Advocate got right --- be honest, 1-3 items"],
  "maintains": ["specific points you stand firm on with data backing --- 2-4 items"],
  "updatedTarget": "revised price target or same as before",
  "finalStance": "one sentence --- your maintained position after considering all challenges and research"
}`
    }]
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = parseJSON<RebuttalResult>(extractText(msg.content as any[]))
  return {
    ...raw,
    researchQuestions,
    researchAnswers,
    // Legacy aliases for any consumer still reading old fields
    researchQuestion: researchQuestions.join(' | '),
    researchAnswer: researchAnswers.join('\n\n---\n\n'),
  }
}

export async function runCounter(
  bundle: SignalBundle,
  gpt: GptResult,
  rebuttal: RebuttalResult
): Promise<CounterResult> {

  // Bug 19: pull cached prior research for this ticker (Devil's prior questions)
  const cachedResearch = await getCachedResearchQuestions(bundle.ticker, 'gpt')
  const cacheBlock = formatCachedResearchBlock(cachedResearch)

  // Format the Lead's R2 research (now array shape) into a string for prompt context
  const leadResearchSummary = (rebuttal.researchQuestions ?? []).map((q, i) =>
    `"${q}" → ${(rebuttal.researchAnswers ?? [])[i] ?? '(no answer)'}`
  ).join('; ')

  const researchAsk = await getOpenAI().chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 250,
    messages: [
      { role: 'system', content: `You are the Devil's Advocate in a stock debate about ${bundle.ticker}. You can send TWO research questions to the News Scout (who has access to real-time news, fundamentals, options flow, and market data) before firing back at the Lead Analyst. Choose two questions that strengthen your challenges from DIFFERENT angles --- do not ask variations of the same thing. Return them as a numbered list, ONE QUESTION PER LINE: "1. <question>\\n2. <question>". Nothing else.` },
      { role: 'user', content: `LEAD ANALYST'S REBUTTAL: ${rebuttal.rebuttal}
THEY CONCEDE: ${rebuttal.concedes.join('; ')}
THEY MAINTAIN: ${rebuttal.maintains.join('; ')}
FRESH RESEARCH THEY USED: ${leadResearchSummary}${cacheBlock}

What TWO questions should the News Scout research right now to help you counter? Format as:
1. <first question>
2. <second question>` }
    ]
  })
  const researchAskText = researchAsk.choices[0].message.content?.trim() ?? ''
  const researchQuestions = parseNumberedQuestions(researchAskText, 2)

  const researchContext = `${bundle.aiContext.technicalsSection}\n${bundle.aiContext.fundamentalsSection}\n${bundle.aiContext.smartMoneySection}\n${bundle.aiContext.optionsSection}\n${bundle.aiContext.marketSection}`
  // Run both research calls in parallel
  const researchAnswers = await Promise.all(
    researchQuestions.map(q => runTargetedResearch(bundle, q, researchContext))
  )

  const researchBlock = researchQuestions.map((q, i) =>
    `Question ${i + 1}: "${q}"\nAnswer ${i + 1}: ${researchAnswers[i]}`
  ).join('\n\n')

  const counterSystem = `You are the Devil's Advocate in an elite AI stock council for ${bundle.ticker}. The News Scout just provided fresh research from TWO of your questions. Use both responses. This is your final shot.

CALIBRATION: Yield on a challenge ONLY if the Lead Analyst directly refuted it AND your fresh research confirms their refutation. Mitigation is not refutation --- if the Lead's rebuttal merely softened a challenge by adding an offsetting factor, your challenge still stands. Defensive admissions about risk do not count as resolution. The Judge weighs argument QUALITY. Yielding on weakly-pressured challenges is fine; yielding on points the Lead failed to actually refute is dishonest. If your strongest challenges remain materially unresolved, say so plainly and press them with the fresh research.`

  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1200,
    messages: [
      { role: 'system', content: counterSystem },
      { role: 'user', content: `YOUR ORIGINAL CHALLENGES: ${gpt.challenges.join('; ')}

LEAD ANALYST'S REBUTTAL: ${rebuttal.rebuttal}
THEY CONCEDE: ${rebuttal.concedes.join('; ')}
THEY MAINTAIN: ${rebuttal.maintains.join('; ')}
UPDATED TARGET: ${rebuttal.updatedTarget}
RESEARCH THEY CITED: ${leadResearchSummary}

YOUR FRESH RESEARCH (from TWO questions, just retrieved):
${researchBlock}

Now fire back. Acknowledge where their rebuttal was convincing --- yielding on weak challenges strengthens your remaining ones. Use the fresh research to press on unresolved weaknesses. What must the Judge not ignore?

JSON ONLY (do NOT echo the research questions or answers — they are already known on the server):
{
  "finalChallenge": "2-3 sentences --- your strongest remaining challenge, referencing fresh research where relevant",
  "yieldsOn": ["points where their rebuttal directly refuted your challenge AND fresh research confirms the refutation --- 0-2 items, leave empty array if no genuine refutations"],
  "pressesOn": ["points that remain unresolved and the Judge must weigh --- 2-3 items"],
  "closingArgument": "one sentence --- the single most important thing for the Judge to consider"
}` }
    ]
  })
  const raw = parseJSON<CounterResult>(completion.choices[0].message.content!)
  return {
    ...raw,
    researchQuestions,
    researchAnswers,
    // Legacy aliases for any consumer still reading old fields
    researchQuestion: researchQuestions.join(' | '),
    researchAnswer: researchAnswers.join('\n\n---\n\n'),
  }
}

// ─────────────────────────────────────────────────────────────
// JUDGE --- NEUTRAL across all personas (Gap #7)
// Removed persona-specific weighting. The user picked a lens for the Lead,
// the Devil cross-pressured it; Judge's job is to weigh the debate on merit
// regardless of what persona the user selected.
// ─────────────────────────────────────────────────────────────
function buildJudgeSystemPrompt(bundle: SignalBundle): string {
  return `You are the Judge of an elite AI stock council for ${bundle.ticker}. The council has three roles: News Scout, Lead Analyst, and Devil's Advocate. You hold NO prior position. You weigh technical and fundamental arguments EQUALLY regardless of what analytical lens the Lead Analyst used. Higher quality evidence wins regardless of type.

PROCEDURAL RULES:
- YOUR JOB IS TO JUDGE THE DEBATE, NOT REDO THE ANALYSIS. The Lead Analyst already analyzed the data. The Devil's Advocate already cross-pressured. The News Scout already filtered news. Your job is to weigh which side built the stronger case --- not to re-evaluate the underlying signals from scratch. If you find yourself starting a sentence with "the RSI is..." or "the price is X% below the SMA200..." you've gone wrong. Cite the COUNCIL MEMBER, not the raw indicator. Example: "The Lead correctly identified the death cross, but the Devil's Advocate's research into insider buying at higher prices materially weakened the bearish case." That's judging. "RSI at 30 with MACD bearish suggests further downside" is re-analyzing --- don't do that.
- WEIGHT NOVELTY OVER REPETITION. If the Devil's Round 2 research surfaced a fact neither side considered initially (e.g., insider buy prices, supply-chain detail, regulatory deadline), give it disproportionate weight. The debate progressed because of new information; honor that progression. Do NOT weight a point more heavily just because both sides discussed it at length.
- Weigh argument QUALITY, not vote count or word count.
- The Lead Analyst ran with a specific lens (technical, fundamental, or balanced). The Devil's Advocate cross-pressured from the opposite dimension (or attacked the weakest point for balanced). This is by design. Weight both arguments on their merit --- do not automatically favor the Lead's lens because the user picked it.
- Both sides received equal research access (each consulted the News Scout once in Round 2). Weight their research contributions equally.
- Treat concessions as signs of intellectual honesty, not weakness. A side that concedes a point and defends the rest well often has the stronger case than a side that refuses to concede anything.
- If the Devil's Advocate returned NEUTRAL honestly because the data supports the Lead, weight that higher than an aggressive but weakly-supported BEARISH call.
- Never cite missing or unavailable data as a reason for lower conviction. If a metric is unavailable, ignore it entirely rather than mentioning its absence.
- Refer to council members by their role names only.

═════════════════════════════════════════════════════════════════════
OPTIONS STRATEGY GUIDANCE — for the optionsStrategy field
═════════════════════════════════════════════════════════════════════

The optionsStrategy field is a real strategic recommendation, not a generic "consider calls if bullish" paragraph. Translate the available options data (in BUNDLE OPTIONS ANALYSIS and any LIVE TRADIER CHAIN sections) into specific strike/expiry/structure recommendations. Apply these principles:

1. DELTA IS DIRECTIONAL EXPOSURE, NOT PROBABILITY. A 0.30 delta call behaves like 30 shares of the underlying per contract. The 0.30 figure is also approximately the probability of finishing ITM at expiry, but only as a side effect — what matters for strategy is the directional exposure. Match delta to conviction: high conviction + directional thesis → 0.50-0.70 delta (closer to ITM, more directional, less leverage). Low/medium conviction or wanting cheap optionality → 0.20-0.35 delta (further OTM, more leverage, lower hit rate).

2. IV CONTEXT MATTERS MORE THAN ABSOLUTE IV. 50% IV is high for SPY but low for ARKK or biotech. When the bundle reports IV skew, IV signal, or earnings implied move vs historical, USE that comparison. If implied move is meaningfully larger than historical (e.g., ±2.6% implied vs ±0.6% historical), IV is elevated and long premium is expensive — favor spreads over naked long. If implied move is at or below historical, long premium is cheap — naked long calls/puts make sense.

3. EXPIRY MATCHES THESIS HORIZON, WITH BUFFER. For 1D timeframe verdicts: 0-7 day expiries (weekly options). For 1W: 14-30 day expiries (you want time for the move to develop AND time to exit before final-week theta acceleration). For 1M: 30-60 day expiries. For 3M: 60-120 day expiries. NEVER recommend an expiry that ends before the catalyst the thesis depends on (e.g., don't recommend a Friday-expiring call when the thesis hinges on next Tuesday's earnings).

4. STRUCTURE FOLLOWS IV REGIME AND CONVICTION:
   - High conviction + LOW IV: long calls/puts (ATM or slightly ITM, ~0.55-0.65 delta) — premium is cheap, you want max directional exposure
   - High conviction + HIGH IV: vertical debit spreads (buy ATM, sell OTM) — you reduce premium cost and IV crush risk; max profit at short strike
   - Medium conviction + any IV: vertical debit spreads — defines risk, lower cost, accepts capped profit
   - Low conviction or "directional but uncertain timing": calendar spreads or diagonals — short-dated short strike captures decay, long-dated long strike provides directional exposure if thesis plays out
   - Pre-earnings IV crush risk: avoid naked long premium, prefer iron condor or vertical spread to neutralize vega
   - High GEX (positive, dealers long gamma): mean-reversion environment — favor selling premium near pinned levels, fade extremes
   - Negative GEX (dealers short gamma): trending environment — favor directional long premium, breakouts have momentum

5. CITE THE BUNDLE'S OPTIONS DATA SPECIFICALLY. The BUNDLE OPTIONS ANALYSIS section provides P/C ratio, max pain, IV skew, GEX, short interest, and unusual sweep activity. Reference these in your reasoning. Examples:
   - "P/C volume of 1.71 reflects elevated put buying which often precedes a squeeze higher when fundamentals are improving — supports the bullish bias for short-dated calls"
   - "Max pain at $48 suggests pinning risk — favor a vertical spread with short strike at or above $50 to avoid expiring at max pain"
   - "Unusual sweep on $55 calls expiring in 3 weeks (1886 vol vs 384 OI) provides a follow-the-flow target for long call exposure"

6. OUTPUT REQUIREMENTS for optionsStrategy:
   - Specify structure (long call/put, vertical spread, calendar, etc.)
   - Specify strike(s) — anchor to current price + delta target (e.g., "ATM ~$48 calls" or "buy $48/sell $55 vertical")
   - Specify expiry — anchor to thesis horizon (e.g., "30-45 DTE" or "weekly expiring next Friday")
   - State the IV context (high/normal/low relative to historical or earnings move)
   - State the dollar risk per contract (or per spread)
   - One sentence explaining WHY this beats just buying the stock (leverage, defined risk, IV monetization, etc.)

DO NOT write generic "consider buying calls" recommendations. If the verdict is BULLISH but conviction is low, recommend a vertical debit spread rather than naked long calls — that's a real strategic differentiator. If the verdict is NEUTRAL, recommend an iron condor or short straddle rather than nothing — neutral verdicts have valid premium-selling strategies. If the bundle data is insufficient (no live chain, no IV), state that and recommend simplest structure (e.g., "with limited live chain data, default to a 30-DTE vertical debit spread at the verdict's entry price ± ATR").

═════════════════════════════════════════════════════════════════════

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}`
}

function buildJudgeUserPrompt(
  bundle: SignalBundle,
  gemini: GeminiResult,
  claude: ClaudeResult,
  gpt: GptResult,
  rebuttal: RebuttalResult | undefined,
  counter: CounterResult | undefined,
  round: number,
  social: SocialSentiment | undefined,
  aggregator: AggregatorScoutResult | undefined,
  verifications: VerificationsByStage | undefined,
): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const persona = ((bundle as any).persona ?? 'balanced') as PersonaKey
  const lens = resolveLens(persona, bundle.timeframe)

  const newsScout = `NEWS SCOUT BRIEFING (neutral source):
${gemini.summary}
Sentiment: ${gemini.sentiment} | Confidence: ${gemini.confidence}% | Regime: ${gemini.regimeAssessment}
Key events: ${gemini.keyEvents.join('; ')}`

  const socialBlock = social ? formatSocialSentimentForPrompt(social, 'judge') : ''
  const aggregatorBlock = aggregator ? formatAggregatorForPrompt(aggregator, 'judge') : ''

  const round1 = `━━━ ROUND 1 --- Initial Positions ━━━

LEAD ANALYST position: ${claude.signal} @ ${claude.confidence}% confidence [${lens.toUpperCase()} lens${isPersonaExplicit(persona) ? ', user-selected' : ', timeframe default'}]
  Thesis:             ${claude.reasoning}
  Technical evidence: ${claude.technicalBasis}
  Fundamental evidence: ${claude.fundamentalBasis}
  Price target:       ${claude.target}
  Catalysts cited:    ${(claude.catalysts ?? []).join('; ')}
  Key risks (self-identified): ${(claude.keyRisks ?? []).join('; ')}

DEVIL'S ADVOCATE position: ${gpt.signal} @ ${gpt.confidence}% confidence (${gpt.agrees ? 'agrees with Lead' : 'disagrees with Lead'})${lens !== 'balanced' ? ` [cross-pressure from ${lens === 'technical' ? 'fundamental' : 'technical'} dimension]` : ''}
  Thesis:                ${gpt.reasoning}
  Challenges raised:     ${gpt.challenges.join('; ')}
  Alternate scenario:    ${gpt.alternateScenario}
  Strongest single counter: ${gpt.strongestCounterArgument}`

  // Bug 19: Format multiple research Q&A pairs (now arrays) into a clean prompt block
  const formatResearchPairs = (qs: string[] | undefined, as: string[] | undefined): string => {
    const questions = qs ?? []
    const answers = as ?? []
    if (questions.length === 0) return '(no research)'
    return questions.map((q, i) =>
      `    Q${i + 1}: "${q}"\n    A${i + 1}: ${answers[i] ?? '(no answer)'}`
    ).join('\n')
  }

  const round2 = rebuttal ? `

━━━ ROUND 2 --- After Independent Research ━━━

LEAD ANALYST researched:
${formatResearchPairs(rebuttal.researchQuestions, rebuttal.researchAnswers)}
  
  Updated position:  ${rebuttal.signal} @ ${rebuttal.confidence}% confidence
  Response to Devil: ${rebuttal.rebuttal}
  Points maintained: ${rebuttal.maintains.join('; ')}
  Points conceded:   ${rebuttal.concedes.join('; ')}
  Updated target:    ${rebuttal.updatedTarget}
  Final stance:      ${rebuttal.finalStance}

DEVIL'S ADVOCATE researched:
${formatResearchPairs(counter?.researchQuestions, counter?.researchAnswers)}
  
  Final challenge:   ${counter?.finalChallenge ?? ''}
  Points pressing:   ${(counter?.pressesOn ?? []).join('; ')}
  Points conceded:   ${(counter?.yieldsOn ?? []).join('; ')}
  Closing argument:  ${counter?.closingArgument ?? ''}` : ''

  const judgeTask = `

━━━ Your Task as Judge ━━━

The Lead Analyst ran a ${lens.toUpperCase()} lens --- they structurally emphasized ${lens === 'technical' ? 'chart/momentum/flow evidence and deprioritized fundamentals' : lens === 'fundamental' ? 'earnings/valuation/analyst/insider evidence and deprioritized technicals' : 'both dimensions equally'}. The Devil's Advocate ${lens === 'balanced' ? 'attacked the weakest point of the thesis' : `cross-pressured from the ${lens === 'technical' ? 'fundamental' : 'technical'} dimension`}. Both sides had equal research access in Round 2.

Reach a verdict based on which set of evidence is stronger on the weight of the data. You are NEUTRAL --- do not automatically favor the Lead's lens. If the Devil's cross-pressure challenge genuinely exposed a blind spot the user's lens missed, reflect that in your verdict. If the Lead's lens was appropriate for the setup and the Devil manufactured opposition from a dimension that didn't matter, reward that.

Reward honest NEUTRAL calls when data warranted them. Penalize aggressive positions that weren't supported by the specific evidence presented.`

  return `TICKER: ${bundle.ticker} | PRICE: $${bundle.currentPrice.toFixed(2)} | ROUND: ${round} | LEAD LENS: ${lens.toUpperCase()} | TIMEFRAME: ${bundle.timeframe}

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}

${newsScout}

${socialBlock}
${aggregatorBlock}
${formatVerificationBlockForJudge(verifications)}

${round1}${round2}${judgeTask}

━━━ Supplementary Data for Verdict Calibration ━━━

${/* eslint-disable-next-line @typescript-eslint/no-explicit-any */ ''}${(bundle.aiContext as any).macroIntelligenceSection ? (bundle.aiContext as any).macroIntelligenceSection + '\n\n' : ''}OPTIONS FLOW & VOLATILITY:
${(bundle.aiContext.optionsSection || '').slice(0, 1500)}

KEY TECHNICAL CONTEXT (for stop/target calibration):
${(bundle.aiContext.technicalsSection || '').slice(0, 1500)}

CONVICTION ENGINE:
${(bundle.aiContext.convictionSection || '').slice(0, 1000)}

JSON ONLY --- include ALL fields below:
{
  "signal": "BULLISH|BEARISH|NEUTRAL",
  "confidence": <0-100>,
  "target": "specific price target that MUST align with takeProfit. For BULLISH: above current price. For BEARISH: below current price. For NEUTRAL: within 5% of current price either direction.",
  "risk": "single most critical risk in one sentence",
  "summary": "4-5 sentence professional verdict",
  "winningArgument": "who made the strongest case and exactly why --- name the side and the specific argument",
  "dissent": "strongest opposing view in one sentence",
  "scenarios": [
    {"label":"bull","probability":<0-100>,"trigger":"specific catalyst"},
    {"label":"base","probability":<0-100>,"trigger":"base case condition"},
    {"label":"bear","probability":<0-100>,"trigger":"specific risk event"}
  ],
  "invalidationTrigger": "the single clearest signal this thesis is wrong",
  "rounds": ${round},
  "entryPrice": "REQUIRED FORMAT: A specific dollar price (e.g. '$197.50') OR a tight range (e.g. '$195-$198 on a pullback'). When the signal is BULLISH or BEARISH AND confidence is ≥55% AND earnings are NOT within the timeframe-specific block window (1D: same-day; 1W: ≤1 day; 1M: ≤3 days; 3M: ≤7 days), you MUST provide a parseable dollar price. Use technical levels from the bundle (ATR-derived bands, Fibonacci retracements, EMA9/20/50, support/resistance) as anchors. ONLY when the directional thesis is genuinely contingent on a future event (earnings within block window, pending catalyst that needs to develop) may you return 'N/A --- wait for [specific event]'. Do NOT return 'N/A' just because of mild uncertainty or split signals — pick the best technical anchor and commit. The Trader downstream cannot evaluate trade quality without a parseable entry, so when in doubt, give a numeric anchor with surrounding qualitative context in actionPlan.",
  "stopLoss": "REQUIRED FORMAT: A specific dollar price below entry (BULLISH) or above entry (BEARISH). When entryPrice is a parseable dollar value, stopLoss MUST also be a parseable dollar value. CRITICAL: For BULLISH signal this MUST be BELOW entry; for BEARISH MUST be ABOVE entry. Use ATR-derived stops (typically 1.5-2× ATR for 1W timeframe, 0.5-1× ATR for 1D, 2-3× ATR for 1M+). Example BULLISH at $197 with ATR $13: '$171 --- 2× ATR below entry'. Only return 'N/A --- depends on post-event price discovery' when entryPrice is also N/A.",
  "takeProfit": "REQUIRED FORMAT: A specific dollar price above entry (BULLISH) or below entry (BEARISH). When entryPrice is a parseable dollar value, takeProfit MUST also be a parseable dollar value. CRITICAL: For BULLISH MUST be ABOVE entry; for BEARISH MUST be BELOW entry. Aim for at least 1.5:1 R:R relative to the stop (1D/1W) or 2:1 (1M/3M). Example BULLISH at $197 stop $171: '$236 first target (3× ATR above entry, 1.5:1 R:R)'. Only return 'N/A --- depends on post-event price discovery' when entryPrice is also N/A.",
  "timeHorizon": "MUST match the selected timeframe: 1D=same day to next session, 1W=3-10 trading days, 1M=3-6 weeks, 3M=6-13 weeks. Currently: ${bundle.timeframe}",
  "plainEnglish": "Explain the verdict in simple plain English as if talking to someone who has never traded before. 3-4 sentences. No jargon.",
  "technicalsExplained": "Explain what the technical signals mean in plain English. Cover chart patterns, gaps, trend structure, Ichimoku cloud, RSI/Williams/CCI agreement. 4-5 sentences.",
  "fundamentalsExplained": "Explain what the fundamental signals mean in plain English. Analyst ratings, earnings implications, insider activity, implied move if applicable. 3-4 sentences.",
  "smartMoneyExplained": "Explain smart money signals in plain English. Insider buying/selling, congressional trades, options flow, GEX, short interest. 3-4 sentences.",
  "actionPlan": "Clear, specific, step-by-step action plan. Reference ATR-derived stop and target. 4-5 sentences.",
  "optionsStrategy": "REQUIRED FORMAT: One detailed paragraph (4-6 sentences) following the OPTIONS STRATEGY GUIDANCE in the system prompt. MUST include: (a) specific structure (long call/put, vertical spread, calendar, iron condor — not just 'options'), (b) specific strike(s) anchored to current price + target delta, (c) specific expiry window anchored to thesis horizon, (d) IV regime context (elevated/normal/compressed vs historical or earnings implied move), (e) approximate dollar risk per contract or spread, (f) one sentence on why this structure beats simply trading the stock. Cite the bundle's options data (P/C ratio, max pain, GEX, IV skew, unusual sweeps) by specific values where relevant. Do NOT write generic 'consider buying calls' recommendations — that fails the format requirement."
}`
}

async function runJudgeClaude(
  bundle: SignalBundle,
  gemini: GeminiResult,
  claude: ClaudeResult,
  gpt: GptResult,
  rebuttal: RebuttalResult | undefined,
  counter: CounterResult | undefined,
  round: number,
  social: SocialSentiment | undefined,
  aggregator: AggregatorScoutResult | undefined,
  verifications: VerificationsByStage | undefined,
): Promise<JudgeResult> {
  const systemPrompt = buildJudgeSystemPrompt(bundle)
  const userPrompt   = buildJudgeUserPrompt(bundle, gemini, claude, gpt, rebuttal, counter, round, social, aggregator, verifications)

  const msg = await getAnthropic().messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 6000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textBlock = msg.content.find((b: any) => b.type === 'text') as { type: 'text'; text: string } | undefined
  if (!textBlock) throw new Error('No text content in Judge response')
  const raw = parseJSON<JudgeResult>(textBlock.text)
  return { ...raw, judgeModel: 'claude-opus-4-7' }
}

async function runJudgeGemini(
  bundle: SignalBundle,
  gemini: GeminiResult,
  claude: ClaudeResult,
  gpt: GptResult,
  rebuttal: RebuttalResult | undefined,
  counter: CounterResult | undefined,
  round: number,
  social: SocialSentiment | undefined,
  aggregator: AggregatorScoutResult | undefined,
  verifications: VerificationsByStage | undefined,
): Promise<JudgeResult> {
  const systemPrompt = buildJudgeSystemPrompt(bundle)
  const userPrompt   = buildJudgeUserPrompt(bundle, gemini, claude, gpt, rebuttal, counter, round, social, aggregator, verifications)
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`

  const { text, modelUsed } = await generateWithFallback({
    prompt: fullPrompt,
    caller: 'judge:draft',
    temperature: 0.2,
    maxOutputTokens: 8192,
    responseMimeType: 'application/json',
  })
  const raw = parseJSON<JudgeResult>(text)
  return { ...raw, judgeModel: modelUsed }
}

// ─────────────────────────────────────────────────────────────
// GAP #8 --- Confidence Calibration Round
// ─────────────────────────────────────────────────────────────
// LLMs systematically overconfidence their predictions. The calibrator
// reads the full debate transcript + draft verdict and recommends a
// confidence adjustment. Claude Opus runs this (different family than
// the Gemini Judge) for model-diversity calibration.
//
// Direction: bidirectional. Calibrator can push up OR down, with
// asymmetric thresholds: pushing down is the default when both sides
// made valid points; pushing up requires strong convergence from both.

/**
 * Build the calibration system prompt. Independent of lens/persona
 * because calibration is about confidence math, not analytical framing.
 */
function buildJudgeReviewerSystemPrompt(bundle: SignalBundle): string {
  return `You are the Judge Reviewer in an elite AI stock council for ${bundle.ticker}. The Judge has produced a DRAFT verdict. Your job is to audit the draft against a 5-rule checklist BEFORE the verdict ships to the user.

You are NOT re-arguing the directional case. You are NOT proposing alternative verdicts. You ONLY check for specific procedural and structural issues per these 5 rules:

═════════════════════════════════════════════════════════════════════
RULE 1 — Re-analysis instead of judging (procedural)
═════════════════════════════════════════════════════════════════════
Did the Judge's reasoning cite raw indicators (e.g. "RSI at 65", "price 27% above SMA200", "earnings beat by $0.07") as if making the case itself, rather than evaluating which side cited those indicators more effectively? The Judge's job is to weigh which side built the stronger argument --- not to redo the analysis. Re-analysis sentences typically start with "the RSI is..." or "the price is X% above...". Judging sentences typically start with "the Lead correctly identified..." or "the Devil's R2 research materially weakened..."

Flag specific examples if found. If clean, return an empty array.

═════════════════════════════════════════════════════════════════════
RULE 2 — Confidence calibration (calibration)
═════════════════════════════════════════════════════════════════════
Does the Judge's confidence number match what the debate actually shows?

CALIBRATION PRINCIPLES:
1. LLMs systematically overconfidence predictions. The base rate bias is toward numbers that are too high. When in doubt, lean toward lowering.
2. Mutual concessions indicate real uncertainty. If BOTH Lead and Devil conceded meaningful points in Round 2, confidence should reflect genuine ambiguity --- regardless of how strong the winning argument sounded. A 78% confidence on a debate where both sides honestly conceded is almost certainly overcalibrated.
3. Asymmetric thresholds:
   - PUSH DOWN when you see: mutual concessions, unresolved challenge from the losing side, research answers that partially supported the other side, surface-level argument quality, reflexivity concerns (late cycle, all-time highs, extreme positioning), post-catalyst continuation theses
   - PUSH UP requires: strong mutual convergence, losing side explicitly yielded on multiple points, overwhelming data convergence, clear catalyst alignment
4. Timeframe honesty. A 3-month thesis with 80% confidence is often more justified than a 1-day call with 80% confidence. Short timeframes have more noise.
5. Signal-specific calibration:
   - NEUTRAL can warrant HIGH confidence (70-80%+) when data is genuinely ambiguous
   - BULLISH/BEARISH above 75% should be RARE and only justified by overwhelming convergence
   - Most real-world calls belong in the 55-72% range

Material severity: a calibration miss of 15+ points (e.g., draft is 80% but evidence supports 60-65%) is MATERIAL and triggers retry. Smaller misses (5-10 points) are surface-only.

═════════════════════════════════════════════════════════════════════
RULE 3 — Trade plan structural issues (math/format)
═════════════════════════════════════════════════════════════════════
Does the entry/stop/target add up consistently?

For BULLISH verdicts: target MUST be > entry, AND entry MUST be > stop (price rises through entry, climbs to target, falls through stop). If the math is inverted, FLAG.

For BEARISH verdicts: target MUST be < entry, AND entry MUST be < stop (price falls through entry, drops to target, rises through stop). If the math is inverted, FLAG.

For NEUTRAL verdicts: prices may be null or vague --- no flag needed.

Also flag: prices that are not parseable as dollar values (e.g., entry says "above breakout" with no number), risk/reward ratio implied by the levels seems wildly off from the stated R:R, or stop is closer than 0.3x ATR to entry (inside noise).

Rule 3 flags are MATERIAL — they trigger retry.

═════════════════════════════════════════════════════════════════════
RULE 4 — Options strategy format violations (per Bug 25 contract)
═════════════════════════════════════════════════════════════════════
If the verdict includes an optionsStrategy field, does it include all 6 required components?

  (a) Specific structure (long call/put, vertical spread, calendar, iron condor — NOT just "options" or "calls")
  (b) Specific strike(s) anchored to current price + target delta
  (c) Specific expiry window anchored to thesis horizon
  (d) IV regime context (elevated/normal/compressed vs historical or earnings implied move)
  (e) Approximate dollar risk per contract or spread
  (f) One sentence on why this beats simply trading the stock

Flag SPECIFIC missing components (e.g., "no expiry window specified" or "no IV context"). Rule 4 flags are SURFACE-ONLY (do not trigger retry) — the verdict still ships, the user sees the note.

═════════════════════════════════════════════════════════════════════
RULE 5 — Verdict signal contradicts debate weight
═════════════════════════════════════════════════════════════════════
Does the signal match where the evidence landed?

Examples of contradiction:
- Both sides conceded the bull case was materially stronger, but verdict is BEARISH
- Lead's case was demolished by Devil's R2 research, but verdict is high-confidence BULLISH
- The signal is the opposite of what the winning argument's direction was

This is rare. Most of the time the Judge directionally aligns with the winning argument. But when it doesn't, that's a serious procedural failure that requires retry.

Rule 5 flags are MATERIAL — they trigger retry.

═════════════════════════════════════════════════════════════════════
RULE 6 — Source integrity (debate contaminated by fabricated/hallucinated material)
═════════════════════════════════════════════════════════════════════
Did the Judge's draft narrative explicitly acknowledge that the debate built on fabricated, hallucinated, or verification-failed sources?

This rule fires when phrases like the following appear in the draft's summary, winningArgument, or dissent fields:
  - "fabricated", "hallucinated", "made-up", "invented"
  - "proven factually incorrect", "proven false", "could not verify"
  - "verification stripped", "failed verification"
  - "no such filing exists", "claim does not stand"
  - "fictitious", "spurious", references to false specifics

This is a real failure mode: when the Lead or Devil cites a specific institutional position, 13F filing, congressional trade, insider transaction, or analyst target that does not exist in the bundle data, they have HALLUCINATED. The Judge may catch it (good — defense in depth working) but allowing those phrases into the user-facing verdict prose is unprofessional and breaks trust. A retry forces the Judge to re-derive the verdict using only verified evidence so the prose is clean.

Flag SPECIFIC instances. Each entry in sourceIntegrityIssues should describe ONE contaminated claim that influenced the draft (e.g., "Lead R2 cited fabricated Berkshire Hathaway 39.81M LI share position" or "Devil R1 invented institutional ownership claim").

Rule 6 flags are MATERIAL — they trigger retry with explicit instruction to re-derive without the contaminated framing.

═════════════════════════════════════════════════════════════════════

OUTPUT contract:

You return strict JSON. The schema includes all 6 rules' findings PLUS overall status. Material concerns trigger a one-shot Judge retry; minor notes only get surfaced. Cleanness is the default — only flag when the rule actually fires.

overallStatus computation:
- "clean" = no flags on any rule
- "minor_notes" = flags only on rules 1 or 4, AND rule 2 adjustment if any is <15 points
- "material_concerns" = rules 3, 5, or 6 fired, OR rule 2 adjustment is >=15 points

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}`
}

/** Backwards-compat: previous code references buildCalibratorSystemPrompt.
 *  The renamed buildJudgeReviewerSystemPrompt is the canonical name now,
 *  but this alias keeps existing call sites working without modification. */
function buildCalibratorSystemPrompt(bundle: SignalBundle): string {
  return buildJudgeReviewerSystemPrompt(bundle)
}

async function runJudgeReviewer(
  bundle: SignalBundle,
  draftJudge: JudgeResult,
  gemini: GeminiResult,
  claude: ClaudeResult,
  gpt: GptResult,
  rebuttal: RebuttalResult | undefined,
  counter: CounterResult | undefined,
): Promise<JudgeReviewResult> {

  const systemPrompt = buildJudgeReviewerSystemPrompt(bundle)

  const concedesCount = rebuttal?.concedes?.length ?? 0
  const yieldsCount = counter?.yieldsOn?.length ?? 0
  const bothConceded = concedesCount > 0 && yieldsCount > 0

  const userPrompt = `TICKER: ${bundle.ticker} | TIMEFRAME: ${bundle.timeframe} | PRICE: $${bundle.currentPrice.toFixed(2)}

━━━ DRAFT VERDICT (what you're reviewing) ━━━
Judge model:     ${draftJudge.judgeModel ?? 'unknown'}
Draft signal:    ${draftJudge.signal}
Draft confidence: ${draftJudge.confidence}%
Draft summary:   ${draftJudge.summary}
Winning argument: ${draftJudge.winningArgument}
Dissenting view:  ${draftJudge.dissent}

━━━ DRAFT TRADE PLAN (for Rule 3 check) ━━━
Entry:  ${draftJudge.entryPrice ?? '(none)'}
Stop:   ${draftJudge.stopLoss ?? '(none)'}
Target: ${draftJudge.takeProfit ?? '(none)'}
Time horizon: ${draftJudge.timeHorizon ?? '(none)'}

━━━ DRAFT OPTIONS STRATEGY (for Rule 4 check) ━━━
${draftJudge.optionsStrategy ?? '(no options strategy provided — Rule 4 is N/A)'}

━━━ DEBATE EVIDENCE (what you use to evaluate) ━━━

LEAD ANALYST (${claude.signal} @ ${claude.confidence}% initially):
  Reasoning: ${claude.reasoning}
  ${rebuttal ? `After research, updated to ${rebuttal.signal} @ ${rebuttal.confidence}%.
  CONCEDED (${concedesCount} points): ${rebuttal.concedes.join('; ')}
  MAINTAINED: ${rebuttal.maintains.join('; ')}
  Final stance: ${rebuttal.finalStance}` : '(no rebuttal)'}

DEVIL'S ADVOCATE (${gpt.signal} @ ${gpt.confidence}% initially):
  Reasoning: ${gpt.reasoning}
  Strongest counter: ${gpt.strongestCounterArgument}
  ${counter ? `After research, final challenge: ${counter.finalChallenge}
  YIELDED (${yieldsCount} points): ${counter.yieldsOn.join('; ')}
  STILL PRESSING: ${counter.pressesOn.join('; ')}
  Closing: ${counter.closingArgument}` : '(no counter)'}

NEWS SCOUT: ${gemini.summary}

━━━ OBSERVATIONS ━━━
- Both sides conceded meaningful points: ${bothConceded ? 'YES --- this is a strong signal of genuine ambiguity; confidence should be moderate' : 'NO --- one or both sides did not concede'}

━━━ YOUR TASK ━━━

Audit the draft against the 5-rule checklist. Output strict JSON with findings for each rule. Be MECHANICAL — only flag when a rule actually fires; don't manufacture issues to look thorough.

If the trade plan is missing (entry/stop/target all null on a directional verdict), that itself is a Rule 3 flag.

If draft.optionsStrategy is null or "(no options strategy provided)", Rule 4 is N/A and optionsStrategyIssues should be empty.

JSON ONLY:
{
  "draftConfidence": ${draftJudge.confidence},
  "draftSignal": "${draftJudge.signal}",
  "recommendedConfidence": <0-100 integer — your calibrated recommendation (Rule 2)>,
  "adjustmentDelta": <recommendedConfidence - draftConfidence, can be negative>,
  "adjustmentDirection": "up|down|unchanged",
  "confidenceBand": { "low": <integer>, "high": <integer> },
  "reasoning": "2-3 sentences explaining the calibration call. Cite specific concessions, unresolved challenges, or convergence evidence.",
  "overconfidenceFlags": ["specific signs the draft was too confident, 0-3 items"],
  "underconfidenceFlags": ["specific signs the draft was too cautious, 0-3 items"],
  "mutualConcessions": ${bothConceded},
  "unresolvedChallenge": "the single strongest still-open challenge from the losing side, or null if thesis cleanly won",
  "reAnalysisFlags": ["specific examples of the draft Judge re-analyzing instead of judging (Rule 1), 0-3 items. Empty array if clean."],
  "tradePlanIssues": ["specific structural problems with entry/stop/target (Rule 3), 0-3 items. Empty array if clean. Examples: 'BULLISH but stop ($52) above entry ($48)', 'Target is unparseable: above breakout', 'Stop within 0.15× ATR — inside noise band'"],
  "optionsStrategyIssues": ["specific missing components in optionsStrategy (Rule 4), 0-6 items. Empty array if clean or N/A. Examples: 'No expiry window specified', 'No IV regime context', 'Generic recommend calls without strikes'"],
  "signalMismatchConcern": "single string describing how signal contradicts debate weight (Rule 5), or null if signal aligns with evidence.",
  "sourceIntegrityIssues": ["specific instances where the draft acknowledged contaminated sources (Rule 6), 0-5 items. Empty array if clean. Examples: 'Lead R2 cited fabricated Berkshire Hathaway 13F position', 'Devil R2 invented institutional ownership claim that failed verification'. Scan summary/winningArgument/dissent for words like fabricated/hallucinated/proven false/could not verify."]
}`

  try {
    const msg = await getAnthropic().messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 2000,  // increased from 1200 — extra rules need more room
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = parseJSON<Omit<JudgeReviewResult, 'calibratorModel' | 'overallStatus' | 'materialRuleNumbers'>>(extractText(msg.content as any[]))

    // Clamp recommendedConfidence to 0-100 and recompute delta/direction defensively
    const clampedRec = Math.max(0, Math.min(100, Math.round(raw.recommendedConfidence)))
    const delta = clampedRec - draftJudge.confidence
    const direction: 'up' | 'down' | 'unchanged' =
      Math.abs(delta) < 2 ? 'unchanged' : delta > 0 ? 'up' : 'down'

    // Defensive normalization of array fields — model may return null/undefined
    // for any field; coerce to empty arrays.
    const reAnalysisFlags = Array.isArray(raw.reAnalysisFlags) ? raw.reAnalysisFlags.slice(0, 5) : []
    const tradePlanIssues = Array.isArray(raw.tradePlanIssues) ? raw.tradePlanIssues.slice(0, 5) : []
    const optionsStrategyIssues = Array.isArray(raw.optionsStrategyIssues) ? raw.optionsStrategyIssues.slice(0, 6) : []
    const signalMismatchConcern = typeof raw.signalMismatchConcern === 'string' && raw.signalMismatchConcern.trim() ? raw.signalMismatchConcern : null
    const sourceIntegrityIssues = Array.isArray(raw.sourceIntegrityIssues) ? raw.sourceIntegrityIssues.slice(0, 5) : []

    // ── Compute overallStatus deterministically based on which rules fired ──
    // material if rule 3, 5, or 6 fired, OR if rule 2 delta >= 15 (severe miscalibration)
    const materialRuleNumbers: number[] = []
    if (tradePlanIssues.length > 0) materialRuleNumbers.push(3)
    if (signalMismatchConcern) materialRuleNumbers.push(5)
    if (sourceIntegrityIssues.length > 0) materialRuleNumbers.push(6)
    if (Math.abs(delta) >= 15) materialRuleNumbers.push(2)

    // minor if any flag fired but no material ones
    const anyFlagFired =
      reAnalysisFlags.length > 0 ||
      optionsStrategyIssues.length > 0 ||
      direction !== 'unchanged' ||
      materialRuleNumbers.length > 0

    const overallStatus: JudgeReviewResult['overallStatus'] =
      materialRuleNumbers.length > 0 ? 'material_concerns'
      : anyFlagFired ? 'minor_notes'
      : 'clean'

    return {
      draftConfidence: draftJudge.confidence,
      draftSignal: draftJudge.signal,
      recommendedConfidence: clampedRec,
      adjustmentDelta: delta,
      adjustmentDirection: direction,
      confidenceBand: raw.confidenceBand ?? { low: clampedRec, high: clampedRec },
      reasoning: raw.reasoning ?? '',
      overconfidenceFlags: Array.isArray(raw.overconfidenceFlags) ? raw.overconfidenceFlags.slice(0, 3) : [],
      underconfidenceFlags: Array.isArray(raw.underconfidenceFlags) ? raw.underconfidenceFlags.slice(0, 3) : [],
      mutualConcessions: !!raw.mutualConcessions,
      unresolvedChallenge: typeof raw.unresolvedChallenge === 'string' ? raw.unresolvedChallenge : null,
      reAnalysisFlags,
      tradePlanIssues,
      optionsStrategyIssues,
      signalMismatchConcern,
      sourceIntegrityIssues,
      overallStatus,
      materialRuleNumbers,
      calibratorModel: 'claude-opus-4-7',
    }
  } catch (err) {
    // If reviewer fails, return a no-op review so pipeline doesn't crash.
    // The Judge's draft will ship as-is.
    console.warn('[judge-reviewer] failed, returning no-op:', (err as Error).message?.slice(0, 200))
    return {
      draftConfidence: draftJudge.confidence,
      draftSignal: draftJudge.signal,
      recommendedConfidence: draftJudge.confidence,
      adjustmentDelta: 0,
      adjustmentDirection: 'unchanged',
      confidenceBand: { low: draftJudge.confidence, high: draftJudge.confidence },
      reasoning: 'Reviewer unavailable --- draft verdict preserved unchanged.',
      overconfidenceFlags: [],
      underconfidenceFlags: [],
      mutualConcessions: bothConceded,
      unresolvedChallenge: null,
      reAnalysisFlags: [],
      tradePlanIssues: [],
      optionsStrategyIssues: [],
      signalMismatchConcern: null,
      sourceIntegrityIssues: [],
      overallStatus: 'clean',
      materialRuleNumbers: [],
      calibratorModel: 'reviewer-failed',
    }
  }
}

/** Backwards-compat alias. Renamed runCalibrator → runJudgeReviewer to
 *  reflect expanded responsibility (5 rules, not just Rule 2 calibration). */
async function runCalibrator(
  bundle: SignalBundle,
  draftJudge: JudgeResult,
  gemini: GeminiResult,
  claude: ClaudeResult,
  gpt: GptResult,
  rebuttal: RebuttalResult | undefined,
  counter: CounterResult | undefined,
): Promise<CalibrationResult> {
  return runJudgeReviewer(bundle, draftJudge, gemini, claude, gpt, rebuttal, counter)
}

/**
 * Log calibration result to the calibration_log table for backtest analysis.
 * Fire-and-forget --- never blocks pipeline on logging failure.
 */
function logCalibration(
  bundle: SignalBundle,
  calibration: CalibrationResult,
  finalJudge: JudgeResult,
): void {
  void (async () => {
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const admin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
      )
      await admin.from('calibration_log').insert({
        ticker: bundle.ticker,
        timeframe: bundle.timeframe,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        persona: ((bundle as any).persona ?? 'balanced') as string,
        judge_model: finalJudge.judgeModel ?? 'unknown',
        calibrator_model: calibration.calibratorModel,
        signal: finalJudge.signal,
        draft_confidence: calibration.draftConfidence,
        recommended_confidence: calibration.recommendedConfidence,
        final_confidence: finalJudge.confidence,
        adjustment_delta: calibration.adjustmentDelta,
        adjustment_direction: calibration.adjustmentDirection,
        mutual_concessions: calibration.mutualConcessions,
        unresolved_challenge: calibration.unresolvedChallenge?.slice(0, 500) ?? null,
        reasoning: calibration.reasoning?.slice(0, 1000) ?? null,
        overconfidence_flag_count: calibration.overconfidenceFlags?.length ?? 0,
        underconfidence_flag_count: calibration.underconfidenceFlags?.length ?? 0,
      })
    } catch (e) {
      console.warn('[calibration-log] failed:', (e as Error).message?.slice(0, 100))
    }
  })()
}

export async function runJudge(
  bundle: SignalBundle,
  gemini: GeminiResult,
  claude: ClaudeResult,
  gpt: GptResult,
  rebuttal?: RebuttalResult,
  counter?: CounterResult,
  round = 1,
  social?: SocialSentiment,
  aggregator?: AggregatorScoutResult,
  verifications?: VerificationsByStage,
): Promise<JudgeResult> {
  // Note: calibration result is stored on the returned judge via a side-channel
  // attached during pipeline orchestration. This function returns JudgeResult
  // for backward compatibility with any caller that just wants the final verdict.
  return runJudgeWithCalibration(bundle, gemini, claude, gpt, rebuttal, counter, round, social, aggregator, verifications)
    .then(r => r.judge)
}

/**
 * Internal: runs Judge draft → Calibrator → Judge final (Option B architecture).
 * Returns BOTH the final verdict AND the calibration metadata so the pipeline
 * can log the calibration and expose it to the UI.
 *
 * If calibration produces an 'unchanged' recommendation, we skip the second
 * Judge call entirely and apply the draft as the final verdict --- saves cost
 * in the common case where the draft was already well-calibrated.
 */
export async function runJudgeWithCalibration(
  bundle: SignalBundle,
  gemini: GeminiResult,
  claude: ClaudeResult,
  gpt: GptResult,
  rebuttal?: RebuttalResult,
  counter?: CounterResult,
  round = 1,
  social?: SocialSentiment,
  aggregator?: AggregatorScoutResult,
  verifications?: VerificationsByStage,
): Promise<{ judge: JudgeResult; calibration: CalibrationResult }> {

  const useGemini = process.env.GEMINI_JUDGE !== 'false'
  const judgeRunner = useGemini ? runJudgeGemini : runJudgeClaude

  // ── Step 1: Draft verdict from the primary Judge ──
  let draft: JudgeResult
  try {
    draft = await judgeRunner(bundle, gemini, claude, gpt, rebuttal, counter, round, social, aggregator, verifications)
  } catch (err) {
    if (useGemini) {
      console.warn('[judge] Gemini failed on draft, falling back to Claude Opus:', (err as Error).message?.slice(0, 200))
      draft = await runJudgeClaude(bundle, gemini, claude, gpt, rebuttal, counter, round, social, aggregator, verifications)
      draft.judgeModel = 'claude-opus-4-7-fallback'
    } else {
      throw err
    }
  }

  // ── Step 2: Calibrator reviews the draft confidence ──
  // ── Step 2: Judge Reviewer audits the draft against 5-rule checklist ──
  // (Replaces the old single-purpose "calibrator" which only handled Rule 2.)
  // The variable name 'calibration' is retained for backwards-compat with
  // the function signatures and the calibration_log table — the review
  // is a strict superset of the old calibration data.
  const calibration = await runCalibrator(bundle, draft, gemini, claude, gpt, rebuttal, counter)

  // ── Step 3: Decide whether to retry the Judge ──
  // Material concerns (Rules 3, 5, or severe Rule 2) → one-shot retry with corrective context
  // Minor notes (Rules 1, 4, or mild Rule 2) → ship draft as-is; flags surface to user
  // Clean → ship draft as-is, no flags
  //
  // The retry is ONE-SHOT — Judge v2 ships regardless of whether the reviewer would
  // have new concerns. This prevents infinite loops if the reviewer is over-eager.
  let finalJudge: JudgeResult

  if (calibration.overallStatus === 'material_concerns') {
    // Re-run Judge with corrective context covering BOTH calibration AND
    // structural concerns. The reviewer's flags (trade plan issues, signal
    // mismatch concern, severe calibration delta) are injected into the
    // Judge prompt as explicit guidance.
    try {
      finalJudge = await runJudgeWithCalibrationInput(
        bundle, gemini, claude, gpt, rebuttal, counter, round, social, aggregator,
        draft, calibration, useGemini, verifications
      )
      finalJudge = sanitizeJudgeResult(finalJudge, bundle)
    } catch (err) {
      // Retry failed — fall back to draft with the reviewer's confidence applied.
      // Trade plan / signal issues will remain in the v1 verdict surfaced to user
      // via the review flags. Better than losing the debate entirely.
      console.warn('[judge-final] retry failed, applying calibration to draft:', (err as Error).message?.slice(0, 200))
      finalJudge = sanitizeJudgeResult({
        ...draft,
        confidence: calibration.recommendedConfidence,
      }, bundle)
    }
  } else {
    // overallStatus is 'clean' or 'minor_notes' — ship the draft directly.
    // If minor_notes fired (Rule 1 re-analysis, Rule 4 options format, or
    // mild Rule 2 calibration), the reviewer's flags will be surfaced to
    // the user via the persisted judge_review_pipeline JSONB column.
    finalJudge = sanitizeJudgeResult(draft, bundle)
  }

  // ── Fire-and-forget: log calibration for backtest analysis ──
  logCalibration(bundle, calibration, finalJudge)

  return { judge: finalJudge, calibration }
}

/**
 * Re-run the Judge with calibration input. Uses the same Judge model (Gemini
 * by default, Claude fallback). The calibration recommendation is injected
 * into the Judge's user prompt as explicit guidance.
 */
async function runJudgeWithCalibrationInput(
  bundle: SignalBundle,
  gemini: GeminiResult,
  claude: ClaudeResult,
  gpt: GptResult,
  rebuttal: RebuttalResult | undefined,
  counter: CounterResult | undefined,
  round: number,
  social: SocialSentiment | undefined,
  aggregator: AggregatorScoutResult | undefined,
  draft: JudgeResult,
  calibration: CalibrationResult,
  useGemini: boolean,
  verifications: VerificationsByStage | undefined,
): Promise<JudgeResult> {

  // Build per-rule corrective guidance blocks. Only include sections where
  // the rule actually fired — keeps the prompt focused on what needs to change.
  const calibrationBlock = calibration.adjustmentDirection !== 'unchanged' ? `
CALIBRATION (Rule 2):
  - Adjust confidence ${calibration.adjustmentDirection.toUpperCase()} to approximately ${calibration.recommendedConfidence}% (delta: ${calibration.adjustmentDelta >= 0 ? '+' : ''}${calibration.adjustmentDelta})
  - Reasonable band: ${calibration.confidenceBand.low}%–${calibration.confidenceBand.high}%
  - Reasoning: ${calibration.reasoning}
  ${calibration.overconfidenceFlags.length > 0 ? `- Overconfidence signs: ${calibration.overconfidenceFlags.join('; ')}` : ''}
  ${calibration.underconfidenceFlags.length > 0 ? `- Underconfidence signs: ${calibration.underconfidenceFlags.join('; ')}` : ''}
  ${calibration.unresolvedChallenge ? `- Strongest unresolved challenge: "${calibration.unresolvedChallenge}"` : ''}` : ''

  const tradePlanBlock = calibration.tradePlanIssues.length > 0 ? `
TRADE PLAN STRUCTURE (Rule 3) — MUST FIX:
${calibration.tradePlanIssues.map(issue => `  - ${issue}`).join('\n')}
  Re-derive entry/stop/target so the math is internally consistent:
    - BULLISH: target > entry > stop, all as parseable dollar values
    - BEARISH: stop > entry > target, all as parseable dollar values
    - Risk/reward implied by the levels should match your stated thesis horizon
    - Stop should be at least 0.3× ATR away from entry (outside noise band)` : ''

  const optionsBlock = calibration.optionsStrategyIssues.length > 0 ? `
OPTIONS STRATEGY FORMAT (Rule 4) — MUST FIX:
${calibration.optionsStrategyIssues.map(issue => `  - ${issue}`).join('\n')}
  Re-write optionsStrategy to include all 6 required components: specific structure (long call/put/vertical spread/calendar/condor), specific strike(s), specific expiry, IV regime context, dollar risk per contract, why-this-beats-stock sentence.` : ''

  const signalBlock = calibration.signalMismatchConcern ? `
SIGNAL DIRECTION (Rule 5) — REVIEW:
  The reviewer flagged: "${calibration.signalMismatchConcern}"
  Re-examine your verdict's direction against where the evidence actually landed. If both sides conceded the bull case was stronger, the verdict should not be BEARISH. If the Lead's case was demolished, a high-confidence BULLISH verdict is incorrect. Consider whether the signal should change — or, if you believe the signal is right, strengthen winningArgument with the specific evidence that justifies it despite the apparent contradiction.` : ''

  const sourceIntegrityBlock = calibration.sourceIntegrityIssues.length > 0 ? `
SOURCE INTEGRITY (Rule 6) — MUST FIX:
${calibration.sourceIntegrityIssues.map(issue => `  - ${issue}`).join('\n')}
  Your draft's narrative explicitly acknowledged that the debate built on fabricated, hallucinated, or verification-failed sources. This is unacceptable in a user-facing verdict. Re-derive the verdict using ONLY verified evidence from the bundle and the surviving parts of the debate. Do NOT allow the discarded claim to influence framing, confidence, or trade plan. Do NOT mention "fabricated", "hallucinated", "proven false", "could not verify" or similar language in your revised summary, winningArgument, or dissent — those phrases should not appear in the user-facing verdict. If the discarded source was a meaningful part of the original reasoning, your revised confidence should reflect the weaker remaining evidence (typically lower than the draft).` : ''

  const calibrationGuidance = `

━━━ INDEPENDENT REVIEWER FEEDBACK ON YOUR DRAFT ━━━

Your DRAFT verdict was ${draft.signal} @ ${draft.confidence}% confidence with entry ${draft.entryPrice ?? '(none)'} / stop ${draft.stopLoss ?? '(none)'} / target ${draft.takeProfit ?? '(none)'}.

An independent reviewer (Claude Opus) audited your draft against a 6-rule procedural checklist. The following concerns were flagged as material and need to be addressed in your final verdict:
${calibrationBlock}${tradePlanBlock}${optionsBlock}${signalBlock}${sourceIntegrityBlock}

The reviewer did NOT re-analyze the directional thesis — only audit your draft for procedural and structural quality. You are NOT required to follow every recommendation blindly, but address each flagged concern explicitly. If you disagree with a flag, your final verdict should make the case for why your draft was correct on that dimension.

Keep your verdict structure identical to the draft. Update only what's needed to address the flags. Do NOT introduce new analytical content not already supported by the debate.`

  // Build a user prompt that re-uses the main Judge logic but appends calibration guidance
  if (useGemini) {
    const systemPrompt = buildJudgeSystemPrompt(bundle)
    const userPrompt = buildJudgeUserPrompt(bundle, gemini, claude, gpt, rebuttal, counter, round, social, aggregator, verifications)
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}${calibrationGuidance}`

    const { text, modelUsed } = await generateWithFallback({
      prompt: fullPrompt,
      caller: 'judge:reviewed-rerun',
      temperature: 0.2,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    })
    const raw = parseJSON<JudgeResult>(text)
    return { ...raw, judgeModel: `-reviewed` }
  } else {
    const systemPrompt = buildJudgeSystemPrompt(bundle)
    const userPrompt = buildJudgeUserPrompt(bundle, gemini, claude, gpt, rebuttal, counter, round, social, aggregator, verifications) + calibrationGuidance

    const msg = await getAnthropic().messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 6000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textBlock = msg.content.find((b: any) => b.type === 'text') as { type: 'text'; text: string } | undefined
    if (!textBlock) throw new Error('No text content in calibrated Judge response')
    const raw = parseJSON<JudgeResult>(textBlock.text)
    return { ...raw, judgeModel: 'claude-opus-4-7-reviewed' }
  }
}

// ─────────────────────────────────────────────────────────────
// Judge correction logging (Gap #6)
// ─────────────────────────────────────────────────────────────
function logJudgeCorrection(
  bundle: SignalBundle,
  judgeModel: string | undefined,
  signal: string,
  field: 'stopLoss' | 'takeProfit',
  originalValue: string,
  correctedValue: string,
  atrUsed: number,
  entryPrice: number,
): void {
  void (async () => {
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const admin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
      )
      await admin.from('judge_corrections').insert({
        ticker: bundle.ticker,
        timeframe: bundle.timeframe,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        persona: ((bundle as any).persona ?? 'balanced') as string,
        judge_model: judgeModel ?? 'unknown',
        signal,
        corrected_field: field,
        original_value: originalValue?.slice(0, 500) ?? '',
        corrected_value: correctedValue?.slice(0, 500) ?? '',
        atr_used: atrUsed > 0 ? atrUsed : null,
        entry_price: entryPrice > 0 ? entryPrice : null,
      })
    } catch (e) {
      console.warn('[judge-correction] log failed:', (e as Error).message?.slice(0, 100))
    }
  })()
}

function extractPrice(s: string): number | null {
  const m = s?.match(/\$(\d{1,6}(?:\.\d{1,2})?)/)
  return m ? parseFloat(m[1]) : null
}

function sanitizeJudgeResult(judge: JudgeResult, bundle: SignalBundle): JudgeResult {
  const currentPrice = bundle.technicals?.currentPrice ?? 0
  if (!currentPrice) return judge

  const signal = judge.signal
  const entry  = extractPrice(judge.entryPrice) ?? currentPrice
  const stop   = extractPrice(judge.stopLoss)
  const tp     = extractPrice(judge.takeProfit)
  const atr    = bundle.technicals?.atr14 ?? 0

  // ── Earnings tier enforcement (Tier 0-3) ───────────────────────
  // When earnings are imminent, prompt-level directives are unreliable
  // (LLM can ignore them when conviction is high). Code-level
  // enforcement is the only consistent guardrail.
  //
  //   Tier 0 (0d, TODAY)     → full no-entry block
  //   Tier 1 (1d, TOMORROW)  → full no-entry block
  //   Tier 2 (2d)            → entry allowed, action plan force-prefixed
  //                            with binary risk acknowledgment + sizing
  //                            guidance
  //   Tier 3 (3d)            → same as Tier 2, milder language
  //
  // Signal/confidence/scenarios/thesis preserved across all tiers.
  const daysToEarnings = bundle.fundamentals?.daysToEarnings ?? null

  // Tier 0 + Tier 1: full block
  if (daysToEarnings !== null && daysToEarnings >= 0 && daysToEarnings <= 1) {
    const tierLabel = daysToEarnings === 0 ? 'TODAY' : 'TOMORROW'
    const blockedEntry = `No entry before earnings (reports ${tierLabel}) --- wait for post-earnings reaction`
    const blockedStop  = `N/A --- stop level depends on post-earnings price discovery`
    const blockedTp    = `N/A --- target level depends on post-earnings price discovery`
    const guard        = `IMPORTANT: ${bundle.ticker} reports ${tierLabel}. Do not enter before the catalyst. Wait for post-earnings price action to establish a new trend, then re-evaluate using the directional thesis below as a starting hypothesis.\n\n`
    const wasOverridden = (
      extractPrice(judge.entryPrice) !== null ||
      extractPrice(judge.stopLoss) !== null ||
      extractPrice(judge.takeProfit) !== null
    )
    if (wasOverridden) {
      console.warn(`[pipeline] earnings tier ${tierLabel} (${daysToEarnings}d) --- overriding actionable fields, preserving thesis`)
      logJudgeCorrection(bundle, judge.judgeModel, signal, 'stopLoss', judge.stopLoss, blockedStop, atr, entry)
    }
    // Strip price-bearing sentences from the action plan body so it
    // doesn't contradict the blocked structured fields. The LLM may
    // have written 'enter at $X / stop $Y / target $Z' even though
    // the directive says wait --- remove those.
    const stripPriceSentences = (s: string): string => {
      if (!s) return s
      // Split on sentence terminators while keeping the structure;
      // drop any sentence containing a dollar price.
      const parts = s.split(/(?<=[.!?])\s+/)
      return parts.filter(p => !/\$\d{1,6}(?:\.\d{1,2})?/.test(p)).join(' ').trim()
    }
    const cleanedActionPlan = stripPriceSentences(judge.actionPlan ?? '')
    return {
      ...judge,
      entryPrice: blockedEntry,
      stopLoss:   blockedStop,
      takeProfit: blockedTp,
      actionPlan: guard + cleanedActionPlan,
    }
  }

  // Tier 2 + Tier 3: entry allowed, but force binary-risk acknowledgment
  // and position-sizing guidance into the action plan. We do NOT override
  // the entry/stop/target prices themselves --- they fall through to the
  // BULLISH/BEARISH direction validation below.
  if (daysToEarnings !== null && daysToEarnings >= 2 && daysToEarnings <= 3) {
    const dayWord = daysToEarnings === 2 ? '2 trading days' : '3 trading days'
    const guardTier23 = `BINARY EVENT WARNING: ${bundle.ticker} reports earnings in ${dayWord}. The options market is pricing a meaningful move (see implied move in fundamentals). If you take this trade, use REDUCED POSITION SIZE (target ~50% of normal sizing) and define a clear pre-earnings invalidation level. Plan to either close the position before the report or accept full binary risk through the catalyst.\n\n`
    const wasGuarded = (judge.actionPlan ?? '').startsWith('BINARY EVENT WARNING')
    if (!wasGuarded) {
      console.warn(`[pipeline] earnings tier ${daysToEarnings}d --- prefixing action plan with binary-risk acknowledgment`)
    }
    // Fall through to normal BULLISH/BEARISH validation, but mutate the
    // action plan as we pass through. We capture judge here, run the
    // normal sanitization below, and apply the prefix at the end.
    // Cleanest: set the prefix flag and check at the end.
    judge = wasGuarded ? judge : { ...judge, actionPlan: guardTier23 + (judge.actionPlan ?? '') }
  }

  if (signal === 'BULLISH') {
    let fixedStop   = judge.stopLoss
    let fixedTarget = judge.takeProfit

    if (stop !== null && stop >= entry) {
      const corrected = (atr > 0 ? entry - atr * 2 : entry * 0.93).toFixed(2)
      fixedStop = `$${corrected} --- 2× ATR below entry (auto-corrected)`
      console.warn(`[pipeline] BULLISH stop ${stop} was >= entry ${entry} --- corrected to ${corrected}`)
      logJudgeCorrection(bundle, judge.judgeModel, signal, 'stopLoss', judge.stopLoss, fixedStop, atr, entry)
    }

    if (tp !== null && tp <= entry) {
      const corrected = (atr > 0 ? entry + atr * 3 : entry * 1.08).toFixed(2)
      fixedTarget = `$${corrected} first target (auto-corrected), extended target at resistance`
      console.warn(`[pipeline] BULLISH target ${tp} was <= entry ${entry} --- corrected to ${corrected}`)
      logJudgeCorrection(bundle, judge.judgeModel, signal, 'takeProfit', judge.takeProfit, fixedTarget, atr, entry)
    }

    return { ...judge, stopLoss: fixedStop, takeProfit: fixedTarget }
  }

  if (signal === 'BEARISH') {
    let fixedStop   = judge.stopLoss
    let fixedTarget = judge.takeProfit

    if (stop !== null && stop <= entry) {
      const corrected = (atr > 0 ? entry + atr * 2 : entry * 1.07).toFixed(2)
      fixedStop = `$${corrected} --- 2× ATR above entry (auto-corrected)`
      console.warn(`[pipeline] BEARISH stop ${stop} was <= entry ${entry} --- corrected to ${corrected}`)
      logJudgeCorrection(bundle, judge.judgeModel, signal, 'stopLoss', judge.stopLoss, fixedStop, atr, entry)
    }

    if (tp !== null && tp >= entry) {
      const corrected = (atr > 0 ? entry - atr * 3 : entry * 0.92).toFixed(2)
      fixedTarget = `$${corrected} first target (auto-corrected)`
      console.warn(`[pipeline] BEARISH target ${tp} was >= entry ${entry} --- corrected to ${corrected}`)
      logJudgeCorrection(bundle, judge.judgeModel, signal, 'takeProfit', judge.takeProfit, fixedTarget, atr, entry)
    }

    return { ...judge, stopLoss: fixedStop, takeProfit: fixedTarget }
  }

  return judge
}

// ─────────────────────────────────────────────────────────────
// Main pipeline orchestrator
// ─────────────────────────────────────────────────────────────
export async function runPipeline(
  bundle: SignalBundle,
  onProgress: (event: string, data: unknown) => void
): Promise<PipelineResult> {
  const transcript: TranscriptMessage[] = []

  onProgress('gemini_start', {})
  onProgress('grok_start', {})
  onProgress('aggregator_start', {})
  const [gemini, social, aggregator] = await Promise.all([
    runGemini(bundle),
    runSocialScout(bundle.ticker, bundle.currentPrice, bundle.timeframe),
    runAggregatorScout(bundle.ticker, bundle.currentPrice, bundle.timeframe),
  ])
  transcript.push({ role: 'gemini', stage: 'news_macro', content: gemini.summary, confidence: gemini.confidence, timestamp: ts() })
  onProgress('gemini_done', gemini)
  onProgress('grok_done', social)
  onProgress('aggregator_done', aggregator)

  const macroContext = await buildMacroIntelligenceContext(
    bundle.ticker,
    bundle.aiContext?.technicalsSection ? ['technology','energy','financials'] : []
  ).catch(() => '')
  if (macroContext) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bundle = { ...bundle, aiContext: { ...bundle.aiContext, macroIntelligenceSection: macroContext } as any }
  }

  onProgress('claude_start', { gemini })
  const claude = await runClaude(bundle, gemini, social, aggregator)
  transcript.push({ role: 'claude', stage: 'lead_analyst', content: claude.reasoning, signal: claude.signal, confidence: claude.confidence, timestamp: ts() })
  onProgress('claude_done', claude)

  // ── Gap #9: kick off verification of Lead's reasoning in parallel ──
  // Doesn't block GPT/Rebuttal; we await all verifications at the end.
  const leadVerifyPromise = verifyFactualClaims(bundle.ticker, 'lead', claude.reasoning, bundle)
    .catch((e) => { console.warn('[verification/lead] failed:', (e as Error).message); return null })

  onProgress('gpt_start', { gemini, claude })
  const gpt = await runGPT(bundle, gemini, claude, social, aggregator)
  transcript.push({ role: 'gpt', stage: 'devils_advocate', content: gpt.reasoning, signal: gpt.signal, confidence: gpt.confidence, timestamp: ts() })
  onProgress('gpt_done', gpt)

  // Verify Devil's challenges in parallel
  const devilText = [gpt.reasoning, ...gpt.challenges, gpt.strongestCounterArgument].filter(Boolean).join('\n\n')
  const devilVerifyPromise = verifyFactualClaims(bundle.ticker, 'devil', devilText, bundle)
    .catch((e) => { console.warn('[verification/devil] failed:', (e as Error).message); return null })

  onProgress('rebuttal_start', { claude, gpt })
  const rebuttal = await runRebuttal(bundle, claude, gpt)
  transcript.push({ role: 'claude', stage: 'rebuttal', content: rebuttal.rebuttal, signal: rebuttal.signal, confidence: rebuttal.confidence, timestamp: ts() })
  onProgress('rebuttal_done', rebuttal)

  // Verify Rebuttal's research answer + rebuttal text
  const rebuttalText = [rebuttal.rebuttal, rebuttal.researchAnswer, ...rebuttal.maintains, rebuttal.finalStance].filter(Boolean).join('\n\n')
  const rebuttalVerifyPromise = verifyFactualClaims(bundle.ticker, 'rebuttal', rebuttalText, bundle)
    .catch((e) => { console.warn('[verification/rebuttal] failed:', (e as Error).message); return null })

  onProgress('counter_start', { gpt, rebuttal })
  const counter = await runCounter(bundle, gpt, rebuttal)
  transcript.push({ role: 'gpt', stage: 'counter', content: counter.finalChallenge, timestamp: ts() })
  onProgress('counter_done', counter)

  // Verify Counter's research answer + challenge text
  const counterText = [counter.finalChallenge, counter.researchAnswer, ...counter.pressesOn, counter.closingArgument].filter(Boolean).join('\n\n')
  const counterVerifyPromise = verifyFactualClaims(bundle.ticker, 'counter', counterText, bundle)
    .catch((e) => { console.warn('[verification/counter] failed:', (e as Error).message); return null })

  // Await all verifications before Judge so calibration has clean data
  const [leadVer, devilVer, rebuttalVer, counterVer] = await Promise.all([
    leadVerifyPromise,
    devilVerifyPromise,
    rebuttalVerifyPromise,
    counterVerifyPromise,
  ])

  // Aggregate verification stats for the UI badge
  const verifications = {
    lead: leadVer ?? undefined,
    devil: devilVer ?? undefined,
    rebuttal: rebuttalVer ?? undefined,
    counter: counterVer ?? undefined,
    totalVerified: (leadVer?.verifiedCount ?? 0) + (devilVer?.verifiedCount ?? 0) +
                   (rebuttalVer?.verifiedCount ?? 0) + (counterVer?.verifiedCount ?? 0),
    totalStripped: (leadVer?.strippedCount ?? 0) + (devilVer?.strippedCount ?? 0) +
                   (rebuttalVer?.strippedCount ?? 0) + (counterVer?.strippedCount ?? 0),
    allSourceUrls: [
      ...(leadVer?.allSourceUrls ?? []),
      ...(devilVer?.allSourceUrls ?? []),
      ...(rebuttalVer?.allSourceUrls ?? []),
      ...(counterVer?.allSourceUrls ?? []),
    ],
  }

  onProgress('verification_done', {
    totalVerified: verifications.totalVerified,
    totalStripped: verifications.totalStripped,
  })

  onProgress('judge_start', {})
  const { judge, calibration } = await runJudgeWithCalibration(bundle, gemini, claude, gpt, rebuttal, counter, 1, social, aggregator, verifications)
  transcript.push({ role: 'judge', stage: 'arbitrator', content: judge.summary, signal: judge.signal, confidence: judge.confidence, timestamp: ts() })

  // ── Trader Filter ─────────────────────────────────────────
  // Evaluates the Council's verdict against trader discipline rules:
  // R:R, confidence floors per setup type, conflict detection.
  // Output is TAKE / PASS / WAIT --- separate from the Judge verdict.
  onProgress('trader_start', {})
  const trader = await evaluateTrade(judge, bundle, bundle.timeframe)
  onProgress('trader_done', trader)
  onProgress('judge_done', judge)

  // Emit the Judge Reviewer audit payload so the UI can render review notes
  // and "verdict revised" badges. Same shape that gets persisted to the
  // judge_review_pipeline JSONB column on the analyses row. Null-safe: if
  // calibration is undefined (legacy path), no event is emitted and the
  // page renders the verdict normally.
  if (calibration) {
    onProgress('judge_review_done', {
      version: 1,
      retryFired: (calibration.materialRuleNumbers?.length ?? 0) > 0,
      draftSignal: calibration.draftSignal,
      draftConfidence: calibration.draftConfidence,
      review: calibration,
      finalSignal: judge.signal,
      finalConfidence: judge.confidence,
      overallStatus: calibration.overallStatus,
      materialRuleNumbers: calibration.materialRuleNumbers ?? [],
    })
  }

  return { gemini, claude, gpt, rebuttal, counter, judge, calibration, verifications, transcript, social, aggregator, trader }
}
