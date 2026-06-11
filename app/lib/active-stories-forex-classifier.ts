// =============================================================
// app/lib/active-stories-forex-classifier.ts
//
// Forex-specific Active Stories classifier (Phase 2 of forex
// Active Stories, Jun 2026).
//
// Separate from the equity classifier because forex stories have
// fundamentally different shape:
//   - No earnings, no analyst ratings, no 13F filings
//   - Catalysts are central bank decisions, macro data releases,
//     COT positioning shifts, technical breakouts
//   - Sessions matter differently (forex is 24/5 — London/NY/Asia)
//
// The classifier ONLY considers forex stories. Equity stories run
// in the original active-stories-classifier with its own cron.
// Both write to the same tracked_stories table, distinguished by
// asset_type='forex' vs 'stock'/'crypto'.
// =============================================================

import Anthropic from '@anthropic-ai/sdk'
import type { MarketRegime } from '@/app/lib/market-regime'
import type {
  TrackedStory,
  Signal,
  Magnitude,
  RiskLevel,
  Timeframe,
  SessionAnchor,
} from '@/app/lib/story-tracker'
import type { LLMClassificationOutput } from '@/app/lib/types/active-stories'

const VALID_SIGNALS: Signal[] = ['BULLISH', 'BEARISH', 'NEUTRAL']
const VALID_MAGNITUDES: Magnitude[] = ['high', 'medium', 'low']
const VALID_RISKS: RiskLevel[] = ['high', 'medium', 'low']
const VALID_TIMEFRAMES: Timeframe[] = ['1D', '1W', '1M', '3M']
const VALID_SESSIONS: SessionAnchor[] = ['today', 'tomorrow', 'weekend']

// The 7 major forex pairs we track. Can expand later if usage justifies.
// USD is the implicit other side of every pair; we don't track USD-only.
export const TRACKED_FOREX_PAIRS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD',
] as const

const TRACKED_FOREX_SET = new Set<string>(TRACKED_FOREX_PAIRS as readonly string[])

// ─────────────────────────────────────────────────────────────
// News filtering — narrow the equity-style news pipeline to
// forex-relevant headlines before passing to the classifier
// ─────────────────────────────────────────────────────────────

// Patterns that indicate a headline is forex-relevant:
//   - Currency codes (3-letter ISO) — must be word-bounded to avoid false
//     positives like "EURope" or "USDA" or "JPYears"
//   - Pair notation with slash or compact (EUR/USD, EURUSD)
//   - Central bank references (Fed, ECB, BoE, BoJ, BoC, RBA, FOMC)
//   - Macro indicator keywords
//   - Currency-market language
const FOREX_KEYWORD_PATTERNS = [
  /\b(?:EUR|USD|GBP|JPY|AUD|CAD|CHF|NZD|MXN|SEK|NOK)\b/i,
  /\b(?:EUR|USD|GBP|JPY|AUD|CAD|CHF|NZD)\/(?:EUR|USD|GBP|JPY|AUD|CAD|CHF|NZD)\b/i,
  /\b(?:EUR|GBP|AUD|NZD|USD)(?:USD|JPY|GBP|EUR|CAD|CHF|AUD|NZD)\b/i,
  /\b(?:FOMC|Federal Reserve|Fed Chair|Jerome Powell|Powell)\b/i,
  /\b(?:ECB|European Central Bank|Lagarde|Christine Lagarde)\b/i,
  /\b(?:Bank of England|BOE|Andrew Bailey)\b/i,
  /\b(?:Bank of Japan|BOJ|Kazuo Ueda|Ueda)\b/i,
  /\b(?:Bank of Canada|BOC|Tiff Macklem|Macklem)\b/i,
  /\b(?:Reserve Bank of Australia|RBA|Michele Bullock|Bullock)\b/i,
  /\b(?:non[-\s]?farm|NFP|jobs report|payrolls?)\b/i,
  /\b(?:CPI|inflation|PPI|GDP|retail sales|PMI)\b/i,
  /\b(?:forex|FX market|currency markets?|dollar index|DXY)\b/i,
  /\b(?:rate (?:decision|hike|cut|hold)|monetary policy)\b/i,
  /\bdollar (?:strengthens?|weakens?|rallies?|slides?|gains?|drops?)\b/i,
  /\b(?:euro|sterling|pound|yen|loonie|aussie|kiwi|franc) (?:strengthens?|weakens?|rallies?|slides?|gains?|drops?)\b/i,
]

