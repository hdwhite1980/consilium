// =============================================================
// app/api/cron/earnings-signal/route.ts
//
// Phase 2 of the pre-earnings run-up tracker.
//
// Runs daily over earnings_watch names within SIGNAL_WINDOW_DAYS of their
// report and snapshots the day's run-up signals into earnings_signal_log,
// so the TREND accumulates across the week:
//
//   1. fetchBars (daily)  -> price, avg dollar volume, 5d/10d drift   [cheap]
//   2. liquidity/price gate (from those bars)                          [free]
//   3. fetchOptionsFlow    -> P/C vol+OI, IV skew, options posture     [gated]
//   4. composite run-up score + bias (drift primary, options confirm)
//
// Sentiment is deferred to the Phase 3 council (columns left null here).
// Gated-out names are marked 'skipped' in earnings_watch so we don't re-pull
// bars for them every day; gated-in names are marked 'analyzed'.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { fetchBars } from '@/app/lib/data/alpaca'
import { fetchOptionsFlow } from '@/app/lib/signals/options-flow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// How far out we start snapshotting. The run-up window the user wants to ride
// is the last few days into the print; 5 calendar days gives the trend room to
// form while keeping the per-day universe small.
const SIGNAL_WINDOW_DAYS = 5
const MAX_NAMES = 60            // hard cap on names processed per run
const MAX_OPTIONS_FETCHES = 35 // cap on Tradier option-chain pulls per run

// Universe gates (NOT per-user position sizing — these decide whether a name is
// liquid/priced enough to be worth tracking and to have a usable options market)
const MIN_PRICE = 1                       // avoid true penny junk; low so small accounts keep optionality
const MIN_AVG_DOLLAR_VOLUME = 5_000_000   // $5M/day — needs a real options market for positioning signal

interface WatchRow {
  id: string
  ticker: string
  report_date: string
  status: string
}

function pctChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) return 0
  return ((to - from) / from) * 100
}

// One-off diagnostic: hit Tradier's expirations endpoint for a known-liquid
// name on BOTH bases and report raw status/body. A 401 on production with the
// key set => the token is a sandbox token (options-flow uses production when a
// key is present), which silently nulls every chain. Remove once resolved.
async function tradierProbe(): Promise<Record<string, unknown>> {
  const key = process.env.TRADIER_API_KEY
  if (!key) return { configured: false }
  const hit = async (base: string) => {
    try {
      const res = await fetch(
        `${base}/markets/options/expirations?symbol=DRI&includeAllRoots=true`,
        { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } },
      )
      const text = await res.text()
      return { status: res.status, ok: res.ok, bodySnippet: text.slice(0, 180) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'fetch failed' }
    }
  }
  return {
    configured: true,
    production: await hit('https://api.tradier.com/v1'),
    sandbox: await hit('https://sandbox.tradier.com/v1'),
  }
}

