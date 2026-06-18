// =============================================================
// app/lib/admin/api-checks.ts
//
// Reachability checks for every external service Wali-OS connects
// to. Each check returns a standard ApiCheckResult shape that the
// admin UI can render uniformly.
//
// Design rules:
//   - Each check has its own short timeout (5s default, 8s for slow ones)
//   - Checks return null/error gracefully; never throw
//   - Checks should be safe to run repeatedly (no side effects)
//   - Each check returns latency in ms so we can spot degradation
//   - "Configured" means env var is set; "reachable" means upstream
//     answered 2xx; "degraded" means upstream answered but with
//     warnings (rate limit headers, slow response, etc.)
// =============================================================

export type ApiStatus = 'ok' | 'degraded' | 'down' | 'not_configured' | 'unknown'

export interface ApiCheckResult {
  id: string                  // stable key (e.g. 'finnhub')
  name: string                // display name (e.g. 'Finnhub')
  category: 'data' | 'ai' | 'broker' | 'infra' | 'comms'
  status: ApiStatus
  latencyMs: number | null    // null when not_configured or aborted
  httpStatus: number | null   // last HTTP status seen, if any
  message: string | null      // brief error/warning when not 'ok'
  checkedAt: string           // ISO timestamp of when this result was produced
}

// ─────────────────────────────────────────────────────────────
// Generic helpers
// ─────────────────────────────────────────────────────────────

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs = 5_000,
): Promise<{ res: Response | null; latencyMs: number; error: string | null }> {
  const start = Date.now()
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    return { res, latencyMs: Date.now() - start, error: null }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    return {
      res: null,
      latencyMs: Date.now() - start,
      error: err.length > 200 ? err.slice(0, 200) + '...' : err,
    }
  } finally {
    clearTimeout(t)
  }
}

function buildResult(
  id: string,
  name: string,
  category: ApiCheckResult['category'],
  partial: Partial<Omit<ApiCheckResult, 'id' | 'name' | 'category' | 'checkedAt'>>,
): ApiCheckResult {
  return {
    id,
    name,
    category,
    status: partial.status ?? 'unknown',
    latencyMs: partial.latencyMs ?? null,
    httpStatus: partial.httpStatus ?? null,
    message: partial.message ?? null,
    checkedAt: new Date().toISOString(),
  }
}

function notConfigured(id: string, name: string, category: ApiCheckResult['category'], envVar: string): ApiCheckResult {
  return buildResult(id, name, category, {
    status: 'not_configured',
    message: `${envVar} not set`,
  })
}

// ─────────────────────────────────────────────────────────────
// Infrastructure
// ─────────────────────────────────────────────────────────────

async function checkSupabase(): Promise<ApiCheckResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return notConfigured('supabase', 'Supabase', 'infra', 'NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY')

  const start = Date.now()
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const admin = createClient(url, key, { auth: { persistSession: false } })
    // Cheapest possible query — count(*) on a tiny static table.
    // We use auth.users via head=true count which returns just the count without rows.
    const { error } = await admin
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .limit(1)
    const latencyMs = Date.now() - start
    if (error) {
      return buildResult('supabase', 'Supabase', 'infra', {
        status: 'down', latencyMs,
        message: error.message?.slice(0, 200),
      })
    }
    return buildResult('supabase', 'Supabase', 'infra', {
      status: latencyMs > 2_000 ? 'degraded' : 'ok',
      latencyMs,
      httpStatus: 200,
      message: latencyMs > 2_000 ? 'Slow response (>2s)' : null,
    })
  } catch (e) {
    return buildResult('supabase', 'Supabase', 'infra', {
      status: 'down', latencyMs: Date.now() - start,
      message: e instanceof Error ? e.message.slice(0, 200) : String(e),
    })
  }
}

// ─────────────────────────────────────────────────────────────
// AI providers
// ─────────────────────────────────────────────────────────────

