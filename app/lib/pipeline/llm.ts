// app/lib/pipeline/llm.ts
// ─────────────────────────────────────────────────────────────
// Centralized LLM access for the Council pipeline.
//
// Replaces ~14 inline `new Anthropic()/new OpenAI()` + raw
// `.create()` + `parseJSON()` call sites that previously lived in
// pipeline.ts. Fixes three classes of latent failure:
//
//   1. RELIABILITY — every core call now goes through SDK clients
//      configured with bounded retries + a hard timeout (handles
//      transient 429/5xx/connection drops with backoff), and the
//      JSON wrappers add ONE reprompt-on-parse-failure so a single
//      malformed response body no longer throws away an entire run
//      after ~10 upstream calls have already been paid for.
//
//   2. DETERMINISM — model + temperature are pinned per Council
//      ROLE in one place. Previously the Lead, Devil, and the Opus
//      Judge ran at the SDK default temperature (1.0), which fed
//      run-to-run variance into a track record that is supposed to
//      be calibrated. The Judge/Reviewer/Calibrator now run near
//      deterministic; the debate roles keep a little diversity.
//
//   3. MAINTAINABILITY — model strings live HERE, not scattered.
//      Swapping a model for one role is a one-line change instead
//      of a repo-wide find/replace (cf. patch-model-rename.ps1).
// ─────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

// ── Per-role model + temperature configuration ──────────────
// Single source of truth for the whole Council.
export type CouncilRole =
  | 'lead' | 'devil' | 'rebuttal' | 'counter'
  | 'judge' | 'reviewer' | 'calibrator' | 'research' | 'researchGpt'

// Model IDs are env-overridable so a model deprecation, or an account/key that
// lacks a given model, can be fixed by setting ONE Railway env var — no code
// change, no redeploy of model strings. Defaults are the current canonical IDs.
//   ANTHROPIC_SONNET_MODEL  → lead / rebuttal / research
//   ANTHROPIC_OPUS_MODEL    → judge / reviewer / calibrator
// (devil / counter / researchGpt use OpenAI gpt-4o and are unaffected.)
//
// IMPORTANT: 'research' is the CLAUDE-side research ask. The GPT-side research
// ask has its OWN key, 'researchGpt' (gpt-4o). They are deliberately separate
// so an OpenAI call can never accidentally grab a Claude model id (that caused
// a 404 'model claude-sonnet-4-6 does not exist' from OpenAI). Every key below
// names exactly one provider's model — never reuse a Claude key on a GPT call.
const SONNET_MODEL = process.env.ANTHROPIC_SONNET_MODEL ?? 'claude-sonnet-4-6'
const OPUS_MODEL   = process.env.ANTHROPIC_OPUS_MODEL   ?? 'claude-opus-4-7'

export const COUNCIL_MODELS: Record<CouncilRole, string> = {
  lead:        SONNET_MODEL,
  devil:       'gpt-4o',
  rebuttal:    SONNET_MODEL,
  counter:     'gpt-4o',
  judge:       OPUS_MODEL,
  reviewer:    OPUS_MODEL,
  calibrator:  OPUS_MODEL,
  research:    SONNET_MODEL,   // Claude-side research ask
  researchGpt: 'gpt-4o',       // GPT-side research ask — MUST stay an OpenAI model
}

// Temperature pinned per role. Debate roles (lead/devil/rebuttal/
// counter) keep modest diversity — they are meant to argue. The
// Judge / Reviewer / Calibrator run near-deterministic so the same
// bundle grades consistently across runs. Research is low-temp
// because it is a factual lookup, not a creative task.
export const COUNCIL_TEMPS: Record<CouncilRole, number> = {
  lead:       0.4,
  devil:      0.5,
  rebuttal:   0.4,
  counter:    0.5,
  judge:      0.15,
  reviewer:   0.10,
  calibrator: 0.10,
  research:   0.30,
  researchGpt: 0.30,
}

// ── Reliability knobs (override via env if needed) ──────────
const LLM_TIMEOUT_MS  = Number(process.env.LLM_TIMEOUT_MS  ?? '90000')
const LLM_MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES ?? '3')

// ── Memoized, configured SDK clients ────────────────────────
// One client per process instead of `new Anthropic()` on every
// call. The SDK's built-in retry handles transient HTTP errors
// (429 / 5xx / connection resets) with exponential backoff.
let _anthropic: Anthropic | null = null
export function anthropic(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: LLM_MAX_RETRIES,
      timeout: LLM_TIMEOUT_MS,
    })
  }
  return _anthropic
}

