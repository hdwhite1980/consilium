// =============================================================
// app/lib/signals/options-flow-alpaca.ts
//
// Alpaca-backed options posture for the pre-earnings signal cron, using the
// SAME Alpaca credentials already powering bars/execution — no Tradier, no new
// account, no funding. Replaces the Tradier path for fetchOptionsFlow's
// run-up use (P/C volume ratio + IV skew + a bullish/bearish read).
//
// Source: GET data.alpaca.markets/v1beta1/options/snapshots/{underlying}
//   - feed=indicative (free; 15-min delayed — fine for a daily signal)
//   - each contract snapshot carries a dailyBar (volume) and impliedVolatility
//     (+ greeks). We aggregate near-the-money, near-term contracts into:
//       putCallRatio  = putVol / callVol     (today's flow)
//       ivSkew        = avgPutIV - avgCallIV  (positive = fear/bearish)
//   - open interest isn't in the data snapshot, so putCallOIRatio stays null
//     (the run-up signal only needs the volume ratio + skew).
// =============================================================

const ALPACA_DATA_BASE = process.env.ALPACA_BASE_URL || 'https://data.alpaca.markets'

export interface AlpacaOptionsFlow {
  putCallRatio: number | null
  putCallOIRatio: number | null
  ivSkew: number | null
  putCallSignal: 'bullish' | 'bearish' | 'neutral'
  source: 'alpaca'
}

interface AlpacaOptionSnapshot {
  dailyBar?: { v?: number }
  impliedVolatility?: number
  greeks?: { impliedVolatility?: number; iv?: number }
}

const EMPTY: AlpacaOptionsFlow = {
  putCallRatio: null,
  putCallOIRatio: null,
  ivSkew: null,
  putCallSignal: 'neutral',
  source: 'alpaca',
}

// OCC symbol tail is fixed-width regardless of root length:
//   ...{YYMMDD}{C|P}{strike*1000, 8 digits}
function parseOcc(sym: string): { type: 'C' | 'P'; strike: number; expiry: string } | null {
  if (sym.length < 16) return null
  const type = sym.slice(-9, -8)
  if (type !== 'C' && type !== 'P') return null
  const strike = Number(sym.slice(-8)) / 1000
  if (!Number.isFinite(strike) || strike <= 0) return null
  const yymmdd = sym.slice(-15, -9)
  if (!/^\d{6}$/.test(yymmdd)) return null
  const expiry = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`
  return { type, strike, expiry }
}

export async function fetchOptionsFlowAlpaca(
  ticker: string,
  currentPrice: number,
): Promise<AlpacaOptionsFlow> {
  const key = process.env.ALPACA_API_KEY
  const secret = process.env.ALPACA_SECRET_KEY
  if (!key || !secret || !Number.isFinite(currentPrice) || currentPrice <= 0) return EMPTY

  try {
    const today = new Date()
    const expLte = new Date(today.getTime() + 120 * 86400000).toISOString().split('T')[0]
    const url =
      `${ALPACA_DATA_BASE}/v1beta1/options/snapshots/${encodeURIComponent(ticker)}` +
      `?feed=indicative&limit=1000&expiration_date_lte=${expLte}`

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    let json: { snapshots?: Record<string, AlpacaOptionSnapshot> }
    try {
      const res = await fetch(url, {
        headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret },
        signal: ctrl.signal,
      })
      if (!res.ok) return EMPTY
      json = (await res.json()) as { snapshots?: Record<string, AlpacaOptionSnapshot> }
    } finally {
      clearTimeout(timer)
    }

    const snaps = json.snapshots ?? {}
    const lo = currentPrice * 0.75
    const hi = currentPrice * 1.25
    const todayMs = today.getTime()

    let callVol = 0
    let putVol = 0
    const callIVs: number[] = []
    const putIVs: number[] = []

    for (const [sym, snap] of Object.entries(snaps)) {
      const occ = parseOcc(sym)
      if (!occ) continue
      // near-the-money only (cleaner skew, ignores deep-OTM noise)
      if (occ.strike < lo || occ.strike > hi) continue
      // near-term only (<= ~120d)
      const dte = (Date.parse(`${occ.expiry}T00:00:00Z`) - todayMs) / 86400000
      if (!Number.isFinite(dte) || dte < 0 || dte > 120) continue

      const vol = Number(snap?.dailyBar?.v ?? 0)
      const ivRaw = snap?.impliedVolatility ?? snap?.greeks?.impliedVolatility ?? snap?.greeks?.iv
      const iv = Number(ivRaw)

      if (occ.type === 'C') {
        callVol += Number.isFinite(vol) ? vol : 0
        if (Number.isFinite(iv) && iv > 0) callIVs.push(iv)
      } else {
        putVol += Number.isFinite(vol) ? vol : 0
        if (Number.isFinite(iv) && iv > 0) putIVs.push(iv)
      }
    }

    const putCallRatio = callVol > 0 ? putVol / callVol : null
    const avg = (a: number[]): number | null => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null)
    const cIV = avg(callIVs)
    const pIV = avg(putIVs)
    const ivSkew = cIV !== null && pIV !== null ? pIV - cIV : null

    // Primary read from P/C volume; fall back to IV skew if volume is absent
    // (thin tape / delayed feed gaps) so we still get a directional lean.
    let putCallSignal: AlpacaOptionsFlow['putCallSignal'] =
      putCallRatio === null ? 'neutral' :
      putCallRatio > 1.2 ? 'bearish' :
      putCallRatio < 0.7 ? 'bullish' : 'neutral'
    if (putCallRatio === null && ivSkew !== null) {
      putCallSignal = ivSkew > 0.05 ? 'bearish' : ivSkew < -0.02 ? 'bullish' : 'neutral'
    }

    return {
      putCallRatio: putCallRatio === null ? null : Number(putCallRatio.toFixed(3)),
      putCallOIRatio: null,
      ivSkew: ivSkew === null ? null : Number(ivSkew.toFixed(4)),
      putCallSignal,
      source: 'alpaca',
    }
  } catch {
    return EMPTY
  }
}
