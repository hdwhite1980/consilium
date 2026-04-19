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

  // DISABLED: single-session enforcement had a race condition that kept
  // bouncing fresh logins to /login?error=session_displaced. Every attempt
  // to fix it (access_token slice, then refresh_token slice, then grace
  // windows) left edge cases. Disabling wholesale until we redesign this
  // with a stable server-side device fingerprint (user-agent + IP hash).
  // The app is fully functional without it - users can be logged in on
  // multiple devices simultaneously, which is fine for a consumer SaaS.
  if (false) {
  // ── Single session enforcement ───────────────────────────────
  // Policy: last-login-wins, keyed on refresh_token (NOT access_token).
  //
  // Why refresh_token: Supabase rotates the access_token automatically every
  // hour AND whenever the client refreshes in the background. Using
  // access_token.slice(-32) as a fingerprint makes us misclassify every
  // single token rotation as a "different device" and sign the user out.
  //
  // The refresh_token is stable for the lifetime of a login session. It only
  // changes when the user actually logs out and logs back in, which is
  // exactly what we want to detect for "another device logged in".
  //
  // Also keyed on user_agent-derived device hint so logging into a new
  // browser/device writes a new fingerprint without racing itself.
  const refreshToken = session.refresh_token ?? null
  const sessionFingerprint = refreshToken ? refreshToken.slice(-32) : null

  if (sessionFingerprint) {
    const { data: activeSession } = await admin
      .from('active_sessions')
      .select('session_token, updated_at')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!activeSession) {
      // First time we've seen this user — claim the slot.
      await admin.from('active_sessions').insert({
        user_id: user.id,
        session_token: sessionFingerprint,
      })
    } else if (activeSession!.session_token !== sessionFingerprint) {
      // Fingerprints differ — a DIFFERENT login session is now active for
      // this user. Two scenarios:
      //   a) User legitimately logged in on another device → this session
      //      should be signed out.
      //   b) User just logged in on THIS device and the table still has
      //      their old fingerprint from a previous session → we should
      //      claim the slot.
      //
      // Detection: if the stored row is older than GRACE_MS, it's stale
      // (from a previous session), and this is the fresh login taking over.
      // If the stored row is recent, another device JUST claimed it.
      const storedAge = activeSession.updated_at
        ? Date.now() - new Date(activeSession.updated_at).getTime()
        : Infinity
      const GRACE_MS = 2 * 60 * 1000 // 2 minutes

      if (storedAge > GRACE_MS) {
        // Stored fingerprint is stale — this is a fresh login. Take the slot.
        await admin
          .from('active_sessions')
          .update({
            session_token: sessionFingerprint,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', user.id)
      } else {
        // Stored fingerprint is recent AND different — another device is
        // actively using this account. Sign this session out.
        console.log(`[middleware] genuine displacement for ${user.email} — stored age ${storedAge}ms`)
        await supabase.auth.signOut()
        const loginUrl = new URL('/login', request.url)
        loginUrl.searchParams.set('error', 'session_displaced')
        loginUrl.searchParams.set('message', 'Signed out — account accessed from another device.')
        const response = NextResponse.redirect(loginUrl)
        // Clear auth cookies so the browser doesn't retry with dead tokens
        request.cookies.getAll()
          .filter(c => c.name.startsWith('sb-'))
          .forEach(c => response.cookies.delete(c.name))
        return response
      }
    } else {
      // Fingerprints match — bump updated_at so future mismatches can
      // correctly classify us as "recently active".
      // Only bump occasionally to avoid hammering the DB on every request.
      const storedAge = activeSession.updated_at
        ? Date.now() - new Date(activeSession.updated_at).getTime()
        : Infinity
      if (storedAge > 5 * 60 * 1000) { // bump every 5 min at most
        await admin
          .from('active_sessions')
          .update({ updated_at: new Date().toISOString() })
          .eq('user_id', user.id)
      }
    }
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
