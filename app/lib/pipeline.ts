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
  researchQuestion: string   // what the Lead Analyst asked Gemini to verify
  researchAnswer: string     // what Gemini found
  rebuttal: string           // Lead Analyst's direct response to Devil's Advocate
  concedes: string[]         // points the Lead Analyst admits are valid
  maintains: string[]        // points the Lead Analyst doubles down on
  updatedTarget: string      // target price after considering challenges
  finalStance: string        // one sentence summary of maintained position
}

export interface CounterResult {
  researchQuestion: string   // what the Devil's Advocate asked Gemini to verify
  researchAnswer: string     // what Gemini found
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

// Targeted Gemini research during debate — fetches fresh live data and answers
export async function runTargetedResearch(
  bundle: SignalBundle,
  question: string,
  context: string
): Promise<string> {

  // ── Classify what kind of data the question needs ──
  const q = question.toLowerCase()
  const needsNews        = q.includes('news') || q.includes('recent') || q.includes('latest') || q.includes('announced') || q.includes('report') || q.includes('catalyst')
  const needsFundamentals = q.includes('earnings') || q.includes('revenue') || q.includes('pe ') || q.includes('p/e') || q.includes('margin') || q.includes('eps') || q.includes('guidance') || q.includes('analyst') || q.includes('upgrade') || q.includes('downgrade') || q.includes('target')
  const needsOptions     = q.includes('option') || q.includes('put') || q.includes('call') || q.includes('iv ') || q.includes('implied vol') || q.includes('short interest') || q.includes('unusual')
  const needsTechnicals  = q.includes('support') || q.includes('resistance') || q.includes('rsi') || q.includes('macd') || q.includes('volume') || q.includes('moving average') || q.includes('trend') || q.includes('vwap') || q.includes('breakout') || q.includes('breakdown')
  const needsMacro       = q.includes('vix') || q.includes('fed') || q.includes('rate') || q.includes('market') || q.includes('sector') || q.includes('spy') || q.includes('inflation') || q.includes('macro')

  // ── Fetch additional live data the bundle may not have ──
  const liveDataParts: string[] = []

  // Fresh Finnhub quote for price-sensitive questions
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

  // Fresh analyst recommendations and price targets
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
          if (next) liveDataParts.push(`NEXT EARNINGS: ${next.date} — EPS estimate $${next.epsEstimate ?? 'N/A'}, Revenue estimate $${next.revenueEstimate ? (next.revenueEstimate/1e9).toFixed(2)+'B' : 'N/A'}`)
        }
      }
    } catch { /* non-critical */ }
  }

  // Fresh options data
  if (needsOptions) {
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
            liveDataParts.push(`OPTIONS (${expiries[0]}): P/C ratio ${pcr}, Call vol ${callVol}, Put vol ${putVol}`)
            if (highIV.length) liveDataParts.push(`HIGH IV OPTIONS: ${highIV.join(' | ')}`)
          }
        }
      }
    } catch { /* non-critical */ }
  }

  // Fresh VIX and macro
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
    ? `\nFRESH LIVE DATA (just fetched):\n${liveDataParts.join('\n')}`
    : ''

  // ── Build full context for Gemini ──
  const sections: string[] = []
  if (needsNews || !needsTechnicals) sections.push(bundle.aiContext.newsSection)
  if (needsTechnicals) sections.push(bundle.aiContext.technicalsSection)
  if (needsFundamentals) sections.push(bundle.aiContext.fundamentalsSection)
  if (needsOptions) sections.push(bundle.aiContext.optionsSection)
  if (needsMacro) sections.push(bundle.aiContext.marketSection)
  if (needsOptions || needsTechnicals) sections.push(bundle.aiContext.smartMoneySection)
  // Always include context passed by caller
  if (context && !sections.some(s => s === context)) sections.push(context)

  const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']
  for (const modelName of GEMINI_MODELS) {
    try {
      const model = getGenAI().getGenerativeModel({ model: modelName })
      const result = await model.generateContent(`You are the News Scout providing urgent real-time research during a live stock debate about ${bundle.ticker} (currently $${bundle.currentPrice.toFixed(2)}).

A council member has asked: "${question}"
${liveData}

SIGNAL DATA FROM BUNDLE:
${sections.join('\n\n')}

Answer in 2-4 sentences using the freshest data available, prioritizing the LIVE DATA section if present. Include specific numbers, dates, and percentages. Be direct and decisive — this goes straight into the debate. If the data genuinely doesn't support the question, say so clearly.`)
      return result.response.text().trim().slice(0, 600)
    } catch (e) {
      const msg = (e as Error).message ?? ''
      if (!msg.includes('503') && !msg.includes('overload') && !msg.includes('404')) throw e
    }
  }
  return 'Research unavailable at this time.'
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
      const isForexPair = bundle.ticker.length === 6 && /^[A-Z]{6}$/.test(bundle.ticker) && ['USD','EUR','GBP','JPY','AUD','CAD','NZD','CHF','SEK','NOK','DKK','SGD','HKD','MXN','ZAR','TRY'].some(c => bundle.ticker.startsWith(c) || bundle.ticker.endsWith(c))
      const assetContext = isForexPair
        ? `This is a FOREX currency pair. Analysis focuses on: central bank policy divergence between the two currencies, macroeconomic data (inflation, employment, GDP) for each region, interest rate differentials, technical price action, and global risk sentiment. There are no earnings, P/E ratios, or insider data for forex. Use the technical signals and macro context as your primary evidence.`
        : `${pi[p] ?? pi.balanced}`
      return `You are the Lead Analyst (${pn[p] ?? 'Balanced'} perspective) in an elite AI council for ${bundle.ticker}. ${assetContext} Be decisive. Support every claim with specific data. Your analysis will be challenged by the Devil's Advocate. Never mention missing or unavailable data — only use what you have. IMPORTANT: If the price data shows a period change exceeding ±200%, treat this as a potential data error and note it explicitly rather than building your analysis on it.`
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

