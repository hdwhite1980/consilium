// ═════════════════════════════════════════════════════════════
// app/api/watchlist/route.ts
//
// GET  /api/watchlist                      — returns all entries (stocks + options)
//                                            with latest computed signal
// POST /api/watchlist                      — add a stock OR option to watchlist
//   stock body:  { ticker, source? }
//   option body: { ticker, assetType: 'option', optionSymbol, optionType, strike,
//                  expiration, premiumAtAdd?, deltaAtAdd?, ivAtAdd?, source? }
// DELETE /api/watchlist?ticker=X            — remove a stock (or mute)
// DELETE /api/watchlist?optionSymbol=X      — remove an option (or mute)
// PATCH  /api/watchlist                     — toggle mute / update notes
//   body: { ticker OR optionSymbol, muted?, notes? }
//
// Option fields are null on stock rows and populated on option rows.
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
  assetType: 'stock' | 'option'
  source: string
  addedAt: string
  muted: boolean
  notes: string | null

  // Option identity (null for stock entries)
  optionSymbol: string | null
  optionType: 'call' | 'put' | null
  strike: number | null
  expiration: string | null
  premiumAtAdd: number | null
  deltaAtAdd: number | null
  ivAtAdd: number | null

  // Exit evaluation (may be null if cron hasn't run yet)
  computedAt: string | null
  exitLevel: 'hold' | 'watch' | 'exit' | null
  exitConfidence: number | null
  exitReasons: string[] | null
  thesisStatus: 'intact' | 'weakening' | 'broken' | null

  // Price snapshot (both stock and option; for options this is the underlying)
  currentPrice: number | null
  priceChange1dPct: number | null
  priceChangeSinceVerdictPct: number | null

  // Technicals (full TechnicalSignals jsonb) — populated for both types
  // For options, shows underlying stock technicals
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  technicals: any | null
  technicalBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null

  // Original verdict reference (for underlying if option)
  originalSignal: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null
  originalConfidence: number | null

  // Option-specific current state (null for stock rows)
  currentPremium: number | null
  currentDelta: number | null
  currentGamma: number | null
  currentTheta: number | null
  currentVega: number | null
  currentIv: number | null
  currentBid: number | null
  currentAsk: number | null
  currentVolume: number | null
  currentOpenInterest: number | null
  dte: number | null
  moneyness: 'ITM' | 'ATM' | 'OTM' | null
  moneynessPct: number | null
  ivChangePct: number | null
  premiumChangePct: number | null
  breakeven: number | null
}

interface WatchlistResponse {
  rows: WatchlistRow[]
  summary: {
    total: number
    stockCount: number
    optionCount: number
    holdCount: number
    watchCount: number
    exitCount: number
    pendingCount: number
    lastComputedAt: string | null
  }
}

