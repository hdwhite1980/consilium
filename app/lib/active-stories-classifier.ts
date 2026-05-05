// =============================================================
// app/lib/active-stories-classifier.ts
//
// The classifier prompt module — Phase 2 of Active Stories.
//
// Responsibility: take active stories + fresh news + regime context,
// ask Claude to produce updates/new-stories/resolutions, parse and
// validate the response.
//
// Single-purpose module so the prompt can be iterated on without
// touching cron route plumbing. The cron route applies the parsed
// output via story-tracker helpers.
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

// ─────────────────────────────────────────────────────────────
// Prompt builders — kept as pure functions for testability
// ─────────────────────────────────────────────────────────────

/**
 * Format active stories as compact context for the prompt.
 * Truncates verbose fields (note arrays show last 2 entries only)
 * to keep token count reasonable when there are 30-40 active stories.
 */
function formatActiveStoriesBlock(stories: TrackedStory[]): string {
  if (stories.length === 0) return '(no active stories — this is a fresh start)'
  return stories.map(s => {
    const recentUpdates = (s.updates ?? []).slice(-2).map(u =>
      `       [run ${u.runId}] ${u.note}${u.signalChange ? ` [→${u.signalChange}]` : ''}${u.confidenceChange !== undefined ? ` [conf:${u.confidenceChange}]` : ''}`
    ).join('\n')
    const ageHours = ((Date.now() - new Date(s.firstSeen).getTime()) / 3_600_000).toFixed(1)
    return `  • ID ${s.id}
    Ticker: ${s.ticker} (${s.assetType})
    Current signal: ${s.signal} @ ${s.confidence}% confidence
    Magnitude: ${s.magnitude ?? 'unknown'} | Risk: ${s.riskLevel ?? 'unknown'}
    Status: ${s.status}
    Timeframes: [${s.timeframes.join(', ')}]
    Session anchor: ${s.sessionAnchor}
    Catalyst: ${s.catalyst ?? '(none)'}
    Headline: ${s.headline ?? '(none)'}
    Reason: ${s.reason ?? '(none)'}
    Age: ${ageHours}h since first seen | Last touched: run ${s.lastTouchedRun}
    Update history (last 2):
${recentUpdates || '       (none)'}`
  }).join('\n\n')
}

/**
 * The system prompt — anchored on the dual-mode classifier role.
 * Keeps disciplinary rules tight: only ≥60 confidence, only catalyst-backed,
 * timeframe vs session distinction explicit.
 */
function buildSystemPrompt(): string {
  return `You are a financial analyst running an Active Stories tracking system. You see TWO inputs every run:
  (1) Stories already being tracked from prior runs (the "active stories" list)
  (2) Fresh news since the last run

Your output has THREE parts:
  - storyUpdates: changes to existing stories (new info, signal/confidence changes, mark playing-out, mark resolved)
  - newStories: catalysts not yet tracked, classified for the first time
  - run metadata: marketTheme, marketStatus, summary

CORE PRINCIPLES:

1. CONTINUITY MATTERS. If fresh news materially relates to an existing story, UPDATE that story rather than creating a duplicate. Even if a different headline mentions the same ticker for the same underlying catalyst, it's an update — append a note describing what's new and only change signal/confidence if the new info actually shifts your read.

2. RESOLVE WHEN APPROPRIATE. Mark a story resolved when:
   - The catalyst event has now happened (earnings reported, FDA decision out, deal closed)
   - The thesis has played out (price moved as expected and the trade window has closed)
   - News has rendered the original thesis irrelevant (different catalyst now dominates)
   - The story has gone quiet for so long it's no longer actionable
   ALWAYS provide a one-sentence resolutionReason when marking resolved.

3. PLAYING_OUT IS A REAL STATE. If the catalyst is unfolding RIGHT NOW (earnings being reported, halt active, deal vote happening), use markPlayingOut=true rather than markResolved. The story is still alive but in motion.

4. NEW STORIES NEED CATALYSTS. Do not create new stories for tickers that are merely mentioned in news without a specific actionable catalyst. The bar for new stories is higher than the bar for updating existing ones — a new story commits the system to tracking that ticker for days/weeks.

5. CONFIDENCE FLOOR: 60. Both new stories AND signal/confidence changes on existing stories must clear 60% confidence. Below that, leave the story alone or don't create it.

6. TIMEFRAMES (how long the trade thesis lasts) AND SESSION ANCHORS (when the catalyst hits) are ORTHOGONAL:
   - timeframes: ['1D'] | ['1W'] | ['1M'] | ['3M'] | combinations like ['1D','1W']
       1D: catalyst plays out within hours/single session (earnings tonight, halt resumed)
       1W: catalyst plays out over 3-10 trading days (analyst rating wave, gap-and-hold continuation)
       1M: catalyst plays out over weeks (M&A regulatory review, drug trial, sector rotation)
       3M: multi-month theme (Fed cycle position, capex cycle, regulatory shift)
   - sessionAnchor: 'today' | 'tomorrow' | 'weekend'
       today: catalyst becomes actionable during today's session
       tomorrow: catalyst becomes actionable next session
       weekend: catalyst becomes actionable Mon morning (or first day after weekend)

7. REGIME-AWARE CONFIDENCE. Bullish news in risk-off markets often fades. Bearish news in risk-on markets often gets bought. Factor regime into confidence — don't just classify the headline in isolation.

8. CONCISE NOTES. When updating, the "note" field is the audit trail of what's new. 1-2 sentences. Specific. No generic re-stating of the original story.

9. MAGNITUDE: high = expecting 5%+ move, medium = 2-5%, low = <2%.

10. STRICT JSON OUTPUT. No markdown fences, no preamble, no explanatory text outside JSON. Use plain numbers (no $ signs, no commas).`
}

