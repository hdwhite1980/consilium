// =============================================================
// app/lib/trading/oanda-validate.ts
//
// Validates an OANDA Personal Access Token against the
// /v3/accounts/{accountId}/summary endpoint. Returns account
// status, balance, and currency so we cache it like Alpaca.
//
// OANDA has two environments:
//   Practice (paper): https://api-fxpractice.oanda.com
//   Live:             https://api-fxtrade.oanda.com
//
// The token works for ONE environment only — using a practice
// token against the live endpoint returns 401.
// =============================================================

const OANDA_PRACTICE_BASE = 'https://api-fxpractice.oanda.com'
const OANDA_LIVE_BASE     = 'https://api-fxtrade.oanda.com'

export interface OandaValidationResult {
  ok: boolean
  error?: string
  accountId?: string
  accountStatus?: string
  currency?: string
  balance?: number
  unrealizedPL?: number
  marginAvailable?: number
}

export async function validateOandaCredential(
  accountId: string,
  accessToken: string,
  mode: 'paper' | 'live',
): Promise<OandaValidationResult> {
  const baseUrl = mode === 'paper' ? OANDA_PRACTICE_BASE : OANDA_LIVE_BASE
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(`${baseUrl}/v3/accounts/${encodeURIComponent(accountId)}/summary`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept-Datetime-Format': 'RFC3339',
      },
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const j = JSON.parse(text) as { errorMessage?: string; message?: string }
        if (j.errorMessage) detail += `: ${j.errorMessage}`
        else if (j.message) detail += `: ${j.message}`
      } catch { if (text) detail += `: ${text.slice(0, 200)}` }
      return { ok: false, error: detail }
    }
    const body = JSON.parse(text) as {
      account?: {
        id?: string
        currency?: string
        balance?: string | number
        unrealizedPL?: string | number
        marginAvailable?: string | number
        openTradeCount?: number
        openPositionCount?: number
        pendingOrderCount?: number
        marginRate?: string
        hedgingEnabled?: boolean
      }
    }
    const a = body.account ?? {}
    return {
      ok: true,
      accountId: a.id ?? accountId,
      accountStatus: 'ACTIVE',
      currency: a.currency,
      balance: a.balance !== undefined ? Number(a.balance) : undefined,
      unrealizedPL: a.unrealizedPL !== undefined ? Number(a.unrealizedPL) : undefined,
      marginAvailable: a.marginAvailable !== undefined ? Number(a.marginAvailable) : undefined,
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { ok: false, error: 'OANDA validation timeout (10s)' }
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}
