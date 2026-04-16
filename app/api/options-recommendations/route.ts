import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'

// Evaluated at request time so env vars are always fresh
const TRADIER_KEY = () => process.env.TRADIER_API_KEY || ''
const TRADIER_BASE = () => TRADIER_KEY()
  ? 'https://api.tradier.com/v1'
  : 'https://sandbox.tradier.com/v1'

export interface OptionsContract {
  symbol: string
  type: 'call' | 'put'
  strike: number
  expiry: string
  last: number | null
  bid: number | null
  ask: number | null
  volume: number
  openInterest: number
  iv: number | null
  delta: number | null
  theta: number | null
  gamma: number | null
  daysToExpiry: number
  moneyness: 'ITM' | 'ATM' | 'OTM'
}

export interface OptionsRecommendation {
  strategy: string           // e.g. "Buy Put Options"
  strategyType: 'long_call' | 'long_put' | 'covered_call' | 'cash_secured_put' | 'bull_call_spread' | 'bear_put_spread' | 'neutral'
  rationale: string          // plain English why
  riskLevel: 'high' | 'medium' | 'low'
  maxLoss: string            // plain English max loss
  maxGain: string            // plain English max gain
  idealFor: string           // who this is suitable for
  timeHorizon: string
  contracts: OptionsContract[]   // specific recommended contracts
  alternativeStrategy: string    // if this one is too risky
  beginnerWarning: string        // always shown for beginners
  greeksExplained: string        // explain delta/theta in plain English
}

async function fetchExpirations(ticker: string): Promise<string[]> {
  try {
    const url = `${TRADIER_BASE()}/markets/options/expirations?symbol=${ticker}&includeAllRoots=true`
    const res = await fetch(url,
      { headers: { 'Authorization': `Bearer ${TRADIER_KEY()}`, 'Accept': 'application/json' } }
    )
    if (!res.ok) return []
    const data = await res.json()
    const dates = data?.expirations?.date ?? []
    return Array.isArray(dates) ? dates : [dates]
  } catch { return [] }
}

