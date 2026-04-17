import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as adminClient } from '@supabase/supabase-js'

function admin() {
  return adminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// GET — fetch dividend history + upcoming schedule for user's portfolio
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()

  // User's dividend history
  const { data: dividends } = await db
    .from('dividends')
    .select('*')
    .eq('user_id', user.id)
    .order('ex_date', { ascending: false })
    .limit(100)

  // Get user's portfolio tickers for schedule
  const { data: positions } = await db
    .from('portfolios')
    .select('ticker')
    .eq('user_id', user.id)

  const tickers = [...new Set((positions || []).map((p: any) => p.ticker))]
  let schedule: any[] = []

  if (tickers.length > 0) {
    // Check cache first
    const { data: cached } = await db
      .from('dividend_schedule')
      .select('*')
      .in('ticker', tickers)
      .gte('ex_date', new Date().toISOString().split('T')[0])
      .order('ex_date', { ascending: true })

    if (cached && cached.length > 0) {
      schedule = cached
    } else {
      // Fetch from Finnhub for each ticker
      const finnhubKey = process.env.FINNHUB_API_KEY
      if (finnhubKey) {
        for (const ticker of tickers.slice(0, 20)) {
          try {
            const from = new Date().toISOString().split('T')[0]
            const to = new Date(Date.now() + 365 * 86400000).toISOString().split('T')[0]
            const res = await fetch(
              `https://finnhub.io/api/v1/stock/dividend2?symbol=${ticker}&from=${from}&to=${to}&token=${finnhubKey}`
            )
            if (!res.ok) continue
            const data = await res.json()
            const divs = Array.isArray(data) ? data : (data.data || [])

            for (const d of divs.slice(0, 4)) {
              const row = {
                ticker: ticker.toUpperCase(),
                ex_date: d.exDate || d.ex_date,
                pay_date: d.payDate || d.pay_date || null,
                amount: d.amount || d.dividend || null,
                frequency: d.frequency || null,
                fetched_at: new Date().toISOString(),
              }
              if (!row.ex_date) continue
              await db.from('dividend_schedule').upsert(row, { onConflict: 'ticker,ex_date' })
              schedule.push(row)
            }
            await new Promise(r => setTimeout(r, 120))
          } catch { /* skip */ }
        }
      }
    }
  }

  return NextResponse.json({ dividends: dividends || [], schedule })
}

// POST — log a dividend
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const db = admin()

  const { error } = await db.from('dividends').insert({
    user_id: user.id,
    ticker: body.ticker,
    ex_date: body.ex_date,
    pay_date: body.pay_date || null,
    amount_per_share: body.amount_per_share,
    shares_held: body.shares_held,
    total_received: body.total_received,
    reinvested: body.reinvested || false,
    reinvest_shares: body.reinvest_shares || null,
    reinvest_price: body.reinvest_price || null,
    notes: body.notes || null,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// DELETE — remove a dividend record
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await req.json()
  await admin().from('dividends').delete().eq('id', id).eq('user_id', user.id)
  return NextResponse.json({ ok: true })
}
