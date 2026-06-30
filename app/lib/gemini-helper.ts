// =============================================================
// app/lib/gemini-helper.ts
//
// Resilient wrapper around Gemini calls with automatic retry on
// transient errors (503, 429, network blips) and automatic fallback
// from gemini-2.5-pro to gemini-2.5-flash when Pro is overloaded.
//
// Default behavior (matches Wali-OS's chosen policy):
//   1. Try gemini-2.5-pro
//   2. If transient error: wait 1.5s, retry gemini-2.5-pro once
//   3. If still failing: switch to gemini-2.5-flash, no retry
//   4. If Flash also fails: throw the last error
//
// Usage example:
//   const { text, modelUsed, attemptsMade } = await generateWithFallback({
//     prompt: '...',
//     temperature: 0.1,
//     maxOutputTokens: 4000,
//     responseMimeType: 'application/json',
//     caller: 'verification:claim-extract',
//   })
//
// Grounded (Google Search) example:
//   const { text, rawResponse } = await generateWithFallback({
//     prompt: '...',
//     useGoogleSearchGrounding: true,
//     caller: 'verification:batch-verify',
//   })
//
// Telemetry: every call emits a single console.log line with the caller
// name, model used, attempts made, and elapsed time. Failures emit a
// console.warn with the model + error message.
// =============================================================

import { GoogleGenerativeAI } from '@google/generative-ai'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GenerationConfig = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tool = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GenerateContentResult = any

const getGenAI = () => new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

// Public API types

export interface GeminiCallOptions {
  /** The full prompt text passed to the model. */
  prompt: string

  /**
   * Caller identifier used in log lines. Pick something short and unique
   * so you can grep Railway logs for a specific call site, e.g.:
   *   'verification:claim-extract'
   *   'verification:batch-verify'
   *   'judge:draft'
   *   'judge:calibrated-rerun'
   *   'tomorrow:verify-watchlist'
   */
  caller: string

  /**
   * Model fallback chain. Defaults to ['gemini-2.5-pro', 'gemini-2.5-flash'].
   * The first model is the primary; subsequent models are fallbacks.
   */
  models?: string[]

  /**
   * Whether to retry the FIRST model in the chain once on a transient error
   * before falling back to the next model. Default: true.
   *
   * Most Gemini overload errors clear within 1-2 seconds, so a single retry
   * catches most transient cases without burning much wall time.
   */
  retryFirstModel?: boolean

  /** Backoff delay before the retry attempt, in milliseconds. Default: 1500. */
  retryDelayMs?: number

  // Generation config
  temperature?: number
  maxOutputTokens?: number

  /**
   * Set to 'application/json' to force JSON-only output (the model will not
   * include markdown fences). Most callers using JSON output should set this.
   */
  responseMimeType?: 'application/json' | 'text/plain'

  // Tooling
  /**
   * Enable Google Search grounding. The result will include groundingMetadata
   * (sources surfaced by Google Search) for inspection by the caller.
   *
   * Note: not all models support grounding equally well. gemini-2.5-pro and
   * gemini-2.5-flash both support it as of this writing.
   */
  useGoogleSearchGrounding?: boolean
}

export interface GeminiCallResult {
  /** The generated text (already extracted via response.text()). */
  text: string

  /** Which model in the fallback chain actually returned the response. */
  modelUsed: string

  /**
   * Total attempts made across all models in the chain. 1 = first try
   * succeeded; 2 = retry succeeded; 3+ = had to fall back to a later model.
   */
  attemptsMade: number

  /**
   * Elapsed time in milliseconds from the first attempt to a successful
   * response. Useful for cost/latency tracking.
   */
  elapsedMs: number

  /**
   * Raw response object so the caller can access groundingMetadata or
   * other model-specific fields without us having to surface every one.
   * Only populated when useGoogleSearchGrounding is true.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawResponse?: any
}

// Error classification

/**
 * Returns true if an error looks like a transient overload / rate-limit /
 * network condition that's worth retrying. We DON'T retry on:
 *   - 4xx errors that aren't 429 (auth failures, bad input, etc.)
 *   - Schema validation errors
 *   - Quota exceeded (different from rate limit)
 *
 * Patterns we DO consider retryable:
 *   - 503 Service Unavailable
 *   - 429 Rate Limit
 *   - "overload" / "overloaded" in the message body
 *   - "UNAVAILABLE" status
 *   - "DEADLINE_EXCEEDED"
 *   - Network errors (ECONNRESET, ETIMEDOUT, fetch failures)
 */
function isTransientError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err)
  return (
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('overload') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('DEADLINE_EXCEEDED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('fetch failed') ||
    msg.includes('network')
  )
}

