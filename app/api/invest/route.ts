import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const [{ data: trades }, { data: journey }] = await Promise.all([
    getAdmin().from('invest_trades').select('*').eq('user_id', user.id).order('opened_at', { ascending: false }),
    getAdmin().from('invest_journey').select('*').eq('user_id', user.id).single(),
  ])

  return NextResponse.json({ trades: trades ?? [], journey: journey ?? null })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json()

  // Set starting balance / init journey
  if (body.type === 'set_balance') {
    const { data } = await getAdmin().from('invest_journey').upsert({
      user_id: user.id,
      starting_balance: body.balance,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' }).select().single()
    return NextResponse.json({ journey: data })
  }

  // Log a new trade
  if (body.type === 'open_trade') {
    const { ticker, shares, entry_price, council_signal, confidence, notes } = body
    const { data, error } = await getAdmin().from('invest_trades').insert({
      user_id: user.id,
      ticker: ticker.toUpperCase(),
      shares: parseFloat(shares),
      entry_price: parseFloat(entry_price),
      council_signal,
      confidence,
      notes,
    }).select().single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Update total trades count
    await getAdmin().from('invest_journey').upsert({
      user_id: user.id,
      starting_balance: 0,
      total_trades: 1,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

    return NextResponse.json({ trade: data })
  }

  // Close a trade
  if (body.type === 'close_trade') {
    const { id, exit_price } = body
    const exitP = parseFloat(exit_price)

    const { data: trade } = await getAdmin().from('invest_trades').select('*').eq('id', id).eq('user_id', user.id).single()
    if (!trade) return NextResponse.json({ error: 'Trade not found' }, { status: 404 })

    await getAdmin().from('invest_trades').update({
      exit_price: exitP,
      exit_date: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('user_id', user.id)

    // Update journey stats
    const isWin = exitP > trade.entry_price
    const { data: journey } = await getAdmin().from('invest_journey').select('*').eq('user_id', user.id).single()

    if (journey) {
      const newStreak = isWin ? (journey.win_streak ?? 0) + 1 : 0
      const bestStreak = Math.max(journey.best_streak ?? 0, newStreak)
      const winningTrades = (journey.winning_trades ?? 0) + (isWin ? 1 : 0)
      const firstWinAt = isWin && !journey.first_win_at ? new Date().toISOString() : journey.first_win_at

      await getAdmin().from('invest_journey').update({
        win_streak: newStreak,
        best_streak: bestStreak,
        winning_trades: winningTrades,
        first_win_at: firstWinAt,
        updated_at: new Date().toISOString(),
      }).eq('user_id', user.id)
    }

    return NextResponse.json({ success: true, isWin })
  }

  // Delete a trade
  if (body.type === 'delete_trade') {
    await getAdmin().from('invest_trades').delete().eq('id', body.id).eq('user_id', user.id)
    return NextResponse.json({ success: true })
  }

  return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
}
