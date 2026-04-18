'use client'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Plus, X, RefreshCw, Sparkles, Flame } from 'lucide-react'
import InvestLessons from '@/app/components/InvestLessons'
import { Tutorial, TutorialLauncher, INVEST_TUTORIAL } from '@/app/components/Tutorial'

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
}

interface Stage {
  name: string
  emoji: string
  color: string
  min: number
  max: number | null
  tagline: string
  maxPositions: number
  progressPct: number
  toNext: number
  nextStageName: string | null
}

interface StageMeta {
  name: string
  emoji: string
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

interface ForgeData {
  journey: Journey | null
  stage: Stage
  stages: StageMeta[]
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

// ══════════════════════════════════════════════════════════════
// PARTICLE FIELD — rising embers from the bottom of the screen.
// Volatility (derived from abs sum of sector 1D changes) drives speed.
// ══════════════════════════════════════════════════════════════
function EmberField({ intensity = 1 }: { intensity?: number }) {
  const count = 36
  return (
    <div className="forge-particles" aria-hidden>
      {Array.from({ length: count }).map((_, i) => {
        const left = Math.random() * 100
        const dur = 8 + Math.random() * 14 / Math.max(0.5, intensity)
        const delay = Math.random() * 22
        const drift = Math.random() * 60 - 30
        const opacity = 0.3 + Math.random() * 0.5
        return (
          <span
            key={i}
            className="forge-particle"
            style={{
              left: `${left}%`,
              animationDuration: `${dur}s`,
              animationDelay: `${delay}s`,
              ['--drift' as string]: `${drift}px`,
              opacity,
            }}
          />
        )
      })}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// FLAME SVG — procedurally flickering, color-shifts by stage
// ══════════════════════════════════════════════════════════════
function FlameGraphic({ color }: { color: string }) {
  return (
    <svg className="flame-svg" viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <defs>
        <radialGradient id="flameGrad" cx="50%" cy="80%" r="60%">
          <stop offset="0%" stopColor="#fff4d6" stopOpacity="0.95" />
          <stop offset="30%" stopColor="#fbbf24" stopOpacity="0.7" />
          <stop offset="65%" stopColor={color} stopOpacity="0.5" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </radialGradient>
        <radialGradient id="flameCore" cx="50%" cy="75%" r="40%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g className="flame-core">
        <path
          d="M110 200 C 60 180, 50 130, 80 90 C 90 110, 100 105, 95 80 C 115 95, 130 110, 130 140 C 140 125, 150 130, 150 150 C 160 140, 165 155, 160 170 C 155 185, 140 200, 110 200 Z"
          fill="url(#flameGrad)"
        />
        <path
          d="M110 180 C 85 170, 80 140, 100 115 C 105 130, 115 128, 112 108 C 125 120, 135 135, 135 155 C 140 150, 145 158, 142 170 C 138 180, 128 188, 110 188 Z"
          fill="url(#flameCore)"
        />
      </g>
    </svg>
  )
}

// ══════════════════════════════════════════════════════════════
// START SCREEN — first-time balance entry
// ══════════════════════════════════════════════════════════════
function StartScreen({ onStart }: { onStart: (balance: number) => Promise<void> }) {
  const [amount, setAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const num = parseFloat(amount)
  const valid = !isNaN(num) && num > 0
  const presets = [5, 10, 25, 50, 100, 250]

  return (
    <div className="forge-root forge-start">
      <EmberField intensity={0.6} />
      <div className="forge-start-inner">
        <div className="forge-logo" style={{ marginBottom: 24 }}>wali · forge</div>
        <h1 className="forge-start-title">Light the first ember.</h1>
        <p className="forge-start-sub">
          Every journey starts with what you have. Enter your first balance — even $1 is enough to begin.
        </p>

        <div className="forge-start-presets">
          {presets.map(p => (
            <button
              key={p}
              className={`preset-chip ${num === p ? 'active' : ''}`}
              onClick={() => setAmount(String(p))}
            >
              ${p}
            </button>
          ))}
        </div>

        <div className="forge-start-input-row">
          <span className="forge-dollar">$</span>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.00"
            min="1"
            step="0.01"
            inputMode="decimal"
            autoFocus
          />
        </div>

        <button
          className="forge-primary-btn forge-start-btn"
          disabled={!valid || submitting}
          onClick={async () => {
            if (!valid) return
            setSubmitting(true)
            try { await onStart(num) } finally { setSubmitting(false) }
          }}
        >
          {submitting ? 'Lighting…' : 'Begin the journey →'}
        </button>

        <p className="forge-start-fineprint">
          You can change this later. The balance is your starting point — from there, trades you log
          grow or shrink it.
        </p>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// LOG-TRADE SHEET — the walkthrough we specced
// ══════════════════════════════════════════════════════════════
function LogTradeSheet({
  prefill,
  cashRemaining,
  onClose,
  onSave,
}: {
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

  // Pull live price when ticker is entered manually (not from a spark)
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
    <div className="forge-sheet-overlay" onClick={onClose}>
      <div className="forge-sheet" onClick={e => e.stopPropagation()}>
        <div className="forge-sheet-header">
          <span className="eyebrow">log a trade</span>
          <button className="forge-close-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="forge-sheet-body">
          <h2 className="forge-sheet-title">
            {prefill?.ticker ? (
              <>Taking the <em>{prefill.ticker}</em> spark</>
            ) : (
              <>What did you buy?</>
            )}
          </h2>

          {prefill?.rationale && (
            <p className="forge-sheet-sub">{prefill.rationale}</p>
          )}

          {/* Ticker (editable only when no prefill) */}
          <div className="forge-field">
            <label>Ticker</label>
            <div className="forge-field-row">
              <input
                type="text"
                value={ticker}
                onChange={e => setTicker(e.target.value.toUpperCase())}
                onBlur={() => { if (!prefill && ticker) lookupPrice() }}
                placeholder="e.g. PLTR"
                maxLength={6}
                disabled={!!prefill?.ticker}
                className="ticker-input"
              />
              {!prefill?.ticker && (
                <button className="inline-btn" onClick={lookupPrice} disabled={!ticker || fetchingPrice}>
                  {fetchingPrice ? '…' : 'Fetch price'}
                </button>
              )}
            </div>
          </div>

          <div className="forge-field-pair">
            <div className="forge-field">
              <label>Shares</label>
              <input
                type="number"
                value={shares}
                onChange={e => setShares(e.target.value)}
                placeholder="0"
                min="0"
                step="1"
                inputMode="numeric"
              />
            </div>
            <div className="forge-field">
              <label>Entry price</label>
              <input
                type="number"
                value={price}
                onChange={e => setPrice(e.target.value)}
                placeholder="0.00"
                min="0"
                step="0.01"
                inputMode="decimal"
              />
            </div>
          </div>

          {/* Live math preview */}
          <div className="forge-math-preview">
            <div className="forge-math-row">
              <span>Position size</span>
              <span className="mono">{fmt$(cost)}</span>
            </div>
            <div className="forge-math-row">
              <span>Cash remaining</span>
              <span className="mono">{fmt$(cashRemaining)}</span>
            </div>
            <div className="forge-math-row strong">
              <span>After this trade</span>
              <span className="mono" style={{ color: overBudget ? '#f87171' : '#34d399' }}>
                {fmt$(cashAfter)}
              </span>
            </div>
            {overBudget && (
              <div className="forge-math-warning">
                Over budget by {fmt$(Math.abs(cashAfter))}. Reduce shares or lower entry.
              </div>
            )}
          </div>

          <div className="forge-field">
            <label>Notes <span style={{ opacity: 0.5 }}>(optional)</span></label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Why this trade? Catalyst, setup, plan…"
              rows={2}
            />
          </div>
        </div>

        <div className="forge-sheet-footer">
          <button className="forge-ghost-btn" onClick={onClose}>Cancel</button>
          <button
            className="forge-primary-btn"
            disabled={!valid || overBudget || saving}
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
            }}
          >
            {saving ? 'Logging…' : 'Log this trade →'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// CLOSE-TRADE SHEET
// ══════════════════════════════════════════════════════════════
function CloseTradeSheet({
  trade,
  onClose,
  onSave,
}: {
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
    <div className="forge-sheet-overlay" onClick={onClose}>
      <div className="forge-sheet" onClick={e => e.stopPropagation()}>
        <div className="forge-sheet-header">
          <span className="eyebrow">close · {trade.ticker}</span>
          <button className="forge-close-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="forge-sheet-body">
          <h2 className="forge-sheet-title">Lock it in or learn from it.</h2>
          <p className="forge-sheet-sub">
            You bought <span className="mono">{trade.shares}</span> shares at <span className="mono">{fmt$(trade.entry_price)}</span>.
            What was your exit?
          </p>
          <div className="forge-field">
            <label>Exit price</label>
            <input
              type="number"
              value={exitPrice}
              onChange={e => setExitPrice(e.target.value)}
              placeholder="0.00"
              min="0"
              step="0.01"
              autoFocus
              inputMode="decimal"
            />
          </div>
          {valid && (
            <div className={`forge-pnl-preview ${isWin ? 'win' : 'loss'}`}>
              <div className="forge-pnl-big mono">
                {pnl >= 0 ? '+' : ''}{fmt$(pnl)}
              </div>
              <div className="forge-pnl-sub mono">
                {fmtPct(pnlPct)} · {isWin ? 'locked-in win' : 'learning experience'}
              </div>
            </div>
          )}
        </div>
        <div className="forge-sheet-footer">
          <button className="forge-ghost-btn" onClick={onClose}>Cancel</button>
          <button
            className="forge-primary-btn"
            disabled={!valid || saving}
            onClick={async () => {
              if (!valid) return
              setSaving(true)
              try { await onSave(exitNum) } finally { setSaving(false) }
            }}
            style={isWin ? { background: 'linear-gradient(135deg,#34d399,#059669)' } : undefined}
          >
            {saving ? 'Closing…' : isWin ? 'Lock in the win 🔥' : 'Close trade'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// FIRST-WIN CEREMONY
// ══════════════════════════════════════════════════════════════
function FirstWinMoment({ amount, onDismiss }: { amount: number; onDismiss: () => void }) {
  return (
    <div className="first-win-overlay">
      <div className="first-win-card">
        <div className="eyebrow" style={{ color: '#fbbf24', marginBottom: 14 }}>moment · captured</div>
        <h1>First win.</h1>
        <div className="first-win-amount mono">+ {fmt$(amount)}</div>
        <p>This is how it starts. Every journey begins with a single locked-in win.</p>
        <button onClick={onDismiss}>Keep going →</button>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════
function ForgeInner() {
  const router = useRouter()

  // Data
  const [data, setData] = useState<ForgeData | null>(null)
  const [loading, setLoading] = useState(true)
  const [introAccepted, setIntroAccepted] = useState<boolean | null>(null)

  // Ideas (sparks)
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [loadingIdeas, setLoadingIdeas] = useState(false)
  const [stokedAt, setStokedAt] = useState<Date | null>(null)

  // UI state
  const [logSheetOpen, setLogSheetOpen] = useState(false)
  const [logPrefill, setLogPrefill] = useState<Partial<Idea> | undefined>(undefined)
  const [closeTarget, setCloseTarget] = useState<Trade | null>(null)
  const [firstWinAmount, setFirstWinAmount] = useState<number | null>(null)
  const [showTutorial, setShowTutorial] = useState(false)
  const [mobileView, setMobileView] = useState<'flame' | 'sparks' | 'trades' | 'embers'>('flame')

  const didCheckIntro = useRef(false)

  // Check intro acceptance once
  useEffect(() => {
    if (didCheckIntro.current) return
    didCheckIntro.current = true
    fetch('/api/invest/intro')
      .then(r => r.json())
      .then(d => setIntroAccepted(!!d.accepted))
      .catch(() => setIntroAccepted(true)) // fail-open so user isn't stranded
  }, [])

  // Load forge data
  const loadData = useCallback(async () => {
    try {
      const res = await fetch('/api/invest/forge')
      if (!res.ok) { setLoading(false); return }
      const d: ForgeData = await res.json()
      setData(d)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // Refresh data every 5 min during market hours
  useEffect(() => {
    const interval = setInterval(() => {
      if (isMarketOpen()) loadData()
    }, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [loadData])

  // Auto-fetch sparks once data arrives and journey exists and no sparks yet
  useEffect(() => {
    if (data?.journey && ideas.length === 0 && !loadingIdeas && !stokedAt) {
      stokeFlame()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.journey])

  const stokeFlame = async () => {
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
      setStokedAt(new Date())
    } catch { /* ignore */ }
    setLoadingIdeas(false)
  }

  const openLogFromSpark = (idea: Idea) => {
    setLogPrefill(idea)
    setLogSheetOpen(true)
  }

  const openLogBlank = () => {
    setLogPrefill(undefined)
    setLogSheetOpen(true)
  }

  const saveLogTrade = async (payload: { ticker: string; shares: number; entry_price: number; council_signal?: string; confidence?: number; notes?: string }) => {
    await fetch('/api/invest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'open_trade', ...payload }),
    })
    setLogSheetOpen(false)
    setLogPrefill(undefined)
    await loadData()
  }

  const saveCloseTrade = async (exitPrice: number) => {
    if (!closeTarget) return
    const res = await fetch('/api/invest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'set_balance', balance }),
    })
    await loadData()
  }

  // ── Render states ─────────────────────────────────────────
  if (loading || introAccepted === null) {
    return (
      <div className="forge-loading">
        <EmberField intensity={0.4} />
        <div className="forge-loading-dots">
          {[0, 1, 2].map(i => <span key={i} style={{ animationDelay: `${i * 0.15}s` }} />)}
        </div>
        <ForgeStyles />
      </div>
    )
  }

  if (introAccepted === false) {
    router.replace('/invest/intro')
    return null
  }

  if (!data?.journey) {
    return (
      <>
        <StartScreen onStart={setStartBalance} />
        <ForgeStyles />
      </>
    )
  }

  const { stage, stages, value, openTrades, stats, sectorWinds } = data
  const stageIdx = stages.findIndex(s => s.name === stage.name)

  // Intensity for particles: higher on volatile days
  const volatility = Math.min(2, sectorWinds.reduce((s, w) => s + Math.abs(w.change1D ?? 0), 0) / 10 || 1)

  return (
    <div className="forge-root">
      {/* Ambient atmosphere */}
      <div className="forge-sky" />
      <EmberField intensity={volatility} />

      {/* Modals / overlays */}
      {showTutorial && (
        <Tutorial
          config={INVEST_TUTORIAL}
          autoStart
          onComplete={() => setShowTutorial(false)}
          onSkip={() => setShowTutorial(false)}
        />
      )}
      {firstWinAmount != null && (
        <FirstWinMoment amount={firstWinAmount} onDismiss={() => setFirstWinAmount(null)} />
      )}
      {logSheetOpen && (
        <LogTradeSheet
          prefill={logPrefill}
          cashRemaining={value.cashRemaining}
          onClose={() => { setLogSheetOpen(false); setLogPrefill(undefined) }}
          onSave={saveLogTrade}
        />
      )}
      {closeTarget && (
        <CloseTradeSheet
          trade={closeTarget}
          onClose={() => setCloseTarget(null)}
          onSave={saveCloseTrade}
        />
      )}

      {/* Topbar */}
      <header className="forge-topbar">
        <button className="forge-backbtn" onClick={() => router.push('/')} aria-label="Back">
          <ArrowLeft size={14} />
        </button>
        <span className="forge-logo">wali · forge</span>
        <span className="eyebrow forge-eyebrow-inline">invest journey</span>
        <div className="forge-topbar-spacer" />
        <div className="forge-pulse" title={isMarketOpen() ? 'Market open' : 'Market closed'}>
          <span className="dot" />
          <span className="label">{isMarketOpen() ? 'live' : 'closed'}</span>
        </div>
        <TutorialLauncher tutorialId="invest" label="How it works" />
      </header>

      {/* Mobile-only tab switcher */}
      <nav className="forge-mobile-nav">
        {(['flame', 'sparks', 'trades', 'embers'] as const).map(v => (
          <button
            key={v}
            className={mobileView === v ? 'active' : ''}
            onClick={() => setMobileView(v)}
          >
            {v === 'flame' ? 'flame' : v === 'sparks' ? `sparks${ideas.length ? ` · ${ideas.length}` : ''}` : v === 'trades' ? `open · ${openTrades.length}` : 'embers'}
          </button>
        ))}
      </nav>

      {/* Main three-column grid */}
      <div className="forge-stage">

        {/* LEFT — stage ladder */}
        <aside className={`forge-ladder ${mobileView === 'flame' ? 'mv-show' : 'mv-hide'}`}>
          <div className="forge-ladder-title">
            <div className="eyebrow">the path</div>
            <h3>Six stages from spark to free</h3>
          </div>
          <div className="stage-rail" />
          {stages.map((s, i) => {
            const status = i < stageIdx ? 'past' : i === stageIdx ? 'current' : 'future'
            const rangeText = s.max == null ? `$${s.min.toLocaleString()}+` : `$${s.min} — $${s.max}`
            return (
              <div key={s.name} className={`stage-row ${status}`}>
                <div className="node" style={status !== 'future' ? { boxShadow: `0 0 14px ${s.color}AA` } : undefined} />
                <div className="info">
                  <div className="name">{s.name}</div>
                  <div className="range mono">{rangeText}</div>
                </div>
              </div>
            )
          })}

          {/* Tethers — progress + streak */}
          <div className="tether">
            <div className="tether-row">
              <span className="k">to {stage.nextStageName ?? 'apex'}</span>
              <span className="v mono">{stage.nextStageName ? fmt$(stage.toNext) : '—'}</span>
            </div>
            <div className="bar">
              <div className="fill" style={{ width: `${stage.progressPct}%` }} />
            </div>
            <div className="tether-row" style={{ marginTop: 10, marginBottom: 0 }}>
              <span className="k">streak</span>
              <span className="v mono">{stats.winStreak} · 🔥</span>
            </div>
          </div>

          <div className="tether">
            <div className="tether-row"><span className="k">win rate</span><span className="v mono">{stats.winRate}%</span></div>
            <div className="tether-row"><span className="k">best streak</span><span className="v mono">{stats.bestStreak}</span></div>
            <div className="tether-row" style={{ marginBottom: 0 }}>
              <span className="k">locked in</span>
              <span className="v mono" style={{ color: value.realized >= 0 ? '#34d399' : '#f87171' }}>
                {value.realized >= 0 ? '+' : ''}{fmt$(value.realized)}
              </span>
            </div>
          </div>
        </aside>

        {/* CENTER — flame hero + sector winds + sparks */}
        <main className={`forge-center ${mobileView === 'flame' || mobileView === 'sparks' ? 'mv-show' : 'mv-hide'}`}>

          {(mobileView === 'flame' || mobileView === 'sparks') && (
            <div className={`flame-hero ${mobileView === 'sparks' ? 'compact' : ''}`}>
              <div className="flame-ring" />
              <div className="flame-ring r2" />
              <div className="flame-ring r3" />
              <FlameGraphic color={stage.color} />
              <div className="flame-value">
                <div className="eyebrow">portfolio</div>
                <div className="big mono">{fmt$(value.total)}</div>
                <div className="delta mono" style={{ color: value.openPnL >= 0 ? '#34d399' : '#f87171' }}>
                  {value.openPnL >= 0 ? '+' : ''}{fmt$(value.openPnL)} · open
                </div>
              </div>
            </div>
          )}

          {mobileView === 'flame' && (
            <div className="stage-caption">
              <h1>
                You are at <em>{stage.name}</em>
              </h1>
              <p>{stage.tagline}</p>
            </div>
          )}

          {/* Sector winds ribbon */}
          {sectorWinds.length > 0 && (
            <div className="sector-winds">
              <div className="winds-label eyebrow">sector winds · today</div>
              <div className="sector-scroll">
                {sectorWinds.map(w => (
                  <div
                    key={w.etf}
                    className={`sector-chip ${w.change1D >= 0.5 ? 'bull' : w.change1D <= -0.5 ? 'bear' : 'neutral'}`}
                  >
                    <span className="bar" />
                    <span className="nm mono">{w.etf}</span>
                    <span className="pct mono">{fmtPct(w.change1D)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Constellation of sparks */}
          <div className="constellation">
            <div className="constellation-header">
              <h2>Tonight's sparks</h2>
              <button className="stoke-btn" onClick={stokeFlame} disabled={loadingIdeas}>
                <RefreshCw size={11} className={loadingIdeas ? 'spinning' : ''} />
                {loadingIdeas ? 'stoking…' : 'stoke the flame'}
              </button>
            </div>

            {loadingIdeas && ideas.length === 0 ? (
              <div className="sparks-loading">
                <Sparkles size={22} style={{ color: '#fbbf24' }} />
                <p>The council is reading the market…</p>
              </div>
            ) : ideas.length === 0 ? (
              <div className="sparks-empty">
                <p>No sparks yet. Stoke the flame to see tonight's picks.</p>
              </div>
            ) : (
              <div className="picks-grid">
                {ideas.map((idea, i) => {
                  const price = idea.livePrice ?? idea.price
                  return (
                    <div
                      key={`${idea.ticker}-${i}`}
                      className="pick-spark"
                      onClick={() => openLogFromSpark(idea)}
                      style={{ animationDelay: `${i * 0.08}s` }}
                    >
                      <div className="tk">
                        <span className="sym">{idea.ticker}</span>
                        <span className="px mono">{fmt$(price)}</span>
                      </div>
                      {idea.catalyst && (
                        <div className="why">{idea.catalyst}</div>
                      )}
                      <div className="meta">
                        <span className="mono">{idea.suggestedShares} sh</span>
                        <span className="sig mono">
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

        {/* RIGHT — open trades + embers (lessons) */}
        <aside className={`forge-right ${mobileView === 'trades' || mobileView === 'embers' ? 'mv-show' : 'mv-hide'}`}>

          {(mobileView === 'flame' || mobileView === 'trades') && (
            <div className="right-section">
              <div className="eyebrow">open · in play</div>
              <h3>{openTrades.length === 0 ? 'No positions yet' : openTrades.length === 1 ? 'One position' : `${openTrades.length} positions`}</h3>

              {openTrades.length === 0 ? (
                <p className="right-empty">Tap a spark in the center to open your first trade.</p>
              ) : (
                openTrades.map(t => {
                  const isUp = (t.pnl ?? 0) >= 0
                  return (
                    <button
                      key={t.id}
                      className="trade-card"
                      style={{ ['--tc' as string]: isUp ? '#34d399' : '#f87171' }}
                      onClick={() => setCloseTarget(t)}
                    >
                      <div className="heartbeat" />
                      <div className="row1">
                        <span className="sym">{t.ticker}</span>
                        <span className={`pnl mono ${isUp ? 'up' : 'dn'}`}>
                          {t.pnlPct != null ? fmtPct(t.pnlPct) : '—'}
                        </span>
                      </div>
                      <div className="row2 mono">
                        <span>{t.shares} sh @ {fmt$(t.entry_price)}</span>
                        <span>{t.currentPrice != null ? fmt$(t.currentPrice) : 'live…'}</span>
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          )}

          {(mobileView === 'flame' || mobileView === 'embers') && (
            <div className="right-section">
              <div className="eyebrow">embers · wisdom</div>
              <h3>Lessons along the way</h3>
              <div className="embers-wrap">
                <InvestLessons
                  currentStage={stage.name}
                  totalTrades={stats.totalTrades}
                  closedTrades={stats.closedCount}
                  isDark={true}
                />
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* Footer action bar */}
      <div className="forge-actions">
        <button className="forge-ghost-btn" onClick={openLogBlank}>
          <Plus size={12} /> Log manually
        </button>
        <div className="forge-actions-spacer" />
        <button className="forge-primary-btn" onClick={stokeFlame} disabled={loadingIdeas}>
          <Flame size={12} /> {loadingIdeas ? 'Stoking…' : 'New sparks'}
        </button>
      </div>

      <ForgeStyles />
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// STYLES — single injected stylesheet. Kept as a component so
// it lives with the page and ships together.
// ══════════════════════════════════════════════════════════════
function ForgeStyles() {
  return (
    <style jsx global>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500&family=JetBrains+Mono:wght@300;400;500&display=swap');

      .forge-root, .forge-loading, .forge-start {
        font-family: 'Fraunces', Georgia, serif;
        color: rgba(255, 240, 220, 0.92);
        background: radial-gradient(ellipse at 50% 110%, #1a0b05 0%, #0a0503 45%, #050201 100%);
        min-height: 100vh;
        position: relative;
        overflow-x: hidden;
      }
      .forge-root * { box-sizing: border-box; }
      .forge-root .mono { font-family: 'JetBrains Mono', monospace; font-weight: 400; }
      .forge-root .eyebrow {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.26em;
        text-transform: uppercase;
        color: rgba(255, 180, 100, 0.55);
      }

      /* ── Atmosphere ────────────────────────────── */
      .forge-sky {
        position: fixed; inset: 0; pointer-events: none; z-index: 0;
        background:
          radial-gradient(ellipse 800px 400px at 50% 100%, rgba(249,115,22,0.18) 0%, transparent 60%),
          radial-gradient(ellipse 400px 200px at 50% 100%, rgba(251,191,36,0.15) 0%, transparent 70%);
      }
      .forge-particles {
        position: fixed; inset: 0; pointer-events: none; z-index: 1;
      }
      .forge-particle {
        position: absolute; bottom: -10px;
        width: 2px; height: 2px; border-radius: 50%;
        background: rgba(255, 200, 130, 0.9);
        box-shadow: 0 0 4px rgba(255, 180, 100, 0.8);
        animation: forge-rise linear infinite;
      }
      @keyframes forge-rise {
        0% { transform: translateY(0) translateX(0); opacity: 0; }
        10% { opacity: 1; }
        90% { opacity: 1; }
        100% { transform: translateY(-90vh) translateX(var(--drift, 20px)); opacity: 0; }
      }

      /* ── Loading ───────────────────────────────── */
      .forge-loading {
        display: flex; align-items: center; justify-content: center;
      }
      .forge-loading-dots { display: flex; gap: 6px; z-index: 2; }
      .forge-loading-dots span {
        width: 8px; height: 8px; border-radius: 50%;
        background: #f97316;
        animation: dotBounce 1s ease-in-out infinite;
      }
      @keyframes dotBounce { 0%,100%{transform:translateY(0);opacity:0.4;} 50%{transform:translateY(-8px);opacity:1;} }

      /* ── Start screen ──────────────────────────── */
      .forge-start { display: flex; align-items: center; justify-content: center; padding: 40px 20px; }
      .forge-start-inner {
        max-width: 440px; width: 100%;
        text-align: center; position: relative; z-index: 2;
      }
      .forge-start-title {
        font-family: 'Fraunces', serif;
        font-size: 36px; font-weight: 400; font-style: italic;
        margin: 0 0 12px; line-height: 1.15;
        background: linear-gradient(180deg, #fff4d6, #f97316);
        -webkit-background-clip: text; background-clip: text; color: transparent;
      }
      .forge-start-sub {
        font-size: 15px; line-height: 1.5;
        color: rgba(255, 220, 180, 0.6);
        margin: 0 0 32px;
      }
      .forge-start-presets { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-bottom: 20px; }
      .preset-chip {
        padding: 8px 14px; border-radius: 999px;
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(249,115,22,0.2);
        color: rgba(255,220,180,0.75);
        font-family: 'JetBrains Mono', monospace; font-size: 12px;
        cursor: pointer; transition: all 0.2s ease;
      }
      .preset-chip:hover { border-color: rgba(249,115,22,0.5); color: #fbbf24; }
      .preset-chip.active { background: rgba(249,115,22,0.15); border-color: #f97316; color: #fbbf24; }
      .forge-start-input-row {
        display: flex; align-items: center; gap: 8px;
        margin: 0 auto 20px; max-width: 220px;
        padding: 14px 16px; border-radius: 14px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(249,115,22,0.25);
      }
      .forge-dollar { font-family: 'JetBrains Mono', monospace; color: rgba(255,220,180,0.5); font-size: 22px; }
      .forge-start-input-row input {
        flex: 1; width: 100%; min-width: 0;
        background: transparent; border: 0; outline: 0;
        color: rgba(255,244,214,0.98);
        font-family: 'JetBrains Mono', monospace;
        font-size: 22px; font-weight: 500;
      }
      .forge-start-btn { width: 100%; max-width: 300px; margin: 0 auto 20px; display: block; }
      .forge-start-fineprint { font-size: 12px; color: rgba(255,220,180,0.4); font-style: italic; line-height: 1.5; }

      /* ── Topbar ────────────────────────────────── */
      .forge-topbar {
        position: sticky; top: 0; z-index: 10;
        display: flex; align-items: center; gap: 14px;
        padding: 14px 24px;
        background: rgba(10, 5, 3, 0.72);
        backdrop-filter: blur(12px);
        border-bottom: 1px solid rgba(249,115,22,0.12);
      }
      .forge-backbtn {
        width: 28px; height: 28px; border-radius: 8px;
        background: transparent; border: 1px solid rgba(255,220,180,0.15);
        display: flex; align-items: center; justify-content: center;
        color: rgba(255,220,180,0.7); cursor: pointer;
      }
      .forge-backbtn:hover { border-color: rgba(249,115,22,0.4); color: #fbbf24; }
      .forge-logo {
        font-family: 'Fraunces', serif; font-weight: 500; font-size: 18px;
        letter-spacing: -0.01em; font-style: italic;
        color: rgba(255, 230, 200, 0.95);
      }
      .forge-eyebrow-inline { display: none; }
      @media (min-width: 720px) { .forge-eyebrow-inline { display: inline; } }
      .forge-topbar-spacer { flex: 1; }
      .forge-pulse {
        display: flex; align-items: center; gap: 6px;
        padding: 5px 10px; border-radius: 999px;
        background: rgba(52, 211, 153, 0.08);
        border: 1px solid rgba(52, 211, 153, 0.2);
      }
      .forge-pulse .dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #34d399;
        animation: breathe 2s ease-in-out infinite;
      }
      @keyframes breathe {
        0%,100% { opacity: 0.4; transform: scale(0.9); }
        50% { opacity: 1; transform: scale(1.2); box-shadow: 0 0 8px rgba(52,211,153,0.8); }
      }
      .forge-pulse .label {
        font-family: 'JetBrains Mono', monospace; font-size: 9px;
        letter-spacing: 0.15em; color: rgba(52, 211, 153, 0.9); text-transform: uppercase;
      }

      /* ── Mobile tab bar ────────────────────────── */
      .forge-mobile-nav {
        display: flex;
        gap: 2px;
        padding: 8px 16px 0;
        position: relative;
        z-index: 3;
        border-bottom: 1px solid rgba(249,115,22,0.08);
      }
      .forge-mobile-nav button {
        flex: 1;
        padding: 10px 6px;
        background: transparent; border: 0; cursor: pointer;
        font-family: 'JetBrains Mono', monospace; font-size: 10px;
        letter-spacing: 0.12em; text-transform: uppercase;
        color: rgba(255,180,100,0.5);
        border-bottom: 2px solid transparent;
        transition: all 0.2s ease;
      }
      .forge-mobile-nav button.active { color: #fbbf24; border-bottom-color: #f97316; }
      @media (min-width: 960px) { .forge-mobile-nav { display: none; } }

      /* ── Main stage grid ───────────────────────── */
      .forge-stage {
        display: grid;
        grid-template-columns: 1fr;
        position: relative; z-index: 2;
        min-height: calc(100vh - 120px);
      }
      @media (min-width: 960px) {
        .forge-stage {
          grid-template-columns: 240px minmax(0, 1fr) 300px;
        }
      }

      .mv-hide { display: none; }
      .mv-show { display: block; }
      @media (min-width: 960px) {
        .mv-hide, .mv-show { display: block; }
      }

      /* ── LEFT: Ladder ──────────────────────────── */
      .forge-ladder {
        padding: 24px 20px;
        border-right: 1px solid rgba(249,115,22,0.1);
        position: relative;
      }
      @media (max-width: 959px) {
        .forge-ladder { border-right: 0; border-bottom: 1px solid rgba(249,115,22,0.1); }
      }
      .forge-ladder-title { margin-bottom: 20px; }
      .forge-ladder-title h3 {
        font-family: 'Fraunces', serif; font-weight: 400; font-style: italic;
        font-size: 15px; color: rgba(255, 220, 180, 0.7); margin: 6px 0 0;
      }
      .stage-rail {
        position: absolute; left: 30px; top: 90px; bottom: 250px;
        width: 1px;
        background: linear-gradient(to bottom, rgba(249,115,22,0.3), rgba(249,115,22,0.05));
      }
      .stage-row {
        display: flex; align-items: center; gap: 12px;
        padding: 8px 0; position: relative;
        transition: all 0.4s ease;
      }
      .stage-row .node {
        width: 16px; height: 16px; border-radius: 50%;
        border: 1.5px solid rgba(249,115,22,0.25);
        background: #0a0503; flex-shrink: 0; transition: all 0.4s ease;
      }
      .stage-row.past .node {
        background: radial-gradient(circle, #fbbf24 0%, #f97316 70%);
        border-color: #fbbf24;
      }
      .stage-row.current .node {
        background: radial-gradient(circle, #fff4d6 0%, #fbbf24 40%, #f97316 100%);
        border-color: #fff4d6;
        animation: nodeBreathe 2.4s ease-in-out infinite;
      }
      @keyframes nodeBreathe {
        0%,100% { box-shadow: 0 0 16px rgba(251,191,36,0.9), 0 0 32px rgba(249,115,22,0.4); }
        50% { box-shadow: 0 0 22px rgba(251,191,36,1), 0 0 48px rgba(249,115,22,0.6); }
      }
      .stage-row .info .name {
        font-family: 'Fraunces', serif; font-size: 15px; font-weight: 500;
        color: rgba(255, 220, 180, 0.85);
      }
      .stage-row.future .info .name { color: rgba(255, 220, 180, 0.28); }
      .stage-row.current .info .name { color: #fff4d6; font-style: italic; }
      .stage-row .info .range {
        font-size: 10px; color: rgba(255, 180, 100, 0.5); margin-top: 2px;
      }
      .stage-row.future .info .range { color: rgba(255, 180, 100, 0.18); }

      /* Tethers */
      .tether {
        margin-top: 20px;
        padding: 12px 14px;
        border-radius: 10px;
        background: linear-gradient(180deg, rgba(249,115,22,0.08), rgba(249,115,22,0.02));
        border: 1px solid rgba(249,115,22,0.15);
      }
      .tether-row {
        display: flex; justify-content: space-between; align-items: baseline;
        margin-bottom: 8px;
      }
      .tether-row .k {
        font-family: 'JetBrains Mono', monospace; font-size: 9px;
        letter-spacing: 0.2em; text-transform: uppercase;
        color: rgba(255, 180, 100, 0.6);
      }
      .tether-row .v { font-size: 13px; color: rgba(255, 230, 200, 0.95); font-weight: 500; }
      .tether .bar {
        height: 3px; background: rgba(249,115,22,0.1); border-radius: 2px;
        overflow: hidden; position: relative;
      }
      .tether .bar .fill {
        height: 100%;
        background: linear-gradient(90deg, #fbbf24, #f97316, #ef4444);
        border-radius: 2px;
        transition: width 1.2s cubic-bezier(0.22, 1, 0.36, 1);
        position: relative;
      }
      .tether .bar .fill::after {
        content: ''; position: absolute; top: 0; right: 0; width: 8px; height: 100%;
        background: rgba(255, 255, 255, 0.6);
        filter: blur(4px);
        animation: barShimmer 2s ease-in-out infinite;
      }
      @keyframes barShimmer { 0%,100%{opacity:0.4;} 50%{opacity:1;} }

      /* ── CENTER: Flame + sparks ────────────────── */
      .forge-center {
        padding: 28px 20px 40px;
        display: flex; flex-direction: column; align-items: center;
      }
      .flame-hero {
        position: relative;
        width: 300px; height: 300px;
        display: flex; align-items: center; justify-content: center;
        margin-top: 8px;
      }
      .flame-hero.compact { width: 180px; height: 180px; margin-top: 0; margin-bottom: 8px; }
      .flame-hero.compact .flame-svg { width: 140px; height: 140px; }
      .flame-hero.compact .flame-value .big { font-size: 26px; }
      .flame-ring {
        position: absolute; inset: 0; border-radius: 50%;
        border: 1px dashed rgba(249,115,22,0.2);
        animation: slowSpin 40s linear infinite;
      }
      .flame-ring.r2 { inset: 24px; animation-duration: 60s; animation-direction: reverse; border-color: rgba(251,191,36,0.15); }
      .flame-ring.r3 { inset: 56px; animation-duration: 80s; border-color: rgba(239,68,68,0.1); }
      @keyframes slowSpin { to { transform: rotate(360deg); } }
      .flame-svg {
        position: relative; z-index: 2;
        width: 200px; height: 200px;
      }
      .flame-core {
        animation: flameFlicker 3s ease-in-out infinite;
        transform-origin: 50% 100%;
      }
      @keyframes flameFlicker {
        0%,100% { transform: scale(1, 1); }
        33% { transform: scale(1.02, 0.98); }
        66% { transform: scale(0.98, 1.03); }
      }
      .flame-value {
        position: absolute; inset: 0;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        z-index: 3; pointer-events: none;
      }
      .flame-value .big {
        font-size: 34px; font-weight: 500;
        color: rgba(255, 244, 214, 0.98);
        letter-spacing: -0.02em;
        text-shadow: 0 0 20px rgba(251,191,36,0.4);
      }
      .flame-value .delta { font-size: 12px; margin-top: 6px; }

      .stage-caption { text-align: center; margin-top: 20px; max-width: 520px; }
      .stage-caption h1 {
        font-family: 'Fraunces', serif; font-size: 30px; font-weight: 400;
        margin: 0; letter-spacing: -0.01em;
        color: rgba(255, 230, 200, 0.92);
      }
      .stage-caption h1 em {
        font-style: italic;
        background: linear-gradient(180deg, #fff4d6 0%, #f97316 100%);
        -webkit-background-clip: text; background-clip: text; color: transparent;
        padding-right: 2px;
      }
      .stage-caption p {
        font-family: 'Fraunces', serif; font-size: 14px;
        color: rgba(255, 220, 180, 0.55);
        margin: 4px 0 0; font-style: italic;
      }

      /* Sector winds */
      .sector-winds { margin-top: 28px; width: 100%; max-width: 560px; }
      .winds-label { text-align: center; margin-bottom: 10px; }
      .sector-scroll {
        display: flex; gap: 8px; overflow-x: auto; padding: 4px 2px;
        scrollbar-width: none;
      }
      .sector-scroll::-webkit-scrollbar { display: none; }
      .sector-chip {
        flex-shrink: 0; padding: 6px 12px; border-radius: 999px;
        background: rgba(255, 255, 255, 0.02);
        border: 1px solid rgba(249,115,22,0.15);
        display: flex; align-items: center; gap: 6px;
        transition: all 0.3s ease;
      }
      .sector-chip .bar {
        width: 3px; height: 12px; border-radius: 2px;
        background: rgba(255,255,255,0.2);
      }
      .sector-chip.bull .bar { background: #34d399; box-shadow: 0 0 6px #34d399; }
      .sector-chip.bear .bar { background: #f87171; box-shadow: 0 0 6px #f87171; }
      .sector-chip .nm { font-size: 10px; color: rgba(255,220,180,0.85); }
      .sector-chip .pct { font-size: 10px; }
      .sector-chip.bull .pct { color: #34d399; }
      .sector-chip.bear .pct { color: #f87171; }
      .sector-chip.neutral .pct { color: rgba(255,220,180,0.5); }

      /* Constellation */
      .constellation { margin-top: 32px; width: 100%; max-width: 620px; }
      .constellation-header {
        display: flex; align-items: baseline; justify-content: space-between;
        margin-bottom: 14px; gap: 12px;
      }
      .constellation-header h2 {
        font-family: 'Fraunces', serif; font-size: 22px;
        font-style: italic; font-weight: 400;
        color: rgba(255, 230, 200, 0.92); margin: 0;
      }
      .stoke-btn {
        font-family: 'JetBrains Mono', monospace; font-size: 10px;
        letter-spacing: 0.18em; text-transform: uppercase;
        padding: 7px 14px; border-radius: 999px;
        background: rgba(249,115,22,0.1);
        border: 1px solid rgba(249,115,22,0.3);
        color: #fbbf24; cursor: pointer;
        display: inline-flex; align-items: center; gap: 6px;
        transition: all 0.3s ease;
      }
      .stoke-btn:hover:not(:disabled) {
        background: rgba(249,115,22,0.2);
        box-shadow: 0 0 16px rgba(249,115,22,0.3);
      }
      .stoke-btn:disabled { opacity: 0.6; cursor: wait; }
      .stoke-btn .spinning { animation: spin 1s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }

      .sparks-loading, .sparks-empty {
        text-align: center; padding: 32px 20px;
        color: rgba(255,220,180,0.5);
        font-family: 'Fraunces', serif; font-style: italic; font-size: 14px;
      }

      .picks-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
      }
      .pick-spark {
        padding: 14px; border-radius: 10px;
        background: linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0.01));
        border: 1px solid rgba(249,115,22,0.15);
        cursor: pointer; position: relative; overflow: hidden;
        animation: sparkArrive 0.8s cubic-bezier(0.22, 1, 0.36, 1) backwards;
        transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
        text-align: left;
      }
      @keyframes sparkArrive {
        0% { opacity: 0; transform: translateY(12px) scale(0.92); }
        100% { opacity: 1; transform: translateY(0) scale(1); }
      }
      .pick-spark:hover {
        border-color: rgba(249,115,22,0.5);
        transform: translateY(-2px);
        box-shadow: 0 8px 24px rgba(249,115,22,0.15);
      }
      .pick-spark::before {
        content: ''; position: absolute; top: -1px; left: 50%;
        width: 40px; height: 2px;
        background: linear-gradient(90deg, transparent, #fbbf24, transparent);
        transform: translateX(-50%);
        opacity: 0; transition: opacity 0.3s ease;
      }
      .pick-spark:hover::before { opacity: 1; }
      .pick-spark .tk {
        display: flex; align-items: baseline; justify-content: space-between;
        margin-bottom: 6px;
      }
      .pick-spark .tk .sym {
        font-family: 'Fraunces', serif; font-size: 17px; font-weight: 500;
        color: rgba(255, 244, 214, 0.98);
        letter-spacing: -0.01em;
      }
      .pick-spark .tk .px { font-size: 12px; color: rgba(255, 220, 180, 0.7); }
      .pick-spark .why {
        font-family: 'Fraunces', serif; font-size: 12px; font-style: italic;
        color: rgba(255, 220, 180, 0.55); line-height: 1.4;
        margin-bottom: 10px; min-height: 34px;
      }
      .pick-spark .meta {
        display: flex; justify-content: space-between;
        padding-top: 8px; border-top: 1px solid rgba(249,115,22,0.1);
      }
      .pick-spark .meta span {
        font-size: 9px; letter-spacing: 0.1em;
        color: rgba(255, 180, 100, 0.6);
        text-transform: uppercase;
      }
      .pick-spark .meta .sig { color: #34d399; }

      /* ── RIGHT: Trades + embers ────────────────── */
      .forge-right {
        padding: 24px 20px;
        border-left: 1px solid rgba(249,115,22,0.1);
      }
      @media (max-width: 959px) {
        .forge-right { border-left: 0; border-top: 1px solid rgba(249,115,22,0.1); }
      }
      .right-section { margin-bottom: 28px; }
      .right-section h3 {
        font-family: 'Fraunces', serif; font-weight: 400; font-size: 16px;
        font-style: italic; color: rgba(255, 230, 200, 0.88);
        margin: 6px 0 12px;
      }
      .right-empty {
        font-family: 'Fraunces', serif; font-style: italic;
        font-size: 13px; color: rgba(255,220,180,0.4);
        margin: 0; line-height: 1.5;
      }

      .trade-card {
        display: block; width: 100%; text-align: left;
        padding: 12px 14px; border-radius: 10px;
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(255,255,255,0.05);
        margin-bottom: 8px; position: relative; overflow: hidden;
        cursor: pointer; transition: border-color 0.2s ease;
      }
      .trade-card:hover { border-color: rgba(249,115,22,0.25); }
      .trade-card .heartbeat {
        position: absolute; top: 0; left: 0; right: 0; height: 1px;
        background: linear-gradient(90deg, transparent, var(--tc, #34d399), transparent);
        animation: heartbeat 3s ease-in-out infinite;
      }
      @keyframes heartbeat {
        0%,100% { opacity: 0.2; transform: scaleX(0.5); }
        50% { opacity: 1; transform: scaleX(1); }
      }
      .trade-card .row1 {
        display: flex; justify-content: space-between; align-items: baseline;
        margin-bottom: 4px;
      }
      .trade-card .sym {
        font-family: 'Fraunces', serif; font-size: 15px; font-weight: 500;
        color: rgba(255,244,214,0.95); letter-spacing: -0.01em;
      }
      .trade-card .pnl { font-size: 13px; font-weight: 500; }
      .trade-card .pnl.up { color: #34d399; }
      .trade-card .pnl.dn { color: #f87171; }
      .trade-card .row2 {
        display: flex; justify-content: space-between; font-size: 10px;
        color: rgba(255,220,180,0.45);
      }

      .embers-wrap {
        /* InvestLessons component brings its own styles; we just give it container */
        margin-top: 4px;
      }

      /* ── Footer action bar ─────────────────────── */
      .forge-actions {
        position: sticky; bottom: 0; z-index: 5;
        padding: 14px 20px;
        background: rgba(10, 5, 3, 0.82);
        backdrop-filter: blur(12px);
        border-top: 1px solid rgba(249,115,22,0.12);
        display: flex; align-items: center; gap: 10px;
      }
      .forge-actions-spacer { flex: 1; }
      .forge-ghost-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 9px 16px; border-radius: 999px;
        background: transparent;
        border: 1px solid rgba(255,220,180,0.15);
        color: rgba(255,220,180,0.75);
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
        cursor: pointer; transition: all 0.3s ease;
      }
      .forge-ghost-btn:hover { border-color: rgba(249,115,22,0.4); color: #fbbf24; }
      .forge-primary-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 10px 20px; border-radius: 999px;
        background: linear-gradient(135deg, #f97316, #ef4444);
        border: 0; color: #fff4d6;
        font-family: 'JetBrains Mono', monospace; font-size: 10px;
        letter-spacing: 0.15em; text-transform: uppercase; font-weight: 500;
        cursor: pointer; transition: all 0.3s ease;
        box-shadow: 0 0 16px rgba(249,115,22,0.25);
      }
      .forge-primary-btn:hover:not(:disabled) {
        box-shadow: 0 0 28px rgba(249,115,22,0.5);
        transform: translateY(-1px);
      }
      .forge-primary-btn:disabled { opacity: 0.5; cursor: not-allowed; }

      /* ── Sheets ────────────────────────────────── */
      .forge-sheet-overlay {
        position: fixed; inset: 0; z-index: 40;
        background: rgba(0, 0, 0, 0.72);
        backdrop-filter: blur(6px);
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
        animation: fadeIn 0.3s ease;
      }
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      .forge-sheet {
        width: 100%; max-width: 440px;
        background: #0f0704;
        border: 1px solid rgba(249,115,22,0.22);
        border-radius: 18px;
        box-shadow: 0 30px 80px rgba(0,0,0,0.7), 0 0 40px rgba(249,115,22,0.1);
        overflow: hidden;
        animation: sheetRise 0.4s cubic-bezier(0.22, 1, 0.36, 1);
      }
      @keyframes sheetRise { from { transform: translateY(30px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      .forge-sheet-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid rgba(249,115,22,0.12);
      }
      .forge-close-btn {
        width: 26px; height: 26px; border-radius: 8px;
        background: transparent; border: 1px solid rgba(255,220,180,0.1);
        color: rgba(255,220,180,0.6);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
      }
      .forge-close-btn:hover { color: #fbbf24; border-color: rgba(249,115,22,0.4); }
      .forge-sheet-body { padding: 20px; }
      .forge-sheet-title {
        font-family: 'Fraunces', serif; font-size: 22px; font-weight: 400;
        font-style: italic; margin: 0 0 8px;
        color: rgba(255,244,214,0.96);
      }
      .forge-sheet-title em {
        background: linear-gradient(180deg, #fff4d6, #f97316);
        -webkit-background-clip: text; background-clip: text; color: transparent;
      }
      .forge-sheet-sub {
        font-family: 'Fraunces', serif; font-size: 13px; font-style: italic;
        color: rgba(255,220,180,0.55); margin: 0 0 16px; line-height: 1.5;
      }
      .forge-field { margin-bottom: 14px; }
      .forge-field label {
        display: block; font-family: 'JetBrains Mono', monospace;
        font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase;
        color: rgba(255,180,100,0.5); margin-bottom: 6px;
      }
      .forge-field input, .forge-field textarea {
        width: 100%; padding: 11px 13px;
        background: rgba(255,255,255,0.025);
        border: 1px solid rgba(249,115,22,0.15);
        border-radius: 10px;
        color: rgba(255,244,214,0.96);
        font-family: 'JetBrains Mono', monospace; font-size: 14px;
        outline: 0; transition: border-color 0.2s ease, box-shadow 0.2s ease;
      }
      .forge-field textarea {
        font-family: 'Fraunces', serif; font-size: 13px; resize: vertical; min-height: 56px;
      }
      .forge-field input.ticker-input {
        text-transform: uppercase; letter-spacing: 0.08em;
      }
      .forge-field input:focus, .forge-field textarea:focus {
        border-color: rgba(249,115,22,0.5);
        box-shadow: 0 0 0 2px rgba(249,115,22,0.12);
      }
      .forge-field input:disabled { opacity: 0.6; }
      .forge-field-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
      .forge-field-row { display: flex; gap: 8px; }
      .forge-field-row input { flex: 1; }
      .inline-btn {
        padding: 0 14px; border-radius: 10px;
        background: rgba(249,115,22,0.1);
        border: 1px solid rgba(249,115,22,0.3);
        color: #fbbf24;
        font-family: 'JetBrains Mono', monospace; font-size: 10px;
        letter-spacing: 0.12em; text-transform: uppercase;
        cursor: pointer;
        white-space: nowrap;
      }
      .inline-btn:disabled { opacity: 0.4; cursor: not-allowed; }

      .forge-math-preview {
        padding: 12px 14px; border-radius: 10px;
        background: rgba(249,115,22,0.05);
        border: 1px solid rgba(249,115,22,0.15);
        margin-bottom: 14px;
      }
      .forge-math-row {
        display: flex; justify-content: space-between;
        font-family: 'JetBrains Mono', monospace; font-size: 12px;
        color: rgba(255,220,180,0.7);
        padding: 3px 0;
      }
      .forge-math-row.strong {
        margin-top: 6px; padding-top: 8px;
        border-top: 1px solid rgba(249,115,22,0.15);
        font-weight: 500; color: rgba(255,244,214,0.95); font-size: 14px;
      }
      .forge-math-warning {
        margin-top: 8px; padding: 6px 10px; border-radius: 8px;
        background: rgba(248,113,113,0.1);
        border: 1px solid rgba(248,113,113,0.3);
        color: #f87171;
        font-family: 'Fraunces', serif; font-style: italic; font-size: 12px;
      }

      .forge-pnl-preview {
        padding: 16px; border-radius: 12px; text-align: center;
        margin-bottom: 14px;
      }
      .forge-pnl-preview.win { background: rgba(52,211,153,0.1); border: 1px solid rgba(52,211,153,0.25); }
      .forge-pnl-preview.loss { background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.2); }
      .forge-pnl-big { font-size: 28px; font-weight: 500; letter-spacing: -0.01em; }
      .forge-pnl-preview.win .forge-pnl-big { color: #34d399; }
      .forge-pnl-preview.loss .forge-pnl-big { color: #f87171; }
      .forge-pnl-sub { font-size: 11px; margin-top: 4px; opacity: 0.8; }

      .forge-sheet-footer {
        display: flex; gap: 10px; justify-content: flex-end;
        padding: 14px 20px;
        border-top: 1px solid rgba(249,115,22,0.1);
        background: rgba(0,0,0,0.2);
      }

      /* ── First-win ceremony ────────────────────── */
      .first-win-overlay {
        position: fixed; inset: 0; z-index: 50;
        background: radial-gradient(circle at 50% 50%, rgba(249,115,22,0.25) 0%, rgba(10,5,3,0.95) 60%);
        backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center;
        animation: fadeIn 0.5s ease;
      }
      .first-win-card {
        text-align: center;
        padding: 48px 40px; max-width: 360px;
        animation: riseIn 0.8s cubic-bezier(0.22, 1, 0.36, 1);
      }
      @keyframes riseIn { from { opacity: 0; transform: translateY(20px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
      .first-win-card h1 {
        font-family: 'Fraunces', serif; font-size: 48px; font-weight: 400;
        font-style: italic; margin: 0; line-height: 1.1;
        background: linear-gradient(180deg, #fff4d6, #f97316);
        -webkit-background-clip: text; background-clip: text; color: transparent;
      }
      .first-win-amount {
        font-family: 'JetBrains Mono', monospace; font-size: 24px;
        color: #34d399; margin: 14px 0 20px; font-weight: 500;
      }
      .first-win-card p {
        font-family: 'Fraunces', serif; font-style: italic;
        font-size: 14px; color: rgba(255,220,180,0.6);
        margin: 0 auto 24px; line-height: 1.5;
      }
      .first-win-card button {
        padding: 12px 28px; border-radius: 999px;
        background: linear-gradient(135deg, #f97316, #ef4444);
        border: 0; color: #fff4d6;
        font-family: 'JetBrains Mono', monospace; font-size: 10px;
        letter-spacing: 0.2em; text-transform: uppercase; cursor: pointer;
        box-shadow: 0 0 24px rgba(249,115,22,0.5);
      }
    `}</style>
  )
}

// ══════════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════════
export default function InvestPage() {
  return (
    <Suspense
      fallback={
        <div className="forge-loading">
          <div className="forge-loading-dots">
            {[0, 1, 2].map(i => <span key={i} style={{ animationDelay: `${i * 0.15}s` }} />)}
          </div>
          <ForgeStyles />
        </div>
      }
    >
      <ForgeInner />
    </Suspense>
  )
}
