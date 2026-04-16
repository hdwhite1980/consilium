'use client'

import { useEffect, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'

function ConfirmInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const token_hash = searchParams.get('token_hash')
    const type       = searchParams.get('type')
    const code       = searchParams.get('code')
    const next       = searchParams.get('next') ?? '/'
    const error_code = searchParams.get('error_code')
    const error_desc = searchParams.get('error_description')
    const verified   = searchParams.get('verified')

    // Already verified by auth/callback — just show success
    if (verified === 'true') {
      setStatus('success')
      setTimeout(() => router.push(next), 1500)
      return
    }

    // Supabase error passed through from callback
    if (error_code || error_desc) {
      setStatus('error')
      setMessage(error_desc
        ? decodeURIComponent(error_desc.replace(/\+/g, ' '))
        : 'Confirmation failed. Please try again.')
      return
    }

    const supabase = createClient()

    // Flow 1: PKCE code exchange (fallback if code lands here directly)
    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (error) {
          setStatus('error')
          setMessage('This confirmation link has expired or already been used. Please sign up again.')
        } else {
          setStatus('success')
          setTimeout(() => router.push(next), 1500)
        }
      })
      return
    }

    // Flow 2: token_hash — handle both PKCE (pkce_ prefix) and OTP tokens
    if (token_hash && type) {
      const isPKCE = token_hash.startsWith('pkce_')

      if (isPKCE) {
        // PKCE token — exchange using exchangeCodeForSession
        supabase.auth.exchangeCodeForSession(token_hash).then(({ error }) => {
          if (error) {
            console.error('PKCE exchange error:', error.message)
            // Try verifyOtp as fallback
            supabase.auth.verifyOtp({
              token_hash,
              type: type as 'signup' | 'recovery' | 'email' | 'magiclink'
            }).then(({ error: otpError }) => {
              if (otpError) {
                setStatus('error')
                setMessage('This confirmation link has expired or already been used. Please sign up again.')
              } else {
                setStatus('success')
                setTimeout(() => router.push(next), 1500)
              }
            })
          } else {
            setStatus('success')
            setTimeout(() => router.push(next), 1500)
          }
        })
      } else {
        // Regular OTP token
        supabase.auth.verifyOtp({
          token_hash,
          type: type as 'signup' | 'recovery' | 'email' | 'magiclink'
        }).then(({ error }) => {
          if (error) {
            setStatus('error')
            setMessage(error.message.includes('expired')
              ? 'This confirmation link has expired. Please sign up again.'
              : 'This link has already been used. Try signing in, or sign up again.')
          } else {
            setStatus('success')
            setTimeout(() => router.push(next), 1500)
          }
        })
      }
      return
    }

    // Flow 3: Hash fragment (legacy)
    const hash = window.location.hash
    if (hash.includes('access_token')) {
      setStatus('success')
      setTimeout(() => router.push('/'), 1500)
      return
    }

    // Nothing matched
    setStatus('error')
    setMessage('Invalid confirmation link. Please sign up again or contact support.')
  }, [searchParams, router])

  return (
    <div className="min-h-screen flex items-center justify-center px-4"
      style={{ background: '#0a0d12' }}>
      <div className="w-full max-w-sm text-center space-y-6">

        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>Σ</div>
          <div className="text-left">
            <div className="text-lg font-bold tracking-tight text-white">CONSILIUM</div>
            <div className="text-[10px] font-mono text-white/25">Signal Convergence Engine</div>
          </div>
        </div>

        {status === 'verifying' && (
          <div className="space-y-4">
            <div className="flex justify-center gap-1.5">
              {[0,1,2].map(i => (
                <span key={i} className="w-2 h-2 rounded-full thinking-dot"
                  style={{ background: '#a78bfa', animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
            <p className="text-white/50 text-sm">Verifying your email…</p>
          </div>
        )}

        {status === 'success' && (
          <div className="space-y-4">
            <div className="text-5xl">✓</div>
            <div>
              <h1 className="text-xl font-bold text-white mb-2">Email confirmed!</h1>
              <p className="text-sm text-white/50">Taking you to Wali-OS…</p>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-5">
            <div className="text-5xl">✕</div>
            <div>
              <h1 className="text-xl font-bold text-white mb-2">Confirmation failed</h1>
              <p className="text-sm text-white/50 leading-relaxed">{message}</p>
            </div>
            <div className="space-y-2">
              <button onClick={() => router.push('/login')}
                className="w-full py-3 rounded-xl font-semibold text-white transition-all hover:opacity-90"
                style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
                Back to sign in
              </button>
              <button onClick={() => router.push('/login?mode=signup')}
                className="w-full py-3 rounded-xl text-sm transition-all hover:opacity-80"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.1)' }}>
                Sign up again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function ConfirmPage() {
  return (
    <Suspense fallback={<div style={{ background: '#0a0d12', minHeight: '100vh' }} />}>
      <ConfirmInner />
    </Suspense>
  )
}