/**
 * The user prompt — embeds the run context + active stories + fresh news.
 */
function buildUserPrompt(params: {
  runId: number
  triggerSource: string
  regime: MarketRegime
  activeStories: TrackedStory[]
  newsBlock: string
  now: Date
}): string {
  const { runId, triggerSource, regime, activeStories, newsBlock, now } = params
  const nowStr = now.toISOString()
  const day = nowStr.slice(0, 10)
  return `RUN CONTEXT
  Run ID: ${runId}
  Triggered by: ${triggerSource}
  Now: ${nowStr}
  Date: ${day}

MARKET REGIME RIGHT NOW:
${regime.contextParagraph}

ACTIVE STORIES (currently tracked, ${activeStories.length} total — review each one against the news below):
${formatActiveStoriesBlock(activeStories)}

FRESH NEWS HEADLINES (deduped, since last run):
${newsBlock}

Now produce your classification. Walk through these steps in order:

  STEP 1 — REVIEW EXISTING STORIES. For each active story above, decide:
    - Is fresh news relevant to it? If yes, write a storyUpdates entry.
    - Has the catalyst played out or is the thesis no longer actionable? If yes, mark resolved with reason.
    - Is the catalyst unfolding right now? If yes, mark playingOut.
    - Has signal/confidence shifted? Update both fields and explain in the note.
    - If none of the above and the story is unchanged, simply omit it from storyUpdates (this counts as "leave alone").

  STEP 2 — IDENTIFY NEW STORIES. From the fresh news, what catalysts AREN'T already covered by the active stories? Those become newStories. Each new story needs:
    - A clear catalyst (not just mention)
    - Confidence ≥ 60
    - One or more timeframe tags
    - A session anchor

  STEP 3 — PRODUCE METADATA. marketTheme is the single dominant theme this run. marketStatus is one sentence on overall mood. summary is 2-3 sentences on the most important takeaways.

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
      "ticker": "SYMBOL",
      "companyName": "Company Name Inc",
      "assetType": "stock",
      "signal": "BULLISH",
      "confidence": 72,
      "magnitude": "high",
      "timeframes": ["1D", "1W"],
      "sessionAnchor": "today",
      "catalyst": "Specific event e.g. Beat Q3 EPS by 18%",
      "reason": "Plain English explanation of why this matters at the tagged horizons",
      "headline": "the exact headline driving this",
      "riskLevel": "medium"
    }
  ],
  "marketTheme": "single dominant theme this run",
  "marketStatus": "one sentence on overall market mood given the regime",
  "summary": "2-3 sentences on the most important takeaways from this run"
}`
}

// ─────────────────────────────────────────────────────────────
// Output validation
// ─────────────────────────────────────────────────────────────

/**
 * Validate and clean the LLM output. Drops malformed entries silently
 * (better to lose one bad story than fail the whole run). Logs warnings
 * for any drops so we can debug later.
 */
