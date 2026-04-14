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
  const model = getGenAI().getGenerativeModel({ model: 'gemini-2.5-flash' })
  const result = await model.generateContent(`You are the News Scout and Macro Analyst for an elite AI stock council.

Analyze all news, macro, and market context for ${bundle.ticker}. You go first. Be specific.

${bundle.aiContext.newsSection}

${bundle.aiContext.marketSection}

Respond JSON ONLY (no fences):
{"summary":"3 sentence overview","headlines":["top 4-5 headlines"],"sentiment":"positive|negative|neutral|mixed","confidence":<0-100>,"keyEvents":["2-4 near-term catalysts"],"macroFactors":["2-3 macro conditions"],"regimeAssessment":"1 sentence on regime impact"}`)
  return parseJSON<GeminiResult>(result.response.text())
}

export async function runClaude(bundle: SignalBundle, gemini: GeminiResult): Promise<ClaudeResult> {
  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: `You are the Lead Analyst in an elite AI stock council for ${bundle.ticker}. Synthesize ALL signals into a clear directional call. Be specific and data-driven. Your analysis will be challenged by GPT-4o.`,
    messages: [{
      role: 'user',
      content: `TICKER: ${bundle.ticker} | TIMEFRAME: ${bundle.timeframe} | PRICE: $${bundle.currentPrice.toFixed(2)}

GEMINI'S MACRO BRIEF:
${gemini.summary}
Sentiment: ${gemini.sentiment} | Regime: ${gemini.regimeAssessment}
Events: ${gemini.keyEvents.join('; ')}

YOUR SIGNAL DATA:
${bundle.aiContext.technicalsSection}

${bundle.aiContext.fundamentalsSection}

${bundle.aiContext.smartMoneySection}

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
      { role: 'system', content: `You are the Devil's Advocate in an elite AI stock council for ${bundle.ticker}. Challenge Claude's conclusions with data. Do NOT simply agree.` },
      { role: 'user', content: `TICKER: ${bundle.ticker} | PRICE: $${bundle.currentPrice.toFixed(2)}

GEMINI: ${gemini.sentiment} sentiment, ${gemini.confidence}% confidence
${gemini.summary}

CLAUDE (${claude.signal}, ${claude.confidence}%): ${claude.reasoning}
Target: ${claude.target} | Risks: ${claude.keyRisks.join('; ')}

SIGNAL DATA:
${bundle.aiContext.technicalsSection}
${bundle.aiContext.optionsSection}
${bundle.aiContext.convictionSection}

JSON ONLY:
{"agrees":<true|false>,"signal":"BULLISH|BEARISH|NEUTRAL","reasoning":"4 sentences","confidence":<0-100>,"challenges":["2-4 specific data-backed challenges"],"alternateScenario":"scenario Claude underweights","strongestCounterArgument":"single most compelling counter"}` }
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
  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1200,
    system: `You are the Judge of an elite AI stock council for ${bundle.ticker}. You hold NO prior position. Weigh argument QUALITY not vote count. Be decisive. Name the winning argument explicitly.`,
    messages: [{
      role: 'user',
      content: `TICKER: ${bundle.ticker} | PRICE: $${bundle.currentPrice.toFixed(2)} | ROUND: ${round}

GEMINI (${gemini.sentiment}, ${gemini.confidence}%): ${gemini.summary}
Regime: ${gemini.regimeAssessment}

CLAUDE (${claude.signal}, ${claude.confidence}%): ${claude.reasoning}
Technical: ${claude.technicalBasis}
Fundamental: ${claude.fundamentalBasis}
Target: ${claude.target}

GPT-4o (${gpt.signal}, ${gpt.confidence}%, ${gpt.agrees ? 'AGREES' : 'DISAGREES'}): ${gpt.reasoning}
Challenges: ${gpt.challenges.join('; ')}
Counter: ${gpt.strongestCounterArgument}

CONVICTION ENGINE:
${bundle.aiContext.convictionSection}

JSON ONLY:
{"signal":"BULLISH|BEARISH|NEUTRAL","confidence":<0-100>,"target":"price target","risk":"critical risk","summary":"4-5 sentence verdict","winningArgument":"who won and why","dissent":"strongest opposing view","scenarios":[{"label":"bull","probability":<0-100>,"trigger":"catalyst"},{"label":"base","probability":<0-100>,"trigger":"condition"},{"label":"bear","probability":<0-100>,"trigger":"risk"}],"invalidationTrigger":"clearest signal thesis is wrong","rounds":${round}}`
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
