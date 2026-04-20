// ═════════════════════════════════════════════════════════════
// app/lib/market-regime.ts
//
// Classifies the current market as risk-on, risk-off, or mixed
// based on SPY change, VIX level, and sector breadth.
//
// Why this exists:
//   The old Today's Movers system classified news without any
//   context for market regime. Bullish news in a risk-off market
//   often sells off anyway — the prompt was missing this.
//
// Sources: Finnhub quotes for SPY, VIX, and sector ETFs.
// Returns: regime label + the raw data that drove it + a short
// "context paragraph" that can be injected into AI prompts.
// ═════════════════════════════════════════════════════════════

const FINNHUB_BASE = 'https://finnhub.io/api/v1'

const SECTOR_ETFS = ['XLK', 'XLV', 'XLF', 'XLE', 'XLY', 'XLP', 'XLI', 'XLB', 'XLRE', 'XLU', 'XLC']

export interface MarketRegime {
  regime: 'risk-on' | 'risk-off' | 'mixed'
  spyChangePct: number | null
  vixLevel: number | null
  vixChangePct: number | null
  sectorsUp: number          // count of sectors positive
  sectorsDown: number        // count of sectors negative
  sectorBreadth: number      // (up - down) / total
  contextParagraph: string   // Human-readable 2-3 sentences for AI prompts
  fetchedAt: string
}

/**
 * Fetch a simple Finnhub quote, returning percent change.
 * Returns null on any error. Short timeout so we don't stall the pipeline.
 */
async function fetchQuote(symbol: string, token: string): Promise<{ c: number; dp: number } | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(`${FINNHUB_BASE}/quote?symbol=${symbol}&token=${token}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return null
    const q = await res.json()
    if (typeof q?.dp !== 'number' || typeof q?.c !== 'number') return null
    return { c: q.c, dp: q.dp }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch and classify current market regime.
 * Always returns a regime — never throws. Falls back to 'mixed' on errors.
 */
export async function getMarketRegime(): Promise<MarketRegime> {
  const token = process.env.FINNHUB_API_KEY
  const now = new Date().toISOString()

  if (!token) {
    return {
      regime: 'mixed',
      spyChangePct: null,
      vixLevel: null,
      vixChangePct: null,
      sectorsUp: 0,
      sectorsDown: 0,
      sectorBreadth: 0,
      contextParagraph: 'Market regime unavailable (Finnhub not configured).',
      fetchedAt: now,
    }
  }

  // Fetch SPY, VIX, and all 11 sector ETFs in parallel
  const [spy, vix, ...sectors] = await Promise.all([
    fetchQuote('SPY', token),
    fetchQuote('^VIX', token),
    ...SECTOR_ETFS.map(s => fetchQuote(s, token)),
  ])

  const spyChangePct = spy?.dp ?? null
  const vixLevel = vix?.c ?? null
  const vixChangePct = vix?.dp ?? null

  const sectorData = sectors.map((s, i) => ({ etf: SECTOR_ETFS[i], change: s?.dp ?? null }))
  const sectorsWithData = sectorData.filter(s => s.change !== null)
  const sectorsUp = sectorsWithData.filter(s => (s.change ?? 0) > 0.1).length
  const sectorsDown = sectorsWithData.filter(s => (s.change ?? 0) < -0.1).length
  const sectorBreadth = sectorsWithData.length > 0
    ? (sectorsUp - sectorsDown) / sectorsWithData.length
    : 0

  // ── Regime classification ─────────────────────────────────
  //
  // Strongly risk-on:  SPY up, VIX down or below 15, breadth > +0.4
  // Strongly risk-off: SPY down, VIX up or above 20, breadth < -0.4
  // Mixed:             anything in between
  //
  // We weight each input roughly equally. This is intentionally
  // simple — the goal is to inject context into the AI prompt,
  // not to be the final word on regime.
  let regime: MarketRegime['regime'] = 'mixed'

  let riskOnScore = 0
  let riskOffScore = 0

  // SPY signal
  if (spyChangePct !== null) {
    if (spyChangePct > 0.3) riskOnScore += 1
    else if (spyChangePct < -0.3) riskOffScore += 1
  }

  // VIX level signal (absolute level matters more than change)
  if (vixLevel !== null) {
    if (vixLevel < 15) riskOnScore += 1
    else if (vixLevel > 20) riskOffScore += 1
  }

  // VIX change signal (direction matters)
  if (vixChangePct !== null) {
    if (vixChangePct < -2) riskOnScore += 1       // VIX falling hard = risk-on
    else if (vixChangePct > 2) riskOffScore += 1  // VIX spiking = risk-off
  }

  // Breadth signal
  if (sectorBreadth > 0.4) riskOnScore += 1
  else if (sectorBreadth < -0.4) riskOffScore += 1

  if (riskOnScore >= 2 && riskOffScore === 0) regime = 'risk-on'
  else if (riskOffScore >= 2 && riskOnScore === 0) regime = 'risk-off'
  else regime = 'mixed'

  // ── Context paragraph for AI prompts ──────────────────────
  const parts: string[] = []
  if (spyChangePct !== null) {
    const dir = spyChangePct >= 0 ? 'up' : 'down'
    parts.push(`SPY is ${dir} ${Math.abs(spyChangePct).toFixed(2)}% today`)
  }
  if (vixLevel !== null) {
    const vixDesc = vixLevel < 15 ? 'low (complacent)' : vixLevel < 20 ? 'moderate' : vixLevel < 25 ? 'elevated' : 'high (fearful)'
    const vixChg = vixChangePct !== null
      ? ` (${vixChangePct >= 0 ? '+' : ''}${vixChangePct.toFixed(1)}%)`
      : ''
    parts.push(`VIX at ${vixLevel.toFixed(1)}${vixChg} — ${vixDesc}`)
  }
  if (sectorsWithData.length > 0) {
    parts.push(`${sectorsUp}/${sectorsWithData.length} sectors green, ${sectorsDown}/${sectorsWithData.length} red (breadth ${(sectorBreadth * 100).toFixed(0)}%)`)
  }

  const regimeDesc = regime === 'risk-on'
    ? 'Risk-on environment — bullish news has tailwinds, bearish news may be shrugged off.'
    : regime === 'risk-off'
      ? 'Risk-off environment — bearish news gets punished, bullish news may fade. Flight to safety likely.'
      : 'Mixed/neutral environment — news drives idiosyncratic moves rather than broad risk-on/risk-off flows.'

  const contextParagraph = parts.length > 0
    ? `${parts.join('. ')}. ${regimeDesc}`
    : regimeDesc

  return {
    regime,
    spyChangePct,
    vixLevel,
    vixChangePct,
    sectorsUp,
    sectorsDown,
    sectorBreadth: Math.round(sectorBreadth * 100) / 100,
    contextParagraph,
    fetchedAt: now,
  }
}
