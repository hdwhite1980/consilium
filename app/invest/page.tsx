'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Plus, X, TrendingUp, TrendingDown, Flame, Zap, Target, RefreshCw, CheckCircle, Trophy } from 'lucide-react'
import { Tutorial, TutorialLauncher, INVEST_TUTORIAL } from '@/app/components/Tutorial'

// ── Milestone config ──────────────────────────────────────────
// Mirror of getPriceRange from the ideas API route
function getClientPriceRange(deployable: number, maxPositions: number): { minPrice: number; maxPrice: number } {
  const per = deployable / Math.max(1, maxPositions)
  if (per <= 5)    return { minPrice: 0.5, maxPrice: 5 }
  if (per <= 20)   return { minPrice: 1,   maxPrice: Math.min(8,   per * 0.7) }
  if (per <= 100)  return { minPrice: 2,   maxPrice: Math.min(25,  per * 0.6) }
  if (per <= 500)  return { minPrice: 5,   maxPrice: Math.min(60,  per * 0.5) }
  if (per <= 2000) return { minPrice: 10,  maxPrice: Math.min(150, per * 0.4) }
  return             { minPrice: 20,  maxPrice: Math.min(500, per * 0.3) }
}

const MILESTONES = [
  { name: 'Spark',   emoji: '🔥',  min: 0,      max: 10,     color: '#fbbf24', desc: '$1–$5 stocks · momentum plays' },
  { name: 'Ember',   emoji: '🔥🔥', min: 10,     max: 50,     color: '#f97316', desc: '$1–$8 stocks · technical setups' },
  { name: 'Flame',   emoji: '🔥🔥🔥', min: 50,   max: 200,    color: '#ef4444', desc: '$1–$15 stocks · catalysts + technicals' },
  { name: 'Blaze',   emoji: '⚡',   min: 200,    max: 1000,   color: '#a78bfa', desc: '$2–$50 stocks · full debate analysis' },
  { name: 'Inferno', emoji: '💎',   min: 1000,   max: 10000,  color: '#60a5fa', desc: '$5–$200 stocks · conviction plays' },
  { name: 'Free',    emoji: '🏆',   min: 10000,  max: Infinity, color: '#34d399', desc: 'Any stock · full platform' },
]

function getMilestone(total: number) {
  return MILESTONES.find(m => total >= m.min && total < m.max) ?? MILESTONES[0]
}

function getNextMilestone(total: number) {
  const idx = MILESTONES.findIndex(m => total >= m.min && total < m.max)
  return MILESTONES[idx + 1] ?? null
}

