import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code       = searchParams.get('code')
  const token_hash = searchParams.get('token_hash')
  const type       = searchParams.get('type')
  const next       = searchParams.get('next') ?? '/'
  const error      = searchParams.get('error')
  const errorDesc  = searchParams.get('error_description')

  // Supabase error — show on confirm page
  if (error) {
    const url = new URL('/confirm', origin)
    url.searchParams.set('error_code', error)
    url.searchParams.set('error_description', errorDesc ?? 'Confirmation failed')
    return NextResponse.redirect(url.toString())
  }

  // PKCE code exchange — Supabase sends this after validating the email link
  if (code) {
    const supabase = await createClient()
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
    if (!exchangeError) {
      // Success — go to confirm page to show success state then redirect
      const url = new URL('/confirm', origin)
      url.searchParams.set('verified', 'true')
      url.searchParams.set('next', next)
      return NextResponse.redirect(url.toString())
    }
    const url = new URL('/confirm', origin)
    url.searchParams.set('error_code', 'exchange_failed')
    url.searchParams.set('error_description', exchangeError.message)
    return NextResponse.redirect(url.toString())
  }

  // token_hash — pass through to confirm page
  if (token_hash && type) {
    const url = new URL('/confirm', origin)
    url.searchParams.set('token_hash', token_hash)
    url.searchParams.set('type', type)
    url.searchParams.set('next', next)
    return NextResponse.redirect(url.toString())
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
