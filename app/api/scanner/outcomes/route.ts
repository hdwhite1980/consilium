// ═════════════════════════════════════════════════════════════
// app/api/scanner/outcomes/route.ts
//
// Daily cron: computes 1d / 7d / 30d forward returns for scanner
// picks that have passed those time thresholds.
//
// Flow:
//   - Find pending outcomes: return_Nd IS NULL AND created_at + N days <= now
//   - For each distinct ticker, fetch 1 month of bars (batch-cached)
//   - Also fetch SPY once
//   - Compute returns, rel-vs-SPY, correct/incorrect direction alignment
//   - Update the outcome row
//
// Called once daily at 16:30 ET via GitHub Actions (after market close).
// Writes are idempotent (UPSERT with scan_id + ticker).
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { fetchBars } from '@/app/lib/data/alpaca'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('x-cron-secret') === secret
}

// ─────────────────────────────────────────────────────────────
// Helper: get closing price N trading days from a given date
// ─────────────────────────────────────────────────────────────
interface PriceAtOffset {
  price: number | null
  daysFound: number
}

function priceAfterDays(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bars: any[],
  scanDate: Date,
  targetDays: number,
): PriceAtOffset {
  // Find the first bar on or after (scanDate + targetDays)
  const targetMs = scanDate.getTime() + targetDays * 24 * 60 * 60 * 1000
  const tolerance = 3 * 24 * 60 * 60 * 1000  // 3 days grace for weekends/holidays

  // Sort bars ascending by timestamp
  const sorted = [...bars].sort((a, b) => {
    const aTs = new Date(a.t ?? a.timestamp ?? a.date ?? 0).getTime()
    const bTs = new Date(b.t ?? b.timestamp ?? b.date ?? 0).getTime()
    return aTs - bTs
  })

  for (const bar of sorted) {
    const ts = new Date(bar.t ?? bar.timestamp ?? bar.date ?? 0).getTime()
    if (ts >= targetMs && ts <= targetMs + tolerance) {
      const close = Number(bar.c ?? bar.close)
      if (Number.isFinite(close) && close > 0) {
        return { price: close, daysFound: Math.round((ts - scanDate.getTime()) / (24 * 60 * 60 * 1000)) }
      }
    }
  }

  return { price: null, daysFound: 0 }
}

// ─────────────────────────────────────────────────────────────
// Compute outcome for a single pick
// ─────────────────────────────────────────────────────────────
interface PendingOutcome {
  id: number
  scan_id: number
  ticker: string
  direction: string
  composite_score: number
  price_at_scan: number
  created_at: string
  return_1d: number | null
  return_7d: number | null
  return_30d: number | null
}

async function computeOutcomeUpdates(
  pending: PendingOutcome,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tickerBars: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spyBars: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  const scanDate = new Date(pending.created_at)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = { computed_at: new Date().toISOString() }
  const now = Date.now()
  const scanMs = scanDate.getTime()
  const daysSinceScan = (now - scanMs) / (24 * 60 * 60 * 1000)

  // Get SPY scan-date price for relative-return calc
  const spyScanDay = priceAfterDays(spyBars, scanDate, 0)

  for (const days of [1, 7, 30]) {
    const key = `return_${days}d` as 'return_1d' | 'return_7d' | 'return_30d'
    if (pending[key] !== null) continue  // already computed
    if (daysSinceScan < days) continue   // not enough time passed

    const tickerFuture = priceAfterDays(tickerBars, scanDate, days)
    const spyFuture = priceAfterDays(spyBars, scanDate, days)

    if (tickerFuture.price === null) continue

    const tickerReturn = ((tickerFuture.price - pending.price_at_scan) / pending.price_at_scan) * 100

    updates[`return_${days}d`] = Math.round(tickerReturn * 100) / 100

    if (spyFuture.price !== null && spyScanDay.price !== null) {
      const spyReturn = ((spyFuture.price - spyScanDay.price) / spyScanDay.price) * 100
      const relReturn = tickerReturn - spyReturn
      updates[`spy_return_${days}d`] = Math.round(spyReturn * 100) / 100
      updates[`rel_return_${days}d`] = Math.round(relReturn * 100) / 100
    }

    // Direction correctness:
    //   bullish + up = correct, bullish + down = wrong
    //   bearish + down = correct, bearish + up = wrong
    //   mixed: correct if absolute return > 2% in either direction (useful signal)
    if (pending.direction === 'bullish') {
      updates[`correct_${days}d`] = tickerReturn > 0
    } else if (pending.direction === 'bearish') {
      updates[`correct_${days}d`] = tickerReturn < 0
    } else {
      updates[`correct_${days}d`] = Math.abs(tickerReturn) > 2
    }
  }

  return updates
}

