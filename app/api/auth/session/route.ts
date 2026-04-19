import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { registerSession, clearSession, getDeviceHint } from '@/app/lib/auth/session'
import { hasActiveAccess } from '@/app/lib/stripe'

const DEVICE_COOKIE_NAME = 'wali_device_id'
const THIRTY_DAYS = 60 * 60 * 24 * 30

// GET /api/auth/session - returns subscription status and tier
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ hasAccess: false, tier: 'standard', status: 'unauthenticated' })
  const access = await hasActiveAccess(user.id)
  return NextResponse.json(access)
}

// POST /api/auth/session - called client-side after login
//
// Verifies the access token, generates a device_id, stores it in
// active_sessions, and returns it as a cookie. The device_id is how
// middleware proves on subsequent requests that this device is still
// the authorized one (hasn't been displaced by a newer login).
//
// Also writes the sb-*-auth-token cookie for @supabase/ssr middleware
// consumption (bypasses the SDK's async cookie commit race).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const { accessToken, refreshToken } = body as {
    accessToken?: string
    refreshToken?: string
  }

  if (!accessToken || !refreshToken) {
    return NextResponse.json({ error: 'accessToken and refreshToken required' }, { status: 400 })
  }

  // Verify the access token against Supabase using admin SDK
  const { createClient: createAdmin } = await import('@supabase/supabase-js')
  const admin = createAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { data: userData, error: userErr } = await admin.auth.getUser(accessToken)
  if (userErr || !userData?.user) {
    return NextResponse.json({ error: 'Invalid access token' }, { status: 401 })
  }
  const userId = userData.user.id

  const userAgent = req.headers.get('user-agent') || ''
  const deviceHint = getDeviceHint(userAgent)

  // Generate fresh device_id, store it, get it back
  const deviceId = await registerSession(userId, deviceHint)

  // Build Supabase auth cookie in the format @supabase/ssr expects to read
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL!
    .match(/https:\/\/([^.]+)\.supabase\.co/)?.[1]

  const res = NextResponse.json({ ok: true, deviceHint })

  if (projectRef) {
    const sbCookieValue = 'base64-' + Buffer.from(JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
      token_type: 'bearer',
      user: userData.user,
    })).toString('base64')

    res.cookies.set(`sb-${projectRef}-auth-token`, sbCookieValue, {
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      httpOnly: false, // @supabase/ssr uses non-httpOnly so browser JS can read
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    })
  }

  // Set device_id cookie - this is what middleware checks for displacement
  res.cookies.set(DEVICE_COOKIE_NAME, deviceId, {
    path: '/',
    maxAge: THIRTY_DAYS,
    httpOnly: true, // JS doesn't need to read this - it's only for requests
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })

  return res
}

// DELETE /api/auth/session - called on logout
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) await clearSession(user.id)

  const res = NextResponse.json({ ok: true })
  // Clear the device cookie so stale devices can't impersonate
  res.cookies.delete(DEVICE_COOKIE_NAME)
  return res
}