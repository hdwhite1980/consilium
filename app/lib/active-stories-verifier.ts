// =============================================================
// app/lib/active-stories-verifier.ts (Phase 2.5)
//
// Hallucination verification pass for Active Stories classifier output.
//
// PROBLEM: The classifier (Phase 2) can fabricate plausible-sounding
// specifics that aren't in the source news. Canonical failure: GME
// "$56B eBay takeover bid" — a fictional dollar amount + named-entity
// acquisition that appeared in catalyst/reason but not in any source
// headline.
//
// APPROACH: Two-stage hybrid verification.
//   Stage 1 (free): pattern-match claim-bearing tokens in catalyst,
//     reason, headline, and update notes. For each claim, check if the
//     source newsBlock contains the same dollar amount, action-verb
//     pairing, or named entity. Verified claims pass through; suspicious
//     claims go to Stage 2.
//   Stage 2 (LLM, only on suspicious): batch suspicious stories into
//     one Claude call asking "are these specifics supported by the
//     source?" — fail-open on timeout/error.
//
// ACTION ON UNVERIFIED: Cap confidence at 60 (the existing floor) and
// prepend [UNVERIFIED] to the relevant field. Dashboard can render an
// "unverified" badge from the marker.
// =============================================================

import Anthropic from '@anthropic-ai/sdk'
import type {
  LLMClassificationOutput,
} from '@/app/lib/types/active-stories'

const VERIFIER_TIMEOUT_MS = 8_000
const VERIFIER_MODEL = 'claude-sonnet-4-6'
const MAX_BATCH_SIZE = 10                 // suspicious stories per LLM call
const UNVERIFIED_CONF_CAP = 60            // cap confidence when unverified
const UNVERIFIED_MARKER = '[UNVERIFIED] ' // prepended to flagged fields

// ─────────────────────────────────────────────────────────────
// Stage 1 — Pattern match (free, runs on every call)
// ─────────────────────────────────────────────────────────────

interface ExtractedClaims {
  dollarAmounts: string[]       // ["$56B", "$1.23", "$14 billion"]
  percentages: string[]         // ["25%", "+18%"]
  actionVerbs: string[]         // ["acquires", "sues", "beats"]
  namedEntities: string[]       // ["eBay", "FDA", "DOJ"]
}

// Action verbs that often co-occur with hallucinated specifics.
// Bare mention is fine; what matters is whether the source supports
// the specific subject/object the classifier paired with the verb.
const HIGH_RISK_ACTION_VERBS = [
  'acquires', 'acquired', 'acquisition', 'takeover', 'merges', 'merger',
  'sues', 'sued', 'lawsuit', 'files suit', 'settles', 'settlement',
  'partners with', 'partnership', 'announces', 'announced',
  'recalls', 'recalled', 'suspends', 'suspended',
  'approves', 'approved', 'rejects', 'rejected', 'denies', 'denied',
  'beats', 'beat', 'misses', 'missed',
  'guides', 'guidance', 'cuts', 'cut', 'raises', 'raised', 'lowers', 'lowered',
  'tariff', 'tariffs', 'sanctions', 'sanctioned',
  'fda', 'sec', 'ftc', 'doj',
]

// Regex helpers
const DOLLAR_RE = /\$\s?\d+(?:[.,]\d+)?(?:\s?(?:million|billion|trillion|m|b|t|k))?/gi
const PERCENT_RE = /[+-]?\d+(?:\.\d+)?\s?%/g

/**
 * Extract claim-bearing tokens from a text blob.
 * Lower-cases verbs/entities for matching but preserves dollar/percent
 * strings verbatim for source-matching.
 */
