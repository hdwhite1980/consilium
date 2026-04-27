// =============================================================
// app/api/analyze/qa/route.ts
//
// Follow-up Q&A endpoint. Called after a Council verdict has rendered.
// Accepts:
//   - ticker
//   - analysisContext: full Council results (technicals, news, all
//     model verdicts, judge synthesis) — passed by client
//   - history: prior Q&A exchanges in this session
//   - question: the new question
//
// Returns:
//   - answer: Claude Sonnet 4.5's response
//
// Stateless on the server. Client manages conversation state.
// Conversation history is capped at 6 exchanges (12 messages) and
// roughly 6K tokens before the oldest gets trimmed.
//
// Cost per turn: ~$0.02-0.04 (3K input + 500 output @ Sonnet pricing)
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/app/lib/auth/server'

export const runtime = 'nodejs'
export const maxDuration = 30

// ---- Types ----------------------------------------------------

interface QAMessage {
  role: 'user' | 'assistant'
  content: string
}

interface AnalysisContext {
  ticker: string
  currentPrice: number
  // Final verdict
  verdict: {
    signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
    confidence: number
    target: string
    risk: string
    summary: string
    winningArgument: string
    dissent: string
    invalidationTrigger: string
    entryPrice: string
    stopLoss: string
    takeProfit: string
    timeHorizon: string
    actionPlan: string
    optionsStrategy?: string
  }
  // News scout findings
  news: {
    summary: string
    sentiment: string
    headlines: string[]
    keyEvents: string[]
    macroFactors: string[]
    regimeAssessment: string
  } | null
  // Lead Analyst (Claude) original verdict
  leadAnalyst: {
    signal: string
    reasoning: string
    target: string
    confidence: number
    technicalBasis: string
    fundamentalBasis: string
    catalysts: string[]
    keyRisks: string[]
  } | null
  // Devil's Advocate (GPT) challenge
  devilsAdvocate: {
    agrees: boolean
    signal: string
    reasoning: string
    challenges: string[]
    alternateScenario: string
    strongestCounterArgument: string
  } | null
  // Lead Analyst's rebuttal
  rebuttal: {
    signal: string
    confidence: number
    rebuttal: string
    concedes: string[]
    maintains: string[]
    finalStance: string
  } | null
  // Devil's Advocate counter
  counter: {
    finalChallenge: string
    yieldsOn: string[]
    pressesOn: string[]
    closingArgument: string
  } | null
  // Technicals snapshot
  technicals: {
    rsi?: number
    macd?: string
    sma50?: number
    sma200?: number
    bias?: string
    keySignals?: string[]
  } | null
  // Social pulse
  social?: {
    bullishCount?: number
    bearishCount?: number
    keyThemes?: string[]
    summary?: string
  } | null
}

// ---- Helpers --------------------------------------------------

let _anthropic: Anthropic | null = null
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) throw new Error('ANTHROPIC_API_KEY not configured')
    _anthropic = new Anthropic({ apiKey: key })
  }
  return _anthropic
}

/**
 * Trim conversation history to stay within ~6K tokens.
 * Rough approximation: 4 chars per token.
 * Keeps most recent exchanges, drops oldest if over budget.
 * Always retains at least the most recent user question.
 */
function trimHistory(history: QAMessage[]): QAMessage[] {
  const MAX_TOKENS = 6000
  const APPROX_CHARS_PER_TOKEN = 4

  if (history.length <= 2) return history

  // Compute total chars, working backward from most recent
  const reversed = [...history].reverse()
  const kept: QAMessage[] = []
  let totalChars = 0

  for (const msg of reversed) {
    totalChars += msg.content.length
    if (totalChars / APPROX_CHARS_PER_TOKEN > MAX_TOKENS && kept.length >= 2) {
      break
    }
    kept.unshift(msg)
  }

  // Cap at 12 messages (6 exchanges) regardless of token count
  if (kept.length > 12) {
    return kept.slice(kept.length - 12)
  }

  return kept
}

/**
 * Build the system prompt — defines Claude's role and includes the
 * full Council analysis context.
 */
