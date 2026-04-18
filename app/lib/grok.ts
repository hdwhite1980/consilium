// ─────────────────────────────────────────────────────────────
// Grok (xAI) client — privacy-minded defaults
// ─────────────────────────────────────────────────────────────
//
// IMPORTANT privacy/ToS notes — verify each before production:
// 1. Data retention: Check https://x.ai/legal — confirm xAI does NOT train
//    on API traffic by default, or confirm opt-out is enabled on your account.
// 2. Live search entitlement: The real-time X data feature requires the
//    'live-search' or 'x-search' tool to be enabled on your xAI tier.
//    If unavailable, Grok falls back to training-data knowledge only.
// 3. Pricing: Grok 4.20 is ~$2/M input tokens, $6/M output. Check current.
//
// The prompts below deliberately do NOT reveal:
//   - The app name (Wali-OS)
//   - Our multi-model architecture
//   - Our competitive positioning
//   - Other models' outputs
//
// We only send: ticker, public price, current timestamp, and a generic
// instruction to return sentiment JSON.
//
// ─────────────────────────────────────────────────────────────

import OpenAI from 'openai'

// Grok uses OpenAI SDK format with a different base URL.
// Reusing the SDK is the officially documented pattern from xAI.
function getGrok() {
  const key = process.env.XAI_API_KEY
  if (!key) throw new Error('XAI_API_KEY not set')
  return new OpenAI({
    apiKey: key,
    baseURL: 'https://api.x.ai/v1',
  })
}

// Model selection. If a model name becomes unavailable, try the fallback.
// Order: try the most capable first, fall back to general-purpose.
const GROK_MODELS = [
  'grok-4-20-0309',   // reasoning-tier, best for sentiment synthesis
  'grok-4-20',        // general tier
  'grok-4',           // older fallback
]

export interface GrokCallOptions {
  temperature?: number
  maxTokens?: number
  searchEnabled?: boolean  // enable live X search tool
  timeoutMs?: number
}

/**
 * Call Grok with OpenAI-SDK-compatible messages.
 * Returns the raw string content. Parsing is the caller's responsibility.
 *
 * On error, throws. Callers should catch and provide fallback behavior —
 * Social Scout should never block the debate if Grok is unavailable.
 */
export async function callGrok(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: GrokCallOptions = {}
): Promise<string> {
  const {
    temperature = 0.3,
    maxTokens = 1200,
    searchEnabled = true,
    timeoutMs = 45000,
  } = opts

  const client = getGrok()
  let lastError: Error | null = null

  for (const model of GROK_MODELS) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      // Build the request. xAI supports OpenAI's chat.completions shape.
      // The `search_parameters` object below is xAI-specific — it tells
      // Grok to use live web/X search. If the model on this tier doesn't
      // support it, the call still succeeds without live data.
      const requestBody: Record<string, unknown> = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }

      if (searchEnabled) {
        // xAI's native live-search parameter. Safe to include even if tier
        // doesn't support it — xAI ignores unknown fields gracefully.
        requestBody.search_parameters = {
          mode: 'on',
          sources: [
            { type: 'x' },       // X (Twitter) posts
            { type: 'web' },     // general web (news, blogs)
          ],
          max_search_results: 20,
        }
      }

      // Use the raw fetch path since we're passing xAI-specific params.
      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        throw new Error(`Grok API ${response.status}: ${errBody.slice(0, 200)}`)
      }

      const data = await response.json()
      const content = data?.choices?.[0]?.message?.content
      if (!content || typeof content !== 'string') {
        throw new Error('Grok returned empty content')
      }
      return content
    } catch (e) {
      lastError = e as Error
      const msg = (e as Error).message ?? ''
      const isLastModel = model === GROK_MODELS[GROK_MODELS.length - 1]
      if (isLastModel) throw e
      console.warn(`[grok] model ${model} failed (${msg.slice(0, 80)}), trying next...`)
    }
    // unused var workaround for the SDK import — keep it so future
    // code can switch to `client.chat.completions.create(...)` if needed
    void client
  }

  throw lastError ?? new Error('Grok unavailable — all models failed')
}
