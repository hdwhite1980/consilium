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

// ── Fetch full technical snapshot from Finnhub ────────────────────────────────

interface TickerSnapshot {
  ticker: string
  price: number
  change1D: number
  prevClose: number
  high52w: number | null
  low52w: number | null
  pctFrom52wHigh: number | null
  volume: number | null
  avgVolume: number | null
  volumeRatio: number | null  // today vol / avg vol — spike detection
  rsi: number | null
  macdSignal: 'bullish' | 'bearish' | 'neutral'
  trend: 'above_sma50' | 'below_sma50' | 'unknown'
  earningsDate: string | null
  peRatio: number | null
}

async function fetchTickerSnapshot(ticker: string, finnhubKey: string): Promise<TickerSnapshot | null> {
  try {
    // Fetch quote, basic financials, and technicals in parallel
    const [quoteRes, metricsRes, candleRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/indicator?symbol=${ticker}&resolution=D&from=${Math.floor((Date.now() - 90 * 86400000) / 1000)}&to=${Math.floor(Date.now() / 1000)}&indicator=rsi&timeperiod=14&token=${finnhubKey}`),
    ])

    if (!quoteRes.ok) return null
    const quote = await quoteRes.json()
    if (!quote.c || quote.c === 0) return null

    const price = quote.c
    const prevClose = quote.pc || price
    const change1D = prevClose > 0 ? ((price - prevClose) / prevClose * 100) : (quote.dp || 0)

    // Basic financials
    let high52w = null, low52w = null, avgVolume = null, peRatio = null
    if (metricsRes.ok) {
      const metrics = await metricsRes.json()
      const m = metrics.metric || {}
      high52w = m['52WeekHigh'] || null
      low52w = m['52WeekLow'] || null
      avgVolume = m['10DayAverageTradingVolume'] ? m['10DayAverageTradingVolume'] * 1e6 : null
      peRatio = m['peNormalizedAnnual'] || m['peTTM'] || null
    }

    const pctFrom52wHigh = high52w ? parseFloat(((price - high52w) / high52w * 100).toFixed(1)) : null
    const currentVolume = quote.v || null
    const volumeRatio = (currentVolume && avgVolume && avgVolume > 0)
      ? parseFloat((currentVolume / avgVolume).toFixed(2))
      : null

    // RSI from candle indicator
    let rsi = null
    if (candleRes.ok) {
      const candles = await candleRes.json()
      const rsiArr = candles.rsi
      if (Array.isArray(rsiArr) && rsiArr.length > 0) {
        rsi = parseFloat(rsiArr[rsiArr.length - 1].toFixed(1))
      }
    }

    // MACD signal — derive from price momentum as fallback
    // Simple heuristic: change1D > 0 and RSI 45-65 = bullish momentum zone
    const macdSignal = rsi
      ? (rsi > 55 ? 'bullish' : rsi < 45 ? 'bearish' : 'neutral')
      : (change1D > 0.5 ? 'bullish' : change1D < -0.5 ? 'bearish' : 'neutral')

    // SMA50 trend — approximate from 52w high/low position
    const trend = pctFrom52wHigh !== null
      ? (pctFrom52wHigh > -15 ? 'above_sma50' : 'below_sma50')
      : 'unknown'

    return {
      ticker,
      price: parseFloat(price.toFixed(2)),
      change1D: parseFloat(change1D.toFixed(2)),
      prevClose: parseFloat(prevClose.toFixed(2)),
      high52w: high52w ? parseFloat(high52w.toFixed(2)) : null,
      low52w: low52w ? parseFloat(low52w.toFixed(2)) : null,
      pctFrom52wHigh,
      volume: currentVolume,
      avgVolume: avgVolume ? Math.round(avgVolume) : null,
      volumeRatio,
      rsi,
      macdSignal,
      trend,
      earningsDate: null, // could fetch separately
      peRatio: peRatio ? parseFloat(peRatio.toFixed(1)) : null,
    }
  } catch {
    return null
  }
}

// ── Format snapshot for Claude ────────────────────────────────────────────────

function formatSnapshotForClaude(s: TickerSnapshot): string {
  const parts = [
    `${s.ticker}: $${s.price} (${s.change1D >= 0 ? '+' : ''}${s.change1D}% today)`,
    s.rsi != null ? `RSI ${s.rsi}${s.rsi > 70 ? ' ⚠ overbought' : s.rsi < 30 ? ' ⭐ oversold' : ''}` : null,
    s.volumeRatio != null ? `Volume ${s.volumeRatio}x avg${s.volumeRatio > 2 ? ' 🔥 spike' : ''}` : null,
    s.pctFrom52wHigh != null ? `${s.pctFrom52wHigh}% from 52w high` : null,
    s.macdSignal !== 'neutral' ? `MACD ${s.macdSignal}` : null,
    s.trend === 'above_sma50' ? 'above SMA50 ✓' : s.trend === 'below_sma50' ? 'below SMA50 ✗' : null,
    s.peRatio ? `P/E ${s.peRatio}x` : null,
  ].filter(Boolean)
  return parts.join(' | ')
}

// ── Main route ────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { budget, type = 'stock', sector } = await req.json()
  if (!budget || budget <= 0) return NextResponse.json({ error: 'budget required' }, { status: 400 })

  const finnhubKey = process.env.FINNHUB_API_KEY
  if (!finnhubKey) return NextResponse.json({ error: 'No price data available' }, { status: 500 })

  // 1. Determine target sector
  let targetSector = sector
  let sectorName = 'Top Sector'
  let sectorChange = 0

  if (!targetSector) {
    try {
      const origin = process.env.NEXT_PUBLIC_APP_URL || 'https://wali-os.com'
      const macroRes = await fetch(`${origin}/api/macro`, {
        headers: { Cookie: req.headers.get('cookie') || '' }
      })
      if (macroRes.ok) {
        const macroData = await macroRes.json()
        const topSector = macroData?.sectors?.[0]
        if (topSector) {
          targetSector = topSector.etf
          sectorName = topSector.name
          sectorChange = topSector.change1D || 0
        }
      }
    } catch { /* fallback */ }
    if (!targetSector) { targetSector = 'XLK'; sectorName = 'Technology' }
  } else {
    sectorName = SECTOR_TICKERS[targetSector]?.name || targetSector
  }

  const tickers = SECTOR_TICKERS[targetSector]?.tickers || SECTOR_TICKERS.XLK.tickers

  // 2. Fetch full technical snapshots for all tickers (with rate limiting)
  const snapshots: TickerSnapshot[] = []
  for (const ticker of tickers) {
    const snap = await fetchTickerSnapshot(ticker, finnhubKey)
    if (snap) snapshots.push(snap)
    await new Promise(r => setTimeout(r, 120)) // ~8 req/s, under 10/s limit
  }

  if (snapshots.length === 0) {
    return NextResponse.json({ error: 'Could not fetch price data' }, { status: 500 })
  }

  // 3. Filter by budget
  let candidates: TickerSnapshot[]
  if (type === 'stock') {
    candidates = snapshots.filter(s => s.price <= budget)
  } else {
    // Options: filter where ATM premium likely fits budget
    // Estimate: premium ≈ 2-4% of stock price per 2-week contract
    candidates = snapshots.filter(s => {
      const estPremium = s.price * 0.03 * 100
      return estPremium <= budget * 1.8
    })
  }

  if (candidates.length === 0) {
    const cheapest = snapshots.sort((a, b) => a.price - b.price)[0]
    return NextResponse.json({
      ok: true,
      sector: sectorName,
      sectorEtf: targetSector,
      sectorChange,
      budget,
      type,
      suggestions: [],
      message: type === 'stock'
        ? `No stocks in ${sectorName} are under $${budget}/share. Cheapest is ${cheapest?.ticker} at $${cheapest?.price}.`
        : `No options in ${sectorName} fit a $${budget} contract budget. Try increasing your budget.`
    })
  }

  // 4. Score candidates — weighted ranking before Claude
  const scored = candidates.map(s => {
    let score = 0

    // Momentum (change1D)
    if (s.change1D > 3)        score += 30
    else if (s.change1D > 1)   score += 20
    else if (s.change1D > 0)   score += 10
    else if (s.change1D < -3)  score += 5 // potential reversal
    else                       score -= 10

    // Volume spike — strongest signal
    if (s.volumeRatio) {
      if (s.volumeRatio > 3)      score += 35
      else if (s.volumeRatio > 2) score += 25
      else if (s.volumeRatio > 1.5) score += 15
    }

    // RSI sweet spot (not overbought, not oversold)
    if (s.rsi) {
      if (s.rsi >= 50 && s.rsi <= 65) score += 20  // bullish momentum zone
      else if (s.rsi > 65 && s.rsi <= 70) score += 10 // getting hot
      else if (s.rsi > 70) score -= 10  // overbought risk
      else if (s.rsi < 30) score += 15  // oversold bounce potential
    }

    // Trend
    if (s.trend === 'above_sma50') score += 15
    else if (s.trend === 'below_sma50') score -= 10

    // Distance from 52w high — near high = strength
    if (s.pctFrom52wHigh !== null) {
      if (s.pctFrom52wHigh > -5)  score += 15  // near all-time high
      else if (s.pctFrom52wHigh > -15) score += 5
      else if (s.pctFrom52wHigh < -40) score -= 10 // deep in hole
    }

    return { ...s, score }
  }).sort((a, b) => b.score - a.score)

  // Take top 12 for Claude to pick from
  const top12 = scored.slice(0, 12)

  // 5. Claude picks best 5-7 with full context
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  const snapshotLines = top12.map(s => formatSnapshotForClaude(s)).join('\n')

  const stockPrompt = `You are a technical trading analyst. A trader has $${budget} per share to spend. 
The ${sectorName} sector is today's focus (ETF change: ${sectorChange >= 0 ? '+' : ''}${sectorChange.toFixed(1)}%).

Here are the top candidates with full technical data:
${snapshotLines}

Key signals explained:
- RSI >70 = overbought (caution), RSI <30 = oversold (bounce potential), RSI 50-65 = healthy momentum zone
- Volume spike (>2x avg) = institutional activity, confirms the move
- % from 52w high shows trend strength — near high = momentum, far below = potential value

Pick the 5-7 BEST setups. Prioritize: strong volume + RSI in healthy zone + uptrend. 
For each give a specific, data-backed reason citing the actual numbers.

JSON only — include ALL fields:
{
  "suggestions": [
    {
      "ticker": "NVDA",
      "price": 188.50,
      "change1D": 2.3,
      "shares": ${Math.floor(budget / (top12[0]?.price || 100))},
      "reason": "Volume 2.8x average with RSI 58 — institutional accumulation in momentum zone, 3% from 52w high",
      "risk": "medium",
      "catalyst": "momentum",
      "rsi": 58,
      "volume_ratio": 2.8,
      "signal_strength": "strong"
    }
  ],
  "summary": "One sentence on why ${sectorName} and these specific picks make sense right now"
}`

  const optionPrompt = `You are an options trading analyst. A trader has $${budget} max total per contract in ${sectorName}.

Candidates with full technical data:
${snapshotLines}

For a $${budget} contract budget: max premium = $${(budget / 100).toFixed(2)}/share.
Stocks with volume spikes + RSI momentum = ideal options candidates (confirms directional conviction).

Pick 5-7 best option setups. For each:
- Call if bullish momentum/breakout, Put if bearish breakdown
- ATM or slightly OTM for best risk/reward at this budget
- 1-3 week expiry for time balance

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
      "reason": "Volume 3.1x average, RSI 56 in bullish zone, breaking above SMA50",
      "risk": "medium",
      "catalyst": "breakout",
      "rsi": 56,
      "volume_ratio": 3.1,
      "signal_strength": "strong"
    }
  ],
  "summary": "One sentence on the options setup in ${sectorName}"
}`

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    messages: [{ role: 'user', content: type === 'stock' ? stockPrompt : optionPrompt }]
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textBlock = msg.content.find((b: any) => b.type === 'text') as { text: string } | undefined
  const raw = textBlock?.text || ''
  const clean = raw.replace(/```json|```/g, '').trim()
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')

  let result: any = { suggestions: [], summary: `${sectorName} analysis` }
  if (start !== -1) {
    try {
      result = JSON.parse(clean.slice(start, end + 1))
    } catch { /* use fallback */ }
  }

  // Merge actual snapshot data into suggestions (price/change always from live data)
  result.suggestions = (result.suggestions || []).map((s: any) => {
    const snap = snapshots.find(sn => sn.ticker === s.ticker)
    return snap ? { ...s, price: snap.price, change1D: snap.change1D, rsi: snap.rsi, volumeRatio: snap.volumeRatio } : s
  })

  return NextResponse.json({
    ok: true,
    sector: sectorName,
    sectorEtf: targetSector,
    sectorChange,
    budget,
    type,
    ...result
  })
}
