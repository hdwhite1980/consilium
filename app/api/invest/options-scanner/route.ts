// ═════════════════════════════════════════════════════════════
// app/api/debug/tradier/route.ts
//
// TEMPORARY diagnostic endpoint. Shows what the code actually sees
// for TRADIER_API_KEY and attempts a live auth test. Delete this file
// once the Tradier auth issue is resolved.
//
// GET /api/debug/tradier
//
// Returns:
//   - Whether the env var is set
//   - Length of the key value (not the key itself)
//   - First + last 3 chars of key (for verification without leaking)
//   - Whether key has suspicious whitespace
//   - Live test result against /markets/quotes?symbols=AAPL
//   - Base URL being used (sandbox vs production)
// ═════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server'

export async function GET() {
  const rawKey = process.env.TRADIER_API_KEY
  const env = (process.env.TRADIER_ENV ?? 'sandbox').toLowerCase()
  const baseUrl = env === 'production' ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1'

  // ── Diagnose the key itself ─────────────────────────────────
  const diagnosis: {
    keySet: boolean
    keyLength: number | null
    keyPreview: string | null
    hasLeadingWhitespace: boolean
    hasTrailingWhitespace: boolean
    hasInternalWhitespace: boolean
    hasNonPrintable: boolean
    env: string
    baseUrl: string
  } = {
    keySet: !!rawKey,
    keyLength: rawKey ? rawKey.length : null,
    keyPreview: rawKey && rawKey.length >= 6
      ? `${rawKey.slice(0, 3)}...${rawKey.slice(-3)}`
      : rawKey ? '(too short)' : null,
    hasLeadingWhitespace: rawKey ? /^\s/.test(rawKey) : false,
    hasTrailingWhitespace: rawKey ? /\s$/.test(rawKey) : false,
    hasInternalWhitespace: rawKey ? /\s/.test(rawKey.trim()) : false,
    hasNonPrintable: rawKey ? /[^\x20-\x7E]/.test(rawKey) : false,
    env,
    baseUrl,
  }

  // ── Live auth test with untrimmed key (as code sees it) ─────
  let liveTestRaw: {
    status: number | string
    body: string
    headers: Record<string, string>
  } = { status: 'not_attempted', body: '', headers: {} }

  if (rawKey) {
    try {
      const res = await fetch(`${baseUrl}/markets/quotes?symbols=AAPL`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${rawKey}`,
          Accept: 'application/json',
        },
      })
      const bodyText = await res.text()
      liveTestRaw = {
        status: res.status,
        body: bodyText.slice(0, 500),
        headers: {
          'content-type': res.headers.get('content-type') ?? '',
          'x-ratelimit-allowed': res.headers.get('x-ratelimit-allowed') ?? '',
          'x-ratelimit-used': res.headers.get('x-ratelimit-used') ?? '',
          'www-authenticate': res.headers.get('www-authenticate') ?? '',
        },
      }
    } catch (e) {
      liveTestRaw = { status: 'fetch_error', body: (e as Error).message.slice(0, 200), headers: {} }
    }
  }

  // ── Also test with TRIMMED key (in case whitespace is the issue) ─
  let liveTestTrimmed: {
    status: number | string
    body: string
  } = { status: 'not_attempted', body: '' }

  if (rawKey && (diagnosis.hasLeadingWhitespace || diagnosis.hasTrailingWhitespace)) {
    try {
      const trimmed = rawKey.trim()
      const res = await fetch(`${baseUrl}/markets/quotes?symbols=AAPL`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${trimmed}`,
          Accept: 'application/json',
        },
      })
      const bodyText = await res.text()
      liveTestTrimmed = {
        status: res.status,
        body: bodyText.slice(0, 300),
      }
    } catch (e) {
      liveTestTrimmed = { status: 'fetch_error', body: (e as Error).message.slice(0, 200) }
    }
  }

  return NextResponse.json({
    diagnosis,
    liveTestRaw,
    liveTestTrimmedIfWhitespace: liveTestTrimmed,
    interpretation: buildInterpretation(diagnosis, liveTestRaw, liveTestTrimmed),
    timestamp: new Date().toISOString(),
  }, { status: 200 })
}

function buildInterpretation(
  diag: ReturnType<typeof GET> extends Promise<infer R> ? R : never,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trimmed: any,
): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = diag as any
  if (!d.keySet) {
    return '❌ TRADIER_API_KEY is NOT set in the environment. Railway variable missing or not applied to running deployment.'
  }
  if (d.keyLength < 10) {
    return `❌ TRADIER_API_KEY is set but only ${d.keyLength} chars long. Tradier tokens are typically 28+ chars. You may have pasted an account number instead of the access token.`
  }
  if (d.hasLeadingWhitespace || d.hasTrailingWhitespace) {
    if (trimmed?.status === 200) {
      return `⚠️ TRADIER_API_KEY has whitespace. RAW version fails but TRIMMED works. Fix: re-save the Railway variable without leading/trailing spaces.`
    }
    return `⚠️ TRADIER_API_KEY has whitespace. Neither raw nor trimmed work — the token itself may also be invalid.`
  }
  if (d.hasNonPrintable) {
    return `⚠️ TRADIER_API_KEY contains non-printable characters. Re-paste the token from tradier.com.`
  }
  if (raw?.status === 200) {
    return '✅ TRADIER_API_KEY works. Auth passes against Tradier. If scanner still fails, the issue is elsewhere.'
  }
  if (raw?.status === 401) {
    return '❌ TRADIER_API_KEY is set but Tradier rejects it (401 Unauthorized). Either the token is invalid/revoked or it\'s for the wrong environment (sandbox token used in production or vice versa).'
  }
  if (raw?.status === 403) {
    return '❌ TRADIER_API_KEY rejected (403 Forbidden). Token may have been revoked or account suspended.'
  }
  return `⚠️ Unexpected status: ${raw?.status}. See liveTestRaw.body for details.`
}
