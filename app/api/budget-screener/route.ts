import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import Anthropic from '@anthropic-ai/sdk'

const SECTOR_TICKERS: Record<string, { name: string; tickers: string[] }> = {
  XLK:  { name: 'Technology',       tickers: ['NVDA','MSFT','AAPL','META','GOOGL','AVGO','ORCL','AMD','ADBE','CRM','PLTR','ARM','SMCI','MU','ANET'] },
  XLV:  { name: 'Healthcare',       tickers: ['LLY','UNH','JNJ','ABBV','MRK','TMO','ABT','DHR','PFE','AMGN','ISRG','VRTX','REGN','BSX','MDT'] },
  XLF:  { name: 'Financials',       tickers: ['JPM','V','MA','BAC','GS','MS','WFC','BX','SPGI','AXP','COF','ICE','CME','PGR','MET'] },
  XLE:  { name: 'Energy',           tickers: ['XOM','CVX','COP','EOG','SLB','OXY','MPC','PSX','VLO','HES','DVN','FANG','HAL','BKR','TRGP'] },
  XLY:  { name: 'Consumer Disc.',   tickers: ['AMZN','TSLA','HD','MCD','NKE','LOW','SBUX','TJX','BKNG','CMG','ABNB','RCL','CCL','MGM','WYNN'] },
  XLP:  { name: 'Consumer Staples', tickers: ['WMT','PG','KO','COST','PEP','PM','MDLZ','CL','GIS','KMB','MO','STZ','KHC','HSY','CHD'] },
  XLI:  { name: 'Industrials',      tickers: ['GE','CAT','UPS','HON','UNP','BA','DE','LMT','RTX','ETN','EMR','PH','GD','NOC','CSX'] },
  XLB:  { name: 'Materials',        tickers: ['LIN','SHW','APD','ECL','FCX','NEM','NUE','VMC','MLM','CTVA','DOW','DD','PPG','ALB','CF'] },
  XLRE: { name: 'Real Estate',      tickers: ['PLD','AMT','EQIX','WELL','SPG','DLR','O','PSA','EXR','AVB','VTR','ARE','BXP','KIM','NNN'] },
  XLU:  { name: 'Utilities',        tickers: ['NEE','SO','DUK','SRE','AEP','D','PCG','EXC','XEL','WEC','AWK','ES','CNP','NI','AES'] },
  XLC:  { name: 'Comm. Services',   tickers: ['META','GOOGL','NFLX','DIS','CHTR','T','VZ','TMUS','EA','TTWO','WBD','PARA','FOX','OMC','IPG'] },
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { budget, type = 'stock', sector } = await req.json()
  if (!budget || budget <= 0) return NextResponse.json({ error: 'budget required' }, { status: 400 })

  const finnhubKey = process.env.FINNHUB_API_KEY
  if (!finnhubKey) return NextResponse.json({ error: 'No price data available' }, { status: 500 })

  // 1. Get the hottest sector from macro if none specified
  let targetSector = sector
  let sectorName = 'Top Sector'
  
  if (!targetSector) {
    try {
      const macroRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/macro`, {
        headers: { Cookie: req.headers.get('cookie') || '' }
      })
      if (macroRes.ok) {
        const macroData = await macroRes.json()
        const topSector = macroData?.sectors?.[0]
        if (topSector) {
          targetSector = topSector.etf
          sectorName = topSector.name
        }
      }
    } catch { /* fallback to XLK */ }
    if (!targetSector) { targetSector = 'XLK'; sectorName = 'Technology' }
  } else {
    sectorName = SECTOR_TICKERS[targetSector]?.name || targetSector
  }

  const tickers = SECTOR_TICKERS[targetSector]?.tickers || SECTOR_TICKERS.XLK.tickers

  // 2. Fetch live prices for all tickers in the sector
  const priceData: Array<{ ticker: string; price: number; change1D: number; prevClose: number }> = []

  for (const ticker of tickers) {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubKey}`)
      if (!res.ok) continue
      const q = await res.json()
      if (!q.c || q.c === 0) continue
      const change = q.dp && Math.abs(q.dp) > 0.001 ? q.dp : (q.pc > 0 ? (q.c - q.pc) / q.pc * 100 : 0)
      priceData.push({ ticker, price: q.c, change1D: parseFloat(change.toFixed(2)), prevClose: q.pc || q.c })
    } catch { /* skip */ }
    await new Promise(r => setTimeout(r, 60))
  }

  if (type === 'stock') {
    // Filter stocks within budget (per share)
    const affordable = priceData
      .filter(s => s.price <= budget)
      .sort((a, b) => b.change1D - a.change1D) // hottest movers first

    if (affordable.length === 0) {
      return NextResponse.json({
        ok: true,
        sector: sectorName,
        sectorEtf: targetSector,
        budget,
        type,
        suggestions: [],
        message: `No stocks in ${sectorName} are currently under $${budget}/share. The cheapest is $${Math.min(...priceData.map(p => p.price)).toFixed(2)}.`
      })
    }

    // Get AI analysis of the top suggestions
    const top10 = affordable.slice(0, 10)
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `A trader has $${budget} per share to spend. They want stocks in the ${sectorName} sector that are currently moving.

Here are the affordable options with today's price and % change:
${top10.map(s => `${s.ticker}: $${s.price.toFixed(2)} (${s.change1D >= 0 ? '+' : ''}${s.change1D}%)`).join('\n')}

Pick the 5-7 BEST setups from this list. For each, give:
1. Why it's a good setup right now (1 sentence — specific, data-driven)
2. Shares they can buy with their budget (budget / price, rounded down)
3. Risk level: low/medium/high

JSON only:
{
  "suggestions": [
    {
      "ticker": "NVDA",
      "price": 188.50,
      "change1D": 2.3,
      "shares": 5,
      "reason": "Breaking out above 50-day MA on AI chip demand news",
      "risk": "medium",
      "catalyst": "one word catalyst e.g. earnings/momentum/breakout/news"
    }
  ],
  "summary": "One sentence on why ${sectorName} is the place to be right now"
}`
      }]
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textBlock = msg.content.find((b: any) => b.type === 'text') as { text: string } | undefined
    const raw = textBlock?.text || ''
    const clean = raw.replace(/```json|```/g, '').trim()
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    const result = start !== -1 ? JSON.parse(clean.slice(start, end + 1)) : { suggestions: top10.slice(0, 7).map(s => ({ ticker: s.ticker, price: s.price, change1D: s.change1D, shares: Math.floor(budget / s.price), reason: 'Moving in hot sector', risk: 'medium', catalyst: 'momentum' })), summary: `${sectorName} is today's top sector` }

    return NextResponse.json({ ok: true, sector: sectorName, sectorEtf: targetSector, budget, type, ...result })
  }

  if (type === 'option') {
    // For options: budget is max premium per contract (per share cost × 100)
    // Find stocks where ATM options are likely within budget
    // Filter to stocks where 1 contract premium ≈ budget
    // Options premium is roughly 2-5% of stock price for near-term ATM
    const optionCandidates = priceData
      .filter(s => {
        const estPremium = s.price * 0.03 * 100 // rough 3% of stock price × 100 shares
        return estPremium <= budget * 1.5 // within 50% of budget
      })
      .sort((a, b) => b.change1D - a.change1D)
      .slice(0, 15)

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `A trader has $${budget} max to spend on ONE options contract (total cost including the ×100 multiplier) in the ${sectorName} sector.

Available stocks with today's prices and momentum:
${optionCandidates.map(s => `${s.ticker}: $${s.price.toFixed(2)} (${s.change1D >= 0 ? '+' : ''}${s.change1D}% today)`).join('\n')}

For a $${budget} total budget on one contract:
- A $${(budget/100).toFixed(2)} premium per share × 100 = $${budget} total
- Stocks under $${(budget / 100 / 0.03).toFixed(0)} tend to have options near this budget

Pick 5-7 best option setups. For each explain the specific play (call or put, approximate strike/expiry, why).

JSON only:
{
  "suggestions": [
    {
      "ticker": "AMD",
      "price": 95.20,
      "change1D": 1.8,
      "option_type": "call",
      "suggested_strike": "ATM $95",
      "suggested_expiry": "2 weeks out",
      "est_premium_per_share": 2.80,
      "est_total_cost": 280,
      "reason": "Momentum breakout with AI tailwinds, call buying surging",
      "risk": "medium",
      "catalyst": "momentum"
    }
  ],
  "summary": "One sentence on the options opportunity in ${sectorName} right now"
}`
      }]
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textBlock = msg.content.find((b: any) => b.type === 'text') as { text: string } | undefined
    const raw = textBlock?.text || ''
    const clean = raw.replace(/```json|```/g, '').trim()
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    const result = start !== -1 ? JSON.parse(clean.slice(start, end + 1)) : { suggestions: [], summary: `${sectorName} options analysis unavailable` }

    return NextResponse.json({ ok: true, sector: sectorName, sectorEtf: targetSector, budget, type, ...result })
  }

  return NextResponse.json({ error: 'type must be stock or option' }, { status: 400 })
}
