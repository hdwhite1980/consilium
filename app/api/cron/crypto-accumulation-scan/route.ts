// =============================================================
// app/api/cron/crypto-accumulation-scan/route.ts
//
// Tiered crypto accumulation scan. One parameterized cron, driven by several
// QStash schedules — one per liquidity band — so the whole universe gets covered
// without any single call timing out, and liquid bands can run more often than
// the dust.
//
//   GET ?min=2&max=4        -> scan the $2M–$4M band, upsert results
//   GET ?min=10             -> scan the $10M+ band (no upper cap)
//   GET ?view=1             -> browse stored results (no scan)
//        &band=2-4M &phase=accumulation &minStrength=45 &limit=100
//
// Bands (USD 24h volume, in millions): 0-2, 2-4, 4-8, 8-10, 10+
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { runAccumulationScan } from '@/app/lib/signals/weekly-trend'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createAdmin(url, key)
}

function bandLabel(minM: number, maxM: number | null): string {
  return maxM == null ? `${minM}+M` : `${minM}-${maxM}M`
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }

async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const url = new URL(req.url)
  const admin = getAdmin()

  // ── Browse mode: read stored results, no scan ──
  if (url.searchParams.get('view') === '1') {
    let q = admin.from('crypto_accumulation_scan').select('*')
    const band = url.searchParams.get('band')
    const phase = url.searchParams.get('phase')
    const minStrength = url.searchParams.get('minStrength')
    if (band) q = q.eq('band', band)
    if (phase) q = q.eq('phase', phase)
    if (minStrength) q = q.gte('strength', Number(minStrength))
    const limit = Number(url.searchParams.get('limit') ?? '100')
    const { data, error } = await q.order('strength', { ascending: false }).limit(limit)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ mode: 'view', count: data?.length ?? 0, rows: data ?? [] })
  }

  // ── Scan mode: scan one liquidity band and persist ──
  const minM = Number(url.searchParams.get('min') ?? '0')
  const maxParam = url.searchParams.get('max')
  const maxM = maxParam == null || maxParam === '' ? null : Number(maxParam)
  const minVolumeUsd = minM * 1_000_000
  const maxVolumeUsd = maxM == null ? undefined : maxM * 1_000_000
  const universeLimit = Number(url.searchParams.get('limit') ?? '150')
  const band = bandLabel(minM, maxM)

  const start = Date.now()
  let persisted = 0
  let scanned = 0
  let found = 0
  let errorMessage: string | undefined

  try {
    const scan = await runAccumulationScan({
      minVolumeUsd,
      maxVolumeUsd,
      universeLimit,
      minStrength: 0,        // store every coin's read; filter on read-back
    })
    scanned = scan.scanned
    found = scan.picks.length

    const now = new Date().toISOString()
    // Persist every analyzed coin (full band view), keyed by symbol.
    const rows = scan.scannedReads.map(r => ({
      symbol: `${r.symbol}-USD`,
      base_symbol: r.symbol,
      band,
      price: r.price,
      volume_usd_24h: r.volumeUsd24h,
      price_change_24h: r.priceChange24h,
      phase: r.phase,
      bias: r.bias,
      strength: r.strength,
      is_new: r.isNew,
      has_history: r.ok,
      note: r.note,
      scanned_at: now,
    }))
    // Also record brand-new coins that had no weekly read at all.
    for (const n of scan.newCoins) {
      if (rows.some(row => row.base_symbol === n.symbol)) continue
      rows.push({
        symbol: `${n.symbol}-USD`, base_symbol: n.symbol, band,
        price: 0, volume_usd_24h: n.volumeUsd24h, price_change_24h: n.priceChange24h,
        phase: 'neutral', bias: 'neutral', strength: 0, is_new: true,
        has_history: false, note: 'new listing — insufficient history for weekly read',
        scanned_at: now,
      })
    }

    if (rows.length > 0) {
      const { error } = await admin.from('crypto_accumulation_scan').upsert(rows, { onConflict: 'symbol' })
      if (error) throw new Error(`upsert failed: ${error.message}`)
      persisted = rows.length
    }
    console.log(`[crypto-accum-scan] band=${band} scanned=${scanned} found=${found} persisted=${persisted} in ${Date.now() - start}ms`)
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e)
    console.error(`[crypto-accum-scan] band=${band} failed:`, errorMessage)
  }

  return NextResponse.json({
    mode: 'scan', band, scanned, found, persisted,
    durationMs: Date.now() - start,
    ...(errorMessage ? { error: errorMessage } : {}),
  }, { status: errorMessage ? 500 : 200 })
}
