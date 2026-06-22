/**
 * Wali-OS — Portfolio Summary
 * POST /api/portfolio  — holistic analysis of all positions
 *
 * ─────────────────────────────────────────────────────────────
 * 2026-04-29 — Rewrite incorporating improvements 2 + 7 + supporting fixes:
 *
 *   2. Skip portfolio summary on 1-position accounts
 *      (Returns a stub instead of an LLM call. With one holding there's
 *      nothing to correlate or rebalance — the per-position card is the
 *      whole story.)
 *
 *   7. Don't conflate position-level vs underlying-level
 *      (The OLD prompt treated every position as if it were a long stock
 *      position. A long put on AI was getting analyzed as if the user
 *      was long AI. Now the prompt receives directional exposure per
 *      underlying, distinguishes "owns X" from "has bearish exposure to
 *      X", and the prompt is rewritten to reason about exposure rather
 *      than position count.)
 *
 *   1. (supporting) Compute directional exposure here too
 *      (computeExposure logic mirrored from portfolio/check; we don't
 *      have live option deltas in this codepath, so we use a delta
 *      heuristic from moneyness for the exposure computation. The
 *      heuristic is documented inline.)
 *
 * Date grounding inlined into the system prompt (same pattern as the
 * QA route fix and portfolio/check), so the model has "today is" context.
 * ─────────────────────────────────────────────────────────────
 */

import { NextRequest } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const FINNHUB_KEY = () => process.env.FINNHUB_API_KEY || ''
const ALPACA_HEADERS = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Position {
  ticker: string
  shares: number
  avg_cost: number | null
  position_type?: 'stock' | 'option'
  option_type?: 'call' | 'put' | null
  strike?: number | null
  expiry?: string | null
  contracts?: number | null
  entry_premium?: number | null
  underlying?: string | null
}

interface PositionData {
  ticker: string
  shares: number
  avg_cost: number | null
  currentPrice: number
  marketValue: number
  gainLoss: number | null
  gainLossPct: number | null
  priceChange1D: number
  rsi: number | null
  signal: string
  sma50: number | null
  sma200: number | null
  goldenCross: boolean | null
  earningsDate: string | null
  daysToEarnings: number | null
  sector: string
  analystConsensus: string
  analystTarget: number | null

