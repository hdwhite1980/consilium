import { NextResponse } from 'next/server'
import { createServerClient } from '@/app/lib/supabase'

// Sector ETFs with names
const SECTORS = [
  { etf: 'XLK', name: 'Technology',        emoji: '💻' },
  { etf: 'XLV', name: 'Healthcare',         emoji: '🏥' },
  { etf: 'XLF', name: 'Financials',         emoji: '🏦' },
  { etf: 'XLE', name: 'Energy',             emoji: '⚡' },
  { etf: 'XLY', name: 'Consumer Disc.',     emoji: '🛍' },
  { etf: 'XLP', name: 'Consumer Staples',   emoji: '🛒' },
  { etf: 'XLI', name: 'Industrials',        emoji: '🏭' },
  { etf: 'XLB', name: 'Materials',          emoji: '⛏' },
  { etf: 'XLRE','name': 'Real Estate',      emoji: '🏠' },
  { etf: 'XLU', name: 'Utilities',          emoji: '💡' },
  { etf: 'XLC', name: 'Comm. Services',     emoji: '📡' },
]

// Smart money / institutional flow ETFs
const SMART_MONEY = [
  { ticker: 'SPY',  name: 'S&P 500' },
  { ticker: 'QQQ',  name: 'Nasdaq 100' },
  { ticker: 'IWM',  name: 'Small Cap' },
  { ticker: 'GLD',  name: 'Gold' },
  { ticker: 'TLT',  name: 'Long Bonds' },
  { ticker: 'DXY',  name: 'Dollar (UUP)' },
]

const ALPACA_HEADERS = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
}
const FINNHUB_KEY = () => process.env.FINNHUB_API_KEY || ''

