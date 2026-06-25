// =============================================================
// app/lib/active-stories-futures-classifier.ts
//
// Active Stories — INDEX-FUTURES / MACRO classifier. The futures-desk
// counterpart to the stock and forex classifiers. It produces the ES/NQ-style
// macro narratives the single-stock classifier doesn't: US equity-index
// direction, rates, volatility, and the dollar.
//
// EXECUTION REALITY: the CME futures broker (Tradovate) is unfunded, so literal
// ES/NQ contracts can't trade today. We therefore express each index-futures
// view through its tradeable ETF proxy on Alpaca (the same proxy map FUTURES_SPECS
// already uses): ES→SPY, NQ→QQQ, RTY→IWM, YM→DIA, VIX→VIXY, rates→TLT/IEF,
// dollar→UUP. Stories are tagged assetType='futures' (their own desk/tab) but
// carry a tradeable equity ticker, so the existing stock execution path trades
// them on the funded account. When a futures account is funded later, execution
// can switch to real contracts without changing the story layer.
// =============================================================

import Anthropic from '@anthropic-ai/sdk'
import type { MarketRegime } from '@/app/lib/market-regime'
import type {
  Magnitude,
  Signal,
  RiskLevel,
  SessionAnchor,
  Timeframe,
  TrackedStory,
} from '@/app/lib/types/active-stories'
import type { LLMClassificationOutput } from '@/app/lib/types/active-stories'

const VALID_SIGNALS: Signal[] = ['BULLISH', 'BEARISH', 'NEUTRAL']
const VALID_MAGNITUDES: Magnitude[] = ['high', 'medium', 'low']
const VALID_RISKS: RiskLevel[] = ['high', 'medium', 'low']
const VALID_TIMEFRAMES: Timeframe[] = ['1D', '1W', '1M', '3M']
const VALID_SESSIONS: SessionAnchor[] = ['today', 'tomorrow', 'weekend']

// The tradeable macro complex — equity index, rates, vol, dollar. Each is the
// ETF proxy for an index-futures view, and each is Alpaca-tradeable TODAY.
// Metals/energy intentionally live on the forex/macro desk, not here.
export const TRACKED_FUTURES_PROXIES = [
  'SPY', 'QQQ', 'IWM', 'DIA',   // equity index (ES, NQ, RTY, YM)
  'VIXY',                       // volatility (VX)
  'TLT', 'IEF',                 // rates (ZB/ZN — long & 10Y)
  'UUP',                        // US dollar (DX/6E etc.)
] as const
const TRACKED_FUTURES_SET = new Set<string>(TRACKED_FUTURES_PROXIES as readonly string[])

// Map proxy → the index-futures it represents, used to frame the prompt.
const PROXY_TO_FUTURE: Record<string, string> = {
  SPY: 'ES (S&P 500)', QQQ: 'NQ (Nasdaq-100)', IWM: 'RTY (Russell 2000)', DIA: 'YM (Dow)',
  VIXY: 'VX (VIX volatility)', TLT: 'ZB (30Y Treasury)', IEF: 'ZN (10Y Treasury)', UUP: 'DX (US Dollar Index)',
}

export function filterActiveStoriesFutures(stories: TrackedStory[]): TrackedStory[] {
  return stories.filter(s => (s.assetType as string) === 'futures')
}

function formatActiveStoriesBlock(stories: TrackedStory[]): string {
  if (stories.length === 0) return '(none — fresh desk)'
  return stories.map(s => {
    const future = PROXY_TO_FUTURE[s.ticker] ?? s.ticker
    return `  [${s.id}] ${s.ticker} (${future}) — ${s.signal} ${s.confidence}% — ${s.catalyst ?? s.reason ?? ''}`.slice(0, 300)
  }).join('\n')
}

