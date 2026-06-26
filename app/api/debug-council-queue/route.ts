// =============================================================
// app/api/debug-council-queue/route.ts
// Read-only view of the Council queue — watch it breathe.
//   GET  -> per-pool depth + how many workers the dispatcher WOULD launch,
//           recent throughput, and a sample of recent jobs.
// Auth: Authorization: Bearer ${CRON_SECRET}
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}
function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const db = admin()

  const { data: pools } = await db.from('council_pools').select('*').order('priority', { ascending: true })

  const poolDepth = []
  for (const pool of (pools ?? [])) {
    const { count: pending } = await db.from('council_queue')
      .select('id', { count: 'exact', head: true }).eq('pool', pool.name).eq('status', 'pending')
    const { count: running } = await db.from('council_queue')
      .select('id', { count: 'exact', head: true }).eq('pool', pool.name).eq('status', 'running')
    const budget = Math.max(0, pool.max_concurrency - (running ?? 0))
    poolDepth.push({
      pool: pool.name,
      enabled: pool.enabled,
      maxConcurrency: pool.max_concurrency,
      pending: pending ?? 0,
      running: running ?? 0,
      wouldLaunch: Math.min(pending ?? 0, budget),
    })
  }

  const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
  const { count: doneLastHour } = await db.from('council_queue')
    .select('id', { count: 'exact', head: true }).eq('status', 'done').gte('finished_at', hourAgo)
  const { count: failedLastHour } = await db.from('council_queue')
    .select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('finished_at', hourAgo)

  const { data: recent } = await db.from('council_queue')
    .select('id, ticker, asset_type, source, pool, timeframe, status, attempts, created_at')
    .order('created_at', { ascending: false }).limit(15)

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    globalMaxConcurrency: (pools ?? []).reduce((s, p) => s + (p.enabled ? p.max_concurrency : 0), 0),
    pools: poolDepth,
    lastHour: { done: doneLastHour ?? 0, failed: failedLastHour ?? 0 },
    recent: recent ?? [],
  })
}