async function fetchQuotes(tickers: string[]): Promise<Record<string, { price: number; change1D: number; change5D: number; rsi: number | null }>> {
  const results: Record<string, { price: number; change1D: number; change5D: number; rsi: number | null }> = {}

  await Promise.all(tickers.map(async (ticker) => {
    try {
      // Get bars for RSI + multi-day changes
      const end = new Date().toISOString().split('T')[0]
      const start = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

      for (const feed of ['sip', 'iex']) {
        const res = await fetch(
          `https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&adjustment=all&feed=${feed}`,
          { headers: ALPACA_HEADERS }
        )
        if (!res.ok) continue
        const data = await res.json()
        const bars = data.bars ?? []
        if (bars.length < 2) continue

        const closes = bars.map((b: { c: number }) => b.c)
        const last = closes[closes.length - 1]
        const prev = closes[closes.length - 2]
        const week = closes[Math.max(0, closes.length - 6)]

        const change1D = ((last - prev) / prev) * 100
        const change5D = ((last - week) / week) * 100

        // RSI 14
        let rsi = null
        if (closes.length >= 15) {
          let gains = 0, losses = 0
          for (let i = 1; i <= 14; i++) {
            const d = closes[i] - closes[i-1]
            if (d > 0) gains += d; else losses -= d
          }
          let ag = gains/14, al = losses/14
          for (let i = 15; i < closes.length; i++) {
            const d = closes[i] - closes[i-1]
            ag = (ag*13 + Math.max(d,0)) / 14
            al = (al*13 + Math.max(-d,0)) / 14
          }
          rsi = Math.round(al === 0 ? 100 : 100 - 100/(1 + ag/al))
        }

        // Try Finnhub for live price
        let price = last
        try {
          const fhRes = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY()}`)
          if (fhRes.ok) {
            const q = await fhRes.json()
            if (q.c > 0) price = q.c
          }
        } catch { /* use bar close */ }

        results[ticker] = { price, change1D, change5D, rsi }
        break
      }
    } catch { /* skip */ }
  }))

  return results
}

function sectorSignal(change1D: number, change5D: number, rsi: number | null): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  let score = 0
  if (change1D > 0.5) score += 1
  else if (change1D < -0.5) score -= 1
  if (change5D > 2) score += 2
  else if (change5D < -2) score -= 2
  if (rsi !== null) {
    if (rsi > 60) score += 1
    else if (rsi < 40) score -= 1
  }
  return score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL'
}

export async function GET() {
  // Check cache — macro data cached for 30 minutes
  const supabase = createServerClient()
  const cacheKey = 'macro_dashboard'
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()

  const { data: cached } = await supabase
    .from('news_cache')
    .select('*')
    .eq('cache_key', cacheKey)
    .gte('created_at', cutoff)
    .single()

  if (cached?.content) {
    return NextResponse.json({ ...cached.content, cached: true })
  }

  // Fetch all sector and macro data in parallel
  const allTickers = [...SECTORS.map(s => s.etf), ...SMART_MONEY.map(s => s.ticker === 'DXY (UUP)' ? 'UUP' : s.ticker)]
  const quotes = await fetchQuotes(allTickers)

  // Build sector data
  const sectorData = SECTORS.map(s => {
    const q = quotes[s.etf]
    if (!q) return { ...s, price: 0, change1D: 0, change5D: 0, rsi: null, signal: 'NEUTRAL' as const }
    return {
      ...s,
      price: q.price,
      change1D: q.change1D,
      change5D: q.change5D,
      rsi: q.rsi,
      signal: sectorSignal(q.change1D, q.change5D, q.rsi),
    }
  }).sort((a, b) => b.change1D - a.change1D)

  // Build smart money flow data
  const smartMoneyData = SMART_MONEY.map(s => {
    const ticker = s.ticker === 'DXY (UUP)' ? 'UUP' : s.ticker
    const q = quotes[ticker]
    return {
      ...s,
      ticker,
      price: q?.price ?? 0,
      change1D: q?.change1D ?? 0,
      change5D: q?.change5D ?? 0,
      rsi: q?.rsi ?? null,
    }
  })

  // VIX level from VIXY
  const vix = quotes['TLT'] // use TLT as bond proxy
  const spy = quotes['SPY']
  const qqq = quotes['QQQ']

  // Market regime
  const spyRsi = spy?.rsi ?? 50
  const bullSectors = sectorData.filter(s => s.signal === 'BULLISH').length
  const bearSectors = sectorData.filter(s => s.signal === 'BEARISH').length

  let regime = 'NEUTRAL'
  let regimeColor = '#fbbf24'
  if (bullSectors >= 7 && spyRsi > 55) { regime = 'RISK ON'; regimeColor = '#34d399' }
  else if (bearSectors >= 7 || spyRsi < 40) { regime = 'RISK OFF'; regimeColor = '#f87171' }
  else if (bullSectors > bearSectors) { regime = 'CAUTIOUS BULLISH'; regimeColor = '#34d399' }
  else if (bearSectors > bullSectors) { regime = 'CAUTIOUS BEARISH'; regimeColor = '#f87171' }

  // Breadth
  const breadth = {
    bullish: bullSectors,
    neutral: sectorData.filter(s => s.signal === 'NEUTRAL').length,
    bearish: bearSectors,
    advancing: sectorData.filter(s => s.change1D > 0).length,
    declining: sectorData.filter(s => s.change1D < 0).length,
  }

  // Top movers
  const topSector  = sectorData[0]
  const worstSector = sectorData[sectorData.length - 1]

  const result = {
    timestamp: new Date().toISOString(),
    regime,
    regimeColor,
    breadth,
    topSector,
    worstSector,
    sectors: sectorData,
    smartMoney: smartMoneyData,
    spy: { price: spy?.price ?? 0, change1D: spy?.change1D ?? 0, change5D: spy?.change5D ?? 0, rsi: spy?.rsi ?? null },
    qqq: { price: qqq?.price ?? 0, change1D: qqq?.change1D ?? 0, change5D: qqq?.change5D ?? 0, rsi: qqq?.rsi ?? null },
    bonds: { price: vix?.price ?? 0, change1D: vix?.change1D ?? 0 },
  }

  // Cache the result
  await supabase.from('news_cache').upsert(
    { cache_key: cacheKey, content: result, created_at: new Date().toISOString() },
    { onConflict: 'cache_key' }
  )

  return NextResponse.json(result)
}
