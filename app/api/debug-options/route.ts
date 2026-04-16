import { NextResponse } from 'next/server'

export async function GET() {
  const results: Record<string, unknown> = {}
  const tradierKey = process.env.TRADIER_API_KEY
  const base = 'https://api.tradier.com/v1'
  const headers = { 'Authorization': `Bearer ${tradierKey}`, 'Accept': 'application/json' }

  results['tradier_key_present'] = !!tradierKey

  // Step 1: expirations
  try {
    const r = await fetch(`${base}/markets/options/expirations?symbol=PEP&includeAllRoots=true`, { headers })
    results['expirations_status'] = r.status
    const d = await r.json()
    const dates = d?.expirations?.date ?? []
    results['expiration_dates'] = Array.isArray(dates) ? dates.slice(0, 6) : [dates].slice(0, 6)
  } catch(e) { results['expirations_error'] = String(e) }

  // Step 2: chain for nearest expiry
  const expiries = results['expiration_dates'] as string[] | undefined
  const firstExpiry = expiries?.[1] // skip today's, use next week
  if (firstExpiry) {
    try {
      const r = await fetch(`${base}/markets/options/chains?symbol=PEP&expiration=${firstExpiry}&greeks=true`, { headers })
      results['chain_status'] = r.status
      const d = await r.json()
      const opts = d?.options?.option ?? []
      const arr = Array.isArray(opts) ? opts : [opts]
      results['chain_total_contracts'] = arr.length
      // Find a near-the-money put
      const puts = arr.filter((o: Record<string, unknown>) => o.option_type === 'put')
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) => 
          Math.abs(Number(a.strike) - 155) - Math.abs(Number(b.strike) - 155)
        ).slice(0, 2)
      results['sample_puts'] = puts.map((o: Record<string, unknown>) => ({
        symbol: o.symbol,
        strike: o.strike,
        bid: o.bid,
        ask: o.ask,
        volume: o.volume,
        greeks: o.greeks,
      }))
    } catch(e) { results['chain_error'] = String(e) }
  }

  return NextResponse.json(results)
}
