/**
 * Wali-OS — Position Health Check
 * GET /api/portfolio/check?ticker=NVDA  — single position
 * POST /api/portfolio/check             — all positions
 *
 * Stocks: RSI, volume, P&L vs entry/stop/target
 * Options: live Greeks (delta/theta/IV), intrinsic vs time value,
 *          moneyness, days to expiry, P&L on premium
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
  currentPremium: number | null      // live bid/ask midpoint
  optionPnlPct: number | null        // % change on premium
  optionPnlDollar: number | null     // dollar P&L on all contracts
  daysToExpiry: number | null
  timeDecayUrgent: boolean

  // Greeks
  delta: number | null               // directional exposure
  theta: number | null               // daily time decay in $
  gamma: number | null               // rate of delta change
  vega: number | null                // IV sensitivity
  impliedVolatility: number | null   // as decimal (0.45 = 45%)
  intrinsicValue: number | null      // how much is in-the-money
  timeValue: number | null           // premium above intrinsic
  moneyness: 'deep_itm' | 'itm' | 'atm' | 'otm' | 'deep_otm'
  breakeven: number | null           // price underlying needs to reach by expiry

  verdict: 'HOLD' | 'EXIT' | 'ADD' | 'WATCH'
  conviction: 'high' | 'medium' | 'low'
  reason: string
  action: string
  flags: string[]
}

// ── Fetch underlying quote + technicals ────────────────────────────────────────

async function fetchUnderlyingData(ticker: string) {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return null
  try {
    const [qr, mr, rr] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${key}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${key}`),
      fetch(`https://finnhub.io/api/v1/indicator?symbol=${ticker}&resolution=D&from=${Math.floor((Date.now()-60*86400000)/1000)}&to=${Math.floor(Date.now()/1000)}&indicator=rsi&timeperiod=14&token=${key}`),
    ])
    if (!qr.ok) return null
    const q = await qr.json()
    if (!q.c || q.c === 0) return null

    const price = parseFloat(q.c.toFixed(2))
    const prev = q.pc || price
    const change1D = parseFloat(((price - prev) / prev * 100).toFixed(2))

    let volumeRatio = null
    if (mr.ok) {
      const m = await mr.json()
      const avgVol = m.metric?.['10DayAverageTradingVolume']
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

// ── Fetch live option data from Tradier ────────────────────────────────────────

async function fetchOptionData(
  underlying: string,
  optionType: 'call' | 'put',
  strike: number,
  expiry: string  // YYYY-MM-DD
) {
  try {
    // Get the specific option chain for this expiry
    const chainRes = await fetch(
      `${TRADIER_BASE}/markets/options/chains?symbol=${underlying}&expiration=${expiry}&greeks=true`,
      { headers: { Authorization: `Bearer ${TRADIER_KEY}`, Accept: 'application/json' } }
    )
    if (!chainRes.ok) return null
    const chain = await chainRes.json()
    const options: any[] = chain.options?.option ?? []

    // Find exact contract
    const contract = options.find(o =>
      o.option_type === optionType &&
      Math.abs(o.strike - strike) < 0.01
    )
    if (!contract) {
      // Try to find closest strike
      const sameType = options.filter(o => o.option_type === optionType)
      const closest = sameType.sort((a, b) => Math.abs(a.strike - strike) - Math.abs(b.strike - strike))[0]
      if (!closest) return null
      return parseContractData(closest)
    }
    return parseContractData(contract)
  } catch { return null }
}

function parseContractData(contract: any) {
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

// ── Compute moneyness ─────────────────────────────────────────────────────────

function getMoneyness(
  optionType: 'call' | 'put',
  strike: number,
  underlyingPrice: number
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

// ── Build check for a single position ─────────────────────────────────────────

async function buildCheck(pos: any): Promise<PositionCheck> {
  const isOption = pos.position_type === 'option'
  const underlying = (pos.underlying || pos.ticker).toUpperCase()

  // Always fetch underlying data
  const uData = await fetchUnderlyingData(underlying)
  if (!uData) {
    return buildErrorCheck(pos, 'Could not fetch live data')
  }

  const flags: string[] = []

  if (!isOption) {
    // ── STOCK PATH ────────────────────────────────────────────────────────────
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

    // Stock flags
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

    const parts = [
      pnlPct !== null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct}% P&L` : null,
      uData.rsi !== null ? `RSI ${uData.rsi}` : null,
      uData.volumeRatio !== null && uData.volumeRatio > 1.2 ? `${uData.volumeRatio}x avg vol` : null,
      pctFromStop !== null ? `${pctFromStop.toFixed(1)}% from stop` : null,
      pctFromTarget !== null ? `${pctFromTarget.toFixed(1)}% from target` : null,
    ].filter(Boolean).join(' · ')

    return {
      ticker: pos.ticker,
      position_type: 'stock',
      underlyingPrice: uData.price,
      underlyingChange1D: uData.change1D,
      underlyingRsi: uData.rsi,
      underlyingVolumeRatio: uData.volumeRatio,
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

  // ── OPTIONS PATH ──────────────────────────────────────────────────────────
  const optionType = (pos.option_type || 'call') as 'call' | 'put'
  const strike = pos.strike || 0
  const expiry = pos.expiry || ''
  const contracts = pos.contracts || 1
  const entryPremium = pos.entry_premium || null

  // Days to expiry
  const daysToExpiry = expiry
    ? Math.floor((new Date(expiry).getTime() - Date.now()) / 86400000)
    : null
  const timeDecayUrgent = daysToExpiry !== null && daysToExpiry <= 7

  // Fetch live option data
  const optData = await fetchOptionData(underlying, optionType, strike, expiry)

  const currentPremium = optData?.currentPremium ?? null
  const optionPnlPct = entryPremium && currentPremium
    ? parseFloat(((currentPremium - entryPremium) / entryPremium * 100).toFixed(2))
    : null
  const optionPnlDollar = entryPremium && currentPremium
    ? parseFloat(((currentPremium - entryPremium) * contracts * 100).toFixed(2))
    : null

  // Intrinsic value and time value
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

  // Options flags
  if (daysToExpiry !== null && daysToExpiry < 0) flags.push('⚠ OPTION EXPIRED')
  else if (daysToExpiry !== null && daysToExpiry <= 3) flags.push(`⚠ ${daysToExpiry}d to expiry — exit or roll`)
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

  // Options verdict logic
  let verdict: PositionCheck['verdict'] = 'HOLD'
  let conviction: PositionCheck['conviction'] = 'medium'

  if (daysToExpiry !== null && daysToExpiry < 0) {
    verdict = 'EXIT'; conviction = 'high'
  } else if (daysToExpiry !== null && daysToExpiry <= 2) {
    verdict = 'EXIT'; conviction = 'high'
  } else if (optionPnlPct !== null && optionPnlPct <= -70) {
    verdict = 'EXIT'; conviction = 'high'   // most of premium gone
  } else if (optionPnlPct !== null && optionPnlPct >= 100) {
    verdict = 'EXIT'; conviction = 'high'   // doubled — take it
  } else if (moneyness === 'deep_otm' && timeDecayUrgent) {
    verdict = 'EXIT'; conviction = 'high'   // no path to profit
  } else if (daysToExpiry !== null && daysToExpiry <= 7) {
    verdict = 'WATCH'; conviction = 'high'
  } else if (optionPnlPct !== null && optionPnlPct <= -40) {
    verdict = 'WATCH'; conviction = 'medium'
  } else if (optionPnlPct !== null && optionPnlPct >= 50) {
    verdict = 'WATCH'; conviction = 'medium'  // nice profit, decide whether to hold
  }

  const parts = [
    currentPremium !== null ? `Premium $${currentPremium}` : null,
    optionPnlPct !== null ? `${optionPnlPct >= 0 ? '+' : ''}${optionPnlPct}% on premium` : null,
    optData?.delta != null ? `Δ ${optData.delta.toFixed(2)}` : null,
    optData?.theta != null ? `θ ${optData.theta.toFixed(3)}/day` : null,
    optData?.impliedVolatility != null ? `IV ${(optData.impliedVolatility * 100).toFixed(0)}%` : null,
    moneyness.replace('_', ' '),
    daysToExpiry !== null ? `${daysToExpiry}d left` : null,
    uData.rsi !== null ? `RSI ${uData.rsi}` : null,
  ].filter(Boolean).join(' · ')

  let action = 'Hold — thesis intact'
  if (verdict === 'EXIT') {
    if (daysToExpiry !== null && daysToExpiry <= 2) action = 'Exit immediately — expiring soon, sell to recover any remaining value'
    else if (optionPnlPct !== null && optionPnlPct >= 100) action = 'Take profit — premium has doubled. Sell and lock in gains'
    else if (optionPnlPct !== null && optionPnlPct <= -70) action = 'Cut loss — premium down 70%+. Exit to preserve remaining capital'
    else action = 'Exit position — exit criteria met'
  } else if (verdict === 'WATCH') {
    if (daysToExpiry !== null && daysToExpiry <= 7) action = `${daysToExpiry}d left — decide: exit, roll to later expiry, or hold through expiry`
    else if (optionPnlPct !== null && optionPnlPct >= 50) action = 'Consider selling half to lock in gains, let rest ride'
    else action = 'Monitor closely — set alert if premium drops another 20%'
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
    verdict, conviction,
    reason: parts || `${optionType.toUpperCase()} $${strike} exp ${expiry}`,
    action, flags,
  }
}

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
    verdict: 'HOLD', conviction: 'low', reason: msg, action: 'Retry later', flags: [msg],
  }
}

// ── AI enrichment ─────────────────────────────────────────────────────────────

async function enrichWithAI(checks: PositionCheck[]): Promise<PositionCheck[]> {
  if (!checks.length) return checks
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const snapshot = checks.map(c => {
      if (c.position_type === 'option') {
        return [
          `${c.ticker} ${c.optionType?.toUpperCase()} $${c.strike} exp ${c.expiry} (${c.contracts}x contracts)`,
          `  Underlying: $${c.underlyingPrice} (${c.underlyingChange1D >= 0 ? '+' : ''}${c.underlyingChange1D}% today) | RSI ${c.underlyingRsi ?? 'N/A'}`,
          `  Entry premium: ${c.entryPremium ? `$${c.entryPremium}` : 'N/A'} | Current: ${c.currentPremium ? `$${c.currentPremium}` : 'N/A'} | P&L: ${c.optionPnlPct !== null ? `${c.optionPnlPct >= 0 ? '+' : ''}${c.optionPnlPct}% ($${c.optionPnlDollar})` : 'N/A'}`,
          `  Greeks: Delta ${c.delta ?? 'N/A'} | Theta ${c.theta ?? 'N/A'}/day | IV ${c.impliedVolatility ? `${(c.impliedVolatility*100).toFixed(0)}%` : 'N/A'}`,
          `  ${c.daysToExpiry}d to expiry | ${c.moneyness.replace('_',' ')} | Intrinsic $${c.intrinsicValue ?? 0} | Time value $${c.timeValue ?? 0}`,
          `  Breakeven: $${c.breakeven ?? 'N/A'}`,
          c.flags.length ? `  Flags: ${c.flags.join(', ')}` : '',
        ].filter(Boolean).join('\n')
      } else {
        return [
          `${c.ticker} stock (${c.shares} shares @ $${c.entryPrice ?? '?'})`,
          `  Price: $${c.underlyingPrice} (${c.underlyingChange1D >= 0 ? '+' : ''}${c.underlyingChange1D}% today) | P&L: ${c.pnlPct !== null ? `${c.pnlPct >= 0 ? '+' : ''}${c.pnlPct}%` : 'N/A'} ($${c.pnlDollar ?? 0})`,
          `  RSI ${c.underlyingRsi ?? 'N/A'} | Volume ${c.underlyingVolumeRatio ?? 'N/A'}x avg`,
          c.stopLoss ? `  Stop: $${c.stopLoss} (${c.pctFromStop?.toFixed(1)}% away)` : '  No stop set',
          c.takeProfit ? `  Target: $${c.takeProfit} (${c.pctFromTarget?.toFixed(1)}% away)` : '  No target set',
          c.flags.length ? `  Flags: ${c.flags.join(', ')}` : '',
        ].filter(Boolean).join('\n')
      }
    }).join('\n\n')

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages: [{ role: 'user', content: `You are a trading coach reviewing live positions. Be direct and specific — cite the actual numbers. No fluff.\n\n${snapshot}\n\nFor options: consider delta (directional exposure), theta (daily decay cost), IV level, moneyness, and days to expiry together. A 0.25 delta OTM call with 5 days left and 60% IV is a very different situation than a 0.55 delta ITM call with 30 days.\n\nJSON array, same order:\n[\n  {\n    "ticker": "NVDA",\n    "verdict": "HOLD",\n    "conviction": "high",\n    "reason": "specific reason with actual numbers",\n    "action": "specific action step",\n    "flags": ["any additional flags"]\n  }\n]\nJSON only.` }]
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (msg.content.find((b: any) => b.type === 'text') as any)?.text || ''
    const clean = text.replace(/```json|```/g, '').trim()
    const ai: any[] = JSON.parse(clean.slice(clean.indexOf('['), clean.lastIndexOf(']') + 1))
    return checks.map((c, i) => {
      const a = ai[i]
      if (!a || a.ticker !== c.ticker) return c
      return { ...c,
        verdict: a.verdict || c.verdict,
        conviction: a.conviction || c.conviction,
        reason: a.reason || c.reason,
        action: a.action || c.action,
        flags: [...new Set([...c.flags, ...(a.flags || [])])],
      }
    })
  } catch { return checks }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

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
  const jMap = new Map<string, any>()
  for (const j of (journal || [])) jMap.set(j.ticker, j)
  return { positions, jMap }
}

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

// ── GET — single ticker ───────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ticker = new URL(req.url).searchParams.get('ticker')?.toUpperCase()
  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })

  const { positions, jMap } = await getPositionsAndJournal(user.id)
  const pos = positions.find((p: any) => p.ticker === ticker) || { ticker, shares: 1, position_type: 'stock' }
  const merged = mergeWithJournal(pos, jMap.get(ticker))

  const check = await buildCheck(merged)
  const [enriched] = await enrichWithAI([check])
  return NextResponse.json({ check: enriched })
}

// ── POST — all positions ──────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { positions: jPositions, jMap } = await getPositionsAndJournal(user.id)
  if (!jPositions.length) return NextResponse.json({ checks: [] })

  // Sequential with rate-limit delay (3 Finnhub calls per position)
  const checks: PositionCheck[] = []
  for (const pos of jPositions) {
    const merged = mergeWithJournal(pos, jMap.get(pos.ticker))
    checks.push(await buildCheck(merged))
    await new Promise(r => setTimeout(r, 400))
  }

  const enriched = await enrichWithAI(checks)
  const order = { EXIT: 0, WATCH: 1, HOLD: 2, ADD: 3 }
  enriched.sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9))
  return NextResponse.json({ checks: enriched, checkedAt: new Date().toISOString() })
}
