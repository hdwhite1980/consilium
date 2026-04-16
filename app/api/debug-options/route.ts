import { NextResponse } from 'next/server'

export async function GET() {
  const results: Record<string, unknown> = {}

  // Test Yahoo Finance direct fetch
  const yahooHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
  }

  for (const [label, url] of [
    ['yahoo_q1', 'https://query1.finance.yahoo.com/v7/finance/options/PEP'],
    ['yahoo_q2', 'https://query2.finance.yahoo.com/v7/finance/options/PEP'],
  ]) {
    try {
      const res = await fetch(url, { headers: yahooHeaders, cache: 'no-store' })
      results[label + '_status'] = res.status
      if (res.ok) {
        const data = await res.json()
        const opts = data?.optionChain?.result?.[0]?.options?.[0]
        results[label + '_puts_count'] = opts?.puts?.length ?? 0
        results[label + '_calls_count'] = opts?.calls?.length ?? 0
        results[label + '_sample_put'] = opts?.puts?.[0] ?? null
        results[label + '_expiries'] = data?.optionChain?.result?.[0]?.expirationDates?.slice(0,3) ?? []
      } else {
        results[label + '_body'] = await res.text()
      }
    } catch(e) {
      results[label + '_error'] = e instanceof Error ? e.message : String(e)
    }
  }

  // Test Tradier
  const tradierKey = process.env.TRADIER_API_KEY
  results['tradier_key_present'] = !!tradierKey
  if (tradierKey) {
    try {
      const res = await fetch('https://api.tradier.com/v1/markets/options/expirations?symbol=PEP', {
        headers: { 'Authorization': `Bearer ${tradierKey}`, 'Accept': 'application/json' }
      })
      results['tradier_status'] = res.status
      results['tradier_body'] = (await res.text()).slice(0, 200)
    } catch(e) {
      results['tradier_error'] = e instanceof Error ? e.message : String(e)
    }
  }

  return NextResponse.json(results)
}
