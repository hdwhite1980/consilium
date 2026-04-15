// ─────────────────────────────────────────────────────────────
// AI Pipeline v2 — All 5 phases integrated
// Each AI receives the full signal bundle, not just price text
// ─────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenerativeAI } from '@google/generative-ai'
import type { SignalBundle } from './aggregator'

function getAnthropic() { return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) }
function getOpenAI()    { return new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) }
function getGenAI()     { return new GoogleGenerativeAI(process.env.GEMINI_API_KEY!) }

export type Signal = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

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
  rebuttal: string           // Lead Analyst's direct response to Devil's Advocate
  concedes: string[]         // points the Lead Analyst admits are valid
  maintains: string[]        // points the Lead Analyst doubles down on
  updatedTarget: string      // target price after considering challenges
  finalStance: string        // one sentence summary of maintained position
}

export interface CounterResult {
  finalChallenge: string     // Devil's Advocate's final shot after rebuttal
  yieldsOn: string[]         // points Devil's Advocate now accepts
  pressesOn: string[]        // points Devil's Advocate still presses
  closingArgument: string    // one sentence closing
}

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
  // New fields
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
}

export interface PipelineResult {
  gemini: GeminiResult
  claude: ClaudeResult
  gpt: GptResult
  rebuttal?: RebuttalResult
  counter?: CounterResult
  judge: JudgeResult
  transcript: TranscriptMessage[]
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

function parseJSON<T>(text: string): T {
  const clean = text.replace(/```json|```/g, '').trim()
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON in response')
  return JSON.parse(clean.slice(start, end + 1)) as T
}

export async function runGemini(bundle: SignalBundle): Promise<GeminiResult> {
  // Try primary model, fall back if unavailable
  const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']
  let lastError: Error | null = null
  for (const modelName of GEMINI_MODELS) {
    try {
      const model = getGenAI().getGenerativeModel({ model: modelName })
      const result = await model.generateContent(`You are the News Scout and Macro Analyst for an elite AI stock council.

Analyze all news, macro, and market context for ${bundle.ticker}. You go first. Be specific.

${bundle.aiContext.newsSection}

${bundle.aiContext.marketSection}

Respond JSON ONLY (no fences):
{"summary":"3 sentence overview","headlines":["top 4-5 headlines"],"sentiment":"positive|negative|neutral|mixed","confidence":<0-100>,"keyEvents":["2-4 near-term catalysts"],"macroFactors":["2-3 macro conditions"],"regimeAssessment":"1 sentence on regime impact"}`)
      return parseJSON<GeminiResult>(result.response.text())
    } catch (e) {
      lastError = e as Error
      const msg = (e as Error).message ?? ''
      if (!msg.includes('503') && !msg.includes('overload') && !msg.includes('high demand')) throw e
      console.warn(`News Scout model ${modelName} unavailable, trying next...`)
    }
  }
  throw lastError ?? new Error('News Scout unavailable — all models failed')
}

export async function runClaude(bundle: SignalBundle, gemini: GeminiResult): Promise<ClaudeResult> {
  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: (() => {
      const pi: Record<string, string> = {
        balanced:    'Weight technical and fundamental signals equally. When they conflict, note it explicitly and let data quality determine conviction.',
        technical:   'You are a technical trader. Price action and chart signals are primary. Follow the trend — never fight the tape. A death cross is bearish regardless of P/E ratio. RSI, MACD, and moving averages drive your call.',
        fundamental: 'You are a value-focused analyst. Earnings growth, analyst consensus, and valuation vs historical averages drive your call. Technicals are short-term noise. A 30% drawdown in a high-quality business with strong fundamentals is an opportunity, not a sell signal.',
      }
      const pn: Record<string, string> = { balanced: 'Balanced', technical: 'Technical Trader', fundamental: 'Fundamental Analyst' }
      const p = (( bundle as any).persona ?? 'balanced') as string
      return `You are the Lead Analyst (${pn[p] ?? 'Balanced'} perspective) in an elite AI stock council for ${bundle.ticker}. ${pi[p] ?? pi.balanced} Be decisive. Support every claim with specific data. Your analysis will be challenged by the Devil's Advocate.`
    })(),
    messages: [{
      role: 'user',
      content: `TICKER: ${bundle.ticker} | TIMEFRAME: ${bundle.timeframe} | PRICE: $${bundle.currentPrice.toFixed(2)}

NEWS SCOUT BRIEF:
${gemini.summary}
Sentiment: ${gemini.sentiment} | Regime: ${gemini.regimeAssessment}
Events: ${gemini.keyEvents.join('; ')}

YOUR SIGNAL DATA:
${bundle.aiContext.technicalsSection}

${bundle.aiContext.fundamentalsSection}

${bundle.aiContext.smartMoneySection}

${bundle.aiContext.optionsSection}

${bundle.aiContext.convictionSection}

JSON ONLY:
{"signal":"BULLISH|BEARISH|NEUTRAL","reasoning":"4-5 sentences integrating all signals","target":"price target e.g. $195","confidence":<0-100>,"technicalBasis":"2 sentences","fundamentalBasis":"2 sentences","catalysts":["2-3 catalysts"],"keyRisks":["2-3 risks"]}`
    }]
  })
  return parseJSON<ClaudeResult>((msg.content[0] as { text: string }).text)
}