function buildSystemPrompt(): string {
  return `You run the INDEX-FUTURES / MACRO desk of an Active Stories tracking system. You cover US equity-index direction, interest rates, volatility, and the dollar — the macro layer ABOVE single stocks. You see (1) the macro stories already tracked, (2) fresh news, (3) the market regime.

You trade these views through liquid ETF proxies (this is the ONLY tradeable universe — emit one of these as "ticker"):
  SPY = ES / S&P 500 futures      QQQ = NQ / Nasdaq-100 futures
  IWM = RTY / Russell 2000        DIA = YM / Dow futures
  VIXY = VX / VIX volatility      TLT = 30Y Treasury (rates)
  IEF = 10Y Treasury (rates)      UUP = US Dollar Index

CORE PRINCIPLES:

1. MACRO, NOT SINGLE STOCKS. Your stories are index/rates/vol/dollar level. A NVDA-specific catalyst is NOT your desk; "mega-cap tech leadership dragging NQ/QQQ higher into CPI" IS. Frame catalysts in index-futures terms (ES gap, NQ leadership/breadth, 10Y yield repricing, VIX term structure, DXY breakout), even though the tradeable ticker is the ETF.

2. NEW STORIES NEED A REAL MACRO CATALYST: a scheduled macro print (FOMC, CPI, PPI, NFP/jobs, GDP, PCE), a Fed-speak/policy shift, a rates or curve move, a volatility regime change, a dollar breakout, or a decisive index technical event (range break, failed breakout, breadth thrust). Confidence ≥ 60. Do not manufacture a story from a quiet tape.

3. CONTINUITY. If fresh news extends a tracked macro story, UPDATE it (append a note, shift signal/confidence only if the read changed) rather than duplicating.

4. RESOLVE when the catalyst has passed (the print landed, the Fed decision is out, the move played out) or the thesis is stale. Always give a one-sentence resolutionReason.

5. PLAYING_OUT: if the catalyst is unfolding right now (FOMC statement crossing, CPI just printed), markPlayingOut=true rather than resolved.

6. SIGNAL = direction of the INDEX/INSTRUMENT the ETF tracks. BULLISH SPY = expecting S&P up. BULLISH VIXY = expecting volatility UP (risk-off). BULLISH TLT = expecting long rates DOWN (bonds up). BULLISH UUP = dollar UP. Be careful with the inversion on TLT/IEF (price up = yields down) and state it in the reason.

7. TIMEFRAMES (thesis duration) and SESSION ANCHORS (when the catalyst hits) are orthogonal: timeframes ['1D'|'1W'|'1M'|'3M']; sessionAnchor 'today'|'tomorrow'|'weekend'. A CPI print tomorrow pre-market → sessionAnchor='tomorrow'. An FOMC decision next week → the day it lands.

8. REGIME-AWARE. A bullish index setup in a risk-off regime fades; size confidence accordingly.

9. MAGNITUDE: high = expecting 1.5%+ index move (or a sharp vol/rates move), medium = 0.7-1.5%, low = <0.7%. Index moves are smaller than single-stock moves — calibrate.

10. CONFIDENCE FLOOR 60. Quality over volume: 2-6 macro stories on a busy macro day is healthy; on a quiet day return few or none. Never manufacture.

11. STRICT JSON. No markdown fences, no preamble, no text outside the JSON. Plain numbers (no $, no commas). Your ENTIRE response is ONE JSON object; emit nothing after the final closing brace.`
}

