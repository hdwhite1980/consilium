// =============================================================
// app/lib/trading/alpaca-validate.ts
//
// Hit Alpaca's /v2/account to validate a credential pair and
// pull back cached info (account id, status, cash, equity).
//
// Used at credential save time and as a periodic re-validation.
// NEVER places orders — this is read-only.
// =============================================================

export interface AlpacaAccountSummary {
  ok: boolean
  accountId?: string
  accountStatus?: string
  cash?: number
  equity?: number
  error?: string
}

const ALPACA_PAPER_BASE = 'https://paper-api.alpaca.markets'
const ALPACA_LIVE_BASE  = 'https://api.alpaca.markets'

export async function validateAlpacaCredential(
  keyId: string,
  secret: string,
  mode: 'paper' | 'live',
): Promise<AlpacaAccountSummary> {
  const baseUrl = mode === 'paper' ? ALPACA_PAPER_BASE : ALPACA_LIVE_BASE
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8_000)
  try {
    const res = await fetch(`${baseUrl}/v2/account`, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        'APCA-API-KEY-ID': keyId,
        'APCA-API-SECRET-KEY': secret,
      },
    })
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const body = await res.json() as { message?: string; code?: number }
        if (body.message) detail += `: ${body.message}`
      } catch { /* ignore */ }
      return { ok: false, error: detail }
    }
    const body = await res.json() as {
      id?: string
      status?: string
      cash?: string | number
      equity?: string | number
    }
    return {
      ok: true,
      accountId: body.id,
      accountStatus: body.status,
      cash: body.cash !== undefined ? Number(body.cash) : undefined,
      equity: body.equity !== undefined ? Number(body.equity) : undefined,
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
    }
  } finally {
    clearTimeout(timer)
  }
}
