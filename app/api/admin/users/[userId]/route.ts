// =============================================================
// app/api/admin/users/[userId]/route.ts
//
// PATCH /api/admin/users/:userId
//
// Body: { action, payload? }
// Actions:
//   - { action: 'toggle_comp', payload: { is_exempt: boolean } }
//   - { action: 'extend_trial', payload: { days: number } }
//   - { action: 'set_tier', payload: { tier: string } }
//   - { action: 'set_status', payload: { status: string } }
//
// Designed as a single endpoint with explicit action dispatch so audit
// logging is uniform and we can add actions without proliferating routes.
//
// Note: this does NOT touch Stripe. Toggling is_exempt grants app-level
// access; the user's Stripe subscription (if any) is untouched. If they
// have an active Stripe sub, it continues billing. For comp accounts
// (no Stripe sub), this is the right behavior — they just get free access.
// If you ever need to cancel Stripe subs from admin, add a separate
// action like 'cancel_stripe_sub' that calls the Stripe API.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, getSupabaseAdmin } from '@/app/lib/admin/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Allowed tier values — restrict to known set to prevent accidental garbage
const ALLOWED_TIERS = new Set(['free', 'trial', 'basic', 'pro', 'premium', 'comp'])
// Allowed subscription status values (Stripe-compatible)
const ALLOWED_STATUSES = new Set(['trialing', 'active', 'canceled', 'past_due', 'incomplete', 'paused'])

interface PatchBody {
  action: 'toggle_comp' | 'extend_trial' | 'set_tier' | 'set_status'
  payload?: Record<string, unknown>
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response!

  const { userId } = await ctx.params
  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 })
  }

  let body: PatchBody
  try {
    body = await req.json() as PatchBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const action = body.action
  const payload = body.payload ?? {}

  const admin = await getSupabaseAdmin()

  // Locate the subscriptions row for this user. If none exists, certain
  // actions can create one (toggle_comp), others fail (extend_trial needs
  // an existing trial period to extend).
  const { data: existing, error: lookupErr } = await admin
    .from('subscriptions')
    .select('id, user_id, status, tier, trial_ends_at, current_period_end, is_exempt')
    .eq('user_id', userId)
    .maybeSingle()
  if (lookupErr) {
    console.error('[admin/users PATCH] lookup failed:', lookupErr.message)
    return NextResponse.json({ error: 'Failed to load subscription' }, { status: 500 })
  }

  try {
    switch (action) {
      // ── Toggle comp (is_exempt) ──────────────────────────────
      case 'toggle_comp': {
        const isExempt = payload.is_exempt
        if (typeof isExempt !== 'boolean') {
          return NextResponse.json({ error: 'payload.is_exempt must be boolean' }, { status: 400 })
        }
        if (existing) {
          const { error } = await admin
            .from('subscriptions')
            .update({ is_exempt: isExempt, updated_at: new Date().toISOString() })
            .eq('id', existing.id)
          if (error) throw error
        } else {
          // Create a subscription row with is_exempt = true and a comp tier.
          // This grants the user access via app-level checks on is_exempt.
          const { error } = await admin
            .from('subscriptions')
            .insert({
              user_id: userId,
              status: 'active',
              tier: 'comp',
              is_exempt: isExempt,
            })
          if (error) throw error
        }
        console.log(`[admin/users PATCH] toggle_comp user=${userId} is_exempt=${isExempt} by=${guard.user?.email}`)
        return NextResponse.json({ ok: true, action, userId, is_exempt: isExempt })
      }

      // ── Extend trial by N days ───────────────────────────────
      case 'extend_trial': {
        const days = payload.days
        if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0 || days > 365) {
          return NextResponse.json({ error: 'payload.days must be a positive number ≤ 365' }, { status: 400 })
        }
        // Compute the new trial_ends_at: max(current trial_ends_at, now) + days
        const now = Date.now()
        const baseMs = existing?.trial_ends_at
          ? Math.max(new Date(existing.trial_ends_at).getTime(), now)
          : now
        const newTrialEnd = new Date(baseMs + days * 86_400_000).toISOString()

        if (existing) {
          const { error } = await admin
            .from('subscriptions')
            .update({
              trial_ends_at: newTrialEnd,
              status: existing.status === 'canceled' ? 'trialing' : existing.status,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id)
          if (error) throw error
        } else {
          const { error } = await admin
            .from('subscriptions')
            .insert({
              user_id: userId,
              status: 'trialing',
              tier: 'trial',
              trial_ends_at: newTrialEnd,
              is_exempt: false,
            })
          if (error) throw error
        }
        console.log(`[admin/users PATCH] extend_trial user=${userId} days=${days} new_end=${newTrialEnd} by=${guard.user?.email}`)
        return NextResponse.json({ ok: true, action, userId, trial_ends_at: newTrialEnd })
      }

      // ── Set tier ─────────────────────────────────────────────
      case 'set_tier': {
        const tier = payload.tier
        if (typeof tier !== 'string' || !ALLOWED_TIERS.has(tier)) {
          return NextResponse.json({
            error: `payload.tier must be one of: ${Array.from(ALLOWED_TIERS).join(', ')}`,
          }, { status: 400 })
        }
        if (existing) {
          const { error } = await admin
            .from('subscriptions')
            .update({ tier, updated_at: new Date().toISOString() })
            .eq('id', existing.id)
          if (error) throw error
        } else {
          const { error } = await admin
            .from('subscriptions')
            .insert({ user_id: userId, status: 'active', tier, is_exempt: false })
          if (error) throw error
        }
        console.log(`[admin/users PATCH] set_tier user=${userId} tier=${tier} by=${guard.user?.email}`)
        return NextResponse.json({ ok: true, action, userId, tier })
      }

      // ── Set status ───────────────────────────────────────────
      case 'set_status': {
        const status = payload.status
        if (typeof status !== 'string' || !ALLOWED_STATUSES.has(status)) {
          return NextResponse.json({
            error: `payload.status must be one of: ${Array.from(ALLOWED_STATUSES).join(', ')}`,
          }, { status: 400 })
        }
        if (existing) {
          const { error } = await admin
            .from('subscriptions')
            .update({ status, updated_at: new Date().toISOString() })
            .eq('id', existing.id)
          if (error) throw error
        } else {
          const { error } = await admin
            .from('subscriptions')
            .insert({ user_id: userId, status, tier: 'free', is_exempt: false })
          if (error) throw error
        }
        console.log(`[admin/users PATCH] set_status user=${userId} status=${status} by=${guard.user?.email}`)
        return NextResponse.json({ ok: true, action, userId, status })
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (e) {
    console.error('[admin/users PATCH] action failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }
}
