// =============================================================
// app/lib/perplexity-helper.ts
//
// Perplexity Sonar adapter for the grounded (live-web) Council roles —
// verification / fact-check. Sonar is search-native: it retrieves from the
// live web on every call and returns citations, with a much lower citation-
// hallucination rate than Gemini grounding. That makes it the better fit for
// the verification layer of a trading system, where a hallucinated "source"
// can wave through a false claim into a verdict.
//
// Drop-in by design: searchWithSonar() takes the SAME GeminiCallOptions and
// returns the SAME GeminiCallResult shape as generateWithFallback(), and it
// maps Sonar's citations into the Gemini groundingMetadata shape the
// verification layer already inspects (rawResponse.candidates[0]
// .groundingMetadata.groundingChunks[].web.{uri,title}). So no call site or
// downstream credible-source check has to change.
//
// Enabled per-call via generate-helper delegation when SEARCH_PROVIDER=sonar.
// Requires PERPLEXITY_API_KEY. Rollback = unset SEARCH_PROVIDER (back to Gemini).
//
// Perplexity exposes an OpenAI-compatible API, so we reuse the OpenAI SDK
// pointed at api.perplexity.ai rather than adding a new dependency.
// =============================================================

import OpenAI from 'openai'
import type { GeminiCallOptions, GeminiCallResult } from './gemini-helper'

// Sonar model chain (env-overridable). Defaults are the NON-reasoning Sonar
// models on purpose: they return clean JSON for the verification prompts.
// sonar-reasoning* models emit a <think> block first, which can confuse the
// brace-extraction parser in verification.ts — set SONAR_MODEL=sonar-reasoning-pro
// only if you've confirmed the parser tolerates it.
const SONAR_MODEL          = process.env.SONAR_MODEL          ?? 'sonar-pro'
const SONAR_FALLBACK_MODEL = process.env.SONAR_FALLBACK_MODEL ?? 'sonar'

const SONAR_TIMEOUT_MS = 90_000

let _pplx: OpenAI | null = null
function pplx(): OpenAI {
  if (!_pplx) {
    _pplx = new OpenAI({
      apiKey: process.env.PERPLEXITY_API_KEY,
      baseURL: 'https://api.perplexity.ai',
      maxRetries: 2,
      timeout: SONAR_TIMEOUT_MS,
      defaultHeaders: { 'accept-encoding': 'identity' },  // see llm.ts note — gzip streams truncating
    })
  }
  return _pplx
}

// Map Sonar's citations / search_results into the exact shape the verification
// layer reads off a Gemini grounded response, so the downstream credible-source
// inspection works unchanged. Perplexity returns either `search_results`
// (array of {title,url,date}) or `citations` (array of URL strings) as extra
// fields on the completion object (not in the OpenAI SDK type — hence `any`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toGeminiGroundingShape(resp: any): any {
  const searchResults: Array<{ url?: string; title?: string }> =
    Array.isArray(resp?.search_results)
      ? resp.search_results
      : Array.isArray(resp?.citations)
        ? resp.citations.map((u: string) => ({ url: u, title: u }))
        : []
  const groundingChunks = searchResults
    .map((r) => ({ web: { uri: r?.url ?? '', title: r?.title ?? r?.url ?? '' } }))
    .filter((c) => c.web.uri || c.web.title)
  return { candidates: [{ groundingMetadata: { groundingChunks } }] }
}

export async function searchWithSonar(opts: GeminiCallOptions): Promise<GeminiCallResult> {
  const started = Date.now()
  const chain = opts.models ?? [SONAR_MODEL, SONAR_FALLBACK_MODEL]
  let lastErr: unknown
  let attempts = 0

  for (const model of chain) {
    attempts++
    try {
      // Sonar is search-native — there is no grounding flag; it always
      // retrieves. Only send temperature to non-reasoning Sonar models; the
      // reasoning variants reject a custom temperature (same pattern as the
      // GPT-5 / Opus-4.8 deprecations).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = {
        model,
        messages: [{ role: 'user', content: opts.prompt }],
        max_tokens: opts.maxOutputTokens ?? 4000,
      }
      if (!/reasoning/i.test(model)) {
        params.temperature = opts.temperature ?? 0.1
      }

      const completion = await pplx().chat.completions.create(params)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const text = (completion as any)?.choices?.[0]?.message?.content ?? ''
      const elapsedMs = Date.now() - started
      console.log(`[sonar:${opts.caller}] OK ${model} in ${elapsedMs}ms`)
      return {
        text,
        modelUsed: model,
        attemptsMade: attempts,
        elapsedMs,
        rawResponse: toGeminiGroundingShape(completion),
      }
    } catch (e) {
      lastErr = e
      console.warn(
        `[sonar:${opts.caller}] ${model} failed (attempt ${attempts}/${chain.length}): ` +
        (e instanceof Error ? e.message : String(e)),
      )
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`searchWithSonar(${opts.caller}) exhausted all models`)
}
