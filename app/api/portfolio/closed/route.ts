// ═════════════════════════════════════════════════════════════
// /api/portfolio/closed — Fetch closed positions + realized P&L
//
// Returns:
//   - All positions with status='closed' (full closes)
//   - All positions with status='partial' (still partly open)
//   - All close events (full history including partials)
//   - Aggregate realized P&L total (sum of all close events)
//
// The UI uses this to populate the "Closed" tab and the realized
// P&L number in the portfolio hero strip.
// ═════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = getAdmin()

  // Find user's portfolio
  const { data: portfolio } = await admin
    .from('portfolios')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!portfolio) {
    return NextResponse.json({
      closed_positions: [],
      partial_positions: [],
      close_events: [],
      realized_pnl_total: 0,
      realized_pnl_count: 0,
    })
  }

  // Fetch closed and partial positions
  const { data: positions } = await admin
    .from('portfolio_positions')
    .select('*')
    .eq('portfolio_id', portfolio.id)
    .in('status', ['closed', 'partial'])
    .order('closed_at', { ascending: false, nullsFirst: false })

  const allPositions = positions ?? []
  const closedPositions = allPositions.filter(p => p.status === 'closed')
  const partialPositions = allPositions.filter(p => p.status === 'partial')

  // Fetch all close events for this user (any position)
  const { data: events } = await admin
    .from('position_close_events')
    .select('*')
    .eq('user_id', user.id)
    .order('closed_at', { ascending: false })
    .limit(500)

  const closeEvents = events ?? []
  const realizedPnlTotal = closeEvents.reduce(
    (s, e) => s + (typeof e.realized_pnl === 'number' ? e.realized_pnl : 0),
    0
  )

  return NextResponse.json({
    closed_positions: closedPositions,
    partial_positions: partialPositions,
    close_events: closeEvents,
    realized_pnl_total: realizedPnlTotal,
    realized_pnl_count: closeEvents.length,
  })
}
