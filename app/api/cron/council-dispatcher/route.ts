// =============================================================
// app/api/cron/council-dispatcher/route.ts
//
// The single throttle for all Council load. Every ~1 min it:
//   1. recovers crashed jobs (expired leases -> requeue or fail)
//   2. per pool: launch = min(pending, max_concurrency - inflight)   <- adaptive
//   3. atomically claims that many jobs and fires concurrent /api/analyze calls
//   4. marks each done / requeued / failed
//
// Global concurrency = sum of pool max_concurrency. Tune by editing council_pools.
// ?dryRun=1 reports what it WOULD launch without claiming anything.
// Auth: Authorization: Bearer ${CRON_SECRET}
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const LEASE_SECONDS = 180        // covers a ~90-120s analyze + margin
const ANALYZE_TIMEOUT_MS = 120_000

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}
function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

interface PoolRow { name: string; priority: number; max_concurrency: number; enabled: boolean }
interface Job {
  id: number; user_id: string; ticker: string; asset_type: string | null
  source: string | null; pool: string; timeframe: string; persona: string
  attempts: number; max_attempts: number
}

async function runAnalyze(job: Job): Promise<{ ok: boolean; error?: string }> {
  const rawBase = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '')
  if (!rawBase) return { ok: false, error: 'APP_BASE_URL not set' }
  const baseUrl = /^https?:\/\//.test(rawBase) ? rawBase : `https://${rawBase}`
  try {
    const res = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Trigger': 'council-dispatcher',
        'X-Service-User-Id': job.user_id,
        'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
      },
      body: JSON.stringify({
        ticker: job.ticker, userId: job.user_id,
        timeframe: job.timeframe, persona: job.persona, source: job.source,
      }),
      signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
    })
    return res.ok ? { ok: true } : { ok: false, error: `analyze HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }

async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const db = admin()
  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'

  // 1. recover crashed jobs
  await db.rpc('recover_council_leases')

  // 2. read pools (highest priority first)
  const { data: pools, error: poolErr } = await db
    .from('council_pools').select('*').eq('enabled', true).order('priority', { ascending: true })
  if (poolErr) return NextResponse.json({ error: poolErr.message }, { status: 500 })

  const summary: Array<{ pool: string; pending: number; inflight: number; maxConcurrency: number; launching: number }> = []
  const claimed: Job[] = []

  for (const pool of (pools ?? []) as PoolRow[]) {
    const { count: inflight } = await db.from('council_queue')
      .select('id', { count: 'exact', head: true }).eq('pool', pool.name).eq('status', 'running')
    const { count: pending } = await db.from('council_queue')
      .select('id', { count: 'exact', head: true }).eq('pool', pool.name).eq('status', 'pending')

    const budget = Math.max(0, pool.max_concurrency - (inflight ?? 0))
    const launching = Math.min(pending ?? 0, budget)
    summary.push({ pool: pool.name, pending: pending ?? 0, inflight: inflight ?? 0, maxConcurrency: pool.max_concurrency, launching })

    if (!dryRun && launching > 0) {
      const { data: jobs, error } = await db.rpc('claim_council_jobs', {
        p_pool: pool.name, p_limit: launching, p_lease_seconds: LEASE_SECONDS,
      })
      if (error) console.warn(`[dispatcher] claim ${pool.name} failed:`, error.message)
      for (const j of (jobs ?? []) as Job[]) claimed.push(j)
    }
  }

  // 3. fire all claimed jobs concurrently (global concurrency = sum of budgets)
  let done = 0, requeued = 0, failed = 0
  if (!dryRun && claimed.length > 0) {
    await Promise.allSettled(claimed.map(async (job) => {
      const r = await runAnalyze(job)
      if (r.ok) {
        done++
        await db.from('council_queue').update({ status: 'done', finished_at: new Date().toISOString() }).eq('id', job.id)
      } else if ((job.attempts ?? 0) < (job.max_attempts ?? 3)) {
        requeued++   // attempts already incremented by the claim; retry next cycle
        await db.from('council_queue').update({ status: 'pending', lease_until: null, error: r.error ?? null }).eq('id', job.id)
      } else {
        failed++
        await db.from('council_queue').update({ status: 'failed', finished_at: new Date().toISOString(), error: r.error ?? null }).eq('id', job.id)
      }
    }))
  }

  console.log(`[dispatcher] claimed=${claimed.length} done=${done} requeued=${requeued} failed=${failed}${dryRun ? ' (dryRun)' : ''}`)
  return NextResponse.json({ dryRun, pools: summary, claimed: claimed.length, done, requeued, failed })
}
