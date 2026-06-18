// =============================================================
// app/api/admin/users/route.ts
//
// GET /api/admin/users?page=0&pageSize=50&q=foo
//
// Returns paginated list of users with their subscription state.
// Joins auth.users (for email/created_at) with public.subscriptions
// (for tier/status/trial_ends_at/current_period_end/is_exempt).
//
// Search ?q= matches against email substring.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, getSupabaseAdmin } from '@/app/lib/admin/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface AdminUserRow {
  id: string
  email: string
  createdAt: string
  lastSignInAt: string | null
  isAdmin: boolean
  // Subscription fields (null if no row exists)
  subscriptionId: string | null
  status: string | null              // 'trialing' | 'active' | 'canceled' | 'past_due' | null
  tier: string | null
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  isExempt: boolean
  stripeCustomerId: string | null
  stripeSubId: string | null
}

interface AdminUsersResponse {
  users: AdminUserRow[]
  page: number
  pageSize: number
  totalCount: number
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response!

  try {
    const { searchParams } = new URL(req.url)
    const page = Math.max(0, parseInt(searchParams.get('page') ?? '0', 10) || 0)
    const pageSize = Math.min(200, Math.max(1, parseInt(searchParams.get('pageSize') ?? '50', 10) || 50))
    const q = (searchParams.get('q') ?? '').trim().toLowerCase()

    const admin = await getSupabaseAdmin()

    // List auth users. Supabase admin API uses 1-indexed pages and its own pageSize.
    const { data: authData, error: authErr } = await admin.auth.admin.listUsers({
      page: page + 1,           // Supabase admin API is 1-indexed
      perPage: pageSize,
    })
    if (authErr) {
      console.error('[admin/users GET] auth.admin.listUsers failed:', authErr.message)
      return NextResponse.json({ error: 'Failed to load users' }, { status: 500 })
    }

    let authUsers = authData?.users ?? []
    const totalCount = (authData as unknown as { total?: number })?.total ?? authUsers.length

    // Client-side email substring filter (if query present)
    if (q) {
      authUsers = authUsers.filter(u => (u.email ?? '').toLowerCase().includes(q))
    }

    // Bulk fetch subscriptions for the user IDs in this page
    const userIds = authUsers.map(u => u.id)
    let subsByUserId: Map<string, {
      id: string
      status: string | null
      tier: string | null
      trial_ends_at: string | null
      current_period_end: string | null
      is_exempt: boolean | null
      stripe_customer_id: string | null
      stripe_sub_id: string | null
    }> = new Map()
    if (userIds.length > 0) {
      const { data: subs, error: subsErr } = await admin
        .from('subscriptions')
        .select('id, user_id, status, tier, trial_ends_at, current_period_end, is_exempt, stripe_customer_id, stripe_sub_id')
        .in('user_id', userIds)
      if (subsErr) {
        console.warn('[admin/users GET] subscriptions fetch failed:', subsErr.message)
        // Continue with empty map — users still display, sub fields null
      } else {
        subsByUserId = new Map(
          (subs ?? []).map(s => [s.user_id as string, {
            id: s.id as string,
            status: s.status as string | null,
            tier: s.tier as string | null,
            trial_ends_at: s.trial_ends_at as string | null,
            current_period_end: s.current_period_end as string | null,
            is_exempt: s.is_exempt as boolean | null,
            stripe_customer_id: s.stripe_customer_id as string | null,
            stripe_sub_id: s.stripe_sub_id as string | null,
          }])
        )
      }
    }

    const rows: AdminUserRow[] = authUsers.map(u => {
      const sub = subsByUserId.get(u.id)
      return {
        id: u.id,
        email: u.email ?? '(no email)',
        createdAt: u.created_at,
        lastSignInAt: u.last_sign_in_at ?? null,
        isAdmin: u.app_metadata?.is_admin === true,
        subscriptionId: sub?.id ?? null,
        status: sub?.status ?? null,
        tier: sub?.tier ?? null,
        trialEndsAt: sub?.trial_ends_at ?? null,
        currentPeriodEnd: sub?.current_period_end ?? null,
        isExempt: sub?.is_exempt === true,
        stripeCustomerId: sub?.stripe_customer_id ?? null,
        stripeSubId: sub?.stripe_sub_id ?? null,
      }
    })

    const payload: AdminUsersResponse = {
      users: rows,
      page,
      pageSize,
      totalCount,
    }
    return NextResponse.json(payload)
  } catch (e) {
    console.error('[admin/users GET] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