function extractClaims(text: string): ExtractedClaims {
  if (!text || text.length === 0) {
    return { dollarAmounts: [], percentages: [], actionVerbs: [], namedEntities: [] }
  }
  const lower = text.toLowerCase()

  const dollarAmounts = Array.from(text.matchAll(DOLLAR_RE)).map(m => m[0].trim())
  const percentages = Array.from(text.matchAll(PERCENT_RE)).map(m => m[0].trim())

  const actionVerbs: string[] = []
  for (const verb of HIGH_RISK_ACTION_VERBS) {
    if (lower.includes(verb)) actionVerbs.push(verb)
  }

  // Named entities = capitalized words/phrases of 2+ letters that aren't
  // common English words. This is approximate — Stage 2 LLM is the safety net.
  // We extract candidates and filter common false positives.
  const COMMON_CAPS = new Set([
    'I', 'A', 'The', 'This', 'That', 'These', 'Those', 'It', 'Its',
    'Q1', 'Q2', 'Q3', 'Q4', 'YoY', 'QoQ', 'EPS', 'CEO', 'CFO', 'COO',
    'AI', 'IPO', 'ETF', 'CPI', 'GDP', 'PPI', 'NFP', 'FOMC',
    'EV', 'EVs', 'US', 'USA', 'UK', 'EU',
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
    'Plain', 'English', 'Lead', 'Devil', 'Trader', 'Bullish', 'Bearish', 'Neutral',
    // Common finance shorthand — would be false-positives without this list
    'AMC', 'BMO', 'PMO',           // session anchors: after market close, before market open
    'AH', 'PM', 'AM',              // after hours, pre-market
    'YTD', 'MTD', 'WTD',           // year/month/week to date
    'ATH', 'ATL',                  // all-time high/low
    'TTM', 'LTM', 'NTM',           // trailing/next twelve months
    'PE', 'PB', 'PS', 'PEG',       // valuation multiples
    'EBITDA', 'EBIT', 'FCF', 'CapEx',
    'EM', 'DM',                    // emerging/developed markets
    'BTC', 'ETH', 'USD', 'EUR', 'JPY', 'GBP', 'CNY',
    'Options', 'Futures', 'Earnings', 'Revenue', 'Guidance',
    'Buy', 'Sell', 'Hold',
  ])
  const namedEntities: string[] = []
  const seen = new Set<string>()
  // Match capitalized words possibly chained (e.g. "Bank of America", "FDA", "JPMorgan Chase")
  const entityRe = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,3})\b/g
  for (const m of text.matchAll(entityRe)) {
    const token = m[1]
    if (COMMON_CAPS.has(token)) continue
    if (token.length < 2) continue
    const key = token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    namedEntities.push(token)
  }
  // Also grab bare uppercase regulator/agency acronyms
  const acronymRe = /\b(FDA|SEC|FTC|DOJ|EPA|FCC|FAA|CDC|OSHA|NHTSA|CFTC|FERC|IRS|OPEC|NATO|UN|WHO|IMF|ECB|BOJ|BOE|PBOC)\b/g
  for (const m of text.matchAll(acronymRe)) {
    const token = m[0]
    if (!seen.has(token.toLowerCase())) {
      seen.add(token.toLowerCase())
      namedEntities.push(token)
    }
  }

  return { dollarAmounts, percentages, actionVerbs, namedEntities }
}

/**
 * Check if a claim is present in the source text. Different matching rules
 * per claim type:
 *   - Dollar amounts: substring (case-insensitive, ignore whitespace variations)
 *   - Percentages: substring (allowing for sign/decimal variations)
 *   - Action verbs: substring (case-insensitive) — must be present alongside
 *     the ticker or company name; we approximate this by requiring co-occurrence
 *     in any sentence containing the ticker
 *   - Named entities: substring (case-insensitive)
 */
function claimsSupportedBySource(
  claims: ExtractedClaims,
  source: string,
  ticker: string,
  companyName: string | undefined,
): { allSupported: boolean; missing: string[] } {
  const sourceLower = source.toLowerCase()
  const tickerLower = ticker.toLowerCase()
  const companyLower = (companyName ?? '').toLowerCase()
  const missing: string[] = []

  // Dollar amounts: must appear verbatim in source (normalize whitespace)
  for (const amt of claims.dollarAmounts) {
    const normalized = amt.replace(/\s+/g, '').toLowerCase()
    const sourceNormalized = sourceLower.replace(/\s+/g, '')
    if (!sourceNormalized.includes(normalized)) {
      // Also try the "X billion" expansion (e.g. "$56B" → "$56 billion")
      const expanded = expandDollarShorthand(amt).toLowerCase().replace(/\s+/g, '')
      if (expanded !== normalized && !sourceNormalized.includes(expanded)) {
        missing.push(`dollar:${amt}`)
      }
    }
  }

  // Percentages: must appear verbatim in source
  for (const pct of claims.percentages) {
    const normalized = pct.replace(/\s+/g, '').toLowerCase()
    if (!sourceLower.replace(/\s+/g, '').includes(normalized)) {
      // Allow ±5pp tolerance — classifier may extrapolate small differences
      // For now, strict match. Stage 2 LLM handles edge cases.
      missing.push(`pct:${pct}`)
    }
  }

  // Action verbs: must appear in same sentence as ticker or company
  // Approximate by checking if verb+ticker (or verb+company) co-occur in source.
  // If verb alone in source but not paired with ticker/company, that's
  // suspicious — the classifier may have invented the link.
  for (const verb of claims.actionVerbs) {
    // First check if the verb appears in source at all
    if (!sourceLower.includes(verb)) {
      missing.push(`verb:${verb}`)
      continue
    }
    // Co-occurrence check: find sentences containing the verb, check if
    // any of those sentences also mention the ticker or company name.
    const sentences = source.split(/[.!?\n]+/)
    let cooccurs = false
    for (const sent of sentences) {
      const sLower = sent.toLowerCase()
      if (sLower.includes(verb) && (sLower.includes(tickerLower) || (companyLower && sLower.includes(companyLower)))) {
        cooccurs = true
        break
      }
    }
    if (!cooccurs) {
      missing.push(`verb-no-cooccur:${verb}`)
    }
  }

  // Named entities: each should appear in source if classifier mentioned it.
  // Common ones like the ticker itself or generic company prefixes already filtered.
  for (const ent of claims.namedEntities) {
    // Skip the ticker and company name themselves
    if (ent.toLowerCase() === tickerLower) continue
    if (companyLower && companyLower.includes(ent.toLowerCase())) continue
    if (!sourceLower.includes(ent.toLowerCase())) {
      missing.push(`entity:${ent}`)
    }
  }

  return { allSupported: missing.length === 0, missing }
}

