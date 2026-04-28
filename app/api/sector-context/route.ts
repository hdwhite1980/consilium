// =============================================================
// app/api/sector-context/route.ts
//
// GET /api/sector-context?ticker=NVDA
//
// Returns the SectorContext for a ticker:
//   - Sector classification + ETF
//   - Sector ETF 1D / 5D performance
//   - Top 3 peer 1D performance
//   - Single-name divergence flag
//   - Prompt-ready string
//
// Auth-gated. Lazy-fetches + caches sector classification on
// first lookup; subsequent lookups within 30 days hit cache.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { getSectorContext } from '@/app/lib/data/sector-context'

export const runtime = 'nodejs'
export const maxDuration = 15

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const url = new URL(req.url)
    const ticker = (url.searchParams.get('ticker') ?? '').trim().toUpperCase()

    if (!ticker) {
      return NextResponse.json({ error: 'ticker required' }, { status: 400 })
    }
    if (!/^[A-Z.\-]{1,8}$/.test(ticker)) {
      return NextResponse.json({ error: 'invalid ticker format' }, { status: 400 })
    }

    const ctx = await getSectorContext(ticker)

    return NextResponse.json(ctx, {
      headers: {
        // Cache miss is expensive (Finnhub fetch); cache hit is cheap.
        // Set short browser cache so repeated UI hits don't hammer.
        'Cache-Control': 'private, max-age=120',
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[sector-context] Error:', msg)
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 })
  }
}
