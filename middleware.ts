import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createAdmin } from '@supabase/supabase-js'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user, session } } = await supabase.auth.getUser()
    .then(async u => {
      const s = await supabase.auth.getSession()
      return { data: { user: u.data.user, session: s.data.session } }
    })

  const { pathname } = request.nextUrl

  // ── Always public — no auth needed, no redirects ────────────
  const alwaysPublic = ['/login', '/auth/callback', '/subscribe', '/signup', '/confirm']
  if (alwaysPublic.some(p => pathname.startsWith(p))) {
    return supabaseResponse
  }

  // ── API routes handle their own auth ─────────────────────────
  if (pathname.startsWith('/api/')) {
    return supabaseResponse
  }

  // ── Not logged in → /login ────────────────────────────────────
  if (!user || !session) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  const admin = createAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // ── Single session check ──────────────────────────────────────
  const sessionToken = session.access_token?.slice(-32) ?? null
  if (sessionToken) {
    const { data: activeSession } = await admin
      .from('active_sessions')
      .select('session_token')
      .eq('user_id', user.id)
      .single()

    if (activeSession && activeSession.session_token !== sessionToken) {
      await supabase.auth.signOut()
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('error', 'session_displaced')
      loginUrl.searchParams.set('message', 'You were signed out because your account was accessed from another device.')
      return NextResponse.redirect(loginUrl)
    }
  }

  // ── Disclaimer ────────────────────────────────────────────────
  if (pathname !== '/disclaimer') {
    const { data: disclaimer } = await admin
      .from('disclaimer_accepted')
      .select('user_id')
      .eq('user_id', user.id)
      .single()

    if (!disclaimer) {
      return NextResponse.redirect(new URL('/disclaimer', request.url))
    }
  }

  // ── Subscription / trial check ────────────────────────────────
  // Skip for disclaimer page
  if (pathname === '/disclaimer') return supabaseResponse

  const { data: sub } = await admin
    .from('subscriptions')
    .select('status, trial_ends_at, current_period_end, is_exempt')
    .eq('user_id', user.id)
    .single()

  const now = new Date()
  let hasAccess = false

  if (!sub) {
    // First login — create 7-day trial
    const trialEndsAt = new Date()
    trialEndsAt.setDate(trialEndsAt.getDate() + 7)
    await admin.from('subscriptions').insert({
      user_id: user.id,
      status: 'trialing',
      trial_ends_at: trialEndsAt.toISOString(),
      is_exempt: false,
    })
    hasAccess = true
  } else if (sub.is_exempt) {
    hasAccess = true
  } else if (sub.status === 'trialing') {
    hasAccess = sub.trial_ends_at ? new Date(sub.trial_ends_at) > now : false
  } else if (sub.status === 'active') {
    hasAccess = true
  } else if (sub.status === 'past_due') {
    hasAccess = true // grace period
  }

  if (!hasAccess) {
    return NextResponse.redirect(new URL('/subscribe', request.url))
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
