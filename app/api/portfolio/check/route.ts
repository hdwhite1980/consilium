/**
 * Wali-OS — Position Health Check
 * GET /api/portfolio/check?ticker=NVDA  — single position
 * POST /api/portfolio/check             — all positions
 *
 * Stocks: RSI, volume, P&L vs entry/stop/target
 * Options: live Greeks (delta/theta/IV), intrinsic vs time value,
 *          moneyness, days to expiry, P&L on premium
 *
 * ─────────────────────────────────────────────────────────────
 * 2026-04-29 — Major rewrite incorporating 9 improvements:
 *
 *   1. True directional exposure (delta-aware, not just shares)
 *   2. (Lives in portfolio/route.ts) Skip summary on 1-position accounts
 *   3. Lead-with-verdict structure (UI side, but reason/action ordered for it)
 *   4. "Save-path" context — earnings/economic catalysts before expiry
 *   5. Honest bid/ask math instead of mid-price hopium
 *   6. Wall-clock deadline ("Expires Friday 4pm ET — 22h") not just "1d"
 *   7. (Lives in portfolio/route.ts) Don't conflate position-level vs underlying-level
 *   8. TERMINAL verdict tier — short-circuit LLM, emit static template
 *   9. Council-history integration — pull verdict_log, surface alignment/contradiction
 *
 * Order of new sections in this file matches the order above.
 * ─────────────────────────────────────────────────────────────
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const TRADIER_KEY = process.env.TRADIER_API_KEY
const TRADIER_BASE = TRADIER_KEY
  ? 'https://api.tradier.com/v1'
  : 'https://sandbox.tradier.com/v1'

const FINNHUB_KEY = process.env.FINNHUB_API_KEY

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PositionCheck {
  ticker: string
  position_type: 'stock' | 'option'

  // Underlying / stock data
  underlyingPrice: number
  underlyingChange1D: number
  underlyingRsi: number | null
  underlyingVolumeRatio: number | null

  // Stock-specific
  shares?: number
  entryPrice: number | null
  pnlPct: number | null
  pnlDollar: number | null
  stopLoss: number | null
  takeProfit: number | null
  pctFromStop: number | null
  pctFromTarget: number | null

  // Options-specific
  optionType?: 'call' | 'put'
  strike?: number
  expiry?: string
  contracts?: number
  entryPremium: number | null
  currentPremium: number | null
  optionPnlPct: number | null
  optionPnlDollar: number | null
  daysToExpiry: number | null
  timeDecayUrgent: boolean
  delta: number | null
  theta: number | null
  gamma: number | null
  vega: number | null
  impliedVolatility: number | null
  intrinsicValue: number | null
  timeValue: number | null
  moneyness: 'deep_itm' | 'itm' | 'atm' | 'otm' | 'deep_otm'
  breakeven: number | null

  // ── NEW (2026-04-29) ────────────────────────────────────────

  // (1) True directional exposure
  /** Net dollar exposure to the underlying. Positive = long the underlying,
   *  negative = short. For long puts on a $9 stock with 10 contracts and -0.287
   *  delta, this is roughly -0.287 × 10 × 100 × 9 = -$258. */
  directionalExposure: number | null
  /** Total capital tied up in this position. Stock: shares × cost. Option: premium paid total.
   *  Used to distinguish "money at risk" from "directional exposure" — they differ for options. */
  capitalAtRisk: number | null

  // (5) Honest bid/ask
  bid: number | null
  ask: number | null
  /** Realistic dollar proceeds if you sold right now, accounting for bid-ask spread. */
  realisticProceedsLow: number | null
  realisticProceedsHigh: number | null
  /** Plain-language note for the UI: "current bid is $0.05, you'd realistically net $40-$70" */
  realisticProceedsNote: string | null

  // (6) Wall-clock deadline
  /** Hours until option expiry. Used for sub-day urgency display. */
  hoursUntilExpiry: number | null
  /** Pre-formatted deadline string for UI: "Expires Fri 4:00pm ET — 22h" */
  deadlineLabel: string | null

  // (4) Save-path context — what would actually save this trade?
  savePathSummary: string | null
  savePathProbabilityVerbal: string | null   // "very unlikely" / "unlikely" / "plausible" / "likely"
  savePathProbabilityNumeric: string | null  // "~3%" / "5-10%" / "20-30%"

  // (8) TERMINAL classification
  /** True when the position has effectively no realistic recovery path.
   *  When true, the LLM enrichment is skipped and a static template is used. */
  terminal: boolean
  /** Why the position is terminal. */
  terminalReason: string | null

  // (9) Council-history integration
  councilHistory: CouncilHistoryContext | null

  // (10) Bundle context — rich technical/fundamental data from the persisted analyses.signal_bundle
  // (added 2026-05-06 to fix the Health Check "no RSI or volume data" gap when
  // Finnhub indicators return null. The bundle is built during full Council runs
  // and persists detailed snapshots that we can surface back into Health Check prose.)
  bundleContext: BundleContext | null

  // Verdict + prose
  verdict: 'EXIT' | 'WATCH' | 'HOLD' | 'ADD' | 'TERMINAL'
  conviction: 'high' | 'medium' | 'low'
  reason: string
  action: string
  flags: string[]
}

export interface CouncilHistoryContext {
  /** Most recent verdict for this ticker (matching the user). */
  recentSignal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  recentConfidence: number | null
  recentEntry: number | null
  recentStop: number | null
  recentTarget: number | null
  recentTimeframe: string | null
  recentPersona: string | null
  daysSinceVerdict: number
  /** 'pending' | 'correct' | 'incorrect' from outcome_1w (preferred) or outcome_1m. */
  outcomeStatus: 'pending' | 'correct' | 'incorrect' | 'unknown'
  outcomeHorizon: '1w' | '1m' | null
  /** True when the user's CURRENT position contradicts the Council's most recent direction.
   *  E.g., user holds bearish puts but Council called BULLISH. */
  positionContradictsCouncil: boolean
  /** Plain-language summary of alignment/contradiction. */
  alignmentNote: string
  /** Set when there's a different-persona run from the same day with a different signal. */
  personaDisagreement: string | null
}

/**
 * Rich indicator context pulled from analyses.signal_bundle for the most recent
 * full Council run. Used to give Health Check a richer prompt than Finnhub
 * `/quote`+`/indicator` alone provides — the bundle has full technicals,
 * fundamentals, smart-money signal, and conviction data that Health Check
 * was previously ignoring.
 *
 * All fields are optional because:
 *   - Some bundles persist only a subset of the full bundle (the analyze
 *     route's projection has changed over time)
 *   - Forex/fund tickers don't have all of these (e.g., no insiders for forex)
 *   - The most-recent bundle may be from an older code era with a narrower shape
 *
 * Each field is shaped to be directly citable by the LLM in narrative prose.
 */
export interface BundleContext {
  /** ISO timestamp of the persisted bundle. Used for staleness reasoning. */
  bundleAt: string
  /** Hours since the bundle was built. The LLM uses this to decide whether
   *  the indicators below are fresh enough to cite or stale enough to caveat. */
  hoursSinceBundle: number

  // ── Technicals (from bundle.technicals) ─────────────────────
  rsi: number | null
  macdHistogram: number | null
  /** Position relative to SMA50: 'above' | 'below' | null */
  sma50Position: 'above' | 'below' | null
  /** Position relative to SMA200: 'above' | 'below' | null */
  sma200Position: 'above' | 'below' | null
  /** % distance from price to SMA200 (positive = above) */
  pctFromSma200: number | null
  /** ATR (average true range) — used to size stops/targets relative to volatility */
  atr: number | null
  /** Recent volume vs 20-day average (1.0 = normal, 2.0 = doubled) */
  volumeVs20Day: number | null
  /** Trend label from technicals module: 'strong_uptrend' | 'uptrend' | 'sideways' | 'downtrend' | 'strong_downtrend' */
  trendLabel: string | null

  // ── Smart money (from bundle.smartMoney) ────────────────────
  /** 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell' — already magnitude-floored per Bug 14 */
  insiderSignal: string | null
  /** Net insider transaction value (USD), magnitude-floored. Positive = buys, negative = sells. */
  insiderNetValue: number | null
  /** Pre-computed summary line, e.g. "Officers buying $4.2M (concentrated in CEO)" */
  insiderSummary: string | null

  // ── Fundamentals (from bundle.fundamentals) ─────────────────
  /** Forward P/E ratio if available */
  forwardPE: number | null
  /** Trailing P/E ratio if available */
  trailingPE: number | null
  /** Days until next earnings event. Negative = earnings within last X days. Null = unknown. */
  daysToEarnings: number | null
  /** Pre-computed cash & runway line, e.g. "Cash $2.1B, FCF -$340M/q, runway 6 quarters" */
  cashAndRunway: string | null

  // ── Conviction (from bundle.conviction) ─────────────────────
  /** 'BULLISH' | 'BEARISH' | 'NEUTRAL' — the quantitative engine's standalone signal */
  convictionDirection: string | null
  /** 0-1 score: how well the qualitative + quantitative layers agree */
  convergenceScore: number | null

  // ── Options flow (from bundle.optionsFlow) ──────────────────
  // Surfaced for Health Check narrative — gives the LLM real options data
  // to cite when assessing whether a position is held in supportive or
  // contrary flow context. Not the full chain (Health Check isn't picking
  // strikes), just the highest-signal aggregated data points.
  /** Put/Call volume ratio (1.0 = balanced, >1.0 = more puts than calls trading) */
  putCallRatio: number | null
  /** Pre-computed signal label: 'bullish' | 'neutral' | 'bearish' (high P/C often = squeeze potential) */
  putCallSignal: string | null
  /** Implied-volatility signal: 'elevated' | 'normal' | 'compressed' relative to historical */
  ivSignal: string | null
  /** Gamma exposure direction: 'positive' (mean-reversion regime) | 'negative' (trending regime) */
  gexSignal: string | null
  /** Max pain strike — price gravitates here at expiry, useful pinning context */
  maxPainStrike: number | null
  /** Count of unusual sweeps detected, with the most notable summarized for narrative */
  unusualSweepCount: number | null
  /** Pre-computed summary of the most notable unusual sweep, e.g. "$140 put 1886 vol vs 384 OI" */
  topUnusualSweep: string | null
}

interface OptionDataResult {
  currentPremium: number | null
  bid: number
  ask: number
  volume: number
  openInterest: number
  delta: number | null
  theta: number | null
  gamma: number | null
  vega: number | null
  impliedVolatility: number | null
}

