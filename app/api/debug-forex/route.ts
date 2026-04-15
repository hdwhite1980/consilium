import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const results: Record<string, unknown> = {}
  const finnhubKey = process.env.FINNHUB_API_KEY

  // Test 1: Finnhub quote with different forex symbol formats
  for (const sym of ['EURUSD', 'OANDA:EUR_USD', 'FX:EURUSD']) {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${finnhubKey}`, { cache: 'no-store' })
      const d = await res.json()
      results[`finnhub_${sym.replace(/[^A-Z0-9]/g,'_')}`] = { status: res.status, c: d.c, pc: d.pc, hasData: (d.c ?? 0) > 0 }
    } catch (e) { results[`finnhub_${sym}`] = { error: String(e) } }
  }

  // Test 2: Frankfurter (ECB data, truly free, no key required)
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD,GBP,JPY', { cache: 'no-store' })
    results.frankfurter_latest = { status: res.status, ok: res.ok, body: (await res.text()).slice(0, 400) }
  } catch (e) { results.frankfurter_latest = { error: String(e) } }

  // Test 3: Frankfurter historical bars (this is what we need for technicals)
  try {
    const end = new Date().toISOString().split('T')[0]
    const start = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0]
    const res = await fetch(`https://api.frankfurter.app/${start}..${end}?from=EUR&to=USD`, { cache: 'no-store' })
    const text = await res.text()
    results.frankfurter_history = { status: res.status, ok: res.ok, body: text.slice(0, 500) }
  } catch (e) { results.frankfurter_history = { error: String(e) } }

  // Test 4: ECB SDMX API (official, free, no key)
  try {
    const res = await fetch('https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=10&format=jsondata', { cache: 'no-store' })
    results.ecb_sdmx = { status: res.status, ok: res.ok, body: (await res.text()).slice(0, 400) }
  } catch (e) { results.ecb_sdmx = { error: String(e) } }

  // Test 5: Open Exchange Rates (free 1000 req/month, needs free key)
  try {
    const res = await fetch('https://openexchangerates.org/api/latest.json?app_id=freetest', { cache: 'no-store' })
    results.openexchangerates = { status: res.status, ok: res.ok, body: (await res.text()).slice(0, 200) }
  } catch (e) { results.openexchangerates = { error: String(e) } }

  return NextResponse.json(results, { status: 200 })
}
