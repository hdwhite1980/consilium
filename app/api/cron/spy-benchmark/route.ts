// =============================================================
// app/api/cron/spy-benchmark/route.ts
//
// Computes SPY's return over each resolved verdict's 1-week window and caches it
// on verdict_log.spy_return_1w. The stats endpoint then derives alpha (strategy
// return − SPY return) DB-only. Backfills existing rows and keeps new ones current.
//
// For each verdict: SPY entry close = last SPY close on/before verdict_date;
// SPY exit close = first SPY close on/after verdict_date + 7 calendar days.
// spy_return_1w = exit/entry − 1.
//
// Auth: Authorization: Bearer ${CRON_SECRET}   ?limit=2000  &force=1 (recompute all)
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ALPACA_BASE = process.env.ALPACA_BASE_URL || 'https://data.alpaca.markets'

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}
function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

interface SpyBar { date: string; close: number }

// Fetch SPY daily closes over [start, end] (YYYY-MM-DD), sorted ascending.
async function fetchSpyBars(startStr: string, endStr: string): Promise<SpyBar[]> {
  const apiKey = process.env.ALPACA_API_KEY, apiSecret = process.env.ALPACA_SECRET_KEY
  if (!apiKey || !apiSecret) return []
  const headers = { 'APCA-API-KEY-ID': apiKey, 'APCA-API-SECRET-KEY': apiSecret, 'Accept': 'application/json' }
  for (const feed of ['sip', 'iex']) {
    try {
      const url = `${ALPACA_BASE}/v2/stocks/SPY/bars?timeframe=1Day&start=${startStr}&end=${endStr}&limit=10000&adjustment=all&feed=${feed}`
      const res = await fetch(url, { headers, cache: 'no-store' })
      if (!res.ok) continue
      const data = await res.json()
      const bars = (data.bars ?? []) as Array<{ t: string; c: number }>
      if (bars.length === 0) continue
      return bars
        .map(b => ({ date: String(b.t).split('T')[0], close: Number(b.c) }))
        .filter(b => b.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date))
    } catch { /* try next feed */ }
  }
  return []
}

// Last close on/before target date.
function closeOnOrBefore(bars: SpyBar[], dateStr: string): number | null {
  let found: number | null = null
  for (const b of bars) { if (b.date <= dateStr) found = b.close; else break }
  return found
}
// First close on/after target date.
function closeOnOrAfter(bars: SpyBar[], dateStr: string): number | null {
  for (const b of bars) if (b.date >= dateStr) return b.close
  return null
}
function plusDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split('T')[0]
}

async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') ?? '2000')))
  const force = url.searchParams.get('force') === '1'

  const db = admin()
  // Resolved verdicts (have a 1W price) that still need a SPY benchmark.
  let q = db.from('verdict_log')
    .select('id, verdict_date')
    .not('verdict_date', 'is', null)
    .not('outcome_1w_price', 'is', null)
    .order('verdict_date', { ascending: true })
    .limit(limit)
  if (!force) q = q.is('spy_return_1w', null)

  const { data: verdicts, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!verdicts || verdicts.length === 0) return NextResponse.json({ ok: true, computed: 0, note: 'nothing to benchmark' })

  const dates = verdicts.map(v => String(v.verdict_date).split('T')[0]).sort()
  const rangeStart = plusDays(dates[0], -7)
  const rangeEnd = plusDays(dates[dates.length - 1], 14)
  const bars = await fetchSpyBars(rangeStart, rangeEnd)
  if (bars.length === 0) return NextResponse.json({ error: 'SPY bars unavailable' }, { status: 502 })

  let computed = 0, skipped = 0
  for (const v of verdicts) {
    const d = String(v.verdict_date).split('T')[0]
    const entryClose = closeOnOrBefore(bars, d)
    const exitClose = closeOnOrAfter(bars, plusDays(d, 7))
    if (!entryClose || !exitClose || entryClose <= 0) { skipped++; continue }
    const spyReturn = exitClose / entryClose - 1
    await db.from('verdict_log').update({ spy_return_1w: Number(spyReturn.toFixed(6)) }).eq('id', v.id)
    computed++
  }

  return NextResponse.json({ ok: true, computed, skipped, considered: verdicts.length, barsLoaded: bars.length })
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }
