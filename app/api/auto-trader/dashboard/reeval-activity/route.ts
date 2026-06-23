// =============================================================
// app/api/auto-trader/dashboard/reeval-activity/route.ts
//
// GET → today's reeval_log for the calling user.
//
// Returns:
//   - kpis: counts by trigger source + material change + cancellations
//   - recent: last 30 reeval checks
//   - perTrigger: latest run per trigger_source (after_hours/pre_market)
//
// Used by the dashboard's "Reeval Activity" section.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ReevalRow {
  id: number
  trigger_source: string
  ticker: string
  kind: string                       // 'open_position' | 'held_order'
  verdict_log_id: number | null
  material: boolean
  material_reasons: string[] | null
  price_gap_pct: number | null
  current_price: number | null
  escalated_to_council: boolean
  council_action: string | null
  council_thesis_status: string | null
  council_rationale: string | null
  action_taken: string | null
  cancel_ok: boolean | null
  cancel_reason: string | null
  error_reason: string | null
  created_at: string
}

interface ReevalKpis {
  total: number
  afterHoursChecks: number
  preMarketChecks: number
  morningChecks: number
  materialChanges: number
  councilEscalations: number
  ordersCancelled: number
  errors: number
}

interface RecentReeval {
  id: number
  trigger_source: string
  ticker: string
  kind: string
  verdict_log_id: number | null
  material: boolean
  material_reasons: string[]
  price_gap_pct: number | null
  current_price: number | null
  council_action: string | null
  council_thesis_status: string | null
  action_taken: string | null
  cancel_ok: boolean | null
  error_reason: string | null
  created_at: string
}

interface PerTriggerSummary {
  trigger_source: string
  total_checks: number
  material_count: number
  council_count: number
  cancel_count: number
  last_run_at: string
}

interface ReevalActivityData {
  ok: boolean
  kpis: ReevalKpis
  recent: RecentReeval[]
  perTrigger: PerTriggerSummary[]
  error?: string
}

export async function GET(_req: NextRequest): Promise<NextResponse<ReevalActivityData>> {
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
        kpis: emptyKpis(), recent: [], perTrigger: [],
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
      .from('reeval_log')
      .select('id, trigger_source, ticker, kind, verdict_log_id, material, material_reasons, price_gap_pct, current_price, escalated_to_council, council_action, council_thesis_status, council_rationale, action_taken, cancel_ok, cancel_reason, error_reason, created_at')
      .eq('user_id', userId)
      .gte('created_at', cutoffIso)
      .order('id', { ascending: false })
      .limit(200)

    if (error) {
      // Table may not exist yet (migration 16 hasn't run, or new install) —
      // return empty success rather than 500. UI shows "no data" gracefully.
      const isMissingTable = error.message.includes('does not exist') ||
        error.message.includes('relation') || error.code === '42P01'
      if (isMissingTable) {
        return NextResponse.json({
          ok: true, kpis: emptyKpis(), recent: [], perTrigger: [],
        })
      }
      console.warn('[dashboard/reeval-activity] query failed:', error.message)
      return NextResponse.json({
        ok: false, error: error.message,
        kpis: emptyKpis(), recent: [], perTrigger: [],
      })
    }

    const rows = (data ?? []) as ReevalRow[]

    // KPIs
    const kpis: ReevalKpis = {
      total: rows.length,
      afterHoursChecks: rows.filter(r => r.trigger_source === 'after_hours_reeval').length,
      preMarketChecks: rows.filter(r => r.trigger_source === 'pre_market_reeval').length,
      morningChecks: rows.filter(r => r.trigger_source === 'morning_reeval').length,
      materialChanges: rows.filter(r => r.material === true).length,
      councilEscalations: rows.filter(r => r.escalated_to_council === true).length,
      ordersCancelled: rows.filter(r => r.action_taken === 'cancelled' && r.cancel_ok === true).length,
      errors: rows.filter(r => r.error_reason !== null).length,
    }

    // Recent: top 30
    const recent: RecentReeval[] = rows.slice(0, 30).map(r => ({
      id: r.id,
      trigger_source: r.trigger_source,
      ticker: r.ticker,
      kind: r.kind,
      verdict_log_id: r.verdict_log_id,
      material: r.material,
      material_reasons: Array.isArray(r.material_reasons) ? r.material_reasons : [],
      price_gap_pct: r.price_gap_pct !== null ? Number(r.price_gap_pct) : null,
      current_price: r.current_price !== null ? Number(r.current_price) : null,
      council_action: r.council_action,
      council_thesis_status: r.council_thesis_status,
      action_taken: r.action_taken,
      cancel_ok: r.cancel_ok,
      error_reason: r.error_reason,
      created_at: r.created_at,
    }))

    // Per-trigger summary
    const triggerMap = new Map<string, {
      total: number; material: number; council: number; cancel: number; last: string;
    }>()
    for (const r of rows) {
      const t = r.trigger_source
      const existing = triggerMap.get(t)
      if (existing) {
        existing.total++
        if (r.material) existing.material++
        if (r.escalated_to_council) existing.council++
        if (r.action_taken === 'cancelled' && r.cancel_ok === true) existing.cancel++
        // rows arrive in desc order; "last" is the first one we see for each trigger
      } else {
        triggerMap.set(t, {
          total: 1,
          material: r.material ? 1 : 0,
          council: r.escalated_to_council ? 1 : 0,
          cancel: (r.action_taken === 'cancelled' && r.cancel_ok === true) ? 1 : 0,
          last: r.created_at,
        })
      }
    }
    const perTrigger: PerTriggerSummary[] = Array.from(triggerMap.entries())
      .map(([trigger_source, v]) => ({
        trigger_source,
        total_checks: v.total,
        material_count: v.material,
        council_count: v.council,
        cancel_count: v.cancel,
        last_run_at: v.last,
      }))
      .sort((a, b) => a.trigger_source.localeCompare(b.trigger_source))

    return NextResponse.json({
      ok: true,
      kpis,
      recent,
      perTrigger,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[dashboard/reeval-activity] failed:', msg)
    return NextResponse.json({
      ok: false, error: msg.slice(0, 200),
      kpis: emptyKpis(), recent: [], perTrigger: [],
    })
  }
}

function emptyKpis(): ReevalKpis {
  return {
    total: 0, afterHoursChecks: 0, preMarketChecks: 0, morningChecks: 0,
    materialChanges: 0, councilEscalations: 0, ordersCancelled: 0, errors: 0,
  }
}
