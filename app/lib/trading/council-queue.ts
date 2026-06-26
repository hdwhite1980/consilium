// =============================================================
// app/lib/trading/council-queue.ts
// Shared enqueue helper. Discovery lanes call this instead of POSTing /api/analyze
// directly; the council-dispatcher cron drains the queue with per-pool concurrency.
// =============================================================

import { createClient } from '@supabase/supabase-js'

export type Pool = 'high' | 'normal' | 'low'
export type CouncilTimeframe = '1D' | '1W' | '1M'
export type EnqueueResult = 'enqueued' | 'duplicate' | 'recently_analyzed' | 'error'

export interface EnqueueArgs {
  userId: string
  ticker: string                  // Council form, e.g. SOLUSD / EURUSD / SPY
  assetType: string
  source: string                  // lane id, e.g. live_movers_crypto
  pool: Pool
  timeframe: CouncilTimeframe
  persona?: string
  dedupHours?: number             // skip if analyzed within this window (default 4)
  force?: boolean                 // bypass the verdict_log dedup (testing / manual)
}

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

/**
 * Enqueue a Council analyze-job. Two-layer dedup:
 *   1. skip if a verdict already exists for this ticker within dedupHours (unless force)
 *   2. the unique partial index blocks a second live (pending/running) job
 */
export async function enqueueCouncil(args: EnqueueArgs): Promise<EnqueueResult> {
  const db = admin()
  const ticker = args.ticker.toUpperCase()
  const dedupHours = args.dedupHours ?? 4

  if (!args.force) {
    const cutoff = new Date(Date.now() - dedupHours * 3_600_000).toISOString()
    const { data: recent } = await db
      .from('verdict_log').select('id')
      .eq('user_id', args.userId).eq('ticker', ticker)
      .gte('created_at', cutoff).limit(1)
    if (recent && recent.length > 0) return 'recently_analyzed'
  }

  const { error } = await db.from('council_queue').insert({
    user_id: args.userId,
    ticker,
    asset_type: args.assetType,
    source: args.source,
    pool: args.pool,
    timeframe: args.timeframe,
    persona: args.persona ?? 'balanced',
    dedup_key: `${args.userId}:${ticker}`,
  })
  if (error) {
    if (error.code === '23505') return 'duplicate'   // unique_violation: already queued
    console.warn('[enqueueCouncil] insert error:', error.message)
    return 'error'
  }
  return 'enqueued'
}
