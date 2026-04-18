'use client'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Plus, X, RefreshCw, Activity } from 'lucide-react'
import { Tutorial, TutorialLauncher, INVEST_TUTORIAL } from '@/app/components/Tutorial'
import { DeskNote } from '@/app/components/desk/DeskNote'
import { FloorEmbers } from '@/app/components/desk/FloorEmbers'
import { useContextualLessons } from '@/app/components/desk/useContextualLessons'
import { INVEST_LESSONS, findLessonByTrigger, type InvestLesson } from '@/app/lib/invest-lessons'

// ══════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════
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
  floor_seen_at?: string | null
}

interface Tier {
  name: string
  color: string
  min: number
  max: number | null
  tagline: string
  maxPositions: number
  progressPct: number
  toNext: number
  nextTierName: string | null
}

interface TierMeta {
  name: string
  color: string
  min: number
  max: number | null
  tagline: string
}

interface SectorWind {
  name: string
  etf: string
  signal: string
  change1D: number
}

interface Idea {
  ticker: string
  companyName?: string
  sector?: string
  sectorSignal?: string
  price: number
  livePrice?: number | null
  signal: string
  confidence: number
  catalyst?: string
  rationale?: string
  suggestedAmount: number
  suggestedShares: number
  entry?: string
  stop?: string
  target?: string
  stopPct?: number
  targetPct?: number
  risk?: string
  timeframe?: string
  volumeNote?: string
}

