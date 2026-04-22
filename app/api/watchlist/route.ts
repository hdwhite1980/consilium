// ═════════════════════════════════════════════════════════════
// app/api/watchlist/route.ts
//
// GET  /api/watchlist             — returns user's full watchlist with
//                                   latest computed signal for each entry
// POST /api/watchlist             — adds a ticker to watchlist
//   body: { ticker: string, source?: 'manual'|'analyze'|'invest'|'movers', notes?: string }
// DELETE /api/watchlist?ticker=X  — removes a ticker from watchlist (or mutes it)
// PATCH /api/watchlist            — toggle mute / update notes
//   body: { ticker: string, muted?: boolean, notes?: string }
//
// Response for GET uses watchlist_with_signals view so each row already
// includes the latest signal + full technicals snapshot. The UI renders
// the indicator table directly from the jsonb column — no extra queries.
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ─────────────────────────────────────────────────────────────
// Types (shape returned to UI)
// ─────────────────────────────────────────────────────────────
export interface WatchlistRow {
  entryId: number
  ticker: string
  source: string
  addedAt: string
  muted: boolean
  notes: string | null

  // Exit evaluation (may be null if cron hasn't run yet)
  computedAt: string | null
  exitLevel: 'hold' | 'watch' | 'exit' | null
  exitConfidence: number | null
  exitReasons: string[] | null
  thesisStatus: 'intact' | 'weakening' | 'broken' | null

  // Price snapshot
  currentPrice: number | null
  priceChange1dPct: number | null
  priceChangeSinceVerdictPct: number | null

  // Technicals (full TechnicalSignals jsonb from watchlist_signals)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  technicals: any | null
  technicalBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null

  // Original verdict reference
  originalSignal: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null
  originalConfidence: number | null
}

interface WatchlistResponse {
  rows: WatchlistRow[]
  summary: {
    total: number
    holdCount: number
    watchCount: number
    exitCount: number
    pendingCount: number    // entries without a signal yet
    lastComputedAt: string | null
  }
}

// ═════════════════════════════════════════════════════════════
// GET /api/watchlist
// ═════════════════════════════════════════════════════════════
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const admin = getAdmin()
    const { data, error } = await admin
      .from('watchlist_with_signals')
      .select('*')
      .eq('user_id', user.id)
      .order('added_at', { ascending: false })
      .limit(200)

    if (error) {
      console.error('[watchlist/GET] query failed:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const rows: WatchlistRow[] = (data ?? []).map((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = r as any
      return {
        entryId: Number(row.entry_id),
        ticker: String(row.ticker ?? '').toUpperCase(),
        source: String(row.source ?? 'manual'),
        addedAt: String(row.added_at ?? ''),
        muted: Boolean(row.muted ?? false),
        notes: row.notes ?? null,
        computedAt: row.computed_at ?? null,
        exitLevel: row.exit_level ?? null,
        exitConfidence: row.exit_confidence !== null ? Number(row.exit_confidence) : null,
        exitReasons: Array.isArray(row.exit_reasons) ? row.exit_reasons : null,
        thesisStatus: row.exit_thesis_status ?? null,
        currentPrice: row.current_price !== null ? Number(row.current_price) : null,
        priceChange1dPct: row.price_change_1d_pct !== null ? Number(row.price_change_1d_pct) : null,
        priceChangeSinceVerdictPct: row.price_change_since_verdict_pct !== null
          ? Number(row.price_change_since_verdict_pct) : null,
        technicals: row.technicals ?? null,
        technicalBias: row.technical_bias ?? null,
        originalSignal: row.original_signal ?? null,
        originalConfidence: row.original_confidence !== null ? Number(row.original_confidence) : null,
      }
    })

    // Summary counts
    const holdCount = rows.filter(r => r.exitLevel === 'hold').length
    const watchCount = rows.filter(r => r.exitLevel === 'watch').length
    const exitCount = rows.filter(r => r.exitLevel === 'exit').length
    const pendingCount = rows.filter(r => r.exitLevel === null).length
    const lastComputedAt = rows
      .filter(r => r.computedAt)
      .map(r => r.computedAt as string)
      .sort()
      .slice(-1)[0] ?? null

    const response: WatchlistResponse = {
      rows,
      summary: {
        total: rows.length,
        holdCount,
        watchCount,
        exitCount,
        pendingCount,
        lastComputedAt,
      },
    }

    return NextResponse.json(response)
  } catch (e) {
    console.error('[watchlist/GET] error:', e)
    return NextResponse.json({
      error: (e as Error).message?.slice(0, 200) ?? 'unknown',
    }, { status: 500 })
  }
}