// Single attempt against one specific model
async function callOnce(
  modelName: string,
  opts: GeminiCallOptions
): Promise<GenerateContentResult> {
  const generationConfig: GenerationConfig = {}
  if (typeof opts.temperature === 'number') generationConfig.temperature = opts.temperature
  if (typeof opts.maxOutputTokens === 'number') generationConfig.maxOutputTokens = opts.maxOutputTokens
  if (opts.responseMimeType) generationConfig.responseMimeType = opts.responseMimeType

  // Build tools array if grounding requested
  const tools: Tool[] = []
  if (opts.useGoogleSearchGrounding) {
    tools.push({ googleSearch: {} })
  }

  // Build the model params inline so TypeScript can see the required 'model' field.
  // Use conditional spread for tools so we don't pass an empty array.
  const model = getGenAI().getGenerativeModel({
    model: modelName,
    generationConfig,
    ...(tools.length > 0 ? { tools } : {}),
  })
  return model.generateContent(opts.prompt)
}

// Main entry point: generate with retry + fallback
export async function generateWithFallback(
  opts: GeminiCallOptions
): Promise<GeminiCallResult> {
  // Provider delegation: route grounded (live web search) calls to Perplexity
  // Sonar when SEARCH_PROVIDER=sonar. Sonar is search-native with a much lower
  // citation-hallucination rate — a better fit for the verification/fact-check
  // roles, and immune to the Gemini-tier 503 overload. Only grounded calls are
  // delegated; non-grounded Gemini work (Scout summarization, Judge reasoning,
  // claim extraction) stays on Gemini. Unset SEARCH_PROVIDER to roll back.
  if (opts.useGoogleSearchGrounding && process.env.SEARCH_PROVIDER === 'sonar') {
    const { searchWithSonar } = await import('./perplexity-helper')
    return searchWithSonar(opts)
  }

  // Env-overridable so the Scout/verifier model can be upgraded (e.g. to
  // gemini-3.1-pro) from Railway without a code change. Default stays on the
  // known-good 2.5 chain; set GEMINI_PRO_MODEL / GEMINI_FLASH_MODEL to move up
  // once the exact API id is confirmed in Google AI Studio.
  const defaultChain = [
    process.env.GEMINI_PRO_MODEL ?? 'gemini-2.5-pro',
    process.env.GEMINI_FLASH_MODEL ?? 'gemini-2.5-flash',
  ]
  const models = opts.models ?? defaultChain
  const retryFirstModel = opts.retryFirstModel ?? true
  const retryDelayMs = opts.retryDelayMs ?? 1500

  if (models.length === 0) {
    throw new Error('[gemini-helper] models array cannot be empty')
  }

  const startedAt = Date.now()
  let attemptsMade = 0
  let lastError: Error | null = null

  for (let modelIdx = 0; modelIdx < models.length; modelIdx++) {
    const modelName = models[modelIdx]
    const isPrimary = modelIdx === 0
    const triesForThisModel = isPrimary && retryFirstModel ? 2 : 1

    for (let attempt = 0; attempt < triesForThisModel; attempt++) {
      attemptsMade++
      try {
        const result = await callOnce(modelName, opts)
        const text = result.response.text()
        const elapsedMs = Date.now() - startedAt

        // Telemetry: success path
        const modelTag = modelName.replace('gemini-', '')
        if (attemptsMade > 1) {
          // We had to retry or fall back. Log explicitly so we can track frequency.
          console.log(
            `[gemini:${opts.caller}] OK after ${attemptsMade} attempts using ${modelTag} in ${elapsedMs}ms`
          )
        } else {
          // Happy path. Log lightly.
          console.log(
            `[gemini:${opts.caller}] OK ${modelTag} in ${elapsedMs}ms`
          )
        }

        return {
          text,
          modelUsed: modelName,
          attemptsMade,
          elapsedMs,
          rawResponse: opts.useGoogleSearchGrounding ? result.response : undefined,
        }
      } catch (err) {
        lastError = err as Error
        const msg = (err as Error).message?.slice(0, 200) ?? String(err)
        const isLastTryThisModel = attempt === triesForThisModel - 1
        const isLastModel = modelIdx === models.length - 1

        // Permanent / hard error (auth, 403 billing-deny, bad project). Pro→Flash
        // share the same Google project + billing, so retrying or falling to Flash
        // can't help — both die together. Instead of throwing (which kills the whole
        // council run), cross to a DIFFERENT vendor. Grounded calls already returned
        // to Perplexity above, so anything here is non-grounded and safe to send to
        // Claude / OpenAI.
        if (!isTransientError(err)) {
          console.warn(
            `[gemini:${opts.caller}] HARD error on ${modelName} (${msg}) — crossing to non-Gemini provider`
          )
          try {
            const fb = await geminiCrossProviderFallback({
              prompt: opts.prompt,
              caller: opts.caller,
              grounded: opts.useGoogleSearchGrounding,
              maxOutputTokens: opts.maxOutputTokens,
              temperature: opts.temperature,
            })
            return {
              text: fb.text,
              modelUsed: fb.modelUsed,
              attemptsMade: attemptsMade + 1,
              elapsedMs: Date.now() - startedAt,
              rawResponse: fb.rawResponse,
            }
          } catch (fbErr) {
            console.error(
              `[gemini:${opts.caller}] cross-provider fallback ALSO failed: ${(fbErr as Error).message?.slice(0, 160)}`
            )
            throw err // surface the original Gemini error
          }
        }

        // Transient error: log and decide whether to retry / fall back / give up
        if (!isLastTryThisModel) {
          // Will retry the same model after a backoff
          console.warn(
            `[gemini:${opts.caller}] transient error on ${modelName} (attempt ${attempt + 1}/${triesForThisModel}), retrying in ${retryDelayMs}ms: ${msg}`
          )
          await new Promise((r) => setTimeout(r, retryDelayMs))
        } else if (!isLastModel) {
          // Will fall back to next model in the chain
          const nextModel = models[modelIdx + 1]
          console.warn(
            `[gemini:${opts.caller}] ${modelName} exhausted, falling back to ${nextModel}: ${msg}`
          )
          // No backoff between models -- fallback is immediate
        } else {
          // No more models to try
          console.warn(
            `[gemini:${opts.caller}] ALL MODELS FAILED (last: ${modelName}): ${msg}`
          )
        }
      }
    }
  }

  // If we got here, every model in the chain failed. Before giving up, try a
  // DIFFERENT provider entirely — a Gemini 503 storm shouldn't take out the
  // Scout/verifier. Grounded calls fall to Sonar; non-grounded to OpenAI.
  try {
    const fb = await geminiCrossProviderFallback({
      prompt: opts.prompt,
      caller: opts.caller,
      grounded: opts.useGoogleSearchGrounding,
      maxOutputTokens: opts.maxOutputTokens,
      temperature: opts.temperature,
    })
    return {
      text: fb.text,
      modelUsed: fb.modelUsed,
      attemptsMade: models.length + 1,
      elapsedMs: Date.now() - startedAt,
      rawResponse: fb.rawResponse,
    }
  } catch (fbErr) {
    console.error(
      `[gemini:${opts.caller}] cross-provider fallback failed: ` +
      (fbErr instanceof Error ? fbErr.message : String(fbErr)),
    )
    throw lastError ?? new Error(`[gemini-helper:${opts.caller}] all models failed`)
  }
}