// ── Helpers ───────────────────────────────────────────────────
const fmt$ = (n: number | null | undefined, decimals = 2) => {
  const v = n ?? 0
  if (v < 100) return `$${Math.abs(v).toFixed(decimals)}`
  return `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}
const fmtPct = (n: number | null | undefined) => {
  const v = n ?? 0
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
}

interface Trade {
  id: string
  ticker: string
  shares: number
  entry_price: number
  exit_price: number | null
  exit_date: string | null
  council_signal: string | null
  confidence: number | null
  notes: string | null
  opened_at: string
  currentPrice?: number | null
  pnl?: number | null
  pnlPct?: number | null
}

interface Journey {
  starting_balance: number
  win_streak: number
  best_streak: number
  total_trades: number
  winning_trades: number
  first_win_at: string | null
}

interface Idea {
  ticker: string
  companyName: string
  price: number
  livePrice?: number
  sector: string
  signal: string
  confidence: number
  catalyst: string
  rationale: string
  suggestedAmount: number
  suggestedShares: number
  entry: string
  stop: string
  stopPct: number
  target: string
  targetPct: number
  risk: string
  timeframe: string
  volumeNote: string
}

function useDarkMode() {
  const [isDark, setIsDark] = useState(true)
  useEffect(() => {
    const check = () => setIsDark(document.documentElement.getAttribute('data-theme') !== 'light')
    check()
    const obs = new MutationObserver(check)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return isDark
}

// ── Log Trade Modal ───────────────────────────────────────────
function LogModal({ onSave, onClose, prefill }: {
  onSave: (d: { ticker: string; shares: number; entry_price: number; council_signal?: string; confidence?: number; notes?: string }) => Promise<void>
  onClose: () => void
  prefill?: Partial<{ ticker: string; entry_price: number; shares: number; council_signal: string; confidence: number }>
}) {
  const [ticker, setTicker] = useState(prefill?.ticker ?? '')
  const [shares, setShares] = useState(prefill?.shares?.toString() ?? '1')
  const [entry, setEntry] = useState(prefill?.entry_price?.toFixed(2) ?? '')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const isDark = useDarkMode()
  const surf = isDark ? '#111620' : '#fff'
  const brd = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  const txt = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)'
  const txt2 = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'
  const inputBg = isDark ? '#1a2236' : '#f5f7fb'

  const submit = async () => {
    if (!ticker || !entry || !shares) return
    setSaving(true)
    await onSave({ ticker, shares: parseFloat(shares), entry_price: parseFloat(entry), council_signal: prefill?.council_signal, confidence: prefill?.confidence, notes })
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-sm rounded-2xl p-5 space-y-4" style={{ background: surf, border: `1px solid ${brd}` }}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold" style={{ color: txt }}>Log trade</span>
          <button onClick={onClose} style={{ color: txt2 }}><X size={16} /></button>
        </div>
        {[
          { label: 'Ticker', val: ticker, set: (v: string) => setTicker(v.toUpperCase()), ph: 'e.g. SNDL' },
          { label: 'Shares', val: shares, set: setShares, ph: '1' },
          { label: 'Entry price ($)', val: entry, set: setEntry, ph: '1.84' },
        ].map(({ label, val, set, ph }) => (
          <div key={label}>
            <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: txt2 }}>{label}</div>
            <input value={val} onChange={e => set(e.target.value)} placeholder={ph}
              className="w-full px-3 py-2 rounded-lg text-sm font-mono outline-none border"
              style={{ background: inputBg, borderColor: brd, color: txt }} />
          </div>
        ))}
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: txt2 }}>Notes (optional)</div>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Why you're buying..."
            className="w-full px-3 py-2 rounded-lg text-sm outline-none border"
            style={{ background: inputBg, borderColor: brd, color: txt }} />
        </div>
        <button onClick={submit} disabled={saving || !ticker || !entry}
          className="w-full py-3 rounded-xl text-sm font-bold text-white disabled:opacity-40"
          style={{ background: 'linear-gradient(135deg,#f97316,#ef4444)' }}>
          {saving ? 'Saving...' : 'Log trade 🔥'}
        </button>
      </div>
    </div>
  )
}

// ── Close Trade Modal ─────────────────────────────────────────
function CloseModal({ trade, onClose, onSave }: {
  trade: Trade
  onClose: () => void
  onSave: (exitPrice: number) => Promise<void>
}) {
  const [exit, setExit] = useState(trade.currentPrice?.toFixed(2) ?? '')
  const [saving, setSaving] = useState(false)
  const isDark = useDarkMode()
  const surf = isDark ? '#111620' : '#fff'
  const brd = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  const txt = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)'
  const txt2 = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'
  const inputBg = isDark ? '#1a2236' : '#f5f7fb'

  const exitNum = parseFloat(exit)
  const pnl = !isNaN(exitNum) ? (exitNum - trade.entry_price) * trade.shares : null
  const pnlPct = !isNaN(exitNum) && trade.entry_price > 0 ? ((exitNum - trade.entry_price) / trade.entry_price) * 100 : null
  const isWin = (pnl ?? 0) > 0

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-sm rounded-2xl p-5 space-y-4" style={{ background: surf, border: `1px solid ${brd}` }}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold" style={{ color: txt }}>Close {trade.ticker}</span>
          <button onClick={onClose} style={{ color: txt2 }}><X size={16} /></button>
        </div>
        <div className="text-xs" style={{ color: txt2 }}>
          {trade.shares} shares · entry {fmt$(trade.entry_price)} · cost {fmt$(trade.entry_price * trade.shares)}
        </div>
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: txt2 }}>Exit price ($)</div>
          <input value={exit} onChange={e => setExit(e.target.value)} placeholder={trade.currentPrice?.toFixed(2) ?? ''}
            className="w-full px-3 py-2 rounded-lg text-sm font-mono outline-none border"
            style={{ background: inputBg, borderColor: brd, color: txt }} />
        </div>
        {pnl !== null && (
          <div className="px-4 py-3 rounded-xl text-sm font-bold text-center"
            style={{ background: isWin ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)', color: isWin ? '#34d399' : '#f87171' }}>
            {isWin ? '🔥 ' : ''}{fmt$(pnl)} ({fmtPct(pnlPct)})
            {isWin ? ' — locked in!' : ' — learning experience'}
          </div>
        )}
        <button onClick={async () => { setSaving(true); await onSave(exitNum); setSaving(false) }}
          disabled={saving || isNaN(exitNum)}
          className="w-full py-3 rounded-xl text-sm font-bold text-white disabled:opacity-40"
          style={{ background: isWin ? 'linear-gradient(135deg,#34d399,#059669)' : 'linear-gradient(135deg,#f87171,#dc2626)' }}>
          {saving ? 'Closing...' : isWin ? 'Lock in the win 🔥' : 'Close trade'}
        </button>
      </div>
    </div>
  )
}

// ── First win celebration ─────────────────────────────────────
function FirstWin({ amount, onDismiss }: { amount: number; onDismiss: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-6" style={{ background: 'rgba(0,0,0,0.85)' }}>
      <div className="text-center max-w-xs">
        <div className="text-6xl mb-4">🔥</div>
        <div className="text-2xl font-bold text-white mb-2">First win.</div>
        <div className="text-lg font-mono text-yellow-400 mb-3">{fmt$(amount)} profit</div>
        <div className="text-sm mb-6" style={{ color: 'rgba(255,255,255,0.6)' }}>This is how it starts. Every journey begins with a single win.</div>
        <button onClick={onDismiss} className="px-8 py-3 rounded-xl text-sm font-bold text-white"
          style={{ background: 'linear-gradient(135deg,#f97316,#ef4444)' }}>
          Keep going 🔥
        </button>
      </div>
    </div>
  )
}

// ── Start Balance Screen ──────────────────────────────────────
function StartScreen({ onStart }: { onStart: (balance: number) => void }) {
  const [amount, setAmount] = useState('')
  const isDark = useDarkMode()
  const txt = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)'
  const txt2 = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'
  const brd = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  const inputBg = isDark ? '#1a2236' : '#f5f7fb'
  const presets = ['$1', '$5', '$10', '$25', '$50', '$100']

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-6 text-center" style={{ background: 'var(--bg)' }}>
      <div className="text-6xl mb-6">🔥</div>
      <h1 className="text-2xl font-bold mb-2" style={{ color: txt }}>Start your journey</h1>
      <p className="text-sm mb-8 max-w-xs" style={{ color: txt2 }}>
        Every portfolio starts somewhere. Enter how much you have to invest today — even $1 is enough to begin.
      </p>

      <div className="w-full max-w-xs space-y-4">
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-lg font-mono" style={{ color: txt2 }}>$</span>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="5.00"
            className="w-full pl-8 pr-4 py-4 rounded-2xl text-xl font-mono font-bold outline-none border text-center"
            style={{ background: inputBg, borderColor: brd, color: txt }}
          />
        </div>

        <div className="flex flex-wrap gap-2 justify-center">
          {presets.map(p => (
            <button key={p} onClick={() => setAmount(p.replace('$', ''))}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80"
              style={{ background: 'rgba(249,115,22,0.1)', color: '#f97316', border: '1px solid rgba(249,115,22,0.2)' }}>
              {p}
            </button>
          ))}
        </div>

        <button
          onClick={() => { const v = parseFloat(amount); if (v > 0) onStart(v) }}
          disabled={!amount || parseFloat(amount) <= 0}
          className="w-full py-4 rounded-2xl text-base font-bold text-white disabled:opacity-40 transition-all hover:opacity-90"
          style={{ background: 'linear-gradient(135deg,#f97316,#ef4444)' }}>
          Start my journey 🔥
        </button>

        <p className="text-xs text-center" style={{ color: txt2 }}>
          {parseFloat(amount) >= 500
            ? 'Stocks at this level are volatile and can drop 20–30% quickly. Size positions to what you can afford to lose.'
            : parseFloat(amount) >= 50
            ? 'Small-cap stocks are speculative — most traders lose money on them. The stage system teaches discipline, not guaranteed returns.'
            : 'Stocks in this price range are highly speculative. Most people lose money. Start small, learn the discipline, build from there.'}
        </p>
      </div>
    </div>
  )
}

// ── Idea Card ─────────────────────────────────────────────────
function IdeaCard({ idea, onLog, router, isDark }: {
  idea: Idea
  onLog: (prefill: Partial<{ ticker: string; entry_price: number; shares: number; council_signal: string }>) => void
  router: ReturnType<typeof useRouter>
  isDark: boolean
}) {
  const surf = isDark ? '#111620' : '#fff'
  const surf2 = isDark ? '#181e2a' : '#f5f7fb'
  const brd = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)'
  const txt = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)'
  const txt2 = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
  const txt3 = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'
  const displayPrice = idea.livePrice ?? idea.price
  const riskColor = idea.risk === 'high' ? '#f87171' : idea.risk === 'medium' ? '#fbbf24' : '#34d399'

  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid rgba(249,115,22,0.2)`, background: surf }}>
      <div className="px-4 py-3 flex items-center justify-between" style={{ background: 'rgba(249,115,22,0.06)', borderBottom: `1px solid rgba(249,115,22,0.12)` }}>
        <div className="flex items-center gap-2">
          <Zap size={12} style={{ color: '#f97316' }} />
          <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: '#f97316' }}>Council pick</span>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded-full font-mono"
          style={{ background: `${riskColor}15`, color: riskColor }}>{idea.risk} risk</span>
      </div>

      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold font-mono" style={{ color: txt }}>{idea.ticker}</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full"
                style={{ background: idea.signal === 'BULLISH' ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)', color: idea.signal === 'BULLISH' ? '#34d399' : '#f87171' }}>
                {idea.signal} {idea.confidence}%
              </span>
            </div>
            <div className="text-xs mt-0.5" style={{ color: txt3 }}>{idea.companyName} · {idea.sector}</div>
          </div>
          <div className="text-right">
            <div className="text-lg font-bold font-mono" style={{ color: txt }}>{fmt$(displayPrice)}</div>
            {idea.volumeNote && <div className="text-[10px]" style={{ color: '#fbbf24' }}>{idea.volumeNote}</div>}
          </div>
        </div>

        <div className="px-3 py-2 rounded-lg text-xs" style={{ background: surf2, color: txt2 }}>
          <span className="font-semibold" style={{ color: '#f97316' }}>Catalyst: </span>{idea.catalyst}
        </div>

        <p className="text-xs leading-relaxed" style={{ color: txt2 }}>{idea.rationale}</p>

        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Entry', val: idea.entry, color: txt },
            { label: 'Stop', val: `${idea.stop} (${idea.stopPct}%)`, color: '#f87171' },
            { label: 'Target', val: `${idea.target} (${idea.targetPct}%)`, color: '#34d399' },
          ].map(({ label, val, color }) => (
            <div key={label} className="rounded-lg px-2.5 py-2" style={{ background: surf2 }}>
              <div className="text-[9px] font-mono uppercase mb-0.5" style={{ color: txt3 }}>{label}</div>
              <div className="text-[11px] font-semibold font-mono leading-snug" style={{ color }}>{val}</div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-1">
          <div>
            <span className="text-[10px]" style={{ color: txt3 }}>Suggested: </span>
            <span className="text-[11px] font-mono font-semibold" style={{ color: txt }}>{idea.suggestedShares} shares · {fmt$(idea.suggestedAmount)}</span>
          </div>
          <span className="text-[10px]" style={{ color: txt3 }}>⏱ {idea.timeframe}</span>
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={() => router.push(`/?ticker=${idea.ticker}`)}
            className="flex-1 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-80"
            style={{ background: 'rgba(167,139,250,0.08)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.15)' }}>
            Full council debate →
          </button>
          <button onClick={() => onLog({ ticker: idea.ticker, entry_price: displayPrice, shares: idea.suggestedShares, council_signal: idea.signal })}
            className="flex-1 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-80"
            style={{ background: 'rgba(249,115,22,0.1)', color: '#f97316', border: '1px solid rgba(249,115,22,0.2)' }}>
            Log this trade 🔥
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main inner component ──────────────────────────────────────
function InvestInner() {
  const router = useRouter()
  const [trades, setTrades] = useState<Trade[]>([])
  const [journey, setJourney] = useState<Journey | null>(null)
  const [loading, setLoading] = useState(true)
  const [introAccepted, setIntroAccepted] = useState<boolean | null>(null)
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [journeyNote, setJourneyNote] = useState('')
  const [stageAdvice, setStageAdvice] = useState('')
  const [marketContext, setMarketContext] = useState('')
  const [topSectors, setTopSectors] = useState<Array<{ name: string; signal: string; change1D: number }>>([])
  const [loadingIdeas, setLoadingIdeas] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [prefill, setPrefill] = useState<Partial<{ ticker: string; entry_price: number; shares: number; council_signal: string }> | undefined>()
  const [closeTarget, setCloseTarget] = useState<Trade | null>(null)
  const [showFirstWin, setShowFirstWin] = useState(false)
  const [firstWinAmount, setFirstWinAmount] = useState(0)
  const [tab, setTab] = useState<'ideas' | 'trades' | 'history'>('ideas')
  const [showTutorial, setShowTutorial] = useState(false)
  const [priceUpdatedAt, setPriceUpdatedAt] = useState<Date | null>(null)
  const isDark = useDarkMode()

  // Market hours check (US Eastern Time)
  const isMarketOpen = () => {
    const now = new Date()
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const day = et.getDay()
    const hour = et.getHours()
    const min = et.getMinutes()
    const mins = hour * 60 + min
    // Mon–Fri, 9:30am–4:00pm ET
    return day >= 1 && day <= 5 && mins >= 570 && mins < 960
  }

  const txt  = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)'
  const txt2 = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
  const txt3 = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.35)'
  const surf = isDark ? '#111620' : '#fff'
  const surf2 = isDark ? '#181e2a' : '#f5f7fb'
  const brd  = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)'

  const loadData = useCallback(async () => {
    // Check intro acceptance first
    try {
      const introRes = await fetch('/api/invest/intro')
      const introData = await introRes.json()
      setIntroAccepted(introData.accepted)
      if (!introData.accepted) {
        setLoading(false)
        return
      }
    } catch { setIntroAccepted(false); setLoading(false); return }

    try {
      const res = await fetch('/api/invest')
      const data = await res.json()
      setJourney(data.journey)

      // Fetch live prices
      const openTrades = (data.trades ?? []).filter((t: Trade) => !t.exit_price)
      const enriched = await Promise.all(openTrades.map(async (t: Trade) => {
        try {
          const r = await fetch(`/api/ticker?ticker=${t.ticker}`)
          const d = await r.json()
          const cp: number | null = d?.price ?? null
          return { ...t, currentPrice: cp, pnl: cp ? (cp - t.entry_price) * t.shares : null, pnlPct: cp ? ((cp - t.entry_price) / t.entry_price) * 100 : null }
        } catch { return { ...t, currentPrice: null, pnl: null, pnlPct: null } }
      }))

      const closed = (data.trades ?? []).filter((t: Trade) => t.exit_price)
      setTrades([...enriched, ...closed])
      setPriceUpdatedAt(new Date())
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Auto-start tutorial on first visit
  useEffect(() => {
    fetch('/api/tutorial?id=invest')
      .then(r => r.json())
      .then(({ progress }) => {
        if (!progress || (!progress.completed && !progress.skipped)) setShowTutorial(true)
      }).catch(() => {})
  }, [])

  // Relaunch on custom event
  useEffect(() => {
    const handler = (e: Event) => {
      const { tutorialId } = (e as CustomEvent).detail
      if (tutorialId === 'invest') {
        setShowTutorial(false)
        setTimeout(() => setShowTutorial(true), 0)
      }
    }
    window.addEventListener('consilium:launch_tutorial', handler)
    return () => window.removeEventListener('consilium:launch_tutorial', handler)
  }, [])

  // Auto-refresh prices every 5 min during market hours
  useEffect(() => {
    const refreshPrices = async () => {
      if (!isMarketOpen()) return
      setTrades(prev => {
        const open = prev.filter(t => !t.exit_price)
        if (!open.length) return prev
        Promise.all(open.map(async t => {
          try {
            const r = await fetch(`/api/ticker?ticker=${t.ticker}`)
            const d = await r.json()
            const cp: number | null = d?.price ?? null
            return { ...t, currentPrice: cp, pnl: cp ? (cp - t.entry_price) * t.shares : null, pnlPct: cp ? ((cp - t.entry_price) / t.entry_price) * 100 : null }
          } catch { return t }
        })).then(enriched => {
          const closed = prev.filter(t => !!t.exit_price)
          setTrades([...enriched, ...closed])
          setPriceUpdatedAt(new Date())
        })
        return prev
      })
    }
    const interval = setInterval(refreshPrices, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  const openTrades = trades.filter(t => !t.exit_price)
  const closedTrades = trades.filter(t => !!t.exit_price)

  // Compute total portfolio value
  const unrealizedValue = openTrades.reduce((s, t) => s + (t.currentPrice ?? t.entry_price) * t.shares, 0)
  const realized = closedTrades.reduce((s, t) => s + (t.exit_price! - t.entry_price) * t.shares, 0)
  const totalInvested = openTrades.reduce((s, t) => s + t.entry_price * t.shares, 0)
  const startBal = journey?.starting_balance ?? 0
  // Cash remaining = starting balance - what's currently deployed + any realized gains/losses
  const cashRemaining = Math.max(0, startBal - totalInvested + realized)
  // Total = cash on hand + current market value of open positions
  const totalValue = cashRemaining + unrealizedValue
  const openPnL = unrealizedValue - totalInvested
  const milestone = getMilestone(totalValue)
  const stageMaxPositions = MILESTONES.findIndex(m => m.name === milestone.name) + 2 // 2..7
  const stagePriceRange = getClientPriceRange(cashRemaining, stageMaxPositions)
  const nextMilestone = getNextMilestone(totalValue)
  const progress = nextMilestone ? Math.min(100, ((totalValue - milestone.min) / (nextMilestone.min - milestone.min)) * 100) : 100

  const loadIdeas = async () => {
    setLoadingIdeas(true)
    try {
      const res = await fetch('/api/invest/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totalValue, openTrades, startingBalance: startBal, cashRemaining }),
      })
      const data = await res.json()
      setIdeas(data.ideas ?? [])
      setJourneyNote(data.journeyNote ?? '')
      setStageAdvice(data.stageAdvice ?? '')
      setMarketContext(data.marketContext ?? '')
      setTopSectors(data.topSectors ?? [])
      setTab('ideas')
    } catch { /* ignore */ }
    setLoadingIdeas(false)
  }

  const logTrade = async (d: { ticker: string; shares: number; entry_price: number; council_signal?: string; confidence?: number; notes?: string }) => {
    await fetch('/api/invest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'open_trade', ...d }) })
    await loadData()
    setShowLog(false)
    setPrefill(undefined)
  }

  const closeTrade = async (exitPrice: number) => {
    if (!closeTarget) return
    const res = await fetch('/api/invest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'close_trade', id: closeTarget.id, exit_price: exitPrice }) })
    const data = await res.json()
    if (data.isWin && !journey?.first_win_at) {
      const pnl = (exitPrice - closeTarget.entry_price) * closeTarget.shares
      setFirstWinAmount(pnl)
      setShowFirstWin(true)
    }
    setCloseTarget(null)
    await loadData()
  }

  const setBalance = async (balance: number) => {
    await fetch('/api/invest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'set_balance', balance }) })
    await loadData()
  }

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen" style={{ background: 'var(--bg)' }}>
      <div className="flex gap-1">{[0,1,2].map(i => <span key={i} className="w-2 h-2 rounded-full animate-bounce" style={{ background: '#f97316', animationDelay: `${i*0.15}s` }} />)}</div>
    </div>
  )

  if (introAccepted === false) {
    router.replace('/invest/intro')
    return null
  }

  if (!journey) return <StartScreen onStart={setBalance} />

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: txt }}>
      {showTutorial && (
        <Tutorial config={INVEST_TUTORIAL} autoStart
          onComplete={() => setShowTutorial(false)}
          onSkip={() => setShowTutorial(false)} />
      )}
      {showFirstWin && <FirstWin amount={firstWinAmount} onDismiss={() => setShowFirstWin(false)} />}
      {showLog && <LogModal onSave={logTrade} onClose={() => { setShowLog(false); setPrefill(undefined) }} prefill={prefill} />}
      {closeTarget && <CloseModal trade={closeTarget} onClose={() => setCloseTarget(null)} onSave={closeTrade} />}

      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b sticky top-0 z-10 shrink-0" style={{ background: surf, borderColor: brd }}>
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-xs hover:opacity-70" style={{ color: txt3 }}>
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: brd }} />
        <Flame size={14} style={{ color: '#f97316' }} />
        <span className="text-sm font-bold" style={{ color: txt }}>Invest</span>
        <div className="flex-1" />
        <button onClick={() => { setShowLog(true); setPrefill(undefined) }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
          style={{ background: 'rgba(249,115,22,0.1)', color: '#f97316', border: '1px solid rgba(249,115,22,0.2)' }}>
          <Plus size={11} /> Log trade
        </button>
        <TutorialLauncher tutorialId="invest" label="How it works" />
      </header>

      {/* Tabs */}
      <div className="flex border-b px-4 shrink-0" style={{ borderColor: brd, background: surf }}>
        {(['ideas', 'trades', 'history'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className="px-4 py-2.5 text-xs font-semibold capitalize border-b-2 transition-all"
            style={{ color: tab === t ? '#f97316' : txt3, borderColor: tab === t ? '#f97316' : 'transparent' }}>
            {t === 'ideas' ? '⚡ Ideas' : t === 'trades' ? `📊 Open (${openTrades.length})` : `📋 History (${closedTrades.length})`}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-5 space-y-5">

          {/* Journey card */}
          <div className="rounded-2xl p-4 space-y-4" style={{ border: `2px solid ${milestone.color}30`, background: `${milestone.color}06` }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-full flex items-center justify-center text-xl"
                  style={{ background: `${milestone.color}15`, border: `1px solid ${milestone.color}30` }}>
                  {milestone.emoji}
                </div>
                <div>
                  <div className="text-base font-bold" style={{ color: milestone.color }}>{milestone.name}</div>
                  <div className="text-xs" style={{ color: txt3 }}>{milestone.desc}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold font-mono" style={{ color: txt }}>{fmt$(totalValue)}</div>
                <div className="flex items-center justify-end gap-1.5 mt-0.5">
                  <div className="w-1.5 h-1.5 rounded-full" style={{ background: isMarketOpen() ? '#34d399' : txt3 }} />
                  <div className="text-[10px]" style={{ color: txt3 }}>
                    {isMarketOpen() ? 'live · refreshes 5min' : priceUpdatedAt ? `last close · ${priceUpdatedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'market closed'}
                  </div>
                </div>
              </div>
            </div>

            {nextMilestone && (
              <div>
                <div className="flex justify-between text-[10px] mb-1.5" style={{ color: txt3 }}>
                  <span>{milestone.emoji} {milestone.name}</span>
                  <span>{fmt$(nextMilestone.min - totalValue)} to {nextMilestone.name}</span>
                  <span>{nextMilestone.emoji} {nextMilestone.name}</span>
                </div>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: surf2 }}>
                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${progress}%`, background: milestone.color }} />
                </div>
              </div>
            )}

            <div className="grid grid-cols-4 gap-2">
              {[
                { label: 'In play', val: `${openPnL >= 0 ? '+' : ''}${fmt$(openPnL)}`, color: openPnL >= 0 ? '#34d399' : '#f87171' },
                { label: 'Locked in', val: fmt$(realized), color: realized >= 0 ? '#34d399' : '#f87171' },
                { label: 'Win streak', val: `${journey.win_streak} 🔥`, color: '#fbbf24' },
                { label: 'Win rate', val: journey.total_trades > 0 ? `${Math.round((journey.winning_trades / journey.total_trades) * 100)}%` : '—', color: txt },
              ].map(({ label, val, color }) => (
                <div key={label} className="rounded-xl p-2.5 text-center" style={{ background: surf2 }}>
                  <div className="text-[9px] font-mono uppercase tracking-widest mb-1" style={{ color: txt3 }}>{label}</div>
                  <div className="text-sm font-bold font-mono" style={{ color }}>{val}</div>
                </div>
              ))}
            </div>
          </div>

          {/* IDEAS tab */}
          {tab === 'ideas' && (
            <div className="space-y-4">
              {ideas.length === 0 ? (
                <div className="rounded-2xl p-8 text-center" style={{ background: surf, border: `1px solid ${brd}` }}>
                  <div className="text-3xl mb-3">⚡</div>
                  <p className="text-sm font-semibold mb-1" style={{ color: txt }}>Get today's real volume movers</p>
                  <p className="text-xs mb-5" style={{ color: txt3 }}>
                    The council pulls actual stocks moving today from the Alpaca volume screener — filtered to your price range — then adds sector context and a trade plan. Real data, not guesses.
                  </p>
                  <button onClick={loadIdeas} disabled={loadingIdeas}
                    className="flex items-center gap-2 mx-auto px-6 py-3 rounded-xl text-sm font-bold text-white disabled:opacity-50"
                    style={{ background: 'linear-gradient(135deg,#f97316,#ef4444)' }}>
                    {loadingIdeas ? <RefreshCw size={14} className="animate-spin" /> : <Zap size={14} />}
                    {loadingIdeas ? 'Finding picks...' : `Get ${milestone.name} picks 🔥`}
                  </button>
                </div>
              ) : (
                <>
                  {/* Sector performance strip */}
                  {topSectors.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {topSectors.map(s => (
                        <div key={s.name} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg shrink-0"
                          style={{ background: s.signal === 'BULLISH' ? 'rgba(52,211,153,0.08)' : s.signal === 'BEARISH' ? 'rgba(248,113,113,0.08)' : surf2, border: `1px solid ${s.signal === 'BULLISH' ? 'rgba(52,211,153,0.2)' : s.signal === 'BEARISH' ? 'rgba(248,113,113,0.2)' : brd}` }}>
                          <span className="text-[10px] font-semibold" style={{ color: s.signal === 'BULLISH' ? '#34d399' : s.signal === 'BEARISH' ? '#f87171' : txt3 }}>{s.name}</span>
                          <span className="text-[10px] font-mono" style={{ color: s.change1D >= 0 ? '#34d399' : '#f87171' }}>{s.change1D >= 0 ? '+' : ''}{s.change1D.toFixed(2)}%</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {journeyNote && (
                    <div className="px-4 py-3 rounded-xl text-sm" style={{ background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.15)', color: '#f97316' }}>
                      🔥 {journeyNote}
                    </div>
                  )}
                  {marketContext && (
                    <div className="px-4 py-2.5 rounded-xl text-xs" style={{ background: surf2, border: `1px solid ${brd}`, color: txt2 }}>
                      <span className="font-semibold" style={{ color: txt }}>Market: </span>{marketContext}
                    </div>
                  )}
                  {stageAdvice && (
                    <div className="px-4 py-2.5 rounded-xl text-xs" style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)', color: txt2 }}>
                      <span className="font-semibold" style={{ color: '#a78bfa' }}>Stage tip: </span>{stageAdvice}
                    </div>
                  )}
                  {/* Ideas grid — 2 columns */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {ideas.map((idea, i) => (
                      <IdeaCard key={`${idea.ticker}-${i}`} idea={idea} router={router} isDark={isDark}
                        onLog={pf => { setPrefill(pf); setShowLog(true) }} />
                    ))}
                  </div>
                  <button onClick={loadIdeas} disabled={loadingIdeas}
                    className="w-full py-3 rounded-xl text-xs font-semibold transition-all hover:opacity-80 flex items-center justify-center gap-2"
                    style={{ background: surf2, color: txt3, border: `1px solid ${brd}` }}>
                    <RefreshCw size={11} className={loadingIdeas ? 'animate-spin' : ''} />
                    {loadingIdeas ? 'Refreshing...' : 'Get new picks'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* OPEN TRADES tab */}
          {tab === 'trades' && (
            <div className="space-y-3">
              {openTrades.length === 0 ? (
                <div className="rounded-2xl p-8 text-center" style={{ background: surf, border: `1px solid ${brd}` }}>
                  <p className="text-sm" style={{ color: txt3 }}>No open positions. Log a trade or get picks from the ideas tab.</p>
                  <button onClick={() => setTab('ideas')} className="mt-4 text-xs px-4 py-2 rounded-lg"
                    style={{ color: '#f97316', background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.2)' }}>
                    Get picks →
                  </button>
                </div>
              ) : (
                openTrades.map(t => (
                  <div key={t.id} className="rounded-2xl overflow-hidden" style={{ background: surf, border: `1px solid ${brd}` }}>
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                        style={{ background: (t.pnl ?? 0) >= 0 ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)' }}>
                        <span className="text-[10px] font-mono font-bold"
                          style={{ color: (t.pnl ?? 0) >= 0 ? '#34d399' : '#f87171' }}>{t.ticker.slice(0,4)}</span>
                      </div>
                      <div className="flex-1">
                        <div className="text-sm font-bold" style={{ color: txt }}>{t.ticker}</div>
                        <div className="text-xs" style={{ color: txt3 }}>
                          {t.shares} shares · entry {fmt$(t.entry_price)} · cost {fmt$(t.entry_price * t.shares)}
                        </div>
                      </div>
                      <div className="text-right mr-2">
                        {t.currentPrice ? (
                          <>
                            <div className="text-sm font-bold font-mono" style={{ color: txt }}>{fmt$(t.currentPrice)}</div>
                            <div className="text-xs font-mono" style={{ color: (t.pnl ?? 0) >= 0 ? '#34d399' : '#f87171' }}>
                              {(t.pnl ?? 0) >= 0 ? '+' : ''}{fmt$(t.pnl)} ({fmtPct(t.pnlPct)})
                            </div>
                          </>
                        ) : <span className="text-xs" style={{ color: txt3 }}>Loading...</span>}
                      </div>
                      <button onClick={() => setCloseTarget(t)}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0"
                        style={{ background: surf2, color: txt2, border: `1px solid ${brd}` }}>
                        Close
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* HISTORY tab */}
          {tab === 'history' && (
            <div className="space-y-2">
              {closedTrades.length === 0 ? (
                <div className="rounded-2xl p-8 text-center" style={{ background: surf, border: `1px solid ${brd}` }}>
                  <p className="text-sm" style={{ color: txt3 }}>No closed trades yet. Close your first position to see your results here.</p>
                </div>
              ) : (
                <>
                  {closedTrades.map(t => {
                    const pnl = (t.exit_price! - t.entry_price) * t.shares
                    const pnlPct = ((t.exit_price! - t.entry_price) / t.entry_price) * 100
                    const isWin = pnl > 0
                    return (
                      <div key={t.id} className="flex items-center gap-3 px-4 py-3 rounded-xl" style={{ background: surf, border: `1px solid ${brd}` }}>
                        <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: isWin ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)' }}>
                          {isWin ? <CheckCircle size={13} style={{ color: '#34d399' }} /> : <X size={13} style={{ color: '#f87171' }} />}
                        </div>
                        <div className="flex-1">
                          <div className="text-sm font-bold" style={{ color: txt }}>{t.ticker}</div>
                          <div className="text-xs" style={{ color: txt3 }}>{t.shares} shares · {fmt$(t.entry_price)} → {fmt$(t.exit_price!)}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-bold font-mono" style={{ color: isWin ? '#34d399' : '#f87171' }}>
                            {isWin ? '+' : ''}{fmt$(pnl)}
                          </div>
                          <div className="text-xs font-mono" style={{ color: isWin ? '#34d399' : '#f87171' }}>
                            {fmtPct(pnlPct)}
                          </div>
                        </div>
                      </div>
                    )
                  })}

                  {/* Stats summary */}
                  {closedTrades.length >= 2 && (
                    <div className="rounded-2xl p-4 mt-4" style={{ background: surf, border: `1px solid ${brd}` }}>
                      <div className="text-[10px] font-mono uppercase tracking-widest mb-3" style={{ color: txt3 }}>Journey stats</div>
                      <div className="grid grid-cols-3 gap-3">
                        {[
                          { label: 'Total P&L', val: fmt$(closedTrades.reduce((s,t) => s + (t.exit_price! - t.entry_price) * t.shares, 0)), color: '#34d399' },
                          { label: 'Win rate', val: `${Math.round((journey.winning_trades / Math.max(1, journey.total_trades)) * 100)}%`, color: txt },
                          { label: 'Best streak', val: `${journey.best_streak} 🔥`, color: '#fbbf24' },
                        ].map(({ label, val, color }) => (
                          <div key={label} className="text-center rounded-lg p-2" style={{ background: surf2 }}>
                            <div className="text-[9px] font-mono uppercase" style={{ color: txt3 }}>{label}</div>
                            <div className="text-sm font-bold font-mono mt-0.5" style={{ color }}>{val}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function InvestPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen" style={{ background: 'var(--bg)' }}>
        <div className="flex gap-1">{[0,1,2].map(i => <span key={i} className="w-2 h-2 rounded-full animate-bounce" style={{ background: '#f97316', animationDelay: `${i*0.15}s` }} />)}</div>
      </div>
    }>
      <InvestInner />
    </Suspense>
  )
}
