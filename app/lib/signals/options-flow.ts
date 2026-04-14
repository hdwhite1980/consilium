// ─────────────────────────────────────────────────────────────
// PHASE 4 — Options Flow & Short Interest
// Sources:
//   - Tradier API (free tier) for options chain
//   - FINRA short interest (public data)
//   - Calculated put/call ratio from options chain
// ─────────────────────────────────────────────────────────────

const TRADIER_BASE = 'https://sandbox.tradier.com/v1' // use api.tradier.com for live
const TRADIER_KEY = () => process.env.TRADIER_API_KEY

export interface OptionsFlowSignals {
  // Put/Call ratio
  putCallRatio: number | null
  putCallSignal: 'bullish' | 'bearish' | 'neutral'

  // Open interest
  totalCallOI: number
  totalPutOI: number
  maxPainStrike: number | null    // price where most options expire worthless

  // Implied volatility
  avgIVCall: number | null
  avgIVPut: number | null
  ivSkew: number | null           // put IV - call IV; positive = fear
  ivSignal: 'fear' | 'greed' | 'neutral'

  // Unusual activity flags
  unusualActivity: UnusualOption[]

  // Short interest
  shortInterestPct: number | null  // % of float
  shortRatio: number | null        // days to cover
  shortSignal: 'squeeze_candidate' | 'heavily_shorted' | 'normal' | 'low'

  // Summary for AI
  summary: string
}

export interface UnusualOption {
  type: 'call' | 'put'
  strike: number
  expiry: string
  volume: number
  openInterest: number
  volOIRatio: number   // high ratio = unusual sweep
  ivPct: number
  signal: 'bullish_sweep' | 'bearish_sweep' | 'unusual'
}

async function fetchOptionsChain(ticker: string) {
  if (!TRADIER_KEY()) return null
  try {
    // Get nearest expiry
    const expRes = await fetch(
      `${TRADIER_BASE}/markets/options/expirations?symbol=${ticker}&includeAllRoots=true`,
      {
        headers: {
          'Authorization': `Bearer ${TRADIER_KEY()}`,
          'Accept': 'application/json',
        },
        next: { revalidate: 3600 }
      }
    )
    if (!expRes.ok) return null
    const expData = await expRes.json()
    const expiry = expData?.expirations?.date?.[1] ?? expData?.expirations?.date?.[0]
    if (!expiry) return null

    const chainRes = await fetch(
      `${TRADIER_BASE}/markets/options/chains?symbol=${ticker}&expiration=${expiry}&greeks=true`,
      {
        headers: {
          'Authorization': `Bearer ${TRADIER_KEY()}`,
          'Accept': 'application/json',
        },
        next: { revalidate: 3600 }
      }
    )
    if (!chainRes.ok) return null
    const chainData = await chainRes.json()
    return { expiry, options: chainData?.options?.option ?? [] }
  } catch {
    return null
  }
}

// FINRA short interest (public, no auth needed)
async function fetchShortInterest(ticker: string): Promise<{ pct: number | null; ratio: number | null }> {
  try {
    // FINRA provides this data but requires parsing their reports
    // Using a proxy approach via alternative free endpoint
    const res = await fetch(
      `https://api.nasdaq.com/api/quote/${ticker}/short-interest?assetclass=stocks`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        next: { revalidate: 86400 }
      }
    )
    if (!res.ok) return { pct: null, ratio: null }
    const data = await res.json()
    const rows = data?.data?.shortInterestTable?.rows
    if (!rows?.length) return { pct: null, ratio: null }
    const latest = rows[0]
    const pct = parseFloat(latest?.shortPercentOfFloat?.replace('%', '')) || null
    const ratio = parseFloat(latest?.daysToCover) || null
    return { pct, ratio }
  } catch {
    return { pct: null, ratio: null }
  }
}

