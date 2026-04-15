import { NextRequest } from 'next/server'
import { fetchQuote, fetchBars } from '@/app/lib/data/alpaca'

async function fetchFinnhubPrice(ticker: string): Promise<number | null> {
  try {
    const key = process.env.FINNHUB_API_KEY
    if (!key) return null
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${key}`,
      { next: { revalidate: 60 } }
    )
    if (!res.ok) return null
    const data = await res.json()
    return data.c > 0 ? data.c : null
  } catch { return null }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const ticker = searchParams.get('ticker')
  const timeframe = searchParams.get('timeframe') || '1W'

  if (!ticker) return Response.json({ error: 'ticker required' }, { status: 400 })

  const [quote, bars, finnhubPrice] = await Promise.all([
    fetchQuote(ticker.toUpperCase()).catch(() => null),
    fetchBars(ticker.toUpperCase(), timeframe).catch(() => []),
    fetchFinnhubPrice(ticker.toUpperCase()),
  ])

  // Best available price: Finnhub live > Alpaca mid > last bar close
  const alpacaMid = quote ? (quote.ap + quote.bp) / 2 : null
  const price = finnhubPrice ?? alpacaMid ?? (bars.length ? bars[bars.length - 1].c : null)

  return Response.json({ quote, bars, price })
}
