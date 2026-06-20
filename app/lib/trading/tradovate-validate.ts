// =============================================================
// app/lib/trading/tradovate-validate.ts
//
// Validates Tradovate credentials by performing the auth handshake.
// Returns the access token + accountSpec + account integer ID so
// the caller can cache them.
//
// Tradovate auth flow:
//   POST /auth/accessTokenRequest
//   body: { name, password, appId, appVersion, cid, sec }
//   200 → { accessToken, expirationTime, userId, name, ... }
//
// The token expires after ~80 min. We exchange it on each cron
// run if expired (see tradovate-client.ts).
//
// Two environments:
//   Demo (paper): https://demo.tradovateapi.com/v1
//   Live:         https://live.tradovateapi.com/v1
//
// The credentials work for ONE environment only.
// =============================================================

const TRADOVATE_DEMO_BASE = 'https://demo.tradovateapi.com/v1'
const TRADOVATE_LIVE_BASE = 'https://live.tradovateapi.com/v1'

export interface TradovateCredentialInput {
  username: string
  password: string
  appId: string                  // e.g. "Wali-OS"
  appVersion: string             // e.g. "1.0"
  cid: string                    // client ID (from Tradovate API key page)
  sec: string                    // client secret (from Tradovate API key page)
}

export interface TradovateValidationResult {
  ok: boolean
  error?: string
  accessToken?: string
  expirationTime?: string         // ISO timestamp
  userId?: number
  userName?: string
  // Account discovery (we hit /account/list after auth)
  accountSpec?: string            // e.g. "DEMO12345"
  accountIntId?: number           // numeric account ID for API calls
  balance?: number
  marginAvailable?: number
}

export async function validateTradovateCredential(
  creds: TradovateCredentialInput,
  mode: 'paper' | 'live',
): Promise<TradovateValidationResult> {
  const baseUrl = mode === 'paper' ? TRADOVATE_DEMO_BASE : TRADOVATE_LIVE_BASE

  // Step 1: exchange credentials for access token
  let authResult: TradovateAuthResponse
  try {
    authResult = await tradovateAuth(baseUrl, creds)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!authResult.accessToken) {
    return {
      ok: false,
      error: authResult.errorText ?? `Auth failed (errorCode=${authResult.errorCode ?? 'unknown'})`,
    }
  }

  // Step 2: list accounts to get accountSpec and integer ID
  let accounts: TradovateAccountListItem[]
  try {
    accounts = await fetchAccountList(baseUrl, authResult.accessToken)
  } catch (e) {
    return {
      ok: false,
      error: `Auth succeeded but account list failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }

  if (accounts.length === 0) {
    return { ok: false, error: 'Tradovate auth succeeded but no accounts found on user' }
  }
  // Pick the first account (most users have one)
  const acct = accounts[0]

  // Step 3 (optional): fetch cash balance for the account
  let balance: number | undefined
  let marginAvailable: number | undefined
  try {
    const cash = await fetchCashBalance(baseUrl, authResult.accessToken, acct.id)
    balance = cash?.totalCashValue
    marginAvailable = cash?.availableLiquidity
  } catch {
    // best-effort
  }

  return {
    ok: true,
    accessToken: authResult.accessToken,
    expirationTime: authResult.expirationTime,
    userId: authResult.userId,
    userName: authResult.name,
    accountSpec: acct.name,
    accountIntId: acct.id,
    balance,
    marginAvailable,
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers — exported so tradovate-client.ts can reuse for refresh
// ─────────────────────────────────────────────────────────────

export interface TradovateAuthResponse {
  accessToken?: string
  expirationTime?: string
  userId?: number
  name?: string
  errorCode?: number
  errorText?: string
}

export async function tradovateAuth(
  baseUrl: string,
  creds: TradovateCredentialInput,
): Promise<TradovateAuthResponse> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(`${baseUrl}/auth/accessTokenRequest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: creds.username,
        password: creds.password,
        appId: creds.appId,
        appVersion: creds.appVersion,
        cid: creds.cid,
        sec: creds.sec,
      }),
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const j = JSON.parse(text) as { errorText?: string; message?: string }
        if (j.errorText) detail += `: ${j.errorText}`
        else if (j.message) detail += `: ${j.message}`
      } catch { if (text) detail += `: ${text.slice(0, 200)}` }
      throw new Error(detail)
    }
    return JSON.parse(text) as TradovateAuthResponse
  } finally { clearTimeout(timer) }
}

interface TradovateAccountListItem {
  id: number
  name: string
  active: boolean
  accountType: string
  archived: boolean
}

async function fetchAccountList(baseUrl: string, accessToken: string): Promise<TradovateAccountListItem[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(`${baseUrl}/account/list`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`account/list HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const json = await res.json() as TradovateAccountListItem[]
    return json.filter(a => !a.archived && a.active)
  } finally { clearTimeout(timer) }
}

interface TradovateCashBalance {
  totalCashValue?: number
  availableLiquidity?: number
  realizedPnL?: number
  unrealizedPnL?: number
}

async function fetchCashBalance(
  baseUrl: string,
  accessToken: string,
  accountId: number,
): Promise<TradovateCashBalance | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(`${baseUrl}/cashBalance/getCashBalanceSnapshot`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId }),
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    return await res.json() as TradovateCashBalance
  } finally { clearTimeout(timer) }
}
