import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { validateDeviceId } from '@/app/lib/auth/session'

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

  // --- Always public - no auth needed ---
  const alwaysPublic = ['/login', '/auth/callback', '/subscribe', '/signup', '/confirm', '/privacy', '/terms', '/disclaimer']
  if (alwaysPublic.some(p => pathname.startsWith(p))) return supabaseResponse

  // --- RSC prefetch bypass ---
  // Next.js fires RSC prefetch requests that race with main navigations.
  // When both call getSession() in parallel, Supabase token rotation
  // invalidates whichever request arrives second, causing a false auth
  // error that bounces the user to /login.
  const isRSC = request.headers.get('rsc') === '1'
                || request.headers.get('next-router-prefetch') === '1'
                || request.headers.get('next-router-state-tree') !== null
                || request.headers.get('purpose') === 'prefetch'
                || request.headers.get('sec-purpose')?.includes('prefetch') === true
                || request.nextUrl.searchParams.has('_rsc')
                || request.nextUrl.search.includes('_rsc=')
  if (isRSC) return supabaseResponse

  // Removed feature
  if (pathname.startsWith('/training')) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  // --- Get session ---
  // Wrapped in try-catch - invalid/expired refresh tokens throw AuthApiError
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
    // Stale or invalid refresh token - clear cookies and redirect to login
    const code = err?.code || err?.message || ''
    if (code.includes('refresh_token') || code.includes('Auth') || err?.__isAuthError) {
      const loginUrl = new URL('/login', request.url)
      const response = NextResponse.redirect(loginUrl)
      request.cookies.getAll()
        .filter(c => c.name.startsWith('sb-'))
        .forEach(c => response.cookies.delete(c.name))
      return response
    }
    // Unknown error - fail open for non-auth errors
    if (process.env.NODE_ENV !== 'production') {
      console.error('[middleware] auth error:', err?.message)
    }
  }

  // API routes handle their own auth
  if (pathname.startsWith('/api/')) return supabaseResponse

  // Not logged in -> login
  if (!user || !session) {
    if (process.env.NODE_ENV !== 'production') {
      console.log('[middleware] redirect to /login from', pathname, '- no user/session')
    }
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  const admin = createAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // --- Single-session enforcement via device_id ---
  // When a user logs in, server stores a random UUID in active_sessions
  // and sets a wali_device_id cookie. On each request, we verify this
  // device's cookie still matches what's stored. If the user has since
  // logged in from another browser, a new device_id was written, and
  // this cookie is stale - we redirect with ?error=session_displaced.
  //
  // Unlike token-fingerprint approaches this is immune to Supabase's
  // token rotation because device_id only changes on intentional login.
  const deviceIdCookie = request.cookies.get('wali_device_id')?.value
  const deviceValid = await validateDeviceId(user.id, deviceIdCookie)
  if (!deviceValid) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('error', 'session_displaced')
    const response = NextResponse.redirect(loginUrl)
    // Clear all auth cookies so the stale device starts fresh
    request.cookies.getAll()
      .filter(c => c.name.startsWith('sb-') || c.name === 'wali_device_id')
      .forEach(c => response.cookies.delete(c.name))
    return response
  }

  // --- Disclaimer ---
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

  // --- Subscription check ---
  const { data: sub } = await admin
    .from('subscriptions')
    .select('status, trial_ends_at, current_period_end, is_exempt')
    .eq('user_id', user.id)
    .maybeSingle()

  // No subscription row at all - create trial and grant access
  if (!sub) {
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await admin.from('subscriptions').insert({
      user_id: user.id,
      status: 'trialing',
      trial_ends_at: trialEndsAt.toISOString(),
    }).then(({ error }) => {
      if (error && process.env.NODE_ENV !== 'production') {
        console.error('[middleware] trial insert error:', error.message)
      }
    })
    return supabaseResponse
  }

  const now = new Date()

  // Exempt - always in
  if (sub.is_exempt) return supabaseResponse

  // Active paid subscription
  if (sub.status === 'active' || sub.status === 'past_due') return supabaseResponse

  // Trialing - check expiry
  if (sub.status === 'trialing') {
    if (!sub.trial_ends_at) return supabaseResponse
    if (new Date(sub.trial_ends_at) > now) return supabaseResponse
    return NextResponse.redirect(new URL('/subscribe', request.url))
  }

  // incomplete = started Stripe checkout but didn't finish - treat as trialing
  if (sub.status === 'incomplete') {
    if (!sub.trial_ends_at) return supabaseResponse
    if (new Date(sub.trial_ends_at) > now) return supabaseResponse
    return NextResponse.redirect(new URL('/subscribe', request.url))
  }

  // Any other status (canceled, etc) - no access
  return NextResponse.redirect(new URL('/subscribe', request.url))
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}