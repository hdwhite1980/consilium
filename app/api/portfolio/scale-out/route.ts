// ═════════════════════════════════════════════════════════════
// /api/portfolio/scale-out — Configure scale-out alert levels
//
// Scale-out levels are PRICE ALERTS, not auto-execute.
// User configures: "alert me when price hits $X, suggest closing Y%
// of remaining position." When the price hits, the UI shows an alert
// and the user can confirm a partial close manually.
//
// This file handles CRUD on scale_out_levels table only.
// The actual close happens via /api/portfolio/close.
//
// Endpoints:
//
//   POST /api/portfolio/scale-out
//     body: {
//       position_id: string,
//       levels: [{ level_number, trigger_price, quantity_pct }]
//     }
//   Replaces all levels for a position with the given list.
//   Use this for both creating and updating.
//
//   GET /api/portfolio/scale-out?position_id=X
//     Returns all scale-out levels for a position.
//
//   DELETE /api/portfolio/scale-out?position_id=X
//     Clears all scale-out levels for a position.
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

interface ScaleOutLevelInput {
  level_number: number
  trigger_price: number
  quantity_pct: number       // 0-1, fraction of remaining position
}

interface ScaleOutPostBody {
  position_id: string
  levels: ScaleOutLevelInput[]
}

// ─────────────────────────────────────────────────────────────
// POST — replace all levels for a position
// ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: ScaleOutPostBody
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!body.position_id || !Array.isArray(body.levels)) {
    return NextResponse.json({ error: 'position_id and levels[] required' }, { status: 400 })
  }

  // Validate levels
  const totalPct = body.levels.reduce((s, l) => s + l.quantity_pct, 0)
  if (totalPct > 1.0001) {
    return NextResponse.json({
      error: `Total quantity_pct across levels exceeds 100% (got ${(totalPct * 100).toFixed(1)}%)`,
    }, { status: 400 })
  }

  for (const lvl of body.levels) {
    if (typeof lvl.level_number !== 'number' || lvl.level_number < 1) {
      return NextResponse.json({ error: 'level_number must be >= 1' }, { status: 400 })
    }
    if (typeof lvl.trigger_price !== 'number' || lvl.trigger_price <= 0) {
      return NextResponse.json({ error: 'trigger_price must be > 0' }, { status: 400 })
    }
    if (typeof lvl.quantity_pct !== 'number' || lvl.quantity_pct <= 0 || lvl.quantity_pct > 1) {
      return NextResponse.json({ error: 'quantity_pct must be in (0, 1]' }, { status: 400 })
    }
  }

  const admin = getAdmin()

  // Verify position belongs to user
  const { data: position } = await admin
    .from('portfolio_positions')
    .select('id, user_id, status')
    .eq('id', body.position_id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!position) {
    return NextResponse.json({ error: 'Position not found' }, { status: 404 })
  }
  if (position.status === 'closed') {
    return NextResponse.json({ error: 'Cannot configure scale-out on closed position' }, { status: 400 })
  }

  // Replace all levels: delete existing, insert new
  await admin
    .from('scale_out_levels')
    .delete()
    .eq('position_id', body.position_id)
    .eq('user_id', user.id)
    .eq('triggered', false)  // don't delete already-triggered levels (history)

  const newLevels = body.levels.map(lvl => ({
    position_id: body.position_id,
    user_id: user.id,
    level_number: lvl.level_number,
    trigger_price: lvl.trigger_price,
    quantity_pct: lvl.quantity_pct,
  }))

  if (newLevels.length === 0) {
    return NextResponse.json({ levels: [] })
  }

  const { data: inserted, error: insErr } = await admin
    .from('scale_out_levels')
    .insert(newLevels)
    .select('*')

  if (insErr) {
    return NextResponse.json({ error: insErr.message }, { status: 500 })
  }

  return NextResponse.json({ levels: inserted ?? [] })
}

// ─────────────────────────────────────────────────────────────
// GET — fetch levels for a position
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
  const { data, error } = await admin
    .from('scale_out_levels')
    .select('*')
    .eq('position_id', positionId)
    .eq('user_id', user.id)
    .order('level_number', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ levels: data ?? [] })
}

// ─────────────────────────────────────────────────────────────
// DELETE — clear all levels for a position
// ─────────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const positionId = url.searchParams.get('position_id')
  if (!positionId) {
    return NextResponse.json({ error: 'position_id required' }, { status: 400 })
  }

  const admin = getAdmin()
  const { error } = await admin
    .from('scale_out_levels')
    .delete()
    .eq('position_id', positionId)
    .eq('user_id', user.id)
    .eq('triggered', false)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
