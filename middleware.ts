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

  const { pathname } = request.nextUrl

  // ── Always public — no auth needed ──────────────────────────
  const alwaysPublic = ['/login', '/auth/callback', '/subscribe', '/signup', '/confirm', '/privacy', '/terms', '/disclaimer']
  if (alwaysPublic.some(p => pathname.startsWith(p))) return supabaseResponse

  // Removed feature
  if (pathname.startsWith('/training')) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  // ── Get session ──────────────────────────────────────────────
  // Wrapped in try-catch — invalid/expired refresh tokens throw AuthApiError
  // instead of returning null, which would crash the middleware
  let user: any = null
  let session: any = null
  try {
    const [userResult, sessionResult] = await Promise.all([
      supabase.auth.getUser(),
      supabase.auth.getSession(),
    ])
    user = userResult.data.user
    session = sessionResult.data.session
  } catch (err: any) {
    // Stale or invalid refresh token — clear cookies and redirect to login
    const code = err?.code || err?.message || ''
    if (code.includes('refresh_token') || code.includes('Auth') || err?.__isAuthError) {
      const loginUrl = new URL('/login', request.url)
      const response = NextResponse.redirect(loginUrl)
      // Clear all supabase auth cookies so the client starts fresh
      request.cookies.getAll()
        .filter(c => c.name.startsWith('sb-'))
        .forEach(c => response.cookies.delete(c.name))
      return response
    }
    // Unknown error — fail open for non-auth errors
    console.error('[middleware] auth error:', err?.message)
  }

  // API routes handle their own auth
  if (pathname.startsWith('/api/')) return supabaseResponse

  // Not logged in → login
  if (!user || !session) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  const admin = createAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // ── Single session enforcement ───────────────────────────────
  const sessionToken = session.access_token?.slice(-32) ?? null
  if (sessionToken) {
    const { data: activeSession } = await admin
      .from('active_sessions')
      .select('session_token')
      .eq('user_id', user.id)
      .maybeSingle()

    if (activeSession && activeSession.session_token !== sessionToken) {
      await supabase.auth.signOut()
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('error', 'session_displaced')
      loginUrl.searchParams.set('message', 'Signed out — account accessed from another device.')
      return NextResponse.redirect(loginUrl)
    }
  }

  // ── Disclaimer ───────────────────────────────────────────────
  if (pathname !== '/disclaimer') {
    const { data: disclaimer } = await admin
      .from('disclaimer_accepted')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!disclaimer) {
      return NextResponse.redirect(new URL('/disclaimer', request.url))
    }
  }

  if (pathname === '/disclaimer') return supabaseResponse

  // ── Subscription check ───────────────────────────────────────
  const { data: sub } = await admin
    .from('subscriptions')
    .select('status, trial_ends_at, current_period_end, is_exempt')
    .eq('user_id', user.id)
    .maybeSingle()

  // No subscription row at all — create trial and grant access
  if (!sub) {
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await admin.from('subscriptions').insert({
      user_id: user.id,
      status: 'trialing',
      trial_ends_at: trialEndsAt.toISOString(),
    }).then(({ error }) => {
      if (error) console.error('[middleware] trial insert error:', error.message)
    })
    return supabaseResponse // grant access regardless of insert result
  }

  // Has a subscription row — check access
  const now = new Date()

  // Exempt — always in
  if (sub.is_exempt) return supabaseResponse

  // Active paid subscription
  if (sub.status === 'active' || sub.status === 'past_due') return supabaseResponse

  // Trialing — check expiry
  if (sub.status === 'trialing') {
    // No expiry date = grant access (bad data safety net)
    if (!sub.trial_ends_at) return supabaseResponse
    // Valid trial
    if (new Date(sub.trial_ends_at) > now) return supabaseResponse
    // Expired — send to subscribe
    console.log(`[middleware] trial expired for ${user.email}`)
    return NextResponse.redirect(new URL('/subscribe', request.url))
  }

  // incomplete = started Stripe checkout but didn't finish — treat as trialing
  if (sub.status === 'incomplete') {
    if (!sub.trial_ends_at) return supabaseResponse
    if (new Date(sub.trial_ends_at) > now) return supabaseResponse
    return NextResponse.redirect(new URL('/subscribe', request.url))
  }

  // Any other status (canceled, etc) — no access
  console.log(`[middleware] no access, status=${sub.status} for ${user.email}`)
  return NextResponse.redirect(new URL('/subscribe', request.url))
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
