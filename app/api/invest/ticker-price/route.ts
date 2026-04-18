import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const ticker = req.nextUrl.searchParams.get('ticker')?.toUpperCase()
  if (!ticker) return NextResponse.json({ error: 'ticker is required' }, { status: 400 })

  const key = process.env.FINNHUB_API_KEY
  if (!key) return NextResponse.json({ price: null })

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${key}`,
      { cache: 'no-store' }
    )
    if (!res.ok) return NextResponse.json({ price: null })
    const q = await res.json()
    return NextResponse.json({
      ticker,
      price: (q.c && q.c > 0) ? Number(q.c) : null,
      dayChange: q.d ?? null,
      dayChangePct: q.dp ?? null,
      dayHigh: q.h ?? null,
      dayLow: q.l ?? null,
    })
  } catch {
    return NextResponse.json({ price: null })
  }
}