async function checkAnthropic(): Promise<ApiCheckResult> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return notConfigured('anthropic', 'Anthropic', 'ai', 'ANTHROPIC_API_KEY')

  // The /v1/models endpoint validates the key without burning tokens.
  const { res, latencyMs, error } = await timedFetch(
    'https://api.anthropic.com/v1/models',
    {
      method: 'GET',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    },
    5_000,
  )
  if (!res) return buildResult('anthropic', 'Anthropic', 'ai', { status: 'down', latencyMs, message: error })
  return buildResult('anthropic', 'Anthropic', 'ai', {
    status: res.ok ? 'ok' : 'down',
    latencyMs,
    httpStatus: res.status,
    message: res.ok ? null : `HTTP ${res.status}`,
  })
}

async function checkOpenAI(): Promise<ApiCheckResult> {
  const key = process.env.OPENAI_API_KEY
  if (!key) return notConfigured('openai', 'OpenAI', 'ai', 'OPENAI_API_KEY')

  const { res, latencyMs, error } = await timedFetch(
    'https://api.openai.com/v1/models',
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    },
    5_000,
  )
  if (!res) return buildResult('openai', 'OpenAI', 'ai', { status: 'down', latencyMs, message: error })
  return buildResult('openai', 'OpenAI', 'ai', {
    status: res.ok ? 'ok' : 'down',
    latencyMs,
    httpStatus: res.status,
    message: res.ok ? null : `HTTP ${res.status}`,
  })
}

async function checkGemini(): Promise<ApiCheckResult> {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY
  if (!key) return notConfigured('gemini', 'Google Gemini', 'ai', 'GEMINI_API_KEY')

  // List models — validates key without billing
  const { res, latencyMs, error } = await timedFetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
    { method: 'GET' },
    5_000,
  )
  if (!res) return buildResult('gemini', 'Google Gemini', 'ai', { status: 'down', latencyMs, message: error })
  return buildResult('gemini', 'Google Gemini', 'ai', {
    status: res.ok ? 'ok' : 'down',
    latencyMs,
    httpStatus: res.status,
    message: res.ok ? null : `HTTP ${res.status}`,
  })
}

// ─────────────────────────────────────────────────────────────
// Market data providers
// ─────────────────────────────────────────────────────────────

async function checkFinnhub(): Promise<ApiCheckResult> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return notConfigured('finnhub', 'Finnhub', 'data', 'FINNHUB_API_KEY')

  const { res, latencyMs, error } = await timedFetch(
    `https://finnhub.io/api/v1/quote?symbol=AAPL&token=${key}`,
    { method: 'GET' },
    5_000,
  )
  if (!res) return buildResult('finnhub', 'Finnhub', 'data', { status: 'down', latencyMs, message: error })
  if (!res.ok) {
    return buildResult('finnhub', 'Finnhub', 'data', {
      status: 'down', latencyMs, httpStatus: res.status,
      message: `HTTP ${res.status}`,
    })
  }
  // Finnhub returns 200 even on bad keys but with c=0. Check shape.
  try {
    const body = await res.json() as { c?: number }
    if (typeof body.c !== 'number' || body.c <= 0) {
      return buildResult('finnhub', 'Finnhub', 'data', {
        status: 'degraded', latencyMs, httpStatus: 200,
        message: 'Empty quote response (key may be invalid)',
      })
    }
    return buildResult('finnhub', 'Finnhub', 'data', {
      status: 'ok', latencyMs, httpStatus: 200,
    })
  } catch {
    return buildResult('finnhub', 'Finnhub', 'data', {
      status: 'degraded', latencyMs, httpStatus: 200,
      message: 'Malformed response body',
    })
  }
}