function buildSystemPrompt(ctx: AnalysisContext): string {
  const v = ctx.verdict
  const sections: string[] = []

  sections.push(`You are a senior market analyst answering follow-up questions about a Council analysis you helped produce for ${ctx.ticker} at $${ctx.currentPrice.toFixed(2)}.`)
  sections.push(``)
  sections.push(`Your job is to answer questions clearly and directly using the analysis below. Stay grounded in the evidence already gathered. If asked something the data doesn't support, say so plainly. Do not speculate beyond what the analysis shows.`)
  sections.push(``)
  sections.push(`Be concise. 2-4 paragraphs typically. Use plain language. No emojis. No disclaimers about not being financial advice unless directly relevant.`)
  sections.push(``)
  sections.push(`If the user asks something genuinely outside the scope (e.g., "should I buy SPY instead?"), redirect them to running a fresh analysis on that ticker.`)

  // ---- Final verdict section
  sections.push(``)
  sections.push(`========================================`)
  sections.push(`FINAL COUNCIL VERDICT`)
  sections.push(`========================================`)
  sections.push(`Signal: ${v.signal} (${v.confidence}% confidence)`)
  sections.push(`Target: ${v.target}`)
  sections.push(`Time Horizon: ${v.timeHorizon}`)
  sections.push(`Entry: ${v.entryPrice} | Stop: ${v.stopLoss} | Take Profit: ${v.takeProfit}`)
  sections.push(``)
  sections.push(`Summary: ${v.summary}`)
  sections.push(``)
  sections.push(`Winning Argument: ${v.winningArgument}`)
  if (v.dissent) {
    sections.push(`Dissenting View: ${v.dissent}`)
  }
  sections.push(``)
  sections.push(`Invalidation Trigger: ${v.invalidationTrigger}`)
  sections.push(`Action Plan: ${v.actionPlan}`)
  if (v.optionsStrategy) {
    sections.push(`Options Strategy: ${v.optionsStrategy}`)
  }
  sections.push(`Primary Risk: ${v.risk}`)

  // ---- Lead Analyst's original case
  if (ctx.leadAnalyst) {
    sections.push(``)
    sections.push(`========================================`)
    sections.push(`LEAD ANALYST (CLAUDE) - ORIGINAL CASE`)
    sections.push(`========================================`)
    sections.push(`Signal: ${ctx.leadAnalyst.signal} (${ctx.leadAnalyst.confidence}% confidence)`)
    sections.push(`Target: ${ctx.leadAnalyst.target}`)
    sections.push(`Reasoning: ${ctx.leadAnalyst.reasoning}`)
    sections.push(`Technical basis: ${ctx.leadAnalyst.technicalBasis}`)
    sections.push(`Fundamental basis: ${ctx.leadAnalyst.fundamentalBasis}`)
    if (ctx.leadAnalyst.catalysts?.length > 0) {
      sections.push(`Catalysts: ${ctx.leadAnalyst.catalysts.join(' | ')}`)
    }
    if (ctx.leadAnalyst.keyRisks?.length > 0) {
      sections.push(`Key risks: ${ctx.leadAnalyst.keyRisks.join(' | ')}`)
    }
  }

  // ---- Devil's Advocate challenge
  if (ctx.devilsAdvocate) {
    sections.push(``)
    sections.push(`========================================`)
    sections.push(`DEVIL'S ADVOCATE (GPT) - CHALLENGE`)
    sections.push(`========================================`)
    sections.push(`Agrees with Lead Analyst: ${ctx.devilsAdvocate.agrees ? 'YES' : 'NO'}`)
    sections.push(`Counter-signal: ${ctx.devilsAdvocate.signal}`)
    sections.push(`Reasoning: ${ctx.devilsAdvocate.reasoning}`)
    if (ctx.devilsAdvocate.challenges?.length > 0) {
      sections.push(`Challenges raised: ${ctx.devilsAdvocate.challenges.map((c, i) => `\n  ${i + 1}. ${c}`).join('')}`)
    }
    sections.push(`Strongest counter-argument: ${ctx.devilsAdvocate.strongestCounterArgument}`)
    if (ctx.devilsAdvocate.alternateScenario) {
      sections.push(`Alternate scenario: ${ctx.devilsAdvocate.alternateScenario}`)
    }
  }

  // ---- Rebuttal (Lead Analyst responds)
  if (ctx.rebuttal) {
    sections.push(``)
    sections.push(`========================================`)
    sections.push(`LEAD ANALYST'S REBUTTAL`)
    sections.push(`========================================`)
    sections.push(`Updated signal: ${ctx.rebuttal.signal} (${ctx.rebuttal.confidence}% confidence)`)
    sections.push(`Rebuttal: ${ctx.rebuttal.rebuttal}`)
    if (ctx.rebuttal.concedes?.length > 0) {
      sections.push(`Concedes: ${ctx.rebuttal.concedes.join(' | ')}`)
    }
    if (ctx.rebuttal.maintains?.length > 0) {
      sections.push(`Maintains: ${ctx.rebuttal.maintains.join(' | ')}`)
    }
    sections.push(`Final stance: ${ctx.rebuttal.finalStance}`)
  }

  // ---- Counter (Devil's Advocate's final word)
  if (ctx.counter) {
    sections.push(``)
    sections.push(`========================================`)
    sections.push(`DEVIL'S ADVOCATE COUNTER`)
    sections.push(`========================================`)
    sections.push(`Final challenge: ${ctx.counter.finalChallenge}`)
    if (ctx.counter.yieldsOn?.length > 0) {
      sections.push(`Yields on: ${ctx.counter.yieldsOn.join(' | ')}`)
    }
    if (ctx.counter.pressesOn?.length > 0) {
      sections.push(`Presses on: ${ctx.counter.pressesOn.join(' | ')}`)
    }
    sections.push(`Closing argument: ${ctx.counter.closingArgument}`)
  }

  // ---- News context
  if (ctx.news) {
    sections.push(``)
    sections.push(`========================================`)
    sections.push(`NEWS SCOUT FINDINGS`)
    sections.push(`========================================`)
    sections.push(`Sentiment: ${ctx.news.sentiment}`)
    sections.push(`Summary: ${ctx.news.summary}`)
    if (ctx.news.headlines?.length > 0) {
      sections.push(`Top headlines:`)
      ctx.news.headlines.slice(0, 8).forEach((h, i) => sections.push(`  ${i + 1}. ${h}`))
    }
    if (ctx.news.keyEvents?.length > 0) {
      sections.push(`Key events: ${ctx.news.keyEvents.join(' | ')}`)
    }
    if (ctx.news.macroFactors?.length > 0) {
      sections.push(`Macro factors: ${ctx.news.macroFactors.join(' | ')}`)
    }
    sections.push(`Regime: ${ctx.news.regimeAssessment}`)
  }

  // ---- Technicals
  if (ctx.technicals) {
    sections.push(``)
    sections.push(`========================================`)
    sections.push(`TECHNICAL INDICATORS`)
    sections.push(`========================================`)
    if (ctx.technicals.bias) sections.push(`Overall bias: ${ctx.technicals.bias}`)
    if (ctx.technicals.rsi !== undefined) sections.push(`RSI: ${ctx.technicals.rsi.toFixed(1)}`)
    if (ctx.technicals.macd) sections.push(`MACD: ${ctx.technicals.macd}`)
    if (ctx.technicals.sma50 !== undefined) sections.push(`SMA50: $${ctx.technicals.sma50.toFixed(2)}`)
    if (ctx.technicals.sma200 !== undefined) sections.push(`SMA200: $${ctx.technicals.sma200.toFixed(2)}`)
    if (ctx.technicals.keySignals && ctx.technicals.keySignals.length > 0) {
      sections.push(`Key signals: ${ctx.technicals.keySignals.join(' | ')}`)
    }
  }

  // ---- Social
  if (ctx.social) {
    sections.push(``)
    sections.push(`========================================`)
    sections.push(`SOCIAL SENTIMENT`)
    sections.push(`========================================`)
    if (ctx.social.summary) sections.push(`Summary: ${ctx.social.summary}`)
    if (ctx.social.bullishCount !== undefined && ctx.social.bearishCount !== undefined) {
      sections.push(`Mention split: ${ctx.social.bullishCount} bullish | ${ctx.social.bearishCount} bearish`)
    }
    if (ctx.social.keyThemes && ctx.social.keyThemes.length > 0) {
      sections.push(`Key themes: ${ctx.social.keyThemes.join(' | ')}`)
    }
  }

  return sections.join('\n')
}