export async function runGPT(bundle: SignalBundle, gemini: GeminiResult, claude: ClaudeResult): Promise<GptResult> {
  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1000,
    messages: [
      { role: 'system', content: `You are the Devil's Advocate in an elite AI stock council for ${bundle.ticker}. Challenge the Lead Analyst's conclusions with data. Do NOT simply agree.` },
      { role: 'user', content: `TICKER: ${bundle.ticker} | PRICE: $${bundle.currentPrice.toFixed(2)}

NEWS SCOUT: ${gemini.sentiment} sentiment, ${gemini.confidence}% confidence
${gemini.summary}

LEAD ANALYST (${claude.signal}, ${claude.confidence}%): ${claude.reasoning}
Target: ${claude.target} | Risks: ${claude.keyRisks.join('; ')}

SIGNAL DATA:
${bundle.aiContext.technicalsSection}
${bundle.aiContext.optionsSection}
${bundle.aiContext.convictionSection}

JSON ONLY:
{"agrees":<true|false>,"signal":"BULLISH|BEARISH|NEUTRAL","reasoning":"4 sentences","confidence":<0-100>,"challenges":["2-4 specific data-backed challenges"],"alternateScenario":"scenario the Lead Analyst underweights","strongestCounterArgument":"single most compelling counter"}` }
    ]
  })
  return parseJSON<GptResult>(completion.choices[0].message.content!)
}

// Lead Analyst rebuts the Devil's Advocate challenges
export async function runRebuttal(
  bundle: SignalBundle,
  claude: ClaudeResult,
  gpt: GptResult
): Promise<RebuttalResult> {
  const pa = (bundle as any).persona ?? 'balanced'
  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    system: `You are the Lead Analyst in an elite AI stock council for ${bundle.ticker}. The Devil's Advocate has challenged your analysis. Defend your position where the data supports you. Concede points where the Devil's Advocate is correct. Do not be stubborn — intellectual honesty strengthens your credibility with the Judge.`,
    messages: [{
      role: 'user',
      content: `YOUR ORIGINAL CALL: ${claude.signal} on ${bundle.ticker} at $${bundle.currentPrice.toFixed(2)}, target ${claude.target}
YOUR REASONING: ${claude.reasoning}

DEVIL'S ADVOCATE CHALLENGES:
${gpt.challenges.map((c, i) => `${i+1}. ${c}`).join('\n')}
STRONGEST COUNTER: ${gpt.strongestCounterArgument}
ALTERNATE SCENARIO: ${gpt.alternateScenario}

Respond directly to each challenge. Concede valid points. Defend positions backed by data. Update your price target if the challenges reveal you overshot. Be specific.

JSON ONLY:
{
  "signal": "BULLISH|BEARISH|NEUTRAL",
  "confidence": <0-100>,
  "rebuttal": "3-4 sentences directly responding to the most important challenges",
  "concedes": ["specific points you now agree the Devil's Advocate got right — be honest, 1-3 items"],
  "maintains": ["specific points you are standing firm on with data backing — 2-4 items"],
  "updatedTarget": "revised price target e.g. $195, or same as before if unchanged",
  "finalStance": "one sentence — your maintained position after considering all challenges"
}`
    }]
  })
  return parseJSON<RebuttalResult>((msg.content[0] as { text: string }).text)
}

// Devil's Advocate fires back after Lead Analyst's rebuttal
export async function runCounter(
  bundle: SignalBundle,
  gpt: GptResult,
  rebuttal: RebuttalResult
): Promise<CounterResult> {
  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 600,
    messages: [
      { role: 'system', content: `You are the Devil's Advocate in an elite AI stock council for ${bundle.ticker}. The Lead Analyst has rebutted your challenges. Acknowledge valid concessions, but press hard on the points that remain unresolved. This is your final opportunity to influence the Judge. Be sharp, specific, and data-driven.` },
      { role: 'user', content: `YOUR ORIGINAL CHALLENGES: ${gpt.challenges.join('; ')}

LEAD ANALYST'S REBUTTAL: ${rebuttal.rebuttal}
THEY CONCEDE: ${rebuttal.concedes.join('; ')}
THEY MAINTAIN: ${rebuttal.maintains.join('; ')}
UPDATED TARGET: ${rebuttal.updatedTarget}

Now respond. Acknowledge where their rebuttal was convincing. Double down on unresolved weaknesses. What should the Judge not ignore?

JSON ONLY:
{
  "finalChallenge": "2-3 sentences — your most important remaining challenge after their rebuttal",
  "yieldsOn": ["points where their rebuttal convinced you — be honest, 1-2 items"],
  "pressesOn": ["points that remain unresolved and the Judge must weigh — 2-3 items"],
  "closingArgument": "one sentence — the single most important thing for the Judge to consider"
}` }
    ]
  })
  return parseJSON<CounterResult>(completion.choices[0].message.content!)
}