function tradingDaysTo(reportDate: string, today: Date): number {
  // Simple calendar-day delta is fine for ordering/labeling here.
  const r = new Date(`${reportDate}T00:00:00Z`).getTime()
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return Math.round((r - t) / 86400000)
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const today = new Date()
  const fromDate = today.toISOString().split('T')[0]
  const toDate = new Date(today.getTime() + SIGNAL_WINDOW_DAYS * 86400000)
    .toISOString()
    .split('T')[0]
  const snapshotDate = fromDate

  const admin = await getSupabaseAdmin()

  // 1. Near-term watch names that still need signal work (soonest first)
  const { data: watchRows, error: watchErr } = await admin
    .from('earnings_watch')
    .select('id, ticker, report_date, status')
    .in('status', ['watching', 'analyzed'])
    .gte('report_date', fromDate)
    .lte('report_date', toDate)
    .order('report_date', { ascending: true })
    .limit(MAX_NAMES)

  if (watchErr) {
    return NextResponse.json({ error: `watch read failed: ${watchErr.message}` }, { status: 500 })
  }
  const names = (watchRows ?? []) as WatchRow[]

  const nowIso = new Date().toISOString()
  const rows: Array<Record<string, unknown>> = []
  const gatedInIds: string[] = []
  const gatedOutIds: string[] = []
  let optionsFetches = 0
  // Diagnostics: is Tradier returning usable data, or is every name falling
  // back to neutral? withData = non-null P/C; empty = fetched but null; errors = threw.
  const optDiag = { configured: !!process.env.TRADIER_API_KEY, withData: 0, empty: 0, errors: 0 }
  const optSample: Array<{ ticker: string; pc: number | null; pcOi: number | null; skew: number | null }> = []

  for (const w of names) {
    const ticker = w.ticker
    const daysToReport = tradingDaysTo(w.report_date, today)
    const base: Record<string, unknown> = {
      earnings_watch_id: w.id,
      ticker,
      report_date: w.report_date,
      snapshot_date: snapshotDate,
      days_to_report: daysToReport,
      updated_at: nowIso,
    }

    // --- bars -> price / liquidity / drift ---
    let bars: Awaited<ReturnType<typeof fetchBars>> = []
    try {
      bars = await fetchBars(ticker, '1M') // daily bars, long history
    } catch {
      bars = []
    }
    if (bars.length < 12) {
      rows.push({ ...base, passes_gate: false, gate_reason: 'insufficient_history', runup_bias: 'neutral' })
      gatedOutIds.push(w.id)
      continue
    }

    const closes = bars.map(b => b.c)
    const n = closes.length
    const price = closes[n - 1]
    const drift5d = pctChange(closes[n - 6], price)
    const drift10d = pctChange(closes[n - 11], price)
    const last20 = bars.slice(-20)
    const avgDollarVol =
      last20.reduce((s, b) => s + b.c * b.v, 0) / Math.max(1, last20.length)

    const driftBias =
      drift5d >= 2 && drift10d >= 0 ? 'bullish' :
      drift5d <= -2 && drift10d <= 0 ? 'bearish' : 'neutral'

    // --- gate ---
    let gateReason: string | null = null
    if (price < MIN_PRICE) gateReason = `price ${price.toFixed(2)} < ${MIN_PRICE}`
    else if (avgDollarVol < MIN_AVG_DOLLAR_VOLUME)
      gateReason = `avg$vol ${(avgDollarVol / 1e6).toFixed(1)}M < ${(MIN_AVG_DOLLAR_VOLUME / 1e6).toFixed(0)}M`

    if (gateReason) {
      rows.push({
        ...base,
        price, avg_dollar_volume: Math.round(avgDollarVol),
        drift_5d: Number(drift5d.toFixed(2)), drift_10d: Number(drift10d.toFixed(2)),
        drift_bias: driftBias,
        passes_gate: false, gate_reason: gateReason, runup_bias: 'neutral',
      })
      gatedOutIds.push(w.id)
      continue
    }

    // --- options posture (gated in only; capped) ---
    let pcRatio: number | null = null
    let pcOiRatio: number | null = null
    let ivSkew: number | null = null
    let optionsBias = 'neutral'
    if (optionsFetches < MAX_OPTIONS_FETCHES) {
      optionsFetches++
      try {
        const of = await fetchOptionsFlow(ticker, price)
        pcRatio = of.putCallRatio
        pcOiRatio = of.putCallOIRatio
        ivSkew = of.ivSkew
        optionsBias = of.putCallSignal // 'bullish' | 'bearish' | 'neutral'
        if (pcRatio !== null) optDiag.withData++
        else optDiag.empty++
        if (optSample.length < 10) optSample.push({ ticker, pc: pcRatio, pcOi: pcOiRatio, skew: ivSkew })
      } catch {
        optionsBias = 'neutral'
        optDiag.errors++
      }
    }

    // --- composite: directional 0..100 (50 neutral), bias from drift confirmed by options ---
    let score = 50
    score += Math.max(-25, Math.min(25, drift5d * 2.5)) // drift magnitude (primary)
    score += drift10d > 0 ? 5 : drift10d < 0 ? -5 : 0    // longer-trend confirm
    score += optionsBias === 'bullish' ? 12 : optionsBias === 'bearish' ? -12 : 0
    score = Math.max(0, Math.min(100, Math.round(score)))

    const runupBias =
      driftBias === 'bullish' && optionsBias !== 'bearish' ? 'bullish' :
      driftBias === 'bearish' && optionsBias !== 'bullish' ? 'bearish' : 'neutral'

    rows.push({
      ...base,
      price, avg_dollar_volume: Math.round(avgDollarVol),
      drift_5d: Number(drift5d.toFixed(2)), drift_10d: Number(drift10d.toFixed(2)),
      drift_bias: driftBias,
      pc_ratio: pcRatio, pc_oi_ratio: pcOiRatio, iv_skew: ivSkew, options_bias: optionsBias,
      passes_gate: true, gate_reason: null,
      runup_score: score, runup_bias: runupBias,
    })
    gatedInIds.push(w.id)
  }

  // 2. Upsert snapshots (one per event per day)
  let upserted = 0
  if (rows.length > 0) {
    const { error } = await admin
      .from('earnings_signal_log')
      .upsert(rows, { onConflict: 'earnings_watch_id,snapshot_date' })
    if (error) {
      return NextResponse.json(
        { error: `signal upsert failed: ${error.message}`, processed: names.length },
        { status: 500 },
      )
    }
    upserted = rows.length
  }

  // 3. Advance earnings_watch status: gated-in -> analyzed, gated-out -> skipped
  //    (so we don't re-pull bars for illiquid names every day).
  if (gatedInIds.length > 0) {
    await admin.from('earnings_watch')
      .update({ status: 'analyzed', updated_at: nowIso })
      .in('id', gatedInIds)
  }
  if (gatedOutIds.length > 0) {
    await admin.from('earnings_watch')
      .update({ status: 'skipped', updated_at: nowIso })
      .in('id', gatedOutIds)
  }

  const durationMs = Date.now() - startedAt
  const topRunups = rows
    .filter(r => r.passes_gate)
    .sort((a, b) => (Number(b.runup_score) || 0) - (Number(a.runup_score) || 0))
    .slice(0, 10)
    .map(r => ({
      ticker: r.ticker, dte: r.days_to_report, score: r.runup_score, bias: r.runup_bias,
      drift5d: r.drift_5d, optBias: r.options_bias,
    }))

  console.log(
    `[earnings-signal] processed=${names.length} gatedIn=${gatedInIds.length} ` +
      `gatedOut=${gatedOutIds.length} optionsFetches=${optionsFetches} in ${durationMs}ms`,
  )
  return NextResponse.json({
    ok: true,
    window: { from: fromDate, to: toDate },
    processed: names.length,
    gatedIn: gatedInIds.length,
    gatedOut: gatedOutIds.length,
    optionsFetches,
    optionsDiag: optDiag,
    optionsSample: optSample,
    tradierProbe: await tradierProbe(),
    upserted,
    durationMs,
    topRunups,
  })
}
