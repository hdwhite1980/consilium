import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code       = searchParams.get('code')
  const token_hash = searchParams.get('token_hash')
  const type       = searchParams.get('type')
  const next       = searchParams.get('next') ?? '/'

  // If it has token_hash, it's an email confirmation — send to /confirm
  if (token_hash && type) {
    const confirmUrl = new URL('/confirm', origin)
    confirmUrl.searchParams.set('token_hash', token_hash)
    confirmUrl.searchParams.set('type', type)
    if (next !== '/') confirmUrl.searchParams.set('next', next)
    return NextResponse.redirect(confirmUrl.toString())
  }

  // PKCE code exchange
  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
    return NextResponse.redirect(`${origin}/confirm?error=expired`)
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
