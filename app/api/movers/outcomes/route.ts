// ═════════════════════════════════════════════════════════════
// app/api/movers/outcomes/route.ts
//
// Daily cron endpoint that resolves pending movers_log entries
// by fetching current prices from Finnhub and computing outcomes.
//
// Called by GitHub Actions at 22:30 UTC daily. Can also be POSTed
// manually with CRON_SECRET for testing.
//
// Logic:
//   - For each movers_log row without a full movers_outcomes row:
//       * If flagged_date >= 1 trading day ago: compute outcome_1d
//       * If flagged_date >= 3 trading days ago: compute outcome_3d
//   - Skip rows where we don't have price_at_flag (can't compute)
//   - Fire-and-forget response pattern for GitHub Actions compatibility
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ─────────────────────────────────────────────────────────────
// Auth helper
// ─────────────────────────────────────────────────────────────
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const header = req.headers.get('x-cron-secret')
  return header === secret
}

// ─────────────────────────────────────────────────────────────
// Count weekdays between two dates (approximate trading days)
// ─────────────────────────────────────────────────────────────
function tradingDaysSince(flaggedDate: string): number {
  const start = new Date(flaggedDate + 'T00:00:00Z')
  const end = new Date()
  end.setUTCHours(0, 0, 0, 0)
  let count = 0
  const cur = new Date(start)
  while (cur < end) {
    cur.setUTCDate(cur.getUTCDate() + 1)
    const day = cur.getUTCDay()
    if (day !== 0 && day !== 6) count++
  }
  return count
}