// ═════════════════════════════════════════════════════════════
// POST /api/watchlist — add a ticker
// ═════════════════════════════════════════════════════════════
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const rawTicker = String(body?.ticker ?? '').trim().toUpperCase()
    if (!rawTicker || !/^[A-Z0-9\-\.]{1,10}$/.test(rawTicker)) {
      return NextResponse.json({ error: 'Invalid ticker' }, { status: 400 })
    }

    const source = ['manual', 'analyze', 'invest', 'movers'].includes(body?.source)
      ? body.source : 'manual'
    const notes = typeof body?.notes === 'string' ? body.notes.slice(0, 500) : null

    const admin = getAdmin()

    // Try to look up user's latest verdict on this ticker to denormalize
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let latestVerdict: any = null
    try {
      const { data } = await admin
        .from('verdict_log')
        .select('id, signal, confidence, created_at')
        .eq('user_id', user.id)
        .eq('ticker', rawTicker)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      latestVerdict = data
    } catch { /* no verdict is fine */ }

    // Upsert: if ticker already in watchlist, unmute it and refresh
    const { data: upserted, error } = await admin
      .from('watchlist_entries')
      .upsert({
        user_id: user.id,
        ticker: rawTicker,
        source,
        notes,
        muted: false,
        latest_verdict_id: latestVerdict?.id ?? null,
        latest_verdict_signal: latestVerdict?.signal ?? null,
        latest_verdict_confidence: latestVerdict?.confidence ?? null,
        latest_verdict_at: latestVerdict?.created_at ?? null,
      }, { onConflict: 'user_id,ticker' })
      .select('id, ticker, source, muted')
      .single()

    if (error) {
      console.error('[watchlist/POST] upsert failed:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      entryId: upserted.id,
      ticker: upserted.ticker,
      source: upserted.source,
      muted: upserted.muted,
    })
  } catch (e) {
    console.error('[watchlist/POST] error:', e)
    return NextResponse.json({
      error: (e as Error).message?.slice(0, 200) ?? 'unknown',
    }, { status: 500 })
  }
}

// ═════════════════════════════════════════════════════════════
// DELETE /api/watchlist?ticker=X — remove or mute
// ═════════════════════════════════════════════════════════════
export async function DELETE(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const url = new URL(req.url)
    const ticker = String(url.searchParams.get('ticker') ?? '').trim().toUpperCase()
    const hardDelete = url.searchParams.get('hard') === 'true'

    if (!ticker) {
      return NextResponse.json({ error: 'ticker query param required' }, { status: 400 })
    }

    const admin = getAdmin()

    if (hardDelete) {
      const { error } = await admin
        .from('watchlist_entries')
        .delete()
        .eq('user_id', user.id)
        .eq('ticker', ticker)

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, deleted: true, ticker })
    } else {
      // Soft delete: mute instead
      const { error } = await admin
        .from('watchlist_entries')
        .update({ muted: true })
        .eq('user_id', user.id)
        .eq('ticker', ticker)

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, muted: true, ticker })
    }
  } catch (e) {
    return NextResponse.json({
      error: (e as Error).message?.slice(0, 200) ?? 'unknown',
    }, { status: 500 })
  }
}

// ═════════════════════════════════════════════════════════════
// PATCH /api/watchlist — toggle mute / update notes
// ═════════════════════════════════════════════════════════════
export async function PATCH(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const ticker = String(body?.ticker ?? '').trim().toUpperCase()
    if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: Record<string, any> = {}
    if (typeof body.muted === 'boolean') updates.muted = body.muted
    if (typeof body.notes === 'string') updates.notes = body.notes.slice(0, 500)

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
    }

    const admin = getAdmin()
    const { error } = await admin
      .from('watchlist_entries')
      .update(updates)
      .eq('user_id', user.id)
      .eq('ticker', ticker)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, ticker, updates })
  } catch (e) {
    return NextResponse.json({
      error: (e as Error).message?.slice(0, 200) ?? 'unknown',
    }, { status: 500 })
  }
}
