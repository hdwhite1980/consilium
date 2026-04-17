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

  // Always public — no auth check
  // Removed features — redirect to home
  if (pathname.startsWith('/training')) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  const alwaysPublic = ['/login', '/auth/callback', '/subscribe', '/signup', '/confirm', '/privacy', '/terms']
  if (alwaysPublic.some(p => pathname.startsWith(p))) return supabaseResponse

  const { data: { user, session } } = await supabase.auth.getUser()
    .then(async u => {
      const s = await supabase.auth.getSession()
      return { data: { user: u.data.user, session: s.data.session } }
    })

  // API routes handle their own auth
  if (pathname.startsWith('/api/')) return supabaseResponse

  // Not logged in
  if (!user || !session) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  const admin = createAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Single session check
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

  // Disclaimer check
  if (pathname !== '/disclaimer') {
    const { data: disclaimer } = await admin
      .from('disclaimer_accepted')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!disclaimer) {
      console.log(`[middleware] disclaimer missing for ${user.email}`)
      return NextResponse.redirect(new URL('/disclaimer', request.url))
    }
  }

  if (pathname === '/disclaimer') return supabaseResponse

  // Subscription check
  const { data: sub, error: subError } = await admin
    .from('subscriptions')
    .select('status, trial_ends_at, current_period_end, is_exempt')
    .eq('user_id', user.id)
    .maybeSingle()

  if (subError) console.error('[middleware] sub error:', subError.message)

  const now = new Date()
  let hasAccess = false

  if (!sub) {
    // New user — create trial
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    const { error: ie } = await admin.from('subscriptions').insert({
      user_id: user.id,
      status: 'trialing',
      trial_ends_at: trialEndsAt.toISOString(),
      is_exempt: false,
    })
    if (ie) console.error('[middleware] trial insert error:', ie.message)
    hasAccess = true
  } else if (sub.is_exempt) {
    hasAccess = true
  } else if (sub.status === 'trialing') {
    hasAccess = sub.trial_ends_at ? new Date(sub.trial_ends_at) > now : false
    if (!hasAccess) console.log(`[middleware] trial expired: ${sub.trial_ends_at} for ${user.email}`)
  } else if (sub.status === 'active') {
    hasAccess = true
  } else if (sub.status === 'past_due') {
    hasAccess = true
  } else {
    console.log(`[middleware] no access — status: ${sub?.status} for ${user.email}`)
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