// ─────────────────────────────────────────────────────────────
// Finnhub quote fetcher (small timeout, no retries)
// ─────────────────────────────────────────────────────────────
async function fetchPrice(ticker: string, token: string): Promise<number | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 4000)
  try {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${token}`, {
      signal: ctrl.signal, cache: 'no-store',
    })
    if (!res.ok) return null
    const q = await res.json()
    if (typeof q?.c === 'number' && q.c > 0) return q.c
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// Classify outcome based on signal and price move
// ─────────────────────────────────────────────────────────────
function classifyOutcome(
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  changePct: number
): 'correct' | 'wrong' | 'neutral' {
  // Moves under 0.5% are noise for short-horizon calls
  if (Math.abs(changePct) < 0.5) return 'neutral'

  if (signal === 'BULLISH') return changePct > 0 ? 'correct' : 'wrong'
  if (signal === 'BEARISH') return changePct < 0 ? 'correct' : 'wrong'
  // NEUTRAL (watchlist) — no directional call to grade
  return 'neutral'
}

// ─────────────────────────────────────────────────────────────
// Classify whether magnitude bucket matched actual move
// ─────────────────────────────────────────────────────────────
function classifyMagnitudeHit(
  magnitude: string | null,
  absChangePct: number
): boolean {
  if (!magnitude) return false
  const m = magnitude.toLowerCase()
  // magnitude expectation: high=5%+, medium=2-5%, low=<2%
  if (m === 'high') return absChangePct >= 5
  if (m === 'medium') return absChangePct >= 2 && absChangePct < 5
  if (m === 'low') return absChangePct < 2
  return false
}

// ═════════════════════════════════════════════════════════════
// Main resolver logic
// ═════════════════════════════════════════════════════════════
async function resolveOutcomes(): Promise<{
  processed: number
  resolved1d: number
  resolved3d: number
  skipped: number
  errors: number
}> {
  const admin = getAdmin()
  const finnhubKey = process.env.FINNHUB_API_KEY
  if (!finnhubKey) {
    throw new Error('FINNHUB_API_KEY not configured')
  }

  // Pull movers_log rows that need outcome resolution.
  // Criteria:
  //   - price_at_flag is NOT null (can compute)
  //   - flagged_date is 1-10 trading days ago (not too old, not too recent)
  //   - Either no movers_outcomes row yet, OR the row has NULL fields
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() - 14) // look back 14 calendar days max

  const { data: candidates, error } = await admin
    .from('movers_log')
    .select('id, ticker, signal, magnitude, price_at_flag, flagged_date, flagged_at')
    .gte('flagged_date', cutoff.toISOString().split('T')[0])
    .not('price_at_flag', 'is', null)
    .order('flagged_at', { ascending: true })
    .limit(500) // safety cap

  if (error) {
    throw new Error(`movers_log fetch failed: ${error.message}`)
  }

  if (!candidates || candidates.length === 0) {
    return { processed: 0, resolved1d: 0, resolved3d: 0, skipped: 0, errors: 0 }
  }

  // Check existing outcomes rows to see what's already resolved
  const ids = candidates.map(c => c.id)
  const { data: existingOutcomes } = await admin
    .from('movers_outcomes')
    .select('mover_id, outcome_1d, outcome_3d')
    .in('mover_id', ids)

  const existingMap = new Map<number, { has1d: boolean; has3d: boolean }>()
  for (const e of existingOutcomes ?? []) {
    existingMap.set(e.mover_id as number, {
      has1d: e.outcome_1d !== null,
      has3d: e.outcome_3d !== null,
    })
  }

  let resolved1d = 0
  let resolved3d = 0
  let skipped = 0
  let errors = 0
  const nowIso = new Date().toISOString()

  // Group candidates by ticker to minimize Finnhub calls
  const tickersNeedingPrice = new Set<string>()
  for (const c of candidates) {
    const existing = existingMap.get(c.id as number)
    const tradingDays = tradingDaysSince(c.flagged_date as string)
    const needs1d = tradingDays >= 1 && !existing?.has1d
    const needs3d = tradingDays >= 3 && !existing?.has3d
    if (needs1d || needs3d) {
      tickersNeedingPrice.add((c.ticker as string).toUpperCase())
    }
  }

  // Fetch prices (with throttle to respect Finnhub rate limits)
  const priceMap = new Map<string, number>()
  const tickerArray = Array.from(tickersNeedingPrice)
  console.log(`[movers/outcomes] fetching ${tickerArray.length} ticker prices`)
  for (const t of tickerArray) {
    const p = await fetchPrice(t, finnhubKey)
    if (p !== null) priceMap.set(t, p)
    await new Promise(r => setTimeout(r, 100)) // throttle
  }

  // Process each candidate
  for (const c of candidates) {
    try {
      const ticker = (c.ticker as string).toUpperCase()
      const priceFlag = c.price_at_flag as number
      const signal = c.signal as 'BULLISH' | 'BEARISH' | 'NEUTRAL'
      const magnitude = (c.magnitude as string | null) ?? null
      const tradingDays = tradingDaysSince(c.flagged_date as string)
      const existing = existingMap.get(c.id as number)
      const currentPrice = priceMap.get(ticker)

      if (!currentPrice) {
        skipped++
        continue
      }

      const changePct = ((currentPrice - priceFlag) / priceFlag) * 100
      const absChange = Math.abs(changePct)

      // Build the upsert payload
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const update: Record<string, any> = {
        mover_id: c.id,
      }

      // 1-day outcome (only populate if >=1 trading day and not already set)
      if (tradingDays >= 1 && !existing?.has1d) {
        update.price_1d = currentPrice
        update.change_1d_pct = parseFloat(changePct.toFixed(2))
        update.outcome_1d = classifyOutcome(signal, changePct)
        update.magnitude_hit_1d = classifyMagnitudeHit(magnitude, absChange)
        update.computed_1d_at = nowIso
        resolved1d++
      }

      // 3-day outcome
      if (tradingDays >= 3 && !existing?.has3d) {
        update.price_3d = currentPrice
        update.change_3d_pct = parseFloat(changePct.toFixed(2))
        update.outcome_3d = classifyOutcome(signal, changePct)
        update.magnitude_hit_3d = classifyMagnitudeHit(magnitude, absChange)
        update.computed_3d_at = nowIso
        resolved3d++
      }

      // If update has only mover_id (nothing to compute), skip
      if (Object.keys(update).length <= 1) {
        continue
      }

      // Upsert to movers_outcomes (mover_id should be unique)
      const { error: upsertErr } = await admin
        .from('movers_outcomes')
        .upsert(update, { onConflict: 'mover_id' })

      if (upsertErr) {
        console.warn(`[movers/outcomes] upsert failed for mover_id=${c.id}:`, upsertErr.message)
        errors++
      }
    } catch (e) {
      console.warn(`[movers/outcomes] error processing mover_id=${c.id}:`, (e as Error).message)
      errors++
    }
  }

  return {
    processed: candidates.length,
    resolved1d,
    resolved3d,
    skipped,
    errors,
  }
}

// ═════════════════════════════════════════════════════════════
// Route handlers
// ═════════════════════════════════════════════════════════════

/**
 * POST /api/movers/outcomes
 * Triggered by GitHub Actions cron. Requires x-cron-secret header.
 * Returns 202 immediately and runs resolver in background (fire-and-forget)
 * to avoid Railway's 30s timeout.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Fire-and-forget: start the resolver but return immediately
  void (async () => {
    const started = Date.now()
    console.log('[movers/outcomes] cron START')
    try {
      const result = await resolveOutcomes()
      const ms = Date.now() - started
      console.log(`[movers/outcomes] cron DONE in ${ms}ms:`, JSON.stringify(result))
    } catch (e) {
      console.error('[movers/outcomes] cron FAILED:', (e as Error).message)
      // Write failure to dead-letter table for auditing
      try {
        const admin = getAdmin()
        await admin.from('cron_job_failures').insert({
          job_name: 'movers-outcomes',
          error_message: (e as Error).message?.slice(0, 500) ?? 'unknown',
          failed_at: new Date().toISOString(),
        })
      } catch { /* don't let logging errors escape */ }
    }
  })()

  return NextResponse.json({ ok: true, accepted: true }, { status: 202 })
}

/**
 * GET /api/movers/outcomes
 * Returns a quick summary of recent resolution activity.
 * Useful for debugging and dashboard widgets.
 */
export async function GET() {
  try {
    const admin = getAdmin()

    // Count how many movers have outcomes in last 24h and 7d
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const [{ count: total24h }, { count: total7d }, latestCompute] = await Promise.all([
      admin.from('movers_outcomes').select('id', { count: 'exact', head: true }).gte('created_at', since24h),
      admin.from('movers_outcomes').select('id', { count: 'exact', head: true }).gte('created_at', since7d),
      admin.from('movers_outcomes').select('computed_1d_at, computed_3d_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ])

    return NextResponse.json({
      resolved_last_24h: total24h ?? 0,
      resolved_last_7d: total7d ?? 0,
      most_recent_compute: latestCompute.data?.computed_1d_at ?? latestCompute.data?.computed_3d_at ?? null,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
