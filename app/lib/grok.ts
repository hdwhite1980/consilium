// ─────────────────────────────────────────────────────────────
// Grok (xAI) client — Responses API with Agent Tools
// ─────────────────────────────────────────────────────────────
//
// Updated April 2026: xAI migrated from the Chat Completions Live
// Search to the new Responses API with built-in tools. The old
// `search_parameters` field was deprecated January 12, 2026 (returns
// HTTP 410). We now POST to /v1/responses with `tools: [{type:"x_search"}]`.
//
// IMPORTANT privacy/ToS notes — verify each before production:
// 1. Data retention: Check https://x.ai/legal — confirm xAI does NOT
//    train on API traffic by default, or confirm opt-out is enabled
//    on your account.
// 2. Tool pricing: Built-in tools (x_search, web_search) are billed
//    separately from tokens. Check console.x.ai usage.
// 3. Model availability: grok-4.20-reasoning requires appropriate tier.
//
// The prompts below deliberately do NOT reveal:
//   - The app name (Wali-OS)
//   - Our multi-model architecture
//   - Our competitive positioning
//   - Other models' outputs
//
// ─────────────────────────────────────────────────────────────

// Model fallback chain. Try the strongest first, degrade gracefully.
// Names verified from xAI docs April 2026.
const GROK_MODELS = [
  'grok-4.20-reasoning',       // flagship reasoning model with tools
  'grok-4-1-fast-reasoning',   // faster tier
  'grok-4',                    // older fallback (may not support tools)
]

export interface GrokCallOptions {
  temperature?: number
  maxTokens?: number
  searchEnabled?: boolean   // enable built-in x_search + web_search tools
  timeoutMs?: number
}

/**
 * Extract assistant text from the xAI Responses API response.
 *
 * The Responses API returns an `output` array containing items of
 * different types (message, tool_use, tool_result). We want the
 * final message item with role: "assistant" and its text content.
 *
 * Defensive: the shape may vary slightly across model versions —
 * we walk the whole output looking for anything usable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAssistantText(data: any): string {
  // Path 1 (newest): output array with message items
  if (Array.isArray(data?.output)) {
    // Find the last assistant message
    for (let i = data.output.length - 1; i >= 0; i--) {
      const item = data.output[i]
      if (item?.type === 'message' && item?.role === 'assistant') {
        // content is an array of blocks; concat all text blocks
        if (Array.isArray(item.content)) {
          const text = item.content
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((b: any) => b?.type === 'output_text' || b?.type === 'text')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((b: any) => b?.text ?? '')
            .join('')
          if (text) return text
        }
        if (typeof item.content === 'string' && item.content.length > 0) {
          return item.content
        }
      }
    }
  }

  // Path 2 (convenience): output_text at top level (SDK convenience field)
  if (typeof data?.output_text === 'string' && data.output_text.length > 0) {
    return data.output_text
  }

  // Path 3 (fallback): legacy chat-completions shape, just in case
  const legacy = data?.choices?.[0]?.message?.content
  if (typeof legacy === 'string' && legacy.length > 0) return legacy

  throw new Error('No assistant text found in Grok response')
}

/**
 * Call Grok using the Responses API. Built-in tools (x_search,
 * web_search) are enabled by default so Grok can pull live data.
 *
 * Returns the raw text content. JSON parsing is caller's job.
 * Throws on failure — callers should catch and fall back.
 */
export async function callGrok(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: GrokCallOptions = {}
): Promise<string> {
  const {
    temperature = 0.3,
    maxTokens = 1500,
    searchEnabled = true,
    timeoutMs = 60000,
  } = opts

  const apiKey = process.env.XAI_API_KEY
  if (!apiKey) throw new Error('XAI_API_KEY not set')

  let lastError: Error | null = null

  for (const model of GROK_MODELS) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

      // Responses API payload shape:
      //   - `input` (not `messages`)
      //   - `max_output_tokens` (not `max_tokens`)
      //   - `tools` array with built-in tool types
      const requestBody: Record<string, unknown> = {
        model,
        input: messages.map(m => ({ role: m.role, content: m.content })),
        temperature,
        max_output_tokens: maxTokens,
      }

      if (searchEnabled) {
        // Built-in tools — xAI executes these server-side and folds
        // results into the model's context automatically. We get back
        // citations in the response we can optionally surface later.
        requestBody.tools = [
          { type: 'x_search' },
          { type: 'web_search' },
        ]
      }

      const response = await fetch('https://api.x.ai/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        throw new Error(`Grok API ${response.status}: ${errBody.slice(0, 300)}`)
      }

      const data = await response.json()
      return extractAssistantText(data)
    } catch (e) {
      lastError = e as Error
      const msg = (e as Error).message ?? ''
      const isLastModel = model === GROK_MODELS[GROK_MODELS.length - 1]
      if (isLastModel) throw e
      console.warn(`[grok] model ${model} failed (${msg.slice(0, 100)}), trying next...`)
    }
  }

  throw lastError ?? new Error('Grok unavailable — all models failed')
}
