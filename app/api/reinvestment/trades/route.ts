import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ═════════════════════════════════════════════════════════════
// 2026-04-29 — Added funded_by_dividend_id support
//
// Reinvest trades can now be explicitly linked to the dividend that
// funded them. The unified portfolio page uses this to show
// "NVDA bought with $25 from your AAPL Q1 dividend" inline, and to
// avoid double-counting when computing reinvested-dividend totals.
//
// All existing endpoints stay backward compatible:
//   GET — now also returns funded_by_dividend_id on each row
//   POST — now accepts optional funded_by_dividend_id in body
//   PATCH — unchanged
//   DELETE — unchanged
// ═════════════════════════════════════════════════════════════

// GET — list all trades for user
export async function GET(_req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: trades, error } = await getAdmin()
    .from('reinvestment_trades')
    .select('*')                      // includes funded_by_dividend_id automatically
    .eq('user_id', user.id)
    .order('opened_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ trades: trades ?? [] })
}

// POST — create a new trade
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json()
  const {
    ticker, shares, entry_price,
    analysis_id, council_signal, confidence, persona, notes,
    funded_by_dividend_id,           // ← NEW
  } = body

  if (!ticker || !shares || !entry_price) {
    return NextResponse.json({ error: 'ticker, shares, and entry_price are required' }, { status: 400 })
  }

  // Sanity-check funded_by_dividend_id if provided — must belong to this
  // user, otherwise we silently drop it. Don't fail the whole insert.
  let validatedFundedBy: string | null = null
  if (funded_by_dividend_id) {
    try {
      const { data: divRow } = await getAdmin()
        .from('dividends')
        .select('id, user_id')
        .eq('id', funded_by_dividend_id)
        .eq('user_id', user.id)
        .maybeSingle()
      if (divRow) validatedFundedBy = funded_by_dividend_id
    } catch { /* fall through, leave null */ }
  }

  const { data, error } = await getAdmin()
    .from('reinvestment_trades')
    .insert({
      user_id: user.id,
      ticker: ticker.toUpperCase().trim(),
      shares: parseFloat(shares),
      entry_price: parseFloat(entry_price),
      analysis_id: analysis_id ?? null,
      council_signal: council_signal ?? null,
      confidence: confidence ?? null,
      persona: persona ?? 'balanced',
      notes: notes ?? null,
      funded_by_dividend_id: validatedFundedBy,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ trade: data, ok: true })
}

// PATCH — update a trade (close it, edit shares, etc.)
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { id, exit_price, shares, entry_price, notes, funded_by_dividend_id } = await req.json()

  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (exit_price !== undefined) {
    updates.exit_price = parseFloat(exit_price)
    updates.exit_date = new Date().toISOString()
  }
  if (shares !== undefined) updates.shares = parseFloat(shares)
  if (entry_price !== undefined) updates.entry_price = parseFloat(entry_price)
  if (notes !== undefined) updates.notes = notes
  // Allow updating funded_by_dividend_id (e.g., user later associates
  // an existing trade with a dividend). Validate ownership.
  if (funded_by_dividend_id !== undefined) {
    if (funded_by_dividend_id === null) {
      updates.funded_by_dividend_id = null
    } else {
      const { data: divRow } = await getAdmin()
        .from('dividends')
        .select('id, user_id')
        .eq('id', funded_by_dividend_id)
        .eq('user_id', user.id)
        .maybeSingle()
      if (divRow) updates.funded_by_dividend_id = funded_by_dividend_id
    }
  }

  const { error } = await getAdmin()
    .from('reinvestment_trades')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// DELETE — remove a trade
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await getAdmin()
    .from('reinvestment_trades')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