interface FloorData {
  journey: Journey | null
  tier: Tier
  tiers: TierMeta[]
  value: { total: number; cashRemaining: number; unrealized: number; realized: number; openPnL: number }
  openTrades: Trade[]
  closedTrades: Trade[]
  stats: {
    totalTrades: number
    closedCount: number
    winCount: number
    winRate: number
    winStreak: number
    bestStreak: number
    firstWinAt: string | null
  }
  sectorWinds: SectorWind[]
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
const fmt$ = (n: number | null | undefined, decimals = 2) => {
  const v = n ?? 0
  if (Math.abs(v) < 100) return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(decimals)}`
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}
const fmtPct = (n: number | null | undefined) => {
  const v = n ?? 0
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
}
const isMarketOpen = () => {
  const now = new Date()
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const day = ny.getDay()
  if (day === 0 || day === 6) return false
  const mins = ny.getHours() * 60 + ny.getMinutes()
  return mins >= 9 * 60 + 30 && mins < 16 * 60
}
const nowETShort = () => {
  const now = new Date()
  return now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true }) + ' ET'
}

// ══════════════════════════════════════════════════════════════
// AMBIENT TAPE DRIFT (background)
// ══════════════════════════════════════════════════════════════
function TapeDrift() {
  return (
    <div className="fl-tape-drift" aria-hidden>
      <svg width="100%" height="100%" viewBox="0 0 1200 800" preserveAspectRatio="none">
        {Array.from({ length: 5 }).map((_, i) => {
          const y = 80 + i * 140
          const offset = (i * 200) % 1200
          return (
            <path
              key={i}
              d={`M -100 ${y} Q 300 ${y - 30} 600 ${y} T 1300 ${y}`}
              fill="none"
              stroke="rgba(148, 163, 184, 0.06)"
              strokeWidth="0.5"
              style={{
                animation: `tapeDrift${i} ${30 + i * 5}s linear infinite`,
                transformOrigin: 'center',
              }}
            />
          )
        })}
      </svg>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// PORTFOLIO ORB (center focal point)
// ══════════════════════════════════════════════════════════════
function PortfolioOrb({ color, gain }: { color: string; gain: boolean }) {
  return (
    <svg className="fl-orb-svg" viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <defs>
        <radialGradient id="orbGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={gain ? '#10b981' : '#dc2626'} stopOpacity="0.35" />
          <stop offset="40%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="orbCore" cx="50%" cy="50%" r="35%">
          <stop offset="0%" stopColor="#f5f5f5" stopOpacity="0.9" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* Outer halo */}
      <circle cx="110" cy="110" r="100" fill="url(#orbGrad)" className="fl-orb-halo" />
      {/* Thin tick ring */}
      <circle cx="110" cy="110" r="80" fill="none" stroke={color} strokeOpacity="0.3" strokeWidth="0.5" strokeDasharray="1 6" className="fl-orb-ring" />
      {/* Inner breathing sphere */}
      <circle cx="110" cy="110" r="54" fill="url(#orbCore)" className="fl-orb-core" />
      {/* Center dot */}
      <circle cx="110" cy="110" r="3" fill={color} className="fl-orb-dot" />
    </svg>
  )
}

// ══════════════════════════════════════════════════════════════
// START SCREEN
// ══════════════════════════════════════════════════════════════
function StartScreen({ onStart }: { onStart: (balance: number) => Promise<void> }) {
  const [amount, setAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const num = parseFloat(amount)
  const valid = !isNaN(num) && num > 0
  const presets = [5, 10, 25, 50, 100, 250]

  return (
    <div data-keep-dark="true" className="fl-root fl-start">
      <TapeDrift />
      <div className="fl-start-inner">
        <div className="fl-logo" style={{ marginBottom: 24 }}>wali · floor</div>
        <h1 className="fl-start-title">Open the book.</h1>
        <p className="fl-start-sub">
          The trading floor starts with whatever capital you have. Enter your opening balance to begin — even a dollar is enough to open the book.
        </p>

        <div className="fl-start-presets">
          {presets.map(p => (
            <button key={p} className={`fl-preset-chip ${num === p ? 'active' : ''}`} onClick={() => setAmount(String(p))}>
              ${p}
            </button>
          ))}
        </div>

        <div className="fl-start-input-row">
          <span className="fl-dollar">$</span>
          <input type="number" value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="0.00" min="1" step="0.01" inputMode="decimal" autoFocus />
        </div>

        <button className="fl-primary-btn fl-start-btn" disabled={!valid || submitting}
          onClick={async () => {
            if (!valid) return
            setSubmitting(true)
            try { await onStart(num) } finally { setSubmitting(false) }
          }}>
          {submitting ? 'Opening…' : 'Open the book →'}
        </button>

        <p className="fl-start-fineprint">
          You can change this later. The balance is your starting mark — from here, trades you log grow or shrink it.
        </p>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// ORDER TICKET (log-trade sheet)
// ══════════════════════════════════════════════════════════════
function OrderTicket({ prefill, cashRemaining, onClose, onSave }: {
  prefill?: Partial<Idea>
  cashRemaining: number
  onClose: () => void
  onSave: (data: { ticker: string; shares: number; entry_price: number; council_signal?: string; confidence?: number; notes?: string }) => Promise<void>
}) {
  const [ticker, setTicker] = useState(prefill?.ticker ?? '')
  const [shares, setShares] = useState(prefill?.suggestedShares?.toString() ?? '')
  const [price, setPrice] = useState(prefill?.livePrice?.toString() ?? prefill?.price?.toString() ?? '')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [fetchingPrice, setFetchingPrice] = useState(false)

  const sharesNum = parseFloat(shares) || 0
  const priceNum = parseFloat(price) || 0
  const cost = sharesNum * priceNum
  const cashAfter = cashRemaining - cost
  const overBudget = cost > cashRemaining
  const valid = ticker.length >= 1 && sharesNum > 0 && priceNum > 0

  const lookupPrice = useCallback(async () => {
    if (!ticker) return
    setFetchingPrice(true)
    try {
      const res = await fetch(`/api/invest/ticker-price?ticker=${encodeURIComponent(ticker)}`)
      const data = await res.json()
      if (data.price) setPrice(String(data.price))
    } catch { /* ignore */ }
    setFetchingPrice(false)
  }, [ticker])

  return (
    <div className="fl-ticket-overlay" onClick={onClose}>
      <div className="fl-ticket" onClick={e => e.stopPropagation()}>
        <div className="fl-ticket-header">
          <div>
            <span className="fl-eyebrow">order ticket</span>
            <div className="fl-ticket-time mono">{nowETShort()}</div>
          </div>
          <button className="fl-close-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="fl-ticket-body">
          <h2 className="fl-ticket-title">
            {prefill?.ticker ? <>Take the {prefill.ticker} setup</> : <>New position</>}
          </h2>
          {prefill?.rationale && <p className="fl-ticket-sub">{prefill.rationale}</p>}

          <div className="fl-field">
            <label>Ticker</label>
            <div className="fl-field-row">
              <input type="text" value={ticker}
                onChange={e => setTicker(e.target.value.toUpperCase())}
                onBlur={() => { if (!prefill && ticker) lookupPrice() }}
                placeholder="e.g. PLTR" maxLength={6}
                disabled={!!prefill?.ticker} className="fl-ticker-input" />
              {!prefill?.ticker && (
                <button className="fl-inline-btn" onClick={lookupPrice} disabled={!ticker || fetchingPrice}>
                  {fetchingPrice ? '…' : 'Fetch bid'}
                </button>
              )}
            </div>
          </div>

          <div className="fl-field-pair">
            <div className="fl-field">
              <label>Shares</label>
              <input type="number" value={shares} onChange={e => setShares(e.target.value)}
                placeholder="0" min="0" step="1" inputMode="numeric" />
            </div>
            <div className="fl-field">
              <label>Entry price</label>
              <input type="number" value={price} onChange={e => setPrice(e.target.value)}
                placeholder="0.00" min="0" step="0.01" inputMode="decimal" />
            </div>
          </div>

          <div className="fl-math-preview">
            <div className="fl-math-row"><span>Position size</span><span className="mono">{fmt$(cost)}</span></div>
            <div className="fl-math-row"><span>Cash available</span><span className="mono">{fmt$(cashRemaining)}</span></div>
            <div className="fl-math-row strong">
              <span>Cash after</span>
              <span className="mono" style={{ color: overBudget ? '#dc2626' : '#10b981' }}>{fmt$(cashAfter)}</span>
            </div>
            {overBudget && (
              <div className="fl-math-warning">Over budget by {fmt$(Math.abs(cashAfter))}. Reduce shares or entry.</div>
            )}
          </div>

          <div className="fl-field">
            <label>Notes <span style={{ opacity: 0.5 }}>(optional)</span></label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Thesis, catalyst, setup…" rows={2} />
          </div>
        </div>

        <div className="fl-ticket-footer">
          <button className="fl-ghost-btn" onClick={onClose}>Cancel</button>
          <button className="fl-primary-btn" disabled={!valid || overBudget || saving}
            onClick={async () => {
              if (!valid || overBudget) return
              setSaving(true)
              try {
                await onSave({
                  ticker: ticker.toUpperCase(),
                  shares: sharesNum,
                  entry_price: priceNum,
                  council_signal: prefill?.signal,
                  confidence: prefill?.confidence,
                  notes: notes || undefined,
                })
              } finally { setSaving(false) }
            }}>
            {saving ? 'Submitting…' : 'Submit order →'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// MARK TO MARKET (close-trade sheet)
// ══════════════════════════════════════════════════════════════
function MarkToMarket({ trade, onClose, onSave }: {
  trade: Trade
  onClose: () => void
  onSave: (exitPrice: number) => Promise<void>
}) {
  const [exitPrice, setExitPrice] = useState(trade.currentPrice?.toString() ?? '')
  const [saving, setSaving] = useState(false)
  const exitNum = parseFloat(exitPrice)
  const valid = !isNaN(exitNum) && exitNum > 0
  const pnl = valid ? (exitNum - trade.entry_price) * trade.shares : 0
  const pnlPct = valid ? ((exitNum - trade.entry_price) / trade.entry_price) * 100 : 0
  const isWin = pnl > 0

  return (
    <div className="fl-ticket-overlay" onClick={onClose}>
      <div className="fl-ticket" onClick={e => e.stopPropagation()}>
        <div className="fl-ticket-header">
          <div>
            <span className="fl-eyebrow">mark to market · {trade.ticker}</span>
            <div className="fl-ticket-time mono">{nowETShort()}</div>
          </div>
          <button className="fl-close-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="fl-ticket-body">
          <h2 className="fl-ticket-title">Close position at market.</h2>
          <p className="fl-ticket-sub">
            Held: <span className="mono">{trade.shares}</span> shares @ <span className="mono">{fmt$(trade.entry_price)}</span>. What was your fill?
          </p>
          <div className="fl-field">
            <label>Exit price</label>
            <input type="number" value={exitPrice} onChange={e => setExitPrice(e.target.value)}
              placeholder="0.00" min="0" step="0.01" autoFocus inputMode="decimal" />
          </div>
          {valid && (
            <div className={`fl-pnl-preview ${isWin ? 'win' : 'loss'}`}>
              <div className="fl-pnl-label mono">Realized P&L</div>
              <div className="fl-pnl-big mono">{pnl >= 0 ? '+' : ''}{fmt$(pnl)}</div>
              <div className="fl-pnl-sub mono">{fmtPct(pnlPct)} · {isWin ? 'profit' : 'loss'}</div>
            </div>
          )}
        </div>
        <div className="fl-ticket-footer">
          <button className="fl-ghost-btn" onClick={onClose}>Cancel</button>
          <button className="fl-primary-btn" disabled={!valid || saving}
            onClick={async () => {
              if (!valid) return
              setSaving(true)
              try { await onSave(exitNum) } finally { setSaving(false) }
            }}
            style={isWin ? { background: '#10b981', color: '#052e16' } : undefined}>
            {saving ? 'Closing…' : 'Close position'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// FIRST WIN — TRADE CONFIRMATION RECEIPT
// ══════════════════════════════════════════════════════════════
function TradeConfirmation({ amount, onDismiss }: { amount: number; onDismiss: () => void }) {
  return (
    <div className="fl-confirm-overlay">
      <div className="fl-confirm-card">
        <div className="fl-confirm-header">
          <span className="fl-confirm-eyebrow mono">trade confirmation</span>
          <span className="fl-confirm-time mono">{nowETShort()}</span>
        </div>
        <div className="fl-confirm-body">
          <h1>First profit of record.</h1>
          <div className="fl-confirm-amount mono">+{fmt$(amount)}</div>
          <p>Every book starts with one. The discipline that produced this trade is what compounds.</p>
          <button onClick={onDismiss}>Return to the floor →</button>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// DESK NOTE BELL (contextual nudge)
// ══════════════════════════════════════════════════════════════
function DeskNoteBell({ lesson, onOpen, onDismiss }: { lesson: InvestLesson; onOpen: () => void; onDismiss: () => void }) {
  return (
    <div className="fl-bell-wrap">
      <button className="fl-bell" onClick={onOpen}>
        <div className="fl-bell-body">
          <div className="fl-bell-eyebrow">desk note queued · {lesson.duration}</div>
          <div className="fl-bell-title">{lesson.title}</div>
          <div className="fl-bell-sub">{lesson.subtitle}</div>
        </div>
        <span className="fl-bell-arrow">→</span>
      </button>
      <button className="fl-bell-dismiss" onClick={onDismiss} aria-label="Dismiss">
        <X size={12} />
      </button>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// TIER LADDER (left column — skyline silhouettes)
// ══════════════════════════════════════════════════════════════
function TierLadder({ tiers, tier, stats, value }: {
  tiers: TierMeta[]
  tier: Tier
  stats: { winRate: number; winStreak: number; bestStreak: number }
  value: { realized: number }
}) {
  const tierIdx = tiers.findIndex(t => t.name === tier.name)

  // Relative building heights: Buyer small, Sovereign tallest
  const heights = [20, 32, 48, 68, 92]

  return (
    <aside className="fl-ladder">
      <div className="fl-ladder-head">
        <div className="fl-eyebrow">capital hierarchy</div>
        <h3>Five tiers, one book</h3>
      </div>

      <div className="fl-skyline">
        {tiers.map((t, i) => {
          const h = heights[i] ?? 20
          const status = i < tierIdx ? 'past' : i === tierIdx ? 'current' : 'future'
          return (
            <div key={t.name} className={`fl-building fl-b-${status}`}
                 style={{
                   height: `${h}%`,
                   background: status === 'future' ? 'rgba(148, 163, 184, 0.08)' : undefined,
                   borderColor: status === 'future' ? 'rgba(148, 163, 184, 0.1)' : t.color,
                 }}>
              <div className="fl-building-top" style={{ background: status === 'future' ? 'transparent' : t.color }} />
            </div>
          )
        })}
      </div>

      <div className="fl-tiers">
        {tiers.map((t, i) => {
          const status = i < tierIdx ? 'past' : i === tierIdx ? 'current' : 'future'
          const rangeText = t.max == null ? `$${t.min.toLocaleString()}+` : `$${t.min} — $${t.max.toLocaleString()}`
          return (
            <div key={t.name} className={`fl-tier-row fl-t-${status}`}>
              <div className="fl-tier-mark" style={{ background: status === 'future' ? 'transparent' : t.color, borderColor: t.color }} />
              <div className="fl-tier-info">
                <div className="fl-tier-name">{t.name}</div>
                <div className="fl-tier-range mono">{rangeText}</div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="fl-metric-block">
        <div className="fl-metric-row">
          <span className="k">to {tier.nextTierName ?? 'apex'}</span>
          <span className="v mono">{tier.nextTierName ? fmt$(tier.toNext) : '—'}</span>
        </div>
        <div className="fl-bar">
          <div className="fl-bar-fill" style={{ width: `${tier.progressPct}%` }} />
        </div>
      </div>

      <div className="fl-metric-block">
        <div className="fl-metric-row"><span className="k">win rate</span><span className="v mono">{stats.winRate}%</span></div>
        <div className="fl-metric-row"><span className="k">current streak</span><span className="v mono">{stats.winStreak}</span></div>
        <div className="fl-metric-row"><span className="k">best streak</span><span className="v mono">{stats.bestStreak}</span></div>
        <div className="fl-metric-row" style={{ marginBottom: 0 }}>
          <span className="k">realized</span>
          <span className="v mono" style={{ color: value.realized >= 0 ? '#10b981' : '#dc2626' }}>
            {value.realized >= 0 ? '+' : ''}{fmt$(value.realized)}
          </span>
        </div>
      </div>
    </aside>
  )
}

// ══════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════
function FloorInner() {
  const router = useRouter()

  const [data, setData] = useState<FloorData | null>(null)
  const [loading, setLoading] = useState(true)
  const [introAccepted, setIntroAccepted] = useState<boolean | null>(null)

  const [ideas, setIdeas] = useState<Idea[]>([])
  const [loadingIdeas, setLoadingIdeas] = useState(false)
  const [pulledAt, setPulledAt] = useState<Date | null>(null)

  const [ticketOpen, setTicketOpen] = useState(false)
  const [ticketPrefill, setTicketPrefill] = useState<Partial<Idea> | undefined>(undefined)
  const [closeTarget, setCloseTarget] = useState<Trade | null>(null)
  const [firstWinAmount, setFirstWinAmount] = useState<number | null>(null)
  const [showTutorial, setShowTutorial] = useState(false)
  const [mobileView, setMobileView] = useState<'portfolio' | 'signals' | 'positions' | 'notes'>('portfolio')

  const [openLessonId, setOpenLessonId] = useState<string | null>(null)
  const [ctxLesson, setCtxLesson] = useState<InvestLesson | null>(null)
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set())

  const didCheckIntro = useRef(false)

  useEffect(() => {
    if (didCheckIntro.current) return
    didCheckIntro.current = true
    fetch('/api/invest/intro').then(r => r.json()).then(d => setIntroAccepted(!!d.accepted)).catch(() => setIntroAccepted(true))
  }, [])

  useEffect(() => {
    fetch('/api/invest/lessons').then(r => r.json()).then(d => {
      const ids = new Set<string>(
        ((d.progress ?? []) as Array<{ lesson_id: string; correct: boolean }>)
          .filter(p => p.correct).map(p => p.lesson_id)
      )
      setCompletedIds(ids)
    }).catch(() => {})
  }, [])

  const loadData = useCallback(async () => {
    try {
      const res = await fetch('/api/invest/floor')
      if (!res.ok) { setLoading(false); return }
      const d: FloorData = await res.json()
      setData(d)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  useEffect(() => {
    const interval = setInterval(() => { if (isMarketOpen()) loadData() }, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [loadData])

  const { pendingTrigger, dismissTrigger } = useContextualLessons({
    tier: data?.tier.name ?? 'Buyer',
    openTrades: data?.openTrades ?? [],
    closedTrades: data?.closedTrades ?? [],
    floorSeen: !!data?.journey?.floor_seen_at,
  })

  useEffect(() => {
    if (!pendingTrigger || !data) return
    const lesson = findLessonByTrigger(
      pendingTrigger,
      data.tier.name,
      completedIds,
      data.stats.totalTrades,
      data.stats.closedCount > 0
    )
    if (lesson) setCtxLesson(lesson)
    else dismissTrigger()
  }, [pendingTrigger, data, completedIds, dismissTrigger])

  useEffect(() => {
    if (data?.journey && ideas.length === 0 && !loadingIdeas && !pulledAt) pullSignals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.journey])

  const pullSignals = async () => {
    if (!data) return
    setLoadingIdeas(true)
    try {
      const res = await fetch('/api/invest/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalValue: data.value.total,
          openTrades: data.openTrades,
          startingBalance: data.journey?.starting_balance ?? 0,
          cashRemaining: data.value.cashRemaining,
        }),
      })
      const body = await res.json()
      setIdeas(body.ideas ?? [])
      setPulledAt(new Date())
    } catch { /* ignore */ }
    setLoadingIdeas(false)
  }

  const openTicketFromSignal = (idea: Idea) => { setTicketPrefill(idea); setTicketOpen(true) }
  const openTicketBlank = () => { setTicketPrefill(undefined); setTicketOpen(true) }

  const submitOrder = async (payload: { ticker: string; shares: number; entry_price: number; council_signal?: string; confidence?: number; notes?: string }) => {
    await fetch('/api/invest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'open_trade', ...payload }),
    })
    setTicketOpen(false); setTicketPrefill(undefined)
    await loadData()
  }

  const closePosition = async (exitPrice: number) => {
    if (!closeTarget) return
    const res = await fetch('/api/invest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'close_trade', id: closeTarget.id, exit_price: exitPrice }),
    })
    const body = await res.json()
    const pnl = (exitPrice - closeTarget.entry_price) * closeTarget.shares
    const isFirstWin = body.isWin && !data?.stats.firstWinAt
    setCloseTarget(null)
    await loadData()
    if (isFirstWin) setFirstWinAmount(pnl)
  }

  const setStartBalance = async (balance: number) => {
    await fetch('/api/invest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'set_balance', balance }),
    })
    await loadData()
  }

  const handleLessonComplete = async (lessonId: string, correct: boolean, answer: number) => {
    try {
      await fetch('/api/invest/lessons', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lessonId, quizAnswer: answer, correct }),
      })
      if (correct) setCompletedIds(prev => new Set(prev).add(lessonId))
    } catch { /* ignore */ }
  }

  const openLessonById = (lessonId: string) => setOpenLessonId(lessonId)
  const closeLesson = () => setOpenLessonId(null)
  const openCtxLesson = () => {
    if (!ctxLesson) return
    setOpenLessonId(ctxLesson.id)
    setCtxLesson(null)
    dismissTrigger()
  }
  const dismissCtxLesson = () => { setCtxLesson(null); dismissTrigger() }

  const openLesson = openLessonId ? INVEST_LESSONS.find(l => l.id === openLessonId) ?? null : null

  // ── Render states ─────────────────────────────────────────
  if (loading || introAccepted === null) {
    return (
      <div className="fl-loading">
        <TapeDrift />
        <div className="fl-loading-dots">
          {[0, 1, 2].map(i => <span key={i} style={{ animationDelay: `${i * 0.15}s` }} />)}
        </div>
        <FloorStyles />
      </div>
    )
  }

  if (introAccepted === false) {
    router.replace('/invest/intro')
    return null
  }

  if (!data?.journey) {
    return (<><StartScreen onStart={setStartBalance} /><FloorStyles /></>)
  }

  const { tier, tiers, value, openTrades, stats, sectorWinds } = data
  const openPnLPositive = value.openPnL >= 0

  return (
    <div data-keep-dark="true" className="fl-root">
      <TapeDrift />

      {showTutorial && <Tutorial config={INVEST_TUTORIAL} autoStart onComplete={() => setShowTutorial(false)} onSkip={() => setShowTutorial(false)} />}
      {firstWinAmount != null && <TradeConfirmation amount={firstWinAmount} onDismiss={() => setFirstWinAmount(null)} />}
      {ticketOpen && <OrderTicket prefill={ticketPrefill} cashRemaining={value.cashRemaining} onClose={() => { setTicketOpen(false); setTicketPrefill(undefined) }} onSave={submitOrder} />}
      {closeTarget && <MarkToMarket trade={closeTarget} onClose={() => setCloseTarget(null)} onSave={closePosition} />}
      {openLesson && <DeskNote lesson={openLesson} balance={value.total} onClose={closeLesson} onComplete={handleLessonComplete} alreadyCompleted={completedIds.has(openLesson.id)} />}

      {/* Topbar */}
      <header className="fl-topbar">
        <button className="fl-backbtn" onClick={() => router.push('/')} aria-label="Back"><ArrowLeft size={14} /></button>
        <span className="fl-logo">wali · floor</span>
        <span className="fl-eyebrow fl-eyebrow-inline">invest · trading desk</span>
        <div className="fl-topbar-spacer" />
        <div className="fl-live-tag">
          <span className="dot" style={{ background: isMarketOpen() ? '#10b981' : '#64748b' }} />
          <span className="label">{isMarketOpen() ? 'market live' : 'market closed'}</span>
        </div>
        <TutorialLauncher tutorialId="invest" label="How it works" />
      </header>

      {/* Ticker tape */}
      {sectorWinds.length > 0 && (
        <div className="fl-tape">
          <div className="fl-tape-label mono">sectors ›</div>
          <div className="fl-tape-scroll">
            {[...sectorWinds, ...sectorWinds].map((w, i) => (
              <span key={`${w.etf}-${i}`} className="fl-tape-tick">
                <span className="mono etf">{w.etf}</span>
                <span className={`mono pct ${w.change1D >= 0 ? 'up' : 'dn'}`}>{fmtPct(w.change1D)}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <nav className="fl-mobile-nav">
        {(['portfolio', 'signals', 'positions', 'notes'] as const).map(v => (
          <button key={v} className={mobileView === v ? 'active' : ''} onClick={() => setMobileView(v)}>
            {v === 'portfolio' ? 'portfolio' :
             v === 'signals' ? `signals${ideas.length ? ` · ${ideas.length}` : ''}` :
             v === 'positions' ? `open · ${openTrades.length}` :
             ctxLesson ? 'notes · !' : 'notes'}
          </button>
        ))}
      </nav>

      <div className="fl-stage">

        {/* LEFT — tier ladder */}
        <div className={mobileView === 'portfolio' ? 'fl-show' : 'fl-hide'}>
          <TierLadder tiers={tiers} tier={tier} stats={stats} value={value} />
        </div>

        {/* CENTER — orb + signals */}
        <main className={`fl-center ${mobileView === 'portfolio' || mobileView === 'signals' ? 'fl-show' : 'fl-hide'}`}>

          {(mobileView === 'portfolio' || mobileView === 'signals') && (
            <div className={`fl-orb-hero ${mobileView === 'signals' ? 'compact' : ''}`}>
              <PortfolioOrb color={tier.color} gain={openPnLPositive} />
              <div className="fl-orb-value">
                <div className="fl-eyebrow">book value</div>
                <div className="big mono">{fmt$(value.total)}</div>
                <div className="delta mono" style={{ color: openPnLPositive ? '#10b981' : '#dc2626' }}>
                  {openPnLPositive ? '+' : ''}{fmt$(value.openPnL)} · mtm
                </div>
              </div>
            </div>
          )}

          {mobileView === 'portfolio' && (
            <div className="fl-tier-caption">
              <h1>You are at <em style={{ color: tier.color }}>{tier.name}</em></h1>
              <p>{tier.tagline}</p>
            </div>
          )}

          <div className="fl-signals">
            <div className="fl-signals-header">
              <h2>Today's setups</h2>
              <button className="fl-pull-btn" onClick={pullSignals} disabled={loadingIdeas}>
                <RefreshCw size={11} className={loadingIdeas ? 'spinning' : ''} />
                {loadingIdeas ? 'pulling…' : 'pull new signals'}
              </button>
            </div>

            {loadingIdeas && ideas.length === 0 ? (
              <div className="fl-signals-loading">
                <Activity size={20} style={{ color: '#d4a857' }} />
                <p>Council scanning the tape…</p>
              </div>
            ) : ideas.length === 0 ? (
              <div className="fl-signals-empty">
                <p>No setups queued. Pull new signals to see today's screen.</p>
              </div>
            ) : (
              <div className="fl-signals-grid">
                {ideas.map((idea, i) => {
                  const price = idea.livePrice ?? idea.price
                  return (
                    <div key={`${idea.ticker}-${i}`} className="fl-signal-tile"
                      onClick={() => openTicketFromSignal(idea)}
                      style={{ animationDelay: `${i * 0.06}s` }}>
                      <div className="fl-signal-top">
                        <span className="fl-signal-sym">{idea.ticker}</span>
                        <span className="fl-signal-px mono">{fmt$(price)}</span>
                      </div>
                      {idea.catalyst && <div className="fl-signal-catalyst">{idea.catalyst}</div>}
                      <div className="fl-signal-meta">
                        <span className="mono">{idea.suggestedShares} sh</span>
                        <span className="fl-signal-conf mono">
                          {idea.signal?.toLowerCase() ?? 'bull'} · {idea.confidence ?? 0}%
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </main>

        {/* RIGHT — positions + notes */}
        <aside className={`fl-right ${mobileView === 'positions' || mobileView === 'notes' ? 'fl-show' : 'fl-hide'}`}>

          {ctxLesson && (mobileView === 'portfolio' || mobileView === 'notes') && (
            <DeskNoteBell lesson={ctxLesson} onOpen={openCtxLesson} onDismiss={dismissCtxLesson} />
          )}

          {(mobileView === 'portfolio' || mobileView === 'positions') && (
            <div className="fl-right-section">
              <div className="fl-eyebrow">open positions · mtm</div>
              <h3>{openTrades.length === 0 ? 'No open positions' : openTrades.length === 1 ? 'One position open' : `${openTrades.length} positions open`}</h3>

              {openTrades.length === 0 ? (
                <p className="fl-right-empty">Tap a setup in the center to open your first position.</p>
              ) : (
                openTrades.map(t => {
                  const isUp = (t.pnl ?? 0) >= 0
                  return (
                    <button key={t.id} className="fl-position-row"
                      style={{ ['--pc' as string]: isUp ? '#10b981' : '#dc2626' }}
                      onClick={() => setCloseTarget(t)}>
                      <div className="fl-position-pulse" />
                      <div className="fl-position-row1">
                        <span className="fl-position-sym">{t.ticker}</span>
                        <span className={`fl-position-pnl mono ${isUp ? 'up' : 'dn'}`}>
                          {t.pnlPct != null ? fmtPct(t.pnlPct) : '—'}
                        </span>
                      </div>
                      <div className="fl-position-row2 mono">
                        <span>{t.shares} sh @ {fmt$(t.entry_price)}</span>
                        <span>{t.currentPrice != null ? fmt$(t.currentPrice) : 'live…'}</span>
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          )}

          {(mobileView === 'portfolio' || mobileView === 'notes') && (
            <div className="fl-right-section">
              <div className="fl-eyebrow">desk notes · field manual</div>
              <h3>Notes at the desk</h3>
              <FloorEmbers
                currentStage={tier.name}
                totalTrades={stats.totalTrades}
                closedTrades={stats.closedCount}
                balance={value.total}
                onOpenLesson={openLessonById}
                pulseLessonId={ctxLesson?.id ?? null}
              />
            </div>
          )}
        </aside>
      </div>

      <div className="fl-actions">
        <button className="fl-ghost-btn" onClick={openTicketBlank}><Plus size={12} /> Manual ticket</button>
        <div className="fl-actions-spacer" />
        <button className="fl-primary-btn" onClick={pullSignals} disabled={loadingIdeas}>
          <RefreshCw size={12} className={loadingIdeas ? 'spinning' : ''} /> {loadingIdeas ? 'Pulling…' : 'New signals'}
        </button>
      </div>

      <FloorStyles />
    </div>
  )
}

function FloorStyles() {
  return (
    <style jsx global>{`
      @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,500;8..60,600&family=Inter:wght@300;400;500;600&family=IBM+Plex+Mono:wght@300;400;500&display=swap');

