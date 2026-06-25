// =============================================================
// app/api/cron/earnings-watch/route.ts
//
// Phase 1 of the pre-earnings run-up tracker.
//
// Pulls Finnhub's MARKET-WIDE earnings calendar for the next
// LOOKAHEAD_DAYS (no symbol param = every company reporting in the
// window), applies a light structural filter (US-listed ticker shape +
// future-or-today date), and upserts each event into earnings_watch.
//
// Dedup is on the EVENT (ticker + fiscal_year + fiscal_quarter), so a
// report-date drift updates the same row in place and bumps drift_count
// rather than creating a duplicate. first_seen_at is preserved across
// pulls ("tracking since").
//
// Idempotent — safe to run daily. A daily cadence is recommended: it lets
// provisional dates firm up, tracks drift, and refreshes estimates, for
// only 1 Finnhub call. Liquidity / share-price / options gating is NOT done
// here — it belongs in the daily signal phase, where per-symbol quotes are
// fetched anyway, and only for the near-term subset (cheap). Phase 1 just
// captures the field broadly.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const FINNHUB_BASE = 'https://finnhub.io/api/v1'
const LOOKAHEAD_DAYS = 14
// US-listed common-stock ticker shape (mirrors isStockTicker in decide.ts).
// Drops OTC / foreign / preferred clutter that fills the raw calendar.
const STOCK_RE = /^[A-Z]{1,5}(\.[A-Z])?$/

interface FinnhubEarningsRow {
  date: string
  symbol: string
  hour?: string | null
  epsEstimate?: number | null
  revenueEstimate?: number | null
  quarter?: number | null
  year?: number | null
}

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0]
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const KEY = process.env.FINNHUB_API_KEY
  if (!KEY) return NextResponse.json({ error: 'FINNHUB_API_KEY not set' }, { status: 500 })

  const startedAt = Date.now()
  const today = new Date()
  const from = isoDate(today)
  const to = isoDate(new Date(today.getTime() + LOOKAHEAD_DAYS * 86400000))

  // 1. Pull the market-wide calendar (no symbol = every reporter in the window)
  let rows: FinnhubEarningsRow[] = []
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20_000)
    try {
      const res = await fetch(
        `${FINNHUB_BASE}/calendar/earnings?from=${from}&to=${to}&token=${KEY}`,
        { signal: ctrl.signal },
      )
      if (!res.ok) {
        return NextResponse.json({ error: `Finnhub HTTP ${res.status}` }, { status: 502 })
      }
      const json = (await res.json()) as { earningsCalendar?: FinnhubEarningsRow[] }
      rows = Array.isArray(json.earningsCalendar) ? json.earningsCalendar : []
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Finnhub fetch failed' },
      { status: 502 },
    )
  }

  const pulled = rows.length

  // 2. Light structural filter: US-listed ticker shape + future-or-today date
  const kept = rows.filter(
    r =>
      typeof r.symbol === 'string' &&
      STOCK_RE.test(r.symbol) &&
      typeof r.date === 'string' &&
      r.date >= from,
  )

  // 3. Read existing watch rows to preserve first_seen_at and detect drift.
  //    Keyed by ticker|fiscal_year|fiscal_quarter (the event identity).
  const admin = await getSupabaseAdmin()
  const lookbackFrom = isoDate(new Date(today.getTime() - 2 * 86400000))
  const { data: existingRows } = await admin
    .from('earnings_watch')
    .select('ticker, fiscal_year, fiscal_quarter, report_date, drift_count, first_seen_at')
    .gte('report_date', lookbackFrom)

  const existing = new Map<
    string,
    { report_date: string; drift_count: number; first_seen_at: string }
  >()
  for (const e of existingRows ?? []) {
    existing.set(`${e.ticker}|${e.fiscal_year}|${e.fiscal_quarter}`, {
      report_date: e.report_date,
      drift_count: e.drift_count ?? 0,
      first_seen_at: e.first_seen_at,
    })
  }

  // 4. Build upsert payload. Dedup on ticker+year+quarter; report_date drifts
  //    in place. Prefer Finnhub's fiscal year/quarter; fall back to deriving
  //    them from the report date when missing.
  const nowIso = new Date().toISOString()
  const seen = new Set<string>()
  const finalRows: Array<Record<string, unknown>> = []
  for (const r of kept) {
    const d = new Date(`${r.date}T00:00:00Z`)
    const fy = r.year && Number.isFinite(r.year) ? r.year : d.getUTCFullYear()
    const fq =
      r.quarter && r.quarter >= 1 && r.quarter <= 4
        ? r.quarter
        : Math.ceil((d.getUTCMonth() + 1) / 3)
    const key = `${r.symbol}|${fy}|${fq}`
    if (seen.has(key)) continue // Finnhub can list the same event on multiple rows
    seen.add(key)

    const prior = existing.get(key)
    const drifted = !!prior && prior.report_date !== r.date
    finalRows.push({
      ticker: r.symbol,
      fiscal_year: fy,
      fiscal_quarter: fq,
      report_date: r.date,
      prev_report_date: drifted ? prior!.report_date : null,
      report_hour: r.hour ?? null,
      eps_estimate: typeof r.epsEstimate === 'number' ? r.epsEstimate : null,
      revenue_estimate: typeof r.revenueEstimate === 'number' ? r.revenueEstimate : null,
      drift_count: prior ? (drifted ? prior.drift_count + 1 : prior.drift_count) : 0,
      first_seen_at: prior?.first_seen_at ?? nowIso,
      last_seen_at: nowIso,
      updated_at: nowIso,
    })
  }

  let upserted = 0
  if (finalRows.length > 0) {
    const { error } = await admin
      .from('earnings_watch')
      .upsert(finalRows, { onConflict: 'ticker,fiscal_year,fiscal_quarter' })
    if (error) {
      return NextResponse.json(
        { error: `upsert failed: ${error.message}`, pulled, kept: kept.length },
        { status: 500 },
      )
    }
    upserted = finalRows.length
  }

  // 5. Housekeeping: events whose date has passed but are still 'watching'
  //    (or later in-flight states) get marked 'reported' so the table reflects
  //    truth and future phases ignore them.
  let reported = 0
  const { data: reportedRows, error: repErr } = await admin
    .from('earnings_watch')
    .update({ status: 'reported', updated_at: nowIso })
    .lt('report_date', from)
    .in('status', ['watching', 'analyzed', 'entered'])
    .select('id')
  if (!repErr) reported = (reportedRows ?? []).length

  const durationMs = Date.now() - startedAt
  const sample = finalRows
    .slice()
    .sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)))
    .slice(0, 10)
    .map(r => ({
      ticker: r.ticker,
      date: r.report_date,
      hour: r.report_hour,
      epsEst: r.eps_estimate,
      drift: r.drift_count,
    }))

  console.log(
    `[earnings-watch] window ${from}..${to} pulled=${pulled} kept=${kept.length} ` +
      `upserted=${upserted} reported=${reported} in ${durationMs}ms`,
  )
  return NextResponse.json({
    ok: true,
    window: { from, to },
    pulled,
    kept: kept.length,
    upserted,
    reported,
    durationMs,
    sample,
  })
}
