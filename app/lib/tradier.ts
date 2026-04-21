// ═════════════════════════════════════════════════════════════
// app/lib/tradier.ts
//
// Phase 2 — Tradier integration for real option chain data.
//
// This replaces Claude's ESTIMATED option strikes/premiums/greeks with
// real market data from Tradier's public option chain endpoint.
//
// Flow:
//   1. Claude proposes option ideas (estimated strikes, premiums, greeks)
//   2. For each proposal, fetch real chain via enrichOptionIdea()
//   3. Find the nearest actual strike to Claude's target
//   4. Replace estimated fields with real data
//   5. On failure: return null → caller falls back to Claude's estimate
//
// API configuration:
//   - TRADIER_API_KEY (required) — bearer token from tradier.com
//   - TRADIER_ENV (optional, defaults to 'sandbox') — 'sandbox' or 'production'
//   - Sandbox: free, 15-min delayed data
//   - Production: paid, real-time
//
// Caching:
//   - In-memory cache per ticker+expiration, 60-second TTL
//   - Prevents re-fetching the same chain multiple times in one request cycle
//
// Rate limiting:
//   - Tradier basic = 120 req/min
//   - We're well under this for typical use (3 option ideas = 3 chain fetches)
//   - Timeout each fetch at 8 seconds to avoid stalling the pipeline
// ═════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>

function getBaseUrl(): string {
  const env = (process.env.TRADIER_ENV ?? 'sandbox').toLowerCase()
  return env === 'production'
    ? 'https://api.tradier.com/v1'
    : 'https://sandbox.tradier.com/v1'
}

function getApiKey(): string | null {
  return process.env.TRADIER_API_KEY ?? null
}

// ─────────────────────────────────────────────────────────────
// In-memory cache — per-process. Acceptable for serverless since each
// ideas pull is a single request cycle.
// ─────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chainCache = new Map<string, { data: any[]; fetchedAt: number }>()
const expirationCache = new Map<string, { data: string[]; fetchedAt: number }>()
const CACHE_TTL_MS = 60 * 1000  // 60 seconds

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export interface TradierOption {
  symbol: string             // e.g. AAPL240517C00180000
  underlying: string
  strike: number
  option_type: 'call' | 'put'
  expiration_date: string    // YYYY-MM-DD
  bid: number
  ask: number
  last: number | null
  volume: number
  open_interest: number
  greeks?: {
    delta?: number
    gamma?: number
    theta?: number
    vega?: number
    mid_iv?: number
  }
}

export interface EnrichedOption {
  strike: number
  premium: number          // Mid of bid/ask, or last if mid unavailable
  delta: number | null
  iv: number | null        // Implied volatility as decimal (0.28 = 28%)
  bid: number
  ask: number
  volume: number
  openInterest: number
  expiration: string
  optionSymbol: string
  source: 'tradier'
}

// ─────────────────────────────────────────────────────────────
// Auth failure tracking — lets callers detect systemic 401s
// and report a clear error rather than "no results found"
// ─────────────────────────────────────────────────────────────
interface AuthFailureState {
  count401: number
  total: number
  lastError: string | null
  resetAt: number
}
const authState: AuthFailureState = { count401: 0, total: 0, lastError: null, resetAt: Date.now() }
const AUTH_STATE_WINDOW_MS = 2 * 60 * 1000  // reset counters every 2 min

function trackAuthAttempt(status: number | 'error', errorMsg?: string): void {
  // Reset window if stale
  if (Date.now() - authState.resetAt > AUTH_STATE_WINDOW_MS) {
    authState.count401 = 0
    authState.total = 0
    authState.lastError = null
    authState.resetAt = Date.now()
  }
  authState.total++
  if (status === 401) {
    authState.count401++
    authState.lastError = errorMsg ?? 'HTTP 401 Unauthorized'
  }
}

/**
 * Returns true if the Tradier API is failing with auth errors on the majority
 * of recent calls. Used by callers (like the options scanner) to return a
 * specific "auth failed" error rather than silently returning no results.
 */
