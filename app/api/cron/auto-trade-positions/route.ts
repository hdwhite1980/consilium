// =============================================================
// app/api/cron/auto-trade-positions/route.ts
//
// Position update worker. Runs every ~15 minutes via GitHub
// Actions cron. For each enabled user:
//   1. Find trade_attempts with outcome='placed' that haven't closed yet
//   2. Query Alpaca for each order's current state
//   3. Update trade_attempts with fill info / closure / realized P&L
//
// Realized P&L source: when a child stop/target leg fills, that
// closes the position. We match the parent order to compute pnl.
//
// CRON_SECRET gated.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers } from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import { makeAlpacaClient } from '@/app/lib/trading/alpaca-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary = { users: 0, openOrders: 0, fillsUpdated: 0, closesRecorded: 0, errors: 0, durationMs: 0 }

  try {
    const users = await listEnabledTradingUsers()
    summary.users = users.length

    for (const settings of users) {
      try {
        const credLoad = await loadBrokerCredentialForUse(settings.userId, settings.broker, settings.mode)
        if (!credLoad) continue
        const alpaca = makeAlpacaClient(credLoad.keyId, credLoad.secret, settings.mode)

        // Find this user's open orders (placed/partial_fill/filled-but-not-closed)
        const openAttempts = await fetchOpenAttempts(settings.userId)
        summary.openOrders += openAttempts.length

        for (const att of openAttempts) {
          if (!att.broker_order_id) continue
          try {
            const order = await alpaca.getOrder(att.broker_order_id)
            const update = await deriveUpdate(att, order)
            if (update) {
              await applyUpdate(att.id, update)
              if (update.outcome === 'filled' || update.outcome === 'partial_fill') summary.fillsUpdated++
              if (update.outcome?.startsWith('closed_')) summary.closesRecorded++
            }
          } catch (e) {
            summary.errors++
            console.warn(`[auto-trade-positions] order=${att.broker_order_id} update failed:`, e instanceof Error ? e.message : e)
          }
        }
      } catch (e) {
        summary.errors++
        console.error(`[auto-trade-positions] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[auto-trade-positions cron] done in ${summary.durationMs}ms`)
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────

interface AttemptRow {
  id: string
  user_id: string
  broker_order_id: string | null
  side: string | null
  qty: number | string | null
  entry_price_est: number | string | null
  filled_avg_price: number | string | null
  outcome: string
  council_entry: number | string | null
  council_stop: number | string | null
  council_target: number | string | null
}

async function fetchOpenAttempts(userId: string): Promise<AttemptRow[]> {
  const admin = await getSupabaseAdmin()
  // Look back 30 days for open orders
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data, error } = await admin
    .from('trade_attempts')
    .select('id, user_id, broker_order_id, side, qty, entry_price_est, filled_avg_price, outcome, council_entry, council_stop, council_target')
    .eq('user_id', userId)
    .in('outcome', ['placed', 'partial_fill', 'filled'])
    .gte('created_at', cutoff)
    .not('broker_order_id', 'is', null)
  if (error) {
    console.warn('[auto-trade-positions] fetchOpenAttempts failed:', error.message)
    return []
  }
  return (data ?? []) as AttemptRow[]
}

interface OrderShape {
  status: string
  filled_qty: number
  filled_avg_price: number | null
  filled_at: string | null
  cancelled_at: string | null
  rejected_at: string | null
  failed_at: string | null
  legs: OrderShape[] | null
}

interface UpdatePayload {
  outcome?: 'placed' | 'partial_fill' | 'filled' | 'cancelled' | 'rejected'
                 | 'closed_win' | 'closed_loss' | 'closed_be'
  filled_qty?: number
  filled_avg_price?: number
  filled_at?: string
  closed_at?: string
  realized_pnl?: number
}

/**
 * Figure out what to write back based on order state.
 * Returns null if nothing to update.
 */
async function deriveUpdate(att: AttemptRow, order: OrderShape): Promise<UpdatePayload | null> {
  // The parent (entry) leg
  const s = (order.status ?? '').toLowerCase()

  // If parent has filled and we haven't recorded fill yet
  if ((s === 'filled' || s === 'partially_filled') && att.outcome === 'placed') {
    const update: UpdatePayload = {
      outcome: s === 'filled' ? 'filled' : 'partial_fill',
      filled_qty: order.filled_qty,
    }
    if (order.filled_avg_price !== null) update.filled_avg_price = order.filled_avg_price
    if (order.filled_at) update.filled_at = order.filled_at
    return update
  }

  if (s === 'canceled' || s === 'cancelled') {
    return { outcome: 'cancelled', closed_at: order.cancelled_at ?? new Date().toISOString() }
  }
  if (s === 'rejected') {
    return { outcome: 'rejected', closed_at: order.rejected_at ?? new Date().toISOString() }
  }

  // Closing: check if any child leg filled (means the bracket closed out)
  const legs = order.legs ?? []
  const filledLeg = legs.find(l => (l.status ?? '').toLowerCase() === 'filled' && l.filled_avg_price !== null)
  if (filledLeg && (att.outcome === 'filled' || att.outcome === 'partial_fill')) {
    const entryFill = att.filled_avg_price !== null && att.filled_avg_price !== undefined
      ? Number(att.filled_avg_price) : null
    const exitFill = filledLeg.filled_avg_price
    const qty = att.qty !== null && att.qty !== undefined ? Number(att.qty) : 0
    if (entryFill !== null && exitFill !== null && qty > 0) {
      const sign = att.side === 'buy' ? 1 : -1
      const pnl = (exitFill - entryFill) * qty * sign
      const eps = 0.005  // half-cent rounding tolerance
      let outcome: 'closed_win' | 'closed_loss' | 'closed_be'
      if (pnl > eps) outcome = 'closed_win'
      else if (pnl < -eps) outcome = 'closed_loss'
      else outcome = 'closed_be'
      return {
        outcome,
        realized_pnl: Number(pnl.toFixed(2)),
        closed_at: filledLeg.filled_at ?? new Date().toISOString(),
      }
    }
  }

  return null
}

async function applyUpdate(attemptId: string, update: UpdatePayload): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin
    .from('trade_attempts')
    .update(update)
    .eq('id', attemptId)
}