REQUIRED: Your technicalBasis MUST reference at least 2 of these if present in the data above: Ichimoku cloud position, ATR-derived stop/target levels, Williams %R, CCI, ROC momentum direction, relative strength vs sector. These are high-signal indicators — ignoring them weakens your case.

JSON ONLY:
{"signal":"BULLISH|BEARISH|NEUTRAL","reasoning":"4-5 sentences integrating all signals including new indicators","target":"price target e.g. $195","confidence":<0-100>,"technicalBasis":"2-3 sentences — must cite Ichimoku, ATR, or relative strength if available","fundamentalBasis":"2 sentences","catalysts":["2-3 catalysts"],"keyRisks":["2-3 risks"]}`
    }]
  })
  return parseJSON<ClaudeResult>((msg.content[0] as { text: string }).text)
}

export async function runGPT(bundle: SignalBundle, gemini: GeminiResult, claude: ClaudeResult): Promise<GptResult> {
  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1000,
    messages: [
      { role: 'system', content: `You are the Devil's Advocate in an elite AI stock council for ${bundle.ticker}. Challenge the Lead Analyst's conclusions with data. Do NOT simply agree. Never mention missing or unavailable data — only use what you have. Absence of a metric is not evidence of anything.` },
      { role: 'user', content: `TICKER: ${bundle.ticker} | PRICE: $${bundle.currentPrice.toFixed(2)}

NEWS SCOUT: ${gemini.sentiment} sentiment, ${gemini.confidence}% confidence
${gemini.summary}

LEAD ANALYST (${claude.signal}, ${claude.confidence}%): ${claude.reasoning}
Target: ${claude.target} | Risks: ${claude.keyRisks.join('; ')}

SIGNAL DATA:
${bundle.aiContext.technicalsSection}
${bundle.aiContext.optionsSection}
${bundle.aiContext.convictionSection}