async function checkTwelveData(): Promise<ApiCheckResult> {
  const key = process.env.TWELVE_DATA_API_KEY ?? process.env.TWELVEDATA_API_KEY
  if (!key) return notConfigured('twelvedata', 'TwelveData', 'data', 'TWELVE_DATA_API_KEY')

  const { res, latencyMs, error } = await timedFetch(
    `https://api.twelvedata.com/price?symbol=AAPL&apikey=${key}`,
    { method: 'GET' },
    5_000,
  )
  if (!res) return buildResult('twelvedata', 'TwelveData', 'data', { status: 'down', latencyMs, message: error })
  if (!res.ok) {
    return buildResult('twelvedata', 'TwelveData', 'data', {
      status: 'down', latencyMs, httpStatus: res.status,
      message: `HTTP ${res.status}`,
    })
  }
  // TwelveData returns 200 with status:error for bad keys / rate limits
  try {
    const body = await res.json() as { price?: string | number; status?: string; code?: number; message?: string }
    if (body.status === 'error' || body.code) {
      return buildResult('twelvedata', 'TwelveData', 'data', {
        status: 'degraded', latencyMs, httpStatus: 200,
        message: body.message?.slice(0, 200) ?? `code=${body.code}`,
      })
    }
    if (body.price === undefined || body.price === null) {
      return buildResult('twelvedata', 'TwelveData', 'data', {
        status: 'degraded', latencyMs, httpStatus: 200,
        message: 'Empty price response',
      })
    }
    return buildResult('twelvedata', 'TwelveData', 'data', {
      status: 'ok', latencyMs, httpStatus: 200,
    })
  } catch {
    return buildResult('twelvedata', 'TwelveData', 'data', {
      status: 'degraded', latencyMs, httpStatus: 200,
      message: 'Malformed response body',
    })
  }
}

async function checkSecEdgar(): Promise<ApiCheckResult> {
  // EDGAR has no auth and is free; just verify the atom feed endpoint is up
  const { res, latencyMs, error } = await timedFetch(
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&owner=include&count=1&output=atom',
    {
      method: 'GET',
      headers: {
        // EDGAR requires a User-Agent for politeness
        'User-Agent': 'Wali-OS health check (alerts@wali-os.com)',
      },
    },
    8_000,
  )
  if (!res) return buildResult('sec_edgar', 'SEC EDGAR', 'data', { status: 'down', latencyMs, message: error })
  return buildResult('sec_edgar', 'SEC EDGAR', 'data', {
    status: res.ok ? 'ok' : 'down',
    latencyMs,
    httpStatus: res.status,
    message: res.ok ? null : `HTTP ${res.status}`,
  })
}

async function checkForexFactory(): Promise<ApiCheckResult> {
  // No auth, just check the public JSON feed
  const { res, latencyMs, error } = await timedFetch(
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
    {
      method: 'GET',
      headers: { 'User-Agent': 'Wali-OS health check' },
    },
    8_000,
  )
  if (!res) return buildResult('forexfactory', 'ForexFactory', 'data', { status: 'down', latencyMs, message: error })
  if (!res.ok) {
    return buildResult('forexfactory', 'ForexFactory', 'data', {
      status: 'down', latencyMs, httpStatus: res.status,
      message: `HTTP ${res.status}`,
    })
  }
  try {
    const body = await res.json() as unknown
    if (!Array.isArray(body) || body.length === 0) {
      return buildResult('forexfactory', 'ForexFactory', 'data', {
        status: 'degraded', latencyMs, httpStatus: 200,
        message: 'Empty or non-array response',
      })
    }
    return buildResult('forexfactory', 'ForexFactory', 'data', {
      status: 'ok', latencyMs, httpStatus: 200,
    })
  } catch {
    return buildResult('forexfactory', 'ForexFactory', 'data', {
      status: 'degraded', latencyMs, httpStatus: 200,
      message: 'Malformed response body',
    })
  }
}

