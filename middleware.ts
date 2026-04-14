import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { validateSession } from '@/app/lib/auth/session'

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

  // Refresh session
  const { data: { user, session } } = await supabase.auth.getUser()
    .then(async u => {
      const s = await supabase.auth.getSession()
      return { data: { user: u.data.user, session: s.data.session } }
    })

  const { pathname } = request.nextUrl

  // Always allow public paths
  const publicPaths = ['/login', '/auth/callback']
  if (publicPaths.some(p => pathname.startsWith(p))) {
    if (user && pathname === '/login') {
      return NextResponse.redirect(new URL('/', request.url))
    }
    return supabaseResponse
  }

  // Allow API routes — they handle their own auth
  if (pathname.startsWith('/api/')) {
    return supabaseResponse
  }

  // Not logged in — redirect to login
  if (!user || !session) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  // ── Single session check ───────────────────────────────────
  // The session token is the access_token from Supabase
  // We store a hash of it so even if intercepted it's not the raw JWT
  const sessionToken = session.access_token
    ? session.access_token.slice(-32) // last 32 chars as identifier
    : null

  if (sessionToken) {
    const isValid = await validateSession(user.id, sessionToken)

    if (!isValid) {
      // This session was displaced by a login on another device
      // Sign them out and redirect to login with a message
      await supabase.auth.signOut()
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('error', 'session_displaced')
      loginUrl.searchParams.set('message', 'You were signed out because your account was accessed from another device.')
      return NextResponse.redirect(loginUrl)
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
