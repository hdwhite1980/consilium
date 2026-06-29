// =============================================================
// app/api/track-record/verdicts/route.ts
//
// GET /api/track-record/verdicts
//
// Query params:
//   - version=<n|all>     : filter by version_number (default: all)
//   - signal=<BULLISH|BEARISH|all>
//   - outcome=<win|loss|expired|pending|all>  : filtered on outcome_1w_strict
//   - page=<n>            : 1-indexed page number (default: 1)
//   - pageSize=<n>        : default 20, max 50
//
// Returns paginated verdict rows with:
//   - core fields (ticker, signal, confidence, entry/stop/target)
//   - trader decision/grade
//   - 1d and 1w outcomes (strict + directional)
//   - version metadata
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { getVersionByNumber } from '@/app/lib/system-versions'

export const runtime = 'nodejs'
export const maxDuration = 10

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50

interface VerdictRow {
  id: number
  ticker: string
  signal: string
  confidence: number | null
  entryPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  timeHorizon: string | null
  timeframe: string | null
  traderDecision: string | null
  traderGrade: string | null
  traderRiskReward: number | null
  outcome1dStrict: string | null
  outcome1dDirectional: string | null
  outcome1wStrict: string | null
  outcome1wDirectional: string | null
  outcome1wPrice: number | null
  versionNumber: number | null
  versionLabel: string | null
  createdAt: string
}

interface VerdictsPayload {
  rows: VerdictRow[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createAdmin(url, key)
}

export async function GET(req: NextRequest) {
  try {
    // NOTE: This endpoint is intentionally PUBLIC.
    //
    // Companion to the public /api/track-record/stats endpoint. The
    // track-record page is a conversion surface — anonymous visitors must
    // see both the aggregated stats AND the individual verdict receipts
    // before deciding whether to sign up. Gating verdicts behind auth
    // hides the proof that backs the stats numbers.
    //
    // The exposed data is per-verdict trade-plan metadata (entry/stop/target,
    // signal, confidence, outcome) — this is marketing-grade transparency,
    // analogous to what trading services publish in their track record
    // pages. No PII, no user accounts, no sensitive system internals.
    //
    // The previous 401 broke the page's primary purpose. If email
    // collection is ever wanted on this surface, it should be a softer
    // mechanism (e.g., inline newsletter form) rather than a hard wall.

    const url = new URL(req.url)
    const versionParam = url.searchParams.get('version') ?? 'all'
    const signalParam = url.searchParams.get('signal') ?? 'all'
    const outcomeParam = url.searchParams.get('outcome') ?? 'all'
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(url.searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE),
    )

    const admin = getAdmin()

    let q = admin
      .from('verdict_log')
      .select(
        `id, ticker, signal, confidence,
         entry_price, stop_loss, take_profit,
         time_horizon, timeframe,
         trader_decision, trader_grade, trader_risk_reward,
         outcome_1d_strict, outcome_1d_directional,
         outcome_1w_strict, outcome_1w_directional, outcome_1w_price,
         version_number, code_era, created_at`,
        { count: 'exact' },
      )
      // Only directional calls — NEUTRAL verdicts have no trade plan
      .in('signal', ['BULLISH', 'BEARISH'])

    // Max (day_shark) is measured separately — exclude by default; opt in via ?source=day_shark
    const sourceParam = url.searchParams.get('source')
    if (sourceParam === 'day_shark') q = q.eq('source', 'day_shark')
    else q = q.or('source.is.null,source.neq.day_shark')

    if (versionParam !== 'all') {
      const n = parseInt(versionParam, 10)
      if (!Number.isNaN(n)) {
        q = q.eq('version_number', n)
      }
    }

    if (signalParam !== 'all' && (signalParam === 'BULLISH' || signalParam === 'BEARISH')) {
      q = q.eq('signal', signalParam)
    }

    if (outcomeParam !== 'all') {
      if (outcomeParam === 'pending') {
        // pending = no outcome computed yet (NULL)
        q = q.is('outcome_1w_strict', null)
      } else if (['win', 'loss', 'expired'].includes(outcomeParam)) {
        q = q.eq('outcome_1w_strict', outcomeParam)
      }
    }

    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    const { data, count, error } = await q
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) {
      console.error('[track-record/verdicts] Query failed:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const rows: VerdictRow[] = (data ?? []).map(r => {
      const versionMeta = r.version_number ? getVersionByNumber(r.version_number) : null
      return {
        id: r.id,
        ticker: r.ticker,
        signal: r.signal,
        confidence: numericOrNull(r.confidence),
        entryPrice: numericOrNull(r.entry_price),
        stopLoss: numericOrNull(r.stop_loss),
        takeProfit: numericOrNull(r.take_profit),
        timeHorizon: r.time_horizon ?? null,
        timeframe: r.timeframe ?? null,
        traderDecision: r.trader_decision ?? null,
        traderGrade: r.trader_grade ?? null,
        traderRiskReward: numericOrNull(r.trader_risk_reward),
        outcome1dStrict: r.outcome_1d_strict ?? null,
        outcome1dDirectional: r.outcome_1d_directional ?? null,
        outcome1wStrict: r.outcome_1w_strict ?? null,
        outcome1wDirectional: r.outcome_1w_directional ?? null,
        outcome1wPrice: numericOrNull(r.outcome_1w_price),
        versionNumber: r.version_number ?? null,
        versionLabel: versionMeta?.label ?? (r.code_era ?? null),
        createdAt: r.created_at,
      }
    })

    const total = count ?? 0
    const totalPages = Math.max(1, Math.ceil(total / pageSize))

    const payload: VerdictsPayload = {
      rows,
      page,
      pageSize,
      total,
      totalPages,
    }

    return NextResponse.json(payload, {
      // Public cache: response is identical for all visitors. Short window
      // (60s) because new verdicts can arrive any time and visitors expect
      // recent data to appear quickly.
      headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60' },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[track-record/verdicts] Error:', msg)
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 })
  }
}

// PG NUMERIC may serialize as string; coerce defensively
function numericOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