async function fetchChain(ticker: string, expiry: string): Promise<OptionsContract[]> {
  try {
    const url = `${TRADIER_BASE()}/markets/options/chains?symbol=${ticker}&expiration=${expiry}&greeks=true`
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${TRADIER_KEY()}`, 'Accept': 'application/json' },
      next: { revalidate: 3600 }
    })
    if (!res.ok) return []
    const data = await res.json()
    const options: Array<Record<string, unknown>> = data?.options?.option ?? []
    if (!options.length) return []

    return options.map(o => {
      const greeks = o.greeks as Record<string, unknown> ?? {}
      const daysToExpiry = Math.ceil((new Date(expiry).getTime() - Date.now()) / 86400000)
      const type: 'call' | 'put' = String(o.option_type) === 'call' ? 'call' : 'put'
      const strike = Number(o.strike)
      return {
        symbol: String(o.symbol ?? ''),
        type, strike, expiry,
        last: o.last ? Number(o.last) : null,
        bid: o.bid ? Number(o.bid) : null,
        ask: o.ask ? Number(o.ask) : null,
        volume: Number(o.volume ?? 0),
        openInterest: Number(o.open_interest ?? 0),
        iv: greeks.mid_iv ? Number(greeks.mid_iv) * 100 : null,
        delta: greeks.delta ? Number(greeks.delta) : null,
        theta: greeks.theta ? Number(greeks.theta) : null,
        gamma: greeks.gamma ? Number(greeks.gamma) : null,
        daysToExpiry,
        moneyness: 'ATM' as 'ITM' | 'ATM' | 'OTM', // set by labelMoneyness
      }
    }).filter(c => c.daysToExpiry > 0 && c.daysToExpiry <= 730)
  } catch { return [] }
}

function labelMoneyness(contracts: OptionsContract[], currentPrice: number): OptionsContract[] {
  return contracts.map(c => ({
    ...c,
    moneyness: Math.abs(c.strike - currentPrice) / currentPrice < 0.02
      ? 'ATM' as const
      : c.type === 'call'
        ? c.strike < currentPrice ? 'ITM' as const : 'OTM' as const
        : c.strike > currentPrice ? 'ITM' as const : 'OTM' as const,
  }))
}

function selectBestContractsWithLevels(
  contracts: OptionsContract[],
  signal: string,
  currentPrice: number,
  timeHorizon: string,
  entryPrice: number,
  stopLoss: number | null,
  takeProfit: number | null,
): OptionsContract[] {
  const targetDTE = timeHorizon.includes('week') ? 14
    : timeHorizon.includes('1 month') || timeHorizon.includes('3-4 week') ? 30
    : timeHorizon.includes('2-3 month') ? 75
    : timeHorizon.includes('3-6 month') || timeHorizon.includes('quarter') ? 120
    : timeHorizon.includes('6') ? 200
    : timeHorizon.includes('year') || timeHorizon.includes('LEAP') || timeHorizon.includes('12') ? 365
    : timeHorizon.includes('2-4') ? 21
    : timeHorizon.includes('2-3') ? 21
    : 30

  const baseFilter = (c: OptionsContract) =>
    c.bid !== null && c.bid > 0 && c.daysToExpiry >= 3 && c.daysToExpiry <= 730

  // Score within DTE band — near-term and LEAP scored separately to prevent one suppressing the other
  const scoreNearTerm = (c: OptionsContract, idealStrike: number) => {
    const strikeProx = Math.max(0, 10 - Math.abs(c.strike - idealStrike) / currentPrice * 100)
    const dteScore   = Math.max(0, 5 - Math.abs(c.daysToExpiry - targetDTE) / 3)
    const liquidity  = Math.min(c.volume / 100 + c.openInterest / 1000, 5)
    return strikeProx + dteScore + liquidity
  }

  const scoreLeap = (c: OptionsContract, idealStrike: number) => {
    // For LEAPs, prioritise ATM-to-slightly-ITM strikes and good open interest
    const strikeProx = Math.max(0, 10 - Math.abs(c.strike - idealStrike) / currentPrice * 100)
    const liquidity  = Math.min(c.openInterest / 500, 5) // LEAPs have lower daily volume
    return strikeProx + liquidity
  }

  const selectWithLeaps = (filtered: OptionsContract[], idealStrike: number): OptionsContract[] => {
    const nearTerm = filtered.filter(c => c.daysToExpiry <= 180)
    const leaps    = filtered.filter(c => c.daysToExpiry > 180)

    // Best 2 near-term + best 1 LEAP (if available), deduped
    const bestNear = nearTerm
      .sort((a, b) => scoreNearTerm(b, idealStrike) - scoreNearTerm(a, idealStrike))
      .slice(0, 2)

    const bestLeap = leaps
      .sort((a, b) => scoreLeap(b, idealStrike) - scoreLeap(a, idealStrike))
      .slice(0, 1)

    // Combine: 2 near-term + 1 LEAP, or 3 near-term if no LEAPs available
    const combined = [...bestNear, ...bestLeap]
    return combined.length > 0 ? combined : nearTerm.slice(0, 3)
  }

  if (signal === 'BULLISH') {
    const idealStrike = entryPrice ?? currentPrice
    const filtered = contracts.filter(c => c.type === 'call' && baseFilter(c))
    return selectWithLeaps(filtered, idealStrike)
  }

  if (signal === 'BEARISH') {
    const idealStrike = entryPrice ?? currentPrice
    const filtered = contracts.filter(c => c.type === 'put' && baseFilter(c))
    return selectWithLeaps(filtered, idealStrike)
  }

  // NEUTRAL — 1 call + 1 put near-term, 1 call LEAP
  const atm = entryPrice ?? currentPrice
  const calls = contracts.filter(c => c.type === 'call' && baseFilter(c))
  const puts  = contracts.filter(c => c.type === 'put' && baseFilter(c))
  const bestCall = calls.sort((a, b) => scoreNearTerm(b, atm) - scoreNearTerm(a, atm)).slice(0, 1)
  const bestPut  = puts.sort((a, b) => scoreNearTerm(b, atm) - scoreNearTerm(a, atm)).slice(0, 1)
  const bestLeapCall = calls.filter(c => c.daysToExpiry > 180).sort((a, b) => scoreLeap(b, atm) - scoreLeap(a, atm)).slice(0, 1)
  return [...bestCall, ...bestPut, ...bestLeapCall]
}

function selectBestContracts(
  contracts: OptionsContract[],
  signal: string,
  currentPrice: number,
  timeHorizon: string,
): OptionsContract[] {
  return selectBestContractsWithLevels(contracts, signal, currentPrice, timeHorizon, currentPrice, null, null)
}



// Alpaca options fallback — uses existing Alpaca API key
async function fetchAlpacaOptions(ticker: string, currentPrice: number): Promise<OptionsContract[]> {
  const key = process.env.ALPACA_API_KEY
  const secret = process.env.ALPACA_SECRET_KEY
  if (!key || !secret) return []

  try {
    // Get nearest expiry dates
    const expRes = await fetch(
      `https://data.alpaca.markets/v1beta1/options/snapshots/${ticker}?feed=opra&limit=500&type=call`,
      {
        headers: {
          'APCA-API-KEY-ID': key,
          'APCA-API-SECRET-KEY': secret,
          'Accept': 'application/json',
        }
      }
    )

    if (!expRes.ok) {
      console.error('Alpaca options error:', expRes.status, await expRes.text())
      return []
    }

    const data = await expRes.json()
    const snapshots = data?.snapshots ?? {}
    if (!Object.keys(snapshots).length) return []

    // Get put snapshots too
    const putRes = await fetch(
      `https://data.alpaca.markets/v1beta1/options/snapshots/${ticker}?feed=opra&limit=500&type=put`,
      {
        headers: {
          'APCA-API-KEY-ID': key,
          'APCA-API-SECRET-KEY': secret,
          'Accept': 'application/json',
        }
      }
    )
    const putData = putRes.ok ? await putRes.json() : { snapshots: {} }
    const putSnapshots = putData?.snapshots ?? {}

    const allSnapshots = { ...snapshots, ...putSnapshots }

    const toContract = (symbol: string, snap: Record<string, unknown>): OptionsContract | null => {
      try {
        // Parse OCC symbol: MSFT240119C00400000
        const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/)
        if (!match) return null
        const [, , dateStr, optType, strikeStr] = match
        const year  = parseInt('20' + dateStr.slice(0, 2))
        const month = parseInt(dateStr.slice(2, 4)) - 1
        const day   = parseInt(dateStr.slice(4, 6))
        const expiryDate = new Date(year, month, day)
        const expiryStr = expiryDate.toISOString().split('T')[0]
        const daysToExpiry = Math.ceil((expiryDate.getTime() - Date.now()) / 86400000)
        if (daysToExpiry < 1 || daysToExpiry > 730) return null

        const strike = parseInt(strikeStr) / 1000
        const type: 'call' | 'put' = optType === 'C' ? 'call' : 'put'
        const greeks = snap.greeks as Record<string, unknown> ?? {}
        const quote  = snap.latestQuote as Record<string, unknown> ?? {}
        const trade  = snap.latestTrade as Record<string, unknown> ?? {}
        const iv     = (snap.impliedVolatility as number ?? 0) * 100

        return {
          symbol,
          type,
          strike,
          expiry: expiryStr,
          last: trade.p ? Number(trade.p) : null,
          bid: quote.bp ? Number(quote.bp) : null,
          ask: quote.ap ? Number(quote.ap) : null,
          volume: Number(snap.dailyBar ? (snap.dailyBar as Record<string, unknown>).v ?? 0 : 0),
          openInterest: Number(snap.openInterest ?? 0),
          iv: iv || null,
          delta: greeks.delta ? Number(greeks.delta) : null,
          theta: greeks.theta ? Number(greeks.theta) : null,
          gamma: greeks.gamma ? Number(greeks.gamma) : null,
          daysToExpiry,
          moneyness: Math.abs(strike - currentPrice) / currentPrice < 0.02
            ? 'ATM'
            : type === 'call'
              ? strike < currentPrice ? 'ITM' : 'OTM'
              : strike > currentPrice ? 'ITM' : 'OTM' as 'ITM' | 'ATM' | 'OTM',
        }
      } catch { return null }
    }

    const contracts = Object.entries(allSnapshots)
      .map(([sym, snap]) => toContract(sym, snap as Record<string, unknown>))
      .filter((c): c is OptionsContract => c !== null)
      .filter(c => c.bid !== null && c.bid > 0 && c.volume > 0)
    return contracts
  } catch (e) {
    console.error('Alpaca options exception:', e)
    return []
  }
}



