'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { Check, Zap, Shield, TrendingUp, BarChart2, Brain } from 'lucide-react'

const FEATURES = [
  { icon: <Brain size={15} />,      text: 'AI council debates every analysis — News Scout, Lead Analyst, Devil\'s Advocate, Council Verdict' },
  { icon: <BarChart2 size={15} />,  text: 'Full technical suite — RSI, MACD, Stochastic, VWAP, OBV, Fibonacci, Bollinger Bands' },
  { icon: <TrendingUp size={15} />, text: 'Fundamentals, analyst ratings, earnings calendar, insider activity' },
  { icon: <Shield size={15} />,     text: 'Smart money signals — congressional trades, SEC filings, options flow' },
  { icon: <Zap size={15} />,        text: 'Today\'s Movers — AI-scanned daily news identifying potential winners and losers' },
  { icon: <Check size={15} />,      text: 'Plain English explanations — every signal explained for all experience levels' },
]

function SubscribeInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const canceled = searchParams.get('canceled') === 'true'
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)

  // If already logged in, show the page normally — don't auto-redirect
  // User came here intentionally to see pricing
  useEffect(() => {
    setChecking(false)
  }, [])

  const handleSubscribe = async () => {
    setLoading(true)
    setError(null)
    try {
      // Check if logged in first
      const { createClient } = await import('@/app/lib/auth/client')
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()

      if (!user) {
        // Not logged in — send to login with redirect back to subscribe
        router.push('/login?redirect=/subscribe')
        return
      }

      const res = await fetch('/api/stripe/checkout', { method: 'POST' })
      const text = await res.text()
      let data: { url?: string; error?: string } = {}
      try { data = JSON.parse(text) } catch { 
        setError(`Server error (${res.status}): ${text.slice(0, 200)}`)
        setLoading(false)
        return
      }
      if (data.url) {
        window.location.href = data.url
      } else {
        setError(data.error || `Checkout failed (${res.status})`)
        setLoading(false)
      }
    } catch {
      setError('Failed to start checkout. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col px-4 py-8"
      style={{ background: '#0a0d12' }}>

      {/* Back button */}
      <div className="w-full max-w-md mx-auto mb-6">
        <button onClick={() => router.push('/login')}
          className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors">
          ← Back to sign in
        </button>
      </div>

      <div className="flex flex-col items-center flex-1 justify-center">

      {/* Logo */}
      <div className="flex items-center gap-3 mb-10">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white"
          style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>Σ</div>
        <div>
          <div className="text-lg font-bold tracking-tight text-white">CONSILIUM</div>
          <div className="text-[10px] font-mono text-white/25">Signal Convergence Engine</div>
        </div>
      </div>

      {canceled && (
        <div className="mb-6 px-4 py-3 rounded-xl text-sm text-white/60 border"
          style={{ background: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.08)' }}>
          No worries — your trial is still available whenever you&apos;re ready.
        </div>
      )}

      <div className="w-full max-w-md">

        {/* Pricing card */}
        <div className="rounded-2xl border overflow-hidden"
          style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}>

          {/* Header */}
          <div className="p-6 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
            <div className="flex items-end gap-2 mb-1">
              <span className="text-4xl font-bold text-white">$19</span>
              <span className="text-white/40 mb-1.5">/month</span>
            </div>
            <div className="text-sm text-white/50">after your free trial</div>

            {/* Trial badge */}
            <div className="mt-4 flex items-center gap-2 px-3 py-2 rounded-xl"
              style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)' }}>
              <span style={{ color: '#34d399' }}>✓</span>
              <div>
                <div className="text-sm font-semibold" style={{ color: '#34d399' }}>7-day free trial</div>
                <div className="text-[11px] text-white/40">No credit card required to start</div>
              </div>
            </div>
          </div>

          {/* Features */}
          <div className="p-6 space-y-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
            {FEATURES.map((f, i) => (
              <div key={i} className="flex items-start gap-3">
                <span className="shrink-0 mt-0.5" style={{ color: '#a78bfa' }}>{f.icon}</span>
                <span className="text-sm text-white/60 leading-snug">{f.text}</span>
              </div>
            ))}
          </div>

          {/* CTA */}
          <div className="p-6 space-y-3">
            {error && (
              <div className="text-xs text-red-400 px-3 py-2 rounded-lg"
                style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>
                {error}
              </div>
            )}

            <button onClick={handleSubscribe} disabled={loading}
              className="w-full py-3.5 rounded-xl font-bold text-white transition-all hover:opacity-90 active:scale-98 disabled:opacity-50 text-base"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
              {loading ? 'Redirecting to checkout…' : 'Start free trial'}
            </button>

            <p className="text-[11px] text-white/25 text-center leading-relaxed">
              Your 7-day trial starts immediately. No payment needed until your trial ends.
              Cancel anytime before then and you won&apos;t be charged.
            </p>
          </div>
        </div>

        {/* Disclaimer snippet */}
        <p className="mt-6 text-[10px] text-white/20 text-center leading-relaxed px-4">
          Consilium is for informational purposes only and does not constitute financial advice.
          Past analysis does not guarantee future results. See full disclaimer on login.
        </p>
      </div>

      </div>{/* end centered content */}
    </div>
  )
}

export default function SubscribePage() {
  return (
    <Suspense fallback={<div style={{ background: '#0a0d12', minHeight: '100vh' }} />}>
      <SubscribeInner />
    </Suspense>
  )
}
