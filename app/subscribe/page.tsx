'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Check, Zap, ArrowLeft } from 'lucide-react'

const STANDARD_FEATURES = [
  'Full 6-stage AI debate on every analysis',
  'All timeframes — 1D, 1W, 1M, 3M',
  'Unlimited analyses',
  'Portfolio analysis (up to 15 positions)',
  'Macro sector dashboard',
  "Today's Movers + Tomorrow's Playbook",
  'Trading Academy — all lessons & glossary',
  '24+ technical indicators',
  'Options strategy recommendations',
  'Smart money & insider signals',
  '7-day free trial',
]

const PRO_FEATURES = [
  'Everything in Standard, plus:',
  'Head-to-Head Compare (2 stocks simultaneously)',
  'Reinvestment Tracker with AI tiered strategies',
  'Forex — 21 currency pairs',
  'Unlimited portfolio positions',
  'Analysis history & export',
  'Priority analysis queue',
  'Pro-tier during free trial',
]

function PricingCard({
  tier, price, title, description, features, highlight, loading, onSelect,
}: {
  tier: 'standard' | 'pro'
  price: string
  title: string
  description: string
  features: string[]
  highlight: boolean
  loading: boolean
  onSelect: (tier: 'standard' | 'pro') => void
}) {
  return (
    <div className="flex flex-col rounded-2xl overflow-hidden relative"
      style={{
        background: highlight ? 'linear-gradient(135deg, rgba(124,58,237,0.12), rgba(79,70,229,0.08))' : '#111620',
        border: highlight ? '2px solid rgba(167,139,250,0.4)' : '1px solid rgba(255,255,255,0.08)',
      }}>

      {highlight && (
        <div className="absolute top-0 left-0 right-0 flex justify-center">
          <span className="text-[11px] font-bold px-4 py-1 rounded-b-lg"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)', color: 'white' }}>
            Most popular
          </span>
        </div>
      )}

      <div className="p-7 pt-8 flex-1">
        <div className="mb-5">
          <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5"
            style={{ color: highlight ? '#a78bfa' : 'rgba(255,255,255,0.4)' }}>
            {title}
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-4xl font-bold text-white">{price}</span>
            <span className="text-sm" style={{ color: 'rgba(255,255,255,0.4)' }}>/month</span>
          </div>
          <p className="text-sm mt-2" style={{ color: 'rgba(255,255,255,0.5)' }}>{description}</p>
        </div>

        <ul className="space-y-2.5">
          {features.map((f, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <Check size={13} className="mt-0.5 shrink-0"
                style={{ color: i === 0 && tier === 'pro' ? 'rgba(255,255,255,0.3)' : '#34d399' }} />
              <span className="text-xs leading-relaxed"
                style={{ color: i === 0 && tier === 'pro' ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.7)' }}>
                {f}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="p-7 pt-0">
        <button
          onClick={() => onSelect(tier)}
          disabled={loading}
          className="w-full py-3.5 rounded-xl text-sm font-bold transition-all disabled:opacity-50"
          style={highlight
            ? { background: 'linear-gradient(135deg,#7c3aed,#4f46e5)', color: 'white' }
            : { background: 'rgba(255,255,255,0.06)', color: 'white', border: '1px solid rgba(255,255,255,0.12)' }}>
          {loading ? 'Opening checkout...' : 'Start 7-day free trial'}
        </button>
        <p className="text-center text-[11px] mt-2.5" style={{ color: 'rgba(255,255,255,0.3)' }}>
          No credit card required
        </p>
      </div>
    </div>
  )
}

function SubscribeInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const canceled = searchParams.get('canceled') === 'true'
  const [loading, setLoading] = useState<'standard' | 'pro' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSubscribe = async (tier: 'standard' | 'pro') => {
    setLoading(tier)
    setError(null)
    try {
      const { createClient } = await import('@/app/lib/auth/client')
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()

      if (!user) {
        router.push(`/login?redirect=/subscribe`)
        return
      }

      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        setError(data.error ?? 'Checkout failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#0a0d12', color: 'white' }}>

      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-xs hover:opacity-70 transition-opacity"
          style={{ color: 'rgba(255,255,255,0.4)' }}>
          <ArrowLeft size={13} /> Back
        </button>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <Zap size={14} style={{ color: '#a78bfa' }} />
          <span className="text-sm font-bold">Consilium</span>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-3xl">

          {canceled && (
            <div className="mb-6 px-4 py-3 rounded-xl text-sm text-center"
              style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', color: '#fbbf24' }}>
              Checkout was canceled — your trial is still active.
            </div>
          )}

          {error && (
            <div className="mb-6 px-4 py-3 rounded-xl text-sm text-center"
              style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171' }}>
              {error}
            </div>
          )}

          {/* Hero */}
          <div className="text-center mb-10">
            <h1 className="text-3xl font-bold mb-3">
              Professional AI stock analysis
            </h1>
            <p className="text-base max-w-lg mx-auto" style={{ color: 'rgba(255,255,255,0.5)' }}>
              An AI council that argues both sides before every trade decision.
              Start free for 7 days — no credit card required.
            </p>
          </div>

          {/* Pricing cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-8">
            <PricingCard
              tier="standard"
              price="$29"
              title="Standard"
              description="Full analysis power for investors and swing traders."
              features={STANDARD_FEATURES}
              highlight={false}
              loading={loading === 'standard'}
              onSelect={handleSubscribe}
            />
            <PricingCard
              tier="pro"
              price="$49"
              title="Pro"
              description="Everything an active trader needs in one platform."
              features={PRO_FEATURES}
              highlight={true}
              loading={loading === 'pro'}
              onSelect={handleSubscribe}
            />
          </div>

          {/* Comparison note */}
          <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-xs text-center mb-4" style={{ color: 'rgba(255,255,255,0.3)' }}>
              Not sure? During the 7-day trial you get full Pro access on both plans.
            </p>
            <div className="grid grid-cols-3 gap-4 text-center">
              {[
                { label: 'Analysis quality', standard: '✓', pro: '✓' },
                { label: 'Head-to-head Compare', standard: '—', pro: '✓' },
                { label: 'Reinvestment Tracker', standard: '—', pro: '✓' },
                { label: 'Forex pairs', standard: '—', pro: '✓' },
                { label: 'Unlimited portfolio', standard: '—', pro: '✓' },
                { label: 'Trading Academy', standard: '✓', pro: '✓' },
              ].map(row => (
                <div key={row.label} className="col-span-3 grid grid-cols-3 items-center py-2 border-b last:border-0"
                  style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                  <span className="text-xs text-left" style={{ color: 'rgba(255,255,255,0.5)' }}>{row.label}</span>
                  <span className="text-xs font-mono" style={{ color: row.standard === '✓' ? '#34d399' : 'rgba(255,255,255,0.2)' }}>{row.standard}</span>
                  <span className="text-xs font-mono" style={{ color: row.pro === '✓' ? '#a78bfa' : 'rgba(255,255,255,0.2)' }}>{row.pro}</span>
                </div>
              ))}
              <div className="col-span-3 grid grid-cols-3 mt-1">
                <div />
                <div className="text-[10px] font-mono uppercase tracking-widest text-center" style={{ color: 'rgba(255,255,255,0.3)' }}>Standard</div>
                <div className="text-[10px] font-mono uppercase tracking-widest text-center" style={{ color: '#a78bfa' }}>Pro</div>
              </div>
            </div>
          </div>

          <p className="text-center text-xs mt-6" style={{ color: 'rgba(255,255,255,0.25)' }}>
            Cancel anytime. Analysis is for informational purposes only — not financial advice.
          </p>
        </div>
      </div>
    </div>
  )
}

export default function SubscribePage() {
  return (
    <Suspense>
      <SubscribeInner />
    </Suspense>
  )
}