  // ── NEW (2026-04-29) ────────────────────────────────────────
  /** 'stock' | 'option' — surfaced so UI and prompt distinguish them */
  positionType: 'stock' | 'option'
  /** For options: 'call' | 'put' */
  optionType: 'call' | 'put' | null
  /** For options: strike, expiry, contracts, days to expiry */
  strike: number | null
  expiry: string | null
  contracts: number | null
  daysToExpiry: number | null
  /** Net dollar directional exposure to the *underlying*. Positive = long.
   *  See computeExposure() for the formula. */
  directionalExposure: number
  /** Total capital tied up in this position. Used for risk sizing. */
  capitalAtRisk: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Quote, bars, fundamentals (existing helpers — unchanged)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchQuote(ticker: string): Promise<{ price: number; change1D: number }> {
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY()}`
    )
    if (!res.ok) return { price: 0, change1D: 0 }
    const d = await res.json()
    const change1D = d.pc > 0 ? ((d.c - d.pc) / d.pc) * 100 : 0
    return { price: d.c ?? 0, change1D }
  } catch { return { price: 0, change1D: 0 } }
}

async function fetchBarsForPosition(ticker: string): Promise<{
  rsi: number | null
  sma50: number | null
  sma200: number | null
  goldenCross: boolean | null
}> {
  try {
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - 420)
    const startStr = start.toISOString().split('T')[0]
    const endStr = end.toISOString().split('T')[0]

    for (const feed of ['sip', 'iex']) {
      const res = await fetch(
        `https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Day&start=${startStr}&end=${endStr}&limit=300&adjustment=all&feed=${feed}`,
        { headers: ALPACA_HEADERS }
      )
      if (!res.ok) continue
      const data = await res.json()
      const bars = data.bars ?? []
      if (bars.length < 20) continue

      const closes = bars.map((b: { c: number }) => b.c)

      // RSI
      let rsi = null
      if (closes.length >= 15) {
        let gains = 0, losses = 0
        for (let i = 1; i <= 14; i++) {
          const diff = closes[i] - closes[i - 1]
          if (diff > 0) gains += diff; else losses -= diff
        }
        let avgGain = gains / 14, avgLoss = losses / 14
        for (let i = 15; i < closes.length; i++) {
          const diff = closes[i] - closes[i - 1]
          avgGain = (avgGain * 13 + Math.max(diff, 0)) / 14
          avgLoss = (avgLoss * 13 + Math.max(-diff, 0)) / 14
        }
        rsi = avgLoss === 0 ? 100 : Math.round(100 - 100 / (1 + avgGain / avgLoss))
      }

      const sma = (n: number) => closes.length >= n
        ? closes.slice(-n).reduce((a: number, b: number) => a + b, 0) / n
        : null
      const sma50 = sma(50)
      const sma200 = sma(200)

      return { rsi, sma50, sma200, goldenCross: sma50 && sma200 ? sma50 > sma200 : null }
    }
    return { rsi: null, sma50: null, sma200: null, goldenCross: null }
  } catch { return { rsi: null, sma50: null, sma200: null, goldenCross: null } }
}

async function fetchFundamentalsForPosition(ticker: string, _price: number): Promise<{
  earningsDate: string | null
  daysToEarnings: number | null
  sector: string
  analystConsensus: string
  analystTarget: number | null
}> {
  try {
    const [profileRes, calRes, recRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${FINNHUB_KEY()}`),
      fetch(`https://finnhub.io/api/v1/calendar/earnings?symbol=${ticker}&token=${FINNHUB_KEY()}`),
      fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${ticker}&token=${FINNHUB_KEY()}`),
    ])

    const profile = profileRes.ok ? await profileRes.json() : {}
    const cal = calRes.ok ? await calRes.json() : {}
    const rec = recRes.ok ? await recRes.json() : []

    const sector = profile.finnhubIndustry ?? 'Unknown'
    const upcoming = (cal.earningsCalendar ?? []).find((e: { date: string }) => new Date(e.date) >= new Date())
    const earningsDate = upcoming?.date ?? null
    const daysToEarnings = earningsDate
      ? Math.ceil((new Date(earningsDate).getTime() - Date.now()) / 86400000)
      : null

    const latest = Array.isArray(rec) ? rec[0] : null
    const totalRecs = latest ? (latest.buy + latest.strongBuy + latest.hold + latest.sell + latest.strongSell) : 0
    const bullish = latest && totalRecs > 0 ? (latest.buy + latest.strongBuy) / totalRecs : 0
    const consensus = bullish > 0.6 ? 'buy' : bullish > 0.4 ? 'hold' : 'sell'

    const priceTargetRes = await fetch(
      `https://finnhub.io/api/v1/stock/price-target?symbol=${ticker}&token=${FINNHUB_KEY()}`
    )
    const pt = priceTargetRes.ok ? await priceTargetRes.json() : {}
    const analystTarget = pt.targetMean ?? null

    return { earningsDate, daysToEarnings, sector, analystConsensus: consensus, analystTarget }
  } catch {
    return { earningsDate: null, daysToEarnings: null, sector: 'Unknown', analystConsensus: 'hold', analystTarget: null }
  }
}

function deriveTechSignal(rsi: number | null, goldenCross: boolean | null, priceChange1D: number): string {
  let score = 0
  if (rsi !== null) {
    if (rsi > 70) score -= 1
    else if (rsi < 30) score += 2
    else if (rsi > 50) score += 1
  }
  if (goldenCross === true) score += 2
  else if (goldenCross === false) score -= 2
  if (priceChange1D > 2) score += 1
  else if (priceChange1D < -2) score -= 1
  return score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL'
}