function buildUserPrompt(params: {
  runId: number
  triggerSource: string
  regime: MarketRegime
  activeStories: TrackedStory[]
  newsBlock: string
  cotContext?: string | null
  now?: Date
}): string {
  const now = params.now ?? new Date()
  return `RUN CONTEXT
  runId: ${params.runId}
  triggerSource: ${params.triggerSource}
  now: ${now.toISOString()}
  marketRegime: ${params.regime.regime} — ${params.regime.contextParagraph ?? ''}

TRACKED MACRO STORIES (update or resolve these; do not duplicate):
${formatActiveStoriesBlock(params.activeStories)}

FRESH NEWS (read for the INDEX/RATES/VOL/DOLLAR angle — ignore single-stock-only items unless they move the index):
${params.newsBlock || '(no news)'}

${params.cotContext ? `CFTC COT POSITIONING (large-spec net on index/rates futures):\n${params.cotContext}\n` : ''}
TASK:
  STEP 1 — UPDATE/RESOLVE tracked macro stories from the fresh news.
  STEP 2 — Create NEW macro stories for fresh, actionable index/rates/vol/dollar catalysts (assetType='futures', ticker = one of the proxy ETFs above).

Return ONLY this JSON:
{
  "storyUpdates": [
    { "storyId": "uuid", "note": "what's new", "newSignal": "BULLISH|BEARISH|NEUTRAL (omit if unchanged)", "newConfidence": 72, "markPlayingOut": false, "markResolved": false, "resolutionReason": "required only if markResolved" }
  ],
  "newStories": [
    {
      "ticker": "SPY",
      "companyName": "S&P 500 (ES futures)",
      "assetType": "futures",
      "signal": "BULLISH",
      "confidence": 68,
      "magnitude": "medium",
      "timeframes": ["1D"],
      "sessionAnchor": "tomorrow",
      "catalyst": "CPI tomorrow 8:30 ET; ES futures holding range highs, soft print would confirm breakout",
      "reason": "A cooler CPI re-opens the cut path and pushes ES through resistance; risk is a hot print reversing the tape. Tradeable via SPY.",
      "headline": "Markets brace for tomorrow's CPI print",
      "riskLevel": "medium"
    }
  ],
  "marketTheme": "dominant macro theme this run",
  "marketStatus": "one sentence on macro/risk mood given the regime",
  "summary": "2-3 sentences on the macro picture and next-session catalysts"
}`
}