/**
 * Expand "$56B" → "$56 billion" for source matching.
 */
function expandDollarShorthand(amt: string): string {
  const m = amt.match(/^\$?\s?(\d+(?:[.,]\d+)?)\s?([mbtk])$/i)
  if (!m) return amt
  const num = m[1]
  const suffix = m[2].toLowerCase()
  const expansion = suffix === 'k' ? 'thousand' : suffix === 'm' ? 'million' : suffix === 'b' ? 'billion' : 'trillion'
  return `$${num} ${expansion}`
}

// ─────────────────────────────────────────────────────────────
// Stage 2 — LLM verifier (only on suspicious claims)
// ─────────────────────────────────────────────────────────────

interface SuspiciousClaim {
  scope: 'newStory' | 'storyUpdate'
  index: number             // index in the original array
  ticker: string
  textToVerify: string      // catalyst+reason+headline or note
  missingTokens: string[]   // what Stage 1 couldn't find
}

interface VerifierVerdict {
  index: number
  scope: 'newStory' | 'storyUpdate'
  verified: boolean
  reason: string
}

async function llmVerifyBatch(
  suspicious: SuspiciousClaim[],
  newsBlock: string,
  anthropic: Anthropic,
): Promise<VerifierVerdict[]> {
  if (suspicious.length === 0) return []

  // Build a numbered list for the LLM
  const numbered = suspicious.map((s, i) => `[${i}] ticker=${s.ticker} scope=${s.scope}
       text: ${s.textToVerify}
       Stage-1 flagged missing: ${s.missingTokens.join(', ')}`).join('\n\n')

  const systemPrompt = `You are a hallucination verifier for a financial news classifier. Each item below contains a story's specific claims (catalyst, reason, headline, or update note) that a Stage-1 pattern matcher could not find verbatim in the source news.

Your job: for each item, decide if the specifics are REASONABLY SUPPORTED by the source news, even if not verbatim. Reasoning shortcuts are OK (e.g. classifier said "EPS beat by $0.05" when source said "AAPL beat consensus by 5 cents" — verified). But fabricated specifics are NOT OK (e.g. classifier said "$56B eBay takeover bid" when source has no mention of eBay or any takeover bid — unverified).

VERIFY when:
- The classifier's specifics are restatements, calculations from, or reasonable summaries of the source
- The source has the gist even if numbers/names differ slightly
- The specific is a routine industry term the classifier added for clarity

UNVERIFIED when:
- A dollar amount, named entity, or specific event appears in the story but has NO source basis whatsoever
- The classifier invented a deal, lawsuit, acquisition, partnership, or specific transaction that the source doesn't mention
- The classifier attributed a quote or action to a named person/entity not in source

Output STRICT JSON only:
{"verdicts": [{"index": 0, "verified": true, "reason": "brief explanation"}, ...]}

One verdict per item, ordered by index.`

  const userPrompt = `SOURCE NEWS (this is what the classifier saw):
${newsBlock.slice(0, 8000)}${newsBlock.length > 8000 ? '\n[...truncated]' : ''}

ITEMS TO VERIFY:
${numbered}

Return JSON with one verdict per item. Be lenient on derivable specifics, strict on fabricated specifics.`

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('verifier-timeout')), VERIFIER_TIMEOUT_MS)
  })

  try {
    const msg = await Promise.race([
      anthropic.messages.create({
        model: VERIFIER_MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      timeoutPromise,
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (msg.content[0] as any)?.text as string
    if (!text) {
      console.warn('[active-stories-verifier] empty LLM response — failing open')
      return suspicious.map(s => ({ index: s.index, scope: s.scope, verified: true, reason: 'verifier empty response (failed open)' }))
    }
    const cleaned = text.replace(/```json\s*|\s*```/g, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end === -1) {
      console.warn('[active-stories-verifier] no JSON in LLM response — failing open')
      return suspicious.map(s => ({ index: s.index, scope: s.scope, verified: true, reason: 'verifier JSON parse failed (failed open)' }))
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { verdicts?: Array<{ index: number; verified: boolean; reason: string }> }
    if (!Array.isArray(parsed.verdicts)) {
      console.warn('[active-stories-verifier] malformed verdicts array — failing open')
      return suspicious.map(s => ({ index: s.index, scope: s.scope, verified: true, reason: 'verifier malformed verdicts (failed open)' }))
    }
    // Map LLM verdict indices back to original suspicious indices
    const result: VerifierVerdict[] = []
    for (let i = 0; i < suspicious.length; i++) {
      const v = parsed.verdicts[i]
      if (v && typeof v.verified === 'boolean') {
        result.push({ index: suspicious[i].index, scope: suspicious[i].scope, verified: v.verified, reason: v.reason || '' })
      } else {
        // Missing verdict → fail open for that one
        result.push({ index: suspicious[i].index, scope: suspicious[i].scope, verified: true, reason: 'verdict missing (failed open)' })
      }
    }
    return result
  } catch (err) {
    if (err instanceof Error && err.message === 'verifier-timeout') {
      console.warn('[active-stories-verifier] LLM timeout — failing open')
    } else {
      console.warn('[active-stories-verifier] LLM error — failing open:', err instanceof Error ? err.message : err)
    }
    // Fail open: when verifier breaks, don't kill stories
    return suspicious.map(s => ({ index: s.index, scope: s.scope, verified: true, reason: 'verifier error (failed open)' }))
  }
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export interface VerifyParams {
  classifierOutput: LLMClassificationOutput
  newsBlock: string         // the same newsBlock passed to the classifier
}

export interface VerifyResult {
  /** The classifier output with unverified items marked + confidence capped. */
  verifiedOutput: LLMClassificationOutput
  /** Diagnostic counts for logging / observability. */
  stats: {
    newStoriesChecked: number
    newStoriesFlaggedStage1: number
    newStoriesUnverified: number
    updatesChecked: number
    updatesFlaggedStage1: number
    updatesUnverified: number
    stage2Called: boolean
  }
}

/**
 * Verify a classifier output and mark unverified items.
 *
 * Operation:
 *   1. Stage 1 pattern-match every new story and update against the
 *      source newsBlock. Build list of suspicious items.
 *   2. If suspicious list is non-empty, run Stage 2 LLM verification
 *      in batches of MAX_BATCH_SIZE. Fail-open on timeout/error.
 *   3. Apply [UNVERIFIED] marker and cap confidence on items the LLM
 *      ruled unverified.
 *   4. Return modified output + stats.
 *
 * Cron route should call this after `classifyActiveStories()` and
 * before applying updates via story-tracker helpers.
 */
export async function verifyActiveStories(params: VerifyParams): Promise<VerifyResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const { classifierOutput, newsBlock } = params

  const stats: VerifyResult['stats'] = {
    newStoriesChecked: classifierOutput.newStories.length,
    newStoriesFlaggedStage1: 0,
    newStoriesUnverified: 0,
    updatesChecked: classifierOutput.storyUpdates.length,
    updatesFlaggedStage1: 0,
    updatesUnverified: 0,
    stage2Called: false,
  }

  // ──────────── Stage 1 ────────────
  const suspicious: SuspiciousClaim[] = []

  // Check newStories
  for (let i = 0; i < classifierOutput.newStories.length; i++) {
    const story = classifierOutput.newStories[i]
    const textToVerify = [story.catalyst, story.reason, story.headline].filter(Boolean).join(' || ')
    if (!textToVerify) continue
    const claims = extractClaims(textToVerify)
    // No claim-bearing tokens → nothing to verify, pass through
    if (
      claims.dollarAmounts.length === 0 &&
      claims.percentages.length === 0 &&
      claims.actionVerbs.length === 0 &&
      claims.namedEntities.length === 0
    ) {
      continue
    }
    const check = claimsSupportedBySource(claims, newsBlock, story.ticker, story.companyName)
    if (!check.allSupported) {
      stats.newStoriesFlaggedStage1++
      suspicious.push({
        scope: 'newStory',
        index: i,
        ticker: story.ticker,
        textToVerify,
        missingTokens: check.missing,
      })
    }
  }

  // Check storyUpdates (we verify the note field; signal changes themselves are out of scope)
  for (let i = 0; i < classifierOutput.storyUpdates.length; i++) {
    const update = classifierOutput.storyUpdates[i]
    if (!update.note) continue
    const claims = extractClaims(update.note)
    if (
      claims.dollarAmounts.length === 0 &&
      claims.percentages.length === 0 &&
      claims.actionVerbs.length === 0 &&
      claims.namedEntities.length === 0
    ) {
      continue
    }
    // For updates, we don't have ticker readily available (storyUpdates carry storyId not ticker).
    // The note text + source matching is what we have. Use empty ticker — co-occurrence
    // check will be less strict.
    const check = claimsSupportedBySource(claims, newsBlock, '', undefined)
    if (!check.allSupported) {
      stats.updatesFlaggedStage1++
      suspicious.push({
        scope: 'storyUpdate',
        index: i,
        ticker: '(update)',
        textToVerify: update.note,
        missingTokens: check.missing,
      })
    }
  }

  console.log(`[active-stories-verifier] Stage 1 done. newStories: ${stats.newStoriesChecked} checked, ${stats.newStoriesFlaggedStage1} flagged. updates: ${stats.updatesChecked} checked, ${stats.updatesFlaggedStage1} flagged.`)

  // Build a copy of the output to modify
  const verifiedOutput: LLMClassificationOutput = {
    ...classifierOutput,
    newStories: classifierOutput.newStories.map(s => ({ ...s })),
    storyUpdates: classifierOutput.storyUpdates.map(u => ({ ...u })),
  }

  // No suspicious items → done, return as-is
  if (suspicious.length === 0) {
    return { verifiedOutput, stats }
  }

  // No API key → fail open (Stage 2 can't run)
  if (!apiKey) {
    console.warn('[active-stories-verifier] ANTHROPIC_API_KEY not set; skipping Stage 2 (failing open)')
    return { verifiedOutput, stats }
  }

  // ──────────── Stage 2 ────────────
  stats.stage2Called = true
  const anthropic = new Anthropic({ apiKey })

  // Batch into MAX_BATCH_SIZE chunks
  const verdicts: VerifierVerdict[] = []
  for (let i = 0; i < suspicious.length; i += MAX_BATCH_SIZE) {
    const batch = suspicious.slice(i, i + MAX_BATCH_SIZE)
    const batchVerdicts = await llmVerifyBatch(batch, newsBlock, anthropic)
    verdicts.push(...batchVerdicts)
  }

  // Apply verdicts: unverified items get marker + confidence cap
  for (const v of verdicts) {
    if (v.verified) continue
    if (v.scope === 'newStory') {
      stats.newStoriesUnverified++
      const story = verifiedOutput.newStories[v.index]
      if (!story) continue
      story.catalyst = applyMarker(story.catalyst)
      story.reason = applyMarker(story.reason)
      if (story.confidence > UNVERIFIED_CONF_CAP) {
        story.confidence = UNVERIFIED_CONF_CAP
      }
      console.log(`[active-stories-verifier] UNVERIFIED newStory ${story.ticker}: ${v.reason}`)
    } else {
      stats.updatesUnverified++
      const update = verifiedOutput.storyUpdates[v.index]
      if (!update) continue
      update.note = applyMarker(update.note) ?? update.note
      if (update.newConfidence !== undefined && update.newConfidence > UNVERIFIED_CONF_CAP) {
        update.newConfidence = UNVERIFIED_CONF_CAP
      }
      console.log(`[active-stories-verifier] UNVERIFIED storyUpdate ${update.storyId}: ${v.reason}`)
    }
  }

  console.log(`[active-stories-verifier] Stage 2 done. newStories unverified: ${stats.newStoriesUnverified}, updates unverified: ${stats.updatesUnverified}`)
  return { verifiedOutput, stats }
}

function applyMarker(text: string | undefined): string | undefined {
  if (!text) return text
  if (text.startsWith(UNVERIFIED_MARKER)) return text
  return UNVERIFIED_MARKER + text
}

// ─────────────────────────────────────────────────────────────
// Exports for testing
// ─────────────────────────────────────────────────────────────

export const __testing = {
  extractClaims,
  claimsSupportedBySource,
  expandDollarShorthand,
}
