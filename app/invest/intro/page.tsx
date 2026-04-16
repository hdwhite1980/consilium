'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Flame, TrendingUp, Target, Zap, ChevronRight, BarChart2, AlertTriangle } from 'lucide-react'

export default function InvestIntroPage() {
  const router = useRouter()
  const [accepting, setAccepting] = useState(false)
  const [checked, setChecked] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Check if already accepted
    fetch('/api/invest/intro').then(r => r.json()).then(d => {
      if (d.accepted) router.replace('/invest')
    })
    // Stagger in animation
    setTimeout(() => setVisible(true), 50)
  }, [router])

  const accept = async () => {
    if (!checked) return
    setAccepting(true)
    await fetch('/api/invest/intro', { method: 'POST' })
    router.push('/invest')
  }

  const Card = ({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) => (
    <div className="flex gap-4 p-4 rounded-2xl"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: 'rgba(249,115,22,0.12)' }}>
        {icon}
      </div>
      <div>
        <div className="text-sm font-semibold text-white mb-1">{title}</div>
        <div className="text-xs leading-relaxed" style={{ color: 'rgba(255,255,255,0.5)' }}>{body}</div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen flex flex-col" style={{
      background: 'linear-gradient(160deg, #0a0e17 0%, #0f1420 50%, #0a0e17 100%)',
      fontFamily: "'DM Sans', system-ui, sans-serif"
    }}>
      {/* Subtle fire glow top */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-96 h-64 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at top, rgba(249,115,22,0.08) 0%, transparent 70%)' }} />

      <div
        className="flex-1 flex flex-col max-w-lg mx-auto w-full px-5 py-10"
        style={{ opacity: visible ? 1 : 0, transform: visible ? 'none' : 'translateY(12px)', transition: 'opacity 0.5s ease, transform 0.5s ease' }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-10">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'rgba(249,115,22,0.15)', border: '1px solid rgba(249,115,22,0.2)' }}>
            <Flame size={18} style={{ color: '#f97316' }} />
          </div>
          <div>
            <div className="text-xs font-semibold tracking-widest uppercase" style={{ color: 'rgba(249,115,22,0.7)' }}>Consilium</div>
            <div className="text-sm font-bold text-white">Investment Journey</div>
          </div>
        </div>

        {/* Hero */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white leading-tight mb-3">
            Before you start —<br />
            <span style={{ color: '#f97316' }}>here's exactly what this is.</span>
          </h1>
          <p className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.55)' }}>
            The Invest journey is built for real markets with real stakes. 
            Spend 60 seconds here so you know what you're walking into.
          </p>
        </div>

        {/* What kind of stocks */}
        <div className="mb-3">
          <div className="text-[10px] font-semibold tracking-widest uppercase mb-3" style={{ color: 'rgba(255,255,255,0.3)' }}>
            The stocks
          </div>
          <div className="space-y-2">
            <Card
              icon={<BarChart2 size={15} style={{ color: '#f97316' }} />}
              title="Small-cap and micro-cap stocks"
              body="These are smaller companies — often under $500M market cap. They move fast, react hard to news, and have lower liquidity than large-caps. That's why they can double. It's also why they can drop 40% in a week."
            />
            <Card
              icon={<Zap size={15} style={{ color: '#fbbf24' }} />}
              title="Momentum and volume plays"
              body="The council looks for stocks with unusual volume today — something is moving them. Sometimes it's earnings, a news catalyst, a short squeeze, or sector rotation. The council identifies the setup. What happens after is the market's call."
            />
            <Card
              icon={<Target size={15} style={{ color: '#34d399' }} />}
              title="Sized to what you actually have"
              body="At $5 you're buying 2–3 shares of a $1–2 stock. At $500 you're buying 15 shares of a $25 stock. The stage system scales the price range so every position feels like a real holding — not a lottery ticket, not an afterthought."
            />
          </div>
        </div>

        {/* What the council does and doesn't do */}
        <div className="mb-6">
          <div className="text-[10px] font-semibold tracking-widest uppercase mb-3" style={{ color: 'rgba(255,255,255,0.3)' }}>
            What the council does
          </div>
          <div className="rounded-2xl p-4 space-y-2.5"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
            {[
              ['✓', 'Screens real volume movers from Alpaca\'s live market data'],
              ['✓', 'Checks sector momentum from the macro dashboard'],
              ['✓', 'Gives you a specific entry zone, stop loss, and target'],
              ['✓', 'Sizes the position to your exact available capital'],
              ['✗', 'Cannot predict what any stock will do tomorrow'],
              ['✗', 'Does not guarantee any return at any stage'],
            ].map(([mark, text]) => (
              <div key={text} className="flex items-start gap-3 text-xs">
                <span className="font-bold shrink-0 mt-0.5 w-4"
                  style={{ color: mark === '✓' ? '#34d399' : 'rgba(248,113,113,0.7)' }}>
                  {mark}
                </span>
                <span style={{ color: 'rgba(255,255,255,0.55)' }}>{text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* The honest bit */}
        <div className="rounded-2xl p-4 mb-8 flex gap-3"
          style={{ background: 'rgba(251,191,36,0.05)', border: '1px solid rgba(251,191,36,0.15)' }}>
          <AlertTriangle size={15} style={{ color: '#fbbf24', flexShrink: 0, marginTop: 2 }} />
          <p className="text-xs leading-relaxed" style={{ color: 'rgba(251,191,36,0.85)' }}>
            Every position here is real money in a real market. 
            Keep each trade small enough that a loss is a lesson, not a setback. 
            The goal of the journey is to build the habit of sizing, entering, and exiting with discipline — 
            that skill compounds over time even when individual trades don't.
          </p>
        </div>

        {/* Acknowledgement checkbox */}
        <label className="flex items-start gap-3 mb-6 cursor-pointer group">
          <div
            onClick={() => setChecked(!checked)}
            className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 mt-0.5 transition-all"
            style={{
              background: checked ? '#f97316' : 'transparent',
              border: `2px solid ${checked ? '#f97316' : 'rgba(255,255,255,0.2)'}`,
            }}>
            {checked && (
              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </div>
          <span className="text-sm leading-relaxed" style={{ color: checked ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.4)' }}>
            I understand these are volatile, small-cap stocks with real downside risk. 
            I'll only invest money I'm comfortable losing on any individual trade.
          </span>
        </label>

        {/* CTA */}
        <button
          onClick={accept}
          disabled={!checked || accepting}
          className="w-full py-4 rounded-2xl font-bold text-white flex items-center justify-center gap-2 transition-all disabled:opacity-30"
          style={{
            background: checked ? 'linear-gradient(135deg, #f97316, #ef4444)' : 'rgba(255,255,255,0.05)',
            fontSize: 15,
            boxShadow: checked ? '0 8px 32px rgba(249,115,22,0.25)' : 'none',
            transform: checked ? 'none' : 'none',
          }}>
          {accepting ? (
            <span className="flex gap-1">
              {[0,1,2].map(i => (
                <span key={i} className="w-1.5 h-1.5 rounded-full animate-bounce bg-white"
                  style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </span>
          ) : (
            <>
              Start my journey <ChevronRight size={16} />
            </>
          )}
        </button>

        <p className="text-center text-xs mt-4" style={{ color: 'rgba(255,255,255,0.2)' }}>
          You'll only see this once. We log your acceptance.
        </p>
      </div>
    </div>
  )
}
