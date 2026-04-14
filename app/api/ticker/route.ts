import { NextRequest } from 'next/server'
import { fetchQuote, fetchBars } from '@/app/lib/data/alpaca'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const ticker = searchParams.get('ticker')
  const timeframe = searchParams.get('timeframe') || '1W'

  if (!ticker) return Response.json({ error: 'ticker required' }, { status: 400 })

  const [quote, bars] = await Promise.all([
    fetchQuote(ticker.toUpperCase()).catch(() => null),
    fetchBars(ticker.toUpperCase(), timeframe).catch(() => []),
  ])

  return Response.json({ quote, bars })
}
