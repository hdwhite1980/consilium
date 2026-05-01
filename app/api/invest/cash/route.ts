// =============================================================
// app/api/invest/cash/route.ts
//
// Adds or removes capital on the user's invest journey, mutating
// invest_journey.starting_balance and logging the event to
// invest_cash_events for audit.
//
// POST body: { amount: number }
//   amount > 0 = deposit  (e.g. 50  -> add $50)
//   amount < 0 = withdraw (e.g. -25 -> withdraw $25)
//   amount = 0 rejected
//
// Withdrawals are clamped to never bring starting_balance below 0.
// If the requested withdrawal exceeds available starting_balance,
// the actual withdrawn amount is whatever brings starting_balance
// to 0; the caller can detect this from the response.
//
// GET returns the recent cash event history for the user, newest
// first, capped at 50 rows.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

function getAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// =============================================================
// POST /api/invest/cash — add or remove capital
// =============================================================
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rawAmount = Number(body.amount)
  if (!Number.isFinite(rawAmount) || rawAmount === 0) {
    return NextResponse.json(
      { error: 'amount must be a non-zero finite number' },
      { status: 400 }
    )
  }

  // Cap the magnitude. Single transactions over $1M are almost certainly a
  // typo or abuse. Adjust if a user genuinely needs a larger top-up.
  if (Math.abs(rawAmount) > 1_000_000) {
    return NextResponse.json(
      { error: 'single cash event capped at $1,000,000 magnitude' },
      { status: 400 }
    )
  }

  const admin = getAdmin()

  // Load current journey. If no row exists, the user hasn't gone through
  // the StartScreen yet — they should set an opening balance first rather
  // than topping up from zero.
  const { data: journey, error: journeyErr } = await admin
    .from('invest_journey')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle()

  if (journeyErr) {
    console.error('[invest/cash] journey fetch failed:', journeyErr.message)
    return NextResponse.json({ error: 'journey lookup failed' }, { status: 500 })
  }

  if (!journey) {
    return NextResponse.json(
      { error: 'no invest journey yet — set an opening balance first' },
      { status: 400 }
    )
  }

  const previousBalance = Number(journey.starting_balance ?? 0)

  // Compute the actual delta. If the user requested a withdrawal larger
  // than the available starting_balance, clamp it to bring balance to 0
  // rather than rejecting. This is more forgiving and easier to recover
  // from than a hard rejection. The caller sees the real applied delta
  // in the response.
  let appliedDelta = rawAmount
  if (rawAmount < 0 && previousBalance + rawAmount < 0) {
    appliedDelta = -previousBalance
  }

  const newBalance = previousBalance + appliedDelta

  // 1. Update starting_balance
  const { error: updateErr } = await admin
    .from('invest_journey')
    .update({ starting_balance: newBalance })
    .eq('user_id', user.id)

  if (updateErr) {
    console.error('[invest/cash] update failed:', updateErr.message)
    return NextResponse.json({ error: 'update failed' }, { status: 500 })
  }

  // 2. Log the event. Best-effort — if the audit table doesn't exist yet
  //    or the insert fails for some other reason, we log a warning but
  //    don't fail the request. The starting_balance update is the
  //    contract; the event log is supporting metadata.
  try {
    const { error: eventErr } = await admin
      .from('invest_cash_events')
      .insert({
        user_id: user.id,
        amount: appliedDelta,
        balance_before: previousBalance,
        balance_after: newBalance,
        event_type: appliedDelta > 0 ? 'deposit' : 'withdrawal',
        requested_amount: rawAmount,
        clamped: appliedDelta !== rawAmount,
      })
    if (eventErr) {
      console.warn('[invest/cash] event log insert failed:', eventErr.message)
    }
  } catch (e) {
    console.warn('[invest/cash] event log error:', (e as Error).message)
  }

  return NextResponse.json({
    ok: true,
    requestedAmount: rawAmount,
    appliedAmount: appliedDelta,
    clamped: appliedDelta !== rawAmount,
    previousBalance,
    newBalance,
  })
}

// =============================================================
// GET /api/invest/cash — recent cash event history
// =============================================================
export async function GET(_req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const admin = getAdmin()

  const { data: events, error } = await admin
    .from('invest_cash_events')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    // Table may not exist yet — fail soft so the UI can render without history
    console.warn('[invest/cash] event history failed:', error.message)
    return NextResponse.json({ events: [] })
  }

  return NextResponse.json({ events: events ?? [] })
}