function validateOutput(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  activeStoryIds: Set<string>,
): LLMClassificationOutput {
  const out: LLMClassificationOutput = {
    storyUpdates: [],
    newStories: [],
    marketTheme: typeof raw?.marketTheme === 'string' ? raw.marketTheme : 'No clear macro theme',
    marketStatus: typeof raw?.marketStatus === 'string' ? raw.marketStatus : 'Quiet',
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
  }

  if (Array.isArray(raw?.storyUpdates)) {
    for (const u of raw.storyUpdates) {
      if (!u || typeof u !== 'object') continue
      if (typeof u.storyId !== 'string' || !activeStoryIds.has(u.storyId)) continue
      if (typeof u.note !== 'string' || u.note.length === 0) continue
      const cleaned: typeof out.storyUpdates[number] = { storyId: u.storyId, note: u.note }
      if (u.newSignal && VALID_SIGNALS.includes(u.newSignal as Signal)) cleaned.newSignal = u.newSignal as Signal
      if (typeof u.newConfidence === 'number' && u.newConfidence >= 60 && u.newConfidence <= 100) cleaned.newConfidence = Math.round(u.newConfidence)
      if (u.markPlayingOut === true) cleaned.markPlayingOut = true
      if (u.markResolved === true) {
        cleaned.markResolved = true
        cleaned.resolutionReason = typeof u.resolutionReason === 'string' ? u.resolutionReason : 'Resolved by classifier'
      }
      out.storyUpdates.push(cleaned)
    }
  }

  if (Array.isArray(raw?.newStories)) {
    for (const n of raw.newStories) {
      if (!n || typeof n !== 'object') continue
      if (typeof n.ticker !== 'string') continue
      const tickerUpper = n.ticker.toUpperCase().replace(/[^A-Z]/g, '')
      // Enforce the tradeable proxy universe.
      if (!TRACKED_FUTURES_SET.has(tickerUpper)) {
        console.warn(`[futures-classifier] dropping newStory for non-proxy ticker: ${n.ticker}`)
        continue
      }
      if (!VALID_SIGNALS.includes(n.signal as Signal)) continue
      if (typeof n.confidence !== 'number' || n.confidence < 60 || n.confidence > 100) continue
      if (!Array.isArray(n.timeframes)) continue
      const validTfs = (n.timeframes as unknown[]).filter((t): t is Timeframe => typeof t === 'string' && VALID_TIMEFRAMES.includes(t as Timeframe))
      if (validTfs.length === 0) continue
      if (!VALID_SESSIONS.includes(n.sessionAnchor as SessionAnchor)) continue

      const cleaned: typeof out.newStories[number] = {
        ticker: tickerUpper,
        signal: n.signal as Signal,
        confidence: Math.round(n.confidence),
        timeframes: validTfs,
        sessionAnchor: n.sessionAnchor as SessionAnchor,
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(cleaned as any).assetType = 'futures'
      if (typeof n.companyName === 'string') cleaned.companyName = n.companyName
      if (typeof n.magnitude === 'string' && VALID_MAGNITUDES.includes(n.magnitude as Magnitude)) cleaned.magnitude = n.magnitude as Magnitude
      if (typeof n.catalyst === 'string') cleaned.catalyst = n.catalyst
      if (typeof n.reason === 'string') cleaned.reason = n.reason
      if (typeof n.headline === 'string') cleaned.headline = n.headline
      if (typeof n.riskLevel === 'string' && VALID_RISKS.includes(n.riskLevel as RiskLevel)) cleaned.riskLevel = n.riskLevel as RiskLevel
      out.newStories.push(cleaned)
    }
  }

  return out
}

function parseJSON<T>(text: string): T {
  const clean = text.replace(/```json|```/g, '').trim()
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON object in response')
  return JSON.parse(clean.slice(start, end + 1)) as T
}

/** Best-effort CFTC COT positioning for the index/rates complex. */
export async function buildFuturesCotContext(): Promise<string | null> {
  // v1: COT positioning for the index/vol complex is not wired here yet; the
  // classifier renders fine without it. Wire app/lib/signals/futures-cot later.
  return null
}

export interface ClassifyFuturesParams {
  runId: number
  triggerSource: string
  regime: MarketRegime
  activeStories: TrackedStory[]
  newsBlock: string
  cotContext?: string | null
  now?: Date
}

export async function classifyFuturesActiveStories(params: ClassifyFuturesParams): Promise<LLMClassificationOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')
  const anthropic = new Anthropic({ apiKey })

  const system = buildSystemPrompt()
  const user = buildUserPrompt({
    runId: params.runId,
    triggerSource: params.triggerSource,
    regime: params.regime,
    activeStories: params.activeStories,
    newsBlock: params.newsBlock,
    cotContext: params.cotContext ?? null,
    now: params.now ?? new Date(),
  })

  // Sonar provider switch (live-web grounded), mirroring the forex classifier.
  if (process.env.ACTIVE_STORIES_PROVIDER === 'sonar' && process.env.PERPLEXITY_API_KEY) {
    try {
      const { searchWithSonar } = await import('./perplexity-helper')
      const r = await searchWithSonar({
        prompt: `${system}\n\n${user}`,
        caller: 'active-stories-futures:classify',
        maxOutputTokens: 4000,
        temperature: 0.2,
        useGoogleSearchGrounding: true,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sonarRaw = parseJSON<any>(r.text)
      console.log(`[active-stories-futures] classified via Perplexity Sonar (${r.modelUsed})`)
      return validateOutput(sonarRaw, new Set(params.activeStories.map(s => s.id)))
    } catch (e) {
      console.warn(`[active-stories-futures] Sonar classify failed, falling back to Claude: ${e instanceof Error ? e.message : e}`)
    }
  }

  const msg = await anthropic.messages.create({
    model: process.env.ANTHROPIC_SONNET_MODEL ?? 'claude-sonnet-4-6',
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: user }],
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (msg.content[0] as any)?.text as string
  if (!text) throw new Error('Empty response from Claude')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = parseJSON<any>(text)
  return validateOutput(raw, new Set(params.activeStories.map(s => s.id)))
}
