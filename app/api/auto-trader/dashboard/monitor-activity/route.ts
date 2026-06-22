// =============================================================
// app/api/auto-trader/dashboard/monitor-activity/route.ts
//
// GET → today's position_monitor_log summary for the calling user.
//
// Returns:
//   - kpis: counts by decision (HOLD/TIGHTEN/EXIT/ESCALATE)
//   - recent: last 30 monitor checks with key fields
//   - perTicker: latest decision per currently-monitored ticker
//
// Used by the dashboard's "Position-Monitor Activity" section.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface MonitorRow {
  id: number
  trade_attempt_id: string | null
  ticker: string
  decision: string
  action_taken: string
  current_price: number | null
  current_stop: number | null
  new_stop_price: number | null
  bearish_count_5m: number | null
  bullish_count_5m: number | null
  bearish_count_15m: number | null
  bullish_count_15m: number | null
  error_reason: string | null
  escalation_result: unknown
  created_at: string
}

interface MonitorKpis {
  total: number
  holds: number
  tightens: number
  exits: number
  escalates: number
  failures: number
}

interface RecentMonitorCheck {
  id: number
  ticker: string
  decision: string
  action_taken: string
  current_price: number | null
  current_stop: number | null
  new_stop_price: number | null
  bearish_15m: number | null
  bullish_15m: number | null
  bearish_5m: number | null
  bullish_5m: number | null
  error_reason: string | null
  created_at: string
}

interface PerTickerLatest {
  ticker: string
  latest_decision: string
  latest_action: string
  latest_at: string
  total_checks_today: number
  total_tightens: number
  total_exits: number
}

interface MonitorActivityData {
  ok: boolean
  kpis: MonitorKpis
  recent: RecentMonitorCheck[]
  perTicker: PerTickerLatest[]
  error?: string
}

export async function GET(_req: NextRequest): Promise<NextResponse<MonitorActivityData>> {
  let userId: string | null = null
  try {
    const supa = await createClient()
    const { data: { user } } = await supa.auth.getUser()
    userId = user?.id ?? null
  } catch {
    // fall through; if userId still null we 401
  }
  if (!userId) {
    return NextResponse.json(
      {
        ok: false, error: 'Unauthorized',
        kpis: emptyKpis(), recent: [], perTicker: [],
      },
      { status: 401 },
    )
  }

  try {
    const admin = await getSupabaseAdmin()
    const cutoff = new Date()
    cutoff.setUTCHours(0, 0, 0, 0)
    const cutoffIso = cutoff.toISOString()

    const { data, error } = await admin
      .from('position_monitor_log')
      .select('id, trade_attempt_id, ticker, decision, action_taken, current_price, current_stop, new_stop_price, bearish_count_5m, bullish_count_5m, bearish_count_15m, bullish_count_15m, error_reason, escalation_result, created_at')
      .eq('user_id', userId)
      .gte('created_at', cutoffIso)
      .order('id', { ascending: false })
      .limit(200)

    if (error) {
      console.warn('[dashboard/monitor-activity] query failed:', error.message)
      return NextResponse.json({
        ok: false, error: error.message,
        kpis: emptyKpis(), recent: [], perTicker: [],
      })
    }

    const rows = (data ?? []) as MonitorRow[]

    // KPIs
    const isFailure = (a: string) => a.endsWith('_failed') || a === 'error'
    const kpis: MonitorKpis = {
      total: rows.length,
      holds: rows.filter(r => r.decision === 'HOLD').length,
      tightens: rows.filter(r => r.action_taken === 'tightened' || r.action_taken === 'escalated_tighten').length,
      exits: rows.filter(r => r.action_taken === 'exited' || r.action_taken === 'escalated_exit').length,
      escalates: rows.filter(r => r.decision === 'ESCALATE').length,
      failures: rows.filter(r => isFailure(r.action_taken)).length,
    }

    // Recent: top 30
    const recent: RecentMonitorCheck[] = rows.slice(0, 30).map(r => ({
      id: r.id,
      ticker: r.ticker,
      decision: r.decision,
      action_taken: r.action_taken,
      current_price: r.current_price !== null ? Number(r.current_price) : null,
      current_stop: r.current_stop !== null ? Number(r.current_stop) : null,
      new_stop_price: r.new_stop_price !== null ? Number(r.new_stop_price) : null,
      bearish_15m: r.bearish_count_15m,
      bullish_15m: r.bullish_count_15m,
      bearish_5m: r.bearish_count_5m,
      bullish_5m: r.bullish_count_5m,
      error_reason: r.error_reason,
      created_at: r.created_at,
    }))

    // Per-ticker latest
    // Group by ticker, keep latest row (already sorted desc), plus totals
    const tickerMap = new Map<string, { latest: MonitorRow; checks: number; tightens: number; exits: number }>()
    for (const r of rows) {
      const t = r.ticker.toUpperCase()
      const existing = tickerMap.get(t)
      if (existing) {
        existing.checks++
        if (r.action_taken === 'tightened' || r.action_taken === 'escalated_tighten') existing.tightens++
        if (r.action_taken === 'exited' || r.action_taken === 'escalated_exit') existing.exits++
      } else {
        tickerMap.set(t, {
          latest: r,
          checks: 1,
          tightens: (r.action_taken === 'tightened' || r.action_taken === 'escalated_tighten') ? 1 : 0,
          exits: (r.action_taken === 'exited' || r.action_taken === 'escalated_exit') ? 1 : 0,
        })
      }
    }
    const perTicker: PerTickerLatest[] = Array.from(tickerMap.entries())
      .map(([ticker, v]) => ({
        ticker,
        latest_decision: v.latest.decision,
        latest_action: v.latest.action_taken,
        latest_at: v.latest.created_at,
        total_checks_today: v.checks,
        total_tightens: v.tightens,
        total_exits: v.exits,
      }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker))

    return NextResponse.json({
      ok: true,
      kpis,
      recent,
      perTicker,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[dashboard/monitor-activity] failed:', msg)
    return NextResponse.json({
      ok: false, error: msg.slice(0, 200),
      kpis: emptyKpis(), recent: [], perTicker: [],
    })
  }
}

function emptyKpis(): MonitorKpis {
  return { total: 0, holds: 0, tightens: 0, exits: 0, escalates: 0, failures: 0 }
}
