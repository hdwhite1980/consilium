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

export async function runJudge(
  bundle: SignalBundle,
  gemini: GeminiResult,
  claude: ClaudeResult,
  gpt: GptResult,
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

LEAD ANALYST (${claude.signal}, ${claude.confidence}%): ${claude.reasoning}
Technical: ${claude.technicalBasis}
Fundamental: ${claude.fundamentalBasis}
Target: ${claude.target}

DEVIL'S ADVOCATE (${gpt.signal}, ${gpt.confidence}%, ${gpt.agrees ? 'AGREES' : 'DISAGREES'}): ${gpt.reasoning}
Challenges: ${gpt.challenges.join('; ')}
Counter: ${gpt.strongestCounterArgument}

OPTIONS FLOW:
${bundle.aiContext.optionsSection}

CONVICTION ENGINE:
${bundle.aiContext.convictionSection}

JSON ONLY — include ALL fields below:
{
  "signal": "BULLISH|BEARISH|NEUTRAL",
  "confidence": <0-100>,
  "target": "specific price target e.g. $248",
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
  "takeProfit": "where to take profits e.g. $215 first target, $225 full exit",
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

  onProgress('gemini_start', {})
  const gemini = await runGemini(bundle)
  transcript.push({ role: 'gemini', stage: 'news_macro', content: gemini.summary, confidence: gemini.confidence, timestamp: ts() })
  onProgress('gemini_done', gemini)

  onProgress('claude_start', { gemini })
  const claude = await runClaude(bundle, gemini)
  transcript.push({ role: 'claude', stage: 'lead_analyst', content: claude.reasoning, signal: claude.signal, confidence: claude.confidence, timestamp: ts() })
  onProgress('claude_done', claude)

  onProgress('gpt_start', { gemini, claude })
  const gpt = await runGPT(bundle, gemini, claude)
  transcript.push({ role: 'gpt', stage: 'devils_advocate', content: gpt.reasoning, signal: gpt.signal, confidence: gpt.confidence, timestamp: ts() })
  onProgress('gpt_done', gpt)

  onProgress('judge_start', {})
  const judge = await runJudge(bundle, gemini, claude, gpt, 1)
  transcript.push({ role: 'judge', stage: 'arbitrator', content: judge.summary, signal: judge.signal, confidence: judge.confidence, timestamp: ts() })
  onProgress('judge_done', judge)

  return { gemini, claude, gpt, judge, transcript }
}