// Cross-provider backstop. When the entire Gemini chain fails (typically a 503
// overload storm), fall back to a DIFFERENT provider so the pipeline keeps
// running instead of losing the Scout / verifier entirely:
//   • grounded (live web search) calls → Perplexity Sonar (PERPLEXITY_API_KEY)
//   • non-grounded calls               → OpenAI gpt-5-mini class (OPENAI_API_KEY)
// Returns the text, which model answered, and (for grounded) the Sonar grounding
// shape so the verifier's credible-source check still works. Throws if no
// fallback provider is configured or it also fails — the caller then surfaces
// the original Gemini error.
export async function geminiCrossProviderFallback(opts: {
  prompt: string
  caller: string
  grounded?: boolean
  maxOutputTokens?: number
  temperature?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<{ text: string; modelUsed: string; rawResponse?: any }> {
  if (opts.grounded && process.env.PERPLEXITY_API_KEY) {
    const { searchWithSonar } = await import('./perplexity-helper')
    const r = await searchWithSonar({
      prompt: opts.prompt,
      caller: `${opts.caller}:fallback`,
      maxOutputTokens: opts.maxOutputTokens,
      temperature: opts.temperature,
      useGoogleSearchGrounding: true,
    })
    console.warn(`[${opts.caller}] Gemini down → Sonar fallback (${r.modelUsed})`)
    return { text: r.text, modelUsed: r.modelUsed, rawResponse: r.rawResponse }
  }
  // Non-grounded: prefer Claude (a different vendor + billing from Gemini), so a
  // Gemini account-level outage can't take the council down. OpenAI remains as a
  // deeper safety net below if Anthropic isn't configured or also fails.
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const model =
        process.env.GEMINI_FALLBACK_CLAUDE_MODEL ??
        process.env.ANTHROPIC_SONNET_MODEL ??
        'claude-sonnet-4-6'
      const resp = await client.messages.create({
        model,
        max_tokens: opts.maxOutputTokens ?? 4000,
        temperature: opts.temperature ?? 0.1,
        messages: [{ role: 'user', content: opts.prompt }],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = resp.content
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((b: any) => (b?.type === 'text' ? b.text : ''))
        .join('')
        .trim()
      console.warn(`[${opts.caller}] Gemini down → Claude fallback (${model})`)
      return { text, modelUsed: model }
    } catch (claudeErr) {
      console.warn(
        `[${opts.caller}] Claude fallback failed (${(claudeErr as Error).message?.slice(0, 120)}), trying OpenAI`
      )
      // fall through to OpenAI
    }
  }
  if (process.env.OPENAI_API_KEY) {
    const { openaiChat } = await import('./pipeline/llm')
    const model = process.env.GEMINI_FALLBACK_OPENAI_MODEL ?? 'gpt-5.4-mini'
    const completion = await openaiChat({
      model,
      messages: [{ role: 'user', content: opts.prompt }],
      maxTokens: opts.maxOutputTokens ?? 4000,
      temperature: opts.temperature ?? 0.1,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (completion as any)?.choices?.[0]?.message?.content ?? ''
    console.warn(`[${opts.caller}] Gemini down → OpenAI fallback (${model})`)
    return { text, modelUsed: model }
  }
  throw new Error(`[${opts.caller}] Gemini chain failed and no cross-provider fallback configured`)
}

// Convenience wrapper that matches the most common call pattern:
// "give me JSON-parseable text out of a prompt"
export async function generateJSON<T = unknown>(
  opts: Omit<GeminiCallOptions, 'responseMimeType'> & { responseMimeType?: never }
): Promise<{ data: T; modelUsed: string; attemptsMade: number; elapsedMs: number }> {
  const result = await generateWithFallback({
    ...opts,
    responseMimeType: 'application/json',
  })

  // Try direct parse first (responseMimeType: 'application/json' should yield clean JSON,
  // but some models still emit markdown fences when grounding is enabled, so we
  // strip them defensively).
  const cleaned = result.text.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')

  let data: T
  try {
    if (start === -1 || end === -1) {
      // No JSON object found at all
      data = JSON.parse(cleaned) as T  // will throw, which we catch below
    } else {
      data = JSON.parse(cleaned.slice(start, end + 1)) as T
    }
  } catch (e) {
    throw new Error(
      `[gemini-helper:${opts.caller}] JSON parse failed (model=${result.modelUsed}): ${(e as Error).message}`
    )
  }

  return {
    data,
    modelUsed: result.modelUsed,
    attemptsMade: result.attemptsMade,
    elapsedMs: result.elapsedMs,
  }
}