interface UnderlyingData {
  price: number
  change1D: number
  volumeRatio: number | null
  rsi: number | null
  volume: number | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Underlying data fetcher (Finnhub)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchUnderlyingData(ticker: string): Promise<UnderlyingData | null> {
  if (!FINNHUB_KEY) return null
  try {
    const [qr, mr, rr] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB_KEY}`),
      fetch(`https://finnhub.io/api/v1/indicator?symbol=${ticker}&resolution=D&from=${Math.floor(Date.now()/1000) - 30*86400}&to=${Math.floor(Date.now()/1000)}&indicator=rsi&timeperiod=14&token=${FINNHUB_KEY}`),
    ])
    if (!qr.ok) return null
    const q = await qr.json()
    const price = q.c || 0
    const change1D = q.dp || 0

    let volumeRatio: number | null = null
    if (mr.ok) {
      const m = await mr.json()
      const avgVol = m.metric && m.metric['10DayAverageTradingVolume']
        ? m.metric['10DayAverageTradingVolume'] * 1e6 : null
      if (avgVol && q.v) volumeRatio = parseFloat((q.v / avgVol).toFixed(2))
    }

    let rsi = null
    if (rr.ok) {
      const r = await rr.json()
      if (Array.isArray(r.rsi) && r.rsi.length) {
        rsi = parseFloat(r.rsi[r.rsi.length - 1].toFixed(1))
      }
    }

    return { price, change1D, volumeRatio, rsi, volume: q.v || null }
  } catch { return null }
}