async function checkFrankfurter(): Promise<ApiCheckResult> {
  const { res, latencyMs, error } = await timedFetch(
    'https://api.frankfurter.app/latest?from=USD&to=EUR',
    { method: 'GET' },
    5_000,
  )
  if (!res) return buildResult('frankfurter', 'Frankfurter (FX)', 'data', { status: 'down', latencyMs, message: error })
  if (!res.ok) {
    return buildResult('frankfurter', 'Frankfurter (FX)', 'data', {
      status: 'down', latencyMs, httpStatus: res.status,
      message: `HTTP ${res.status}`,
    })
  }
  try {
    const body = await res.json() as { rates?: Record<string, number> }
    if (!body.rates || typeof body.rates.EUR !== 'number') {
      return buildResult('frankfurter', 'Frankfurter (FX)', 'data', {
        status: 'degraded', latencyMs, httpStatus: 200,
        message: 'Missing rates in response',
      })
    }
    return buildResult('frankfurter', 'Frankfurter (FX)', 'data', {
      status: 'ok', latencyMs, httpStatus: 200,
    })
  } catch {
    return buildResult('frankfurter', 'Frankfurter (FX)', 'data', {
      status: 'degraded', latencyMs, httpStatus: 200,
      message: 'Malformed response body',
    })
  }
}

async function checkCftcSocrata(): Promise<ApiCheckResult> {
  // CFTC Socrata API — public, no auth needed for light queries
  const { res, latencyMs, error } = await timedFetch(
    'https://publicreporting.cftc.gov/resource/6dca-aqww.json?$limit=1',
    {
      method: 'GET',
      headers: { 'User-Agent': 'Wali-OS health check' },
    },
    8_000,
  )
  if (!res) return buildResult('cftc', 'CFTC (COT)', 'data', { status: 'down', latencyMs, message: error })
  return buildResult('cftc', 'CFTC (COT)', 'data', {
    status: res.ok ? 'ok' : 'down',
    latencyMs,
    httpStatus: res.status,
    message: res.ok ? null : `HTTP ${res.status}`,
  })
}

// ─────────────────────────────────────────────────────────────
// Brokers
// ─────────────────────────────────────────────────────────────

async function checkAlpaca(): Promise<ApiCheckResult> {
  const keyId = process.env.ALPACA_API_KEY_ID ?? process.env.APCA_API_KEY_ID
  const secret = process.env.ALPACA_API_SECRET_KEY ?? process.env.APCA_API_SECRET_KEY
  if (!keyId || !secret) return notConfigured('alpaca', 'Alpaca', 'broker', 'ALPACA_API_KEY_ID / SECRET')

  // Use the trading API account endpoint — validates auth and shows account is reachable.
  // We pick the paper trading endpoint to avoid touching live trading by mistake.
  // If user has only live keys, they can set ALPACA_BASE_URL to override.
  const baseUrl = process.env.ALPACA_BASE_URL ?? 'https://paper-api.alpaca.markets'
  const { res, latencyMs, error } = await timedFetch(
    `${baseUrl}/v2/account`,
    {
      method: 'GET',
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secret,
      },
    },
    6_000,
  )
  if (!res) return buildResult('alpaca', 'Alpaca', 'broker', { status: 'down', latencyMs, message: error })
  return buildResult('alpaca', 'Alpaca', 'broker', {
    status: res.ok ? 'ok' : 'down',
    latencyMs,
    httpStatus: res.status,
    message: res.ok ? null : `HTTP ${res.status}`,
  })
}

async function checkTradier(): Promise<ApiCheckResult> {
  const token = process.env.TRADIER_ACCESS_TOKEN ?? process.env.TRADIER_API_KEY
  if (!token) return notConfigured('tradier', 'Tradier', 'broker', 'TRADIER_ACCESS_TOKEN')

  // /v1/markets/clock is free and always available — validates auth without market data quota
  const baseUrl = process.env.TRADIER_BASE_URL ?? 'https://api.tradier.com'
  const { res, latencyMs, error } = await timedFetch(
    `${baseUrl}/v1/markets/clock`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    },
    5_000,
  )
  if (!res) return buildResult('tradier', 'Tradier', 'broker', { status: 'down', latencyMs, message: error })
  return buildResult('tradier', 'Tradier', 'broker', {
    status: res.ok ? 'ok' : 'down',
    latencyMs,
    httpStatus: res.status,
    message: res.ok ? null : `HTTP ${res.status}`,
  })
}

