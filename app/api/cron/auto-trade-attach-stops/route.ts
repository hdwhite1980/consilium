// =============================================================
// app/api/cron/auto-trade-attach-stops/route.ts (Session 1)
//
// Stop-attachment worker. Runs every 1 minute, 24/7.
//
// PURPOSE: The auto-trade-crypto cron places market entries but
// CANNOT place a stop in the same call (Alpaca crypto has no
// bracket order support). Without this worker, crypto positions
// run with no broker-side protective stop — a critical risk gap.
//
// HOW IT WORKS:
//   1. Find trade_attempts rows where:
//      - asset_class IN ('crypto')          (futures added in Session 2)
//      - outcome IN ('placed','filled','partial_fill')
//      - stop_order_id IS NULL              (not yet attached)
//      - stop_attach_attempts < 5           (retry budget)
//      - created_at > now() - 24h           (don't try stale orphans)
//
//   2. For each row, verify the parent entry has filled at Alpaca
//      (the cron may run before fill completes; defer to next run).
//
//   3. Call alpacaCrypto.stopLimitSell() at the stop_price recorded
//      on the attempt row, for the filled_qty.
//
//   4. On success: write stop_order_id and stop_attached_at.
//   5. On failure: increment stop_attach_attempts and log.
//
// SCOPE NOTES:
//   - Crypto only this session. Futures wiring comes in Session 2.
//   - No target attachment — crypto target is managed app-side via
//     reeval (Session 3 will fix reeval for crypto/futures).
//   - This route is idempotent: if a row already has stop_order_id,
//     it won't be re-processed. Safe to run every minute.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import { makeAlpacaCryptoClient, type AlpacaCryptoClient } from '@/app/lib/trading/alpaca-crypto-client'
import { randomBytes } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_ATTEMPTS_PER_RUN = 50          // safety cap per run
const MAX_ATTACH_ATTEMPTS = 5            // give up after N retries
const LOOKBACK_HOURS = 24                // don't chase stale orphans

interface PendingAttachRow {
  id: string                              // trade_attempts.id (UUID)
  user_id: string
  asset_class: string
  ticker: string                          // normalized symbol e.g. "BTC/USD"
  mode: 'paper' | 'live'
  broker: 'alpaca'
  broker_order_id: string | null          // the parent entry order
  side: string | null
  qty: number | string | null
  council_stop: number | string | null    // stop price from the council verdict
  filled_avg_price: number | string | null
  outcome: string
  stop_attach_attempts: number
}

interface AttachSummary {
  pending: number
  attached: number
  deferred: number         // parent not yet filled
  failed: number           // attach attempt failed
  gaveUp: number           // hit max attempts
  errors: number
  durationMs: number
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary: AttachSummary = {
    pending: 0, attached: 0, deferred: 0, failed: 0, gaveUp: 0, errors: 0, durationMs: 0,
  }

