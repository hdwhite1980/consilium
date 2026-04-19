// ─────────────────────────────────────────────────────────────
// AI Pipeline v2 — All 5 phases integrated
// Each AI receives the full signal bundle, not just price text
// ─────────────────────────────────────────────────────────────
//
// Changelog:
//   Apr 19 (a58f): Gap #1 — Sequential debate (Lead → Devil → Rebuttal → Counter)
//                  Previously Devil and Rebuttal ran in parallel with a hardcoded
//                  empty challenge set, making the Rebuttal stage non-functional.
//   Apr 19 (a58f): Gap #2 — Gemini 2.5 Pro Judge (GEMINI_JUDGE env toggle,
//                  automatic Claude Opus fallback on any Gemini failure).
//   Apr 19 (b*):   Gap #3 — Calibrated adversarial Devil's Advocate with
//                  explicit permission to return NEUTRAL when data supports Lead.
//   Apr 19 (b*):   Gap #4 — Symmetric Judge presentation (both sides get
//                  identical field structure across both rounds).
//   Apr 19 (c*):   Gap #5 — Multi-source Round 2 research:
//                  - News questions trigger parallel fetch from Alpaca + Finnhub
//                    ticker-news endpoints (fresh headlines, last 6h)
//                  - Sentiment/narrative questions trigger Grok x_search
//                  - Fundamentals questions still use Finnhub structured data
//                  - All sources run in parallel, dedupe, synthesized by Gemini
//   Apr 19 (c*):   Gap #6 — Judge correction logging to judge_corrections table.
//                  Every time sanitizeJudgeResult fixes a directional error,
//                  we write a row so we can measure Gemini vs Claude accuracy.
//
// ─────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { buildMacroIntelligenceContext } from './macro-intelligence'
import type { SignalBundle } from './aggregator'
import { runSocialScout, formatSocialSentimentForPrompt, type SocialSentiment } from './social-scout'
import { callGrok } from './grok'

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
  researchQuestion: string
  researchAnswer: string
  rebuttal: string
  concedes: string[]
  maintains: string[]
  updatedTarget: string
  finalStance: string
}

export interface CounterResult {
  researchQuestion: string
  researchAnswer: string
  finalChallenge: string
  yieldsOn: string[]
  pressesOn: string[]
  closingArgument: string
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
  transcript: TranscriptMessage[]
  social: SocialSentiment
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
WEIGHT HEAVILY: Fundamentals — P/E vs history, EPS growth, analyst consensus and price targets.
WEIGHT NORMALLY: RSI (for entry timing only), MACD on daily.
TARGETS/STOPS: Use 2–3× ATR, align with key monthly S/R. Time horizon: 3-6 weeks.`

    case '3M': return `TIMEFRAME CONTEXT: This is a 3-MONTH investment analysis. Bars are daily candles with full trend context.
FOCUS ON: Macro trend, structural support/resistance, fundamental quality vs valuation, institutional flows.
WEIGHT HEAVILY: Fundamentals — earnings growth, margins, revenue trajectory, analyst target vs current price.
WEIGHT HEAVILY: Ichimoku cloud (structural trend), SMA200 (long-term bias), relative strength vs sector.
WEIGHT HEAVILY: Smart money — institutional holdings, insider buying, congressional trades.
WEIGHT NORMALLY: Short-term technicals (for entry timing only).
TARGETS/STOPS: Wider stops (3–4× ATR), align with major monthly S/R. Time horizon: 6-13 weeks.
NOTE: Minor technical noise is acceptable in a strong fundamental thesis. What matters is the 3-month trajectory.`

    default: return ''
  }
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
  if (!text || typeof text !== 'string') throw new Error('No JSON in response — empty or non-string input')
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
// GAP #5 — Multi-source Round 2 research helpers
// ─────────────────────────────────────────────────────────────
// When Lead/Devil ask a research question mid-debate, we now pull from
// multiple sources in parallel based on what the question is actually
// asking. Previously we only pulled structured data (earnings, metrics)
// even when the question was about fresh news or sentiment.

/**
 * Fetch fresh ticker-specific news from Alpaca (last N hours).
 * Returns formatted one-line entries with timestamps.
 */
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
      return `[${ts}] ${headline}${summary ? ' — ' + summary : ''}`
    })
  } catch { return [] }
}

/**
 * Fetch fresh ticker-specific news from Finnhub company-news endpoint.
 * Overlaps with Alpaca but covers some different outlets (Reuters, Barron's).
 */
async function fetchFreshFinnhubNews(ticker: string, hours = 6): Promise<string[]> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return []
  // Finnhub uses date-range, minimum 1 day granularity
  const daysBack = Math.max(1, Math.ceil(hours / 24))
  const from = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0]
  const to   = new Date().toISOString().split('T')[0]
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${key}`
    )
    if (!res.ok) return []
    const data = await res.json()
    // Filter to last N hours since Finnhub returns full day; newest first
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
        return `[${ts}] ${headline}${summary ? ' — ' + summary : ''}`
      })
  } catch { return [] }
}

