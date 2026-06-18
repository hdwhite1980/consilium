// =============================================================
// app/lib/admin/admin-auth.ts
//
// Admin authorization helpers. Used by /admin pages and /api/admin/*
// routes to gate access to administrative functions.
//
// Authorization model:
//   - is_admin lives in auth.users.raw_app_meta_data
//   - Set manually in Supabase Studio: Authentication → Users →
//     click user → Raw App Meta Data → add { "is_admin": true }
//   - Or via SQL:
//       UPDATE auth.users
//       SET raw_app_meta_data = jsonb_set(
//         COALESCE(raw_app_meta_data, '{}'::jsonb),
//         '{is_admin}', 'true'::jsonb
//       )
//       WHERE email = 'hugh@...';
//
// Non-admins get 404 (not 401/403) so the admin surface is invisible
// to unauthorized users.
// =============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import type { User } from '@supabase/supabase-js'

export interface AdminGuardResult {
  ok: boolean
  user?: User
  response?: NextResponse
}

/**
 * Verify the current request comes from an admin user.
 * Returns { ok: true, user } on success. Returns { ok: false, response }
 * with a 404 NextResponse otherwise; the caller should return the response.
 */
export async function requireAdmin(): Promise<AdminGuardResult> {
  try {
    const supabase = await createClient()
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) {
      return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
    }
    const isAdmin = user.app_metadata?.is_admin === true
    if (!isAdmin) {
      return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
    }
    return { ok: true, user }
  } catch (e) {
    console.error('[admin-auth] requireAdmin failed:', e instanceof Error ? e.message : e)
    return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  }
}

/**
 * Server-component-friendly admin check. Returns true/false.
 * Use in /admin page.tsx server components to trigger notFound().
 */
export async function isCurrentUserAdmin(): Promise<{ isAdmin: boolean; userId: string | null }> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { isAdmin: false, userId: null }
    return {
      isAdmin: user.app_metadata?.is_admin === true,
      userId: user.id,
    }
  } catch {
    return { isAdmin: false, userId: null }
  }
}

/**
 * Get the Supabase admin client (service role). Bypasses RLS, can read
 * auth.users. NEVER expose to client-side code or non-admin routes.
 */
export async function getSupabaseAdmin() {
  const { createClient: createAdminClient } = await import('@supabase/supabase-js')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }
  return createAdminClient(url, key, { auth: { persistSession: false } })
}