// ─────────────────────────────────────────────────────────────
// Comms
// ─────────────────────────────────────────────────────────────

async function checkStripe(): Promise<ApiCheckResult> {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return notConfigured('stripe', 'Stripe', 'comms', 'STRIPE_SECRET_KEY')

  // List customers with limit=1 — minimal payload, validates key
  const { res, latencyMs, error } = await timedFetch(
    'https://api.stripe.com/v1/customers?limit=1',
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    },
    5_000,
  )
  if (!res) return buildResult('stripe', 'Stripe', 'comms', { status: 'down', latencyMs, message: error })
  return buildResult('stripe', 'Stripe', 'comms', {
    status: res.ok ? 'ok' : 'down',
    latencyMs,
    httpStatus: res.status,
    message: res.ok ? null : `HTTP ${res.status}`,
  })
}

async function checkResend(): Promise<ApiCheckResult> {
  const key = process.env.RESEND_API_KEY
  if (!key) return notConfigured('resend', 'Resend', 'comms', 'RESEND_API_KEY')

  // /domains validates the key without sending email
  const { res, latencyMs, error } = await timedFetch(
    'https://api.resend.com/domains',
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    },
    5_000,
  )
  if (!res) return buildResult('resend', 'Resend', 'comms', { status: 'down', latencyMs, message: error })
  return buildResult('resend', 'Resend', 'comms', {
    status: res.ok ? 'ok' : 'down',
    latencyMs,
    httpStatus: res.status,
    message: res.ok ? null : `HTTP ${res.status}`,
  })
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

const ALL_CHECKS = [
  { id: 'supabase',     fn: checkSupabase },
  { id: 'anthropic',    fn: checkAnthropic },
  { id: 'openai',       fn: checkOpenAI },
  { id: 'gemini',       fn: checkGemini },
  { id: 'finnhub',      fn: checkFinnhub },
  { id: 'twelvedata',   fn: checkTwelveData },
  { id: 'sec_edgar',    fn: checkSecEdgar },
  { id: 'forexfactory', fn: checkForexFactory },
  { id: 'frankfurter',  fn: checkFrankfurter },
  { id: 'cftc',         fn: checkCftcSocrata },
  { id: 'alpaca',       fn: checkAlpaca },
  { id: 'tradier',      fn: checkTradier },
  { id: 'stripe',       fn: checkStripe },
  { id: 'resend',       fn: checkResend },
] as const

type CheckId = typeof ALL_CHECKS[number]['id']

/**
 * Run all checks in parallel. Total time bounded by the slowest single check
 * (each has its own internal timeout). Failures don't block other checks.
 */
export async function runAllApiChecks(): Promise<ApiCheckResult[]> {
  const results = await Promise.all(
    ALL_CHECKS.map(c =>
      c.fn().catch(e => buildResult(c.id, c.id, 'data', {
        status: 'down',
        message: e instanceof Error ? e.message.slice(0, 200) : String(e),
      }))
    )
  )
  return results
}

/**
 * Run a single check by ID. Used by the per-card refresh button.
 */
export async function runApiCheck(id: string): Promise<ApiCheckResult | null> {
  const found = ALL_CHECKS.find(c => c.id === id)
  if (!found) return null
  try {
    return await found.fn()
  } catch (e) {
    return buildResult(found.id, found.id, 'data', {
      status: 'down',
      message: e instanceof Error ? e.message.slice(0, 200) : String(e),
    })
  }
}

export const KNOWN_CHECK_IDS: ReadonlyArray<CheckId> = ALL_CHECKS.map(c => c.id)
