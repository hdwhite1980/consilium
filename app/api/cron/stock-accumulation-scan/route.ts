// =============================================================
// app/api/cron/stock-accumulation-scan/route.ts
//
// Equity accumulation scan — the stock counterpart to crypto-accumulation-scan,
// running the SAME weekly-trend engine the OOS backtest validated on stocks.
// Scans a slice of the curated liquid universe so several schedules cover the
// whole ~500 names without any single call timing out.
//
//   GET ?offset=0&limit=130     -> scan that slice, upsert results
//   GET ?view=1                 -> browse stored results (no scan)
//        &cap=mega &phase=accumulation &minStrength=50 &limit=100
//
// Suggested schedules (4 slices): offset=0,130,260,390 (limit=130), staggered.
// Auth: Authorization: Bearer ${CRON_SECRET}
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { runStockAccumulationScan } from '@/app/lib/signals/weekly-trend'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}
function getAdmin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }

async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const admin = getAdmin()

  // ── Browse mode ──
  if (url.searchParams.get('view') === '1') {
    let q = admin.from('stock_accumulation_scan').select('*')
    const cap = url.searchParams.get('cap')
    const phase = url.searchParams.get('phase')
    const minStrength = url.searchParams.get('minStrength')
    if (cap) q = q.eq('band', cap)
    if (phase) q = q.eq('phase', phase)
    if (minStrength) q = q.gte('strength', Number(minStrength))
    const limit = Number(url.searchParams.get('limit') ?? '100')
    const { data, error } = await q.order('strength', { ascending: false }).limit(limit)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ mode: 'view', count: data?.length ?? 0, rows: data ?? [] })
  }

  // ── Scan mode: one universe slice ──
  // QStash-friendly single param: ?slice=0 .. ?slice=3 (each = limit-sized window).
  // Or explicit ?offset=&limit=.
  const limit = Number(url.searchParams.get('limit') ?? '130')
  const sliceIdx = url.searchParams.get('slice')
  const offset = sliceIdx != null ? Math.max(0, Number(sliceIdx)) * limit : Number(url.searchParams.get('offset') ?? '0')

  const start = Date.now()
  let scanned = 0
  let persisted = 0
  let errorMessage: string | undefined

  try {
    const { reads } = await runStockAccumulationScan({ offset, limit })
    scanned = reads.length

    const now = new Date().toISOString()
    const rows = reads.map(r => ({
      symbol: r.symbol,
      base_symbol: r.symbol,
      band: r.cap,
      sector: r.sector,
      price: 0,
      price_change_recent_pct: r.priceChangeRecentPct,
      phase: r.phase,
      bias: r.bias,
      strength: r.strength,
      has_history: r.ok,
      note: r.note,
      scanned_at: now,
    }))

    if (rows.length > 0) {
      const { error } = await admin.from('stock_accumulation_scan').upsert(rows, { onConflict: 'symbol' })
      if (error) throw new Error(`upsert failed: ${error.message}`)
      persisted = rows.length
    }
    console.log(`[stock-accum-scan] offset=${offset} limit=${limit} scanned=${scanned} persisted=${persisted} in ${Date.now() - start}ms`)
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e)
    console.error(`[stock-accum-scan] offset=${offset} failed:`, errorMessage)
  }

  return NextResponse.json({
    mode: 'scan', offset, limit, scanned, persisted,
    durationMs: Date.now() - start,
    ...(errorMessage ? { error: errorMessage } : {}),
  }, { status: errorMessage ? 500 : 200 })
}