let _openai: OpenAI | null = null
export function openai(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: LLM_MAX_RETRIES,
      timeout: LLM_TIMEOUT_MS,
    })
  }
  return _openai
}

// ── JSON parsing helpers (moved verbatim from pipeline.ts) ──
export function repairJSON(raw: string): string {
  const s = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
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

// Walk forward from an opening brace, tracking string state + escapes, and
// return the index of the brace that closes it (depth back to 0), or -1 if
// the object is never closed. Used to extract the FIRST complete JSON object
// so trailing prose the model may append (e.g. a "**CORRECTION ...**" note)
// is ignored instead of poisoning the slice.
function findMatchingBraceEnd(s: string, openIdx: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

export function parseJSON<T>(text: string): T {
  if (!text || typeof text !== 'string') throw new Error('No JSON in response --- empty or non-string input')
  const clean = text.replace(/```json|```/g, '').trim()
  const start = clean.indexOf('{')
  if (start === -1) {
    console.error('[parseJSON] No JSON found in:', clean.slice(0, 200))
    throw new Error('No JSON in response')
  }
  // First complete object via balanced braces; fall back to the tail (from
  // the first brace) if it never closes, so the repair pass below still runs.
  const matchEnd = findMatchingBraceEnd(clean, start)
  const slice = matchEnd !== -1 ? clean.slice(start, matchEnd + 1) : clean.slice(start)
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
export function extractText(content: any[]): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const block = content.find((b: any) => b.type === 'text') as { text: string } | undefined
  if (!block) throw new Error('No text block in Anthropic response')
  return block.text
}

// ── Role-aware JSON call wrappers ───────────────────────────
// These add the ONE thing the SDK's transient-error retry can't:
// recovery from a well-formed HTTP response whose BODY isn't valid
// JSON. On the first parse failure we reprompt ONCE with a strict
// instruction at temperature 0, then give up with a clear error.

const JSON_REPROMPT =
  '\n\nIMPORTANT: your previous reply could not be parsed as JSON. ' +
  'Respond with ONLY the JSON object — no prose, no markdown, no code fences.'

export interface JSONCallOpts {
  role: CouncilRole
  system: string
  user: string
  maxTokens: number
}

export async function callClaudeJSON<T>(opts: JSONCallOpts): Promise<T> {
  const model = COUNCIL_MODELS[opts.role]
  const temperature = COUNCIL_TEMPS[opts.role]
  // Provider guard: this path hits the Anthropic SDK. A non-Claude model here
  // means a role was mis-wired; fail loud with the role name instead of letting
  // Anthropic return a confusing error.
  if (!/^claude/i.test(model)) {
    throw new Error(`callClaudeJSON: role '${opts.role}' resolves to non-Claude model '${model}'. Route GPT roles through callGPTJSON.`)
  }
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = attempt === 0 ? opts.user : opts.user + JSON_REPROMPT
    const msg = await anthropic().messages.create({
      model,
      max_tokens: opts.maxTokens,
      temperature: attempt === 0 ? temperature : 0,
      system: opts.system,
      messages: [{ role: 'user', content: user }],
    })
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return parseJSON<T>(extractText(msg.content as any[]))
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(
    `callClaudeJSON(${opts.role}) failed to parse after reprompt: ` +
    (lastErr instanceof Error ? lastErr.message : String(lastErr)),
  )
}

export async function callGPTJSON<T>(opts: JSONCallOpts): Promise<T> {
  const model = COUNCIL_MODELS[opts.role]
  const temperature = COUNCIL_TEMPS[opts.role]
  // Provider guard: this path hits the OpenAI SDK. A Claude model here is the
  // exact bug that produced the OpenAI 404 'model claude-sonnet-4-6 does not
  // exist'. Fail loud with the role name instead of round-tripping to OpenAI.
  if (/^claude/i.test(model)) {
    throw new Error(`callGPTJSON: role '${opts.role}' resolves to Claude model '${model}'. Use 'researchGpt'/'devil'/'counter' for OpenAI, or route via callClaudeJSON.`)
  }
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = attempt === 0 ? opts.user : opts.user + JSON_REPROMPT
    const completion = await openai().chat.completions.create({
      model,
      max_tokens: opts.maxTokens,
      temperature: attempt === 0 ? temperature : 0,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: user },
      ],
    })
    try {
      return parseJSON<T>(completion.choices[0]?.message?.content ?? '')
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(
    `callGPTJSON(${opts.role}) failed to parse after reprompt: ` +
    (lastErr instanceof Error ? lastErr.message : String(lastErr)),
  )
}