// ─────────────────────────────────────────────────────────────────────────────
// Live option data (Tradier)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchOptionData(
  underlying: string,
  optionType: 'call' | 'put',
  strike: number,
  expiry: string,
): Promise<OptionDataResult | null> {
  try {
    const chainRes = await fetch(
      `${TRADIER_BASE}/markets/options/chains?symbol=${underlying}&expiration=${expiry}&greeks=true`,
      { headers: { Authorization: `Bearer ${TRADIER_KEY}`, Accept: 'application/json' } }
    )
    if (!chainRes.ok) return null
    const chain = await chainRes.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: any[] = chain.options?.option ?? []

    const contract = options.find(o =>
      o.option_type === optionType &&
      Math.abs(o.strike - strike) < 0.01
    )
    if (!contract) {
      const sameType = options.filter(o => o.option_type === optionType)
      const closest = sameType.sort((a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike))[0]
      if (!closest) return null
      return parseContractData(closest)
    }
    return parseContractData(contract)
  } catch { return null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContractData(contract: any): OptionDataResult {
  const bid = contract.bid || 0
  const ask = contract.ask || 0
  const midpoint = bid > 0 && ask > 0
    ? parseFloat(((bid + ask) / 2).toFixed(2))
    : contract.last || null

  const greeks = contract.greeks || {}
  return {
    currentPremium: midpoint,
    bid, ask,
    volume: contract.volume || 0,
    openInterest: contract.open_interest || 0,
    delta: greeks.delta != null ? parseFloat(greeks.delta.toFixed(3)) : null,
    theta: greeks.theta != null ? parseFloat(greeks.theta.toFixed(3)) : null,
    gamma: greeks.gamma != null ? parseFloat(greeks.gamma.toFixed(4)) : null,
    vega: greeks.vega != null ? parseFloat(greeks.vega.toFixed(3)) : null,
    impliedVolatility: greeks.mid_iv != null ? parseFloat(greeks.mid_iv.toFixed(3)) : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Moneyness
// ─────────────────────────────────────────────────────────────────────────────

function getMoneyness(
  optionType: 'call' | 'put',
  strike: number,
  underlyingPrice: number,
): PositionCheck['moneyness'] {
  const diff = optionType === 'call'
    ? (underlyingPrice - strike) / strike
    : (strike - underlyingPrice) / strike

  if (diff > 0.10)  return 'deep_itm'
  if (diff > 0.01)  return 'itm'
  if (diff > -0.01) return 'atm'
  if (diff > -0.10) return 'otm'
  return 'deep_otm'
}

// ═════════════════════════════════════════════════════════════════════════════
// (1) True directional exposure
// ═════════════════════════════════════════════════════════════════════════════
//
// For stocks: shares × current price = capital, sign always +
// For long calls:  +|delta| × contracts × 100 × underlying_price (long the underlying)
// For long puts:   -|delta| × contracts × 100 × underlying_price (short the underlying)
//
// Capital at risk:
//   Stock: shares × entry (or current if no entry)
//   Long option: entry_premium × contracts × 100 (the most you can lose)

interface ExposureResult {
  directionalExposure: number | null
  capitalAtRisk: number | null
}

function computeExposure(args: {
  isOption: boolean
  optionType?: 'call' | 'put'
  shares?: number
  contracts?: number
  delta: number | null
  entryPrice: number | null      // stock entry
  entryPremium: number | null    // option entry premium
  underlyingPrice: number
}): ExposureResult {
  const { isOption, optionType, shares, contracts, delta, entryPrice, entryPremium, underlyingPrice } = args

  if (!isOption) {
    if (!shares || shares <= 0) return { directionalExposure: null, capitalAtRisk: null }
    const exposure = shares * underlyingPrice
    const capital = entryPrice ? shares * entryPrice : exposure
    return {
      directionalExposure: parseFloat(exposure.toFixed(2)),
      capitalAtRisk: parseFloat(capital.toFixed(2)),
    }
  }

  // Option path
  if (!contracts || contracts <= 0) return { directionalExposure: null, capitalAtRisk: null }

  // Capital at risk for long options = total premium paid
  const capital = entryPremium ? entryPremium * contracts * 100 : null

  // Directional exposure needs delta
  if (delta === null) return { directionalExposure: null, capitalAtRisk: capital }

  // Long calls: delta is +, exposure is + (long the stock)
  // Long puts:  delta is -, exposure is - (short the stock)
  // We treat both long calls and long puts here. (Short options would flip signs;
  // not currently supported in the schema as a position type.)
  const exposureMagnitude = Math.abs(delta) * contracts * 100 * underlyingPrice
  const sign = optionType === 'put' ? -1 : 1
  const exposure = sign * exposureMagnitude

  return {
    directionalExposure: parseFloat(exposure.toFixed(2)),
    capitalAtRisk: capital,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// (5) Honest bid/ask math
// ═════════════════════════════════════════════════════════════════════════════
//
// Mid-price implies you can transact there. You can't. The realistic close
// price is the bid (or somewhere just above bid for marketable limits).

interface ProceedsResult {
  low: number | null
  high: number | null
  note: string | null
}

function computeRealisticProceeds(args: {
  bid: number
  ask: number
  contracts: number
  midpoint: number | null
}): ProceedsResult {
  const { bid, ask, contracts, midpoint } = args

  // No contract data, no proceeds estimate
  if (!contracts || contracts <= 0) return { low: null, high: null, note: null }

  // No bid means no buyer. You'd have to negotiate or accept market disposal.
  if (bid <= 0) {
    if (midpoint && midpoint > 0) {
      const midCents = midpoint * 100 * contracts
      return {
        low: 0,
        high: parseFloat((midCents * 0.5).toFixed(2)),
        note: `No bid — market makers won't quote. Mid is theoretical $${midpoint.toFixed(2)}; realistic exit is $0-$${(midCents * 0.5).toFixed(0)} via limit order, or expire worthless.`,
      }
    }
    return {
      low: 0,
      high: 0,
      note: `No bid available — likely zero recovery. Let it expire or close for whatever broker offers.`,
    }
  }

  // Normal bid/ask path
  const lowProceeds = bid * 100 * contracts                // sell at bid (instant)
  const highProceeds = midpoint
    ? Math.min(ask, midpoint) * 100 * contracts            // limit order at mid
    : ask * 100 * contracts                                // limit at ask (unlikely fill)

  // Spread sanity: if bid/ask spread is >50% of mid, flag it
  const spread = ask - bid
  const spreadPct = midpoint && midpoint > 0 ? (spread / midpoint) * 100 : 0
  let note: string
  if (spreadPct > 50) {
    note = `Wide spread: bid $${bid.toFixed(2)} / ask $${ask.toFixed(2)} (${spreadPct.toFixed(0)}% wide). Realistic close: $${lowProceeds.toFixed(0)}-$${highProceeds.toFixed(0)}. Mid is theoretical.`
  } else if (spread > 0) {
    note = `Bid $${bid.toFixed(2)} / ask $${ask.toFixed(2)}. Selling at bid nets $${lowProceeds.toFixed(0)}; limit at mid might get $${highProceeds.toFixed(0)}.`
  } else {
    note = `Bid/ask data limited. Estimate: $${lowProceeds.toFixed(0)}-$${highProceeds.toFixed(0)} depending on order type.`
  }

  return {
    low: parseFloat(lowProceeds.toFixed(2)),
    high: parseFloat(highProceeds.toFixed(2)),
    note,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// (6) Wall-clock deadline
// ═════════════════════════════════════════════════════════════════════════════
//
// US options expire at 4:00 PM ET on the expiry date (15:00 CT, 21:00 UTC during DST).
// We render in user-relative form: "Expires Fri 4:00pm ET — 22h" or "Expires today — 3h"

function buildDeadlineLabel(expiry: string | null, daysToExpiry: number | null): {
  hoursUntilExpiry: number | null
  label: string | null
} {
  if (!expiry || daysToExpiry === null) return { hoursUntilExpiry: null, label: null }

  // Options expire at 4pm ET. UTC offset: 20:00 UTC during DST, 21:00 UTC standard time.
  // We approximate at 20:00 UTC (DST is more common in trading) — close enough for display.
  const expiryDateUTC = new Date(`${expiry}T20:00:00Z`)
  const now = new Date()
  const msUntil = expiryDateUTC.getTime() - now.getTime()
  const hoursUntil = msUntil / 3_600_000

  if (msUntil < 0) {
    return { hoursUntilExpiry: hoursUntil, label: 'Expired' }
  }

  // Day-of-week label
  const dayOfWeek = expiryDateUTC.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' })

  // Same calendar day in user's tz?
  const expiryDay = expiryDateUTC.toLocaleDateString('en-US', { timeZone: 'America/New_York' })
  const todayDay = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' })
  const isSameDay = expiryDay === todayDay

  if (hoursUntil < 24) {
    if (isSameDay) {
      const hoursPart = Math.floor(hoursUntil)
      const minutesPart = Math.round((hoursUntil - hoursPart) * 60)
      return {
        hoursUntilExpiry: parseFloat(hoursUntil.toFixed(2)),
        label: `Expires today 4:00pm ET — ${hoursPart}h ${minutesPart}m`,
      }
    }
    return {
      hoursUntilExpiry: parseFloat(hoursUntil.toFixed(2)),
      label: `Expires ${dayOfWeek} 4:00pm ET — ${hoursUntil.toFixed(0)}h`,
    }
  }

  // > 24h, fall back to day-count + day-of-week
  const dayLabel = daysToExpiry === 1 ? 'tomorrow'
    : daysToExpiry <= 6 ? dayOfWeek
    : `${daysToExpiry}d`
  return {
    hoursUntilExpiry: parseFloat(hoursUntil.toFixed(2)),
    label: `Expires ${dayLabel} 4:00pm ET (${daysToExpiry}d)`,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// (4) Save-path context — what would actually save this trade?
// ═════════════════════════════════════════════════════════════════════════════
//
// For a position to recover, the underlying needs to move enough in the right
// direction before expiry. We compute:
//   - move needed (in % of underlying)
//   - days available
//   - any scheduled catalysts in the window (earnings, econ events)
//   - probability band
//
// The probability is informed by ATR-based expected move: if the move needed
// is N×ATR over T days, we compare to the realized probability of that-or-larger
// moves historically. We don't pull live ATR here — we use a heuristic from
// daysToExpiry and the abs(breakevenDistPct).

interface SavePathArgs {
  isOption: boolean
  optionType?: 'call' | 'put'
  underlyingPrice: number
  strike?: number
  breakeven: number | null
  daysToExpiry: number | null
  hoursUntilExpiry: number | null
  moneyness: PositionCheck['moneyness']
  optionPnlPct: number | null
  earningsContext: { hasEarningsBeforeExpiry: boolean; daysToEarnings: number | null }
}

interface SavePathResult {
  summary: string | null
  probabilityVerbal: string | null
  probabilityNumeric: string | null
}

function computeSavePath(args: SavePathArgs): SavePathResult {
  const { isOption, optionType, underlyingPrice, breakeven, daysToExpiry, hoursUntilExpiry, moneyness, earningsContext } = args

  // Stock positions: not really a "save path" — they recover gradually with reversion.
  // Skip this section entirely for stocks; their P&L recovery isn't binary.
  if (!isOption) {
    return { summary: null, probabilityVerbal: null, probabilityNumeric: null }
  }

  if (breakeven === null || daysToExpiry === null) {
    return { summary: null, probabilityVerbal: null, probabilityNumeric: null }
  }

  // For options, the move-to-breakeven percentage is the gating number
  const movePct = ((breakeven - underlyingPrice) / underlyingPrice) * 100
  const direction = optionType === 'call'
    ? (movePct > 0 ? 'up' : 'already past breakeven')
    : (movePct < 0 ? 'down' : 'already past breakeven')
  const movePctAbs = Math.abs(movePct)

  // If the position is already past breakeven (deep ITM call when underlying > strike + premium,
  // or deep ITM put when underlying < strike - premium), the save path is trivially "stay here."
  if (direction === 'already past breakeven') {
    return {
      summary: `Already past breakeven. Position profits as long as underlying stays in-the-money through expiry.`,
      probabilityVerbal: moneyness === 'deep_itm' ? 'likely' : 'plausible',
      probabilityNumeric: moneyness === 'deep_itm' ? '60-80%' : '40-60%',
    }
  }

  // Compute time horizon in fractional days for sub-day options
  const timeHorizonDays = hoursUntilExpiry !== null && hoursUntilExpiry < 48
    ? hoursUntilExpiry / 24
    : daysToExpiry

  // Heuristic probability of needing a move >= movePctAbs over timeHorizonDays.
  // Stock daily moves are roughly Gaussian with stdev ~1.5% for major liquid names,
  // up to ~4% for small-cap volatile names. We use 2% as a generic stdev and scale
  // by sqrt(time). This isn't Black-Scholes — it's a back-of-envelope sanity check
  // appropriate for "probability band" output, not a precise forecast.
  const dailyStdev = 2.0  // % per day, rough average
  const horizonStdev = dailyStdev * Math.sqrt(Math.max(0.04, timeHorizonDays))  // floor at ~1h
  const sigmas = movePctAbs / horizonStdev

  // Convert sigmas to a verbal band. We're talking single-tail probability here
  // (move in one specific direction, not "either direction").
  let probabilityVerbal: string
  let probabilityNumeric: string
  if (sigmas > 3.0) {
    probabilityVerbal = 'very unlikely'
    probabilityNumeric = '<2%'
  } else if (sigmas > 2.0) {
    probabilityVerbal = 'very unlikely'
    probabilityNumeric = '~2-5%'
  } else if (sigmas > 1.5) {
    probabilityVerbal = 'unlikely'
    probabilityNumeric = '~5-10%'
  } else if (sigmas > 1.0) {
    probabilityVerbal = 'unlikely'
    probabilityNumeric = '~10-20%'
  } else if (sigmas > 0.5) {
    probabilityVerbal = 'plausible'
    probabilityNumeric = '~25-35%'
  } else {
    probabilityVerbal = 'plausible'
    probabilityNumeric = '~35-45%'
  }

  // Catalyst boost: earnings before expiry can produce moves >2 sigma routinely.
  // If earnings is in window, bump probability up one tier and note it.
  let catalystNote = ''
  if (earningsContext.hasEarningsBeforeExpiry) {
    catalystNote = ` Earnings ${earningsContext.daysToEarnings === 0 ? 'today' : earningsContext.daysToEarnings === 1 ? 'tomorrow' : `in ${earningsContext.daysToEarnings} days`} could trigger the needed move (binary risk works both ways).`
    // Bump up one tier
    if (probabilityVerbal === 'very unlikely') {
      probabilityVerbal = 'unlikely'
      probabilityNumeric = '~10-20%'
    } else if (probabilityVerbal === 'unlikely') {
      probabilityVerbal = 'plausible'
      probabilityNumeric = '~25-35%'
    } else {
      probabilityVerbal = 'plausible'
      probabilityNumeric = '~35-50%'
    }
  } else if (timeHorizonDays < 2) {
    catalystNote = ` No scheduled catalysts before close — would need an unscheduled news event.`
  }

  const horizonLabel = hoursUntilExpiry !== null && hoursUntilExpiry < 24
    ? `${hoursUntilExpiry.toFixed(0)}h`
    : `${daysToExpiry}d`

  const summary = `Underlying needs to move ${direction} ${movePctAbs.toFixed(1)}% in ${horizonLabel} to reach breakeven. ${probabilityVerbal} (${probabilityNumeric}).${catalystNote}`

  return { summary, probabilityVerbal, probabilityNumeric }
}

// ═════════════════════════════════════════════════════════════════════════════
// (4b) Earnings catalyst lookup
// ═════════════════════════════════════════════════════════════════════════════
//
// Quick lookup against Finnhub's earnings calendar to see if the underlying
// reports earnings between now and expiry. Used by computeSavePath above.

async function fetchEarningsBeforeExpiry(
  ticker: string,
  expiry: string | null,
): Promise<{ hasEarningsBeforeExpiry: boolean; daysToEarnings: number | null }> {
  if (!expiry || !FINNHUB_KEY) return { hasEarningsBeforeExpiry: false, daysToEarnings: null }

  try {
    const today = new Date().toISOString().split('T')[0]
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${expiry}&symbol=${ticker}&token=${FINNHUB_KEY}`
    const res = await fetch(url)
    if (!res.ok) return { hasEarningsBeforeExpiry: false, daysToEarnings: null }
    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = data.earningsCalendar ?? []
    if (!events.length) return { hasEarningsBeforeExpiry: false, daysToEarnings: null }

    const earningsDate = events[0].date
    const daysToEarnings = Math.floor(
      (new Date(earningsDate).getTime() - Date.now()) / 86400000
    )
    return { hasEarningsBeforeExpiry: true, daysToEarnings }
  } catch {
    return { hasEarningsBeforeExpiry: false, daysToEarnings: null }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// (8) TERMINAL classification
// ═════════════════════════════════════════════════════════════════════════════
//
// Some positions are mathematically over. Hard-coding these saves an LLM call,
// runs faster, and prevents Claude from accidentally suggesting hope.

function checkTerminal(args: {
  daysToExpiry: number | null
  hoursUntilExpiry: number | null
  moneyness: PositionCheck['moneyness']
  optionPnlPct: number | null
  bid: number | null
  isOption: boolean
}): { terminal: boolean; reason: string | null } {
  const { daysToExpiry, hoursUntilExpiry, moneyness, optionPnlPct, bid, isOption } = args

  if (!isOption) return { terminal: false, reason: null }

  // Already expired
  if (daysToExpiry !== null && daysToExpiry < 0) {
    return { terminal: true, reason: 'Position has expired. Settle/close to clear from your account.' }
  }

  // Same-day OTM
  if (hoursUntilExpiry !== null && hoursUntilExpiry < 6 && (moneyness === 'otm' || moneyness === 'deep_otm')) {
    return { terminal: true, reason: `Less than 6 hours to expiry and out-of-the-money. Will expire worthless absent a major catalyst.` }
  }

  // <= 1 day deep OTM
  if (daysToExpiry !== null && daysToExpiry <= 1 && moneyness === 'deep_otm') {
    return { terminal: true, reason: `Deep out-of-the-money with ≤1 day to expiry. Statistically expires worthless.` }
  }

  // No bid + close to expiry = nobody will buy this from you
  if (bid !== null && bid <= 0 && daysToExpiry !== null && daysToExpiry <= 3) {
    return { terminal: true, reason: `No bid quoted. Market makers won't pay for this contract; let it expire.` }
  }

  // 95%+ premium gone, OTM, < 5 days left
  if (
    optionPnlPct !== null && optionPnlPct <= -90 &&
    (moneyness === 'otm' || moneyness === 'deep_otm') &&
    daysToExpiry !== null && daysToExpiry <= 5
  ) {
    return { terminal: true, reason: `Premium down ${Math.abs(optionPnlPct).toFixed(0)}%, OTM, ≤${daysToExpiry}d to expiry. Effectively zero recovery path.` }
  }

  return { terminal: false, reason: null }
}

// ═════════════════════════════════════════════════════════════════════════════
// (10) Bundle context — pull rich indicator data from analyses.signal_bundle
// ═════════════════════════════════════════════════════════════════════════════
//
// Health Check previously relied on Finnhub /quote and /indicator for technicals.
// Finnhub free tier doesn't reliably return RSI or 10-day average volume, so the
// LLM was being told "RSI N/A | Volume N/A" and writing prose like "no RSI or
// volume data available to assess momentum." But the analyses table already has
// the full signal_bundle from the most recent Council run — including technicals,
// fundamentals, smart-money, and conviction data. Health Check should pull from
// there as a richer fallback (or primary source), not duplicate the Finnhub fetch.

async function fetchBundleContext(
  userId: string,
  ticker: string,
): Promise<BundleContext | null> {
  try {
    const admin = getAdmin()

    // Pull the most recent analysis for this user/ticker. Joining user_id ensures
    // we don't surface another user's bundle. If the user has never analyzed this
    // ticker, return null and let the LLM fall back to the council-history note.
    const { data: rows } = await admin
      .from('analyses')
      .select('signal_bundle, created_at')
      .eq('user_id', userId)
      .eq('ticker', ticker.toUpperCase())
      .order('created_at', { ascending: false })
      .limit(1)

    const row = rows?.[0]
    if (!row || !row.signal_bundle) return null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bundle = row.signal_bundle as any
    const bundleAt = row.created_at as string
    const hoursSinceBundle = Math.max(
      0,
      Math.floor((Date.now() - new Date(bundleAt).getTime()) / 3_600_000),
    )

    // ── Technicals ─────────────────────────────────────────────
    const tech = bundle.technicals ?? {}
    const rsi = numericOrNull(tech.rsi ?? tech.rsi14 ?? null)
    const macdHistogram = numericOrNull(tech.macdHistogram ?? tech.macd_histogram ?? null)

    const currentPrice = numericOrNull(bundle.currentPrice ?? bundle.current_price ?? null)
    const sma50 = numericOrNull(tech.sma50 ?? null)
    const sma200 = numericOrNull(tech.sma200 ?? null)
    const sma50Position: 'above' | 'below' | null =
      currentPrice !== null && sma50 !== null
        ? currentPrice >= sma50 ? 'above' : 'below'
        : null
    const sma200Position: 'above' | 'below' | null =
      currentPrice !== null && sma200 !== null
        ? currentPrice >= sma200 ? 'above' : 'below'
        : null
    const pctFromSma200 =
      currentPrice !== null && sma200 !== null && sma200 > 0
        ? ((currentPrice - sma200) / sma200) * 100
        : null

    const atr = numericOrNull(tech.atr ?? tech.atr14 ?? null)
    const volumeVs20Day = numericOrNull(
      tech.volumeRatio ?? tech.volume_ratio ?? tech.volumeVs20Day ?? null,
    )
    const trendLabel: string | null = typeof tech.trend === 'string'
      ? tech.trend
      : (typeof tech.trendLabel === 'string' ? tech.trendLabel : null)

    // ── Smart money ────────────────────────────────────────────
    const sm = bundle.smartMoney ?? {}
    const insiderSignal: string | null = typeof sm.insiderSignal === 'string'
      ? sm.insiderSignal
      : null
    const insiderNetValue = numericOrNull(sm.insiderNetValue ?? null)
    const insiderSummary: string | null = typeof sm.summary === 'string'
      ? sm.summary
      : (typeof sm.insiderSummary === 'string' ? sm.insiderSummary : null)

    // ── Fundamentals ───────────────────────────────────────────
    const fund = bundle.fundamentals ?? {}
    const forwardPE = numericOrNull(fund.forwardPE ?? fund.forward_pe ?? null)
    const trailingPE = numericOrNull(fund.trailingPE ?? fund.trailing_pe ?? fund.peRatio ?? null)
    const daysToEarnings = numericOrNull(fund.daysToEarnings ?? null)
    const cashAndRunway: string | null = typeof fund.cashAndRunway === 'string'
      ? fund.cashAndRunway
      : (typeof fund.runwaySummary === 'string' ? fund.runwaySummary : null)

    // ── Conviction ─────────────────────────────────────────────
    const conv = bundle.conviction ?? {}
    const convictionDirection: string | null = typeof conv.direction === 'string'
      ? conv.direction
      : null
    const convergenceScore = numericOrNull(conv.convergenceScore ?? conv.convergence_score ?? null)

    // ── Options flow ───────────────────────────────────────────
    // Reads from bundle.optionsFlow (post Bug-24 persistence). Null-safe
    // for older rows that predate the persistence fix — we just get nulls
    // and the buildBundleSnapshotLines helper skips lines for null values.
    const oflow = bundle.optionsFlow ?? null
    const putCallRatio = numericOrNull(oflow?.putCallRatio ?? null)
    const putCallSignal: string | null = typeof oflow?.putCallSignal === 'string' ? oflow.putCallSignal : null
    const ivSignal: string | null = typeof oflow?.ivSignal === 'string' ? oflow.ivSignal : null
    const gexSignal: string | null = typeof oflow?.gexSignal === 'string' ? oflow.gexSignal : null
    const maxPainStrike = numericOrNull(oflow?.maxPainStrike ?? null)
    const unusualSweeps = Array.isArray(oflow?.unusualActivity) ? oflow.unusualActivity : []
    const unusualSweepCount = unusualSweeps.length
    // Summarize the most notable unusual sweep for narrative use. Pick the one
    // with the largest vol/OI ratio (the strongest signal of flagged activity).
    let topUnusualSweep: string | null = null
    if (unusualSweepCount > 0) {
      const top = [...unusualSweeps]
        .filter(u => u && typeof u === 'object')
        .sort((a, b) => (numericOrNull(b.volOIRatio) ?? 0) - (numericOrNull(a.volOIRatio) ?? 0))[0]
      if (top) {
        const strikeStr = numericOrNull(top.strike) !== null ? `$${top.strike}` : '?'
        const typeStr = top.type ?? '?'
        const expStr = top.expiry ?? '?'
        const volStr = numericOrNull(top.volume) !== null ? top.volume.toLocaleString() : '?'
        const oiStr = numericOrNull(top.openInterest) !== null ? top.openInterest.toLocaleString() : '?'
        const ratioStr = numericOrNull(top.volOIRatio) !== null
          ? `${top.volOIRatio.toFixed(1)}× vol/OI`
          : ''
        topUnusualSweep = `${strikeStr} ${typeStr} ${expStr} — vol ${volStr} vs OI ${oiStr}${ratioStr ? ` (${ratioStr})` : ''}`
      }
    }

    return {
      bundleAt,
      hoursSinceBundle,
      rsi,
      macdHistogram,
      sma50Position,
      sma200Position,
      pctFromSma200: pctFromSma200 !== null ? parseFloat(pctFromSma200.toFixed(1)) : null,
      atr,
      volumeVs20Day,
      trendLabel,
      insiderSignal,
      insiderNetValue,
      insiderSummary,
      forwardPE,
      trailingPE,
      daysToEarnings,
      cashAndRunway,
      convictionDirection,
      convergenceScore,
      putCallRatio,
      putCallSignal,
      ivSignal,
      gexSignal,
      maxPainStrike,
      unusualSweepCount,
      topUnusualSweep,
    }
  } catch (e) {
    console.warn('[portfolio/check] bundleContext lookup failed:', (e as Error).message?.slice(0, 100))
    return null
  }
}

// PG NUMERIC may serialize as string; coerce defensively. Same helper as bug23.
function numericOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ═════════════════════════════════════════════════════════════════════════════
// (9) Council-history integration
// ═════════════════════════════════════════════════════════════════════════════
//
// Pulls the most recent verdict_log row(s) for this user/ticker and computes
// alignment with the current position direction.

async function fetchCouncilHistory(
  userId: string,
  ticker: string,
  positionDirection: 'long' | 'short' | 'neutral',
): Promise<CouncilHistoryContext | null> {
  try {
    const admin = getAdmin()

    // Pull last 14 days of verdicts for this ticker for this user.
    // We need the most recent one, but also any that are from the SAME date
    // but a different persona (to detect persona disagreement).
    const since = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0]
    const { data: verdicts } = await admin
      .from('verdict_log')
      .select('signal, confidence, entry_price, stop_loss, take_profit, time_horizon, persona, timeframe, outcome_1w, outcome_1m, verdict_date, created_at')
      .eq('user_id', userId)
      .eq('ticker', ticker.toUpperCase())
      .gte('verdict_date', since)
      .order('created_at', { ascending: false })
      .limit(10)

    if (!verdicts || verdicts.length === 0) return null

    const recent = verdicts[0]
    const verdictDate = new Date(recent.created_at)
    const daysSinceVerdict = Math.max(0, Math.floor(
      (Date.now() - verdictDate.getTime()) / 86400000
    ))

    // Outcome status — prefer 1w if available
    let outcomeStatus: CouncilHistoryContext['outcomeStatus'] = 'unknown'
    let outcomeHorizon: CouncilHistoryContext['outcomeHorizon'] = null
    if (recent.outcome_1w === 'correct' || recent.outcome_1w === 'incorrect') {
      outcomeStatus = recent.outcome_1w
      outcomeHorizon = '1w'
    } else if (recent.outcome_1w === 'pending') {
      outcomeStatus = 'pending'
      outcomeHorizon = '1w'
    } else if (recent.outcome_1m === 'correct' || recent.outcome_1m === 'incorrect') {
      outcomeStatus = recent.outcome_1m
      outcomeHorizon = '1m'
    }

    // Position-vs-Council alignment:
    //   Council BULLISH + user long      → aligned
    //   Council BULLISH + user short     → contradicts (e.g., bearish puts)
    //   Council BEARISH + user short     → aligned
    //   Council BEARISH + user long      → contradicts
    //   Council NEUTRAL                  → no alignment claim
    const councilBullish = recent.signal === 'BULLISH'
    const councilBearish = recent.signal === 'BEARISH'
    let positionContradictsCouncil = false
    if (councilBullish && positionDirection === 'short') positionContradictsCouncil = true
    if (councilBearish && positionDirection === 'long') positionContradictsCouncil = true

    // Build alignment note
    let alignmentNote: string
    if (recent.signal === 'NEUTRAL') {
      alignmentNote = `Council ran NEUTRAL ${recent.confidence ?? '?'}% on ${ticker} ${daysSinceVerdict === 0 ? 'today' : daysSinceVerdict === 1 ? 'yesterday' : `${daysSinceVerdict} days ago`} — no directional claim.`
    } else if (positionContradictsCouncil) {
      const positionDesc = positionDirection === 'short' ? 'bearish position' : 'bullish position'
      const councilDesc = recent.signal.toLowerCase()
      const outcomeDesc = outcomeStatus === 'correct'
        ? ` Council was right (outcome confirmed) — your position fights the validated thesis.`
        : outcomeStatus === 'incorrect'
        ? ` Council turned out to be wrong (outcome confirmed) — your contrarian bet was correct.`
        : outcomeStatus === 'pending'
        ? ` Council outcome still pending — your position is contrarian but the thesis hasn't resolved.`
        : ''
      alignmentNote = `Council called ${councilDesc} ${recent.confidence ?? '?'}% on ${ticker} ${daysSinceVerdict === 0 ? 'today' : daysSinceVerdict === 1 ? 'yesterday' : `${daysSinceVerdict} days ago`}. Your ${positionDesc} contradicts that direction.${outcomeDesc}`
    } else {
      const councilDesc = recent.signal.toLowerCase()
      const outcomeDesc = outcomeStatus === 'correct'
        ? ` Council was right (outcome confirmed) — your position aligns with a validated thesis.`
        : outcomeStatus === 'incorrect'
        ? ` Council turned out to be wrong (outcome confirmed) — your aligned position is at risk.`
        : outcomeStatus === 'pending'
        ? ` Council outcome pending; your position aligns with the active thesis.`
        : ''
      alignmentNote = `Council called ${councilDesc} ${recent.confidence ?? '?'}% on ${ticker} ${daysSinceVerdict === 0 ? 'today' : daysSinceVerdict === 1 ? 'yesterday' : `${daysSinceVerdict} days ago`}. Your position aligns with that direction.${outcomeDesc}`
    }

    // Persona disagreement: did a different-persona run on the same day produce a different signal?
    let personaDisagreement: string | null = null
    const sameDay = verdicts.filter(v => v.verdict_date === recent.verdict_date)
    if (sameDay.length > 1) {
      const otherSignals = sameDay
        .filter(v => v.persona !== recent.persona && v.signal !== recent.signal)
      if (otherSignals.length > 0) {
        const conflict = otherSignals[0]
        personaDisagreement = `Same-day ${conflict.persona ?? 'alternate'}-lens run was ${conflict.signal} ${conflict.confidence ?? '?'}% — internal disagreement on ${ticker}.`
      }
    }

    return {
      recentSignal: recent.signal as CouncilHistoryContext['recentSignal'],
      recentConfidence: recent.confidence ?? null,
      recentEntry: recent.entry_price ?? null,
      recentStop: recent.stop_loss ?? null,
      recentTarget: recent.take_profit ?? null,
      recentTimeframe: recent.timeframe ?? null,
      recentPersona: recent.persona ?? null,
      daysSinceVerdict,
      outcomeStatus,
      outcomeHorizon,
      positionContradictsCouncil,
      alignmentNote,
      personaDisagreement,
    }
  } catch (e) {
    console.warn('[portfolio/check] councilHistory lookup failed:', (e as Error).message?.slice(0, 100))
    return null
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Position-direction inference (for council-history alignment)
// ═════════════════════════════════════════════════════════════════════════════
function inferPositionDirection(args: {
  isOption: boolean
  optionType?: 'call' | 'put'
}): 'long' | 'short' | 'neutral' {
  if (!args.isOption) return 'long'                 // owning shares = long
  if (args.optionType === 'call') return 'long'     // long call = bullish on underlying
  if (args.optionType === 'put') return 'short'     // long put = bearish on underlying
  return 'neutral'
}

// ─────────────────────────────────────────────────────────────────────────────
// Build check for a single position
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildCheck(pos: any, userId: string): Promise<PositionCheck> {
  const isOption = pos.position_type === 'option'
  const underlying = (pos.underlying || pos.ticker).toUpperCase()

  const uData = await fetchUnderlyingData(underlying)
  if (!uData) {
    return buildErrorCheck(pos, 'Could not fetch live data')
  }

  const flags: string[] = []

  // ── STOCK PATH ─────────────────────────────────────────────────────────────
  if (!isOption) {
    const entryPrice = pos.avg_cost || null
    const pnlPct = entryPrice
      ? parseFloat(((uData.price - entryPrice) / entryPrice * 100).toFixed(2))
      : null
    const pnlDollar = entryPrice && pos.shares
      ? parseFloat(((uData.price - entryPrice) * pos.shares).toFixed(2))
      : null

    const pctFromStop = pos.stop_loss
      ? parseFloat(((uData.price - pos.stop_loss) / pos.stop_loss * 100).toFixed(2))
      : null
    const pctFromTarget = pos.take_profit
      ? parseFloat(((pos.take_profit - uData.price) / uData.price * 100).toFixed(2))
      : null

    if (pnlPct !== null && pnlPct <= -8)  flags.push(`down ${Math.abs(pnlPct).toFixed(1)}% from entry`)
    if (pnlPct !== null && pnlPct >= 25)  flags.push(`up ${pnlPct.toFixed(1)}% — consider partial profits`)
    if (pctFromStop !== null && pctFromStop < 0)    flags.push('⚠ STOP LOSS BREACHED')
    if (pctFromStop !== null && pctFromStop >= 0 && pctFromStop <= 3) flags.push(`only ${pctFromStop.toFixed(1)}% above stop`)
    if (pctFromTarget !== null && pctFromTarget <= 2) flags.push(`within ${pctFromTarget.toFixed(1)}% of target`)
    if (uData.rsi !== null && uData.rsi > 75) flags.push(`RSI ${uData.rsi} overbought`)
    if (uData.rsi !== null && uData.rsi < 25) flags.push(`RSI ${uData.rsi} oversold`)
    if (uData.volumeRatio !== null && uData.volumeRatio > 2) flags.push(`${uData.volumeRatio}x volume spike`)

    let verdict: PositionCheck['verdict'] = 'HOLD'
    let conviction: PositionCheck['conviction'] = 'medium'
    if (pctFromStop !== null && pctFromStop < 0) { verdict = 'EXIT'; conviction = 'high' }
    else if (pnlPct !== null && pnlPct <= -15)   { verdict = 'EXIT'; conviction = 'high' }
    else if (pctFromTarget !== null && pctFromTarget <= 1) { verdict = 'EXIT'; conviction = 'high' }
    else if (pctFromStop !== null && pctFromStop <= 3) { verdict = 'WATCH'; conviction = 'high' }
    else if (pnlPct !== null && pnlPct >= 15 && uData.rsi !== null && uData.rsi > 70) { verdict = 'WATCH'; conviction = 'medium' }
    else if (pnlPct !== null && pnlPct > 0 && uData.rsi !== null && uData.rsi < 60 && uData.volumeRatio !== null && uData.volumeRatio > 1.5) { verdict = 'ADD'; conviction = 'low' }

    const exposure = computeExposure({
      isOption: false,
      shares: pos.shares,
      delta: null,
      entryPrice, entryPremium: null,
      underlyingPrice: uData.price,
      contracts: undefined,
    })

    const positionDirection = inferPositionDirection({ isOption: false })
    const [councilHistory, bundleContext] = await Promise.all([
      fetchCouncilHistory(userId, pos.ticker, positionDirection),
      fetchBundleContext(userId, pos.ticker),
    ])

    // Add council-history flag if it contradicts position
    if (councilHistory?.positionContradictsCouncil) {
      flags.push(`Council ${councilHistory.recentSignal} ${councilHistory.daysSinceVerdict}d ago — your position is contrarian`)
    }

    const parts = [
      pnlPct !== null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct}% P&L` : null,
      uData.rsi !== null ? `RSI ${uData.rsi}` : (bundleContext?.rsi !== null && bundleContext?.rsi !== undefined ? `RSI ${bundleContext.rsi}` : null),
      uData.volumeRatio !== null && uData.volumeRatio > 1.2 ? `${uData.volumeRatio}x avg vol` : null,
      pctFromStop !== null ? `${pctFromStop.toFixed(1)}% from stop` : null,
      pctFromTarget !== null ? `${pctFromTarget.toFixed(1)}% from target` : null,
    ].filter(Boolean).join(' · ')

    return {
      ticker: pos.ticker,
      position_type: 'stock',
      underlyingPrice: uData.price,
      underlyingChange1D: uData.change1D,
      // Prefer live Finnhub RSI/volume; fall back to bundle if Finnhub returned null
      underlyingRsi: uData.rsi ?? bundleContext?.rsi ?? null,
      underlyingVolumeRatio: uData.volumeRatio ?? bundleContext?.volumeVs20Day ?? null,
      shares: pos.shares,
      entryPrice, pnlPct, pnlDollar,
      stopLoss: pos.stop_loss || null,
      takeProfit: pos.take_profit || null,
      pctFromStop, pctFromTarget,
      entryPremium: null, currentPremium: null, optionPnlPct: null, optionPnlDollar: null,
      daysToExpiry: null, timeDecayUrgent: false,
      delta: null, theta: null, gamma: null, vega: null,
      impliedVolatility: null, intrinsicValue: null, timeValue: null,
      moneyness: 'atm', breakeven: null,

      // New fields
      directionalExposure: exposure.directionalExposure,
      capitalAtRisk: exposure.capitalAtRisk,
      bid: null, ask: null,
      realisticProceedsLow: null, realisticProceedsHigh: null, realisticProceedsNote: null,
      hoursUntilExpiry: null, deadlineLabel: null,
      savePathSummary: null, savePathProbabilityVerbal: null, savePathProbabilityNumeric: null,
      terminal: false, terminalReason: null,
      councilHistory,
      bundleContext,

      verdict, conviction,
      reason: parts || `$${uData.price} (${uData.change1D >= 0 ? '+' : ''}${uData.change1D}% today)`,
      action: verdict === 'EXIT'
        ? (pctFromTarget !== null && pctFromTarget <= 1 ? 'Take profit — at target' : 'Exit — stop or loss threshold breached')
        : verdict === 'WATCH' ? 'Tighten stop, watch closely'
        : verdict === 'ADD'   ? 'Consider adding on continued momentum'
        : 'Hold — no action needed',
      flags,
    }
  }

  // ── OPTIONS PATH ───────────────────────────────────────────────────────────
  const optionType = (pos.option_type || 'call') as 'call' | 'put'
  const strike = pos.strike || 0
  const expiry = pos.expiry || ''
  const contracts = pos.contracts || 1
  const entryPremium = pos.entry_premium || null

  // ── Days to expiry — calendar-day count from today (midnight ET) to
  //    expiry (midnight ET), NOT 24-hour windows. Traders think in calendar
  //    days remaining ("expires Friday" = 2 days when checked Wednesday
  //    afternoon), not in 24h chunks. The hoursUntilExpiry from
  //    buildDeadlineLabel below is the right field for sub-day urgency.
  //
  //    Old bug: Math.floor((new Date('2026-05-01') - Date.now()) / 86400000)
  //    parses the expiry as midnight UTC and rounds down, so checking
  //    Wednesday afternoon for a Friday expiry returned 1 instead of 2.
  const daysToExpiry = expiry
    ? (() => {
        // Parse expiry as a calendar date in ET (where the option actually
        // expires at 4pm). We compare midnight-ET to midnight-ET so partial
        // hours don't bleed off a day.
        const [y, m, d] = expiry.split('-').map(Number)
        if (!y || !m || !d) return null
        // Build a Date for midnight-ET on expiry (handle as UTC offset; ET
        // is UTC-4 during DST, UTC-5 during standard time. We approximate
        // at UTC-4 — matches what buildDeadlineLabel uses).
        const expiryMidnightET = new Date(Date.UTC(y, m - 1, d, 4, 0, 0))
        // Today's midnight-ET (server time, projected to ET).
        const now = new Date()
        const todayMidnightET = new Date(Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          4, 0, 0,
        ))
        // If we're already past today's "midnight ET" (i.e., past 4 UTC = past
        // midnight ET), step back one day so we count from yesterday's midnight.
        // Otherwise we double-count today.
        const todayAnchor = now.getTime() < todayMidnightET.getTime()
          ? new Date(todayMidnightET.getTime() - 86400000)
          : todayMidnightET
        return Math.round((expiryMidnightET.getTime() - todayAnchor.getTime()) / 86400000)
      })()
    : null
  const timeDecayUrgent = daysToExpiry !== null && daysToExpiry <= 7

  // Wall-clock countdown (improvement #6)
  const { hoursUntilExpiry, label: deadlineLabel } = buildDeadlineLabel(expiry, daysToExpiry)

  // Live option data
  const optData = await fetchOptionData(underlying, optionType, strike, expiry)

  const currentPremium = optData?.currentPremium ?? null
  const optionPnlPct = entryPremium && currentPremium
    ? parseFloat(((currentPremium - entryPremium) / entryPremium * 100).toFixed(2))
    : null
  const optionPnlDollar = entryPremium && currentPremium
    ? parseFloat(((currentPremium - entryPremium) * contracts * 100).toFixed(2))
    : null

  let intrinsicValue: number | null = null
  let timeValue: number | null = null
  if (currentPremium !== null) {
    const itm = optionType === 'call'
      ? Math.max(0, uData.price - strike)
      : Math.max(0, strike - uData.price)
    intrinsicValue = parseFloat(itm.toFixed(2))
    timeValue = parseFloat(Math.max(0, currentPremium - itm).toFixed(2))
  }

  const moneyness = getMoneyness(optionType, strike, uData.price)
  const breakeven = optionType === 'call'
    ? parseFloat((strike + (entryPremium || 0)).toFixed(2))
    : parseFloat((strike - (entryPremium || 0)).toFixed(2))

  const breakevenDist = breakeven
    ? parseFloat(((uData.price - breakeven) / breakeven * 100).toFixed(2))
    : null

  // Honest bid/ask proceeds (improvement #5)
  const proceeds = computeRealisticProceeds({
    bid: optData?.bid ?? 0,
    ask: optData?.ask ?? 0,
    contracts,
    midpoint: currentPremium,
  })

  // Earnings catalyst lookup (used by save-path)
  const earningsContext = await fetchEarningsBeforeExpiry(underlying, expiry)

  // Save-path computation (improvement #4)
  const savePath = computeSavePath({
    isOption: true,
    optionType,
    underlyingPrice: uData.price,
    strike,
    breakeven,
    daysToExpiry,
    hoursUntilExpiry,
    moneyness,
    optionPnlPct,
    earningsContext,
  })

  // Exposure (improvement #1)
  const exposure = computeExposure({
    isOption: true,
    optionType,
    contracts,
    delta: optData?.delta ?? null,
    entryPrice: null,
    entryPremium,
    underlyingPrice: uData.price,
    shares: undefined,
  })

  // TERMINAL check (improvement #8)
  const terminalCheck = checkTerminal({
    daysToExpiry,
    hoursUntilExpiry,
    moneyness,
    optionPnlPct,
    bid: optData?.bid ?? null,
    isOption: true,
  })

  // Flags ────────────────────────────────────────
  if (daysToExpiry !== null && daysToExpiry < 0) flags.push('⚠ OPTION EXPIRED')
  else if (daysToExpiry !== null && daysToExpiry <= 3) flags.push(`⚠ ${deadlineLabel ?? `${daysToExpiry}d to expiry`}`)
  else if (timeDecayUrgent) flags.push(`${daysToExpiry}d to expiry — theta accelerating`)

  if (moneyness === 'deep_otm') flags.push('Deep OTM — high risk of expiring worthless')
  if (moneyness === 'otm' && daysToExpiry !== null && daysToExpiry < 14) flags.push('OTM with <2 weeks — needs move soon')
  if (moneyness === 'deep_itm') flags.push('Deep ITM — consider taking profits or rolling')

  if (optData?.delta !== null && optData?.delta !== undefined) {
    const absDelta = Math.abs(optData.delta)
    if (absDelta < 0.15) flags.push(`Delta ${optData.delta.toFixed(2)} — low probability of profit`)
    if (absDelta > 0.80) flags.push(`Delta ${optData.delta.toFixed(2)} — acts like stock, consider rolling`)
  }

  if (optData?.theta !== null && optData?.theta !== undefined && currentPremium) {
    const dailyDecayPct = Math.abs(optData.theta) / currentPremium * 100
    if (dailyDecayPct > 2) flags.push(`Theta ${optData.theta.toFixed(3)} — losing ${dailyDecayPct.toFixed(1)}%/day to time decay`)
  }

  if (optData?.impliedVolatility) {
    const ivPct = (optData.impliedVolatility * 100).toFixed(0)
    if (optData.impliedVolatility > 0.8) flags.push(`IV ${ivPct}% — very expensive, consider selling`)
    else if (optData.impliedVolatility < 0.2) flags.push(`IV ${ivPct}% — cheap, good time to buy`)
  }

  if (optionPnlPct !== null && optionPnlPct <= -50) flags.push(`Premium down ${Math.abs(optionPnlPct).toFixed(0)}% — significant loss`)
  if (optionPnlPct !== null && optionPnlPct >= 50) flags.push(`Premium up ${optionPnlPct.toFixed(0)}% — consider locking in gains`)

  if (uData.rsi !== null) {
    const rsiWarning = optionType === 'call' && uData.rsi > 75
      ? `Underlying RSI ${uData.rsi} overbought — headwind for calls`
      : optionType === 'put' && uData.rsi < 25
      ? `Underlying RSI ${uData.rsi} oversold — headwind for puts`
      : null
    if (rsiWarning) flags.push(rsiWarning)
  }

  if (breakevenDist !== null) {
    const needsToMove = Math.abs(breakevenDist).toFixed(1)
    if (optionType === 'call' && uData.price < breakeven) flags.push(`Underlying needs +${needsToMove}% to reach breakeven $${breakeven}`)
    if (optionType === 'put' && uData.price > breakeven) flags.push(`Underlying needs -${needsToMove}% to reach breakeven $${breakeven}`)
  }

  // Council history (improvement #9) + bundle context (improvement #10)
  const positionDirection = inferPositionDirection({ isOption: true, optionType })
  const [councilHistory, bundleContext] = await Promise.all([
    fetchCouncilHistory(userId, underlying, positionDirection),
    fetchBundleContext(userId, underlying),
  ])
  if (councilHistory?.positionContradictsCouncil) {
    flags.push(`Council ${councilHistory.recentSignal} ${councilHistory.daysSinceVerdict}d ago — your ${optionType === 'put' ? 'puts' : 'position'} contradict that direction`)
  }

  // Verdict logic — TERMINAL takes precedence
  let verdict: PositionCheck['verdict'] = 'HOLD'
  let conviction: PositionCheck['conviction'] = 'medium'

  if (terminalCheck.terminal) {
    verdict = 'TERMINAL'
    conviction = 'high'
  } else if (daysToExpiry !== null && daysToExpiry < 0) {
    verdict = 'EXIT'; conviction = 'high'
  } else if (daysToExpiry !== null && daysToExpiry <= 2) {
    verdict = 'EXIT'; conviction = 'high'
  } else if (optionPnlPct !== null && optionPnlPct <= -70) {
    verdict = 'EXIT'; conviction = 'high'
  } else if (optionPnlPct !== null && optionPnlPct >= 100) {
    verdict = 'EXIT'; conviction = 'high'
  } else if (moneyness === 'deep_otm' && timeDecayUrgent) {
    verdict = 'EXIT'; conviction = 'high'
  } else if (daysToExpiry !== null && daysToExpiry <= 7) {
    verdict = 'WATCH'; conviction = 'high'
  } else if (optionPnlPct !== null && optionPnlPct <= -40) {
    verdict = 'WATCH'; conviction = 'medium'
  } else if (optionPnlPct !== null && optionPnlPct >= 50) {
    verdict = 'WATCH'; conviction = 'medium'
  }

  const parts = [
    currentPremium !== null ? `Premium $${currentPremium}` : null,
    optionPnlPct !== null ? `${optionPnlPct >= 0 ? '+' : ''}${optionPnlPct}% on premium` : null,
    optData?.delta != null ? `Δ ${optData.delta.toFixed(2)}` : null,
    optData?.theta != null ? `θ ${optData.theta.toFixed(3)}/day` : null,
    optData?.impliedVolatility != null ? `IV ${(optData.impliedVolatility * 100).toFixed(0)}%` : null,
    moneyness.replace('_', ' '),
    deadlineLabel ?? (daysToExpiry !== null ? `${daysToExpiry}d left` : null),
    uData.rsi !== null ? `RSI ${uData.rsi}` : null,
  ].filter(Boolean).join(' · ')

  // Action prose — TERMINAL gets a static template (improvement #8 short-circuit)
  let action: string
  if (verdict === 'TERMINAL') {
    if (proceeds.low !== null && proceeds.high !== null && proceeds.high > 0) {
      action = `TERMINAL — ${terminalCheck.reason} Realistic close proceeds: $${proceeds.low.toFixed(0)}-$${proceeds.high.toFixed(0)}. Sell or let expire.`
    } else {
      action = `TERMINAL — ${terminalCheck.reason} Close for whatever bid exists or let expire.`
    }
  } else if (verdict === 'EXIT') {
    if (daysToExpiry !== null && daysToExpiry <= 2) {
      const proceedsHint = proceeds.low !== null && proceeds.high !== null
        ? ` Realistic proceeds: $${proceeds.low.toFixed(0)}-$${proceeds.high.toFixed(0)}.`
        : ''
      action = `Exit immediately — expiring soon, sell to recover any remaining value.${proceedsHint}`
    } else if (optionPnlPct !== null && optionPnlPct >= 100) {
      action = 'Take profit — premium has doubled. Sell and lock in gains.'
    } else if (optionPnlPct !== null && optionPnlPct <= -70) {
      action = 'Cut loss — premium down 70%+. Exit to preserve remaining capital.'
    } else {
      action = 'Exit position — exit criteria met'
    }
  } else if (verdict === 'WATCH') {
    // Compute daily theta as percent of current premium for EV discipline.
    // If theta exceeds 20%/day on a near-expiry contract, "hold and watch"
    // is mathematically wrong — premium decays faster than the underlying
    // can plausibly recover (absent a known catalyst).
    const dailyDecayPct = optData?.theta && currentPremium && currentPremium > 0
      ? Math.abs(optData.theta) / currentPremium * 100
      : null
    const proceedsHint = proceeds.low !== null && proceeds.high !== null && proceeds.high > 0
      ? ` Realistic proceeds today: $${proceeds.low.toFixed(0)}-$${proceeds.high.toFixed(0)}.`
      : ''

    if (daysToExpiry !== null && daysToExpiry <= 2 && dailyDecayPct !== null && dailyDecayPct > 20) {
      // High-theta near-expiry: today's bid > tomorrow's bid, almost always.
      action = `${daysToExpiry}d left and theta is ${dailyDecayPct.toFixed(0)}%/day — close TODAY, not tomorrow. Tomorrow's premium will be smaller, not larger.${proceedsHint}`
    } else if (daysToExpiry !== null && daysToExpiry <= 2) {
      action = `${daysToExpiry}d left — close today unless a scheduled catalyst before expiry could move the underlying.${proceedsHint}`
    } else if (daysToExpiry !== null && daysToExpiry <= 7) {
      action = `${daysToExpiry}d left — decide now: exit at current proceeds, or roll to a later expiry that matches your thesis horizon. Avoid "hold and see" — theta accelerates from here.${proceedsHint}`
    } else if (optionPnlPct !== null && optionPnlPct >= 50) {
      action = 'Consider selling half to lock in gains, let rest ride'
    } else {
      action = 'Monitor closely — set alert if premium drops another 20%'
    }
  } else {
    action = 'Hold — thesis intact'
  }

  return {
    ticker: pos.ticker,
    position_type: 'option',
    underlyingPrice: uData.price,
    underlyingChange1D: uData.change1D,
    underlyingRsi: uData.rsi,
    underlyingVolumeRatio: uData.volumeRatio,
    entryPrice: entryPremium,
    pnlPct: null,
    pnlDollar: null,
    stopLoss: null,
    takeProfit: null,
    pctFromStop: null,
    pctFromTarget: null,
    optionType, strike, expiry, contracts, entryPremium,
    currentPremium, optionPnlPct, optionPnlDollar,
    daysToExpiry, timeDecayUrgent,
    delta: optData?.delta ?? null,
    theta: optData?.theta ?? null,
    gamma: optData?.gamma ?? null,
    vega: optData?.vega ?? null,
    impliedVolatility: optData?.impliedVolatility ?? null,
    intrinsicValue, timeValue, moneyness, breakeven,

    // New fields
    directionalExposure: exposure.directionalExposure,
    capitalAtRisk: exposure.capitalAtRisk,
    bid: optData?.bid ?? null,
    ask: optData?.ask ?? null,
    realisticProceedsLow: proceeds.low,
    realisticProceedsHigh: proceeds.high,
    realisticProceedsNote: proceeds.note,
    hoursUntilExpiry,
    deadlineLabel,
    savePathSummary: savePath.summary,
    savePathProbabilityVerbal: savePath.probabilityVerbal,
    savePathProbabilityNumeric: savePath.probabilityNumeric,
    terminal: terminalCheck.terminal,
    terminalReason: terminalCheck.reason,
    councilHistory,
    bundleContext,

    verdict, conviction,
    reason: parts || `${optionType.toUpperCase()} $${strike} exp ${expiry}`,
    action,
    flags,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildErrorCheck(pos: any, msg: string): PositionCheck {
  return {
    ticker: pos.ticker, position_type: pos.position_type || 'stock',
    underlyingPrice: 0, underlyingChange1D: 0, underlyingRsi: null, underlyingVolumeRatio: null,
    entryPrice: null, pnlPct: null, pnlDollar: null,
    stopLoss: null, takeProfit: null, pctFromStop: null, pctFromTarget: null,
    entryPremium: null, currentPremium: null, optionPnlPct: null, optionPnlDollar: null,
    daysToExpiry: null, timeDecayUrgent: false,
    delta: null, theta: null, gamma: null, vega: null,
    impliedVolatility: null, intrinsicValue: null, timeValue: null,
    moneyness: 'atm', breakeven: null,
    directionalExposure: null, capitalAtRisk: null,
    bid: null, ask: null,
    realisticProceedsLow: null, realisticProceedsHigh: null, realisticProceedsNote: null,
    hoursUntilExpiry: null, deadlineLabel: null,
    savePathSummary: null, savePathProbabilityVerbal: null, savePathProbabilityNumeric: null,
    terminal: false, terminalReason: null,
    councilHistory: null,
    bundleContext: null,
    verdict: 'HOLD', conviction: 'low', reason: msg, action: 'Retry later', flags: [msg],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI enrichment — skipped entirely for TERMINAL positions (improvement #8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a BundleContext as snapshot lines for the LLM. Each line is conditional —
 * we skip nulls so the LLM doesn't see a wall of "N/A" entries. The freshness
 * header tells the LLM whether the data is recent enough to cite without caveat.
 */
function buildBundleSnapshotLines(bc: BundleContext): string[] {
  const lines: string[] = []

  // Freshness header — tells the LLM whether to caveat the indicators
  let freshnessNote: string
  if (bc.hoursSinceBundle <= 6) {
    freshnessNote = `Council bundle from ${bc.hoursSinceBundle}h ago — fresh, cite freely`
  } else if (bc.hoursSinceBundle <= 24) {
    freshnessNote = `Council bundle from ${bc.hoursSinceBundle}h ago — recent, mostly fresh`
  } else if (bc.hoursSinceBundle <= 72) {
    freshnessNote = `Council bundle from ${Math.round(bc.hoursSinceBundle / 24)}d ago — caveat technicals as "as of last Council run"`
  } else {
    freshnessNote = `Council bundle from ${Math.round(bc.hoursSinceBundle / 24)}d ago — STALE, suggest user run a fresh Council`
  }
  lines.push(`  Council bundle context: ${freshnessNote}`)

  // Technicals
  const techParts: string[] = []
  if (bc.rsi !== null) techParts.push(`RSI ${bc.rsi}`)
  if (bc.macdHistogram !== null) techParts.push(`MACD ${bc.macdHistogram > 0 ? '+' : ''}${bc.macdHistogram.toFixed(2)}`)
  if (bc.atr !== null) techParts.push(`ATR ${bc.atr.toFixed(2)}`)
  if (bc.volumeVs20Day !== null) techParts.push(`vol ${bc.volumeVs20Day.toFixed(1)}x 20d avg`)
  if (techParts.length > 0) {
    lines.push(`    Technicals: ${techParts.join(' | ')}`)
  }

  // Trend / SMA position
  const trendParts: string[] = []
  if (bc.trendLabel) trendParts.push(`trend: ${bc.trendLabel.replace(/_/g, ' ')}`)
  if (bc.sma50Position) trendParts.push(`${bc.sma50Position} SMA50`)
  if (bc.sma200Position && bc.pctFromSma200 !== null) {
    trendParts.push(`${bc.pctFromSma200 >= 0 ? '+' : ''}${bc.pctFromSma200}% vs SMA200`)
  }
  if (trendParts.length > 0) {
    lines.push(`    Trend: ${trendParts.join(' | ')}`)
  }

  // Smart money
  if (bc.insiderSummary) {
    lines.push(`    Insiders: ${bc.insiderSummary}`)
  } else if (bc.insiderSignal && bc.insiderSignal !== 'neutral') {
    const signalLabel = bc.insiderSignal.replace(/_/g, ' ')
    const valueNote = bc.insiderNetValue !== null
      ? ` (net $${(bc.insiderNetValue / 1_000_000).toFixed(1)}M)`
      : ''
    lines.push(`    Insiders: ${signalLabel}${valueNote}`)
  }

  // Fundamentals
  const fundParts: string[] = []
  if (bc.forwardPE !== null) fundParts.push(`Fwd P/E ${bc.forwardPE.toFixed(1)}`)
  if (bc.trailingPE !== null && bc.forwardPE === null) fundParts.push(`P/E ${bc.trailingPE.toFixed(1)}`)
  if (bc.daysToEarnings !== null) {
    if (bc.daysToEarnings > 0) {
      fundParts.push(`earnings in ${bc.daysToEarnings}d`)
    } else if (bc.daysToEarnings === 0) {
      fundParts.push('earnings today')
    } else {
      fundParts.push(`earnings ${Math.abs(bc.daysToEarnings)}d ago`)
    }
  }
  if (fundParts.length > 0) {
    lines.push(`    Fundamentals: ${fundParts.join(' | ')}`)
  }
  if (bc.cashAndRunway) {
    lines.push(`    Cash & runway: ${bc.cashAndRunway}`)
  }

  // Conviction (the quantitative engine's standalone signal)
  if (bc.convictionDirection && bc.convergenceScore !== null) {
    lines.push(`    Conviction engine: ${bc.convictionDirection} (qual+quant convergence ${(bc.convergenceScore * 100).toFixed(0)}%)`)
  }

  // Options flow — surface the highest-signal aggregated data points.
  // Only render lines when there's actually a non-neutral signal or notable
  // activity, otherwise it's just noise ("P/C neutral, IV neutral, GEX neutral").
  const optionsParts: string[] = []
  if (bc.putCallRatio !== null && bc.putCallSignal && bc.putCallSignal !== 'neutral') {
    optionsParts.push(`P/C ${bc.putCallRatio.toFixed(2)} (${bc.putCallSignal})`)
  } else if (bc.putCallRatio !== null && bc.putCallRatio > 1.5) {
    // Even neutral-labeled but elevated P/C is worth noting (squeeze potential)
    optionsParts.push(`P/C ${bc.putCallRatio.toFixed(2)} (elevated)`)
  }
  if (bc.ivSignal && bc.ivSignal !== 'neutral' && bc.ivSignal !== 'normal') {
    optionsParts.push(`IV ${bc.ivSignal}`)
  }
  if (bc.gexSignal && bc.gexSignal !== 'neutral') {
    optionsParts.push(`GEX ${bc.gexSignal}`)
  }
  if (bc.maxPainStrike !== null) {
    optionsParts.push(`max pain $${bc.maxPainStrike.toFixed(2)}`)
  }
  if (optionsParts.length > 0) {
    lines.push(`    Options flow: ${optionsParts.join(' | ')}`)
  }
  // Unusual sweep gets its own line because it's narrative-rich
  if (bc.unusualSweepCount !== null && bc.unusualSweepCount > 0 && bc.topUnusualSweep) {
    lines.push(`    Unusual sweeps (${bc.unusualSweepCount}): ${bc.topUnusualSweep}`)
  }

  return lines
}

async function enrichWithAI(checks: PositionCheck[]): Promise<PositionCheck[]> {
  if (!checks.length) return checks

  // Skip TERMINAL positions — their action prose is already correct from the static template
  const enrichable = checks.filter(c => !c.terminal)
  if (!enrichable.length) return checks

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const snapshot = enrichable.map(c => {
      // Build a "Council bundle indicators" line. Sourced from the most recent
      // analyses.signal_bundle for this user/ticker. When present, this gives
      // the LLM real RSI/MACD/SMA/ATR/volume/insider/PE/runway/conviction data
      // instead of "N/A" values from a Finnhub-only fetch.
      const bc = c.bundleContext
      const bundleLines = bc
        ? buildBundleSnapshotLines(bc)
        : []

      if (c.position_type === 'option') {
        const lines = [
          `${c.ticker} ${c.optionType?.toUpperCase()} $${c.strike} exp ${c.expiry} (${c.contracts}x contracts)`,
          `  Underlying: $${c.underlyingPrice} (${c.underlyingChange1D >= 0 ? '+' : ''}${c.underlyingChange1D}% today) | RSI ${c.underlyingRsi ?? bc?.rsi ?? 'N/A'}`,
          `  Entry premium: ${c.entryPremium ? `$${c.entryPremium}` : 'N/A'} | Current mid: ${c.currentPremium ? `$${c.currentPremium}` : 'N/A'} | P&L on premium: ${c.optionPnlPct !== null ? `${c.optionPnlPct >= 0 ? '+' : ''}${c.optionPnlPct}% ($${c.optionPnlDollar})` : 'N/A'}`,
          `  Bid/Ask: ${c.bid !== null ? `$${c.bid.toFixed(2)}/$${c.ask?.toFixed(2)}` : 'N/A'}${c.realisticProceedsNote ? ` | Realistic proceeds: $${c.realisticProceedsLow?.toFixed(0)}-$${c.realisticProceedsHigh?.toFixed(0)}` : ''}`,
          `  Greeks: Delta ${c.delta ?? 'N/A'} | Theta ${c.theta ?? 'N/A'}/day | IV ${c.impliedVolatility ? `${(c.impliedVolatility*100).toFixed(0)}%` : 'N/A'}`,
          `  ${c.deadlineLabel ?? `${c.daysToExpiry}d to expiry`} | ${c.moneyness.replace('_',' ')} | Intrinsic $${c.intrinsicValue ?? 0} | Time value $${c.timeValue ?? 0}`,
          `  Breakeven: $${c.breakeven ?? 'N/A'}`,
          `  Directional exposure: ${c.directionalExposure !== null ? '$' + c.directionalExposure.toFixed(0) : 'N/A'} (${c.directionalExposure !== null && c.directionalExposure < 0 ? 'bearish' : c.directionalExposure !== null && c.directionalExposure > 0 ? 'bullish' : 'flat'} on underlying via ${c.optionType})`,
          c.savePathSummary ? `  Save path: ${c.savePathSummary}` : '',
          c.councilHistory ? `  Council history: ${c.councilHistory.alignmentNote}${c.councilHistory.personaDisagreement ? ' ' + c.councilHistory.personaDisagreement : ''}` : '',
          ...bundleLines,
          c.flags.length ? `  Flags: ${c.flags.join(', ')}` : '',
        ]
        return lines.filter(Boolean).join('\n')
      } else {
        const lines = [
          `${c.ticker} stock (${c.shares} shares @ $${c.entryPrice ?? '?'})`,
          `  Price: $${c.underlyingPrice} (${c.underlyingChange1D >= 0 ? '+' : ''}${c.underlyingChange1D}% today) | P&L: ${c.pnlPct !== null ? `${c.pnlPct >= 0 ? '+' : ''}${c.pnlPct}%` : 'N/A'} ($${c.pnlDollar ?? 0})`,
          `  RSI ${c.underlyingRsi ?? bc?.rsi ?? 'N/A'} | Volume ${c.underlyingVolumeRatio ?? bc?.volumeVs20Day ?? 'N/A'}x avg`,
          `  Directional exposure: ${c.directionalExposure !== null ? '$' + c.directionalExposure.toFixed(0) : 'N/A'} (long stock)`,
          c.stopLoss ? `  Stop: $${c.stopLoss} (${c.pctFromStop?.toFixed(1)}% away)` : '  No stop set',
          c.takeProfit ? `  Target: $${c.takeProfit} (${c.pctFromTarget?.toFixed(1)}% away)` : '  No target set',
          c.councilHistory ? `  Council history: ${c.councilHistory.alignmentNote}${c.councilHistory.personaDisagreement ? ' ' + c.councilHistory.personaDisagreement : ''}` : '',
          ...bundleLines,
          c.flags.length ? `  Flags: ${c.flags.join(', ')}` : '',
        ]
        return lines.filter(Boolean).join('\n')
      }
    }).join('\n\n')

    // System prompt — date grounding inlined (same pattern as the QA fix)
    const today = new Date().toUTCString().split(' ').slice(0, 4).join(' ')
    const todayISO = new Date().toISOString().split('T')[0]
    const systemPrompt = `Today is ${today} (ISO: ${todayISO}). This is the actual current date from server time. Trust user-supplied dates (option expirations, transaction dates) without arguing — they have a calendar, you don't.

You are a trading coach reviewing live positions. Be direct and specific — cite the actual numbers from the snapshot. No fluff. For options, consider delta (directional exposure), theta (daily decay cost), IV level, moneyness, and days to expiry together. A 0.25 delta OTM call with 5 days left and 60% IV is a very different situation than a 0.55 delta ITM call with 30 days.

When the snapshot includes "Council bundle context," cite the SPECIFIC indicators provided — RSI value, MACD direction, SMA position, volume ratio, insider signal, P/E, conviction score. Do NOT say "no momentum data available" if the bundle has values for these — that's wrong. The bundle context comes from the most recent full Council analysis and contains real indicator data. The freshness note tells you whether to cite freely (recent), caveat as "as of last Council run" (24-72h old), or recommend a fresh Council run (>72h old).

Specifically, for stock positions:
  - Cite RSI level by number ("RSI 65 — momentum strong but approaching overbought territory")
  - Cite SMA200 position ("trading 12% above the 200-day average — extended but in clear uptrend")
  - Cite volume context if present ("today's volume is 2.3x the 20-day average — institutional participation confirmed")
  - Cite insider signal if non-neutral ("insiders selling $4.2M concentrated in CFO — minor concern but not thesis-breaking")
  - Use forward P/E to ground valuation comments ("Fwd P/E 19.6 reflects priced-in growth")
  - Cite options flow context if present — high P/C ratio = squeeze potential, max pain strike = pinning risk into expiry, unusual sweeps = follow-the-flow alignment or warning. Examples:
    - "P/C 1.71 (elevated) — heavy put buying creates squeeze potential when fundamentals are improving, supportive of the long position"
    - "Max pain at $48 below your entry $49.27 suggests pinning pressure at expiry; consider taking profits before monthly OPEX if held into that window"
    - "Unusual sweep on $55 calls expiring next month aligns with your long position — flow is supportive"

Generic momentum language without citing the actual indicators is a failure. If the bundle has the data, USE it.

When the snapshot includes "Council history," weave it into your reasoning. If the user's position contradicts the most recent Council direction, name the contradiction and explain what it means for the exit decision. If the Council outcome is confirmed (correct/incorrect), use that to weight the alignment note.

When the snapshot includes "Save path," reference the probability band and any catalyst note in your reason. Do not invent probability numbers; use the verbal band given.

When the snapshot includes "Realistic proceeds," cite the bid-ask range in your action — never quote mid-price as if it's transactable.

═════════════════════════════════════════════════════════════
EXPECTED-VALUE DISCIPLINE — apply rigorously to near-expiry options
═════════════════════════════════════════════════════════════

Before writing the "action" field for any option position, ask: does waiting have positive expected value? For most near-expiry options, the answer is no, and the action must reflect that. The following rules are not suggestions — they are constraints on what you may write.

RULE 1 — Theta is not "time value to salvage by waiting"
  Theta is the rate at which premium DISAPPEARS. A position with theta of -$0.05/day on a $0.10 premium loses 50% of its value per day. Suggesting the user "wait until tomorrow to salvage time value" is mathematically backwards: tomorrow's premium will be SMALLER than today's, not larger, absent a directional move. Do not use language like "salvage remaining time value by waiting" — that's the opposite of what waiting does.

RULE 2 — Don't recommend hope-trades
  When the save-path probability is "very unlikely" or "unlikely" AND there is no scheduled catalyst before expiry, you must NOT recommend the user "wait to see if the move happens." A 2-5% probability event is, by definition, the move you should not bet on. For these positions, the action is exit-now, not wait-and-see. If you find yourself writing "wait for a gap on overnight news" or similar, stop — you are recommending a hope-trade.

RULE 3 — For high-theta near-expiry options, exit timing optimizes for CURRENT bid, not future bid
  When daysToExpiry ≤ 2 and the daily theta exceeds 20% of current premium, recommend closing today, not tomorrow. The premium will decay overnight and again into expiry; current proceeds will almost always exceed future proceeds. The only exceptions are (a) a scheduled catalyst before expiry that could move the underlying, or (b) the position is already deep ITM and intrinsic value protects it.

RULE 4 — When the bid is non-zero and daysToExpiry ≤ 2, the action template is:
  "Place a limit sell at $X-$Y today. If unfilled by close, drop to bid. Do not carry into [next trading day]." — where X and Y come from the realistic-proceeds range. Do not add "wait for overnight news" or "see if a gap forms" — those are hope-trades that violate Rule 2.

RULE 5 — Council alignment does not save a structurally broken contract
  If the Council called bearish and the user holds bearish puts, the alignment is good — but if those puts expire before the Council's predicted move has time to play out, the contract is still structurally wrong for the thesis. The action should acknowledge the alignment AND note the timing mismatch: "Council was right directionally, but this contract expires before the move has time to develop. Close and consider re-entering with longer expiry if the bearish thesis still holds."

These rules apply to the "action" field. The "reason" field can include nuance and explain the alignment with Council, the save-path probability, and the structural timing problem. But the action must be a clear, EV-positive instruction.`

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `${snapshot}\n\nReturn JSON array, same order as snapshot:\n[\n  {\n    "ticker": "NVDA",\n    "verdict": "HOLD",\n    "conviction": "high",\n    "reason": "specific reason with actual numbers, including council-history alignment if present and save-path probability if relevant",\n    "action": "specific action step. For options near expiry (≤2d) with high theta (>20%/day), the action should be a limit-sell-today instruction citing the realistic-proceeds range, NOT a wait-for-overnight-move suggestion. See EV-discipline rules in the system prompt.",\n    "flags": ["any additional flags"]\n  }\n]\n\nBefore returning, audit each \\"action\\" field: does it contain phrases like \\"wait until tomorrow,\\" \\"hold for overnight news,\\" \\"see if a gap forms,\\" or \\"salvage remaining time value\\"? If yes AND the position has daysToExpiry ≤ 2 AND theta > 20% of premium AND the save-path probability is unlikely/very unlikely, rewrite the action to be a today-exit instruction. Hope-trades are banned for these positions.\n\nJSON only, no markdown.`,
      }],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (msg.content.find((b: any) => b.type === 'text') as any)?.text || ''
    const clean = text.replace(/```json|```/g, '').trim()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ai: any[] = JSON.parse(clean.slice(clean.indexOf('['), clean.lastIndexOf(']') + 1))

    // Map AI results back to enrichable checks by ticker (TERMINAL passes through unchanged)
    const aiByTicker = new Map<string, typeof ai[number]>()
    enrichable.forEach((c, i) => {
      const a = ai[i]
      if (a && a.ticker === c.ticker) aiByTicker.set(c.ticker, a)
    })

    return checks.map(c => {
      if (c.terminal) return c  // Static template wins — improvement #8
      const a = aiByTicker.get(c.ticker)
      if (!a) return c
      return {
        ...c,
        verdict: (a.verdict as PositionCheck['verdict']) || c.verdict,
        conviction: (a.conviction as PositionCheck['conviction']) || c.conviction,
        reason: a.reason || c.reason,
        action: a.action || c.action,
        flags: [...new Set([...c.flags, ...(a.flags || [])])],
      }
    })
  } catch {
    return checks
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getPositionsAndJournal(userId: string) {
  const admin = getAdmin()
  const { data: portfolio } = await admin.from('portfolios').select('id').eq('user_id', userId).maybeSingle()
  const positions = portfolio
    ? (await admin.from('portfolio_positions').select('*').eq('portfolio_id', portfolio.id)).data || []
    : []
  const { data: journal } = await admin
    .from('trade_journal')
    .select('ticker,stop_loss,take_profit,entry_price,entry_premium,position_type,option_type,strike,expiry,contracts')
    .eq('user_id', userId)
    .eq('outcome', 'pending')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jMap = new Map<string, any>()
  for (const j of (journal || [])) jMap.set(j.ticker, j)
  return { positions, jMap }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mergeWithJournal(pos: any, j: any) {
  return {
    ...pos,
    stop_loss: j?.stop_loss || pos.stop_loss || null,
    take_profit: j?.take_profit || pos.take_profit || null,
    ...(j?.entry_price ? { avg_cost: j.entry_price } : {}),
    ...(j?.entry_premium ? { entry_premium: j.entry_premium } : {}),
    ...(j?.option_type ? { option_type: j.option_type } : {}),
    ...(j?.strike ? { strike: j.strike } : {}),
    ...(j?.expiry ? { expiry: j.expiry } : {}),
    ...(j?.contracts ? { contracts: j.contracts } : {}),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — single ticker
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ticker = new URL(req.url).searchParams.get('ticker')?.toUpperCase()
  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })

  const { positions, jMap } = await getPositionsAndJournal(user.id)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pos = positions.find((p: any) => p.ticker === ticker) || { ticker, shares: 1, position_type: 'stock' }
  const merged = mergeWithJournal(pos, jMap.get(ticker))

  const check = await buildCheck(merged, user.id)
  const [enriched] = await enrichWithAI([check])
  return NextResponse.json({ check: enriched })
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — all positions
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(_req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { positions: jPositions, jMap } = await getPositionsAndJournal(user.id)
  if (!jPositions.length) return NextResponse.json({ checks: [] })

  // Sequential with rate-limit delay (3 Finnhub calls + verdict_log lookup per position)
  const checks: PositionCheck[] = []
  for (const pos of jPositions) {
    const merged = mergeWithJournal(pos, jMap.get(pos.ticker))
    checks.push(await buildCheck(merged, user.id))
    await new Promise(r => setTimeout(r, 400))
  }

  const enriched = await enrichWithAI(checks)
  // Sort: TERMINAL first (most urgent), then EXIT, WATCH, HOLD, ADD
  const order = { TERMINAL: 0, EXIT: 1, WATCH: 2, HOLD: 3, ADD: 4 }
  enriched.sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9))
  return NextResponse.json({ checks: enriched, checkedAt: new Date().toISOString() })
}