export async function runJudge(
  bundle: SignalBundle,
  gemini: GeminiResult,
  claude: ClaudeResult,
  gpt: GptResult,
  rebuttal?: RebuttalResult,
  counter?: CounterResult,
  round = 1
): Promise<JudgeResult> {
  const judgePersona: Record<string, string> = {
    balanced:    'Weigh technical and fundamental arguments equally. Higher quality evidence wins regardless of type.',
    technical:   'Give more weight to technical arguments — price action, chart patterns, and momentum signals. A stock in a clear downtrend requires exceptionally strong fundamental evidence to override the chart.',
    fundamental: 'Give more weight to fundamental arguments — earnings quality, valuation vs history, and analyst consensus. Technical signals are short-term noise. A fundamentally strong business trading at a discount to its historical valuation is a buy even in a downtrend.',
  }
  const judgePersonaKey = (( bundle as any).persona ?? 'balanced') as string
  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: `You are the Judge of an elite AI stock council for ${bundle.ticker}. The council has three roles: News Scout, Lead Analyst, and Devil's Advocate. You hold NO prior position. ${judgePersona[judgePersonaKey] ?? judgePersona.balanced} Weigh argument QUALITY not vote count. Be decisive. Refer to council members by their role names only.`,
    messages: [{
      role: 'user',
      content: `TICKER: ${bundle.ticker} | PRICE: $${bundle.currentPrice.toFixed(2)} | ROUND: ${round} | PERSPECTIVE: ${(( bundle as any).persona ?? 'balanced').toUpperCase()}

NEWS SCOUT: ${gemini.sentiment} sentiment, ${gemini.confidence}% confidence
${gemini.summary}
Regime: ${gemini.regimeAssessment}

━━━ ROUND 1 ━━━
LEAD ANALYST (${claude.signal}, ${claude.confidence}%): ${claude.reasoning}
Technical basis: ${claude.technicalBasis}
Fundamental basis: ${claude.fundamentalBasis}
Target: ${claude.target}
Catalysts: ${claude.catalysts?.join('; ')}

DEVIL'S ADVOCATE (${gpt.signal}, ${gpt.confidence}%, ${gpt.agrees ? 'AGREES' : 'DISAGREES'}): ${gpt.reasoning}
Challenges: ${gpt.challenges.join('; ')}
Strongest counter: ${gpt.strongestCounterArgument}
Alternate scenario: ${gpt.alternateScenario}

${rebuttal ? `━━━ ROUND 2 ━━━
LEAD ANALYST REBUTTAL (updated signal: ${rebuttal.signal}, ${rebuttal.confidence}%):
${rebuttal.rebuttal}
Concedes: ${rebuttal.concedes.join('; ')}
Maintains: ${rebuttal.maintains.join('; ')}
Updated target: ${rebuttal.updatedTarget}

DEVIL'S ADVOCATE COUNTER:
${counter?.finalChallenge ?? ''}
Yields on: ${counter?.yieldsOn.join('; ') ?? ''}
Still pressing: ${counter?.pressesOn.join('; ') ?? ''}
Closing argument: ${counter?.closingArgument ?? ''}` : ''}

OPTIONS FLOW:
${bundle.aiContext.optionsSection}

CONVICTION ENGINE:
${bundle.aiContext.convictionSection}

JSON ONLY — include ALL fields below:
{
  "signal": "BULLISH|BEARISH|NEUTRAL",
  "confidence": <0-100>,
  "target": "specific price target that MUST align with takeProfit. For BULLISH: above current price. For BEARISH: below current price. For NEUTRAL: within 5% of current price either direction.",
  "risk": "single most critical risk in one sentence",
  "summary": "4-5 sentence professional verdict",
  "winningArgument": "who made the strongest case and exactly why",
  "dissent": "strongest opposing view in one sentence",
  "scenarios": [
    {"label":"bull","probability":<0-100>,"trigger":"specific catalyst"},
    {"label":"base","probability":<0-100>,"trigger":"base case condition"},
    {"label":"bear","probability":<0-100>,"trigger":"specific risk event"}
  ],
  "invalidationTrigger": "the single clearest signal this thesis is wrong",
  "rounds": ${round},
  "entryPrice": "recommended entry price or range e.g. $195-$198 on a pullback to support",
  "stopLoss": "where to cut losses e.g. $189 — below SMA200 support",
  "takeProfit": "where to take profits — for BULLISH this is above entry price, for BEARISH this is below entry price. Must be consistent with the signal direction. e.g. BULLISH: '$215 first target, $225 full exit' | BEARISH: '$192 first target, $185 full exit'",
  "timeHorizon": "realistic timeframe e.g. 2-3 weeks for base case to play out",
  "plainEnglish": "Explain the verdict in simple plain English as if talking to someone who has never traded before. 3-4 sentences. No jargon. What is this stock doing and what should someone know about it right now?",
  "technicalsExplained": "Explain what the technical signals mean in plain English. What is the RSI telling us? What does the death cross or golden cross mean? What does price vs moving averages tell us? 3-4 sentences a beginner would understand.",
  "fundamentalsExplained": "Explain what the fundamental signals mean in plain English. What do the analyst ratings mean? What does earnings date mean for the stock? What does insider buying or selling tell us? 3-4 sentences a beginner would understand.",
  "smartMoneyExplained": "Explain what the smart money signals mean in plain English. What does it mean when insiders buy or sell? What does congressional trading tell us? What does options flow and short interest mean? 3-4 sentences a beginner would understand.",
  "actionPlan": "Give a clear, specific, step-by-step action plan in plain English. What should someone actually DO — buy, sell, wait, set an alert? Be specific about price levels. 4-5 sentences.",
  "optionsStrategy": "Based on the verdict, options flow, and IV conditions — what is the single best options approach for this stock right now? One paragraph. Cover whether to buy or sell options, whether IV is favorable, what type of strategy fits (buying calls/puts, spreads, selling premium), and why. Write it for someone who understands options basics but is not an expert."
}`
    }]
  })
  return parseJSON<JudgeResult>((msg.content[0] as { text: string }).text)
}