// ═════════════════════════════════════════════════════════════════════════════
// (1) Directional exposure — without live deltas
// ═════════════════════════════════════════════════════════════════════════════
//
// portfolio/check has Tradier in scope and pulls real deltas. This codepath
// doesn't — we only have strike, current price, and option type. So we derive
// a delta heuristic from moneyness:
//
//   Deep ITM:     |delta| ≈ 0.85
//   ITM:          |delta| ≈ 0.65
//   ATM:          |delta| ≈ 0.50
//   OTM:          |delta| ≈ 0.30
//   Deep OTM:     |delta| ≈ 0.10
//
// This is rough but correct in direction and correct in magnitude order. The
// numbers only need to be good enough for the prompt to reason about
// "you have $X bullish/bearish exposure to this underlying" — they're not
// used for any precise calculation.

interface ExposureResult {
  directionalExposure: number
  capitalAtRisk: number
}

function getMoneyness(
  optionType: 'call' | 'put',
  strike: number,
  underlyingPrice: number,
): 'deep_itm' | 'itm' | 'atm' | 'otm' | 'deep_otm' {
  const diff = optionType === 'call'
    ? (underlyingPrice - strike) / strike
    : (strike - underlyingPrice) / strike
  if (diff > 0.10)  return 'deep_itm'
  if (diff > 0.01)  return 'itm'
  if (diff > -0.01) return 'atm'
  if (diff > -0.10) return 'otm'
  return 'deep_otm'
}

function approximateDelta(moneyness: string): number {
  switch (moneyness) {
    case 'deep_itm': return 0.85
    case 'itm':      return 0.65
    case 'atm':      return 0.50
    case 'otm':      return 0.30
    case 'deep_otm': return 0.10
    default:         return 0.50
  }
}