// ─────────────────────────────────────────────────────────────
// Main pass: compute outcomes for all pending picks
// ─────────────────────────────────────────────────────────────
async function runOutcomesPass(): Promise<{
  processed: number
  updated: number
  skipped: number
  errors: number
}> {
  const admin = getAdmin()
  const started = Date.now()

  // Fetch all outcomes that are still pending at any horizon
  // We check past 35 days — enough for 30d forward returns
  const cutoff = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString()

  const { data: pending, error } = await admin
    .from('scanner_pick_outcomes')
    .select('id, scan_id, ticker, direction, composite_score, price_at_scan, created_at, return_1d, return_7d, return_30d')
    .gte('created_at', cutoff)
    .or('return_1d.is.null,return_7d.is.null,return_30d.is.null')
    .limit(1000)

  if (error) throw new Error(`pending fetch failed: ${error.message}`)
  if (!pending || pending.length === 0) {
    return { processed: 0, updated: 0, skipped: 0, errors: 0 }
  }

  console.log(`[scanner/outcomes] ${pending.length} pending outcomes to evaluate`)

  // Fetch SPY bars once
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spyBars: any[] = []
  try {
    spyBars = await fetchBars('SPY', '3M') ?? []
  } catch {
    console.error('[scanner/outcomes] SPY fetch failed — cannot compute rel-returns')
    return { processed: pending.length, updated: 0, skipped: pending.length, errors: 1 }
  }

  if (spyBars.length < 20) {
    console.error('[scanner/outcomes] SPY returned too few bars')
    return { processed: pending.length, updated: 0, skipped: pending.length, errors: 1 }
  }

  // Group pending by ticker to avoid duplicate bar fetches
  const byTicker = new Map<string, PendingOutcome[]>()
  for (const p of pending) {
    const t = (p.ticker ?? '').toUpperCase()
    if (!t) continue
    const list = byTicker.get(t) ?? []
    list.push(p as PendingOutcome)
    byTicker.set(t, list)
  }

  console.log(`[scanner/outcomes] ${byTicker.size} unique tickers to fetch`)

  const BATCH_SIZE = 10
  const tickers = [...byTicker.keys()]
  let updated = 0
  let skipped = 0
  let errors = 0

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE)

    await Promise.all(batch.map(async (ticker) => {
      try {
        const bars = await fetchBars(ticker, '3M')
        if (!bars || bars.length < 5) {
          skipped += (byTicker.get(ticker)?.length ?? 0)
          return
        }

        const entries = byTicker.get(ticker) ?? []
        for (const p of entries) {
          const updates = computeOutcomeUpdates(p, bars, spyBars)
          const hasReturnUpdate = Object.keys(updates).some(k => k.startsWith('return_'))
          if (!hasReturnUpdate) {
            skipped++
            continue
          }

          const { error: upErr } = await admin
            .from('scanner_pick_outcomes')
            .update(updates)
            .eq('id', p.id)

          if (upErr) {
            console.warn(`[scanner/outcomes] update failed for ${ticker} id ${p.id}:`, upErr.message)
            errors++
          } else {
            updated++
          }
        }
      } catch (e) {
        console.warn(`[scanner/outcomes] ${ticker} failed:`, (e as Error).message?.slice(0, 100))
        errors += (byTicker.get(ticker)?.length ?? 0)
      }
    }))
  }

  console.log(`[scanner/outcomes] TOTAL ${Date.now() - started}ms — processed:${pending.length} updated:${updated} skipped:${skipped} errors:${errors}`)

  return { processed: pending.length, updated, skipped, errors }
}

// ═════════════════════════════════════════════════════════════
// POST — the cron endpoint
// ═════════════════════════════════════════════════════════════
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  void (async () => {
    console.log('[scanner/outcomes] cron START')
    try {
      const result = await runOutcomesPass()
      console.log('[scanner/outcomes] cron DONE:', JSON.stringify(result))
    } catch (e) {
      console.error('[scanner/outcomes] cron FAILED:', (e as Error).message)
      try {
        const admin = getAdmin()
        await admin.from('cron_job_failures').insert({
          job_name: 'scanner-outcomes',
          error_message: (e as Error).message?.slice(0, 500) ?? 'unknown',
          failed_at: new Date().toISOString(),
        })
      } catch { /* swallow */ }
    }
  })()

  return NextResponse.json({ ok: true, accepted: true }, { status: 202 })
}

// ═════════════════════════════════════════════════════════════
// GET — hit-rate summary (public, no secret needed)
// ═════════════════════════════════════════════════════════════
export async function GET() {
  try {
    const admin = getAdmin()

    const [overall, byUniverse] = await Promise.all([
      admin.from('scanner_hit_rate').select('*').maybeSingle(),
      admin.from('scanner_hit_rate_by_universe').select('*').order('picks_tracked', { ascending: false }).limit(15),
    ])

    return NextResponse.json({
      overall: overall.data ?? null,
      byUniverse: byUniverse.data ?? [],
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