  try {
    const pending = await fetchPendingAttachments()
    summary.pending = pending.length

    // Group by user_id so we can reuse one Alpaca client per user
    const byUser = new Map<string, PendingAttachRow[]>()
    for (const row of pending) {
      const list = byUser.get(row.user_id) ?? []
      list.push(row)
      byUser.set(row.user_id, list)
    }

    for (const [userId, rows] of byUser) {
      // Same mode for all of a user's rows in practice; take from first
      const mode = rows[0].mode
      const credLoad = await loadBrokerCredentialForUse(userId, 'alpaca', mode, 'crypto')
      if (!credLoad) {
        console.warn(`[attach-stops] user=${userId} no alpaca crypto credential; skipping ${rows.length} attempts`)
        continue
      }
      const alpaca = makeAlpacaCryptoClient(credLoad.keyId, credLoad.secret, mode)

      for (const row of rows) {
        try {
          const result = await processAttempt(row, alpaca)
          switch (result.kind) {
            case 'attached':  summary.attached++; break
            case 'deferred':  summary.deferred++; break
            case 'failed':    summary.failed++; break
            case 'gave_up':   summary.gaveUp++; break
          }
        } catch (e) {
          summary.errors++
          console.error(`[attach-stops] attempt=${row.id} unexpected error:`, e instanceof Error ? e.message : e)
        }
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[attach-stops cron] done in ${summary.durationMs}ms pending=${summary.pending} attached=${summary.attached} deferred=${summary.deferred} failed=${summary.failed} gaveUp=${summary.gaveUp}`)
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────
// Per-attempt processing
// ─────────────────────────────────────────────────────────────

type ProcessResult =
  | { kind: 'attached'; stopOrderId: string }
  | { kind: 'deferred'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'gave_up'; reason: string }

async function processAttempt(row: PendingAttachRow, alpaca: AlpacaCryptoClient): Promise<ProcessResult> {
  // Already past retry budget — mark gave_up and exit (loud)
  if (row.stop_attach_attempts >= MAX_ATTACH_ATTEMPTS) {
    return { kind: 'gave_up', reason: `at max attempts (${row.stop_attach_attempts})` }
  }

  // Validate row has the data we need
  const stopPrice = row.council_stop !== null && row.council_stop !== undefined
    ? Number(row.council_stop) : null
  if (stopPrice === null || !Number.isFinite(stopPrice) || stopPrice <= 0) {
    // This is unrecoverable — no stop price means we can't attach. Mark gave_up.
    await markFailed(row.id, row.stop_attach_attempts, `no valid stop_price (council_stop=${row.council_stop})`)
    return { kind: 'failed', reason: 'no valid stop_price' }
  }
  if (!row.broker_order_id) {
    await markFailed(row.id, row.stop_attach_attempts, 'no broker_order_id on row')
    return { kind: 'failed', reason: 'no broker_order_id' }
  }

  // Check parent entry order — must be filled before we can attach a stop
  // (Alpaca rejects stop orders on positions you don't have yet.)
  let parentOrder
  try {
    parentOrder = await alpaca.getOrder(row.broker_order_id)
  } catch (e) {
    // Could be transient (Alpaca 5xx) or permanent (order doesn't exist).
    // Either way, increment attempts and defer to next run.
    const msg = e instanceof Error ? e.message : String(e)
    await markFailed(row.id, row.stop_attach_attempts, `getOrder failed: ${msg.slice(0, 200)}`)
    return { kind: 'failed', reason: `getOrder failed: ${msg.slice(0, 100)}` }
  }

  const status = (parentOrder.status ?? '').toLowerCase()
  if (status !== 'filled' && status !== 'partially_filled') {
    // Not yet filled — common right after placement. Just defer; don't count as a failed attempt.
    return { kind: 'deferred', reason: `parent status=${status}` }
  }

  const filledQty = parentOrder.filled_qty ?? 0
  if (filledQty <= 0) {
    return { kind: 'deferred', reason: `parent status=${status} but filled_qty=${filledQty}` }
  }

  // We're good — place the stop_limit sell
  const stopClientId = `wos-stop-${row.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`

  // Idempotency: a previous run may have placed the stop but failed to
  // write back the ID. Look it up first.
  try {
    const existing = await alpaca.getOrderByClientId(stopClientId).catch(() => null)
    if (existing) {
      await markAttached(row.id, existing.id, row.stop_attach_attempts)
      return { kind: 'attached', stopOrderId: existing.id }
    }
  } catch { /* fall through to place */ }

  try {
    const stopOrder = await alpaca.stopLimitSell({
      symbol: row.ticker,                  // already normalized e.g. "BTC/USD"
      qty: filledQty,
      stopPrice,
      clientOrderId: stopClientId,
    })
    await markAttached(row.id, stopOrder.id, row.stop_attach_attempts)
    console.log(`[attach-stops] ATTACHED user=${row.user_id} ${row.ticker} stop=${stopPrice} stopOrderId=${stopOrder.id} attemptId=${row.id}`)
    return { kind: 'attached', stopOrderId: stopOrder.id }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markFailed(row.id, row.stop_attach_attempts, `stopLimitSell failed: ${msg.slice(0, 200)}`)
    console.warn(`[attach-stops] FAILED user=${row.user_id} ${row.ticker} attempt=${row.id}: ${msg.slice(0, 200)}`)
    return { kind: 'failed', reason: msg.slice(0, 100) }
  }
}

// ─────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────

async function fetchPendingAttachments(): Promise<PendingAttachRow[]> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000).toISOString()
  const { data, error } = await admin
    .from('trade_attempts')
    .select('id, user_id, asset_class, ticker, mode, broker, broker_order_id, side, qty, council_stop, filled_avg_price, outcome, stop_attach_attempts')
    .eq('asset_class', 'crypto')                    // Session 1: crypto only
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .is('stop_order_id', null)
    .lt('stop_attach_attempts', MAX_ATTACH_ATTEMPTS)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: true })       // oldest first — fairness
    .limit(MAX_ATTEMPTS_PER_RUN)
  if (error) {
    console.error('[attach-stops] fetchPendingAttachments failed:', error.message)
    return []
  }
  return (data ?? []) as PendingAttachRow[]
}

async function markAttached(attemptId: string, stopOrderId: string, prevAttempts: number): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin
    .from('trade_attempts')
    .update({
      stop_order_id: stopOrderId,
      stop_attached_at: new Date().toISOString(),
      stop_attach_attempts: prevAttempts + 1,
    })
    .eq('id', attemptId)
}

async function markFailed(attemptId: string, prevAttempts: number, reason: string): Promise<void> {
  const admin = await getSupabaseAdmin()
  // Increment the attach counter. We don't write `reason` to the row because the
  // existing `reject_reason` field is for the original placement outcome, and
  // overwriting it would lose that audit trail. The reason is logged below and
  // visible in Railway logs filtered by [attach-stops].
  await admin
    .from('trade_attempts')
    .update({ stop_attach_attempts: prevAttempts + 1 })
    .eq('id', attemptId)
  console.warn(`[attach-stops] attempt=${attemptId} attach failed (#${prevAttempts + 1}): ${reason}`)
}
