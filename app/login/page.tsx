'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'
import { Eye, EyeOff, AlertCircle } from 'lucide-react'

function LoginPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw]     = useState(false)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [mode, setMode]         = useState<'login' | 'signup' | 'reset'>('login')
  const [resetSent, setResetSent] = useState(false)

  const redirect = searchParams.get('redirect') || '/'

  // If there's an error param from callback or session displacement
  useEffect(() => {
    const errParam = searchParams.get('error')
    const msgParam = searchParams.get('message')
    if (msgParam) {
      setError(msgParam)
    } else if (errParam === 'session_displaced') {
      setError('You were signed out because your account was logged into from another device.')
    } else if (errParam) {
      setError('Authentication failed. Please try again.')
    }
  }, [searchParams])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createClient()

    try {
      if (mode === 'reset') {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth/callback?next=/`,
        })
        if (error) throw error
        setResetSent(true)
        setLoading(false)
        return
      }

      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` }
        })
        if (error) throw error
        setError(null)
        // Show confirmation message
        setMode('login')
        setError('Check your email to confirm your account, then log in.')
        setLoading(false)
        return
      }

      // Login
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error

      // Register this device as the only active session
      // This kicks out any other device currently using this account
      if (data.session?.access_token) {
        const sessionToken = data.session.access_token.slice(-32)
        await fetch('/api/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionToken }),
        })
      }

      router.push(redirect)
      router.refresh()

    } catch (err: unknown) {
      const msg = (err as Error).message || 'Something went wrong'
      setError(
        msg.includes('Invalid login') ? 'Incorrect email or password.' :
        msg.includes('Email not confirmed') ? 'Please check your email and confirm your account first.' :
        msg.includes('User already registered') ? 'An account with this email already exists. Try logging in.' :
        msg.includes('Password should be') ? 'Password must be at least 6 characters.' :
        msg
      )
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4"
      style={{ background: '#0a0d12' }}>

      {/* Logo */}
      <div className="flex items-center gap-3 mb-10">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white"
          style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
          Σ
        </div>
        <div>
          <div className="text-lg font-bold tracking-tight text-white">CONSILIUM</div>
          <div className="text-[10px] font-mono text-white/25">Signal Convergence Engine</div>
        </div>
      </div>

      {/* Card */}
      <div className="w-full max-w-sm rounded-2xl border p-8"
        style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}>

        {/* Title */}
        <div className="mb-7">
          <h1 className="text-xl font-bold text-white mb-1">
            {mode === 'login' ? 'Welcome back' : mode === 'signup' ? 'Create account' : 'Reset password'}
          </h1>
          <p className="text-sm text-white/35">
            {mode === 'login' ? 'Sign in to access your analysis dashboard' :
             mode === 'signup' ? 'Get access to the AI stock council' :
             'Enter your email and we\'ll send a reset link'}
          </p>
        </div>

        {/* Reset sent confirmation */}
        {resetSent ? (
          <div className="text-center space-y-4">
            <div className="text-4xl">📧</div>
            <p className="text-sm text-white/70">Password reset email sent. Check your inbox.</p>
            <button onClick={() => { setMode('login'); setResetSent(false) }}
              className="text-sm text-white/40 hover:text-white/70 underline transition-colors">
              Back to login
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Email */}
            <div>
              <label className="block text-xs font-mono text-white/40 mb-1.5 uppercase tracking-wider">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
                className="w-full rounded-lg px-4 py-3 text-sm outline-none transition-colors border"
                style={{
                  background: '#181e2a',
                  borderColor: 'rgba(255,255,255,0.1)',
                  color: 'white',
                }}
                onFocus={e => e.target.style.borderColor = '#7c3aed'}
                onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
              />
            </div>

            {/* Password */}
            {mode !== 'reset' && (
              <div>
                <label className="block text-xs font-mono text-white/40 mb-1.5 uppercase tracking-wider">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showPw ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    minLength={6}
                    className="w-full rounded-lg px-4 py-3 pr-11 text-sm outline-none transition-colors border"
                    style={{
                      background: '#181e2a',
                      borderColor: 'rgba(255,255,255,0.1)',
                      color: 'white',
                    }}
                    onFocus={e => e.target.style.borderColor = '#7c3aed'}
                    onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
                  />
                  <button type="button" onClick={() => setShowPw(!showPw)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors">
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            )}

            {/* Error / info message */}
            {error && (
              <div className="flex items-start gap-2 p-3 rounded-lg"
                style={{
                  background: error.includes('Check your email') || error.includes('confirm')
                    ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)',
                  border: `1px solid ${error.includes('Check your email') || error.includes('confirm')
                    ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'}`,
                }}>
                <AlertCircle size={14} className="shrink-0 mt-0.5"
                  style={{ color: error.includes('Check your email') ? '#34d399' : '#f87171' }} />
                <p className="text-xs leading-relaxed"
                  style={{ color: error.includes('Check your email') ? '#34d399' : '#f87171' }}>
                  {error}
                </p>
              </div>
            )}

            {/* Forgot password */}
            {mode === 'login' && (
              <div className="text-right">
                <button type="button" onClick={() => { setMode('reset'); setError(null) }}
                  className="text-xs text-white/30 hover:text-white/60 transition-colors">
                  Forgot password?
                </button>
              </div>
            )}

            {/* Submit */}
            <button type="submit" disabled={loading}
              className="w-full py-3 rounded-lg font-semibold text-sm text-white transition-all hover:opacity-90 active:scale-98 disabled:opacity-50 mt-2"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
              {loading
                ? 'Please wait...'
                : mode === 'login' ? 'Sign in'
                : mode === 'signup' ? 'Create account'
                : 'Send reset link'}
            </button>

            {/* Mode toggle */}
            <div className="text-center pt-2">
              {mode === 'login' ? (
                <p className="text-xs text-white/30">
                  Don&apos;t have an account?{' '}
                  <button type="button" onClick={() => { setMode('signup'); setError(null) }}
                    className="text-white/60 hover:text-white transition-colors underline">
                    Sign up
                  </button>
                </p>
              ) : (
                <button type="button" onClick={() => { setMode('login'); setError(null) }}
                  className="text-xs text-white/30 hover:text-white/60 transition-colors">
                  ← Back to login
                </button>
              )}
            </div>
          </form>
        )}
      </div>

      <div className="mt-6 flex items-center gap-4 justify-center">
        <a href="/subscribe"
          className="text-[11px] font-mono text-white/30 hover:text-white/60 transition-colors underline">
          View pricing
        </a>
        <span className="text-white/15 text-xs">·</span>
        <p className="text-[10px] font-mono text-white/15">
          Not financial advice
        </p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div style={{ background: '#0a0d12', minHeight: '100vh' }} />}>
      <LoginPageInner />
    </Suspense>
  )
}
