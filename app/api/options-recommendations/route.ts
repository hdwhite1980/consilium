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

// Yahoo Finance fallback — no API key needed
async function fetchYahooOptions(ticker: string, currentPrice: number): Promise<OptionsContract[]> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/options/${ticker}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, next: { revalidate: 900 } }
    )
    if (!res.ok) return []
    const data = await res.json()
    const result = data?.optionChain?.result?.[0]
    if (!result) return []

    const expiry = result.expirationDates?.[1] ?? result.expirationDates?.[0]
    if (!expiry) return []

    const expiryDate = new Date(expiry * 1000)
    const expiryStr = expiryDate.toISOString().split('T')[0]
    const daysToExpiry = Math.ceil((expiryDate.getTime() - Date.now()) / 86400000)

    const calls = (result.options?.[0]?.calls ?? []).slice(0, 10)
    const puts  = (result.options?.[0]?.puts  ?? []).slice(0, 10)

    const toContract = (o: Record<string, unknown>, type: 'call' | 'put'): OptionsContract => ({
      symbol: String(o.contractSymbol ?? ''),
      type,
      strike: Number(o.strike ?? 0),
      expiry: expiryStr,
      last: o.lastPrice ? Number(o.lastPrice) : null,
      bid: o.bid ? Number(o.bid) : null,
      ask: o.ask ? Number(o.ask) : null,
      volume: Number(o.volume ?? 0),
      openInterest: Number(o.openInterest ?? 0),
      iv: o.impliedVolatility ? Number(o.impliedVolatility) * 100 : null,
      delta: null, theta: null, gamma: null,
      daysToExpiry,
      moneyness: Math.abs(Number(o.strike ?? 0) - currentPrice) / currentPrice < 0.02
        ? 'ATM'
        : type === 'call'
          ? Number(o.strike ?? 0) < currentPrice ? 'ITM' : 'OTM'
          : Number(o.strike ?? 0) > currentPrice ? 'ITM' : 'OTM',
    })

    return [
      ...calls.map((o: Record<string, unknown>) => toContract(o, 'call')),
      ...puts.map((o: Record<string, unknown>) => toContract(o, 'put')),
    ]
  } catch { return [] }
}

async function fetchChain(ticker: string, expiry: string): Promise<OptionsContract[]> {
  try {
    const res = await fetch(
      `${TRADIER_BASE()}/markets/options/chains?symbol=${ticker}&expiration=${expiry}&greeks=true`,
      { headers: { 'Authorization': `Bearer ${TRADIER_KEY()}`, 'Accept': 'application/json' } }
    )
    if (!res.ok) return []
    const data = await res.json()
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

    // Fallback to Yahoo Finance if no Tradier data
    if (contracts.length === 0) {
      contracts = await fetchYahooOptions(ticker, currentPrice)
      if (contracts.length > 0) dataSource = 'Yahoo Finance'
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

Based on this analysis, provide a specific options recommendation in JSON only (no markdown):
{
  "strategy": "short name e.g. Buy Put Options",
  "strategyType": "long_call|long_put|covered_call|cash_secured_put|bull_call_spread|bear_put_spread|neutral",
  "rationale": "2-3 sentences explaining WHY this strategy fits the verdict in plain English. Reference the actual price target and time horizon.",
  "riskLevel": "high|medium|low",
  "maxLoss": "plain English description of worst case e.g. 'You lose the entire premium paid, which is $X per contract ($X total for 1 contract controlling 100 shares)'",
  "maxGain": "plain English description of best case with realistic numbers based on the price target",
  "idealFor": "who this strategy is suitable for e.g. 'Traders who believe the stock will drop significantly within 3 weeks and are comfortable losing 100% of their investment'",
  "timeHorizon": "specific recommendation e.g. 'Look for contracts expiring in 3-4 weeks'",
  "alternativeStrategy": "A safer/simpler alternative for more conservative traders",
  "beginnerWarning": "A clear, honest warning about options risk for someone who has never traded options. Mention that options can expire worthless.",
  "greeksExplained": "Explain what delta, theta, and IV mean for the specific contracts above in plain English. E.g. 'Delta of -0.40 means if the stock drops $1, your option gains about $40 per contract. Theta of -0.05 means you lose about $5 per contract per day just from time passing.'"
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
