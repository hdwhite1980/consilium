// ═════════════════════════════════════════════════════════════
// /api/portfolio/close — Close a position (full or partial)
//
// Handles:
//   - Full close: closes all open lots, marks position 'closed'
//   - Partial close: closes specified quantity using FIFO lot order
//   - Optional AI postmortem generation (Claude Haiku for cost)
//   - Lot-aware realized P&L computation
//   - Updates portfolio_positions.status accordingly
//
// Endpoints:
//   POST /api/portfolio/close
//     body: {
//       position_id: string,
//       exit_price: number,           // $/share or $/contract
//       quantity?: number,            // optional; full close if omitted
//       closed_reason?: string,       // 'manual' | 'target_hit' | etc
//       generate_postmortem?: boolean,
//       notes?: string,
//     }
//   Returns: {
//     close_event: { ... },
//     position: { ... updated row ... },
//     postmortem: { ... } | null,
//   }
//
//   GET /api/portfolio/close?position_id=X
//     Returns scale-out levels and close event history for a position.
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

export const runtime = 'nodejs'
export const maxDuration = 30

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface PositionRow {
  id: string
  user_id: string
  portfolio_id: string
  ticker: string
  shares: number
  avg_cost: number | null
  position_type: 'stock' | 'option' | null
  option_type: 'call' | 'put' | null
  strike: number | null
  expiry: string | null
  contracts: number | null
  entry_premium: number | null
  underlying: string | null
  status: 'open' | 'closed' | 'partial'
  closed_at: string | null
  closed_reason: string | null
  added_at: string
  notes: string | null
}

interface LotRow {
  id: string
  position_id: string
  user_id: string
  lot_number: number
  opened_at: string
  quantity: number
  entry_price: number
  is_estimated: boolean
  status: 'open' | 'closed'
  closed_at: string | null
  exit_price: number | null
  realized_pnl: number | null
}

interface CloseEventRow {
  id: string
  position_id: string
  user_id: string
  closed_at: string
  close_type: 'full' | 'partial' | 'scale_out_step'
  closed_reason: string
  lot_ids: string[]
  quantity_closed: number
  exit_price: number
  exit_value: number
  realized_pnl: number
  realized_pnl_pct: number | null
  postmortem: Record<string, unknown> | null
  notes: string | null
}

// ─────────────────────────────────────────────────────────────
// FIFO lot allocator
// Given a target quantity to close and a list of open lots (sorted FIFO),
// returns: which lots get fully closed, and (optionally) one lot that
// gets partial-closed via splitting.
// ─────────────────────────────────────────────────────────────

interface AllocationResult {
  fullyClosedLots: LotRow[]
  partialLot: { lot: LotRow; quantityToClose: number; quantityRemaining: number } | null
  totalQuantityClosed: number
  totalCostBasis: number      // sum of (entry_price * quantity) for the closed portions
}

function allocateFIFO(openLots: LotRow[], targetQuantity: number): AllocationResult | null {
  if (targetQuantity <= 0) return null

  const sortedLots = [...openLots].sort((a, b) =>
    new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime()
  )

  const fullyClosedLots: LotRow[] = []
  let partialLot: AllocationResult['partialLot'] = null
  let remaining = targetQuantity
  let totalCostBasis = 0
  let totalQuantityClosed = 0

  for (const lot of sortedLots) {
    if (remaining <= 0) break

    if (lot.quantity <= remaining) {
      // Fully close this lot
      fullyClosedLots.push(lot)
      totalCostBasis += lot.entry_price * lot.quantity
      totalQuantityClosed += lot.quantity
      remaining -= lot.quantity
    } else {
      // Partial close — split this lot
      partialLot = {
        lot,
        quantityToClose: remaining,
        quantityRemaining: lot.quantity - remaining,
      }
      totalCostBasis += lot.entry_price * remaining
      totalQuantityClosed += remaining
      remaining = 0
    }
  }

  // Couldn't allocate full target quantity
  if (totalQuantityClosed < targetQuantity - 0.0001) return null

  return { fullyClosedLots, partialLot, totalQuantityClosed, totalCostBasis }
}

// ─────────────────────────────────────────────────────────────
// Postmortem generator
// Optional. Uses Claude Haiku for cost. Returns null if generation
// fails — never blocks the close from completing.
// ─────────────────────────────────────────────────────────────

interface PostmortemRequest {
  ticker: string
  positionType: 'stock' | 'option'
  optionType?: string | null
  strike?: number | null
  expiry?: string | null
  entryPrice: number          // weighted avg
  exitPrice: number
  quantity: number
  realizedPnl: number
  realizedPnlPct: number
  holdDays: number
  closedReason: string
  notes: string | null
}

