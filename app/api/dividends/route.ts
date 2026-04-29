import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as adminClient } from '@supabase/supabase-js'

function admin() {
  return adminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// ═════════════════════════════════════════════════════════════
// 2026-04-29 — GET now returns linked reinvest trades per dividend
//
// Each dividend row in the response includes a `linkedReinvestTrades`
// array of trades that were funded by that dividend (via the
// reinvestment_trades.funded_by_dividend_id FK from the migration).
// The unified portfolio page uses this to show:
//
//   AAPL · $25 · Apr 15
//     → funded NVDA reinvest trade (2 sh @ $850, +$45 P/L, open)
//
// POST and DELETE are unchanged.
// ═════════════════════════════════════════════════════════════

interface LinkedReinvestTrade {
  id: string
  ticker: string
  shares: number
  entry_price: number
  exit_price: number | null
  exit_date: string | null
  council_signal: string | null
  confidence: number | null
  notes: string | null
  opened_at: string
}

// GET — fetch dividend history + upcoming schedule for user's portfolio
export async function GET(_req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = admin()

  // 1. User's dividend history
  const { data: dividends } = await db
    .from('dividends')
    .select('*')
    .eq('user_id', user.id)
    .order('ex_date', { ascending: false })
    .limit(100)

  // 2. Linked reinvest trades — fetch in one query, group by dividend id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let linkedByDividend = new Map<string, LinkedReinvestTrade[]>()
  const dividendIds = (dividends ?? []).map(d => d.id)
  if (dividendIds.length > 0) {
    const { data: linkedTrades } = await db
      .from('reinvestment_trades')
      .select('id, ticker, shares, entry_price, exit_price, exit_date, council_signal, confidence, notes, opened_at, funded_by_dividend_id')
      .eq('user_id', user.id)
      .in('funded_by_dividend_id', dividendIds)

    if (linkedTrades) {
      for (const t of linkedTrades) {
        const divId = (t as { funded_by_dividend_id: string }).funded_by_dividend_id
        if (!linkedByDividend.has(divId)) linkedByDividend.set(divId, [])
        linkedByDividend.get(divId)!.push({
          id: t.id,
          ticker: t.ticker,
          shares: t.shares,
          entry_price: t.entry_price,
          exit_price: t.exit_price,
          exit_date: t.exit_date,
          council_signal: t.council_signal,
          confidence: t.confidence,
          notes: t.notes,
          opened_at: t.opened_at,
        })
      }
    }
  }

  // 3. Attach linkedReinvestTrades to each dividend row
  const dividendsWithLinks = (dividends ?? []).map(d => ({
    ...d,
    linkedReinvestTrades: linkedByDividend.get(d.id) ?? [],
  }))

  // 4. Upcoming dividend schedule (existing logic, unchanged)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: positions } = await db
    .from('portfolios')
    .select('ticker')
    .eq('user_id', user.id)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tickers = [...new Set((positions || []).map((p: any) => p.ticker))]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let schedule: any[] = []

  if (tickers.length > 0) {
    const { data: cached } = await db
      .from('dividend_schedule')
      .select('*')
      .in('ticker', tickers)
      .gte('ex_date', new Date().toISOString().split('T')[0])
      .order('ex_date', { ascending: true })

    if (cached && cached.length > 0) {
      schedule = cached
    } else {
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const divs: any[] = Array.isArray(data) ? data : (data.data || [])

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

  return NextResponse.json({ dividends: dividendsWithLinks, schedule })
}

// POST — log a dividend (unchanged)
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const db = admin()

  const { data, error } = await db.from('dividends').insert({
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
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // Return the inserted row so the client can use the new id (e.g., to
  // immediately log a reinvest trade linked to this dividend)
  return NextResponse.json({ ok: true, dividend: data })
}

// DELETE — remove a dividend record (unchanged)
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await req.json()
  await admin().from('dividends').delete().eq('id', id).eq('user_id', user.id)
  return NextResponse.json({ ok: true })
}