export async function fetchOptionsFlow(ticker: string, currentPrice: number): Promise<OptionsFlowSignals> {
  const [chain, shortData] = await Promise.all([
    fetchOptionsChain(ticker),
    fetchShortInterest(ticker),
  ])

  // ── Process options chain ──────────────────────────────────
  let putCallRatio: number | null = null
  let totalCallOI = 0, totalPutOI = 0
  let totalCallVol = 0, totalPutVol = 0
  let maxPainStrike: number | null = null
  let avgIVCall: number | null = null, avgIVPut: number | null = null
  const unusualActivity: UnusualOption[] = []

  if (chain?.options?.length) {
    type OptionContract = Record<string, unknown> & { greeks?: Record<string, unknown> }
    const calls = chain.options.filter((o: OptionContract) => o.option_type === 'call')
    const puts  = chain.options.filter((o: OptionContract) => o.option_type === 'put')

    totalCallOI  = calls.reduce((s: number, o: OptionContract) => s + (Number(o.open_interest) || 0), 0)
    totalPutOI   = puts.reduce((s: number, o: OptionContract) => s + (Number(o.open_interest) || 0), 0)
    totalCallVol = calls.reduce((s: number, o: OptionContract) => s + (Number(o.volume) || 0), 0)
    totalPutVol  = puts.reduce((s: number, o: OptionContract) => s + (Number(o.volume) || 0), 0)

    putCallRatio = totalCallVol > 0 ? totalPutVol / totalCallVol : null

    const callIVs = calls.map((o: OptionContract) => Number(o.greeks?.mid_iv) || 0).filter(Boolean)
    const putIVs  = puts.map((o: OptionContract) => Number(o.greeks?.mid_iv) || 0).filter(Boolean)
    avgIVCall = callIVs.length ? (callIVs as number[]).reduce((a: number, b: number) => a + b, 0) / callIVs.length : null
    avgIVPut  = putIVs.length ? (putIVs as number[]).reduce((a: number, b: number) => a + b, 0) / putIVs.length : null

    // Unusual sweeps: volume > 3x open interest is a flag
    for (const opt of chain.options as OptionContract[]) {
      const vol = Number(opt.volume) || 0
      const oi  = Number(opt.open_interest) || 1
      const ratio = vol / oi
      if (ratio > 3 && vol > 500) {
        unusualActivity.push({
          type: String(opt.option_type) as 'call' | 'put',
          strike: Number(opt.strike),
          expiry: chain.expiry,
          volume: vol,
          openInterest: oi,
          volOIRatio: ratio,
          ivPct: Number(opt.greeks?.mid_iv) * 100 || 0,
          signal: opt.option_type === 'call' ? 'bullish_sweep' : 'bearish_sweep',
        })
      }
    }
    unusualActivity.sort((a, b) => b.volOIRatio - a.volOIRatio)
    unusualActivity.splice(5) // keep top 5

    // Max pain: strike where total options value is minimized
    const strikes = [...new Set((chain.options as OptionContract[]).map((o) => Number(o.strike)))].sort((a: number, b: number) => a - b)
    let minPain = Infinity
    for (const strike of strikes) {
      const callPain = calls
        .filter((o: OptionContract) => Number(o.strike) < strike)
        .reduce((s: number, o: OptionContract) => s + (strike - Number(o.strike)) * (Number(o.open_interest) || 0), 0)
      const putPain = puts
        .filter((o: OptionContract) => Number(o.strike) > strike)
        .reduce((s: number, o: OptionContract) => s + (Number(o.strike) - strike) * (Number(o.open_interest) || 0), 0)
      const total = callPain + putPain
      if (total < minPain) { minPain = total; maxPainStrike = strike }
    }
  }

  // ── Signals ────────────────────────────────────────────────
  const putCallSignal: OptionsFlowSignals['putCallSignal'] =
    putCallRatio === null ? 'neutral' :
    putCallRatio > 1.2 ? 'bearish' :
    putCallRatio < 0.7 ? 'bullish' : 'neutral'

  const ivSkew = avgIVPut !== null && avgIVCall !== null ? avgIVPut - avgIVCall : null
  const ivSignal: OptionsFlowSignals['ivSignal'] =
    ivSkew === null ? 'neutral' :
    ivSkew > 0.05 ? 'fear' : ivSkew < -0.02 ? 'greed' : 'neutral'

  const { pct: shortPct, ratio: shortRatio } = shortData
  const shortSignal: OptionsFlowSignals['shortSignal'] =
    shortPct === null ? 'normal' :
    shortPct > 25 ? 'squeeze_candidate' :
    shortPct > 15 ? 'heavily_shorted' :
    shortPct < 3 ? 'low' : 'normal'

  // ── Summary ────────────────────────────────────────────────
  const lines = [
    `=== OPTIONS FLOW & SHORT INTEREST ===`,
    ``,
    chain
      ? [
          `Options (expiry ${chain.expiry}):`,
          putCallRatio !== null ? `  Put/Call ratio: ${putCallRatio.toFixed(2)} — ${putCallSignal.toUpperCase()} signal` : '',
          `  Call OI: ${totalCallOI.toLocaleString()} | Put OI: ${totalPutOI.toLocaleString()}`,
          maxPainStrike ? `  Max pain strike: $${maxPainStrike} (price gravitates here at expiry)` : '',
          ivSkew !== null ? `  IV skew (put-call): ${(ivSkew*100).toFixed(1)}% — market ${ivSignal}` : '',
          unusualActivity.length > 0
            ? [`  Unusual sweeps detected:`,
               ...unusualActivity.slice(0, 3).map(u =>
                 `    ${u.type.toUpperCase()} $${u.strike} — ${u.volume.toLocaleString()} vol vs ${u.openInterest.toLocaleString()} OI (${u.volOIRatio.toFixed(1)}x) → ${u.signal}`
               )].join('\n')
            : `  No unusual sweep activity detected`,
        ].filter(Boolean).join('\n')
      : `  Options data unavailable (set TRADIER_API_KEY to enable)`,
    ``,
    shortPct !== null
      ? [
          `Short interest:`,
          `  ${shortPct.toFixed(1)}% of float sold short`,
          shortRatio ? `  Days to cover: ${shortRatio.toFixed(1)}` : '',
          `  Signal: ${shortSignal.toUpperCase().replace('_', ' ')}`,
          shortSignal === 'squeeze_candidate'
            ? `  ⚠ High short interest — good news could trigger short squeeze` : '',
        ].filter(Boolean).join('\n')
      : `  Short interest data unavailable`,
  ].filter(Boolean)

  return {
    putCallRatio, putCallSignal,
    totalCallOI, totalPutOI,
    maxPainStrike, avgIVCall, avgIVPut,
    ivSkew, ivSignal,
    unusualActivity,
    shortInterestPct: shortPct,
    shortRatio,
    shortSignal,
    summary: lines.join('\n'),
  }
}