EXPLOIT THESE IF THEY CONTRADICT THE LEAD ANALYST'S THESIS:
- Ichimoku cloud position (above/below/in cloud, TK cross direction)
- ATR-based volatility (is the suggested stop realistic given ATR?)
- Williams %R and CCI readings (do they confirm or contradict RSI?)
- ROC momentum (accelerating or decelerating?)
- Relative strength vs sector (outperforming or lagging peers?)
- GEX signal (dealer positioning — pinning or amplifying?)
- Earnings implied move vs historical (options overpriced/underpriced?)

JSON ONLY:
{"agrees":<true|false>,"signal":"BULLISH|BEARISH|NEUTRAL","reasoning":"4 sentences","confidence":<0-100>,"challenges":["2-4 specific data-backed challenges — cite the new indicators above if they support your case"],"alternateScenario":"scenario the Lead Analyst underweights","strongestCounterArgument":"single most compelling counter"}` }
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

  // ── Step 1: Lead Analyst identifies the single most important data gap ──
  // Ask Claude what it needs Gemini to verify before rebutting
  const researchAsk = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 150,
    system: `You are the Lead Analyst in a stock debate about ${bundle.ticker}. You can send ONE research question to the News Scout (who has access to real-time news, fundamentals, options flow, and market data) before you respond to the Devil's Advocate. Ask about the single most important data point that would resolve the most significant challenge.`,
    messages: [{
      role: 'user',
      content: `YOUR ORIGINAL CALL: ${claude.signal} at $${bundle.currentPrice.toFixed(2)}, target ${claude.target}

DEVIL'S ADVOCATE CHALLENGES:
${gpt.challenges.map((c, i) => `${i+1}. ${c}`).join('\n')}
STRONGEST COUNTER: ${gpt.strongestCounterArgument}

What ONE question should the News Scout research right now to help you respond? Reply with just the question, nothing else.`
    }]
  })
  const researchQuestion = (researchAsk.content[0] as { text: string }).text.trim()

  // ── Step 2: Gemini runs the targeted research ──
  const researchContext = `${bundle.aiContext.technicalsSection}\n${bundle.aiContext.fundamentalsSection}\n${bundle.aiContext.smartMoneySection}\n${bundle.aiContext.optionsSection}\n${bundle.aiContext.marketSection}`
  const researchAnswer = await runTargetedResearch(bundle, researchQuestion, researchContext)

  // ── Step 3: Lead Analyst rebuts with fresh research in hand ──
  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 900,
    system: `You are the Lead Analyst in an elite AI stock council for ${bundle.ticker}. The News Scout just provided fresh research to help you respond. Use it. Defend your position where data supports you, concede where the Devil's Advocate is correct. Intellectual honesty wins with the Judge.`,
    messages: [{
      role: 'user',
      content: `YOUR ORIGINAL CALL: ${claude.signal} on ${bundle.ticker} at $${bundle.currentPrice.toFixed(2)}, target ${claude.target}
YOUR REASONING: ${claude.reasoning}

DEVIL'S ADVOCATE CHALLENGES:
${gpt.challenges.map((c, i) => `${i+1}. ${c}`).join('\n')}
STRONGEST COUNTER: ${gpt.strongestCounterArgument}
ALTERNATE SCENARIO: ${gpt.alternateScenario}

NEWS SCOUT RESEARCH (fresh data, just retrieved):
Question asked: "${researchQuestion}"
Answer: ${researchAnswer}

Now respond directly to each challenge. Reference the fresh research where relevant. Concede valid points. Defend positions backed by data. Update your price target if warranted.

JSON ONLY:
{
  "signal": "BULLISH|BEARISH|NEUTRAL",
  "confidence": <0-100>,
  "researchQuestion": "${researchQuestion.replace(/"/g, "'")}",
  "researchAnswer": ${JSON.stringify(researchAnswer)},
  "rebuttal": "3-4 sentences directly responding to the challenges, referencing the fresh research",
  "concedes": ["specific points you now agree the Devil's Advocate got right — be honest, 1-3 items"],
  "maintains": ["specific points you stand firm on with data backing — 2-4 items"],
  "updatedTarget": "revised price target or same as before",
  "finalStance": "one sentence — your maintained position after considering all challenges and research"
}`
    }]
  })
  const raw = parseJSON<RebuttalResult>((msg.content[0] as { text: string }).text)
  // Ensure research fields are always populated
  return {
    ...raw,
    researchQuestion,
    researchAnswer,
  }
}