async function generatePostmortem(req: PostmortemRequest): Promise<Record<string, unknown> | null> {
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: globalThis.fetch as any })

    const isOption = req.positionType === 'option'
    const tradeDesc = isOption
      ? `${req.optionType?.toUpperCase()} option on ${req.ticker} (strike $${req.strike}, expiry ${req.expiry})`
      : `${req.quantity} shares of ${req.ticker}`

    const outcome = req.realizedPnl > 0 ? 'win' : req.realizedPnl < 0 ? 'loss' : 'breakeven'

    const sysPrompt = `You are a trading coach reviewing a closed position. Grade the PROCESS, not just the outcome — a lucky win can have bad process; an unlucky loss can have great process.

Output strict JSON with these fields:
- "grade": one of "A", "B", "C", "D", "F"
- "outcome": "win" | "loss" | "breakeven"
- "what_worked": 1-2 sentences on what the trader did well (or "Nothing notable" if loss with bad process)
- "what_missed": 1-2 sentences on what could have gone better (or "N/A — clean execution" if perfect)
- "key_lesson": 1 sentence — the single most important takeaway
- "next_time": 1 sentence — concrete actionable change for similar setups

Be honest. If process was bad and trade lost, say so. If process was good and trade lost, also say so. Don't sugar-coat.`

    const userPrompt = `Closed: ${tradeDesc}
Entry: $${req.entryPrice.toFixed(2)}/${isOption ? 'contract' : 'share'}
Exit: $${req.exitPrice.toFixed(2)}/${isOption ? 'contract' : 'share'}
Held: ${req.holdDays} day${req.holdDays === 1 ? '' : 's'}
Realized P&L: ${req.realizedPnl >= 0 ? '+' : ''}$${req.realizedPnl.toFixed(2)} (${req.realizedPnlPct >= 0 ? '+' : ''}${req.realizedPnlPct.toFixed(2)}%)
Outcome: ${outcome}
Closed because: ${req.closedReason}
${req.notes ? `Notes: ${req.notes}` : ''}

Generate the postmortem JSON.`

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: sysPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = msg.content.find((b: any) => b.type === 'text') as { type: 'text'; text: string } | undefined
    if (!block) return null

    const jsonMatch = block.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    return JSON.parse(jsonMatch[0])
  } catch (e) {
    console.warn('[close-position] postmortem generation failed:', (e as Error).message?.slice(0, 200))
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// POST handler — close a position
// ─────────────────────────────────────────────────────────────

interface CloseRequest {
  position_id: string
  exit_price: number
  quantity?: number
  closed_reason?: string
  generate_postmortem?: boolean
  notes?: string
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: CloseRequest
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!body.position_id || typeof body.exit_price !== 'number' || body.exit_price <= 0) {
    return NextResponse.json({ error: 'position_id and positive exit_price required' }, { status: 400 })
  }

  const closedReason = body.closed_reason ?? 'manual'
  const validReasons = ['manual', 'target_hit', 'stop_hit', 'expired', 'assigned', 'exercised']
  if (!validReasons.includes(closedReason)) {
    return NextResponse.json({ error: 'Invalid closed_reason' }, { status: 400 })
  }

  const admin = getAdmin()

  // ── Fetch position
  const { data: position, error: posErr } = await admin
    .from('portfolio_positions')
    .select('*')
    .eq('id', body.position_id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (posErr || !position) {
    return NextResponse.json({ error: 'Position not found' }, { status: 404 })
  }

  const positionRow = position as PositionRow

  if (positionRow.status === 'closed') {
    return NextResponse.json({ error: 'Position already fully closed' }, { status: 400 })
  }

  // ── Fetch open lots
  const { data: lotsData, error: lotsErr } = await admin
    .from('position_lots')
    .select('*')
    .eq('position_id', body.position_id)
    .eq('status', 'open')

  if (lotsErr) {
    return NextResponse.json({ error: 'Failed to load lots' }, { status: 500 })
  }

  const openLots = (lotsData ?? []) as LotRow[]
  if (openLots.length === 0) {
    return NextResponse.json({ error: 'Position has no open lots — already closed?' }, { status: 400 })
  }

  const totalOpenQuantity = openLots.reduce((s, l) => s + l.quantity, 0)

  // ── Determine close quantity
  // For options, quantity is in CONTRACTS (1 contract = 100 shares)
  // For stocks, quantity is in SHARES
  const isOption = positionRow.position_type === 'option'
  const targetQuantity = body.quantity ?? totalOpenQuantity

  if (targetQuantity <= 0) {
    return NextResponse.json({ error: 'quantity must be positive' }, { status: 400 })
  }
  if (targetQuantity > totalOpenQuantity + 0.0001) {
    return NextResponse.json({
      error: `Cannot close ${targetQuantity} ${isOption ? 'contracts' : 'shares'} — only ${totalOpenQuantity} open`,
    }, { status: 400 })
  }

  const isFullClose = Math.abs(targetQuantity - totalOpenQuantity) < 0.0001

  // ── Allocate lots FIFO
  const allocation = allocateFIFO(openLots, targetQuantity)
  if (!allocation) {
    return NextResponse.json({ error: 'Failed to allocate lots' }, { status: 500 })
  }

  // ── Compute realized P&L
  // For stocks: P&L = (exit_price - entry_price) * quantity
  // For options: P&L = (exit_price - entry_price) * quantity * 100  (because contract = 100 shares of underlying)
  const multiplier = isOption ? 100 : 1
  const exitValue = body.exit_price * targetQuantity * multiplier

  let realizedPnl = 0
  for (const lot of allocation.fullyClosedLots) {
    realizedPnl += (body.exit_price - lot.entry_price) * lot.quantity * multiplier
  }
  if (allocation.partialLot) {
    realizedPnl += (body.exit_price - allocation.partialLot.lot.entry_price) *
                   allocation.partialLot.quantityToClose * multiplier
  }

  const costBasis = allocation.totalCostBasis * multiplier
  const realizedPnlPct = costBasis > 0 ? (realizedPnl / costBasis) * 100 : null

  // ── Apply database changes (transactional via separate calls;
  // Supabase doesn't support multi-table transactions in a single request,
  // so we do this in order and best-effort. If something fails partway,
  // we log it but the user can see what happened.)

  const closedAt = new Date().toISOString()
  const closedLotIds: string[] = []

  // 1. Close the fully-closed lots
  for (const lot of allocation.fullyClosedLots) {
    const lotPnl = (body.exit_price - lot.entry_price) * lot.quantity * multiplier
    const { error: lotErr } = await admin
      .from('position_lots')
      .update({
        status: 'closed',
        closed_at: closedAt,
        exit_price: body.exit_price,
        realized_pnl: lotPnl,
      })
      .eq('id', lot.id)

    if (lotErr) {
      console.error(`[close-position] failed to close lot ${lot.id}:`, lotErr.message)
      return NextResponse.json({ error: 'Failed to close lot — partial state may exist' }, { status: 500 })
    }
    closedLotIds.push(lot.id)
  }

  // 2. Handle partial-close lot (split into two: closed portion + remaining open)
  let newRemainingLotId: string | null = null
  if (allocation.partialLot) {
    const { lot, quantityToClose, quantityRemaining } = allocation.partialLot

    // Close the original lot for the closed portion (we replace its quantity
    // with the closed amount, mark it closed, and create a new lot for the
    // remaining open quantity)
    const closedPortionPnl = (body.exit_price - lot.entry_price) * quantityToClose * multiplier
    const { error: closeErr } = await admin
      .from('position_lots')
      .update({
        status: 'closed',
        closed_at: closedAt,
        exit_price: body.exit_price,
        realized_pnl: closedPortionPnl,
        quantity: quantityToClose,  // shrink to just the closed portion
      })
      .eq('id', lot.id)

    if (closeErr) {
      console.error('[close-position] partial lot close failed:', closeErr.message)
      return NextResponse.json({ error: 'Partial close failed — partial state may exist' }, { status: 500 })
    }
    closedLotIds.push(lot.id)

    // Create new open lot for the remaining quantity
    const { data: newLot, error: newLotErr } = await admin
      .from('position_lots')
      .insert({
        position_id: positionRow.id,
        user_id: positionRow.user_id,
        lot_number: openLots.length + allocation.fullyClosedLots.length + 1,
        opened_at: lot.opened_at,
        quantity: quantityRemaining,
        entry_price: lot.entry_price,
        is_estimated: lot.is_estimated,
        status: 'open',
      })
      .select('id')
      .single()

    if (newLotErr || !newLot) {
      console.error('[close-position] failed to create remainder lot:', newLotErr?.message)
      return NextResponse.json({ error: 'Failed to split lot — partial state may exist' }, { status: 500 })
    }
    newRemainingLotId = newLot.id
  }

  // 3. Optionally generate postmortem
  let postmortem: Record<string, unknown> | null = null
  if (body.generate_postmortem) {
    // Compute weighted avg entry across closed lots/portions
    const weightedEntry = costBasis / multiplier / targetQuantity
    const earliestOpenedAt = allocation.fullyClosedLots[0]?.opened_at
      ?? allocation.partialLot?.lot.opened_at
      ?? closedAt
    const holdDays = Math.max(0, Math.round(
      (new Date(closedAt).getTime() - new Date(earliestOpenedAt).getTime()) / 86400000
    ))

    postmortem = await generatePostmortem({
      ticker: positionRow.ticker,
      positionType: isOption ? 'option' : 'stock',
      optionType: positionRow.option_type,
      strike: positionRow.strike,
      expiry: positionRow.expiry,
      entryPrice: weightedEntry,
      exitPrice: body.exit_price,
      quantity: targetQuantity,
      realizedPnl,
      realizedPnlPct: realizedPnlPct ?? 0,
      holdDays,
      closedReason,
      notes: body.notes ?? null,
    })
  }

  // 4. Insert close event
  const { data: closeEvent, error: eventErr } = await admin
    .from('position_close_events')
    .insert({
      position_id: positionRow.id,
      user_id: positionRow.user_id,
      closed_at: closedAt,
      close_type: isFullClose ? 'full' : 'partial',
      closed_reason: closedReason,
      lot_ids: closedLotIds,
      quantity_closed: targetQuantity,
      exit_price: body.exit_price,
      exit_value: exitValue,
      realized_pnl: realizedPnl,
      realized_pnl_pct: realizedPnlPct,
      postmortem,
      notes: body.notes ?? null,
    })
    .select('*')
    .single()

  if (eventErr || !closeEvent) {
    console.error('[close-position] failed to insert close event:', eventErr?.message)
    return NextResponse.json({ error: 'Close event insert failed' }, { status: 500 })
  }

  // 5. Update position status
  const newStatus = isFullClose ? 'closed' : 'partial'
  const positionUpdate: Record<string, unknown> = {
    status: newStatus,
    updated_at: closedAt,
  }
  if (isFullClose) {
    positionUpdate.closed_at = closedAt
    positionUpdate.closed_reason = closedReason
  }

  // For partial close, also reduce the visible shares/contracts on the position
  // so the UI summary matches. We'll recompute from open lots to be safe.
  if (!isFullClose) {
    const remainingQty = totalOpenQuantity - targetQuantity
    if (isOption) {
      positionUpdate.contracts = remainingQty
      positionUpdate.shares = remainingQty * 100
    } else {
      positionUpdate.shares = remainingQty
    }
  }

  const { data: updatedPosition, error: updErr } = await admin
    .from('portfolio_positions')
    .update(positionUpdate)
    .eq('id', positionRow.id)
    .select('*')
    .single()

  if (updErr) {
    console.error('[close-position] failed to update position status:', updErr.message)
    return NextResponse.json({ error: 'Position status update failed' }, { status: 500 })
  }

  console.log(
    `[close-position] ${positionRow.ticker} ${isFullClose ? 'FULL' : 'PARTIAL'} close: ` +
    `${targetQuantity} ${isOption ? 'contracts' : 'shares'} @ $${body.exit_price}, ` +
    `realized $${realizedPnl.toFixed(2)} (${realizedPnlPct?.toFixed(2)}%)`
  )

  return NextResponse.json({
    close_event: closeEvent,
    position: updatedPosition,
    postmortem,
  })
}

// ─────────────────────────────────────────────────────────────
// GET handler — fetch close events + scale-out levels for a position
// ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const positionId = url.searchParams.get('position_id')
  if (!positionId) {
    return NextResponse.json({ error: 'position_id required' }, { status: 400 })
  }

  const admin = getAdmin()

  const [eventsRes, levelsRes, lotsRes] = await Promise.all([
    admin.from('position_close_events')
      .select('*')
      .eq('position_id', positionId)
      .eq('user_id', user.id)
      .order('closed_at', { ascending: false }),
    admin.from('scale_out_levels')
      .select('*')
      .eq('position_id', positionId)
      .eq('user_id', user.id)
      .order('level_number', { ascending: true }),
    admin.from('position_lots')
      .select('*')
      .eq('position_id', positionId)
      .eq('user_id', user.id)
      .order('lot_number', { ascending: true }),
  ])

  return NextResponse.json({
    close_events: eventsRes.data ?? [],
    scale_out_levels: levelsRes.data ?? [],
    lots: lotsRes.data ?? [],
  })
}