export async function runPipeline(
  bundle: SignalBundle,
  onProgress: (event: string, data: unknown) => void
): Promise<PipelineResult> {
  const transcript: TranscriptMessage[] = []

  // ── Stage 1: News Scout ──────────────────────────────────
  onProgress('gemini_start', {})
  const gemini = await runGemini(bundle)
  transcript.push({ role: 'gemini', stage: 'news_macro', content: gemini.summary, confidence: gemini.confidence, timestamp: ts() })
  onProgress('gemini_done', gemini)

  // ── Stage 2: Lead Analyst ────────────────────────────────
  onProgress('claude_start', { gemini })
  const claude = await runClaude(bundle, gemini)
  transcript.push({ role: 'claude', stage: 'lead_analyst', content: claude.reasoning, signal: claude.signal, confidence: claude.confidence, timestamp: ts() })
  onProgress('claude_done', claude)

  // ── Stage 3: Devil's Advocate ────────────────────────────
  onProgress('gpt_start', { gemini, claude })
  const gpt = await runGPT(bundle, gemini, claude)
  transcript.push({ role: 'gpt', stage: 'devils_advocate', content: gpt.reasoning, signal: gpt.signal, confidence: gpt.confidence, timestamp: ts() })
  onProgress('gpt_done', gpt)

  // ── Stage 4: Lead Analyst Rebuttal ───────────────────────
  onProgress('rebuttal_start', { claude, gpt })
  const rebuttal = await runRebuttal(bundle, claude, gpt)
  transcript.push({ role: 'claude', stage: 'rebuttal', content: rebuttal.rebuttal, signal: rebuttal.signal, confidence: rebuttal.confidence, timestamp: ts() })
  onProgress('rebuttal_done', rebuttal)

  // ── Stage 5: Devil's Advocate Counter ────────────────────
  onProgress('counter_start', { gpt, rebuttal })
  const counter = await runCounter(bundle, gpt, rebuttal)
  transcript.push({ role: 'gpt', stage: 'counter', content: counter.finalChallenge, timestamp: ts() })
  onProgress('counter_done', counter)

  // ── Stage 6: Council Verdict ─────────────────────────────
  onProgress('judge_start', {})
  const judge = await runJudge(bundle, gemini, claude, gpt, rebuttal, counter, 1)
  transcript.push({ role: 'judge', stage: 'arbitrator', content: judge.summary, signal: judge.signal, confidence: judge.confidence, timestamp: ts() })
  onProgress('judge_done', judge)

  return { gemini, claude, gpt, rebuttal, counter, judge, transcript }
}