// Helper to safely cast view row to a typed shape
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapViewRowToWatchlistRow(r: any): WatchlistRow {
  return {
    entryId: Number(r.entry_id),
    ticker: String(r.ticker ?? '').toUpperCase(),
    assetType: (r.asset_type ?? 'stock') as 'stock' | 'option',
    source: String(r.source ?? 'manual'),
    addedAt: String(r.added_at ?? ''),
    muted: Boolean(r.muted ?? false),
    notes: r.notes ?? null,

    optionSymbol: r.option_symbol ?? null,
    optionType: r.option_type ?? null,
    strike: r.strike !== null && r.strike !== undefined ? Number(r.strike) : null,
    expiration: r.expiration ?? null,
    premiumAtAdd: r.premium_at_add !== null && r.premium_at_add !== undefined ? Number(r.premium_at_add) : null,
    deltaAtAdd: r.delta_at_add !== null && r.delta_at_add !== undefined ? Number(r.delta_at_add) : null,
    ivAtAdd: r.iv_at_add !== null && r.iv_at_add !== undefined ? Number(r.iv_at_add) : null,

    computedAt: r.computed_at ?? null,
    exitLevel: r.exit_level ?? null,
    exitConfidence: r.exit_confidence !== null && r.exit_confidence !== undefined ? Number(r.exit_confidence) : null,
    exitReasons: Array.isArray(r.exit_reasons) ? r.exit_reasons : null,
    thesisStatus: r.exit_thesis_status ?? null,

    currentPrice: r.current_price !== null && r.current_price !== undefined ? Number(r.current_price) : null,
    priceChange1dPct: r.price_change_1d_pct !== null && r.price_change_1d_pct !== undefined ? Number(r.price_change_1d_pct) : null,
    priceChangeSinceVerdictPct: r.price_change_since_verdict_pct !== null && r.price_change_since_verdict_pct !== undefined ? Number(r.price_change_since_verdict_pct) : null,

    technicals: r.technicals ?? null,
    technicalBias: r.technical_bias ?? null,

    originalSignal: r.original_signal ?? null,
    originalConfidence: r.original_confidence !== null && r.original_confidence !== undefined ? Number(r.original_confidence) : null,

    currentPremium: r.current_premium !== null && r.current_premium !== undefined ? Number(r.current_premium) : null,
    currentDelta: r.current_delta !== null && r.current_delta !== undefined ? Number(r.current_delta) : null,
    currentGamma: r.current_gamma !== null && r.current_gamma !== undefined ? Number(r.current_gamma) : null,
    currentTheta: r.current_theta !== null && r.current_theta !== undefined ? Number(r.current_theta) : null,
    currentVega: r.current_vega !== null && r.current_vega !== undefined ? Number(r.current_vega) : null,
    currentIv: r.current_iv !== null && r.current_iv !== undefined ? Number(r.current_iv) : null,
    currentBid: r.current_bid !== null && r.current_bid !== undefined ? Number(r.current_bid) : null,
    currentAsk: r.current_ask !== null && r.current_ask !== undefined ? Number(r.current_ask) : null,
    currentVolume: r.current_volume !== null && r.current_volume !== undefined ? Number(r.current_volume) : null,
    currentOpenInterest: r.current_open_interest !== null && r.current_open_interest !== undefined ? Number(r.current_open_interest) : null,
    dte: r.dte !== null && r.dte !== undefined ? Number(r.dte) : null,
    moneyness: r.moneyness ?? null,
    moneynessPct: r.moneyness_pct !== null && r.moneyness_pct !== undefined ? Number(r.moneyness_pct) : null,
    ivChangePct: r.iv_change_pct !== null && r.iv_change_pct !== undefined ? Number(r.iv_change_pct) : null,
    premiumChangePct: r.premium_change_pct !== null && r.premium_change_pct !== undefined ? Number(r.premium_change_pct) : null,
    breakeven: r.breakeven !== null && r.breakeven !== undefined ? Number(r.breakeven) : null,
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: WatchlistRow[] = (data ?? []).map((r: any) => mapViewRowToWatchlistRow(r))

    const stockCount = rows.filter(r => r.assetType === 'stock').length
    const optionCount = rows.filter(r => r.assetType === 'option').length
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
        stockCount,
        optionCount,
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
// POST /api/watchlist — add stock OR option
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

    const assetType = body?.assetType === 'option' ? 'option' : 'stock'
    const source = ['manual', 'analyze', 'invest', 'movers'].includes(body?.source)
      ? body.source : 'manual'
    const notes = typeof body?.notes === 'string' ? body.notes.slice(0, 500) : null

    // Option-specific validation
    let optionFields: {
      option_symbol: string | null
      option_type: 'call' | 'put' | null
      strike: number | null
      expiration: string | null
      premium_at_add: number | null
      delta_at_add: number | null
      iv_at_add: number | null
    } = {
      option_symbol: null,
      option_type: null,
      strike: null,
      expiration: null,
      premium_at_add: null,
      delta_at_add: null,
      iv_at_add: null,
    }

    if (assetType === 'option') {
      const optionSymbol = typeof body?.optionSymbol === 'string' ? body.optionSymbol.trim() : ''
      const optionType = body?.optionType
      const strike = typeof body?.strike === 'number' ? body.strike : parseFloat(body?.strike)
      const expiration = typeof body?.expiration === 'string' ? body.expiration.trim() : ''

      if (!optionSymbol) {
        return NextResponse.json({ error: 'optionSymbol required for asset_type=option' }, { status: 400 })
      }
      if (!['call', 'put'].includes(optionType)) {
        return NextResponse.json({ error: 'optionType must be "call" or "put"' }, { status: 400 })
      }
      if (!Number.isFinite(strike) || strike <= 0) {
        return NextResponse.json({ error: 'strike must be a positive number' }, { status: 400 })
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) {
        return NextResponse.json({ error: 'expiration must be YYYY-MM-DD' }, { status: 400 })
      }

      const premiumAtAdd = typeof body?.premiumAtAdd === 'number' ? body.premiumAtAdd : null
      const deltaAtAdd = typeof body?.deltaAtAdd === 'number' ? body.deltaAtAdd : null
      const ivAtAdd = typeof body?.ivAtAdd === 'number' ? body.ivAtAdd : null

      optionFields = {
        option_symbol: optionSymbol,
        option_type: optionType,
        strike,
        expiration,
        premium_at_add: premiumAtAdd,
        delta_at_add: deltaAtAdd,
        iv_at_add: ivAtAdd,
      }
    }

    const admin = getAdmin()

    // Look up latest verdict on the underlying
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

    const conflictTarget = assetType === 'option' ? 'user_id,option_symbol' : 'user_id,ticker,asset_type'

    const { data: upserted, error } = await admin
      .from('watchlist_entries')
      .upsert({
        user_id: user.id,
        ticker: rawTicker,
        asset_type: assetType,
        source,
        notes,
        muted: false,
        latest_verdict_id: latestVerdict?.id ?? null,
        latest_verdict_signal: latestVerdict?.signal ?? null,
        latest_verdict_confidence: latestVerdict?.confidence ?? null,
        latest_verdict_at: latestVerdict?.created_at ?? null,
        ...optionFields,
      }, {
        onConflict: conflictTarget,
        ignoreDuplicates: false,
      })
      .select('id, ticker, asset_type, option_symbol, source, muted')
      .single()

    if (error) {
      console.error('[watchlist/POST] upsert failed:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      entryId: upserted.id,
      ticker: upserted.ticker,
      assetType: upserted.asset_type,
      optionSymbol: upserted.option_symbol,
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
// DELETE — accepts ticker (for stock) or optionSymbol (for option)
// ═════════════════════════════════════════════════════════════
export async function DELETE(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const url = new URL(req.url)
    const ticker = String(url.searchParams.get('ticker') ?? '').trim().toUpperCase()
    const optionSymbol = String(url.searchParams.get('optionSymbol') ?? '').trim()
    const hardDelete = url.searchParams.get('hard') === 'true'

    if (!ticker && !optionSymbol) {
      return NextResponse.json({ error: 'ticker or optionSymbol query param required' }, { status: 400 })
    }

    const admin = getAdmin()

    // Build query based on which identifier was provided
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseQuery = (q: any) => {
      let query = q.eq('user_id', user.id)
      if (optionSymbol) {
        query = query.eq('option_symbol', optionSymbol).eq('asset_type', 'option')
      } else {
        query = query.eq('ticker', ticker).eq('asset_type', 'stock')
      }
      return query
    }

    if (hardDelete) {
      const { error } = await baseQuery(admin.from('watchlist_entries').delete())
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, deleted: true, ticker, optionSymbol })
    } else {
      const { error } = await baseQuery(admin.from('watchlist_entries').update({ muted: true }))
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, muted: true, ticker, optionSymbol })
    }
  } catch (e) {
    return NextResponse.json({
      error: (e as Error).message?.slice(0, 200) ?? 'unknown',
    }, { status: 500 })
  }
}

// ═════════════════════════════════════════════════════════════
// PATCH — toggle mute / update notes (by ticker or optionSymbol)
// ═════════════════════════════════════════════════════════════
export async function PATCH(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const ticker = String(body?.ticker ?? '').trim().toUpperCase()
    const optionSymbol = String(body?.optionSymbol ?? '').trim()

    if (!ticker && !optionSymbol) {
      return NextResponse.json({ error: 'ticker or optionSymbol required' }, { status: 400 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: Record<string, any> = {}
    if (typeof body.muted === 'boolean') updates.muted = body.muted
    if (typeof body.notes === 'string') updates.notes = body.notes.slice(0, 500)

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
    }

    const admin = getAdmin()
    let query = admin.from('watchlist_entries').update(updates).eq('user_id', user.id)
    if (optionSymbol) {
      query = query.eq('option_symbol', optionSymbol).eq('asset_type', 'option')
    } else {
      query = query.eq('ticker', ticker).eq('asset_type', 'stock')
    }

    const { error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, ticker, optionSymbol, updates })
  } catch (e) {
    return NextResponse.json({
      error: (e as Error).message?.slice(0, 200) ?? 'unknown',
    }, { status: 500 })
  }
}
