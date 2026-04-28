// =============================================================
// app/api/extended-hours/route.ts
//
// GET /api/extended-hours?ticker=NVDA
//
// Returns extended-hours context: current market status,
// latest price, regular/previous closes, and the AH/PM move
// (if any) with quality assessment.
//
// Used for:
//   1. UI display on /analyze page
//   2. Debugging extended-hours data quality
//   3. Future: pre-market dashboard widget
//
// Auth-gated. Pure read endpoint — no DB writes, no AI calls.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { getExtendedHoursContext } from '@/app/lib/data/extended-hours'

export const runtime = 'nodejs'
export const maxDuration = 10

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
    if (!/^[A-Z]{1,6}$/.test(ticker)) {
      return NextResponse.json({ error: 'invalid ticker format' }, { status: 400 })
    }

    const ctx = await getExtendedHoursContext(ticker)

    return NextResponse.json(ctx, {
      headers: {
        'Cache-Control': 'private, max-age=60',
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[extended-hours] Error:', msg)
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 })
  }
}
