import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get('ticker') ?? 'EURUSD'
  const results: Record<string, unknown> = {}

  const alpacaKey    = process.env.ALPACA_API_KEY
  const alpacaSecret = process.env.ALPACA_SECRET_KEY
  const finnhubKey   = process.env.FINNHUB_API_KEY
  const alpacaBase   = process.env.ALPACA_BASE_URL ?? 'https://data.alpaca.markets'

  results.env = {
    hasAlpacaKey: !!alpacaKey,
    hasAlpacaSecret: !!alpacaSecret,
    hasFinnhubKey: !!finnhubKey,
    alpacaBase,
  }

  // ── Test 1: Alpaca forex/bars ──────────────────────────────
  try {
    const symbol = 'EUR/USD'
    const end   = new Date().toISOString()
    const start = new Date(Date.now() - 14 * 86400000).toISOString()
    const url   = `${alpacaBase}/v1beta3/forex/bars?symbols=${encodeURIComponent(symbol)}&timeframe=1Day&start=${start}&end=${end}&limit=10&sort=asc`
    const res   = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': alpacaKey!, 'APCA-API-SECRET-KEY': alpacaSecret! },
      cache: 'no-store',
    })
    const text = await res.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { data = text.slice(0, 200) }
    results.alpaca_forex_bars = { status: res.status, ok: res.ok, data }
  } catch (e) { results.alpaca_forex_bars = { error: String(e) } }

  // ── Test 2: Alpaca latest forex rates ─────────────────────
  try {
    const url = `${alpacaBase}/v1beta3/forex/latest/rates?currency_pairs=EUR/USD`
    const res = await fetch(url, {
      headers: { 'APCA-API-KEY-ID': alpacaKey!, 'APCA-API-SECRET-KEY': alpacaSecret! },
      cache: 'no-store',
    })
    const text = await res.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { data = text.slice(0, 200) }
    results.alpaca_forex_rates = { status: res.status, ok: res.ok, data }
  } catch (e) { results.alpaca_forex_rates = { error: String(e) } }

  // ── Test 3: Finnhub forex/rates ───────────────────────────
  try {
    const url = `https://finnhub.io/api/v1/forex/rates?base=EUR&token=${finnhubKey}`
    const res = await fetch(url, { cache: 'no-store' })
    const text = await res.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { data = text.slice(0, 200) }
    results.finnhub_forex_rates = { status: res.status, ok: res.ok, data }
  } catch (e) { results.finnhub_forex_rates = { error: String(e) } }

  // ── Test 4: Finnhub forex/candle ─────────────────────────
  try {
    const to   = Math.floor(Date.now() / 1000)
    const from = to - 14 * 86400
    const url  = `https://finnhub.io/api/v1/forex/candle?symbol=OANDA:EUR_USD&resolution=D&from=${from}&to=${to}&token=${finnhubKey}`
    const res  = await fetch(url, { cache: 'no-store' })
    const text = await res.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { data = text.slice(0, 200) }
    results.finnhub_forex_candle = { status: res.status, ok: res.ok, data }
  } catch (e) { results.finnhub_forex_candle = { error: String(e) } }

  // ── Test 5: Finnhub forex/candle IC Markets ───────────────
  try {
    const to   = Math.floor(Date.now() / 1000)
    const from = to - 14 * 86400
    const url  = `https://finnhub.io/api/v1/forex/candle?symbol=IC%20MARKETS%3AEUR%2FUSD&resolution=D&from=${from}&to=${to}&token=${finnhubKey}`
    const res  = await fetch(url, { cache: 'no-store' })
    const text = await res.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { data = text.slice(0, 200) }
    results.finnhub_forex_candle_ic = { status: res.status, ok: res.ok, data }
  } catch (e) { results.finnhub_forex_candle_ic = { error: String(e) } }

  // ── Test 6: Finnhub supported forex symbols ───────────────
  try {
    const url = `https://finnhub.io/api/v1/forex/symbol?exchange=oanda&token=${finnhubKey}`
    const res = await fetch(url, { cache: 'no-store' })
    const text = await res.text()
    let data: unknown
    try {
      const arr = JSON.parse(text)
      // Just show first 5 matching EUR/USD
      data = Array.isArray(arr) ? arr.filter((s: {symbol: string}) => s.symbol?.includes('EUR')).slice(0, 5) : text.slice(0, 200)
    } catch { data = text.slice(0, 200) }
    results.finnhub_forex_symbols = { status: res.status, ok: res.ok, data }
  } catch (e) { results.finnhub_forex_symbols = { error: String(e) } }

  return NextResponse.json(results, { status: 200 })
}
