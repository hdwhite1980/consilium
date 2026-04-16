import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const admin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function getOrCreatePortfolio(userId: string) {
  const db = admin()
  const { data } = await db.from('portfolios').select('*').eq('user_id', userId).maybeSingle()
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

  const {
    ticker, shares, avg_cost, notes,
    position_type, option_type, strike, expiry, contracts, entry_premium, underlying
  } = await req.json()
  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })
  
  const isOption = position_type === 'option'
  if (!isOption && !shares) return NextResponse.json({ error: 'shares required for stock positions' }, { status: 400 })
  if (isOption && (!contracts || !strike || !expiry || !option_type)) {
    return NextResponse.json({ error: 'contracts, strike, expiry, option_type required for options' }, { status: 400 })
  }

  const portfolio = await getOrCreatePortfolio(user.id)
  if (!portfolio) return NextResponse.json({ error: 'Could not create portfolio' }, { status: 500 })

  // For options, use a unique key of ticker+expiry+strike+type to allow multiple option positions
  const conflictTarget = isOption ? undefined : 'portfolio_id,ticker'
  
  const upsertData: Record<string, unknown> = {
    portfolio_id: portfolio.id,
    user_id: user.id,
    ticker: ticker.toUpperCase(),
    shares: isOption ? (contracts ?? 1) * 100 : Number(shares), // options: contracts × 100
    avg_cost: avg_cost ? Number(avg_cost) : (entry_premium ? Number(entry_premium) : null),
    notes: notes ?? null,
    position_type: position_type ?? 'stock',
    updated_at: new Date().toISOString(),
  }

  if (isOption) {
    upsertData.option_type = option_type
    upsertData.strike = strike ? Number(strike) : null
    upsertData.expiry = expiry ?? null
    upsertData.contracts = contracts ? Number(contracts) : 1
    upsertData.entry_premium = entry_premium ? Number(entry_premium) : null
    upsertData.underlying = (underlying ?? ticker).toUpperCase()
  }

  const { data, error } = await admin()
    .from('portfolio_positions')
    .upsert(upsertData, conflictTarget ? { onConflict: conflictTarget } : undefined)
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