/**
 * Fire Grok x_search for sentiment-heavy questions only. Returns the
 * narrative answer or empty string if nothing substantive was found.
 */
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
      { temperature: 0.3, maxTokens: 400, searchEnabled: true, timeoutMs: 25000 }
    )
    const clean = result.trim()
    if (clean.length < 20 || clean.toLowerCase().includes('insufficient live sentiment')) return ''
    return clean.slice(0, 600)
  } catch (e) {
    console.warn('[grok-sentiment] failed:', (e as Error).message?.slice(0, 100))
    return ''
  }
}

/**
 * Dedupe headlines by first 60 chars, case-insensitive.
 * Alpaca and Finnhub frequently syndicate the same articles.
 */
function dedupeHeadlines(all: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const h of all) {
    // Strip the [MM-DD HH:MM] timestamp prefix for comparison
    const body = h.replace(/^\[[^\]]+\]\s*/, '').toLowerCase()
    const key  = body.slice(0, 60)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(h)
    if (out.length >= 6) break
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// Targeted Gemini research during debate — fetches fresh live data
// and synthesizes a short answer usable mid-debate.
// ─────────────────────────────────────────────────────────────
export async function runTargetedResearch(
  bundle: SignalBundle,
  question: string,
  context: string
): Promise<string> {

  const q = question.toLowerCase()

  // Question classification
  const needsNews          = q.includes('news') || q.includes('recent') || q.includes('latest') || q.includes('announced') || q.includes('report') || q.includes('catalyst') || q.includes('breaking')
  const needsFundamentals  = q.includes('earnings') || q.includes('revenue') || q.includes('pe ') || q.includes('p/e') || q.includes('margin') || q.includes('eps') || q.includes('guidance') || q.includes('analyst') || q.includes('upgrade') || q.includes('downgrade') || q.includes('target')
  const needsOptions       = q.includes('option') || q.includes('put') || q.includes('call') || q.includes('iv ') || q.includes('implied vol') || q.includes('short interest') || q.includes('unusual')
  const needsTechnicals    = q.includes('support') || q.includes('resistance') || q.includes('rsi') || q.includes('macd') || q.includes('volume') || q.includes('moving average') || q.includes('trend') || q.includes('vwap') || q.includes('breakout') || q.includes('breakdown')
  const needsMacro         = q.includes('vix') || q.includes('fed') || q.includes('rate') || q.includes('market') || q.includes('sector') || q.includes('spy') || q.includes('inflation') || q.includes('macro')
  // New: sentiment-heavy questions → route to Grok
  const needsSentiment     = q.includes('sentiment') || q.includes('narrative') || q.includes('saying') || q.includes('buzz') || q.includes('reaction') ||
                             q.includes('twitter') || q.includes('x post') || q.includes('crowd') || q.includes('retail') ||
                             q.includes('fomo') || q.includes('bearish talk') || q.includes('bullish talk') ||
                             q.includes('management said') || q.includes('conference call') || q.includes('reacting')

  const liveDataParts: string[] = []

  // ── Structured fundamentals data (existing behavior) ──
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
          if (next) liveDataParts.push(`NEXT EARNINGS: ${next.date} — EPS estimate $${next.epsEstimate ?? 'N/A'}, Revenue estimate $${next.revenueEstimate ? (next.revenueEstimate/1e9).toFixed(2)+'B' : 'N/A'}`)
        }
      }
    } catch { /* non-critical */ }
  }

  // ── GAP #5: Fresh news from Alpaca + Finnhub (parallel) ──
  // Fires when question is news-related OR when it's sentiment-related
  // (because sentiment questions often reference news catalysts too).
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

  // ── GAP #5: Grok x_search for sentiment-heavy questions ──
  if (needsSentiment) {
    const grokAnswer = await fetchGrokSentiment(bundle.ticker, question)
    if (grokAnswer) {
      liveDataParts.push(`LIVE X SENTIMENT (Grok x_search):\n${grokAnswer}`)
    }
  }

  // ── Options data (existing) ──
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

  // ── Macro data (existing) ──
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

  // ── Pull pre-built bundle sections for topical context ──
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
DEBATE TIMEFRAME: ${bundle.timeframe} — keep your answer relevant to this horizon.

A council member has asked: "${question}"
${liveData}

SIGNAL DATA FROM BUNDLE:
${sections.join('\n\n')}

