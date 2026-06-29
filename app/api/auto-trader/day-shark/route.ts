// =============================================================
// app/api/auto-trader/day-shark/route.ts
//
// Max's own dashboard data — day_shark only. Pure DB read (no broker calls):
// aggregates, per-asset breakdown, the crypto milestone story, open positions,
// and closed trades with Max's exit voice attached.
// =============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { maxNarration, nextMilestone, type MaxEvent } from '@/app/lib/trading/day-shark'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CRYPTO_START = 50   // Max's real-money crypto starting stake — the "$50 → $100" story

function admin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

interface Row {
  id: number
  ticker: string
  asset_class: string | null
  side: string | null
  outcome: string
  qty: number | null
  entry_price_est: number | null
  filled_avg_price: number | null
  stop_price: number | null
  target_price: number | null
  realized_pnl: number | string | null
  exit_price: number | null
  closure_kind: string | null
  created_at: string
  closed_at: string | null
}

const OPEN = ['placed', 'filled', 'partial_fill']
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v) || 0)

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data } = await admin()
    .from('trade_attempts')
    .select('id, ticker, asset_class, side, outcome, qty, entry_price_est, filled_avg_price, stop_price, target_price, realized_pnl, exit_price, closure_kind, created_at, closed_at')
    .eq('user_id', user.id)
    .eq('signal_source', 'day_shark')
    .order('created_at', { ascending: false })
    .limit(500)

  const rows = (data ?? []) as Row[]
  const openRows = rows.filter(r => OPEN.includes(r.outcome))
  const closedRows = rows.filter(r => r.outcome === 'closed_win' || r.outcome === 'closed_loss')

  const wins = closedRows.filter(r => r.outcome === 'closed_win').length
  const losses = closedRows.filter(r => r.outcome === 'closed_loss').length
  const totalPnl = closedRows.reduce((s, r) => s + num(r.realized_pnl), 0)
  const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : null

  // Per-asset breakdown
  const perAsset: Record<string, { open: number; closed: number; pnl: number; wins: number; losses: number }> = {}
  for (const a of ['crypto', 'stock', 'forex']) perAsset[a] = { open: 0, closed: 0, pnl: 0, wins: 0, losses: 0 }
  for (const r of rows) {
    const a = r.asset_class ?? 'stock'
    if (!perAsset[a]) continue
    if (OPEN.includes(r.outcome)) perAsset[a].open++
    else if (r.outcome === 'closed_win' || r.outcome === 'closed_loss') {
      perAsset[a].closed++; perAsset[a].pnl += num(r.realized_pnl)
      if (r.outcome === 'closed_win') perAsset[a].wins++; else perAsset[a].losses++
    }
  }

  // Crypto milestone story (real money): stake = $50 + realized crypto P&L
  const cryptoStake = CRYPTO_START + perAsset.crypto.pnl
  const milestoneTarget = nextMilestone(cryptoStake, CRYPTO_START)
  const prevRung = milestoneTarget / 2
  const milestonePct = Math.max(0, Math.min(100, ((cryptoStake - prevRung) / (milestoneTarget - prevRung)) * 100))

  const now = Date.now()
  const open = openRows.map(r => {
    const entry = r.filled_avg_price ?? r.entry_price_est
    return {
      ticker: r.ticker, asset: r.asset_class, side: r.side ?? 'buy',
      entry, stop: r.stop_price, target: r.target_price, qty: num(r.qty),
      ageHours: Number(((now - new Date(r.created_at).getTime()) / 3_600_000).toFixed(1)),
    }
  })

  const closed = closedRows.slice(0, 30).map(r => {
    const entry = r.filled_avg_price ?? r.entry_price_est ?? 0
    const win = r.outcome === 'closed_win'
    const gainPct = entry > 0 && r.exit_price ? (r.side === 'sell' ? (entry - r.exit_price) : (r.exit_price - entry)) / entry : 0
    const event: MaxEvent = r.closure_kind === 'target_hit' ? 'target' : 'stop'
    return {
      ticker: r.ticker, asset: r.asset_class, outcome: r.outcome,
      pnl: num(r.realized_pnl), exitPrice: r.exit_price, win,
      closedAt: r.closed_at,
      voice: maxNarration({ event, ticker: r.ticker, gainPct }),
    }
  })

  // What Max is evaluating — the normal trader's recent directional verdicts.
  // Max re-decides on these with his own looser bar, so he may take ones the
  // trader passed. The decision badge here shows the TRADER's call.
  const { data: vData } = await admin()
    .from('verdict_log')
    .select('ticker, signal, trader_decision, trader_risk_reward, trader_pass_reasons, created_at')
    .eq('user_id', user.id)
    .or('source.is.null,source.neq.day_shark')
    .in('signal', ['BULLISH', 'BEARISH'])
    .order('created_at', { ascending: false })
    .limit(20)

  const watching = (vData ?? []).map((v: {
    ticker: string | null; signal: string | null; trader_decision: string | null
    trader_risk_reward: number | string | null; trader_pass_reasons: string[] | null; created_at: string
  }) => ({
    ticker: v.ticker,
    signal: v.signal,
    decision: v.trader_decision,                       // TAKE | PASS | WAIT
    rr: v.trader_risk_reward == null ? null : Number(Number(v.trader_risk_reward).toFixed(2)),
    reason: Array.isArray(v.trader_pass_reasons) && v.trader_pass_reasons.length > 0 ? v.trader_pass_reasons[0] : null,
    at: v.created_at,
    ageHours: Number(((Date.now() - new Date(v.created_at).getTime()) / 3_600_000).toFixed(1)),
  }))

  // ── TEMP DEBUG ── reveals whether the auth user matches the trade rows.
  const outcomesForUser = Array.from(new Set(rows.map(r => r.outcome)))
  const { count: globalDayShark } = await admin()
    .from('trade_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('signal_source', 'day_shark')
    .in('outcome', OPEN)
  const { data: sampleAny } = await admin()
    .from('trade_attempts')
    .select('user_id, ticker, outcome')
    .eq('signal_source', 'day_shark')
    .in('outcome', OPEN)
    .limit(3)

  return NextResponse.json({
    aggregates: { totalPnl: Number(totalPnl.toFixed(2)), wins, losses, winRate, openCount: openRows.length, totalTrades: closedRows.length },
    perAsset,
    milestone: { cryptoStake: Number(cryptoStake.toFixed(2)), next: milestoneTarget, pct: Number(milestonePct.toFixed(0)) },
    open, closed, watching,
    _debug: {
      authUserId: user.id,
      rowsForThisUser: rows.length,
      outcomesForThisUser: outcomesForUser,
      openCountForThisUser: openRows.length,
      globalOpenDaySharkRows: globalDayShark ?? null,
      sampleOpenRowsAnyUser: sampleAny ?? [],
    },
  })
}
