import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import {
  refreshLegislativeIntelligence,
  getRecentHighImpactEvents,
  getLegislativeEventsForTicker,
  getCongressionalTradesForTicker,
  fetchCongressionalTrades,
} from '@/app/lib/data/legislative'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const ticker = searchParams.get('ticker')?.toUpperCase()

  if (ticker) {
    const [events, trades] = await Promise.all([
      getLegislativeEventsForTicker(ticker),
      getCongressionalTradesForTicker(ticker),
    ])
    return NextResponse.json({ ticker, events, trades })
  }

  // Return recent high-impact events for dashboard
  const events = await getRecentHighImpactEvents(20)
  return NextResponse.json({ events })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { action, ticker } = await req.json()

  if (action === 'refresh') {
    refreshLegislativeIntelligence().catch(console.error)
    return NextResponse.json({ ok: true, message: 'Legislative intelligence refresh started' })
  }

  if (action === 'trades' && ticker) {
    fetchCongressionalTrades(ticker).catch(console.error)
    return NextResponse.json({ ok: true, message: `Fetching trades for ${ticker}` })
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