Answer in 2-4 sentences using the freshest data available, prioritizing the LIVE DATA section if present. When FRESH HEADLINES are shown, cite at least one by timestamp if it's directly relevant. When LIVE X SENTIMENT is shown, reference it explicitly. Include specific numbers, dates, and percentages. Be direct and decisive — this goes straight into the debate. If the data genuinely doesn't support the question, say so clearly.`)
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
        '1D': 'FOCUS on TODAY only — intraday news, pre/post-market moves, breaking catalysts. Ignore multi-week trends.',
        '1W': 'FOCUS on THIS WEEK — earnings this week, analyst actions, macro data releases in the next 5 days.',
        '1M': 'FOCUS on THIS MONTH — upcoming earnings date, recent upgrades/downgrades, sector rotation.',
        '3M': 'FOCUS on NEXT QUARTER — earnings trajectory, macro tailwinds/headwinds, institutional positioning.',
      }
      const newsInput = (bundle.aiContext.newsSection || '').slice(0, 6000)
      const marketInput = (bundle.aiContext.marketSection || '').slice(0, 2000)

      const result = await model.generateContent(`You are the News Scout and Macro Analyst for an elite AI stock council.

Analyze all news, macro, and market context for ${bundle.ticker}. You go first. Be specific.
TIMEFRAME: ${bundle.timeframe} — ${tfFocus[bundle.timeframe] ?? ''}

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
  throw lastError ?? new Error('News Scout unavailable — all models failed')
}

export async function runClaude(bundle: SignalBundle, gemini: GeminiResult, social?: SocialSentiment): Promise<ClaudeResult> {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (( bundle as any).persona ?? 'balanced') as string
      const isForexPair = bundle.ticker.length === 6 && /^[A-Z]{6}$/.test(bundle.ticker) && ['USD','EUR','GBP','JPY','AUD','CAD','NZD','CHF','SEK','NOK','DKK','SGD','HKD','MXN','ZAR','TRY'].some(c => bundle.ticker.startsWith(c) || bundle.ticker.endsWith(c))
      const assetContext = isForexPair
        ? `This is a FOREX currency pair. Analysis focuses on: central bank policy divergence between the two currencies, macroeconomic data (inflation, employment, GDP) for each region, interest rate differentials, technical price action, and global risk sentiment. There are no earnings, P/E ratios, or insider data for forex. Use the technical signals and macro context as your primary evidence.`
        : `${pi[p] ?? pi.balanced}`
      return `You are the Lead Analyst (${pn[p] ?? 'Balanced'} perspective) in an elite AI council for ${bundle.ticker}. ${assetContext} Be decisive. Support every claim with specific data. Your analysis will be challenged by the Devil's Advocate. Never mention missing or unavailable data — only use what you have. IMPORTANT: If the price data shows a period change exceeding ±200%, treat this as a potential data error and note it explicitly rather than building your analysis on it.

${timeframeContext(bundle.timeframe)}`
    })(),
    messages: [{
      role: 'user',
      content: `TICKER: ${bundle.ticker} | TIMEFRAME: ${bundle.timeframe} | PRICE: $${bundle.currentPrice.toFixed(2)}

${timeframeContext(bundle.timeframe)}

NEWS SCOUT BRIEF:
${gemini.summary}
Sentiment: ${gemini.sentiment} | Regime: ${gemini.regimeAssessment}
Events: ${gemini.keyEvents.join('; ')}

${social ? formatSocialSentimentForPrompt(social, 'lead') : ''}

YOUR SIGNAL DATA:
${bundle.aiContext.technicalsSection}

${bundle.aiContext.fundamentalsSection}

${bundle.aiContext.smartMoneySection}

${bundle.aiContext.optionsSection}

${bundle.aiContext.convictionSection}

${/* eslint-disable-next-line @typescript-eslint/no-explicit-any */ ''}${(bundle.aiContext as any).macroIntelligenceSection ? (bundle.aiContext as any).macroIntelligenceSection + '\n\n' : ''}REQUIRED: Your technicalBasis MUST reference at least 2 of these if present in the data above: Ichimoku cloud position, ATR-derived stop/target levels, Williams %R, CCI, ROC momentum direction, relative strength vs sector. These are high-signal indicators — ignoring them weakens your case.
PATTERNS: If the data includes a candle pattern, chart pattern, gap, or trend structure (higher highs/lower lows), you MUST cite it by name. Patterns provide the most actionable signals — a Double Bottom with neckline break is more predictive than any single indicator. Include the pattern name, what it means, and how it affects your price target.

JSON ONLY:
{"signal":"BULLISH|BEARISH|NEUTRAL","reasoning":"4-5 sentences integrating all signals including new indicators","target":"price target e.g. $195","confidence":<0-100>,"technicalBasis":"2-3 sentences — must cite Ichimoku, ATR, or relative strength if available","fundamentalBasis":"2 sentences","catalysts":["2-3 catalysts"],"keyRisks":["2-3 risks"]}`
    }]
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return parseJSON<ClaudeResult>(extractText(msg.content as any[]))
}