// Devil's Advocate fires back after Lead Analyst's rebuttal
export async function runCounter(
  bundle: SignalBundle,
  gpt: GptResult,
  rebuttal: RebuttalResult
): Promise<CounterResult> {

  // ── Step 1: Devil's Advocate identifies what Gemini should verify ──
  const researchAsk = await getOpenAI().chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 150,
    messages: [
      { role: 'system', content: `You are the Devil's Advocate in a stock debate about ${bundle.ticker}. You can send ONE research question to the News Scout (who has access to real-time news, fundamentals, options flow, and market data) before firing back at the Lead Analyst. Ask about the single most important thing that could strengthen your challenge or expose a weakness in their rebuttal.` },
      { role: 'user', content: `LEAD ANALYST'S REBUTTAL: ${rebuttal.rebuttal}
THEY CONCEDE: ${rebuttal.concedes.join('; ')}
THEY MAINTAIN: ${rebuttal.maintains.join('; ')}
FRESH RESEARCH THEY USED: "${rebuttal.researchQuestion}" → ${rebuttal.researchAnswer}

What ONE question should the News Scout research right now to help you counter? Reply with just the question, nothing else.` }
    ]
  })
  const researchQuestion = researchAsk.choices[0].message.content?.trim() ?? ''

  // ── Step 2: Gemini runs the targeted research ──
  const researchContext = `${bundle.aiContext.technicalsSection}\n${bundle.aiContext.fundamentalsSection}\n${bundle.aiContext.smartMoneySection}\n${bundle.aiContext.optionsSection}\n${bundle.aiContext.marketSection}`
  const researchAnswer = await runTargetedResearch(bundle, researchQuestion, researchContext)

  // ── Step 3: Devil's Advocate fires back with fresh research ──
  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 700,
    messages: [
      { role: 'system', content: `You are the Devil's Advocate in an elite AI stock council for ${bundle.ticker}. The News Scout just provided fresh research. Use it. This is your final shot. Be sharp, specific, and data-driven.` },
      { role: 'user', content: `YOUR ORIGINAL CHALLENGES: ${gpt.challenges.join('; ')}

LEAD ANALYST'S REBUTTAL: ${rebuttal.rebuttal}
THEY CONCEDE: ${rebuttal.concedes.join('; ')}
THEY MAINTAIN: ${rebuttal.maintains.join('; ')}
UPDATED TARGET: ${rebuttal.updatedTarget}
RESEARCH THEY CITED: "${rebuttal.researchQuestion}" → ${rebuttal.researchAnswer}

YOUR FRESH RESEARCH (just retrieved):
Question: "${researchQuestion}"
Answer: ${researchAnswer}

Now fire back. Acknowledge where their rebuttal was convincing. Use the fresh research to press on unresolved weaknesses. What must the Judge not ignore?

JSON ONLY:
{
  "researchQuestion": ${JSON.stringify(researchQuestion)},
  "researchAnswer": ${JSON.stringify(researchAnswer)},
  "finalChallenge": "2-3 sentences — your strongest remaining challenge, referencing fresh research where relevant",
  "yieldsOn": ["points where their rebuttal genuinely convinced you — be honest, 1-2 items"],
  "pressesOn": ["points that remain unresolved and the Judge must weigh — 2-3 items"],
  "closingArgument": "one sentence — the single most important thing for the Judge to consider"
}` }
    ]
  })
  const raw = parseJSON<CounterResult>(completion.choices[0].message.content!)
  return {
    ...raw,
    researchQuestion,
    researchAnswer,
  }
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
    system: `You are the Judge of an elite AI stock council for ${bundle.ticker}. The council has three roles: News Scout, Lead Analyst, and Devil's Advocate. You hold NO prior position. ${judgePersona[judgePersonaKey] ?? judgePersona.balanced} Weigh argument QUALITY not vote count. Be decisive. Refer to council members by their role names only. IMPORTANT: Never cite missing or unavailable data as a reason for lower conviction — only cite the data you have. If a metric is unavailable, ignore it entirely rather than mentioning its absence.`,
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
LEAD ANALYST consulted News Scout: "${rebuttal.researchQuestion}"
News Scout found: ${rebuttal.researchAnswer}
LEAD ANALYST REBUTTAL (updated signal: ${rebuttal.signal}, ${rebuttal.confidence}%):
${rebuttal.rebuttal}
Concedes: ${rebuttal.concedes.join('; ')}
Maintains: ${rebuttal.maintains.join('; ')}
Updated target: ${rebuttal.updatedTarget}

