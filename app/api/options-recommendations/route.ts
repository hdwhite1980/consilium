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
              : strike > currentPrice ? 'ITM' : 'OTM' as 'ITM' | 'ATM' | 'OTM',
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


// Yahoo Finance fallback — no API key, always available
async function fetchYahooOptions(ticker: string, currentPrice: number): Promise<OptionsContract[]> {
  // Try multiple Yahoo endpoints with realistic browser headers
  const endpoints = [
    `https://query1.finance.yahoo.com/v7/finance/options/${ticker}`,
    `https://query2.finance.yahoo.com/v7/finance/options/${ticker}`,
  ]
  const yahooHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
  }
  try {
    let res: Response | null = null
    for (const url of endpoints) {
      try {
        res = await fetch(url, { headers: yahooHeaders, cache: 'no-store' })
        if (res.ok) break
        console.log(`Yahoo ${url} returned ${res.status}`)
      } catch { continue }
    }
    if (!res?.ok) return []
    const data = await res.json()
    const result = data?.optionChain?.result?.[0]
    if (!result) return []

    const expiryTs = result.expirationDates?.[0]
    if (!expiryTs) return []
    const expiryDate = new Date(expiryTs * 1000)
    const expiryStr = expiryDate.toISOString().split('T')[0]
    const daysToExpiry = Math.ceil((expiryDate.getTime() - Date.now()) / 86400000)

    const toContract = (raw: Record<string, unknown>, type: 'call' | 'put'): OptionsContract | null => {
      try {
        const strike = Number(raw.strike)
        const bid = Number(raw.bid ?? 0)
        const ask = Number(raw.ask ?? 0)
        const last = Number(raw.lastPrice ?? 0)
        const volume = Number(raw.volume ?? 0)
        const oi = Number(raw.openInterest ?? 0)
        const iv = Number(raw.impliedVolatility ?? 0) * 100
        if (!strike || (!bid && !ask && !last)) return null
        const moneyness = Math.abs(strike - currentPrice) / currentPrice < 0.03
          ? 'ATM'
          : type === 'call'
            ? strike < currentPrice ? 'ITM' : 'OTM'
            : strike > currentPrice ? 'ITM' : 'OTM'
        return {
          symbol: String(raw.contractSymbol ?? ''),
          type,
          strike,
          expiry: expiryStr,
          last: last || null,
          bid: bid || null,
          ask: ask || null,
          volume,
          openInterest: oi,
          iv: iv || null,
          delta: null, // Yahoo doesn't provide Greeks
          theta: null,
          gamma: null,
          daysToExpiry,
          moneyness,
        }
      } catch { return null }
    }

    const calls = (result.options?.[0]?.calls ?? [])
      .map((c: Record<string, unknown>) => toContract(c, 'call'))
      .filter((c: OptionsContract | null): c is OptionsContract => c !== null)

    const puts = (result.options?.[0]?.puts ?? [])
      .map((p: Record<string, unknown>) => toContract(p, 'put'))
      .filter((p: OptionsContract | null): p is OptionsContract => p !== null)

    const all = [...calls, ...puts].filter(c =>
      c.volume > 0 &&
      Math.abs(c.strike - currentPrice) / currentPrice < 0.15 // within 15% of current price
    )
    console.log(`Yahoo options: ${all.length} contracts for ${ticker}`)
    return all
  } catch (e) {
    console.error('Yahoo options exception:', e)
    return []
  }
}


