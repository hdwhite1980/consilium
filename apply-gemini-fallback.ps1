# =============================================================
# apply-gemini-fallback.ps1
#
# Atomic patch:
#   1. Creates app/lib/gemini-helper.ts (new file, ~325 lines)
#   2. Patches app/lib/verification.ts:
#        - Add import for generateWithFallback / generateJSON
#        - Migrate extractFactualClaims to use generateJSON
#        - Migrate batchVerifyClaims to use generateWithFallback
#   3. Patches app/lib/pipeline.ts:
#        - Add import for generateWithFallback
#        - Migrate runJudgeGemini
#        - Migrate calibrated re-run
#   4. Patches app/api/tomorrow/route.ts:
#        - Add import for generateWithFallback
#        - Migrate verifyWatchlistWithGemini
#
# All 5 call sites switch from direct gemini-2.5-pro calls to the
# helper, gaining: retry on transient errors, automatic Pro->Flash
# fallback, and structured logging per call site.
#
# Pure ASCII script. Idempotent (won't double-apply).
# Preserves original line endings of each file (verification + tomorrow
# are LF, pipeline is CRLF).
#
# Usage:
#   .\apply-gemini-fallback.ps1          (dry run)
#   .\apply-gemini-fallback.ps1 -Apply   (write changes)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

# Files
$HelperFile      = 'app\lib\gemini-helper.ts'
$VerificationFile = 'app\lib\verification.ts'
$PipelineFile    = 'app\lib\pipeline.ts'
$TomorrowFile    = 'app\api\tomorrow\route.ts'

foreach ($f in @($VerificationFile, $PipelineFile, $TomorrowFile)) {
    if (-not (Test-Path $f)) {
        Write-Host "ERROR: $f not found. Run from repo root." -ForegroundColor Red
        exit 1
    }
}

# Sync .NET CWD with PowerShell location for [System.IO.File] calls
[System.Environment]::CurrentDirectory = (Get-Location).Path

# === Helpers ===================================================
function Bytes-IndexOf([byte[]]$haystack, [byte[]]$needle) {
    if ($needle.Length -gt $haystack.Length) { return -1 }
    for ($i = 0; $i -le ($haystack.Length - $needle.Length); $i++) {
        $match = $true
        for ($j = 0; $j -lt $needle.Length; $j++) {
            if ($haystack[$i + $j] -ne $needle[$j]) { $match = $false; break }
        }
        if ($match) { return $i }
    }
    return -1
}

function Bytes-CountOccurrences([byte[]]$haystack, [byte[]]$needle) {
    if ($needle.Length -gt $haystack.Length) { return 0 }
    $count = 0
    $i = 0
    while ($i -le ($haystack.Length - $needle.Length)) {
        $match = $true
        for ($j = 0; $j -lt $needle.Length; $j++) {
            if ($haystack[$i + $j] -ne $needle[$j]) { $match = $false; break }
        }
        if ($match) {
            $count++
            $i += $needle.Length
        } else {
            $i++
        }
    }
    return $count
}

function Bytes-ReplaceFirst([byte[]]$haystack, [byte[]]$needle, [byte[]]$replacement) {
    $idx = Bytes-IndexOf $haystack $needle
    if ($idx -lt 0) { return $null }
    $before = if ($idx -gt 0) { $haystack[0..($idx - 1)] } else { @() }
    $afterStart = $idx + $needle.Length
    $after = if ($afterStart -lt $haystack.Length) { $haystack[$afterStart..($haystack.Length - 1)] } else { @() }
    $result = New-Object byte[] ($before.Length + $replacement.Length + $after.Length)
    [Array]::Copy($before, 0, $result, 0, $before.Length)
    [Array]::Copy($replacement, 0, $result, $before.Length, $replacement.Length)
    if ($after.Length -gt 0) {
        [Array]::Copy($after, 0, $result, $before.Length + $replacement.Length, $after.Length)
    }
    return ,$result
}

# === Helper file content =======================================
# This is the full app/lib/gemini-helper.ts written using a single-quoted
# heredoc so the backticks and ${} stay literal (we don't want PS to
# interpret them). The file is created if it doesn't exist; if it exists
# and matches, we skip; if it differs, we error out (don't silently overwrite).