      .fl-root, .fl-loading, .fl-start {
        font-family: 'Inter', system-ui, sans-serif;
        color: rgba(241, 245, 249, 0.92);
        background:
          radial-gradient(ellipse at 50% -10%, rgba(212, 168, 87, 0.05) 0%, transparent 45%),
          linear-gradient(180deg, #0a0e17 0%, #0f1420 50%, #0a0e17 100%);
        min-height: 100vh;
        position: relative;
        overflow-x: hidden;
      }
      .fl-root * { box-sizing: border-box; }
      .fl-root .mono { font-family: 'IBM Plex Mono', monospace; font-weight: 400; }
      .fl-root .fl-eyebrow, .fl-eyebrow {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        color: rgba(148, 163, 184, 0.6);
        font-weight: 500;
      }

      /* ── Ambient tape drift (background) ────────── */
      .fl-tape-drift {
        position: fixed; inset: 0;
        pointer-events: none;
        z-index: 0;
      }
      @keyframes tapeDrift0 { to { transform: translateX(-1200px); } }
      @keyframes tapeDrift1 { to { transform: translateX(1200px); } }
      @keyframes tapeDrift2 { to { transform: translateX(-1200px); } }
      @keyframes tapeDrift3 { to { transform: translateX(1200px); } }
      @keyframes tapeDrift4 { to { transform: translateX(-1200px); } }

      /* ── Loading ────────────────────────────────── */
      .fl-loading { display: flex; align-items: center; justify-content: center; }
      .fl-loading-dots { display: flex; gap: 6px; z-index: 2; }
      .fl-loading-dots span {
        width: 6px; height: 6px; border-radius: 50%;
        background: #d4a857;
        animation: dotBounce 1s ease-in-out infinite;
      }
      @keyframes dotBounce { 0%,100%{transform:translateY(0);opacity:0.4;} 50%{transform:translateY(-6px);opacity:1;} }

      /* ── Start screen ───────────────────────────── */
      .fl-start { display: flex; align-items: center; justify-content: center; padding: 40px 20px; }
      .fl-start-inner { max-width: 440px; width: 100%; text-align: center; position: relative; z-index: 2; }
      .fl-logo {
        font-family: 'Source Serif 4', serif; font-weight: 600; font-size: 18px;
        letter-spacing: -0.01em; color: #f5f5f5;
      }
      .fl-start-title {
        font-family: 'Source Serif 4', serif;
        font-size: 40px; font-weight: 500;
        margin: 0 0 14px; line-height: 1.1;
        letter-spacing: -0.02em;
        color: #f5f5f5;
      }
      .fl-start-sub {
        font-family: 'Source Serif 4', serif;
        font-size: 15px; line-height: 1.6;
        color: rgba(148, 163, 184, 0.75);
        margin: 0 0 32px;
      }
      .fl-start-presets { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-bottom: 24px; }
      .fl-preset-chip {
        padding: 8px 14px; border-radius: 4px;
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(148, 163, 184, 0.15);
        color: rgba(226, 232, 240, 0.75);
        font-family: 'IBM Plex Mono', monospace; font-size: 12px;
        cursor: pointer; transition: all 0.2s ease;
      }
      .fl-preset-chip:hover { border-color: rgba(212, 168, 87, 0.4); color: #d4a857; }
      .fl-preset-chip.active { background: rgba(212, 168, 87, 0.1); border-color: #d4a857; color: #d4a857; }
      .fl-start-input-row {
        display: flex; align-items: center; gap: 8px;
        margin: 0 auto 20px; max-width: 240px;
        padding: 14px 16px; border-radius: 6px;
        background: rgba(15, 23, 42, 0.6);
        border: 1px solid rgba(212, 168, 87, 0.25);
      }
      .fl-dollar { font-family: 'IBM Plex Mono', monospace; color: rgba(148, 163, 184, 0.6); font-size: 22px; }
      .fl-start-input-row input {
        flex: 1; width: 100%; min-width: 0;
        background: transparent; border: 0; outline: 0;
        color: #f5f5f5;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 22px; font-weight: 500;
      }
      .fl-start-btn { width: 100%; max-width: 300px; margin: 0 auto 20px; display: flex; justify-content: center; }
      .fl-start-fineprint {
        font-family: 'Source Serif 4', serif;
        font-size: 12px; color: rgba(148, 163, 184, 0.45);
        font-style: italic; line-height: 1.5;
      }

      /* ── Topbar ─────────────────────────────────── */
      .fl-topbar {
        position: sticky; top: 0; z-index: 10;
        display: flex; align-items: center; gap: 14px;
        padding: 14px 24px;
        background: rgba(10, 14, 23, 0.8);
        backdrop-filter: blur(12px);
        border-bottom: 1px solid rgba(148, 163, 184, 0.08);
      }
      .fl-backbtn {
        width: 28px; height: 28px; border-radius: 6px;
        background: transparent; border: 1px solid rgba(148, 163, 184, 0.2);
        display: flex; align-items: center; justify-content: center;
        color: rgba(148, 163, 184, 0.8); cursor: pointer;
      }
      .fl-backbtn:hover { border-color: rgba(212, 168, 87, 0.4); color: #d4a857; }
      .fl-logo {
        font-family: 'Source Serif 4', serif; font-weight: 600; font-size: 16px;
        letter-spacing: -0.01em; color: #f5f5f5;
      }
      .fl-eyebrow-inline { display: none; }
      @media (min-width: 720px) { .fl-eyebrow-inline { display: inline; } }
      .fl-topbar-spacer { flex: 1; }
      .fl-live-tag {
        display: flex; align-items: center; gap: 6px;
        padding: 5px 10px; border-radius: 4px;
        background: rgba(15, 23, 42, 0.6);
        border: 1px solid rgba(148, 163, 184, 0.12);
      }
      .fl-live-tag .dot {
        width: 6px; height: 6px; border-radius: 50%;
        animation: marketPulse 2s ease-in-out infinite;
      }
      @keyframes marketPulse {
        0%,100% { opacity: 0.7; }
        50% { opacity: 1; box-shadow: 0 0 8px currentColor; }
      }
      .fl-live-tag .label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px;
        letter-spacing: 0.16em; color: rgba(226, 232, 240, 0.8); text-transform: uppercase;
      }

      /* ── Ticker tape ────────────────────────────── */
      .fl-tape {
        display: flex; align-items: center;
        background: rgba(15, 23, 42, 0.7);
        border-bottom: 1px solid rgba(148, 163, 184, 0.08);
        padding: 6px 0;
        overflow: hidden;
        position: relative; z-index: 3;
      }
      .fl-tape-label {
        flex-shrink: 0;
        padding: 0 14px;
        font-size: 9px; letter-spacing: 0.22em;
        text-transform: uppercase;
        color: rgba(148, 163, 184, 0.5);
        border-right: 1px solid rgba(148, 163, 184, 0.1);
      }
      .fl-tape-scroll {
        flex: 1;
        display: flex; gap: 24px;
        white-space: nowrap;
        animation: tapeScroll 60s linear infinite;
      }
      @keyframes tapeScroll {
        from { transform: translateX(0); }
        to { transform: translateX(-50%); }
      }
      .fl-tape-tick {
        display: inline-flex; align-items: center; gap: 8px;
        flex-shrink: 0;
      }
      .fl-tape-tick .etf {
        font-size: 11px; color: rgba(226, 232, 240, 0.8);
        letter-spacing: 0.02em;
      }
      .fl-tape-tick .pct { font-size: 11px; font-weight: 500; }
      .fl-tape-tick .pct.up { color: #10b981; }
      .fl-tape-tick .pct.dn { color: #dc2626; }

      /* ── Mobile nav ─────────────────────────────── */
      .fl-mobile-nav {
        display: flex; gap: 2px;
        padding: 6px 16px 0;
        position: relative; z-index: 3;
        border-bottom: 1px solid rgba(148, 163, 184, 0.08);
      }
      .fl-mobile-nav button {
        flex: 1; padding: 10px 6px;
        background: transparent; border: 0; cursor: pointer;
        font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: 0.12em; text-transform: uppercase;
        color: rgba(148, 163, 184, 0.5);
        border-bottom: 2px solid transparent;
        transition: all 0.2s ease;
        font-weight: 500;
      }
      .fl-mobile-nav button.active { color: #d4a857; border-bottom-color: #d4a857; }
      @media (min-width: 960px) { .fl-mobile-nav { display: none; } }

      /* ── Stage grid ─────────────────────────────── */
      .fl-stage {
        display: grid;
        grid-template-columns: 1fr;
        position: relative; z-index: 2;
        min-height: calc(100vh - 140px);
      }
      @media (min-width: 960px) {
        .fl-stage { grid-template-columns: 260px minmax(0, 1fr) 320px; }
      }
      .fl-hide { display: none; }
      .fl-show { display: block; }
      @media (min-width: 960px) {
        .fl-hide, .fl-show { display: block; }
      }

      /* ── Tier ladder (left column) ──────────────── */
      .fl-ladder {
        padding: 24px 20px;
        border-right: 1px solid rgba(148, 163, 184, 0.08);
      }
      @media (max-width: 959px) {
        .fl-ladder { border-right: 0; border-bottom: 1px solid rgba(148, 163, 184, 0.08); }
      }
      .fl-ladder-head { margin-bottom: 20px; }
      .fl-ladder-head h3 {
        font-family: 'Source Serif 4', serif; font-weight: 500;
        font-size: 15px; color: rgba(226, 232, 240, 0.9);
        margin: 6px 0 0; letter-spacing: -0.005em;
      }

      /* Skyline — building silhouettes */
      .fl-skyline {
        display: flex; align-items: flex-end; gap: 2px;
        height: 70px;
        margin-bottom: 20px;
        padding-bottom: 10px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.1);
      }
      .fl-building {
        flex: 1;
        border: 1px solid;
        border-radius: 1px 1px 0 0;
        position: relative;
        transition: all 0.4s ease;
      }
      .fl-building-top {
        position: absolute; top: -2px; left: 50%;
        transform: translateX(-50%);
        width: 3px; height: 3px;
        border-radius: 50%;
      }
      .fl-b-past { opacity: 0.6; }
      .fl-b-current { opacity: 1; box-shadow: 0 0 12px currentColor; }
      .fl-b-future { opacity: 0.4; }

      /* Tier rows */
      .fl-tiers { display: flex; flex-direction: column; gap: 2px; margin-bottom: 20px; }
      .fl-tier-row {
        display: flex; align-items: center; gap: 12px;
        padding: 8px 0;
        transition: all 0.3s ease;
      }
      .fl-tier-mark {
        width: 8px; height: 8px; border-radius: 1px;
        border: 1px solid;
        flex-shrink: 0;
      }
      .fl-tier-info { flex: 1; }
      .fl-tier-name {
        font-family: 'Source Serif 4', serif;
        font-size: 14px; font-weight: 500;
        color: rgba(226, 232, 240, 0.9);
      }
      .fl-t-future .fl-tier-name { color: rgba(148, 163, 184, 0.35); }
      .fl-t-current .fl-tier-name {
        color: #f5f5f5;
        font-weight: 600;
      }
      .fl-tier-range {
        font-size: 10px;
        color: rgba(148, 163, 184, 0.55);
        margin-top: 1px;
        letter-spacing: 0.02em;
      }
      .fl-t-future .fl-tier-range { color: rgba(148, 163, 184, 0.25); }

      /* Metrics */
      .fl-metric-block {
        margin-top: 20px;
        padding: 12px 14px;
        border-radius: 4px;
        background: rgba(15, 23, 42, 0.5);
        border: 1px solid rgba(148, 163, 184, 0.1);
      }
      .fl-metric-row {
        display: flex; justify-content: space-between; align-items: baseline;
        margin-bottom: 8px;
      }
      .fl-metric-row .k {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase;
        color: rgba(148, 163, 184, 0.6);
      }
      .fl-metric-row .v {
        font-size: 13px; color: #f5f5f5; font-weight: 500;
      }
      .fl-bar {
        height: 2px;
        background: rgba(148, 163, 184, 0.1);
        border-radius: 1px;
        overflow: hidden;
      }
      .fl-bar-fill {
        height: 100%; background: #d4a857;
        transition: width 1s cubic-bezier(0.22, 1, 0.36, 1);
      }

      /* ── Center column ──────────────────────────── */
      .fl-center {
        padding: 28px 20px 40px;
        display: flex; flex-direction: column; align-items: center;
      }
      .fl-orb-hero {
        position: relative;
        width: 300px; height: 300px;
        display: flex; align-items: center; justify-content: center;
      }
      .fl-orb-hero.compact { width: 180px; height: 180px; }
      .fl-orb-hero.compact .fl-orb-svg { width: 140px; height: 140px; }
      .fl-orb-hero.compact .fl-orb-value .big { font-size: 26px; }
      .fl-orb-svg { width: 220px; height: 220px; position: relative; z-index: 1; }
      .fl-orb-halo {
        animation: orbBreathe 4s ease-in-out infinite;
        transform-origin: center;
      }
      @keyframes orbBreathe {
        0%,100% { opacity: 0.85; }
        50% { opacity: 1; }
      }
      .fl-orb-ring {
        animation: orbSpin 80s linear infinite;
        transform-origin: center;
      }
      @keyframes orbSpin { to { transform: rotate(360deg); } }
      .fl-orb-core {
        animation: orbCore 3s ease-in-out infinite;
        transform-origin: center;
      }
      @keyframes orbCore {
        0%,100% { transform: scale(1); }
        50% { transform: scale(1.04); }
      }
      .fl-orb-dot {
        animation: orbDot 2s ease-in-out infinite;
      }
      @keyframes orbDot {
        0%,100% { opacity: 0.7; }
        50% { opacity: 1; }
      }
      .fl-orb-value {
        position: absolute; inset: 0;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        z-index: 3; pointer-events: none;
      }
      .fl-orb-value .big {
        font-size: 34px; font-weight: 500;
        color: #f5f5f5;
        letter-spacing: -0.02em;
      }
      .fl-orb-value .delta { font-size: 12px; margin-top: 6px; }

      /* Tier caption */
      .fl-tier-caption { text-align: center; margin-top: 24px; max-width: 520px; }
      .fl-tier-caption h1 {
        font-family: 'Source Serif 4', serif; font-size: 28px; font-weight: 500;
        margin: 0; letter-spacing: -0.01em;
        color: rgba(226, 232, 240, 0.92);
      }
      .fl-tier-caption h1 em {
        font-style: normal;
        font-weight: 600;
      }
      .fl-tier-caption p {
        font-family: 'Source Serif 4', serif; font-size: 14px;
        color: rgba(148, 163, 184, 0.6);
        margin: 6px 0 0;
        font-style: italic;
      }

      /* ── Signals ────────────────────────────────── */
      .fl-signals { margin-top: 40px; width: 100%; max-width: 700px; }
      .fl-signals-header {
        display: flex; align-items: baseline; justify-content: space-between;
        margin-bottom: 14px; gap: 12px;
      }
      .fl-signals-header h2 {
        font-family: 'Source Serif 4', serif; font-size: 20px;
        font-weight: 600;
        color: rgba(226, 232, 240, 0.92); margin: 0;
        letter-spacing: -0.01em;
      }
      .fl-pull-btn {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: 0.16em; text-transform: uppercase;
        padding: 7px 14px; border-radius: 4px;
        background: rgba(212, 168, 87, 0.08);
        border: 1px solid rgba(212, 168, 87, 0.3);
        color: #d4a857; cursor: pointer;
        display: inline-flex; align-items: center; gap: 6px;
        transition: all 0.2s ease;
        font-weight: 500;
      }
      .fl-pull-btn:hover:not(:disabled) {
        background: rgba(212, 168, 87, 0.15);
      }
      .fl-pull-btn:disabled { opacity: 0.6; cursor: wait; }
      .spinning { animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }

      .fl-signals-loading, .fl-signals-empty {
        text-align: center; padding: 32px 20px;
        color: rgba(148, 163, 184, 0.55);
        font-family: 'Source Serif 4', serif; font-style: italic; font-size: 14px;
      }

      /* Signal tiles — Bloomberg DNA */
      .fl-signals-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 8px;
      }
      .fl-signal-tile {
        padding: 14px;
        border-radius: 4px;
        background: rgba(15, 23, 42, 0.6);
        border: 1px solid rgba(148, 163, 184, 0.12);
        cursor: pointer;
        animation: signalArrive 0.5s cubic-bezier(0.22, 1, 0.36, 1) backwards;
        transition: all 0.2s ease;
        text-align: left;
      }
      @keyframes signalArrive {
        0% { opacity: 0; transform: translateY(6px); }
        100% { opacity: 1; transform: translateY(0); }
      }
      .fl-signal-tile:hover {
        border-color: rgba(212, 168, 87, 0.4);
        background: rgba(15, 23, 42, 0.8);
      }
      .fl-signal-top {
        display: flex; align-items: baseline; justify-content: space-between;
        margin-bottom: 8px;
      }
      .fl-signal-sym {
        font-family: 'Source Serif 4', serif; font-size: 16px; font-weight: 600;
        color: #f5f5f5;
        letter-spacing: -0.01em;
      }
      .fl-signal-px {
        font-size: 12px; color: rgba(226, 232, 240, 0.7);
      }
      .fl-signal-catalyst {
        font-family: 'Source Serif 4', serif; font-size: 12px;
        color: rgba(148, 163, 184, 0.75);
        line-height: 1.45;
        margin-bottom: 10px; min-height: 34px;
      }
      .fl-signal-meta {
        display: flex; justify-content: space-between;
        padding-top: 8px;
        border-top: 1px solid rgba(148, 163, 184, 0.1);
      }
      .fl-signal-meta span {
        font-size: 9px; letter-spacing: 0.1em;
        color: rgba(148, 163, 184, 0.6);
        text-transform: uppercase;
      }
      .fl-signal-conf { color: #10b981 !important; }

      /* ── Right column ───────────────────────────── */
      .fl-right {
        padding: 24px 20px;
        border-left: 1px solid rgba(148, 163, 184, 0.08);
      }
      @media (max-width: 959px) {
        .fl-right { border-left: 0; border-top: 1px solid rgba(148, 163, 184, 0.08); }
      }
      .fl-right-section { margin-bottom: 28px; }
      .fl-right-section h3 {
        font-family: 'Source Serif 4', serif; font-weight: 500; font-size: 15px;
        color: rgba(226, 232, 240, 0.88);
        margin: 6px 0 12px;
        letter-spacing: -0.005em;
      }
      .fl-right-empty {
        font-family: 'Source Serif 4', serif; font-style: italic;
        font-size: 13px; color: rgba(148, 163, 184, 0.45);
        margin: 0; line-height: 1.5;
      }

      /* Position rows */
      .fl-position-row {
        display: block; width: 100%; text-align: left;
        padding: 12px 14px;
        border-radius: 4px;
        background: rgba(15, 23, 42, 0.5);
        border: 1px solid rgba(148, 163, 184, 0.08);
        margin-bottom: 6px; position: relative; overflow: hidden;
        cursor: pointer;
        transition: border-color 0.2s ease;
      }
      .fl-position-row:hover { border-color: rgba(212, 168, 87, 0.25); }
      .fl-position-pulse {
        position: absolute; top: 0; left: 0; right: 0; height: 1px;
        background: var(--pc, #10b981);
        opacity: 0.6;
        animation: positionPulse 3s ease-in-out infinite;
      }
      @keyframes positionPulse {
        0%,100% { opacity: 0.2; }
        50% { opacity: 0.7; }
      }
      .fl-position-row1 {
        display: flex; justify-content: space-between; align-items: baseline;
        margin-bottom: 4px;
      }
      .fl-position-sym {
        font-family: 'Source Serif 4', serif; font-size: 14px; font-weight: 600;
        color: #f5f5f5; letter-spacing: -0.01em;
      }
      .fl-position-pnl { font-size: 13px; font-weight: 500; }
      .fl-position-pnl.up { color: #10b981; }
      .fl-position-pnl.dn { color: #dc2626; }
      .fl-position-row2 {
        display: flex; justify-content: space-between;
        font-size: 10px;
        color: rgba(148, 163, 184, 0.55);
      }

      /* ── Desk note bell ─────────────────────────── */
      .fl-bell-wrap {
        position: relative;
        margin-bottom: 20px;
        animation: bellIn 0.5s cubic-bezier(0.22,1,0.36,1);
      }
      @keyframes bellIn {
        from { opacity: 0; transform: translateY(-6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .fl-bell {
        display: flex; align-items: center; gap: 14px;
        width: 100%; padding: 14px 16px;
        border-radius: 6px;
        background: rgba(212, 168, 87, 0.06);
        border: 1px solid rgba(212, 168, 87, 0.3);
        border-left: 3px solid #d4a857;
        cursor: pointer;
        text-align: left;
        transition: all 0.2s ease;
      }
      .fl-bell:hover {
        background: rgba(212, 168, 87, 0.1);
      }
      .fl-bell-body { flex: 1; min-width: 0; }
      .fl-bell-eyebrow {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase;
        color: #d4a857;
        margin-bottom: 4px;
        font-weight: 500;
      }
      .fl-bell-title {
        font-family: 'Source Serif 4', serif;
        font-size: 14px; font-weight: 500;
        color: #f5f5f5;
        line-height: 1.3;
        margin-bottom: 2px;
      }
      .fl-bell-sub {
        font-family: 'Source Serif 4', serif;
        font-size: 12px; font-style: italic;
        color: rgba(148, 163, 184, 0.65);
        line-height: 1.35;
        overflow: hidden; text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      }
      .fl-bell-arrow {
        color: #d4a857; font-size: 16px;
        flex-shrink: 0;
      }
      .fl-bell-dismiss {
        position: absolute; top: 6px; right: 6px;
        width: 20px; height: 20px; border-radius: 4px;
        background: rgba(10, 14, 23, 0.6);
        border: 1px solid rgba(148, 163, 184, 0.1);
        color: rgba(148, 163, 184, 0.5);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; z-index: 2;
      }
      .fl-bell-dismiss:hover { color: rgba(226, 232, 240, 0.9); }

      /* ── Footer actions ─────────────────────────── */
      .fl-actions {
        position: sticky; bottom: 0; z-index: 5;
        padding: 14px 20px;
        background: rgba(10, 14, 23, 0.85);
        backdrop-filter: blur(12px);
        border-top: 1px solid rgba(148, 163, 184, 0.08);
        display: flex; align-items: center; gap: 10px;
      }
      .fl-actions-spacer { flex: 1; }
      .fl-ghost-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 9px 16px; border-radius: 4px;
        background: transparent;
        border: 1px solid rgba(148, 163, 184, 0.2);
        color: rgba(226, 232, 240, 0.8);
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
        cursor: pointer; transition: all 0.2s ease;
        font-weight: 500;
      }
      .fl-ghost-btn:hover { border-color: rgba(212, 168, 87, 0.4); color: #d4a857; }
      .fl-primary-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 10px 20px; border-radius: 4px;
        background: #d4a857;
        border: 0; color: #0a0e17;
        font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: 0.18em; text-transform: uppercase; font-weight: 600;
        cursor: pointer; transition: all 0.2s ease;
      }
      .fl-primary-btn:hover:not(:disabled) {
        filter: brightness(1.1);
      }
      .fl-primary-btn:disabled { opacity: 0.4; cursor: not-allowed; }

      /* ── Order ticket (sheet) ───────────────────── */
      .fl-ticket-overlay {
        position: fixed; inset: 0; z-index: 40;
        background: rgba(5, 8, 14, 0.78);
        backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
        animation: fadeIn 0.25s ease;
      }
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      .fl-ticket {
        width: 100%; max-width: 460px;
        background: #0f1420;
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 6px;
        box-shadow: 0 30px 80px rgba(0,0,0,0.7);
        overflow: hidden;
        animation: ticketRise 0.35s cubic-bezier(0.22, 1, 0.36, 1);
      }
      @keyframes ticketRise { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      .fl-ticket-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 20px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.1);
        background: rgba(15, 23, 42, 0.5);
      }
      .fl-ticket-time {
        font-size: 10px; color: rgba(148, 163, 184, 0.5);
        margin-top: 2px; letter-spacing: 0.05em;
      }
      .fl-close-btn {
        width: 26px; height: 26px; border-radius: 4px;
        background: transparent; border: 1px solid rgba(148, 163, 184, 0.15);
        color: rgba(148, 163, 184, 0.7);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
      }
      .fl-close-btn:hover { color: #d4a857; border-color: rgba(212, 168, 87, 0.4); }
      .fl-ticket-body { padding: 20px; }
      .fl-ticket-title {
        font-family: 'Source Serif 4', serif; font-size: 22px;
        font-weight: 500; margin: 0 0 8px;
        color: #f5f5f5; letter-spacing: -0.01em;
      }
      .fl-ticket-sub {
        font-family: 'Source Serif 4', serif; font-size: 13px;
        color: rgba(148, 163, 184, 0.7);
        margin: 0 0 16px; line-height: 1.5;
        font-style: italic;
      }
      .fl-field { margin-bottom: 14px; }
      .fl-field label {
        display: block;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
        color: rgba(148, 163, 184, 0.6);
        margin-bottom: 6px;
        font-weight: 500;
      }
      .fl-field input, .fl-field textarea {
        width: 100%; padding: 11px 13px;
        background: rgba(15, 23, 42, 0.6);
        border: 1px solid rgba(148, 163, 184, 0.15);
        border-radius: 4px;
        color: #f5f5f5;
        font-family: 'IBM Plex Mono', monospace; font-size: 14px;
        outline: 0; transition: border-color 0.2s ease;
      }
      .fl-field textarea {
        font-family: 'Source Serif 4', serif; font-size: 13px; resize: vertical; min-height: 56px;
      }
      .fl-field input.fl-ticker-input {
        text-transform: uppercase; letter-spacing: 0.06em;
      }
      .fl-field input:focus, .fl-field textarea:focus {
        border-color: rgba(212, 168, 87, 0.5);
      }
      .fl-field input:disabled { opacity: 0.6; }
      .fl-field-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
      .fl-field-row { display: flex; gap: 8px; }
      .fl-field-row input { flex: 1; }
      .fl-inline-btn {
        padding: 0 14px; border-radius: 4px;
        background: rgba(212, 168, 87, 0.08);
        border: 1px solid rgba(212, 168, 87, 0.3);
        color: #d4a857;
        font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: 0.1em; text-transform: uppercase;
        cursor: pointer; white-space: nowrap; font-weight: 500;
      }
      .fl-inline-btn:disabled { opacity: 0.4; cursor: not-allowed; }

      .fl-math-preview {
        padding: 12px 14px; border-radius: 4px;
        background: rgba(15, 23, 42, 0.5);
        border: 1px solid rgba(148, 163, 184, 0.1);
        margin-bottom: 14px;
      }
      .fl-math-row {
        display: flex; justify-content: space-between;
        font-family: 'IBM Plex Mono', monospace; font-size: 12px;
        color: rgba(226, 232, 240, 0.7);
        padding: 3px 0;
      }
      .fl-math-row.strong {
        margin-top: 6px; padding-top: 8px;
        border-top: 1px solid rgba(148, 163, 184, 0.1);
        font-weight: 500; color: #f5f5f5; font-size: 14px;
      }
      .fl-math-warning {
        margin-top: 8px; padding: 6px 10px; border-radius: 4px;
        background: rgba(220, 38, 38, 0.08);
        border: 1px solid rgba(220, 38, 38, 0.25);
        color: #dc2626;
        font-family: 'Source Serif 4', serif; font-style: italic; font-size: 12px;
      }

      .fl-pnl-preview {
        padding: 18px; border-radius: 4px; text-align: center;
        margin-bottom: 14px;
        border-left: 3px solid;
      }
      .fl-pnl-preview.win {
        background: rgba(16, 185, 129, 0.06);
        border: 1px solid rgba(16, 185, 129, 0.25);
        border-left-color: #10b981;
      }
      .fl-pnl-preview.loss {
        background: rgba(220, 38, 38, 0.06);
        border: 1px solid rgba(220, 38, 38, 0.2);
        border-left-color: #dc2626;
      }
      .fl-pnl-label {
        font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase;
        color: rgba(148, 163, 184, 0.7);
        margin-bottom: 8px;
      }
      .fl-pnl-big { font-size: 28px; font-weight: 500; letter-spacing: -0.01em; }
      .fl-pnl-preview.win .fl-pnl-big { color: #10b981; }
      .fl-pnl-preview.loss .fl-pnl-big { color: #dc2626; }
      .fl-pnl-sub { font-size: 11px; margin-top: 6px; opacity: 0.8; }

      .fl-ticket-footer {
        display: flex; gap: 10px; justify-content: flex-end;
        padding: 14px 20px;
        border-top: 1px solid rgba(148, 163, 184, 0.1);
        background: rgba(15, 23, 42, 0.3);
      }

      /* ── Trade confirmation (first win) ─────────── */
      .fl-confirm-overlay {
        position: fixed; inset: 0; z-index: 50;
        background: rgba(5, 8, 14, 0.85);
        backdrop-filter: blur(10px);
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
        animation: fadeIn 0.4s ease;
      }
      .fl-confirm-card {
        width: 100%; max-width: 400px;
        background: #0f1420;
        border: 1px solid rgba(212, 168, 87, 0.3);
        border-radius: 4px;
        overflow: hidden;
        animation: confirmRise 0.6s cubic-bezier(0.22, 1, 0.36, 1);
        position: relative;
      }
      .fl-confirm-card::before {
        content: '';
        position: absolute; top: 0; left: 0; right: 0;
        height: 3px;
        background: linear-gradient(90deg, transparent, #d4a857, transparent);
      }
      @keyframes confirmRise { from { opacity: 0; transform: translateY(20px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
      .fl-confirm-header {
        display: flex; justify-content: space-between;
        padding: 14px 20px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.1);
        background: rgba(15, 23, 42, 0.5);
      }
      .fl-confirm-eyebrow {
        font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase;
        color: #d4a857;
        font-weight: 500;
      }
      .fl-confirm-time {
        font-size: 10px; color: rgba(148, 163, 184, 0.6);
      }
      .fl-confirm-body {
        padding: 32px 28px 28px;
        text-align: center;
      }
      .fl-confirm-body h1 {
        font-family: 'Source Serif 4', serif; font-size: 28px;
        font-weight: 500; margin: 0 0 14px;
        color: #f5f5f5; letter-spacing: -0.01em;
      }
      .fl-confirm-amount {
        font-family: 'IBM Plex Mono', monospace; font-size: 28px;
        font-weight: 500; color: #10b981;
        margin: 0 0 18px;
        letter-spacing: -0.01em;
      }
      .fl-confirm-body p {
        font-family: 'Source Serif 4', serif; font-size: 14px;
        font-style: italic;
        color: rgba(148, 163, 184, 0.75);
        margin: 0 auto 24px; line-height: 1.55;
      }
      .fl-confirm-body button {
        padding: 11px 24px; border-radius: 4px;
        background: #d4a857;
        border: 0; color: #0a0e17;
        font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: 0.2em; text-transform: uppercase;
        cursor: pointer; font-weight: 600;
      }
    `}</style>
  )
}


export default function InvestPage() {
  return (
    <Suspense fallback={
      <div className="fl-loading">
        <div className="fl-loading-dots">
          {[0, 1, 2].map(i => <span key={i} style={{ animationDelay: `${i * 0.15}s` }} />)}
        </div>
        <FloorStyles />
      </div>
    }>
      <FloorInner />
    </Suspense>
  )
}
