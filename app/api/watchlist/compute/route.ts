// ═════════════════════════════════════════════════════════════
// app/api/watchlist/compute/route.ts
//
// Called by GitHub Actions cron every 15 minutes during market hours.
// For each active watchlist entry:
//   1. Run evaluateExit() to get technicals + Claude exit decision
//   2. Write result to watchlist_signals table
//
// Processes entries in parallel batches (10 at a time) so 50 stocks
// finish in ~30-60 seconds. Uses fire-and-forget response pattern
// so the HTTP call returns 202 immediately and work continues
// in the background. This dodges Railway's 30s proxy timeout.
//
// Auth: requires x-cron-secret header matching CRON_SECRET env var.
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { evaluateExit, type ExitEvaluation } from '@/app/lib/exit-signals'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ─────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('x-cron-secret') === secret
}

// ─────────────────────────────────────────────────────────────
// Core compute pass — run in background after returning 202
// ─────────────────────────────────────────────────────────────
async function runComputePass(): Promise<{
  entriesProcessed: number
  signalsWritten: number
  exitCount: number
  watchCount: number
  holdCount: number
  errors: number
}> {
  const admin = getAdmin()
  const started = Date.now()

  // Pull all active, unmuted watchlist entries
  const { data: entries, error } = await admin
    .from('watchlist_entries')
    .select('user_id, ticker')
    .eq('muted', false)
    .gt('expires_at', new Date().toISOString())
    .limit(500) // safety cap

  if (error) {
    throw new Error(`watchlist_entries fetch failed: ${error.message}`)
  }
  if (!entries || entries.length === 0) {
    return { entriesProcessed: 0, signalsWritten: 0, exitCount: 0, watchCount: 0, holdCount: 0, errors: 0 }
  }

  console.log(`[watchlist/compute] processing ${entries.length} entries`)

  // Process in parallel batches of 10 to avoid hammering Finnhub/Anthropic rate limits
  const BATCH_SIZE = 10
  const results: ExitEvaluation[] = []
  let errors = 0

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE)
    const batchStart = Date.now()

    const batchResults = await Promise.all(batch.map(async (e) => {
      try {
        const userId = e.user_id as string
        const ticker = e.ticker as string
        return await evaluateExit(userId, ticker)
      } catch (err) {
        console.warn(`[watchlist/compute] evaluateExit threw for ${e.ticker}:`, (err as Error).message?.slice(0, 100))
        errors++
        return null
      }
    }))

    for (const r of batchResults) {
      if (r) results.push(r)
      else errors++
    }

    console.log(`[watchlist/compute] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(entries.length / BATCH_SIZE)} done in ${Date.now() - batchStart}ms`)
  }

  // Insert all signals in bulk
  let signalsWritten = 0
  if (results.length > 0) {
    const rows = results.map(r => ({
      user_id: r.userId,
      ticker: r.ticker,
      computed_at: r.computedAt,
      exit_level: r.exitLevel,
      exit_confidence: r.exitConfidence,
      exit_reasons: r.exitReasons,
      exit_thesis_status: r.thesisStatus,
      current_price: r.currentPrice,
      price_change_1d_pct: r.priceChange1dPct,
      price_change_since_verdict_pct: r.priceChangeSinceVerdictPct,
      technicals: r.technicals,
      technical_bias: r.technicals.technicalBias,
      original_verdict_id: r.originalVerdictId,
      original_signal: r.originalSignal,
      original_confidence: r.originalConfidence,
    }))

    const { error: insertErr } = await admin
      .from('watchlist_signals')
      .insert(rows)

    if (insertErr) {
      console.error('[watchlist/compute] bulk insert failed:', insertErr.message)
      errors++
    } else {
      signalsWritten = rows.length
    }
  }

  const exitCount = results.filter(r => r.exitLevel === 'exit').length
  const watchCount = results.filter(r => r.exitLevel === 'watch').length
  const holdCount = results.filter(r => r.exitLevel === 'hold').length

  const elapsed = Date.now() - started
  console.log(`[watchlist/compute] TOTAL ${elapsed}ms — ${signalsWritten}/${entries.length} signals written | exit:${exitCount} watch:${watchCount} hold:${holdCount} errors:${errors}`)

  return {
    entriesProcessed: entries.length,
    signalsWritten,
    exitCount,
    watchCount,
    holdCount,
    errors,
  }
}

// ═════════════════════════════════════════════════════════════
// Route handlers
// ═════════════════════════════════════════════════════════════

/**
 * POST /api/watchlist/compute
 * Triggered by GitHub Actions cron. Requires x-cron-secret header.
 * Returns 202 immediately; resolver runs in background.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Fire-and-forget
  void (async () => {
    console.log('[watchlist/compute] cron START')
    try {
      const result = await runComputePass()
      console.log('[watchlist/compute] cron DONE:', JSON.stringify(result))
    } catch (e) {
      console.error('[watchlist/compute] cron FAILED:', (e as Error).message)
      try {
        const admin = getAdmin()
        await admin.from('cron_job_failures').insert({
          job_name: 'watchlist-compute',
          error_message: (e as Error).message?.slice(0, 500) ?? 'unknown',
          failed_at: new Date().toISOString(),
        })
      } catch { /* swallow */ }
    }
  })()

  return NextResponse.json({ ok: true, accepted: true }, { status: 202 })
}

/**
 * GET /api/watchlist/compute
 * Lightweight status — returns recent compute activity.
 */
export async function GET() {
  try {
    const admin = getAdmin()
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    const [{ count: last1h }, { count: last24h }, latest] = await Promise.all([
      admin.from('watchlist_signals').select('id', { count: 'exact', head: true }).gte('computed_at', since),
      admin.from('watchlist_signals').select('id', { count: 'exact', head: true }).gte('computed_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      admin.from('watchlist_signals').select('computed_at').order('computed_at', { ascending: false }).limit(1).maybeSingle(),
    ])

    return NextResponse.json({
      signals_last_1h: last1h ?? 0,
      signals_last_24h: last24h ?? 0,
      most_recent_compute: latest.data?.computed_at ?? null,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