function computePositionExposure(args: {
  pos: Position
  currentPrice: number
}): ExposureResult {
  const { pos, currentPrice } = args
  const isOption = pos.position_type === 'option'

  if (!isOption) {
    const exposure = pos.shares * currentPrice
    const capital = pos.avg_cost ? pos.shares * pos.avg_cost : exposure
    return {
      directionalExposure: parseFloat(exposure.toFixed(2)),
      capitalAtRisk: parseFloat(capital.toFixed(2)),
    }
  }

  // Option path
  const contracts = pos.contracts ?? 1
  const optionType = (pos.option_type ?? 'call') as 'call' | 'put'
  const strike = pos.strike ?? currentPrice

  const moneyness = getMoneyness(optionType, strike, currentPrice)
  const absDelta = approximateDelta(moneyness)
  const sign = optionType === 'put' ? -1 : 1
  const exposure = sign * absDelta * contracts * 100 * currentPrice
  const capital = pos.entry_premium ? pos.entry_premium * contracts * 100 : Math.abs(exposure) * 0.3

  return {
    directionalExposure: parseFloat(exposure.toFixed(2)),
    capitalAtRisk: parseFloat(capital.toFixed(2)),
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Per-underlying exposure aggregation
// ═════════════════════════════════════════════════════════════════════════════
//
// Multiple positions on the same underlying (e.g., long stock + protective put)
// should be netted. This produces a clean view: "$2,500 net long AAPL across
// 1 stock position and 1 put position" which is more useful than "2 positions
// on AAPL totaling $2,500 + $300."

interface UnderlyingExposure {
  underlying: string
  netExposure: number             // positive = net long, negative = net short
  totalCapitalAtRisk: number      // sum of capital regardless of direction
  positionCount: number
  hasStock: boolean
  hasOptions: boolean
  description: string             // human-readable: "long 10 shares + bearish via 10 puts"
}

function aggregateExposureByUnderlying(positions: PositionData[]): UnderlyingExposure[] {
  const groups = new Map<string, PositionData[]>()

  for (const p of positions) {
    // For options, group by underlying ticker (the company), not the option-position ticker
    const key = p.positionType === 'option' && p.ticker.includes(' ')
      ? p.ticker.split(' ')[0]
      : p.ticker
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(p)
  }

  const results: UnderlyingExposure[] = []
  for (const [underlying, group] of groups.entries()) {
    const netExposure = group.reduce((s, p) => s + p.directionalExposure, 0)
    const totalCapital = group.reduce((s, p) => s + p.capitalAtRisk, 0)
    const hasStock = group.some(p => p.positionType === 'stock')
    const hasOptions = group.some(p => p.positionType === 'option')

    // Build description
    const parts: string[] = []
    const stockPos = group.find(p => p.positionType === 'stock')
    if (stockPos) parts.push(`${stockPos.shares} shares (${stockPos.gainLossPct !== null ? (stockPos.gainLossPct >= 0 ? '+' : '') + stockPos.gainLossPct.toFixed(1) + '% P&L' : 'no entry'})`)
    const calls = group.filter(p => p.optionType === 'call')
    const puts = group.filter(p => p.optionType === 'put')
    if (calls.length > 0) {
      const totalContracts = calls.reduce((s, p) => s + (p.contracts ?? 0), 0)
      parts.push(`bullish via ${totalContracts} call${totalContracts === 1 ? '' : 's'}`)
    }
    if (puts.length > 0) {
      const totalContracts = puts.reduce((s, p) => s + (p.contracts ?? 0), 0)
      parts.push(`bearish via ${totalContracts} put${totalContracts === 1 ? '' : 's'}`)
    }

    results.push({
      underlying,
      netExposure: parseFloat(netExposure.toFixed(2)),
      totalCapitalAtRisk: parseFloat(totalCapital.toFixed(2)),
      positionCount: group.length,
      hasStock,
      hasOptions,
      description: parts.join(' + '),
    })
  }

  // Sort by absolute exposure descending (most exposed first)
  return results.sort((a, b) => Math.abs(b.netExposure) - Math.abs(a.netExposure))
}

// ═════════════════════════════════════════════════════════════════════════════
// (2) Single-position stub — returned without an LLM call
// ═════════════════════════════════════════════════════════════════════════════

interface StubAnalysis {
  overallSignal: string
  overallConviction: string
  headline: string
  summary: string
  topRisks: Array<{ risk: string; tickers: string[]; severity: string }>
  opportunities: Array<{ opportunity: string; tickers: string[] }>
  sectorAnalysis: string
  earningsWatch: string
  rebalancingSuggestions: string
  actionPlan: string
  portfolioScore: number
}

function buildSinglePositionStub(positionData: PositionData[]): StubAnalysis {
  const p = positionData[0]
  const tickerLabel = p.ticker
  const isOption = p.positionType === 'option'

  const positionDesc = isOption
    ? `${p.optionType?.toUpperCase()} option on ${p.ticker.split(' ')[0]}`
    : `stock position in ${p.ticker}`

  return {
    overallSignal: 'NEUTRAL',
    overallConviction: 'low',
    headline: `Single ${isOption ? 'option' : 'stock'} position — see per-position card for the actionable view.`,
    summary: `Your portfolio holds one ${positionDesc}. Holistic portfolio analysis (sector concentration, correlation, rebalancing) needs at least 2 positions to produce useful output. The Position Health Check above shows the verdict for this specific position — that's the relevant signal right now. Add more holdings to enable portfolio-level analysis.`,
    topRisks: [{
      risk: `Single-position concentration. With only one holding, your portfolio's outcome is fully determined by ${tickerLabel}. No diversification benefit available until you add 2+ uncorrelated positions.`,
      tickers: [tickerLabel],
      severity: 'high',
    }],
    opportunities: [{
      opportunity: 'Add 2-4 positions in different sectors to enable real portfolio analysis (correlation, sector rotation, rebalancing). Run /analyze on candidate tickers first to find ones with BULLISH verdicts.',
      tickers: [],
    }],
    sectorAnalysis: 'Sector analysis requires multiple positions to be meaningful.',
    earningsWatch: p.daysToEarnings !== null && p.daysToEarnings <= 30
      ? `Earnings in ${p.daysToEarnings} days for ${p.ticker} — see the position card for catalyst timing.`
      : 'No upcoming earnings in next 30 days.',
    rebalancingSuggestions: 'Rebalancing requires 2+ positions. Once you have multiple holdings, this will surface specific rotation suggestions.',
    actionPlan: `1. Use the Position Health Check verdict to decide on ${tickerLabel}. 2. After resolving (or while holding), add 2-3 more positions in different sectors. 3. Re-run portfolio analysis once you have 3+ holdings.`,
    portfolioScore: 50,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main route handler
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))

      try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) { send('error', { message: 'Not authenticated' }); return }

        const body = await req.json()
        const { positions, forceRefresh }: { positions: Position[]; forceRefresh?: boolean } = body
        if (!positions?.length) { send('error', { message: 'No positions provided' }); return }

        const admin = createAdmin(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        )

        // ── Cache check — serve saved analysis if < 24 hours old ──
        if (!forceRefresh) {
          const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
          const { data: cached } = await admin
            .from('portfolio_analyses')
            .select('analysis, created_at')
            .eq('user_id', user.id)
            .gte('created_at', cutoff)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (cached?.analysis) {
            const ageMinutes = Math.round((Date.now() - new Date(cached.created_at).getTime()) / 60000)
            send('status', { message: `Loaded cached analysis from ${ageMinutes} minute${ageMinutes === 1 ? '' : 's'} ago` })
            send('position_data', cached.analysis.positionData ?? [])
            send('complete', { ...cached.analysis, cached: true, ageMinutes })
            return
          }
        }

        send('status', { message: `Analyzing ${positions.length} position${positions.length === 1 ? '' : 's'}...` })

        // ── Fetch live data per position ─────────────────────────
        const positionData: PositionData[] = await Promise.all(
          positions.map(async (pos) => {
            const isOption = pos.position_type === 'option'
            const analysisTicker = isOption ? (pos.underlying ?? pos.ticker) : pos.ticker

            const [quote, bars, fundamentals] = await Promise.all([
              fetchQuote(analysisTicker),
              fetchBarsForPosition(analysisTicker),
              fetchFundamentalsForPosition(analysisTicker, 0),
            ])

            const currentPrice = quote.price

            // Options P&L (approximated — same as before, using intrinsic value)
            let marketValue: number, gainLoss: number | null, gainLossPct: number | null
            if (isOption && pos.entry_premium && pos.contracts) {
              const totalPremiumPaid = pos.entry_premium * pos.contracts * 100
              const intrinsic = currentPrice > 0 && pos.strike
                ? (pos.option_type === 'call'
                    ? Math.max(0, currentPrice - pos.strike) * pos.contracts * 100
                    : Math.max(0, pos.strike - currentPrice) * pos.contracts * 100)
                : 0
              marketValue = intrinsic > 0 ? intrinsic : totalPremiumPaid * 0.5
              gainLoss = marketValue - totalPremiumPaid
              gainLossPct = ((marketValue - totalPremiumPaid) / totalPremiumPaid) * 100
            } else {
              marketValue = currentPrice * pos.shares
              gainLoss = pos.avg_cost ? (currentPrice - pos.avg_cost) * pos.shares : null
              gainLossPct = pos.avg_cost ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : null
            }

            // Days to expiry
            const daysToExpiry = isOption && pos.expiry
              ? Math.floor((new Date(pos.expiry).getTime() - Date.now()) / 86400000)
              : null

            // Directional exposure
            const exposure = computePositionExposure({ pos, currentPrice })

            return {
              ticker: pos.ticker,
              shares: pos.shares,
              avg_cost: isOption ? (pos.entry_premium ?? null) as number | null : pos.avg_cost,
              currentPrice,
              marketValue,
              gainLoss,
              gainLossPct,
              priceChange1D: quote.change1D,
              rsi: bars.rsi,
              signal: deriveTechSignal(bars.rsi, bars.goldenCross, quote.change1D),
              sma50: bars.sma50,
              sma200: bars.sma200,
              goldenCross: bars.goldenCross,
              ...fundamentals,
              // New fields
              positionType: (pos.position_type ?? 'stock') as 'stock' | 'option',
              optionType: pos.option_type ?? null,
              strike: pos.strike ?? null,
              expiry: pos.expiry ?? null,
              contracts: pos.contracts ?? null,
              daysToExpiry,
              directionalExposure: exposure.directionalExposure,
              capitalAtRisk: exposure.capitalAtRisk,
            }
          })
        )

        send('position_data', positionData)

        // ── Aggregate metrics ────────────────────────────────────
        const totalValue = positionData.reduce((s, p) => s + p.marketValue, 0)
        const totalGainLoss = positionData.reduce((s, p) => s + (p.gainLoss ?? 0), 0)
        const totalCost = positionData.reduce((s, p) => s + (p.avg_cost && p.avg_cost > 0 ? p.avg_cost * p.shares : p.marketValue), 0)
        const totalGainLossPct = totalCost > 0 ? (totalGainLoss / totalCost) * 100 : 0

        // Sector concentration — based on capital at risk (better measure than market value
        // for option-heavy portfolios where market value can be nearly zero pre-expiry)
        const sectorMap: Record<string, number> = {}
        positionData.forEach(p => {
          sectorMap[p.sector] = (sectorMap[p.sector] ?? 0) + p.capitalAtRisk
        })
        const totalCapital = Object.values(sectorMap).reduce((a, b) => a + b, 0)
        const sectorConcentration = Object.entries(sectorMap)
          .map(([sector, value]) => ({ sector, pct: totalCapital > 0 ? (value / totalCapital) * 100 : 0 }))
          .sort((a, b) => b.pct - a.pct)

        // Earnings risk
        const upcomingEarnings = positionData
          .filter(p => p.daysToEarnings !== null && p.daysToEarnings <= 30)
          .sort((a, b) => (a.daysToEarnings ?? 99) - (b.daysToEarnings ?? 99))

        // Signal breakdown
        const signals = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 }
        positionData.forEach(p => { signals[p.signal as keyof typeof signals]++ })

        // ── Per-underlying exposure aggregation (improvement #1, #7) ──
        const exposureByUnderlying = aggregateExposureByUnderlying(positionData)

        // ═════════════════════════════════════════════════════════
        // (2) SINGLE-POSITION SHORT-CIRCUIT — skip the LLM call
        // ═════════════════════════════════════════════════════════
        if (positions.length < 2) {
          const stub = buildSinglePositionStub(positionData)
          const result = {
            positionData,
            metrics: {
              totalValue,
              totalGainLoss,
              totalGainLossPct,
              sectorConcentration,
              upcomingEarnings,
              signals,
              exposureByUnderlying,
            },
            analysis: stub,
          }

          // Cache the stub so we don't recompute it
          const { data: portfolio } = await admin
            .from('portfolios')
            .select('id')
            .eq('user_id', user.id)
            .maybeSingle()

          if (portfolio) {
            await admin.from('portfolio_analyses').upsert({
              portfolio_id: portfolio.id,
              user_id: user.id,
              analysis: { ...result, positionData },
              created_at: new Date().toISOString(),
            }, { onConflict: 'portfolio_id' })
          }

          send('complete', result)
          return
        }

        // ── 2+ positions: run the holistic LLM analysis ───────────
        send('status', { message: 'Running portfolio AI analysis...' })

        // Build position summary for the prompt — now exposure-aware
        const positionSummary = positionData.map(p => {
          const isOpt = p.positionType === 'option'
          const allocPct = totalValue > 0 ? (p.marketValue / totalValue * 100).toFixed(1) : '0.0'
          const exposureLabel = p.directionalExposure > 0
            ? `+$${p.directionalExposure.toFixed(0)} bullish exposure`
            : p.directionalExposure < 0
            ? `-$${Math.abs(p.directionalExposure).toFixed(0)} BEARISH exposure`
            : '$0 flat'

          if (isOpt) {
            return [
              `${p.ticker} [${p.optionType?.toUpperCase()} option, strike $${p.strike}, ${p.daysToExpiry !== null ? p.daysToExpiry + 'd to expiry' : 'no expiry'}]`,
              `  Underlying: $${p.currentPrice.toFixed(2)} (${p.priceChange1D >= 0 ? '+' : ''}${p.priceChange1D.toFixed(1)}% today)`,
              `  Market value: $${p.marketValue.toFixed(0)} (${allocPct}% of portfolio) | P&L: ${p.gainLossPct !== null ? (p.gainLossPct >= 0 ? '+' : '') + p.gainLossPct.toFixed(1) + '%' : 'N/A'}`,
              `  Directional: ${exposureLabel} on the underlying via ${p.optionType?.toUpperCase()}`,
              `  RSI ${p.rsi ?? 'N/A'} | Sector: ${p.sector}${p.daysToEarnings !== null ? ` | Earnings in ${p.daysToEarnings}d` : ''}`,
            ].join('\n')
          } else {
            return [
              `${p.ticker} [stock, ${p.shares} shares]`,
              `  Price: $${p.currentPrice.toFixed(2)} (${p.priceChange1D >= 0 ? '+' : ''}${p.priceChange1D.toFixed(1)}% today)`,
              `  Market value: $${p.marketValue.toFixed(0)} (${allocPct}% of portfolio) | P&L: ${p.gainLossPct !== null ? (p.gainLossPct >= 0 ? '+' : '') + p.gainLossPct.toFixed(1) + '%' : 'N/A'}`,
              `  Directional: ${exposureLabel} (long stock)`,
              `  RSI ${p.rsi ?? 'N/A'} | ${p.goldenCross ? 'Golden cross' : p.goldenCross === false ? 'Death cross' : 'No MA cross signal'} | Sector: ${p.sector}${p.daysToEarnings !== null ? ` | Earnings in ${p.daysToEarnings}d` : ''}`,
            ].join('\n')
          }
        }).join('\n\n')

        // Per-underlying summary (the "what you actually own/are exposed to" view)
        const underlyingSummary = exposureByUnderlying.map(u => {
          const direction = u.netExposure > 0 ? 'NET LONG' : u.netExposure < 0 ? 'NET SHORT' : 'NET FLAT'
          return `${u.underlying}: ${direction} $${Math.abs(u.netExposure).toFixed(0)} — ${u.description} (${u.positionCount} position${u.positionCount === 1 ? '' : 's'}, $${u.totalCapitalAtRisk.toFixed(0)} capital at risk)`
        }).join('\n')

        // Date grounding for the prompt
        const today = new Date().toUTCString().split(' ').slice(0, 4).join(' ')
        const todayISO = new Date().toISOString().split('T')[0]

        const anthropic = new Anthropic()
        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: `Today is ${today} (ISO: ${todayISO}). This is the actual current date from server time. Trust user-supplied dates without arguing.

You are a portfolio analyst providing holistic analysis of a user's investment portfolio. The portfolio may include both stock positions and option positions. Be specific, use actual numbers from the data, and give actionable insights. Write for someone who understands investing but wants clear guidance.

CRITICAL — distinguish position from exposure:
  - A long stock position = bullish exposure to the underlying
  - A long call option = bullish exposure to the underlying (delta-weighted)
  - A long put option = BEARISH exposure to the underlying (delta-weighted, sign flipped)

When the data shows "$X BEARISH exposure to TICKER," do NOT analyze it as if the user owns TICKER. The user is short TICKER via puts. Your reasoning should reflect this:
  - "100% allocated to AI puts" is NOT "100% concentrated in AI stock" — the user has BEARISH exposure to AI, not long exposure
  - A losing put position means the underlying is moving AGAINST the user's bearish bet, i.e., the underlying went up
  - Action plans for losing puts should focus on the option itself (close, roll, let expire), not on "reducing AI position size" — there's no AI long position to reduce

Use the EXPOSURE-BY-UNDERLYING summary as the authoritative view of what the user is really long/short. The position list shows individual contracts; the exposure summary shows net direction per company. When the two disagree (e.g., long shares + protective puts), trust the net exposure for the directional read.

For sector concentration: this is computed from CAPITAL AT RISK (premium paid for options, cost basis for stocks), not market value. This is more accurate for portfolios with deep-OTM options whose market value approaches zero.`,
          messages: [{
            role: 'user',
            content: `PORTFOLIO SUMMARY:
Total market value: $${totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
Total P&L: ${totalGainLoss >= 0 ? '+' : ''}$${totalGainLoss.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${totalGainLossPct >= 0 ? '+' : ''}${totalGainLossPct.toFixed(1)}%)
Position-level signals: ${signals.BULLISH} BULLISH, ${signals.NEUTRAL} NEUTRAL, ${signals.BEARISH} BEARISH
Sector capital: ${sectorConcentration.slice(0, 3).map(s => `${s.sector} ${s.pct.toFixed(0)}%`).join(', ')}
Earnings risk: ${upcomingEarnings.length} positions reporting in next 30 days

EXPOSURE BY UNDERLYING (the real directional view):
${underlyingSummary}

POSITIONS DETAIL:
${positionSummary}

Provide a holistic portfolio analysis in JSON only (no markdown). Reason from EXPOSURE BY UNDERLYING, not raw position count, and be careful not to confuse "owns X" with "has bearish exposure to X via puts":

{
  "overallSignal": "BULLISH|BEARISH|NEUTRAL",
  "overallConviction": "high|medium|low",
  "headline": "one punchy sentence summarizing the portfolio's directional posture and key risks. Reference net exposures, not just position list.",
  "summary": "3-4 sentences. Cover net direction across underlyings, biggest risks, and what's working. Use specific tickers and exposure numbers. If the user has option positions, describe them as exposures (bullish/bearish) — don't say 'concentrated in X stock' when the position is options.",
  "topRisks": [
    {"risk": "specific risk grounded in actual exposures and the data shown", "tickers": ["TICKER"], "severity": "high|medium|low"}
  ],
  "opportunities": [
    {"opportunity": "specific opportunity from the data", "tickers": ["TICKER"]}
  ],
  "sectorAnalysis": "2 sentences on capital concentration by sector. Note this is capital-at-risk weighted, not market-value weighted.",
  "earningsWatch": "specific guidance on upcoming earnings — which ones matter most for the actual exposures and why",
  "rebalancingSuggestions": "2-3 specific, actionable rebalancing suggestions. For options near expiry, the suggestion is the option-specific action (close, roll, let expire), not 'reduce position size.'",
  "actionPlan": "3-4 clear steps for the next 2 weeks. For option positions near expiry, prioritize the expiry deadline. For losing options, the action is about the contract (close, roll), not the underlying.",
  "portfolioScore": <0-100>
}`,
          }],
        })

        const text = (msg.content[0] as { text: string }).text
        const clean = text.replace(/```json|```/g, '').trim()
        const analysis = JSON.parse(clean)

        const result = {
          positionData,
          metrics: {
            totalValue,
            totalGainLoss,
            totalGainLossPct,
            sectorConcentration,
            upcomingEarnings,
            signals,
            exposureByUnderlying,  // ← NEW: surfaced in the response for the UI
          },
          analysis,
        }

        // Cache the analysis
        const { data: portfolio } = await admin
          .from('portfolios')
          .select('id')
          .eq('user_id', user.id)
          .maybeSingle()

        if (portfolio) {
          await admin.from('portfolio_analyses').upsert({
            portfolio_id: portfolio.id,
            user_id: user.id,
            analysis: { ...result, positionData },
            created_at: new Date().toISOString(),
          }, { onConflict: 'portfolio_id' })
        }

        send('complete', result)
      } catch (err) {
        console.error('Portfolio analysis error:', err)
        send('error', { message: err instanceof Error ? err.message : 'Analysis failed' })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  })
}