export async function POST(req: NextRequest) {
  try {
    const { ticker, currentPrice, signal, timeHorizon, target, technicals, verdict, stopLoss, entryPrice, takeProfit } = await req.json()

    // Parse Judge's specific price levels for intelligent strike selection
    const parsePrice = (s: string | number | undefined): number | null => {
      if (!s) return null
      const n = parseFloat(String(s).replace(/[^0-9.-]/g, ''))
      return isNaN(n) ? null : n
    }
    const judgeStop    = parsePrice(stopLoss)
    const judgeEntry   = parsePrice(entryPrice) ?? currentPrice
    const judgeTarget  = parsePrice(takeProfit) ?? parsePrice(target)

    // ── Fetch options chain ───────────────────────────────────
    let contracts: OptionsContract[] = []
    let expiriesUsed: string[] = []
    let dataSource = 'none'

    // Primary: Tradier — confirmed working in production
    if (TRADIER_KEY()) {
      const expiries = await fetchExpirations(ticker)
      // Include near-term AND LEAP expirations (up to 2 years out)
      // Near-term: first 4 expirations; LEAPs: any expiry > 180 days
      const nearTerm = expiries.slice(0, 4)
      const leapExpiries = expiries.filter((e: string) => {
        const dte = Math.ceil((new Date(e).getTime() - Date.now()) / 86400000)
        return dte > 180 && dte <= 730
      }).slice(0, 4) // max 4 LEAP expirations
      const targetExpiries = [...new Set([...nearTerm, ...leapExpiries])]
      expiriesUsed = targetExpiries
      const chains = await Promise.all(targetExpiries.map(exp => fetchChain(ticker, exp)))
      const allContracts = chains.flat()
      contracts = labelMoneyness(allContracts, currentPrice)
      if (contracts.length > 0) dataSource = 'Tradier'
    }

    // Fallback: Alpaca options
    if (contracts.length === 0) {
      contracts = await fetchAlpacaOptions(ticker, currentPrice)
      if (contracts.length > 0) dataSource = 'Alpaca'
    }

    const bestContracts = selectBestContractsWithLevels(contracts, signal, currentPrice, timeHorizon || '30 days', judgeEntry, judgeStop, judgeTarget)

    // ── AI strategy recommendation ────────────────────────────
    const anthropic = new Anthropic()

    const contractSummary = bestContracts.length > 0
      ? bestContracts.map(c =>
          `${c.type.toUpperCase()} $${c.strike} exp ${c.expiry} | Bid $${c.bid?.toFixed(2)} Ask $${c.ask?.toFixed(2)} | Delta ${c.delta?.toFixed(2)} Theta ${c.theta?.toFixed(2)} | Vol ${c.volume} OI ${c.openInterest} | IV ${c.iv?.toFixed(0)}% | ${c.moneyness} | ${c.daysToExpiry}d${c.daysToExpiry > 180 ? ' ← LEAP' : ''}`
        ).join('\n')
      : 'No live options chain available'

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system: `You are an options trading expert providing specific, actionable options recommendations. Always explain in plain English that a complete beginner can understand. Never assume prior knowledge of options. Be honest about risks.`,
      messages: [{
        role: 'user',
        content: `Ticker: ${ticker}
Current Price: $${currentPrice}
Council Verdict: ${signal}
Council Entry Zone: ${judgeEntry ? '$' + judgeEntry.toFixed(2) : 'N/A'}
Council Stop Loss: ${judgeStop ? '$' + judgeStop.toFixed(2) + ' (' + (((judgeStop - currentPrice) / currentPrice) * 100).toFixed(1) + '%)' : 'N/A'}
Council Take Profit: ${judgeTarget ? '$' + judgeTarget.toFixed(2) + ' (' + (((judgeTarget - currentPrice) / currentPrice) * 100).toFixed(1) + '%)' : 'N/A'}
Time Horizon: ${timeHorizon}
Technical Score: ${technicals?.technicalScore ?? 'N/A'}
RSI: ${technicals?.rsi ?? 'N/A'}

Verdict Summary: ${verdict}

Available Options Contracts (pre-selected near the council's entry zone):
${contractSummary}

IMPORTANT — Use the Council's specific price levels in your recommendation:
- Stop loss at ${judgeStop ? '$' + judgeStop.toFixed(2) : 'N/A'} defines the maximum risk on this trade
- Take profit at ${judgeTarget ? '$' + judgeTarget.toFixed(2) : 'N/A'} is the realistic target
- Choose strikes that make sense given these levels — don't suggest contracts that expire before the move can develop

LEAP OPTIONS (expiry > 180 days): If contracts with 180+ days to expiry are shown, consider recommending them when:
- The time horizon is 3M or longer
- The thesis requires time to play out (fundamental catalyst, sector rotation)
- High IV makes short-term options expensive — LEAPs have lower theta decay per day
- The user wants stock-like exposure with less capital at risk
LEAPs behave more like stock (delta 0.7-0.9) and less like lottery tickets. Explain this clearly.

CRITICAL RULES:
- If signal is NEUTRAL: strategyType MUST be "neutral". Recommend waiting or income strategies.
- If signal is BULLISH: recommend calls near the entry zone ($${judgeEntry?.toFixed(2) ?? currentPrice.toFixed(2)})
- If signal is BEARISH: recommend puts near the entry zone ($${judgeEntry?.toFixed(2) ?? currentPrice.toFixed(2)})
- NEVER contradict the signal direction.
- Always reference the specific contracts shown above by strike and expiry.
- If recommending a LEAP, explain why the longer duration is appropriate for this specific thesis.

Respond in JSON only (no markdown):
{
  "strategy": "specific strategy name e.g. 'Buy $${judgeEntry?.toFixed(0) ?? ''}  Put — targeting $${judgeTarget?.toFixed(0) ?? ''}'",
  "strategyType": "long_call|long_put|leap_call|leap_put|covered_call|cash_secured_put|bull_call_spread|bear_put_spread|diagonal_spread|neutral",
  "specificContract": "Which exact contract from the list above you'd choose and why — reference strike and expiry",
  "rationale": "2-3 sentences: why this contract fits the council's verdict. Reference entry $${judgeEntry?.toFixed(2) ?? ''}, stop $${judgeStop?.toFixed(2) ?? ''}, target $${judgeTarget?.toFixed(2) ?? ''}",
  "riskLevel": "high|medium|low",
  "maxLoss": "Specific dollar amount: premium paid × 100 shares per contract. If stop is hit at $${judgeStop?.toFixed(2) ?? ''}, the put/call is worth approx X.",
  "maxGain": "If ${ticker} reaches $${judgeTarget?.toFixed(2) ?? 'target'}, the contract is worth approx X — a Y% gain on premium paid.",
  "idealFor": "who this strategy is suitable for",
  "timeHorizon": "Specific expiry recommendation that covers the ${timeHorizon} time horizon",
  "alternativeStrategy": "A simpler alternative. If NEUTRAL, suggest waiting for verdict to change.",
  "beginnerWarning": "Honest risk warning specific to this trade.",
  "greeksExplained": "Delta: for every $1 move in ${ticker}, the option moves $X. Theta: you lose $X per day in time value. Reference the specific contracts."
}`
      }]
    })

    const text = (msg.content[0] as { text: string }).text
    const clean = text.replace(/```json|```/g, '').trim()
    const recommendation = JSON.parse(clean)

    return NextResponse.json({
      recommendation,
      contracts: bestContracts,
      expiriesAvailable: expiriesUsed,
      hasLiveData: bestContracts.length > 0,
      dataSource,
    })

  } catch (err) {
    console.error('Options recommendation error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate recommendation' },
      { status: 500 }
    )
  }
}
