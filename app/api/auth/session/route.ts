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
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()

  if (error || !user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const { sessionToken } = await req.json()
  if (!sessionToken) {
    return NextResponse.json({ error: 'sessionToken required' }, { status: 400 })
  }

  const userAgent = req.headers.get('user-agent') || ''
  const deviceHint = getDeviceHint(userAgent)

  await registerSession(user.id, sessionToken, deviceHint)

  return NextResponse.json({ ok: true, deviceHint })
}

// DELETE /api/auth/session — called on logout
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (user) await clearSession(user.id)

  return NextResponse.json({ ok: true })
}
