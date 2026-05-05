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
  // Put/Call ratios — both volume (today's flow) and open interest (cumulative
  // positioning). Volume reacts to sentiment shifts; OI reflects structural
  // positioning. Computed across the front N monthly expiries (see
  // fetchOptionsChain) so the ratios are comparable to terminal-source numbers.
  putCallRatio: number | null      // volume-based (today's flow)
  putCallOIRatio: number | null    // open-interest-based (cumulative positioning)
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
    // Get all available expiries
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
    // Tradier returns expirations.date as either an array (multiple expiries)
    // or a single string (one expiry). Handle both shapes.
    const dateField = expData?.expirations?.date
    let allExpiries: string[] = []
    if (Array.isArray(dateField)) {
      allExpiries = dateField
    } else if (typeof dateField === 'string') {
      allExpiries = [dateField]
    }
    if (allExpiries.length === 0) return null

    // Cap to the front 3 monthly expiries within ~120 days. Volume
    // and OI in expiries beyond that decay rapidly and add noise to
    // the P/C ratio without representing real near-term positioning.
    const cutoffMs = Date.now() + 120 * 86400_000
    const candidateExpiries = allExpiries
      .filter(d => {
        const t = new Date(d).getTime()
        return Number.isFinite(t) && t <= cutoffMs
      })
      .slice(0, 3)
    const expiries = candidateExpiries.length > 0
      ? candidateExpiries
      : allExpiries.slice(0, 1)  // fallback if filter rejected everything

    // Primary expiry for IV skew / max pain / unusual sweeps / GEX.
    // Same selection rule as before — prefer the 2nd to skip front
    // weeklies-noise, fall back to the 1st.
    const primaryExpiry = expiries[1] ?? expiries[0]

    // Pull all chains in parallel
    const chainResponses = await Promise.all(
      expiries.map(exp =>
        fetch(
          `${TRADIER_BASE()}/markets/options/chains?symbol=${ticker}&expiration=${exp}&greeks=true`,
          {
            headers: {
              'Authorization': `Bearer ${TRADIER_KEY()}`,
              'Accept': 'application/json',
            },
            next: { revalidate: 3600 }
          }
        ).then(r => r.ok ? r.json() : null).catch(() => null)
      )
    )

    // Aggregate volume + OI sums across all fetched expiries
    let aggregateVolCalls = 0, aggregateVolPuts = 0
    let aggregateOICalls = 0, aggregateOIPuts = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let primaryOptions: any[] = []

    for (let i = 0; i < expiries.length; i++) {
      const exp = expiries[i]
      const chainData = chainResponses[i]
      const opts: Array<Record<string, unknown>> = chainData?.options?.option ?? []
      for (const o of opts) {
        const vol = Number(o.volume) || 0
        const oi  = Number(o.open_interest) || 0
        if (o.option_type === 'call') {
          aggregateVolCalls += vol
          aggregateOICalls  += oi
        } else if (o.option_type === 'put') {
          aggregateVolPuts += vol
          aggregateOIPuts  += oi
        }
      }
      if (exp === primaryExpiry) primaryOptions = opts
    }

    // If primary expiry's chain failed but other expiries succeeded, fall
    // back to whichever non-empty chain we have for the per-option work.
    if (primaryOptions.length === 0) {
      for (let i = 0; i < expiries.length; i++) {
        const opts = chainResponses[i]?.options?.option ?? []
        if (opts.length > 0) { primaryOptions = opts; break }
      }
    }

    if (primaryOptions.length === 0 && aggregateVolCalls === 0 && aggregateVolPuts === 0) {
      return null
    }

    return {
      // Backward-compat: existing callers read `expiry` and `options` to
      // mean primary expiry (for max pain, sweeps, IV, GEX).
      expiry: primaryExpiry,
      options: primaryOptions,
      // New: aggregate sums across multiple expiries for accurate P/C ratios.
      aggregateExpiries: expiries,
      aggregateVolCalls,
      aggregateVolPuts,
      aggregateOICalls,
      aggregateOIPuts,
    }
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
        if (latest?.shortInterest && latest?.shortPercentOfFloat !== undefined && latest?.shortPercentOfFloat !== null) {
          // Defensive: shortPercentOfFloat may be returned as decimal (0.15)
          // or percentage (15.0). Distinguish by magnitude.
          const raw = parseFloat(latest.shortPercentOfFloat)
          const pct = Number.isFinite(raw) ? (raw <= 1 ? raw * 100 : raw) : null
          // shortRatio in this endpoint = days to cover, sanity-check 0-100 range
          const rawRatio = Number(latest.shortRatio)
          const ratio = Number.isFinite(rawRatio) && rawRatio > 0 && rawRatio < 100 ? rawRatio : null
          return { pct, ratio }
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
        // Finnhub metric keys for short interest:
        //   sharesShortPercentOfFloat - % of float sold short (decimal or %)
        //   shortPercent              - alias seen on some tickers
        //   shortRatio                - days to cover (typically 0-30)
        // We extract pct (% of float) and ratio (days to cover) separately.
        // Defensive: pct may be returned as decimal (0.15) or percentage (15.0).
        const pctRaw = typeof m['sharesShortPercentOfFloat'] === 'number'
          ? m['sharesShortPercentOfFloat']
          : typeof m['shortPercent'] === 'number'
          ? m['shortPercent']
          : null
        const floatPct = pctRaw === null
          ? null
          : (pctRaw <= 1 ? pctRaw * 100 : pctRaw)
        // shortRatio = days to cover; only accept if in a sane range (avoid
        // accidentally picking up % values that share the same field name)
        const rawRatio = typeof m['shortRatio'] === 'number' ? m['shortRatio'] : null
        const ratio = rawRatio !== null && rawRatio > 0 && rawRatio < 100 ? rawRatio : null
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
  let putCallOIRatio: number | null = null
  let totalCallOI = 0, totalPutOI = 0
  let totalCallVol = 0, totalPutVol = 0
  let maxPainStrike: number | null = null
  let avgIVCall: number | null = null, avgIVPut: number | null = null
  const unusualActivity: UnusualOption[] = []

  if (chain?.options?.length) {
    type OptionContract = Record<string, unknown> & { greeks?: Record<string, unknown> }
    const calls = chain.options.filter((o: OptionContract) => o.option_type === 'call')
    const puts  = chain.options.filter((o: OptionContract) => o.option_type === 'put')

    // Volume + OI ratios use aggregate sums across the front N monthly
    // expiries (computed in fetchOptionsChain) — single-expiry P/C
    // ratios were misleading on tickers where front-month volume is
    // skewed by event-driven flow (e.g., earnings-week put buying with
    // simultaneous call-side bid pulls). Aggregating across expiries
    // produces ratios comparable to terminal sources (Barchart etc).
    totalCallVol = chain.aggregateVolCalls ?? 0
    totalPutVol  = chain.aggregateVolPuts ?? 0
    totalCallOI  = chain.aggregateOICalls ?? 0
    totalPutOI   = chain.aggregateOIPuts ?? 0

    putCallRatio   = totalCallVol > 0 ? totalPutVol / totalCallVol : null
    putCallOIRatio = totalCallOI  > 0 ? totalPutOI  / totalCallOI  : null

    // Diagnostic — verify aggregate vs primary-expiry math.
    // Permanent observability. Search Railway logs for "[options ${ticker}]".
    const primaryCallVol = calls.reduce((s: number, o: OptionContract) => s + (Number(o.volume) || 0), 0)
    const primaryPutVol  = puts.reduce((s: number, o: OptionContract) => s + (Number(o.volume) || 0), 0)
    console.log(`[options ${ticker}] primary_expiry=${chain.expiry} aggregate_expiries=${(chain.aggregateExpiries ?? []).join(',')} primaryCallVol=${primaryCallVol} primaryPutVol=${primaryPutVol} aggCallVol=${totalCallVol} aggPutVol=${totalPutVol} aggCallOI=${totalCallOI} aggPutOI=${totalPutOI} pcVol=${putCallRatio?.toFixed(2) ?? 'null'} pcOI=${putCallOIRatio?.toFixed(2) ?? 'null'}`)

    // IV skew computed from primary-expiry chain only (mixing far-month
    // and near-month IVs would dilute the term-structure signal).
    const callIVs = calls.map((o: OptionContract) => Number(o.greeks?.mid_iv) || 0).filter(Boolean)
    const putIVs  = puts.map((o: OptionContract) => Number(o.greeks?.mid_iv) || 0).filter(Boolean)
    avgIVCall = callIVs.length ? (callIVs as number[]).reduce((a: number, b: number) => a + b, 0) / callIVs.length : null
    avgIVPut  = putIVs.length ? (putIVs as number[]).reduce((a: number, b: number) => a + b, 0) / putIVs.length : null

    // Unusual sweeps: volume > 3x open interest is a flag.
    // Scoped to primary expiry — sweep is an expiry-specific event.
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

    // Max pain: strike where total options value is minimized.
    // Scoped to primary expiry — max pain is an expiry-specific concept.
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
  const aggExpCount = chain?.aggregateExpiries?.length ?? 0
  const aggLabel = aggExpCount > 1
    ? ` (across ${aggExpCount} expiries: ${chain?.aggregateExpiries?.join(', ')})`
    : chain?.expiry ? ` (expiry ${chain.expiry})` : ''
  const lines = [
    `=== OPTIONS FLOW & SHORT INTEREST ===`,
    ``,
    chain
      ? [
          `Options${aggLabel}:`,
          putCallRatio !== null ? `  Put/Call Vol ratio: ${putCallRatio.toFixed(2)} — ${putCallSignal.toUpperCase()} signal` : '',
          putCallOIRatio !== null ? `  Put/Call OI ratio: ${putCallOIRatio.toFixed(2)}` : '',
          `  Call OI: ${totalCallOI.toLocaleString()} | Put OI: ${totalPutOI.toLocaleString()}`,
          maxPainStrike ? `  Max pain strike (${chain.expiry}): $${maxPainStrike} (price gravitates here at expiry)` : '',
          ivSkew !== null ? `  IV skew (put-call, ${chain.expiry}): ${(ivSkew*100).toFixed(1)}% — market ${ivSignal}` : '',
          gexNote ? `  GEX: ${gexNote}` : '',
          unusualActivity.length > 0
            ? [`  Unusual sweeps detected (${chain.expiry}):`,
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
            ? `  Proxy signal from options: P/C Vol ratio ${putCallRatio.toFixed(2)} (${putCallSignal}) — ${putCallRatio > 1.0 ? 'elevated put buying suggests significant bearish positioning exists' : putCallRatio < 0.7 ? 'low put activity suggests limited bearish conviction' : 'balanced positioning'}.`
            : `  No proxy data available. Treat short position data as unknown — do not cite absence as evidence.`,
        ].filter(Boolean).join('\n'),
  ].filter(Boolean)

  return {
    putCallRatio, putCallOIRatio, putCallSignal,
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