$HelperContent = @'
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

  const modelConfig: Record<string, unknown> = { model: modelName }
  if (Object.keys(generationConfig).length > 0) modelConfig.generationConfig = generationConfig
  if (tools.length > 0) modelConfig.tools = tools

  const model = getGenAI().getGenerativeModel(modelConfig)
  return model.generateContent(opts.prompt)
}

// Main entry point: generate with retry + fallback
export async function generateWithFallback(
  opts: GeminiCallOptions
): Promise<GeminiCallResult> {
  const models = opts.models ?? ['gemini-2.5-pro', 'gemini-2.5-flash']
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

        // Permanent errors (auth, bad input, etc.): don't retry, don't fall back
        if (!isTransientError(err)) {
          console.warn(
            `[gemini:${opts.caller}] PERMANENT error on ${modelName}: ${msg}`
          )
          throw err
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

  // If we got here, every model in the chain failed
  throw lastError ?? new Error(`[gemini-helper:${opts.caller}] all models failed`)
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
'@

# === Helper file: create or verify ============================
$writeHelper = $false
if (Test-Path $HelperFile) {
    # Already exists - check if it's the same
    $existing = [System.IO.File]::ReadAllText($HelperFile)
    # Normalize line endings for comparison
    $existingNorm = $existing -replace "`r`n", "`n"
    $expectedNorm = $HelperContent -replace "`r`n", "`n"
    if ($existingNorm -eq $expectedNorm) {
        Write-Host "  [skip] $HelperFile (already present, content matches)" -ForegroundColor DarkGray
    } else {
        Write-Host "  [WARN] $HelperFile exists but differs from expected content" -ForegroundColor Yellow
        Write-Host "         Skipping helper write to avoid clobbering local changes" -ForegroundColor Yellow
        Write-Host "         Migrations below assume the existing file exports generateWithFallback / generateJSON" -ForegroundColor Yellow
    }
} else {
    $writeHelper = $true
}

# === Patches ===================================================
$encoder = [System.Text.Encoding]::UTF8
$patches = @()

# verification.ts uses LF line endings
$LF = "`n"

# verification.ts: import
$patches += @{
    File = $VerificationFile
    Name = 'verification: import generateWithFallback / generateJSON'
    Marker = "import { generateWithFallback, generateJSON } from './gemini-helper'"
    Old = "import { GoogleGenerativeAI } from '@google/generative-ai'${LF}import { createClient } from '@supabase/supabase-js'${LF}"
    New = "import { GoogleGenerativeAI } from '@google/generative-ai'${LF}import { generateWithFallback, generateJSON } from './gemini-helper'${LF}import { createClient } from '@supabase/supabase-js'${LF}"
}

# verification.ts: extractFactualClaims
$patches += @{
    File = $VerificationFile
    Name = 'verification: extractFactualClaims migration'
    Marker = "caller: 'verification:claim-extract'"
    Old = "  try {${LF}    const model = getGenAI().getGenerativeModel({${LF}      model: 'gemini-2.5-pro',${LF}      generationConfig: {${LF}        temperature: 0.1,${LF}        maxOutputTokens: 4000,${LF}        responseMimeType: 'application/json',${LF}      },${LF}    })${LF}    const result = await model.generateContent(prompt)${LF}    const text = result.response.text()${LF}    const parsed = JSON.parse(text)${LF}    const claims = Array.isArray(parsed.claims) ? parsed.claims : []${LF}    return claims${LF}      .filter((c: unknown) => typeof c === 'string' && c.length > 10)${LF}      .map((c: string) => c.trim().slice(0, 400))${LF}      .slice(0, 8)${LF}  } catch (e) {${LF}    console.warn('[verification] claim extraction failed:', (e as Error).message?.slice(0, 200))${LF}    return []${LF}  }${LF}}"
    New = "  try {${LF}    const { data: parsed } = await generateJSON<{ claims?: unknown[] }>({${LF}      prompt,${LF}      caller: 'verification:claim-extract',${LF}      temperature: 0.1,${LF}      maxOutputTokens: 4000,${LF}    })${LF}    const claims = Array.isArray(parsed.claims) ? parsed.claims : []${LF}    return claims${LF}      .filter((c: unknown) => typeof c === 'string' && c.length > 10)${LF}      .map((c: string) => (c as string).trim().slice(0, 400))${LF}      .slice(0, 8)${LF}  } catch (e) {${LF}    console.warn('[verification] claim extraction failed:', (e as Error).message?.slice(0, 200))${LF}    return []${LF}  }${LF}}"
}

# verification.ts: batchVerifyClaims
# NOTE: The original code has a Unicode em-dash (U+2014) in the line:
#   "// Google Search grounding -- critical for verification"
# We pre-normalize that em-dash to ASCII '---' at the top of the script,
# so the anchor below uses ASCII '---' (3 dashes) instead.
$patches += @{
    File = $VerificationFile
    Name = 'verification: batchVerifyClaims migration'
    Marker = "caller: 'verification:batch-verify'"
    Old = "  try {${LF}    const model = getGenAI().getGenerativeModel({${LF}      model: 'gemini-2.5-pro',${LF}      generationConfig: {${LF}        temperature: 0.1,${LF}        maxOutputTokens: 6000,${LF}      },${LF}      // Google Search grounding --- critical for verification${LF}      // eslint-disable-next-line @typescript-eslint/no-explicit-any${LF}      tools: [{ googleSearch: {} } as any],${LF}    })${LF}${LF}    const result = await model.generateContent(prompt)${LF}    const text = result.response.text()${LF}${LF}    // Parse JSON out of response (it may have markdown fences)${LF}    const cleaned = text.replace(/``````json|``````/g, '').trim()${LF}    const start = cleaned.indexOf('{')${LF}    const end = cleaned.lastIndexOf('}')${LF}    if (start === -1 || end === -1) {${LF}      console.warn('[verification] no JSON in batch verify response')${LF}      return claims.map((c) => ({${LF}        claim: c, verified: false, sourceUrl: null, sourceOutlet: null,${LF}        reasoning: 'Verification response had no parseable JSON',${LF}      }))${LF}    }${LF}${LF}    const parsed = JSON.parse(cleaned.slice(start, end + 1))${LF}    const verifications = Array.isArray(parsed.verifications) ? parsed.verifications : []${LF}${LF}    // Inspect groundingMetadata for an independent check on sources${LF}    // eslint-disable-next-line @typescript-eslint/no-explicit-any${LF}    const meta = (result.response.candidates?.[0] as any)?.groundingMetadata as GroundingMetadata | undefined"
    New = "  try {${LF}    const { text, rawResponse } = await generateWithFallback({${LF}      prompt,${LF}      caller: 'verification:batch-verify',${LF}      temperature: 0.1,${LF}      maxOutputTokens: 6000,${LF}      useGoogleSearchGrounding: true,${LF}    })${LF}${LF}    // Parse JSON out of response (it may have markdown fences even with grounding)${LF}    const cleaned = text.replace(/``````json|``````/g, '').trim()${LF}    const start = cleaned.indexOf('{')${LF}    const end = cleaned.lastIndexOf('}')${LF}    if (start === -1 || end === -1) {${LF}      console.warn('[verification] no JSON in batch verify response')${LF}      return claims.map((c) => ({${LF}        claim: c, verified: false, sourceUrl: null, sourceOutlet: null,${LF}        reasoning: 'Verification response had no parseable JSON',${LF}      }))${LF}    }${LF}${LF}    const parsed = JSON.parse(cleaned.slice(start, end + 1))${LF}    const verifications = Array.isArray(parsed.verifications) ? parsed.verifications : []${LF}${LF}    // Inspect groundingMetadata for an independent check on sources${LF}    // eslint-disable-next-line @typescript-eslint/no-explicit-any${LF}    const meta = (rawResponse?.candidates?.[0] as any)?.groundingMetadata as GroundingMetadata | undefined"
}

# pipeline.ts uses CRLF line endings
$CR = "`r`n"

# pipeline.ts: import
$patches += @{
    File = $PipelineFile
    Name = 'pipeline: import generateWithFallback'
    Marker = "import { generateWithFallback } from './gemini-helper'"
    Old = "import { GoogleGenerativeAI } from '@google/generative-ai'${CR}import { buildMacroIntelligenceContext } from './macro-intelligence'${CR}"
    New = "import { GoogleGenerativeAI } from '@google/generative-ai'${CR}import { generateWithFallback } from './gemini-helper'${CR}import { buildMacroIntelligenceContext } from './macro-intelligence'${CR}"
}

# pipeline.ts: runJudgeGemini
$patches += @{
    File = $PipelineFile
    Name = 'pipeline: runJudgeGemini migration'
    Marker = "caller: 'judge:draft'"
    Old = "  const model = getGenAI().getGenerativeModel({${CR}    model: 'gemini-2.5-pro',${CR}    generationConfig: {${CR}      temperature: 0.2,${CR}      maxOutputTokens: 8192,${CR}      responseMimeType: 'application/json',${CR}    },${CR}  })${CR}${CR}  const result = await model.generateContent(fullPrompt)${CR}  const text = result.response.text()${CR}  const raw = parseJSON<JudgeResult>(text)${CR}  return { ...raw, judgeModel: 'gemini-2.5-pro' }${CR}}"
    New = "  const { text, modelUsed } = await generateWithFallback({${CR}    prompt: fullPrompt,${CR}    caller: 'judge:draft',${CR}    temperature: 0.2,${CR}    maxOutputTokens: 8192,${CR}    responseMimeType: 'application/json',${CR}  })${CR}  const raw = parseJSON<JudgeResult>(text)${CR}  return { ...raw, judgeModel: modelUsed }${CR}}"
}

# pipeline.ts: calibrated re-run
$patches += @{
    File = $PipelineFile
    Name = 'pipeline: calibrated re-run migration'
    Marker = "caller: 'judge:calibrated-rerun'"
    Old = "    const model = getGenAI().getGenerativeModel({${CR}      model: 'gemini-2.5-pro',${CR}      generationConfig: {${CR}        temperature: 0.2,${CR}        maxOutputTokens: 8192,${CR}        responseMimeType: 'application/json',${CR}      },${CR}    })${CR}    const result = await model.generateContent(fullPrompt)${CR}    const text = result.response.text()${CR}    const raw = parseJSON<JudgeResult>(text)${CR}    return { ...raw, judgeModel: 'gemini-2.5-pro-calibrated' }"
    New = "    const { text, modelUsed } = await generateWithFallback({${CR}      prompt: fullPrompt,${CR}      caller: 'judge:calibrated-rerun',${CR}      temperature: 0.2,${CR}      maxOutputTokens: 8192,${CR}      responseMimeType: 'application/json',${CR}    })${CR}    const raw = parseJSON<JudgeResult>(text)${CR}    return { ...raw, judgeModel: ``${modelUsed}-calibrated`` }"
}

# tomorrow/route.ts uses LF line endings
# tomorrow: import
$patches += @{
    File = $TomorrowFile
    Name = 'tomorrow: import generateWithFallback'
    Marker = "import { generateWithFallback } from '@/app/lib/gemini-helper'"
    Old = "import { GoogleGenerativeAI } from '@google/generative-ai'${LF}import { createServerClient } from '@/app/lib/supabase'${LF}"
    New = "import { GoogleGenerativeAI } from '@google/generative-ai'${LF}import { generateWithFallback } from '@/app/lib/gemini-helper'${LF}import { createServerClient } from '@/app/lib/supabase'${LF}"
}

# tomorrow: verifyWatchlistWithGemini
$patches += @{
    File = $TomorrowFile
    Name = 'tomorrow: verifyWatchlistWithGemini migration'
    Marker = "caller: 'tomorrow:verify-watchlist'"
    Old = "  try {${LF}    const model = genAI.getGenerativeModel({${LF}      model: 'gemini-2.5-pro',${LF}      generationConfig: { temperature: 0.1, maxOutputTokens: 2500 },${LF}      // eslint-disable-next-line @typescript-eslint/no-explicit-any${LF}      tools: [{ googleSearch: {} } as any],${LF}    })${LF}    const result = await model.generateContent(prompt)${LF}    const text = result.response.text()${LF}    const clean = text.replace(/``````json|``````/g, '').trim()"
    New = "  try {${LF}    const { text } = await generateWithFallback({${LF}      prompt,${LF}      caller: 'tomorrow:verify-watchlist',${LF}      temperature: 0.1,${LF}      maxOutputTokens: 2500,${LF}      useGoogleSearchGrounding: true,${LF}    })${LF}    const clean = text.replace(/``````json|``````/g, '').trim()"
}

# === Pre-flight: dry-run verification ==========================
Write-Host ""
Write-Host "Pre-flight check (verifying all anchors)" -ForegroundColor Cyan
Write-Host ""

# Pre-normalize em-dashes for in-memory anchor matching during dry-run
# (Only modifies in-memory bytes for pre-flight; actual file write happens later)
$emDashBytes = [byte[]]@(0xE2, 0x80, 0x94)
$asciiDashBytes = [byte[]]@(0x2D, 0x2D, 0x2D)

$preflightOk = $true
$skipFiles = @{}  # file path -> true if all patches in this file already applied

foreach ($p in $patches) {
    $bytes = [System.IO.File]::ReadAllBytes($p.File)

    # Normalize in-memory only (don't write back during dry-run)
    while ((Bytes-IndexOf $bytes $emDashBytes) -ge 0) {
        $bytes = Bytes-ReplaceFirst $bytes $emDashBytes $asciiDashBytes
        if ($null -eq $bytes) { break }
    }

    $markerBytes = $encoder.GetBytes($p.Marker)
    $oldBytes = $encoder.GetBytes($p.Old)

    $markerCount = Bytes-CountOccurrences $bytes $markerBytes
    $oldCount = Bytes-CountOccurrences $bytes $oldBytes

    if ($markerCount -ge 1) {
        Write-Host "  [already] $($p.Name) (marker present)" -ForegroundColor DarkGray
    } elseif ($oldCount -eq 1) {
        Write-Host "  [ready]   $($p.Name)" -ForegroundColor Green
    } elseif ($oldCount -eq 0) {
        Write-Host "  [FAIL]    $($p.Name) - anchor not found, marker not present" -ForegroundColor Red
        $preflightOk = $false
    } else {
        Write-Host "  [FAIL]    $($p.Name) - anchor found $oldCount times (expected 1)" -ForegroundColor Red
        $preflightOk = $false
    }
}

if (-not $preflightOk) {
    Write-Host ""
    Write-Host "Pre-flight FAILED. Aborting." -ForegroundColor Red
    Write-Host "The live files differ from what these patches expect." -ForegroundColor Red
    Write-Host "(Did the files change since you uploaded them?)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Pre-flight OK. " -ForegroundColor Green -NoNewline
Write-Host "All anchors found exactly once."

if (-not $Apply) {
    Write-Host ""
    Write-Host "Dry run complete. Re-run with -Apply to write changes." -ForegroundColor Yellow
    exit 0
}

# === Apply =====================================================
Write-Host ""
Write-Host "Applying changes..." -ForegroundColor Cyan
Write-Host ""

# Step 0: Pre-normalize em-dash characters to ASCII '---' in verification.ts
# (The original file uses Unicode em-dash U+2014 in comments. Our anchors are pure ASCII,
# so we normalize at the byte level before applying patches. Idempotent: if the em-dashes
# are already '---', nothing changes.)
Write-Host "  Pre-normalizing Unicode characters in source files..." -ForegroundColor DarkGray

$normalizeFiles = @($VerificationFile, $PipelineFile, $TomorrowFile)
$emDashBytes = [byte[]]@(0xE2, 0x80, 0x94)
$asciiDashBytes = [byte[]]@(0x2D, 0x2D, 0x2D)  # '---' (3 ASCII bytes, same length)

foreach ($f in $normalizeFiles) {
    $bytes = [System.IO.File]::ReadAllBytes($f)
    $count = Bytes-CountOccurrences $bytes $emDashBytes
    if ($count -eq 0) {
        Write-Host "    $f - no em-dashes" -ForegroundColor DarkGray
        continue
    }

    # Replace ALL em-dash occurrences in this file
    $replaced = 0
    while ((Bytes-IndexOf $bytes $emDashBytes) -ge 0) {
        $bytes = Bytes-ReplaceFirst $bytes $emDashBytes $asciiDashBytes
        if ($null -eq $bytes) { break }
        $replaced++
    }
    [System.IO.File]::WriteAllBytes($f, $bytes)
    Write-Host "    $f - normalized $replaced em-dashes to '---'" -ForegroundColor DarkGray
}
Write-Host ""

# Step 1: Write helper file (if needed)
if ($writeHelper) {
    # Write as UTF-8 without BOM. Use LF for line endings (matches verification.ts style).
    $helperPath = Join-Path (Get-Location).Path $HelperFile
    $helperDir = Split-Path $helperPath -Parent
    if (-not (Test-Path $helperDir)) {
        New-Item -ItemType Directory -Path $helperDir -Force | Out-Null
    }
    $helperBytesContent = $HelperContent -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($helperPath, $helperBytesContent, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  [+] Created $HelperFile" -ForegroundColor Green
}

# Step 2: Apply patches per file
$fileGroups = @{}
foreach ($p in $patches) {
    if (-not $fileGroups.ContainsKey($p.File)) {
        $fileGroups[$p.File] = @()
    }
    $fileGroups[$p.File] += $p
}

$totalApplied = 0
$totalSkipped = 0

foreach ($file in $fileGroups.Keys) {
    Write-Host "  Patching $file" -ForegroundColor Cyan
    $bytes = [System.IO.File]::ReadAllBytes($file)
    $originalLength = $bytes.Length
    $appliedThisFile = 0

    foreach ($p in $fileGroups[$file]) {
        $markerBytes = $encoder.GetBytes($p.Marker)
        $markerCount = Bytes-CountOccurrences $bytes $markerBytes
        if ($markerCount -ge 1) {
            Write-Host "    [skip] $($p.Name)" -ForegroundColor DarkGray
            $totalSkipped++
            continue
        }

        $oldBytes = $encoder.GetBytes($p.Old)
        $newBytes = $encoder.GetBytes($p.New)
        $count = Bytes-CountOccurrences $bytes $oldBytes
        if ($count -ne 1) {
            Write-Host "    [FAIL] $($p.Name) - anchor count = $count" -ForegroundColor Red
            continue
        }

        $bytes = Bytes-ReplaceFirst $bytes $oldBytes $newBytes
        if ($null -eq $bytes) {
            Write-Host "    [FAIL] $($p.Name) - replace returned null" -ForegroundColor Red
            continue
        }
        Write-Host "    [+] $($p.Name)" -ForegroundColor Green
        $appliedThisFile++
        $totalApplied++
    }

    if ($appliedThisFile -gt 0) {
        [System.IO.File]::WriteAllBytes($file, $bytes)
        Write-Host "    Wrote $file ($($bytes.Length) bytes, was $originalLength)" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "Summary:" -ForegroundColor Cyan
Write-Host "  $totalApplied patches applied, $totalSkipped already-applied" -ForegroundColor White

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. npm run build" -ForegroundColor Gray
Write-Host "  2. git add -A && git commit -m 'feat(gemini): retry + Pro->Flash fallback for verification, judge, tomorrow'" -ForegroundColor Gray
Write-Host "  3. git push (Railway auto-deploys)" -ForegroundColor Gray
Write-Host "  4. Reproduce by running an analysis. Check Railway logs for [gemini:* lines." -ForegroundColor Gray
Write-Host "     During Google's overload events, you should now see:" -ForegroundColor Gray
Write-Host "       [gemini:judge:draft] transient error on gemini-2.5-pro (attempt 1/2), retrying..." -ForegroundColor DarkGray
Write-Host "       [gemini:judge:draft] OK after 2 attempts using 2.5-pro in 4250ms" -ForegroundColor DarkGray
Write-Host "     OR if Pro stays down:" -ForegroundColor Gray
Write-Host "       [gemini:judge:draft] gemini-2.5-pro exhausted, falling back to gemini-2.5-flash" -ForegroundColor DarkGray
Write-Host "       [gemini:judge:draft] OK after 3 attempts using 2.5-flash in 7100ms" -ForegroundColor DarkGray
