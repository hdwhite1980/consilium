// =============================================================
// app/api/auto-trader/dashboard/reentry-watch/route.ts
//
// GET → the calling user's re-entry watch list.
//
// Returns the tickers the position monitor has EXITED that remain eligible
// for automated re-entry (status='watching'), plus recently exhausted ones,
// with side, re-entry count, exit price, and exit time.
//
// Used by the dashboard's "Re-entry Watch" panel.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_REENTRIES = 2          // mirrors position-monitor; informational only here
const WINDOW_DAYS = 7

interface ReentryWatchRow {
  id: string
  ticker: string
  side: string
  asset_class: string | null
  original_entry: number | null
  original_stop: number | null
  exit_price: number | null
  exit_at: string
  reentry_count: number
  status: string
  last_reentry_at: string | null
}

interface ReentryWatchItem {
  ticker: string
  side: 'buy' | 'sell'
  direction: 'long' | 'short'
  reentryCount: number
  maxReentries: number
  exitPrice: number | null
  exitAt: string
  status: string
  lastReentryAt: string | null
}

interface ReentryWatchData {
  ok: boolean
  watching: ReentryWatchItem[]
  exhausted: ReentryWatchItem[]
  error?: string
}

export async function GET(_req: NextRequest): Promise<NextResponse<ReentryWatchData>> {
  let userId: string | null = null
  try {
    const supa = await createClient()
    const { data: { user } } = await supa.auth.getUser()
    userId = user?.id ?? null
  } catch {
    // fall through; if userId still null we 401
  }
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: 'Unauthorized', watching: [], exhausted: [] },
      { status: 401 },
    )
  }

  try {
    const admin = await getSupabaseAdmin()
    const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()

    const { data, error } = await admin
      .from('reentry_watch')
      .select('id, ticker, side, asset_class, original_entry, original_stop, exit_price, exit_at, reentry_count, status, last_reentry_at')
      .eq('user_id', userId)
      .in('status', ['watching', 'exhausted'])
      .gte('exit_at', cutoff)
      .order('exit_at', { ascending: false })
      .limit(50)

    if (error) {
      console.warn('[dashboard/reentry-watch] query failed:', error.message)
      return NextResponse.json({ ok: false, error: error.message, watching: [], exhausted: [] })
    }

    const rows = (data ?? []) as ReentryWatchRow[]
    const toItem = (r: ReentryWatchRow): ReentryWatchItem => {
      const side = r.side === 'sell' ? 'sell' : 'buy'
      return {
        ticker: r.ticker.toUpperCase(),
        side,
        direction: side === 'buy' ? 'long' : 'short',
        reentryCount: Number(r.reentry_count) || 0,
        maxReentries: MAX_REENTRIES,
        exitPrice: r.exit_price !== null ? Number(r.exit_price) : null,
        exitAt: r.exit_at,
        status: r.status,
        lastReentryAt: r.last_reentry_at,
      }
    }

    const watching = rows.filter(r => r.status === 'watching').map(toItem)
    const exhausted = rows.filter(r => r.status === 'exhausted').map(toItem)

    return NextResponse.json({ ok: true, watching, exhausted })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[dashboard/reentry-watch] error:', msg)
    return NextResponse.json({ ok: false, error: msg, watching: [], exhausted: [] })
  }
}
