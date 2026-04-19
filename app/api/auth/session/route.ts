import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { registerSession, clearSession, getDeviceHint } from '@/app/lib/auth/session'
import { hasActiveAccess } from '@/app/lib/stripe'

// GET /api/auth/session — returns subscription status and tier
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ hasAccess: false, tier: 'standard', status: 'unauthenticated' })
  const access = await hasActiveAccess(user.id)
  return NextResponse.json(access)
}

// POST /api/auth/session — called client-side after login
//
// IMPORTANT: this runs immediately after signInWithPassword, so the
// server-side auth cookies may not yet have propagated. Instead of
// relying on cookie-based getUser() (which races with cookie setup
// and causes a login hang), we accept the fresh access_token in the
// request body and verify it directly against Supabase.
//
// The legacy cookie-based path is kept as a fallback for any callers
// that haven't been updated to pass accessToken.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { sessionToken, accessToken } = body as { sessionToken?: string; accessToken?: string }

  if (!sessionToken) {
    return NextResponse.json({ error: 'sessionToken required' }, { status: 400 })
  }

  let userId: string | null = null

  if (accessToken) {
    // Fresh-login path: verify the access token directly, no cookie race
    const { createClient: createAdmin } = await import('@supabase/supabase-js')
    const admin = createAdmin(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
    const { data, error } = await admin.auth.getUser(accessToken)
    if (error || !data?.user) {
      return NextResponse.json({ error: 'Invalid access token' }, { status: 401 })
    }
    userId = data.user.id
  } else {
    // Legacy cookie-based path (for callers that don't pass accessToken)
    const supabase = await createClient()
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    userId = user.id
  }

  const userAgent = req.headers.get('user-agent') || ''
  const deviceHint = getDeviceHint(userAgent)
  await registerSession(userId, sessionToken, deviceHint)
  return NextResponse.json({ ok: true, deviceHint })
}

// DELETE /api/auth/session — called on logout
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) await clearSession(user.id)
  return NextResponse.json({ ok: true })
}
