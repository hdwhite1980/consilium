'use client'

import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'
import { Eye, EyeOff, Check, TrendingUp, BarChart2, Brain, Shield, Zap, Calendar } from 'lucide-react'

const BENEFITS = [
  { icon: <Brain size={16} />,      color: '#a78bfa', text: 'AI council debates every stock — 4 roles, one verdict' },
  { icon: <BarChart2 size={16} />,  color: '#60a5fa', text: 'Full technical suite with plain English explanations' },
  { icon: <Shield size={16} />,     color: '#34d399', text: 'Smart money — congressional trades, SEC filings, options flow' },
  { icon: <Zap size={16} />,        color: '#fbbf24', text: "Today's & Tomorrow's Movers — AI-scanned daily catalysts" },
  { icon: <TrendingUp size={16} />, color: '#f87171', text: 'Options strategy recommendations with live contract data' },
  { icon: <Calendar size={16} />,   color: '#a78bfa', text: 'Earnings calendar, analyst ratings, insider activity' },
]

function SignupInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [showPw, setShowPw]       = useState(false)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [sent, setSent]           = useState(false)

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createClient()
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/confirm`,
      }
    })

    if (error) {
      setError(
        error.message.includes('already registered') || error.message.includes('already exists')
          ? 'An account with this email already exists. Sign in instead.'
          : error.message.includes('Password')
          ? 'Password must be at least 6 characters.'
          : error.message
      )
      setLoading(false)
    } else {
      setSent(true)
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4"
        style={{ background: '#0a0d12' }}>
        <div className="w-full max-w-sm text-center space-y-5">
          <div className="flex items-center justify-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>Σ</div>
            <div className="text-left">
              <div className="text-lg font-bold tracking-tight text-white">CONSILIUM</div>
              <div className="text-[10px] font-mono text-white/25">Signal Convergence Engine</div>
            </div>
          </div>
          <div className="text-5xl mb-2">📧</div>
          <h1 className="text-2xl font-bold text-white">Check your inbox</h1>
          <p className="text-sm text-white/55 leading-relaxed">
            We sent a confirmation link to <span className="text-white/80 font-medium">{email}</span>.
            Click it to activate your account and start your 7-day free trial.
          </p>
          <div className="rounded-xl p-4 text-left space-y-2"
            style={{ background: 'rgba(167,139,250,0.07)', border: '1px solid rgba(167,139,250,0.2)' }}>
            <p className="text-xs font-semibold" style={{ color: '#a78bfa' }}>What happens next</p>
            {['Click the link in your email', 'Your 7-day free trial starts immediately', 'No credit card required'].map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <Check size={12} style={{ color: '#34d399' }} />
                <span className="text-xs text-white/55">{s}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-white/25">
            Didn&apos;t get it? Check your spam folder, or{' '}
            <button onClick={() => setSent(false)} className="underline hover:text-white/50 transition-colors">
              try again
            </button>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col lg:flex-row" style={{ background: '#0a0d12' }}>

      {/* Left — value props (hidden on small screens) */}
      <div className="hidden lg:flex flex-col justify-center px-12 py-16 flex-1 border-r"
        style={{ borderColor: 'rgba(255,255,255,0.06)', background: '#0d1117' }}>

        <div className="max-w-md">
          {/* Logo */}
          <div className="flex items-center gap-3 mb-12">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-xl font-bold text-white"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>Σ</div>
            <div>
              <div className="text-xl font-bold tracking-tight text-white">CONSILIUM</div>
              <div className="text-[10px] font-mono text-white/25">Signal Convergence Engine</div>
            </div>
          </div>

          <h1 className="text-3xl font-bold text-white mb-3 leading-tight">
            Your AI stock<br />analysis council.
          </h1>
          <p className="text-white/50 text-base mb-10 leading-relaxed">
            Three AI roles debate every stock. One judge delivers the verdict — with price target, entry/exit levels, and plain English explanations for every signal.
          </p>

          <div className="space-y-4">
            {BENEFITS.map((b, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: `${b.color}15` }}>
                  <span style={{ color: b.color }}>{b.icon}</span>
                </div>
                <span className="text-sm text-white/60">{b.text}</span>
              </div>
            ))}
          </div>

          <div className="mt-12 pt-8 border-t" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
            <div className="flex items-center gap-3 mb-1">
              <span className="text-2xl font-bold text-white">$19</span>
              <span className="text-white/40">/month after trial</span>
            </div>
            <div className="flex items-center gap-2">
              <Check size={13} style={{ color: '#34d399' }} />
              <span className="text-sm" style={{ color: '#34d399' }}>7-day free trial · No credit card required</span>
            </div>
          </div>
        </div>
      </div>

      {/* Right — signup form */}
      <div className="flex flex-col justify-center px-6 py-12 lg:w-[440px] lg:shrink-0">

        {/* Mobile logo */}
        <div className="flex items-center gap-3 mb-10 lg:hidden">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>Σ</div>
          <div>
            <div className="text-lg font-bold tracking-tight text-white">CONSILIUM</div>
            <div className="text-[10px] font-mono text-white/25">Signal Convergence Engine</div>
          </div>
        </div>

        <div className="w-full max-w-sm mx-auto">
          <h2 className="text-2xl font-bold text-white mb-1">Create your account</h2>
          <p className="text-sm text-white/40 mb-8">Start your 7-day free trial — no card required.</p>

          <form onSubmit={handleSignup} className="space-y-4">
            {/* Email */}
            <div>
              <label className="block text-xs font-mono text-white/40 mb-1.5 uppercase tracking-wider">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com" required autoComplete="email"
                className="w-full rounded-xl px-4 py-3 text-sm outline-none border transition-all"
                style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }}
                onFocus={e => e.target.style.borderColor = '#7c3aed'}
                onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'} />
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs font-mono text-white/40 mb-1.5 uppercase tracking-wider">Password</label>
              <div className="relative">
                <input type={showPw ? 'text' : 'password'} value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Min. 6 characters" required minLength={6} autoComplete="new-password"
                  className="w-full rounded-xl px-4 py-3 pr-11 text-sm outline-none border transition-all"
                  style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }}
                  onFocus={e => e.target.style.borderColor = '#7c3aed'}
                  onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'} />
                <button type="button" onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors">
                  {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-xl"
                style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>
                <span className="text-red-400 mt-0.5 shrink-0">⚠</span>
                <p className="text-xs text-red-400 leading-relaxed">{error}</p>
              </div>
            )}

            {/* Trial reminder */}
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl"
              style={{ background: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.18)' }}>
              <Check size={13} style={{ color: '#34d399' }} />
              <span className="text-xs" style={{ color: '#34d399' }}>7-day free trial starts immediately. Cancel anytime.</span>
            </div>

            <button type="submit" disabled={loading}
              className="w-full py-3.5 rounded-xl font-bold text-white transition-all hover:opacity-90 disabled:opacity-50 text-base"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
              {loading ? 'Creating account…' : 'Start free trial'}
            </button>
          </form>

          <div className="mt-6 text-center space-y-3">
            <p className="text-xs text-white/30">
              Already have an account?{' '}
              <button onClick={() => router.push('/login')}
                className="text-white/60 hover:text-white transition-colors underline">
                Sign in
              </button>
            </p>
            <p className="text-[10px] text-white/20 leading-relaxed">
              By creating an account you agree to our{' '}
              <button onClick={() => router.push('/disclaimer')}
                className="underline hover:text-white/40 transition-colors">
                disclaimer and terms
              </button>
              . Consilium does not provide financial advice.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SignupPage() {
  return (
    <Suspense fallback={<div style={{ background: '#0a0d12', minHeight: '100vh' }} />}>
      <SignupInner />
    </Suspense>
  )
}