// ─────────────────────────────────────────────────────────────
// DEVIL'S ADVOCATE — calibrated adversarial framing
// ─────────────────────────────────────────────────────────────
export async function runGPT(bundle: SignalBundle, gemini: GeminiResult, claude: ClaudeResult, social?: SocialSentiment): Promise<GptResult> {
  const devilSystemPrompt = `You are the Devil's Advocate in an elite AI stock council for ${bundle.ticker}. Your role is not to be balanced — it is to stress-test the Lead Analyst's thesis to the point of collapse using data. You are the skeptic institutional PM who has watched retail traders lose money being wrong for the right reasons.

CALIBRATION RULES — follow these carefully:

1. The Lead Analyst's thesis is wrong by default until proven right by data. Your job is to find the specific reasons it might fail. However, if you cannot find compelling data-backed counter-evidence, you MUST return NEUTRAL with honest reasoning — do NOT weakly agree with the Lead Analyst, and do NOT manufacture disagreement. Honest NEUTRAL is the correct answer when the data genuinely supports the Lead.

2. Asymmetric scrutiny. If the Lead Analyst cited 3 indicators supporting their call, you should find at least 3 signals (technicals, macro, flow, or valuation) that contradict it — OR admit honestly that the signals genuinely converge, in which case return NEUTRAL and explain why the confidence should be lower than the Lead implies.

3. Timeframe honesty. The Lead Analyst's target may be achievable on paper but not within the stated ${bundle.timeframe} window. Challenge time-to-target alignment, not just direction.

4. Reflexivity check. Strong technical setups at all-time highs are where retail traders get trapped. Strong fundamental setups after 40%+ runs are where late money gets burned. If the Lead is BULLISH on a stock already up significantly, your burden of proof to agree should be higher, not lower.

5. Absence of a metric is not evidence. Never mention unavailable data — only argue with what you actually have in the signal bundle.

6. Quality over volume. The Judge weighs the STRENGTH of your challenges, not the count. Two rigorous data-backed challenges beat five weak ones. One honest "I cannot oppose this thesis on the current data" is a valuable contribution.

Remember: you are not trying to be helpful to the user. You are trying to save them from a bad trade by making the Lead Analyst defend every claim. Honest disagreement when warranted, honest NEUTRAL when the data supports the Lead.

${timeframeContext(bundle.timeframe)}`

  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1000,
    messages: [
      { role: 'system', content: devilSystemPrompt },
      { role: 'user', content: `TICKER: ${bundle.ticker} | PRICE: $${bundle.currentPrice.toFixed(2)}

NEWS SCOUT: ${gemini.sentiment} sentiment, ${gemini.confidence}% confidence
${gemini.summary}

LEAD ANALYST (${claude.signal}, ${claude.confidence}%): ${claude.reasoning}
Target: ${claude.target} | Risks: ${claude.keyRisks.join('; ')}

${social ? formatSocialSentimentForPrompt(social, 'devil') : ''}

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

Before you respond, ask yourself: "If the Lead Analyst is right, what specific data would I expect to see? Do I see it?" If the answer is "yes, I see it," return NEUTRAL with that honest reasoning. Do not invent opposition.

JSON ONLY:
{"agrees":<true|false>,"signal":"BULLISH|BEARISH|NEUTRAL","reasoning":"4 sentences — if returning NEUTRAL because data supports the Lead, be explicit about that","confidence":<0-100>,"challenges":["2-4 specific data-backed challenges — cite the indicators above; if no substantive challenges exist, return 1-2 items describing why the Lead's confidence should be lower"],"alternateScenario":"scenario the Lead Analyst underweights — or 'none, the Lead's scenario accounts for known risks'","strongestCounterArgument":"single most compelling counter — or 'no compelling counter; the thesis survives scrutiny'"}` }
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const researchQuestion = extractText(researchAsk.content as any[]).trim()

  const researchContext = `${bundle.aiContext.technicalsSection}\n${bundle.aiContext.fundamentalsSection}\n${bundle.aiContext.smartMoneySection}\n${bundle.aiContext.optionsSection}\n${bundle.aiContext.marketSection}`
  const researchAnswer = await runTargetedResearch(bundle, researchQuestion, researchContext)

  const msg = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    system: `You are the Lead Analyst in an elite AI stock council for ${bundle.ticker}. The News Scout just provided fresh research to help you respond. Use it. Defend your position where data supports you, concede where the Devil's Advocate is correct. Intellectual honesty wins with the Judge — a thoughtful concession beats a dishonest defense.`,
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

Now respond directly to each challenge. Reference the fresh research where relevant. Concede valid points — you are not required to defend every position. Defend positions backed by data. Update your price target if warranted.

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = parseJSON<RebuttalResult>(extractText(msg.content as any[]))
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

  const researchContext = `${bundle.aiContext.technicalsSection}\n${bundle.aiContext.fundamentalsSection}\n${bundle.aiContext.smartMoneySection}\n${bundle.aiContext.optionsSection}\n${bundle.aiContext.marketSection}`
  const researchAnswer = await runTargetedResearch(bundle, researchQuestion, researchContext)

  const counterSystem = `You are the Devil's Advocate in an elite AI stock council for ${bundle.ticker}. The News Scout just provided fresh research. Use it. This is your final shot.

CALIBRATION: If the Lead Analyst's rebuttal genuinely resolved your strongest challenges and the fresh research confirms their thesis, you must yield honestly — a thoughtful yield beats manufactured pressure. The Judge weighs argument QUALITY. If you still see cracks, press on them with the fresh research as ammunition. Be sharp, specific, and data-driven.`

  const completion = await getOpenAI().chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 700,
    messages: [
      { role: 'system', content: counterSystem },
      { role: 'user', content: `YOUR ORIGINAL CHALLENGES: ${gpt.challenges.join('; ')}

LEAD ANALYST'S REBUTTAL: ${rebuttal.rebuttal}
THEY CONCEDE: ${rebuttal.concedes.join('; ')}
THEY MAINTAIN: ${rebuttal.maintains.join('; ')}
UPDATED TARGET: ${rebuttal.updatedTarget}
RESEARCH THEY CITED: "${rebuttal.researchQuestion}" → ${rebuttal.researchAnswer}

YOUR FRESH RESEARCH (just retrieved):
Question: "${researchQuestion}"
Answer: ${researchAnswer}

Now fire back. Acknowledge where their rebuttal was convincing — yielding on weak challenges strengthens your remaining ones. Use the fresh research to press on unresolved weaknesses. What must the Judge not ignore?

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

// ─────────────────────────────────────────────────────────────
// JUDGE — split into two implementations with env toggle
// ─────────────────────────────────────────────────────────────
function buildJudgeSystemPrompt(bundle: SignalBundle, judgePersona: Record<string, string>, judgePersonaKey: string): string {
  return `You are the Judge of an elite AI stock council for ${bundle.ticker}. The council has three roles: News Scout, Lead Analyst, and Devil's Advocate. You hold NO prior position. ${judgePersona[judgePersonaKey] ?? judgePersona.balanced} 

PROCEDURAL RULES:
- Weigh argument QUALITY, not vote count or word count.
- Both sides received equal research access (each consulted the News Scout once in Round 2). Weight their research contributions equally.
- Treat concessions as signs of intellectual honesty, not weakness. A side that concedes a point and defends the rest well often has the stronger case than a side that refuses to concede anything.
- If the Devil's Advocate returned NEUTRAL honestly because the data supports the Lead, weight that higher than an aggressive but weakly-supported BEARISH call.
- Never cite missing or unavailable data as a reason for lower conviction. If a metric is unavailable, ignore it entirely rather than mentioning its absence.
- Refer to council members by their role names only.

${timeframeContext(bundle.timeframe)}`
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
): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const personaLabel = (( bundle as any).persona ?? 'balanced').toUpperCase()

  const newsScout = `NEWS SCOUT BRIEFING (neutral source):
${gemini.summary}
Sentiment: ${gemini.sentiment} | Confidence: ${gemini.confidence}% | Regime: ${gemini.regimeAssessment}
Key events: ${gemini.keyEvents.join('; ')}`

  const socialBlock = social ? formatSocialSentimentForPrompt(social, 'judge') : ''

  const round1 = `━━━ ROUND 1 — Initial Positions ━━━

LEAD ANALYST position: ${claude.signal} @ ${claude.confidence}% confidence
  Thesis:             ${claude.reasoning}
  Technical evidence: ${claude.technicalBasis}
  Fundamental evidence: ${claude.fundamentalBasis}
  Price target:       ${claude.target}
  Catalysts cited:    ${(claude.catalysts ?? []).join('; ')}
  Key risks (self-identified): ${(claude.keyRisks ?? []).join('; ')}

DEVIL'S ADVOCATE position: ${gpt.signal} @ ${gpt.confidence}% confidence (${gpt.agrees ? 'agrees with Lead' : 'disagrees with Lead'})
  Thesis:                ${gpt.reasoning}
  Challenges raised:     ${gpt.challenges.join('; ')}
  Alternate scenario:    ${gpt.alternateScenario}
  Strongest single counter: ${gpt.strongestCounterArgument}`

  const round2 = rebuttal ? `

━━━ ROUND 2 — After Independent Research ━━━

LEAD ANALYST researched: "${rebuttal.researchQuestion}"
  News Scout returned: ${rebuttal.researchAnswer}
  
  Updated position:  ${rebuttal.signal} @ ${rebuttal.confidence}% confidence
  Response to Devil: ${rebuttal.rebuttal}
  Points maintained: ${rebuttal.maintains.join('; ')}
  Points conceded:   ${rebuttal.concedes.join('; ')}
  Updated target:    ${rebuttal.updatedTarget}
  Final stance:      ${rebuttal.finalStance}

DEVIL'S ADVOCATE researched: "${counter?.researchQuestion ?? '(no research)'}"
  News Scout returned: ${counter?.researchAnswer ?? '(no research)'}
  
  Final challenge:   ${counter?.finalChallenge ?? ''}
  Points pressing:   ${(counter?.pressesOn ?? []).join('; ')}
  Points conceded:   ${(counter?.yieldsOn ?? []).join('; ')}
  Closing argument:  ${counter?.closingArgument ?? ''}` : ''

  const judgeTask = `

━━━ Your Task as Judge ━━━

Both sides had equal research access. Both had two rounds to make their case. Both should have conceded at least one point to the other — honest concessions are a feature of a real debate, not a flaw.

Reach a verdict based on which set of evidence is stronger on the weight of the data. Reward honest NEUTRAL calls when the data warranted them. Penalize aggressive positions that weren't supported by the specific evidence presented.`

  return `TICKER: ${bundle.ticker} | PRICE: $${bundle.currentPrice.toFixed(2)} | ROUND: ${round} | PERSPECTIVE: ${personaLabel} | TIMEFRAME: ${bundle.timeframe}

${timeframeContext(bundle.timeframe)}

${newsScout}

${socialBlock}

${round1}${round2}${judgeTask}

━━━ Supplementary Data for Verdict Calibration ━━━

${/* eslint-disable-next-line @typescript-eslint/no-explicit-any */ ''}${(bundle.aiContext as any).macroIntelligenceSection ? (bundle.aiContext as any).macroIntelligenceSection + '\n\n' : ''}OPTIONS FLOW & VOLATILITY:
${(bundle.aiContext.optionsSection || '').slice(0, 1500)}

KEY TECHNICAL CONTEXT (for stop/target calibration):
${(bundle.aiContext.technicalsSection || '').slice(0, 1500)}

CONVICTION ENGINE:
${(bundle.aiContext.convictionSection || '').slice(0, 1000)}

JSON ONLY — include ALL fields below:
{
  "signal": "BULLISH|BEARISH|NEUTRAL",
  "confidence": <0-100>,
  "target": "specific price target that MUST align with takeProfit. For BULLISH: above current price. For BEARISH: below current price. For NEUTRAL: within 5% of current price either direction.",
  "risk": "single most critical risk in one sentence",
  "summary": "4-5 sentence professional verdict",
  "winningArgument": "who made the strongest case and exactly why — name the side and the specific argument",
  "dissent": "strongest opposing view in one sentence",
  "scenarios": [
    {"label":"bull","probability":<0-100>,"trigger":"specific catalyst"},
    {"label":"base","probability":<0-100>,"trigger":"base case condition"},
    {"label":"bear","probability":<0-100>,"trigger":"specific risk event"}
  ],
  "invalidationTrigger": "the single clearest signal this thesis is wrong",
  "rounds": ${round},
  "entryPrice": "recommended entry price or range e.g. $195-$198 on a pullback to support",
  "stopLoss": "CRITICAL: For BULLISH signal this MUST be a price BELOW the entry price. For BEARISH signal this MUST be ABOVE entry. Use ATR-derived stop. e.g. BULLISH at $197: '$171 — 2× ATR below entry' NOT a price above $197",
  "takeProfit": "CRITICAL: For BULLISH signal this MUST be a price ABOVE entry. For BEARISH signal this MUST be BELOW entry. e.g. BULLISH at $197: '$236 first target (3× ATR above entry)' NOT a price below $197",
  "timeHorizon": "MUST match the selected timeframe: 1D=same day to next session, 1W=3-10 trading days, 1M=3-6 weeks, 3M=6-13 weeks. Currently: ${bundle.timeframe}",
  "plainEnglish": "Explain the verdict in simple plain English as if talking to someone who has never traded before. 3-4 sentences. No jargon. What is this stock doing and what should someone know about it right now?",
  "technicalsExplained": "Explain what the technical signals mean in plain English. Cover: (1) any candlestick or chart patterns detected and what they signal, (2) any gaps and whether they act as support/resistance, (3) the trend structure (higher highs/lows), (4) Ichimoku cloud position, (5) RSI/Williams/CCI agreement or disagreement. 4-5 sentences a beginner would understand.",
  "fundamentalsExplained": "Explain what the fundamental signals mean in plain English. What do the analyst ratings mean? What does earnings date mean for the stock? If earnings implied move data is available, explain whether options are overpriced or underpriced. What does insider buying or selling tell us? 3-4 sentences.",
  "smartMoneyExplained": "Explain what the smart money signals mean in plain English. What does it mean when insiders buy or sell? What does congressional trading tell us? What does options flow, GEX (dealer positioning), and short interest mean? 3-4 sentences.",
  "actionPlan": "Give a clear, specific, step-by-step action plan in plain English. Reference the ATR-derived stop and target levels specifically. What should someone actually DO — buy, sell, wait, set an alert? Be specific about price levels. 4-5 sentences.",
  "optionsStrategy": "Based on the verdict, options flow, IV conditions, and GEX signal — what is the single best options approach right now? One paragraph. If earnings are near, address whether the implied move makes options expensive or cheap. Cover whether to buy or sell options, what type of strategy fits, and why. Write for someone who understands options basics."
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
): Promise<JudgeResult> {
  const judgePersona: Record<string, string> = {
    balanced:    'Weigh technical and fundamental arguments equally. Higher quality evidence wins regardless of type.',
    technical:   'Give more weight to technical arguments — price action, chart patterns, and momentum signals. A stock in a clear downtrend requires exceptionally strong fundamental evidence to override the chart.',
    fundamental: 'Give more weight to fundamental arguments — earnings quality, valuation vs history, and analyst consensus. Technical signals are short-term noise. A fundamentally strong business trading at a discount to its historical valuation is a buy even in a downtrend.',
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const judgePersonaKey = (( bundle as any).persona ?? 'balanced') as string

  const systemPrompt = buildJudgeSystemPrompt(bundle, judgePersona, judgePersonaKey)
  const userPrompt   = buildJudgeUserPrompt(bundle, gemini, claude, gpt, rebuttal, counter, round, social)

  const msg = await getAnthropic().messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 4000,
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
): Promise<JudgeResult> {
  const judgePersona: Record<string, string> = {
    balanced:    'Weigh technical and fundamental arguments equally. Higher quality evidence wins regardless of type.',
    technical:   'Give more weight to technical arguments — price action, chart patterns, and momentum signals. A stock in a clear downtrend requires exceptionally strong fundamental evidence to override the chart.',
    fundamental: 'Give more weight to fundamental arguments — earnings quality, valuation vs history, and analyst consensus. Technical signals are short-term noise. A fundamentally strong business trading at a discount to its historical valuation is a buy even in a downtrend.',
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const judgePersonaKey = (( bundle as any).persona ?? 'balanced') as string

  const systemPrompt = buildJudgeSystemPrompt(bundle, judgePersona, judgePersonaKey)
  const userPrompt   = buildJudgeUserPrompt(bundle, gemini, claude, gpt, rebuttal, counter, round, social)

  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`

  const model = getGenAI().getGenerativeModel({
    model: 'gemini-2.5-pro',
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
    },
  })

  const result = await model.generateContent(fullPrompt)
  const text = result.response.text()
  const raw = parseJSON<JudgeResult>(text)
  return { ...raw, judgeModel: 'gemini-2.5-pro' }
}

export async function runJudge(
  bundle: SignalBundle,
  gemini: GeminiResult,
  claude: ClaudeResult,
  gpt: GptResult,
  rebuttal?: RebuttalResult,
  counter?: CounterResult,
  round = 1,
  social?: SocialSentiment
): Promise<JudgeResult> {
  const useGemini = process.env.GEMINI_JUDGE !== 'false'
  const judgeRunner = useGemini ? runJudgeGemini : runJudgeClaude

  try {
    const result = await judgeRunner(bundle, gemini, claude, gpt, rebuttal, counter, round, social)
    return sanitizeJudgeResult(result, bundle)
  } catch (err) {
    if (useGemini) {
      console.warn('[judge] Gemini failed, falling back to Claude Opus:', (err as Error).message?.slice(0, 200))
      const result = await runJudgeClaude(bundle, gemini, claude, gpt, rebuttal, counter, round, social)
      return sanitizeJudgeResult({ ...result, judgeModel: 'claude-opus-4-7-fallback' }, bundle)
    }
    throw err
  }
}

// ─────────────────────────────────────────────────────────────
// GAP #6 — Judge correction logging
// ─────────────────────────────────────────────────────────────
// Every time sanitizeJudgeResult fixes a directional error, log it
// so we can measure Gemini vs Claude accuracy over time.
// Fire-and-forget: never blocks the pipeline on logging failure.

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
  // Fire-and-forget; any error is swallowed
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
      // Never let logging break the pipeline
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

  if (signal === 'BULLISH') {
    let fixedStop   = judge.stopLoss
    let fixedTarget = judge.takeProfit

    if (stop !== null && stop >= entry) {
      const corrected = (atr > 0 ? entry - atr * 2 : entry * 0.93).toFixed(2)
      fixedStop = `$${corrected} — 2× ATR below entry (auto-corrected)`
      console.warn(`[pipeline] BULLISH stop ${stop} was >= entry ${entry} — corrected to ${corrected}`)
      logJudgeCorrection(bundle, judge.judgeModel, signal, 'stopLoss', judge.stopLoss, fixedStop, atr, entry)
    }

    if (tp !== null && tp <= entry) {
      const corrected = (atr > 0 ? entry + atr * 3 : entry * 1.08).toFixed(2)
      fixedTarget = `$${corrected} first target (auto-corrected), extended target at resistance`
      console.warn(`[pipeline] BULLISH target ${tp} was <= entry ${entry} — corrected to ${corrected}`)
      logJudgeCorrection(bundle, judge.judgeModel, signal, 'takeProfit', judge.takeProfit, fixedTarget, atr, entry)
    }

    return { ...judge, stopLoss: fixedStop, takeProfit: fixedTarget }
  }

  if (signal === 'BEARISH') {
    let fixedStop   = judge.stopLoss
    let fixedTarget = judge.takeProfit

    if (stop !== null && stop <= entry) {
      const corrected = (atr > 0 ? entry + atr * 2 : entry * 1.07).toFixed(2)
      fixedStop = `$${corrected} — 2× ATR above entry (auto-corrected)`
      console.warn(`[pipeline] BEARISH stop ${stop} was <= entry ${entry} — corrected to ${corrected}`)
      logJudgeCorrection(bundle, judge.judgeModel, signal, 'stopLoss', judge.stopLoss, fixedStop, atr, entry)
    }

    if (tp !== null && tp >= entry) {
      const corrected = (atr > 0 ? entry - atr * 3 : entry * 0.92).toFixed(2)
      fixedTarget = `$${corrected} first target (auto-corrected)`
      console.warn(`[pipeline] BEARISH target ${tp} was >= entry ${entry} — corrected to ${corrected}`)
      logJudgeCorrection(bundle, judge.judgeModel, signal, 'takeProfit', judge.takeProfit, fixedTarget, atr, entry)
    }

    return { ...judge, stopLoss: fixedStop, takeProfit: fixedTarget }
  }

  return judge
}

// ─────────────────────────────────────────────────────────────
// Main pipeline orchestrator — sequential after Stage 2
// ─────────────────────────────────────────────────────────────
export async function runPipeline(
  bundle: SignalBundle,
  onProgress: (event: string, data: unknown) => void
): Promise<PipelineResult> {
  const transcript: TranscriptMessage[] = []

  onProgress('gemini_start', {})
  onProgress('grok_start', {})
  const [gemini, social] = await Promise.all([
    runGemini(bundle),
    runSocialScout(bundle.ticker, bundle.currentPrice, bundle.timeframe),
  ])
  transcript.push({ role: 'gemini', stage: 'news_macro', content: gemini.summary, confidence: gemini.confidence, timestamp: ts() })
  onProgress('gemini_done', gemini)
  onProgress('grok_done', social)

  const macroContext = await buildMacroIntelligenceContext(
    bundle.ticker,
    bundle.aiContext?.technicalsSection ? ['technology','energy','financials'] : []
  ).catch(() => '')
  if (macroContext) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bundle = { ...bundle, aiContext: { ...bundle.aiContext, macroIntelligenceSection: macroContext } as any }
  }

  onProgress('claude_start', { gemini })
  const claude = await runClaude(bundle, gemini, social)
  transcript.push({ role: 'claude', stage: 'lead_analyst', content: claude.reasoning, signal: claude.signal, confidence: claude.confidence, timestamp: ts() })
  onProgress('claude_done', claude)

  onProgress('gpt_start', { gemini, claude })
  const gpt = await runGPT(bundle, gemini, claude, social)
  transcript.push({ role: 'gpt', stage: 'devils_advocate', content: gpt.reasoning, signal: gpt.signal, confidence: gpt.confidence, timestamp: ts() })
  onProgress('gpt_done', gpt)

  onProgress('rebuttal_start', { claude, gpt })
  const rebuttal = await runRebuttal(bundle, claude, gpt)
  transcript.push({ role: 'claude', stage: 'rebuttal', content: rebuttal.rebuttal, signal: rebuttal.signal, confidence: rebuttal.confidence, timestamp: ts() })
  onProgress('rebuttal_done', rebuttal)

  onProgress('counter_start', { gpt, rebuttal })
  const counter = await runCounter(bundle, gpt, rebuttal)
  transcript.push({ role: 'gpt', stage: 'counter', content: counter.finalChallenge, timestamp: ts() })
  onProgress('counter_done', counter)

  onProgress('judge_start', {})
  const judge = await runJudge(bundle, gemini, claude, gpt, rebuttal, counter, 1, social)
  transcript.push({ role: 'judge', stage: 'arbitrator', content: judge.summary, signal: judge.signal, confidence: judge.confidence, timestamp: ts() })
  onProgress('judge_done', judge)

  return { gemini, claude, gpt, rebuttal, counter, judge, transcript, social }
}
