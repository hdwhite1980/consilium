import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

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
    console.log('Tradier expirations URL:', url, 'key present:', !!TRADIER_KEY())
    const res = await fetch(url,
      { headers: { 'Authorization': `Bearer ${TRADIER_KEY()}`, 'Accept': 'application/json' } }
    )
    if (!res.ok) {
      console.error('Tradier expirations error:', res.status, await res.text())
      return []
    }
    const data = await res.json()
    console.log('Tradier expirations response:', JSON.stringify(data).slice(0, 200))
    const dates = data?.expirations?.date ?? []
    return Array.isArray(dates) ? dates : [dates]
  } catch (e) {
    console.error('Tradier expirations exception:', e)
    return []
  }
}

// Alpaca options fallback — uses existing Alpaca API key
async function fetchAlpacaOptions(ticker: string, currentPrice: number): Promise<OptionsContract[]> {
  const key = process.env.ALPACA_API_KEY
  const secret = process.env.ALPACA_SECRET_KEY
  if (!key || !secret) return []

  try {
    // Get nearest expiry dates
    const expRes = await fetch(
      `https://data.alpaca.markets/v1beta1/options/snapshots/${ticker}?feed=indicative&limit=100&type=call`,
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
      `https://data.alpaca.markets/v1beta1/options/snapshots/${ticker}?feed=indicative&limit=100&type=put`,
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
        if (daysToExpiry < 1 || daysToExpiry > 90) return null

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
              : strike > currentPrice ? 'ITM' : 'OTM',
        }
      } catch { return null }
    }

    const contracts = Object.entries(allSnapshots)
      .map(([sym, snap]) => toContract(sym, snap as Record<string, unknown>))
      .filter((c): c is OptionsContract => c !== null)
      .filter(c => c.bid !== null && c.bid > 0 && c.volume > 0)

    console.log(`Alpaca options: ${contracts.length} contracts for ${ticker}`)
    return contracts
  } catch (e) {
    console.error('Alpaca options exception:', e)
    return []
  }
}

async function fetchChain(ticker: string, expiry: string): Promise<OptionsContract[]> {
  try {
    const url = `${TRADIER_BASE()}/markets/options/chains?symbol=${ticker}&expiration=${expiry}&greeks=true`
    const res = await fetch(url,
      { headers: { 'Authorization': `Bearer ${TRADIER_KEY()}`, 'Accept': 'application/json' } }
    )
    if (!res.ok) {
      const text = await res.text()
      console.error(`Tradier chain ${expiry} error:`, res.status, text.slice(0, 200))
      return []
    }
    const data = await res.json()
    console.log(`Tradier chain ${expiry}: ${JSON.stringify(data).slice(0, 150)}`)
    const options = data?.options?.option ?? []
    const arr = Array.isArray(options) ? options : [options]
    return arr.map((o: Record<string, unknown>) => ({
      symbol: String(o.symbol ?? ''),
      type: String(o.option_type) === 'call' ? 'call' : 'put',
      strike: Number(o.strike ?? 0),
      expiry,
      last: o.last !== null ? Number(o.last) : null,
      bid: o.bid !== null ? Number(o.bid) : null,
      ask: o.ask !== null ? Number(o.ask) : null,
      volume: Number(o.volume ?? 0),
      openInterest: Number(o.open_interest ?? 0),
      iv: o.greeks ? Number((o.greeks as Record<string, unknown>).smv_vol ?? 0) * 100 : null,
      delta: o.greeks ? Number((o.greeks as Record<string, unknown>).delta ?? 0) : null,
      theta: o.greeks ? Number((o.greeks as Record<string, unknown>).theta ?? 0) : null,
      gamma: o.greeks ? Number((o.greeks as Record<string, unknown>).gamma ?? 0) : null,
      daysToExpiry: Math.ceil((new Date(expiry).getTime() - Date.now()) / 86400000),
      moneyness: 'OTM', // computed below
    })) as OptionsContract[]
  } catch { return [] }
}

function labelMoneyness(contracts: OptionsContract[], currentPrice: number): OptionsContract[] {
  return contracts.map(c => ({
    ...c,
    moneyness: Math.abs(c.strike - currentPrice) / currentPrice < 0.02
      ? 'ATM'
      : c.type === 'call'
        ? c.strike < currentPrice ? 'ITM' : 'OTM'
        : c.strike > currentPrice ? 'ITM' : 'OTM',
  }))
}