/**
 * Filter the multi-source news block down to forex-relevant lines.
 * The equity classifier sees the full firehose; this classifier sees only
 * the forex slice. Returns the filtered text block.
 *
 * If filtering yields nothing, returns an explicit "no forex news" line
 * so the LLM doesn't manufacture stories from thin air.
 */
export function filterNewsForForex(newsBlock: string): string {
  const lines = newsBlock.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    // Keep section headers (lines starting with === or similar) so the
    // classifier still sees structure
    if (/^[=#\-]/.test(line)) { kept.push(line); continue }
    // Keep lines matching any forex pattern
    if (FOREX_KEYWORD_PATTERNS.some(re => re.test(line))) {
      kept.push(line)
    }
  }
  if (kept.length === 0 || kept.every(l => /^[=#\-]/.test(l))) {
    return '(No forex-relevant news in this run.)'
  }
  return kept.join('\n')
}

// ─────────────────────────────────────────────────────────────
// Story filtering — only forex stories matter to this classifier
// ─────────────────────────────────────────────────────────────

/**
 * Filter the active stories list to just forex-asset-type stories,
 * dropping equity/crypto stories that belong to the other classifier.
 */
export function filterActiveStoriesForex(stories: TrackedStory[]): TrackedStory[] {
  return stories.filter(s =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s.assetType as any) === 'forex' || TRACKED_FOREX_SET.has(s.ticker.toUpperCase())
  )
}

// ─────────────────────────────────────────────────────────────
// Prompt builders
// ─────────────────────────────────────────────────────────────

function formatActiveStoriesBlock(stories: TrackedStory[]): string {
  if (stories.length === 0) return '(no active forex stories — this is a fresh start for the forex tracker)'
  return stories.map(s => {
    const recentUpdates = (s.updates ?? []).slice(-2).map(u =>
      `       [run ${u.runId}] ${u.note}${u.signalChange ? ` [→${u.signalChange}]` : ''}${u.confidenceChange !== undefined ? ` [conf:${u.confidenceChange}]` : ''}`
    ).join('\n')
    const ageHours = ((Date.now() - new Date(s.firstSeen).getTime()) / 3_600_000).toFixed(1)
    return `  • ID ${s.id}
    Pair: ${s.ticker}
    Catalyst: ${s.catalyst}
    Signal: ${s.signal} · Confidence: ${s.confidence}% · Magnitude: ${s.magnitude}
    Timeframes: ${(s.timeframes ?? []).join(', ')} · Anchor: ${s.sessionAnchor}
    Age: ${ageHours}h · Status: ${s.status}${recentUpdates ? '\n    Recent updates:\n' + recentUpdates : ''}`
  }).join('\n')
}

function buildSystemPrompt(): string {
  return `You are a senior FX strategist running an Active Stories tracking system for the foreign exchange market. You see THREE inputs every run:
  (1) Forex stories already being tracked from prior runs (the "active stories" list)
  (2) Fresh forex-relevant news since the last run
  (3) Scheduled macro catalysts for the next sessions (central bank meetings, NFP/CPI/PPI/GDP/retail sales releases)

Your output has THREE parts:
  - storyUpdates: changes to existing forex stories
  - newStories: forex catalysts not yet tracked, classified for the first time
  - run metadata: marketTheme, marketStatus, summary

CORE PRINCIPLES — FOREX-SPECIFIC:

1. UNIVERSE. The forex universe you track:
   EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF, NZDUSD
   Do NOT create stories for other pairs, crypto, equity tickers, or commodities. If a headline relates to a non-tracked pair (e.g. USDCNH, USDMXN), skip it.

2. CATALYST CATEGORIES. Forex stories come from a different catalog than equity stories. The valid catalysts are:
   - Central bank rate decisions (FOMC, ECB, BoE, BoJ, BoC, RBA): scheduled events that pin price action
   - Central bank speeches / forward guidance: Powell at Jackson Hole, Lagarde testimony, etc.
   - Major macro data: NFP, CPI, PPI, GDP, retail sales, PMI surprises (both consensus-beat and consensus-miss)
   - Geopolitical events: trade announcements, sanctions, war/peace developments that move risk-on/risk-off
   - CFTC COT positioning extremes: when speculators are crowded long/short at multi-month extremes
   - Major technical breakouts: confirmed break of multi-month range high/low with volume
   - Cross-asset correlation breaks: e.g. risk-off equity selloff coinciding with unusual USD/JPY behavior

   Do NOT create forex stories for: equity earnings, company news, single-stock moves, analyst ratings, M&A — none of those directly drive forex pairs.

3. CONTINUITY MATTERS. If fresh news materially relates to an existing story, UPDATE that story rather than creating a duplicate. The same ECB meeting story should not be created twice across runs.

4. RESOLVE WHEN APPROPRIATE. Mark a story resolved when:
   - The central bank meeting / data release has happened and the move has played out
   - The technical pattern has either confirmed or broken
   - The catalyst has been overtaken by a larger one (e.g. ECB story resolved when FOMC takes over the narrative)
   - The story has gone quiet for 24+ hours with no follow-through
   ALWAYS provide a one-sentence resolutionReason when marking resolved.

5. PLAYING_OUT IS A REAL STATE. If the catalyst is unfolding RIGHT NOW (FOMC press conference live, NFP release just hit, central bank speech in progress), use markPlayingOut=true rather than markResolved.

6. NEW STORIES NEED CATALYSTS. Do not create stories for tickers merely mentioned in news without a specific actionable catalyst. "EUR/USD trading at 1.15" is not a story. "ECB meeting tomorrow, market split 50/50 on hold vs cut" IS a story.

7. CONFIDENCE FLOOR: 60. Both new stories AND signal/confidence changes on existing stories must clear 60% confidence.

8. TIMEFRAMES AND SESSION ANCHORS:
   - timeframes: ['1D'] | ['1W'] | ['1M'] | ['3M'] | combinations
       1D: catalyst plays out within hours/one session (CB decision day, NFP morning)
       1W: catalyst plays out over a few sessions (positioning unwind after CB meeting)
       1M: positioning shift / technical breakout developing over weeks
       3M: structural cycle theme (Fed easing cycle, BoJ normalization)
   - sessionAnchor: 'today' | 'tomorrow' | 'weekend'
       Forex is 24/5 — sessions are London (07:00-16:00 UTC), NY (12:00-21:00 UTC), Asia (23:00-08:00 UTC). The cron runs at session opens.

9. REGIME-AWARE CONFIDENCE. In risk-off regimes, safe-haven currencies (USD, JPY, CHF) tend to outperform. In risk-on regimes, AUD/NZD often lead. A bullish thesis on a risk currency in a risk-off market should carry LOWER confidence than the same thesis in a supportive regime.

10. POSITIONING IS A REAL FORCE. When CFTC COT data shows speculators heavily one-sided (>+20% net long or <-20% net short), the contrarian reversal risk is meaningfully elevated. Use this as a confidence modifier and explicit catalyst when it's present.

11. PRE-EVENT POSITIONING ≠ POST-EVENT DIRECTION. A "EURUSD bearish into ECB" story is different from "EURUSD bearish after ECB hawkish surprise reversed." Be precise about whether the story is positioning for an unresolved event or reacting to a resolved one.

12. CONCISE NOTES. When updating, the "note" field is the audit trail of what's new. 1-2 sentences. Specific. No generic re-stating.

13. MAGNITUDE: high = expecting >100 pips, medium = 50-100 pips, low = <50 pips. (Note: this is different from equity magnitude.)

14. STRICT JSON OUTPUT. No markdown fences, no preamble, no explanatory text outside JSON. Use plain numbers.

15. SCHEDULED CATALYSTS DRIVE TOMORROW STORIES. The "SCHEDULED CATALYSTS" block lists upcoming central bank meetings and macro data releases. When non-empty, create stories anchored to sessionAnchor='tomorrow' for notable scheduled events (HIGH-impact only — not every NFP component). 3-6 tomorrow stories total is a healthy run if the calendar is busy; if quiet, return zero — do NOT manufacture from thin air.

16. WEEKEND DETECTION. If "Now" is Saturday, Sunday, or Friday after 21:00 UTC (NY close), OR if the next major event is Monday, use sessionAnchor='weekend' for scheduled-catalyst stories.

17. ALL NEW STORIES MUST HAVE assetType='forex'. Do not return assetType='stock' or 'crypto' from this classifier. Pair tickers should be 6 uppercase letters (EURUSD, not eur/usd or EUR/USD).`
}

function buildUserPrompt(params: {
  runId: number
  triggerSource: string
  regime: MarketRegime
  activeStories: TrackedStory[]
  newsBlock: string
  scheduledCatalysts: string | null
  cotContext: string | null
  now: Date
}): string {
  const { runId, triggerSource, regime, activeStories, newsBlock, scheduledCatalysts, cotContext, now } = params
  const nowStr = now.toISOString()
  const day = nowStr.slice(0, 10)

  const catalystsBlock = scheduledCatalysts && scheduledCatalysts.trim().length > 0
    ? scheduledCatalysts
    : '(No notable scheduled macro catalysts for the next sessions. Do NOT create tomorrow/weekend stories this run.)'

  const cotBlock = cotContext && cotContext.trim().length > 0
    ? cotContext
    : '(No COT positioning context available this run.)'

  return `RUN CONTEXT
  Run ID: ${runId}
  Triggered by: ${triggerSource}
  Now: ${nowStr}
  Date: ${day}
  Forex universe tracked: EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF, NZDUSD

MARKET REGIME RIGHT NOW:
${regime.contextParagraph}

ACTIVE FOREX STORIES (currently tracked, ${activeStories.length} total):
${formatActiveStoriesBlock(activeStories)}

FRESH FOREX-RELEVANT NEWS HEADLINES (filtered from broader news pipeline):
${newsBlock}

SCHEDULED MACRO CATALYSTS (next trading sessions — central bank meetings, data releases):
${catalystsBlock}

CFTC COT POSITIONING SNAPSHOT (weekly speculative positioning by pair):
${cotBlock}

Now produce your classification. Walk through these steps in order:

  STEP 1 — REVIEW EXISTING FOREX STORIES. For each active forex story above:
    - Is fresh news relevant to it? If yes, write a storyUpdates entry.
    - Has the catalyst (CB meeting, data release, breakout) happened and played out? If yes, mark resolved with reason.
    - Is the catalyst unfolding right now? If yes, mark playingOut.
    - Has signal/confidence shifted (e.g. dovish ECB surprise reversed bullish EUR thesis)? Update both.
    - If unchanged, omit it from storyUpdates.

  STEP 2 — IDENTIFY TODAY-ANCHORED NEW STORIES from FRESH NEWS. From forex-relevant headlines, what catalysts AREN'T already covered? Common patterns:
    - "Powell signals dovish pivot at speech" → USD weakness story
    - "ECB hawkish surprise" → EURUSD bullish story
    - "BoJ holds rates, yen weakens" → USDJPY bullish story
    - "Risk-off selloff in equities" → USD/JPY/CHF strength story across pairs
    Each new story needs: clear catalyst, confidence ≥ 60, one or more timeframe tags, sessionAnchor.

  STEP 3 — IDENTIFY TOMORROW/WEEKEND NEW STORIES from SCHEDULED CATALYSTS. If the calendar block contains HIGH-impact events for the next sessions (FOMC, ECB, BoE, BoJ, BoC, RBA, NFP, CPI), create stories anchored to sessionAnchor='tomorrow' (or 'weekend' if next session is Monday). Tomorrow stories must reference the SCHEDULED nature: "ECB rate decision tomorrow, market pricing 60% hold; dovish surprise would push EURUSD below 1.14" — NOT "EURUSD weakened today."

  STEP 4 — CONSIDER COT POSITIONING. If the COT block shows positioning at extremes (>+20% of OI net long or <-20% net short), evaluate whether the existing technical/macro setup supports a contrarian story. Do NOT create COT-only stories — pair the positioning with another catalyst or skip.

  STEP 5 — PRODUCE METADATA. marketTheme = single dominant forex theme (e.g. "USD strength into FOMC", "EUR pressure ahead of ECB", "Risk-off USD/JPY squeeze"). marketStatus = one sentence on overall FX mood. summary = 2-3 sentences on most important takeaways including next-session catalysts.

OUTPUT JSON ONLY (no preamble, no markdown):
{
  "storyUpdates": [
    {
      "storyId": "uuid-of-existing-story",
      "note": "specific 1-2 sentence description of what's new this run",
      "newSignal": "BULLISH | BEARISH | NEUTRAL (omit if unchanged)",
      "newConfidence": 75,
      "markPlayingOut": false,
      "markResolved": false,
      "resolutionReason": "required only if markResolved=true"
    }
  ],
  "newStories": [
    {
      "ticker": "EURUSD",
      "companyName": "Euro / US Dollar",
      "assetType": "forex",
      "signal": "BEARISH",
      "confidence": 72,
      "magnitude": "medium",
      "timeframes": ["1D"],
      "sessionAnchor": "tomorrow",
      "catalyst": "ECB rate decision tomorrow, consensus 25bps hold but split market positioning suggests binary outcome risk",
      "reason": "ECB tomorrow is dominant catalyst — directional thesis must wait for outcome. Speculators are moderately net long EUR (+5.8% OI) creating asymmetric unwind risk if dovish surprise; conversely hawkish surprise would short-squeeze toward 1.17 resistance.",
      "headline": "ECB meeting tomorrow — markets brace for rate guidance",
      "riskLevel": "high"
    }
  ],
  "marketTheme": "single dominant forex theme this run",
  "marketStatus": "one sentence on overall forex market mood",
  "summary": "2-3 sentences on most important takeaways including next-session catalysts"
}`
}

// ─────────────────────────────────────────────────────────────
// Output validation
// ─────────────────────────────────────────────────────────────

function validateOutput(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  activeStoryIds: Set<string>,
): LLMClassificationOutput {
  const out: LLMClassificationOutput = {
    storyUpdates: [],
    newStories: [],
    marketTheme: typeof raw?.marketTheme === 'string' ? raw.marketTheme : 'No clear theme',
    marketStatus: typeof raw?.marketStatus === 'string' ? raw.marketStatus : 'Quiet',
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
  }

  // Validate storyUpdates
  if (Array.isArray(raw?.storyUpdates)) {
    for (const u of raw.storyUpdates) {
      if (!u || typeof u !== 'object') continue
      if (typeof u.storyId !== 'string' || !activeStoryIds.has(u.storyId)) {
        console.warn(`[forex-classifier] dropping storyUpdate with invalid storyId: ${u.storyId}`)
        continue
      }
      if (typeof u.note !== 'string' || u.note.length === 0) continue
      const cleaned: typeof out.storyUpdates[number] = { storyId: u.storyId, note: u.note }
      if (u.newSignal && VALID_SIGNALS.includes(u.newSignal as Signal)) {
        cleaned.newSignal = u.newSignal as Signal
      }
      if (typeof u.newConfidence === 'number' && u.newConfidence >= 60 && u.newConfidence <= 100) {
        cleaned.newConfidence = Math.round(u.newConfidence)
      }
      if (u.markPlayingOut === true) cleaned.markPlayingOut = true
      if (u.markResolved === true) {
        cleaned.markResolved = true
        cleaned.resolutionReason = typeof u.resolutionReason === 'string' ? u.resolutionReason : 'Resolved by classifier'
      }
      out.storyUpdates.push(cleaned)
    }
  }

  // Validate newStories
  if (Array.isArray(raw?.newStories)) {
    for (const n of raw.newStories) {
      if (!n || typeof n !== 'object') continue
      if (typeof n.ticker !== 'string') continue
      const tickerUpper = n.ticker.toUpperCase().replace(/[^A-Z]/g, '')

      // Enforce forex universe — drop anything not in TRACKED_FOREX_PAIRS
      if (!TRACKED_FOREX_SET.has(tickerUpper)) {
        console.warn(`[forex-classifier] dropping newStory for non-tracked ticker: ${n.ticker}`)
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
      // Force assetType to 'forex' for forex classifier output
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(cleaned as any).assetType = 'forex'
      if (typeof n.companyName === 'string') cleaned.companyName = n.companyName
      if (typeof n.magnitude === 'string' && VALID_MAGNITUDES.includes(n.magnitude as Magnitude)) {
        cleaned.magnitude = n.magnitude as Magnitude
      }
      if (typeof n.catalyst === 'string') cleaned.catalyst = n.catalyst
      if (typeof n.reason === 'string') cleaned.reason = n.reason
      if (typeof n.headline === 'string') cleaned.headline = n.headline
      if (typeof n.riskLevel === 'string' && VALID_RISKS.includes(n.riskLevel as RiskLevel)) {
        cleaned.riskLevel = n.riskLevel as RiskLevel
      }
      out.newStories.push(cleaned)
    }
  }

  return out
}

// ─────────────────────────────────────────────────────────────
// JSON parser
// ─────────────────────────────────────────────────────────────

function parseJSON<T>(text: string): T {
  let trimmed = text.trim()
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }
  return JSON.parse(trimmed) as T
}

// ─────────────────────────────────────────────────────────────
// COT context builder — pulls latest COT data for all tracked pairs
// ─────────────────────────────────────────────────────────────

/**
 * Build a compact COT context block for the classifier. Pulls positioning
 * data for all 7 tracked pairs and formats as a one-liner per pair.
 * Returns null if no COT data is available.
 */
export async function buildForexCotContext(): Promise<string | null> {
  try {
    const { fetchForexCot } = await import('@/app/lib/data/forex-cot')
    const pairs = TRACKED_FOREX_PAIRS
    const results = await Promise.all(
      pairs.map(async (pair) => {
        const cot = await fetchForexCot(pair).catch(() => null)
        if (!cot) return null
        const intensity =
          cot.nonCommNetPctOfOI > 20  ? 'STRONG LONG'  :
          cot.nonCommNetPctOfOI > 5   ? 'mod long'     :
          cot.nonCommNetPctOfOI > -5  ? 'neutral'      :
          cot.nonCommNetPctOfOI > -20 ? 'mod short'    :
                                         'STRONG SHORT'
        const wow = cot.nonCommNetChangeWoW !== null
          ? ` (WoW ${cot.nonCommNetChangeWoW > 0 ? '+' : ''}${cot.nonCommNetChangeWoW.toLocaleString()})`
          : ''
        return `  ${pair}: ${cot.nonCommNet > 0 ? '+' : ''}${cot.nonCommNet.toLocaleString()} contracts (${cot.nonCommNetPctOfOI > 0 ? '+' : ''}${cot.nonCommNetPctOfOI.toFixed(1)}% of OI) — ${intensity}${wow}`
      })
    )
    const lines = results.filter((s): s is string => s !== null)
    if (lines.length === 0) return null
    return `Latest CFTC COT positioning (report dated last Tuesday, released Friday):\n${lines.join('\n')}`
  } catch (e) {
    console.warn(`[forex-classifier] COT context build failed: ${(e as Error).message}`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export interface ClassifyForexParams {
  runId: number
  triggerSource: string
  regime: MarketRegime
  activeStories: TrackedStory[]
  newsBlock: string
  scheduledCatalysts?: string | null
  cotContext?: string | null
  now?: Date
}

/**
 * Run the forex classifier. Mirrors the equity classifyActiveStories
 * signature but with forex-only inputs.
 */
export async function classifyForexActiveStories(
  params: ClassifyForexParams,
): Promise<LLMClassificationOutput> {
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
    scheduledCatalysts: params.scheduledCatalysts ?? null,
    cotContext: params.cotContext ?? null,
    now: params.now ?? new Date(),
  })

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: user }],
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = (msg.content[0] as any)?.text as string
  if (!text) throw new Error('Empty response from Claude')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = parseJSON<any>(text)
  const activeIds = new Set(params.activeStories.map(s => s.id))
  return validateOutput(raw, activeIds)
}