// ---- Route handler --------------------------------------------

export async function POST(req: NextRequest) {
  try {
    // Auth check
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Parse body
    const body = await req.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const ctx = body.analysisContext as AnalysisContext | undefined
    const history = body.history as QAMessage[] | undefined
    const question = body.question as string | undefined

    if (!ctx || !ctx.verdict || !ctx.ticker) {
      return NextResponse.json({ error: 'analysisContext (with verdict and ticker) is required' }, { status: 400 })
    }
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return NextResponse.json({ error: 'question is required' }, { status: 400 })
    }
    if (question.length > 1000) {
      return NextResponse.json({ error: 'Question too long (max 1000 chars)' }, { status: 400 })
    }

    const safeHistory: QAMessage[] = Array.isArray(history)
      ? history.filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string').slice(0, 24)
      : []

    // Trim history to budget
    const trimmedHistory = trimHistory(safeHistory)

    // Build messages: prior history + new question
    const messages: { role: 'user' | 'assistant'; content: string }[] = [
      ...trimmedHistory.map(m => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: question.trim() },
    ]

    // Call Claude
    const systemPrompt = buildSystemPrompt(ctx)

    const response = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: systemPrompt,
      messages,
    })

    const textBlock = response.content.find(b => b.type === 'text')
    const answer = textBlock && textBlock.type === 'text' ? textBlock.text : ''

    if (!answer) {
      return NextResponse.json({ error: 'Empty response from model' }, { status: 502 })
    }

    return NextResponse.json({
      answer,
      tokensUsed: {
        input: response.usage?.input_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[qa] Error:', msg)
    // Don't leak internal error details to client
    return NextResponse.json(
      { error: msg.slice(0, 200) },
      { status: 500 }
    )
  }
}