DEVIL'S ADVOCATE consulted News Scout: "${counter?.researchQuestion ?? ''}"
News Scout found: ${counter?.researchAnswer ?? ''}
DEVIL'S ADVOCATE COUNTER:
${counter?.finalChallenge ?? ''}
Yields on: ${counter?.yieldsOn.join('; ') ?? ''}
Still pressing: ${counter?.pressesOn.join('; ') ?? ''}
Closing argument: ${counter?.closingArgument ?? ''}` : ''}

OPTIONS FLOW & VOLATILITY:
${bundle.aiContext.optionsSection}

KEY TECHNICAL CONTEXT (for stop/target calibration):
${bundle.aiContext.technicalsSection}

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
  "stopLoss": "where to cut losses — use the ATR-derived stop from the signal data if available, explain why e.g. '$189 — 2× ATR below entry, below SMA200 support'",
  "takeProfit": "where to take profits — use ATR-derived target if available. For BULLISH above entry, for BEARISH below entry. e.g. BULLISH: '$215 first (1.5× ATR), $225 full exit at resistance' | BEARISH: '$192 first target, $185 full exit'",
  "timeHorizon": "realistic timeframe e.g. 2-3 weeks for base case to play out",
  "plainEnglish": "Explain the verdict in simple plain English as if talking to someone who has never traded before. 3-4 sentences. No jargon. What is this stock doing and what should someone know about it right now?",
  "technicalsExplained": "Explain what the technical signals mean in plain English. Cover: what the Ichimoku cloud position says about the trend, what ATR says about volatility and appropriate stop placement, what RSI/Williams/CCI oscillators agree or disagree on, and whether momentum (ROC) is accelerating or decelerating. 4-5 sentences a beginner would understand.",
  "fundamentalsExplained": "Explain what the fundamental signals mean in plain English. What do the analyst ratings mean? What does earnings date mean for the stock? If earnings implied move data is available, explain whether options are overpriced or underpriced. What does insider buying or selling tell us? 3-4 sentences.",
  "smartMoneyExplained": "Explain what the smart money signals mean in plain English. What does it mean when insiders buy or sell? What does congressional trading tell us? What does options flow, GEX (dealer positioning), and short interest mean? 3-4 sentences.",
  "actionPlan": "Give a clear, specific, step-by-step action plan in plain English. Reference the ATR-derived stop and target levels specifically. What should someone actually DO — buy, sell, wait, set an alert? Be specific about price levels. 4-5 sentences.",
  "optionsStrategy": "Based on the verdict, options flow, IV conditions, and GEX signal — what is the single best options approach right now? One paragraph. If earnings are near, address whether the implied move makes options expensive or cheap. Cover whether to buy or sell options, what type of strategy fits, and why. Write for someone who understands options basics."
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
