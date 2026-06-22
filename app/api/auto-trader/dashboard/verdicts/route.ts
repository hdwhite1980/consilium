// =============================================================
// app/api/auto-trader/dashboard/verdicts/route.ts
//
// GET → today's verdict_log summary for the calling user.
//
// Returns:
//   - kpis: counts by decision (TAKE/PASS/WAIT) + by signal
//   - recent: last 20 verdicts with key fields
//   - passReasons: aggregated pass reasons by category
//
// Used by the dashboard's "Today's Verdicts" section.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface VerdictRow {
  id: number
  ticker: string
  signal: string | null
  confidence: number | null
  trader_decision: string | null
  trader_grade: string | null
  trader_pass_reasons: string[] | null
  trader_risk_reward: number | null
  entry_price: number | null
  stop_loss: number | null
  take_profit: number | null
  timeframe: string | null
  created_at: string
}

interface VerdictsKpis {
  total: number
  takes: number
  passes: number
  waits: number
  bullish: number
  bearish: number
  takesBullish: number
  takesBearish: number
}

interface PassReasonCategory {
  category: string         // e.g. 'risk_reward', 'confidence', 'earnings', 'other'
  count: number
  sample: string           // first 120 chars of one reason
}

interface RecentVerdict {
  id: number
  ticker: string
  signal: string | null
  confidence: number | null
  trader_decision: string | null
  trader_grade: string | null
  trader_risk_reward: number | null
  entry_price: number | null
  stop_loss: number | null
  take_profit: number | null
  timeframe: string | null
  pass_reason_short: string | null
  created_at: string
}

interface VerdictsDashboardData {
  ok: boolean
  kpis: VerdictsKpis
  recent: RecentVerdict[]
  passReasons: PassReasonCategory[]
  error?: string
}

/**
 * Categorize a pass reason string into a high-level category.
 * Pattern-match against the actual reasons we see in Trader output.
 */
function categorizePassReason(reason: string): string {
  const r = reason.toLowerCase()
  if (r.includes('risk-to-reward') || r.includes('r:r') || r.includes('risk/reward')) return 'risk_reward'
  if (r.includes('confidence') && r.includes('floor')) return 'confidence_floor'
  if (r.includes('earnings')) return 'earnings_window'
  if (r.includes('no valid entry') || r.includes('no entry price') || r.includes('missing entry')) return 'missing_prices'
  if (r.includes('counter-trend')) return 'counter_trend'
  if (r.includes('block')) return 'block_window'
  if (r.includes('stop')) return 'stop_issue'
  return 'other'
}

export async function GET(_req: NextRequest): Promise<NextResponse<VerdictsDashboardData>> {
  // Auth: session user only — no service-level access here
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
        kpis: emptyKpis(), recent: [], passReasons: [],
      },
      { status: 401 },
    )
  }

  try {
    const admin = await getSupabaseAdmin()
    // "Today" = since 00:00 UTC. Could be refined to user's local TZ later;
    // for now UTC matches the rest of the cron infrastructure.
    const cutoff = new Date()
    cutoff.setUTCHours(0, 0, 0, 0)
    const cutoffIso = cutoff.toISOString()

    const { data, error } = await admin
      .from('verdict_log')
      .select('id, ticker, signal, confidence, trader_decision, trader_grade, trader_pass_reasons, trader_risk_reward, entry_price, stop_loss, take_profit, timeframe, created_at')
      .eq('user_id', userId)
      .gte('created_at', cutoffIso)
      .order('id', { ascending: false })
      .limit(100)

    if (error) {
      console.warn('[dashboard/verdicts] query failed:', error.message)
      return NextResponse.json({
        ok: false, error: error.message,
        kpis: emptyKpis(), recent: [], passReasons: [],
      })
    }

    const rows = (data ?? []) as VerdictRow[]

    // KPIs
    const kpis: VerdictsKpis = {
      total: rows.length,
      takes: rows.filter(r => r.trader_decision === 'TAKE').length,
      passes: rows.filter(r => r.trader_decision === 'PASS').length,
      waits: rows.filter(r => r.trader_decision === 'WAIT').length,
      bullish: rows.filter(r => r.signal === 'BULLISH').length,
      bearish: rows.filter(r => r.signal === 'BEARISH').length,
      takesBullish: rows.filter(r => r.trader_decision === 'TAKE' && r.signal === 'BULLISH').length,
      takesBearish: rows.filter(r => r.trader_decision === 'TAKE' && r.signal === 'BEARISH').length,
    }

    // Recent — already sorted desc, take top 20
    const recent: RecentVerdict[] = rows.slice(0, 20).map(r => ({
      id: r.id,
      ticker: r.ticker,
      signal: r.signal,
      confidence: r.confidence,
      trader_decision: r.trader_decision,
      trader_grade: r.trader_grade,
      trader_risk_reward: r.trader_risk_reward !== null ? Number(r.trader_risk_reward.toFixed(2)) : null,
      entry_price: r.entry_price,
      stop_loss: r.stop_loss,
      take_profit: r.take_profit,
      timeframe: r.timeframe,
      pass_reason_short: Array.isArray(r.trader_pass_reasons) && r.trader_pass_reasons.length > 0
        ? r.trader_pass_reasons[0].slice(0, 150)
        : null,
      created_at: r.created_at,
    }))

    // Pass reasons aggregation
    const categoryMap = new Map<string, { count: number; sample: string }>()
    for (const r of rows) {
      if (r.trader_decision !== 'PASS' && r.trader_decision !== 'WAIT') continue
      if (!Array.isArray(r.trader_pass_reasons) || r.trader_pass_reasons.length === 0) continue
      for (const reason of r.trader_pass_reasons) {
        if (typeof reason !== 'string') continue
        const cat = categorizePassReason(reason)
        const existing = categoryMap.get(cat)
        if (existing) {
          existing.count++
        } else {
          categoryMap.set(cat, { count: 1, sample: reason.slice(0, 120) })
        }
      }
    }
    const passReasons: PassReasonCategory[] = Array.from(categoryMap.entries())
      .map(([category, v]) => ({ category, count: v.count, sample: v.sample }))
      .sort((a, b) => b.count - a.count)

    return NextResponse.json({
      ok: true,
      kpis,
      recent,
      passReasons,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[dashboard/verdicts] failed:', msg)
    return NextResponse.json({
      ok: false, error: msg.slice(0, 200),
      kpis: emptyKpis(), recent: [], passReasons: [],
    })
  }
}

function emptyKpis(): VerdictsKpis {
  return {
    total: 0, takes: 0, passes: 0, waits: 0,
    bullish: 0, bearish: 0, takesBullish: 0, takesBearish: 0,
  }
}
