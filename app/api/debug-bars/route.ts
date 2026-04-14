import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const ticker = (searchParams.get('ticker') || 'SOFI').toUpperCase()

  const headers = {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
  }

  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 420)
  const startStr = start.toISOString().split('T')[0]
  const endStr = end.toISOString().split('T')[0]

  let bars: { t: string; o: number; h: number; l: number; c: number; v: number }[] = []
  let feedUsed = 'none'
  for (const feed of ['sip', 'iex']) {
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Day&start=${startStr}&end=${endStr}&limit=300&adjustment=split&feed=${feed}`,
      { headers }
    )
    const data = await res.json()
    if (data.bars && data.bars.length >= 20) {
      bars = data.bars
      feedUsed = feed
      break
    }
  }

  if (!bars.length) return NextResponse.json({ error: 'no bars', raw: data })

  const closes = bars.map((b: { c: number }) => b.c)

  // Manual RSI calc
  function calcRSI(closes: number[], period = 14): number {
    if (closes.length < period + 1) return -1
    let gains = 0, losses = 0
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1]
      if (diff > 0) gains += diff; else losses -= diff
    }
    let avgGain = gains / period, avgLoss = losses / period
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1]
      avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period
      avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period
    }
    return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }

  // Manual SMA
  const sma = (arr: number[], n: number) =>
    arr.slice(-n).reduce((a, b) => a + b, 0) / Math.min(n, arr.length)

  // Manual Stochastic
  function calcStoch(bars: { h: number; l: number; c: number }[], k = 14) {
    if (bars.length < k) return { k: -1, d: -1 }
    const slice = bars.slice(-k)
    const high = Math.max(...slice.map(b => b.h))
    const low = Math.min(...slice.map(b => b.l))
    const close = bars[bars.length - 1].c
    const kVal = high === low ? 50 : ((close - low) / (high - low)) * 100
    return { k: kVal, d: kVal }
  }

  const rsi = calcRSI(closes)
  const sma50 = sma(closes, 50)
  const sma200 = sma(closes, 200)
  const stoch = calcStoch(bars)

  return NextResponse.json({
    ticker,
    barsReturned: bars.length,
    feedUsed,
    dateRange: { first: bars[0].t, last: bars[bars.length - 1].t },
    currentPrice: closes[closes.length - 1],
    rsi: rsi.toFixed(2),
    sma50: sma50.toFixed(2),
    sma200: sma200.toFixed(2),
    goldenCross: sma50 > sma200,
    stochK: stoch.k.toFixed(2),
    last5closes: closes.slice(-5).map((c: number) => c.toFixed(2)),
    note: bars.length < 200 ? `⚠ Only ${bars.length} bars returned — SMA200 inaccurate` : 'OK'
  })
}