export function isTradierAuthFailing(): { failing: boolean; recent401s: number; total: number; lastError: string | null } {
  // Refresh window state
  if (Date.now() - authState.resetAt > AUTH_STATE_WINDOW_MS) {
    return { failing: false, recent401s: 0, total: 0, lastError: null }
  }
  const failing = authState.total >= 5 && authState.count401 / authState.total > 0.5
  return {
    failing,
    recent401s: authState.count401,
    total: authState.total,
    lastError: authState.lastError,
  }
}

// ─────────────────────────────────────────────────────────────
// Low-level fetch with timeout
// ─────────────────────────────────────────────────────────────
async function tradierGet(path: string, params: Record<string, string>, timeoutMs = 8000): Promise<AnyObj | null> {
  const key = getApiKey()
  if (!key) {
    console.warn('[tradier] TRADIER_API_KEY not set')
    trackAuthAttempt('error', 'TRADIER_API_KEY not set')
    return null
  }

  const qs = new URLSearchParams(params).toString()
  const url = `${getBaseUrl()}${path}?${qs}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    })

    if (!res.ok) {
      trackAuthAttempt(res.status, `HTTP ${res.status}`)
      console.warn(`[tradier] ${path} returned ${res.status}`)
      return null
    }

    trackAuthAttempt(res.status)
    const data = await res.json()
    return data
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 120) ?? 'unknown'
    trackAuthAttempt('error', msg)
    console.warn(`[tradier] ${path} failed:`, msg)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Get option expirations for a symbol
// ─────────────────────────────────────────────────────────────
export async function getOptionExpirations(symbol: string): Promise<string[]> {
  const cacheKey = symbol.toUpperCase()
  const cached = expirationCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data
  }

  const result = await tradierGet('/markets/options/expirations', {
    symbol: cacheKey,
    includeAllRoots: 'true',
  })

  if (!result) return []

  // Response shape: { expirations: { date: [ "2025-05-16", "2025-05-23", ... ] } }
  // Or single expiration: { expirations: { date: "2025-05-16" } }
  const rawDates = result.expirations?.date
  let dates: string[] = []
  if (Array.isArray(rawDates)) {
    dates = rawDates.filter((d: unknown): d is string => typeof d === 'string')
  } else if (typeof rawDates === 'string') {
    dates = [rawDates]
  }

  expirationCache.set(cacheKey, { data: dates, fetchedAt: Date.now() })
  return dates
}

// ─────────────────────────────────────────────────────────────
// Get full option chain for a symbol + expiration
// ─────────────────────────────────────────────────────────────
export async function getOptionChain(symbol: string, expiration: string): Promise<TradierOption[]> {
  const cacheKey = `${symbol.toUpperCase()}:${expiration}`
  const cached = chainCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data as TradierOption[]
  }

  const result = await tradierGet('/markets/options/chains', {
    symbol: symbol.toUpperCase(),
    expiration,
    greeks: 'true',
  })

  if (!result) return []

  // Response shape: { options: { option: [ {...}, {...} ] } }
  // Or single option: { options: { option: {...} } }
  const rawOptions = result.options?.option
  let options: TradierOption[] = []
  if (Array.isArray(rawOptions)) {
    options = rawOptions as TradierOption[]
  } else if (rawOptions && typeof rawOptions === 'object') {
    options = [rawOptions as TradierOption]
  }

  // Sanity filter — only keep options with real bid/ask data
  options = options.filter(o =>
    o && typeof o.strike === 'number' && o.strike > 0 &&
    (o.option_type === 'call' || o.option_type === 'put') &&
    (typeof o.bid === 'number' || typeof o.ask === 'number' || typeof o.last === 'number')
  )

  chainCache.set(cacheKey, { data: options, fetchedAt: Date.now() })
  return options
}

// ─────────────────────────────────────────────────────────────
// Find the nearest available expiration to a target DTE
// ─────────────────────────────────────────────────────────────
function pickNearestExpiration(expirations: string[], targetDate: string): string | null {
  if (expirations.length === 0) return null
  const target = new Date(targetDate + 'T00:00:00Z').getTime()
  if (!Number.isFinite(target)) return expirations[0]

  let best = expirations[0]
  let bestDiff = Infinity
  for (const e of expirations) {
    const t = new Date(e + 'T00:00:00Z').getTime()
    if (!Number.isFinite(t)) continue
    const diff = Math.abs(t - target)
    if (diff < bestDiff) {
      bestDiff = diff
      best = e
    }
  }
  return best
}

// ─────────────────────────────────────────────────────────────
// Find the nearest strike to a target price within the chain
// ─────────────────────────────────────────────────────────────
function pickNearestStrike(
  chain: TradierOption[],
  optionType: 'call' | 'put',
  targetStrike: number,
): TradierOption | null {
  const filtered = chain.filter(o => o.option_type === optionType)
  if (filtered.length === 0) return null

  let best = filtered[0]
  let bestDiff = Math.abs(best.strike - targetStrike)
  for (const o of filtered) {
    const diff = Math.abs(o.strike - targetStrike)
    if (diff < bestDiff) {
      bestDiff = diff
      best = o
    }
  }
  return best
}

// ─────────────────────────────────────────────────────────────
// Main entrypoint: enrich a Claude-proposed option with real data
// ─────────────────────────────────────────────────────────────
// Returns null if enrichment fails — caller should fall back to Claude's estimate.
export async function enrichOptionIdea(params: {
  underlying: string
  optionType: 'call' | 'put'
  targetStrike: number
  targetExpiration: string    // YYYY-MM-DD
}): Promise<EnrichedOption | null> {
  const { underlying, optionType, targetStrike, targetExpiration } = params
  const sym = underlying.toUpperCase()

  try {
    // Step 1: get available expirations for this symbol
    const expirations = await getOptionExpirations(sym)
    if (expirations.length === 0) {
      console.warn(`[tradier] no expirations for ${sym}`)
      return null
    }

    // Step 2: pick the nearest one to Claude's target
    const chosenExp = pickNearestExpiration(expirations, targetExpiration)
    if (!chosenExp) return null

    // Step 3: fetch the full chain for that expiration
    const chain = await getOptionChain(sym, chosenExp)
    if (chain.length === 0) {
      console.warn(`[tradier] empty chain for ${sym} @ ${chosenExp}`)
      return null
    }

    // Step 4: find the nearest strike matching Claude's proposed option type
    const contract = pickNearestStrike(chain, optionType, targetStrike)
    if (!contract) {
      console.warn(`[tradier] no ${optionType} strikes in chain for ${sym} @ ${chosenExp}`)
      return null
    }

    // Step 5: compute the premium (mid of bid/ask, or last)
    let premium: number
    if (contract.bid > 0 && contract.ask > 0) {
      premium = (contract.bid + contract.ask) / 2
    } else if (contract.last && contract.last > 0) {
      premium = contract.last
    } else if (contract.ask > 0) {
      premium = contract.ask
    } else if (contract.bid > 0) {
      premium = contract.bid
    } else {
      console.warn(`[tradier] no price data for ${contract.symbol}`)
      return null
    }

    return {
      strike: contract.strike,
      premium: Math.round(premium * 100) / 100,
      delta: contract.greeks?.delta ?? null,
      iv: contract.greeks?.mid_iv ?? null,
      bid: contract.bid,
      ask: contract.ask,
      volume: contract.volume ?? 0,
      openInterest: contract.open_interest ?? 0,
      expiration: contract.expiration_date,
      optionSymbol: contract.symbol,
      source: 'tradier',
    }
  } catch (e) {
    console.warn(`[tradier] enrichOptionIdea failed for ${sym}:`, (e as Error).message)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Utility: check if Tradier is configured
// ─────────────────────────────────────────────────────────────
export function isTradierConfigured(): boolean {
  return !!getApiKey()
}

// ─────────────────────────────────────────────────────────────
// Utility: get sandbox/production status (for disclaimer text)
// ─────────────────────────────────────────────────────────────
export function getTradierMode(): 'sandbox' | 'production' {
  const env = (process.env.TRADIER_ENV ?? 'sandbox').toLowerCase()
  return env === 'production' ? 'production' : 'sandbox'
}
