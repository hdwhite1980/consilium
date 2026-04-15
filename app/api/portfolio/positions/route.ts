import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const admin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function getOrCreatePortfolio(userId: string) {
  const db = admin()
  const { data } = await db.from('portfolios').select('*').eq('user_id', userId).single()
  if (data) return data
  const { data: created } = await db.from('portfolios').insert({ user_id: userId }).select().single()
  return created
}

// GET — fetch positions
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const portfolio = await getOrCreatePortfolio(user.id)
  if (!portfolio) return NextResponse.json({ positions: [] })

  const { data: positions } = await admin()
    .from('portfolio_positions')
    .select('*')
    .eq('portfolio_id', portfolio.id)
    .order('added_at', { ascending: true })

  return NextResponse.json({ positions: positions ?? [], portfolio })
}

// POST — add or update position
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { ticker, shares, avg_cost, notes } = await req.json()
  if (!ticker || !shares) return NextResponse.json({ error: 'ticker and shares required' }, { status: 400 })

  const portfolio = await getOrCreatePortfolio(user.id)
  if (!portfolio) return NextResponse.json({ error: 'Could not create portfolio' }, { status: 500 })

  const { data, error } = await admin()
    .from('portfolio_positions')
    .upsert({
      portfolio_id: portfolio.id,
      user_id: user.id,
      ticker: ticker.toUpperCase(),
      shares: Number(shares),
      avg_cost: avg_cost ? Number(avg_cost) : null,
      notes: notes ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'portfolio_id,ticker' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ position: data })
}

// DELETE — remove position
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { ticker } = await req.json()
  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })

  const portfolio = await getOrCreatePortfolio(user.id)
  if (!portfolio) return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 })

  await admin()
    .from('portfolio_positions')
    .delete()
    .eq('portfolio_id', portfolio.id)
    .eq('ticker', ticker.toUpperCase())

  return NextResponse.json({ success: true })
}
