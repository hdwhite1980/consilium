// ─────────────────────────────────────────────────────────────
// PHASE 4 — Options Flow & Short Interest
// Sources:
//   - Tradier API (free tier) for options chain
//   - FINRA short interest (public data)
//   - Calculated put/call ratio from options chain
// ─────────────────────────────────────────────────────────────

const TRADIER_BASE = () => process.env.TRADIER_API_KEY
  ? 'https://api.tradier.com/v1'
  : 'https://sandbox.tradier.com/v1'
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

  // Gamma Exposure (GEX)
  gex: number | null               // net gamma exposure in $ millions
  gexSignal: 'pinning' | 'accelerating' | 'neutral'  // dealer hedging dynamic
  gexNote: string                  // plain English interpretation

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
      `${TRADIER_BASE()}/markets/options/expirations?symbol=${ticker}&includeAllRoots=true`,
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
      `${TRADIER_BASE()}/markets/options/chains?symbol=${ticker}&expiration=${expiry}&greeks=true`,
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
  // Source 1: Finnhub /stock/short-interest (paid tier)
  try {
    const key = process.env.FINNHUB_API_KEY
    if (key) {
      const res = await fetch(
        `https://finnhub.io/api/v1/stock/short-interest?symbol=${ticker}&token=${key}`,
        { next: { revalidate: 86400 } }
      )
      if (res.ok) {
        const data = await res.json()
        // Finnhub returns { data: [{ date, shortInterest, shortRatio }] }
        const latest = data?.data?.[0]
        if (latest?.shortInterest && latest?.shortPercentOfFloat) {
          return {
            pct: parseFloat(latest.shortPercentOfFloat) * 100,
            ratio: latest.shortRatio ?? null
          }
        }
      }
    }
  } catch { /* fallthrough */ }

  // Source 2: Finnhub /stock/metric — includes shortRatio and shortPercent in metrics
  try {
    const key = process.env.FINNHUB_API_KEY
    if (key) {
      const res = await fetch(
        `https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${key}`,
        { next: { revalidate: 86400 } }
      )
      if (res.ok) {
        const data = await res.json()
        const m = data?.metric ?? {}
        // Finnhub metric keys: shortRatio, shortInterest, sharesShort, etc.
        const pct = m['shortRatio'] ?? m['10DayAverageTradingVolume'] ? null : null
        const ratio = typeof m['shortRatio'] === 'number' ? m['shortRatio'] : null
        // sharesShortPercentOfFloat is the key we want
        const floatPct = typeof m['sharesShortPercentOfFloat'] === 'number'
          ? m['sharesShortPercentOfFloat'] * 100
          : typeof m['shortPercent'] === 'number'
          ? m['shortPercent'] * 100
          : null
        if (floatPct !== null || ratio !== null) {
          return { pct: floatPct, ratio }
        }
      }
    }
  } catch { /* fallthrough */ }

  // Source 3: Alpaca fundamentals endpoint (v1beta1)
  try {
    const alpacaKey = process.env.ALPACA_API_KEY
    const alpacaSecret = process.env.ALPACA_SECRET_KEY
    if (alpacaKey && alpacaSecret) {
      const res = await fetch(
        `https://data.alpaca.markets/v1beta1/stocks/${ticker}/snapshot`,
        {
          headers: {
            'APCA-API-KEY-ID': alpacaKey,
            'APCA-API-SECRET-KEY': alpacaSecret,
          },
          next: { revalidate: 86400 }
        }
      )
      if (res.ok) {
        const data = await res.json()
        // Alpaca snapshot may include fundamental data in some tiers
        const pct = data?.fundamentals?.shortPercentOfFloat ?? data?.shortPercentOfFloat ?? null
        const ratio = data?.fundamentals?.shortRatio ?? data?.shortRatio ?? null
        if (pct !== null) return { pct: pct * 100, ratio }
      }
    }
  } catch { /* fallthrough */ }

  return { pct: null, ratio: null }
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

  // ── Gamma Exposure (GEX) ───────────────────────────────────
  // GEX = sum of (call gamma × OI × 100 × price) - (put gamma × OI × 100 × price)
  // Positive GEX = dealers long gamma = price-pinning effect
  // Negative GEX = dealers short gamma = price-amplifying effect
  let gex: number | null = null
  let gexSignal: OptionsFlowSignals['gexSignal'] = 'neutral'
  let gexNote = ''

  if (chain?.options?.length) {
    try {
      type OC = Record<string, unknown> & { greeks?: Record<string, unknown>; option_type?: string; open_interest?: unknown }
      let totalGex = 0
      for (const opt of chain.options as OC[]) {
        const gamma = Number(opt.greeks?.gamma) || 0
        const oi = Number(opt.open_interest) || 0
        const contribution = gamma * oi * 100 * currentPrice
        totalGex += opt.option_type === 'call' ? contribution : -contribution
      }
      gex = totalGex / 1e6 // convert to millions
      gexSignal = Math.abs(gex) < 50 ? 'neutral' : gex > 0 ? 'pinning' : 'accelerating'
      gexNote = gex > 100
        ? `Strong positive GEX ($${gex.toFixed(0)}M) — dealers long gamma, expect price pinning near $${maxPainStrike ?? currentPrice.toFixed(0)}`
        : gex < -100
        ? `Strong negative GEX ($${gex.toFixed(0)}M) — dealers short gamma, moves likely to accelerate`
        : `Neutral GEX ($${gex.toFixed(0)}M) — no strong dealer hedging pressure`
    } catch { /* non-critical */ }
  }

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
          gexNote ? `  GEX: ${gexNote}` : '',
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
      : [
          `Short interest: not available from data providers for this security.`,
          putCallRatio !== null
            ? `  Proxy signal from options: P/C ratio ${putCallRatio.toFixed(2)} (${putCallSignal}) — ${putCallRatio > 1.0 ? 'elevated put buying suggests significant bearish positioning exists' : putCallRatio < 0.7 ? 'low put activity suggests limited bearish conviction' : 'balanced positioning'}.`
            : `  No proxy data available. Treat short position data as unknown — do not cite absence as evidence.`,
        ].filter(Boolean).join('\n'),
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
    gex, gexSignal, gexNote,
    summary: lines.join('\n'),
  }
}