// Gemini web search — pulls live options data from Yahoo Finance
async function fetchOptionsViaGemini(
  ticker: string,
  currentPrice: number,
  signal: string,
  targetPrice: string,
  timeHorizon: string
): Promise<OptionsContract[]> {
  const geminiKey = process.env.GEMINI_API_KEY
  if (!geminiKey) return []

  try {
    const genAI = new GoogleGenerativeAI(geminiKey)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearch: {} } as never],
    })

    const optionType = signal === 'BEARISH' ? 'put' : 'call'
    const prompt = `Search Yahoo Finance options for ${ticker} right now.

Current price: $${currentPrice}
Council verdict: ${signal}
Target: ${targetPrice}
Time horizon: ${timeHorizon}

I need the ${optionType} options chain for ${ticker} from Yahoo Finance (finance.yahoo.com/quote/${ticker}/options).

Return ONLY a JSON array of the 4-6 most liquid ${optionType} contracts near the money. No markdown, no backticks, just raw JSON:
[
  {
    "type": "${optionType}",
    "strike": 150,
    "expiry": "2025-05-16",
    "bid": 2.35,
    "ask": 2.45,
    "last": 2.40,
    "volume": 1250,
    "openInterest": 4500,
    "iv": 28.5,
    "delta": -0.45,
    "theta": -0.08,
    "daysToExpiry": 21
  }
]

Only include contracts with volume > 100 and expiring in 7-60 days. Use real data from Yahoo Finance.`

    const result = await model.generateContent(prompt)
    const text = result.response.text().trim()

    // Parse JSON from response
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) {
      console.log('Gemini options response (no JSON found):', text.slice(0, 300))
      return []
    }

    const raw = JSON.parse(jsonMatch[0])
    if (!Array.isArray(raw) || raw.length === 0) return []

    return raw.map((c: Record<string, unknown>) => ({
      symbol: `${ticker}${c.expiry?.toString().replace(/-/g, '').slice(2)}${c.type === 'call' ? 'C' : 'P'}${String(Math.round(Number(c.strike) * 1000)).padStart(8, '0')}`,
      type: (c.type === 'put' ? 'put' : 'call') as 'call' | 'put',
      strike: Number(c.strike),
      expiry: String(c.expiry ?? ''),
      last: c.last ? Number(c.last) : null,
      bid: c.bid ? Number(c.bid) : null,
      ask: c.ask ? Number(c.ask) : null,
      volume: Number(c.volume ?? 0),
      openInterest: Number(c.openInterest ?? 0),
      iv: c.iv ? Number(c.iv) : null,
      delta: c.delta ? Number(c.delta) : null,
      theta: c.theta ? Number(c.theta) : null,
      gamma: null,
      daysToExpiry: Number(c.daysToExpiry ?? 30),
      moneyness: Math.abs(Number(c.strike) - currentPrice) / currentPrice < 0.03
        ? 'ATM'
        : c.type === 'call'
          ? Number(c.strike) < currentPrice ? 'ITM' : 'OTM'
          : Number(c.strike) > currentPrice ? 'ITM' : 'OTM' as 'ITM' | 'ATM' | 'OTM',
    })).filter(c => c.strike > 0 && c.daysToExpiry > 0)
  } catch (e) {
    console.error('Gemini options exception:', e)
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
        : c.strike > currentPrice ? 'ITM' : 'OTM' as 'ITM' | 'ATM' | 'OTM',
  }))
}

function selectBestContracts(
  contracts: OptionsContract[],
  signal: string,
  currentPrice: number,
  timeHorizon: string
): OptionsContract[] {
  // Determine target DTE based on time horizon
  const targetDTE = timeHorizon.includes('week') ? 14
    : timeHorizon.includes('month') ? 30
    : timeHorizon.includes('2-3') ? 21
    : 30

  const scoreContract = (c: OptionsContract) =>
    (c.moneyness === 'ATM' ? 10 : c.moneyness === 'OTM' ? 5 : 2) +
    Math.min(c.volume / 100, 5)

  const baseFilter = (c: OptionsContract) =>
    c.bid !== null && c.bid > 0 &&
    c.daysToExpiry >= targetDTE - 7 &&
    c.daysToExpiry <= targetDTE + 21 &&
    c.volume > 0

  if (signal === 'BULLISH') {
    return contracts
      .filter(c => c.type === 'call' && baseFilter(c))
      .sort((a, b) => scoreContract(b) - scoreContract(a))
      .slice(0, 3)
  }

  if (signal === 'BEARISH') {
    return contracts
      .filter(c => c.type === 'put' && baseFilter(c))
      .sort((a, b) => scoreContract(b) - scoreContract(a))
      .slice(0, 3)
  }

  // NEUTRAL — show 2 ATM/near-ATM calls and 2 puts so user can see the market
  // These are for reference/education, not a directional recommendation
  const calls = contracts
    .filter(c => c.type === 'call' && baseFilter(c))
    .sort((a, b) => scoreContract(b) - scoreContract(a))
    .slice(0, 2)
  const puts = contracts
    .filter(c => c.type === 'put' && baseFilter(c))
    .sort((a, b) => scoreContract(b) - scoreContract(a))
    .slice(0, 2)
  return [...calls, ...puts]
}

export async function POST(req: NextRequest) {
  try {
    const { ticker, currentPrice, signal, timeHorizon, target, technicals, verdict } = await req.json()

    // ── Fetch options chain ───────────────────────────────────
    let contracts: OptionsContract[] = []
    let expiriesUsed: string[] = []
    let dataSource = 'none'

    // Primary: Tradier — confirmed working in production
    if (TRADIER_KEY()) {
      const expiries = await fetchExpirations(ticker)
      console.log(`Tradier expiries for ${ticker}:`, expiries.slice(0, 4))
      const targetExpiries = expiries.slice(0, 4)
      expiriesUsed = targetExpiries
      const chains = await Promise.all(targetExpiries.map(exp => fetchChain(ticker, exp)))
      const allContracts = chains.flat()
      console.log(`Tradier raw contracts for ${ticker}:`, allContracts.length)
      contracts = labelMoneyness(allContracts, currentPrice)
      if (contracts.length > 0) dataSource = 'Tradier'
    }

    // Fallback: Alpaca options
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