function validateOutput(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  activeStoryIds: Set<string>,
): LLMClassificationOutput {
  const out: LLMClassificationOutput = {
    storyUpdates: [],
    newStories: [],
    marketTheme: typeof raw?.marketTheme === 'string' ? raw.marketTheme : 'unspecified',
    marketStatus: typeof raw?.marketStatus === 'string' ? raw.marketStatus : '',
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
  }

  // Validate storyUpdates
  if (Array.isArray(raw?.storyUpdates)) {
    for (const u of raw.storyUpdates) {
      if (!u || typeof u !== 'object') continue
      if (typeof u.storyId !== 'string' || !activeStoryIds.has(u.storyId)) {
        console.warn('[active-stories-classifier] dropped update with invalid/unknown storyId:', u.storyId)
        continue
      }
      if (typeof u.note !== 'string' || u.note.trim().length < 5) {
        console.warn('[active-stories-classifier] dropped update with missing/empty note:', u.storyId)
        continue
      }
      const cleaned: LLMClassificationOutput['storyUpdates'][number] = {
        storyId: u.storyId,
        note: u.note.trim(),
      }
      if (typeof u.newSignal === 'string' && VALID_SIGNALS.includes(u.newSignal as Signal)) {
        cleaned.newSignal = u.newSignal as Signal
      }
      if (typeof u.newConfidence === 'number' && u.newConfidence >= 0 && u.newConfidence <= 100) {
        cleaned.newConfidence = Math.round(u.newConfidence)
      }
      if (u.markPlayingOut === true) cleaned.markPlayingOut = true
      if (u.markResolved === true) {
        cleaned.markResolved = true
        cleaned.resolutionReason = typeof u.resolutionReason === 'string' && u.resolutionReason.trim().length > 0
          ? u.resolutionReason.trim()
          : 'LLM marked resolved (no reason provided)'
      }
      out.storyUpdates.push(cleaned)
    }
  }

  // Validate newStories
  if (Array.isArray(raw?.newStories)) {
    for (const n of raw.newStories) {
      if (!n || typeof n !== 'object') continue
      if (typeof n.ticker !== 'string' || !/^[A-Z]{1,10}$/.test(n.ticker.toUpperCase())) {
        console.warn('[active-stories-classifier] dropped new story with invalid ticker:', n.ticker)
        continue
      }
      if (typeof n.signal !== 'string' || !VALID_SIGNALS.includes(n.signal as Signal)) {
        console.warn('[active-stories-classifier] dropped new story with invalid signal:', n.ticker, n.signal)
        continue
      }
      if (typeof n.confidence !== 'number' || n.confidence < 60 || n.confidence > 100) {
        console.warn('[active-stories-classifier] dropped new story below confidence floor:', n.ticker, n.confidence)
        continue
      }
      if (!Array.isArray(n.timeframes) || n.timeframes.length === 0) {
        console.warn('[active-stories-classifier] dropped new story without timeframes:', n.ticker)
        continue
      }
      const validTfs = (n.timeframes as unknown[]).filter(
        (t): t is Timeframe => typeof t === 'string' && VALID_TIMEFRAMES.includes(t as Timeframe),
      )
      if (validTfs.length === 0) {
        console.warn('[active-stories-classifier] dropped new story with no valid timeframes:', n.ticker, n.timeframes)
        continue
      }
      if (typeof n.sessionAnchor !== 'string' || !VALID_SESSIONS.includes(n.sessionAnchor as SessionAnchor)) {
        console.warn('[active-stories-classifier] dropped new story with invalid sessionAnchor:', n.ticker, n.sessionAnchor)
        continue
      }
      const cleaned: LLMClassificationOutput['newStories'][number] = {
        ticker: n.ticker.toUpperCase(),
        signal: n.signal as Signal,
        confidence: Math.round(n.confidence),
        timeframes: validTfs,
        sessionAnchor: n.sessionAnchor as SessionAnchor,
      }
      if (typeof n.companyName === 'string') cleaned.companyName = n.companyName
      if (n.assetType === 'crypto') cleaned.assetType = 'crypto'
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
// JSON parser — robust to LLM occasionally wrapping in fences
// ─────────────────────────────────────────────────────────────

function parseJSON<T>(text: string): T {
  const cleaned = text.replace(/```json\s*|\s*```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error(`No JSON object in: ${cleaned.slice(0, 200)}`)
  return JSON.parse(cleaned.slice(start, end + 1)) as T
}

// ─────────────────────────────────────────────────────────────
// Public API — single function the cron route calls
// ─────────────────────────────────────────────────────────────

export interface ClassifyParams {
  runId: number
  triggerSource: string
  regime: MarketRegime
  activeStories: TrackedStory[]
  newsBlock: string
  now?: Date
}

/**
 * Run the classifier. Returns parsed + validated LLM output ready for
 * the cron route to apply via story-tracker helpers.
 *
 * Throws if the API call fails or the JSON is unparseable. The cron
 * route catches and logs to run_log.
 */
export async function classifyActiveStories(
  params: ClassifyParams,
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
    now: params.now ?? new Date(),
  })

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 6000,  // larger than the legacy 4000 because we may have many updates
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