function selectBestContracts(
  contracts: OptionsContract[],
  signal: string,
  currentPrice: number,
  timeHorizon: string
): OptionsContract[] {
  const isBullish = signal === 'BULLISH'
  const isBearish = signal === 'BEARISH'

  // Determine target DTE based on time horizon
  const targetDTE = timeHorizon.includes('week') ? 14
    : timeHorizon.includes('month') ? 30
    : timeHorizon.includes('2-3') ? 21
    : 30

  const type = isBullish ? 'call' : isBearish ? 'put' : null
  if (!type) return []

  return contracts
    .filter(c =>
      c.type === type &&
      c.bid !== null && c.bid > 0 &&
      c.daysToExpiry >= targetDTE - 7 &&
      c.daysToExpiry <= targetDTE + 21 &&
      c.volume > 0
    )
    .sort((a, b) => {
      // Prefer ATM/slightly OTM with good liquidity
      const aScore = (a.moneyness === 'ATM' ? 10 : a.moneyness === 'OTM' ? 5 : 2)
        + Math.min(a.volume / 100, 5)
      const bScore = (b.moneyness === 'ATM' ? 10 : b.moneyness === 'OTM' ? 5 : 2)
        + Math.min(b.volume / 100, 5)
      return bScore - aScore
    })
    .slice(0, 3)
}

export async function POST(req: NextRequest) {
  try {
    const { ticker, currentPrice, signal, timeHorizon, target, technicals, verdict } = await req.json()

    // ── Fetch options chain ───────────────────────────────────
    let contracts: OptionsContract[] = []
    let expiriesUsed: string[] = []
    let dataSource = 'none'

    if (TRADIER_KEY()) {
      const expiries = await fetchExpirations(ticker)
      const targetExpiries = expiries.slice(0, 4)
      expiriesUsed = targetExpiries
      const chains = await Promise.all(targetExpiries.map(exp => fetchChain(ticker, exp)))
      const allContracts = chains.flat()
      contracts = labelMoneyness(allContracts, currentPrice)
      if (contracts.length > 0) dataSource = 'Tradier'
    }

    // Fallback to Alpaca options if no Tradier data
    if (contracts.length === 0) {
      contracts = await fetchAlpacaOptions(ticker, currentPrice)
      if (contracts.length > 0) dataSource = 'Alpaca'
    }

    const bestContracts = selectBestContracts(contracts, signal, currentPrice, timeHorizon || '30 days')

    // ── AI strategy recommendation ────────────────────────────
    const anthropic = new Anthropic()

    const contractSummary = bestContracts.length > 0
      ? bestContracts.map(c =>
          `${c.type.toUpperCase()} $${c.strike} exp ${c.expiry} | Bid $${c.bid?.toFixed(2)} Ask $${c.ask?.toFixed(2)} | Delta ${c.delta?.toFixed(2)} Theta ${c.theta?.toFixed(2)} | Vol ${c.volume} OI ${c.openInterest} | IV ${c.iv?.toFixed(0)}% | ${c.moneyness} | ${c.daysToExpiry}d to expiry`
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
Price Target: ${target}
Time Horizon: ${timeHorizon}
Technical Score: ${technicals?.technicalScore ?? 'N/A'}
MA Cross: ${technicals?.goldenCross ? 'Golden Cross (bullish)' : 'Death Cross (bearish)'}
RSI: ${technicals?.rsi ?? 'N/A'}

Verdict Summary: ${verdict}

Available Options Contracts:
${contractSummary}

CRITICAL RULES:
- If signal is NEUTRAL: strategyType MUST be "neutral". Do NOT recommend buying calls or puts on a neutral signal. Instead recommend strategies that profit from time decay or sideways movement (covered calls, cash-secured puts, iron condors).
- If signal is BULLISH: strategyType should be "long_call" or "bull_call_spread"
- If signal is BEARISH: strategyType should be "long_put" or "bear_put_spread"
- NEVER contradict the signal. A NEUTRAL signal means the council sees no clear direction — respect that.
- If NEUTRAL, the strategy name should reflect this e.g. "Sell Covered Calls", "Wait for Clearer Signal", "Cash-Secured Put for Entry"

Based on this analysis, provide a specific options recommendation in JSON only (no markdown):
{
  "strategy": "short name matching the signal e.g. 'Sell Covered Calls' for NEUTRAL, 'Buy Call Options' for BULLISH",
  "strategyType": "long_call|long_put|covered_call|cash_secured_put|bull_call_spread|bear_put_spread|neutral",
  "rationale": "2-3 sentences explaining WHY this strategy fits the verdict signal in plain English. Must be consistent with the ${signal} signal. Reference the actual price target and time horizon.",
  "riskLevel": "high|medium|low",
  "maxLoss": "plain English description of worst case e.g. 'You lose the entire premium paid, which is $X per contract ($X total for 1 contract controlling 100 shares)'",
  "maxGain": "plain English description of best case with realistic numbers based on the price target",
  "idealFor": "who this strategy is suitable for",
  "timeHorizon": "specific recommendation e.g. 'Look for contracts expiring in 3-4 weeks'",
  "alternativeStrategy": "A safer/simpler alternative. For NEUTRAL signal, suggest simply waiting for a clearer signal before trading options.",
  "beginnerWarning": "A clear, honest warning about options risk. If signal is NEUTRAL, emphasize that trading options on a neutral signal is especially risky because there is no clear direction.",
  "greeksExplained": "Explain what delta, theta, and IV mean for the specific contracts above in plain English."
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
