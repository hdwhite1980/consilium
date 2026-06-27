// =============================================================
// app/api/cron/verdict-memory-sync/route.ts
//
// Backfills the `features` snapshot on RESOLVED verdicts that don't have one yet,
// by matching the analyses row's signal_bundle for that ticker+date. Runs
// out-of-band so the analyze hot path stays untouched. Idempotent; ?limit= per run.
//
// A verdict with features=null and a decided outcome is "unprocessed"; once a
// snapshot is written (even an all-null one when no bundle is found) it won't be
// reprocessed. This is what makes verdict_log a methodology-locked memory store.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { extractVerdictFeatures } from '@/app/lib/learning/verdict-features'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}
function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }

async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const limit = Number(url.searchParams.get('limit') ?? '100')
  const db = admin()

  // Resolved verdicts still missing a features snapshot.
  const { data: pending, error } = await db.from('verdict_log')
    .select('id, ticker, verdict_date')
    .in('outcome_1w_directional', ['win', 'loss'])
    .is('features', null)
    .order('verdict_date', { ascending: false })
    .limit(limit)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  let updated = 0, noBundle = 0
  for (const v of (pending ?? []) as Array<{ id: number; ticker: string; verdict_date: string }>) {
    // Closest analyses row for this ticker on the verdict date.
    const { data: a } = await db.from('analyses')
      .select('signal_bundle')
      .eq('ticker', v.ticker)
      .gte('created_at', `${v.verdict_date}T00:00:00Z`)
      .lte('created_at', `${v.verdict_date}T23:59:59Z`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const bundle = (a as { signal_bundle?: unknown } | null)?.signal_bundle ?? null
    if (!bundle) noBundle++
    const features = extractVerdictFeatures(bundle)
    await db.from('verdict_log').update({ features }).eq('id', v.id)
    updated++
  }

  return NextResponse.json({
    scanned: pending?.length ?? 0,
    updated,
    noBundleMatch: noBundle,
    note: 'Backfilled feature snapshots on resolved verdicts. Dormant substrate — not wired into the Council.',
  })
}
