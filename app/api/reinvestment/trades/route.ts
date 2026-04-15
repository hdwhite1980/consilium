import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET — list all trades for user
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data: trades, error } = await getAdmin()
    .from('reinvestment_trades')
    .select('*')
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
  const { ticker, shares, entry_price, analysis_id, council_signal, confidence, persona, notes } = body

  if (!ticker || !shares || !entry_price) {
    return NextResponse.json({ error: 'ticker, shares, and entry_price are required' }, { status: 400 })
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
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ trade: data })
}

// PATCH — close a trade (add exit price) or update notes
export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json()
  const { id, exit_price, notes } = body

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (exit_price != null) {
    updates.exit_price = parseFloat(exit_price)
    updates.exit_date = new Date().toISOString()
  }
  if (notes != null) updates.notes = notes

  const { data, error } = await getAdmin()
    .from('reinvestment_trades')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ trade: data })
}

// DELETE — remove a trade
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const { error } = await getAdmin()
    .from('reinvestment_trades')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
