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
  // Options fields (nullable for stock trades)
  position_type?: 'stock' | 'option'
  option_type?: 'call' | 'put' | null
  strike?: number | null
  expiry?: string | null
  contracts?: number | null
  entry_premium?: number | null
  exit_premium?: number | null
  underlying?: string | null
  // Commit A additions — stop/target/verdict/rationale
  stop_price?: number | null
  target_price?: number | null
  verdict_id?: string | null
  rationale?: string | null
  stop_hit_at?: string | null
  target_hit_at?: string | null
  plan_outcome?: 'stop_hit' | 'target_hit' | 'closed_early' | 'still_open' | null
  // Enriched client-side
  currentPrice?: number | null
  pnl?: number | null
  pnlPct?: number | null
}

interface Postmortem {
  id?: string
  trade_id: string
  grade: string
  process_score: number
  outcome: 'win' | 'loss' | 'breakeven'
  analysis: {
    whatWorked: string[]
    whatMissed: string[]
    ruleReferences: Array<{ lessonId: string; lessonTitle: string; reason: string }>
    nextTimeTip: string
    honestSummary: string
  }
  tier_at_trade?: string | null
  generated_at?: string
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
  verdictId?: string                    // Links trade back to the underlying verdict_log row
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
  // Option-idea fields (present only for Operator+ option setups)
  positionType?: 'stock' | 'option'
  underlying?: string
  underlyingPrice?: number
  optionType?: 'call' | 'put'
  strike?: number
  expiry?: string
  dte?: number
  estimatedPremium?: number
  delta?: number
  cost?: number
  breakeven?: number
  maxLoss?: number
  // Phase 2 — Tradier enrichment
  iv?: number | null
  optionSymbol?: string | null
  isEstimated?: boolean
  dataSource?: 'claude-estimate' | 'tradier'
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
const getDTE = (expiry: string | null | undefined): number => {
  if (!expiry) return 0
  try {
    const exp = new Date(expiry + 'T21:00:00Z')
    const diff = exp.getTime() - Date.now()
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)))
  } catch { return 0 }
}

const gradeToClass = (grade: string): string => {
  const letter = grade.charAt(0).toLowerCase()
  return `grade-${letter}`
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
  onSave: (data: {
    ticker: string
    shares: number
    entry_price: number
    council_signal?: string
    confidence?: number
    notes?: string
    // Option-trade fields — only supplied when position_type === 'option'
    position_type?: 'stock' | 'option'
    option_type?: 'call' | 'put'
    strike?: number
    expiry?: string
    contracts?: number
    entry_premium?: number
    underlying?: string
    // Commit A additions — stop/target/verdict/rationale
    stop_price?: number
    target_price?: number
    verdict_id?: string
    rationale?: string
  }) => Promise<void>
}) {
  // Detect if this is an option-mode ticket by presence of option fields in prefill.
  // When the user opens a manual blank ticket, we default to stock; they can toggle.
  const isOptionPrefill = prefill?.positionType === 'option'
  const [mode, setMode] = useState<'stock' | 'option'>(isOptionPrefill ? 'option' : 'stock')

  // Stock-mode state
  const [ticker, setTicker] = useState(prefill?.ticker ?? prefill?.underlying ?? '')
  const [shares, setShares] = useState(prefill?.suggestedShares?.toString() ?? '')
  const [price, setPrice] = useState(prefill?.livePrice?.toString() ?? prefill?.price?.toString() ?? '')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [fetchingPrice, setFetchingPrice] = useState(false)

  // Option-mode state
  const [optionType, setOptionType] = useState<'call' | 'put'>(prefill?.optionType ?? 'call')
  const [strike, setStrike] = useState(prefill?.strike?.toString() ?? '')
  const [expiry, setExpiry] = useState(prefill?.expiry ?? '')
  const [contracts, setContracts] = useState(prefill?.suggestedShares?.toString() ?? '1')
  const [premium, setPremium] = useState(prefill?.estimatedPremium?.toString() ?? '')

  // Commit A additions — stop/target/rationale
  // Prefill stop/target from the council idea when available. Options get numeric
  // defaults computed from premium (100% target, 50% stop) when user starts blank.
  const prefillStop = prefill?.stop ? parseFloat(prefill.stop.replace(/[^\d.-]/g, '')) : null
  const prefillTarget = prefill?.target ? parseFloat(prefill.target.replace(/[^\d.-]/g, '')) : null
  const [stopPrice, setStopPrice] = useState(prefillStop ? prefillStop.toString() : '')
  const [targetPrice, setTargetPrice] = useState(prefillTarget ? prefillTarget.toString() : '')
  const [rationale, setRationale] = useState(prefill?.rationale ?? prefill?.catalyst ?? '')

  // Option-specific stop/target on the premium
  const [optionStop, setOptionStop] = useState('')
  const [optionTarget, setOptionTarget] = useState('')

  // Options confirmation step (2-step submit for higher-risk option trades)
  const [confirmingOption, setConfirmingOption] = useState(false)

  const sharesNum = parseFloat(shares) || 0
  const priceNum = parseFloat(price) || 0
  const strikeNum = parseFloat(strike) || 0
  const contractsNum = parseInt(contracts) || 0
  const premiumNum = parseFloat(premium) || 0
  const stopNum = parseFloat(stopPrice) || 0
  const targetNum = parseFloat(targetPrice) || 0
  const optionStopNum = parseFloat(optionStop) || 0
  const optionTargetNum = parseFloat(optionTarget) || 0

  const cost = mode === 'stock'
    ? sharesNum * priceNum
    : contractsNum * premiumNum * 100
  const cashAfter = cashRemaining - cost
  const overBudget = cost > cashRemaining

  // Core trade validity (size + price)
  const baseValid = mode === 'stock'
    ? ticker.length >= 1 && sharesNum > 0 && priceNum > 0
    : ticker.length >= 1 && strikeNum > 0 && expiry.length > 0 && contractsNum > 0 && premiumNum > 0

  // Commit A: require rationale (min 10 chars — a thesis, not "idk")
  const rationaleValid = rationale.trim().length >= 10

  // Commit A: require stop + target. For stock these are share prices; for options they're premium exit levels.
  const stopTargetValid = mode === 'stock'
    ? stopNum > 0 && targetNum > 0 && stopNum !== priceNum && targetNum !== priceNum
    : optionStopNum > 0 && optionTargetNum > 0 && optionStopNum !== premiumNum && optionTargetNum !== premiumNum

  // Sanity check the direction of stop/target vs entry. If user is bullish,
  // stop should be BELOW entry and target ABOVE. For bearish, flipped.
  // If prefill.signal says BEARISH we invert expectation.
  const isBearishPrefill = (prefill?.signal ?? '').toUpperCase().includes('BEAR')
  const stopTargetDirValid = (() => {
    if (!stopTargetValid) return false
    if (mode === 'stock') {
      if (isBearishPrefill) return stopNum > priceNum && targetNum < priceNum
      return stopNum < priceNum && targetNum > priceNum
    } else {
      // Options: target premium is above entry (take profit), stop premium is below (cut loss).
      // Same for calls and puts — the premium moves up when the position is winning.
      return optionTargetNum > premiumNum && optionStopNum < premiumNum
    }
  })()

  const valid = baseValid && rationaleValid && stopTargetValid && stopTargetDirValid

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
            {prefill?.ticker ? (
              mode === 'option'
                ? <>Take the {prefill.ticker} {prefill.optionType?.toUpperCase()} setup</>
                : <>Take the {prefill.ticker} setup</>
            ) : <>New position</>}
          </h2>
          {prefill?.rationale && <p className="fl-ticket-sub">{prefill.rationale}</p>}

          {/* Stock/Option toggle — only shown for blank (manual) tickets */}
          {!prefill?.ticker && (
            <div className="fl-field">
              <label>Position type</label>
              <div className="fl-mode-toggle">
                <button type="button"
                  className={mode === 'stock' ? 'active' : ''}
                  onClick={() => setMode('stock')}>
                  Stock
                </button>
                <button type="button"
                  className={mode === 'option' ? 'active' : ''}
                  onClick={() => setMode('option')}>
                  Option
                </button>
              </div>
            </div>
          )}

          <div className="fl-field">
            <label>{mode === 'option' ? 'Underlying ticker' : 'Ticker'}</label>
            <div className="fl-field-row">
              <input type="text" value={ticker}
                onChange={e => setTicker(e.target.value.toUpperCase())}
                onBlur={() => { if (!prefill && ticker && mode === 'stock') lookupPrice() }}
                placeholder={mode === 'option' ? 'e.g. AAPL' : 'e.g. PLTR'} maxLength={6}
                disabled={!!prefill?.ticker} className="fl-ticker-input" />
              {!prefill?.ticker && mode === 'stock' && (
                <button className="fl-inline-btn" onClick={lookupPrice} disabled={!ticker || fetchingPrice}>
                  {fetchingPrice ? '…' : 'Fetch bid'}
                </button>
              )}
            </div>
          </div>

          {/* STOCK MODE FIELDS */}
          {mode === 'stock' && (
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
          )}

          {/* OPTION MODE FIELDS */}
          {mode === 'option' && (
            <>
              <div className="fl-field">
                <label>Call or put</label>
                <div className="fl-mode-toggle">
                  <button type="button"
                    className={optionType === 'call' ? 'active call' : ''}
                    disabled={!!prefill?.optionType}
                    onClick={() => setOptionType('call')}>
                    CALL
                  </button>
                  <button type="button"
                    className={optionType === 'put' ? 'active put' : ''}
                    disabled={!!prefill?.optionType}
                    onClick={() => setOptionType('put')}>
                    PUT
                  </button>
                </div>
              </div>

              <div className="fl-field-pair">
                <div className="fl-field">
                  <label>Strike</label>
                  <input type="number" value={strike}
                    onChange={e => setStrike(e.target.value)}
                    disabled={!!prefill?.strike}
                    placeholder="0" min="0" step="0.5" inputMode="decimal" />
                </div>
                <div className="fl-field">
                  <label>Expiry</label>
                  <input type="date" value={expiry}
                    onChange={e => setExpiry(e.target.value)}
                    disabled={!!prefill?.expiry} />
                </div>
              </div>

              <div className="fl-field-pair">
                <div className="fl-field">
                  <label>Contracts</label>
                  <input type="number" value={contracts}
                    onChange={e => setContracts(e.target.value)}
                    placeholder="1" min="1" step="1" inputMode="numeric" />
                </div>
                <div className="fl-field">
                  <label>Premium / share</label>
                  <input type="number" value={premium}
                    onChange={e => setPremium(e.target.value)}
                    placeholder="0.00" min="0" step="0.05" inputMode="decimal" />
                </div>
              </div>
            </>
          )}

          <div className="fl-math-preview">
            <div className="fl-math-row">
              <span>{mode === 'option' ? 'Contract cost' : 'Position size'}</span>
              <span className="mono">{fmt$(cost)}</span>
            </div>
            {mode === 'option' && contractsNum > 1 && (
              <div className="fl-math-row sub">
                <span>{contractsNum} contracts × $100 × ${premium || '0.00'}</span>
                <span className="mono">{fmt$(cost)}</span>
              </div>
            )}
            <div className="fl-math-row"><span>Cash available</span><span className="mono">{fmt$(cashRemaining)}</span></div>
            <div className="fl-math-row strong">
              <span>Cash after</span>
              <span className="mono" style={{ color: overBudget ? '#dc2626' : '#10b981' }}>{fmt$(cashAfter)}</span>
            </div>
            {overBudget && (
              <div className="fl-math-warning">Over budget by {fmt$(Math.abs(cashAfter))}. Reduce {mode === 'option' ? 'contracts or premium' : 'shares or entry'}.</div>
            )}
            {mode === 'option' && prefill?.breakeven && (
              <div className="fl-math-row sub">
                <span>Break-even at expiry</span>
                <span className="mono">{fmt$(prefill.breakeven)}</span>
              </div>
            )}
            {mode === 'option' && prefill?.maxLoss && (
              <div className="fl-math-row sub">
                <span>Max loss</span>
                <span className="mono" style={{ color: '#dc2626' }}>{fmt$(-prefill.maxLoss)}</span>
              </div>
            )}
          </div>

          {/* Commit A: Stop-loss and target fields */}
          {mode === 'stock' && (
            <div className="fl-ticket-grid2">
              <div className="fl-field">
                <label>
                  Stop-loss *
                  {prefillStop && <span style={{ opacity: 0.5, fontSize: '10px', marginLeft: 6 }}>council: {fmt$(prefillStop)}</span>}
                </label>
                <input
                  type="number" step="0.01" value={stopPrice}
                  onChange={e => setStopPrice(e.target.value)}
                  placeholder={isBearishPrefill ? `above ${fmt$(priceNum)}` : `below ${fmt$(priceNum)}`}
                />
              </div>
              <div className="fl-field">
                <label>
                  Target *
                  {prefillTarget && <span style={{ opacity: 0.5, fontSize: '10px', marginLeft: 6 }}>council: {fmt$(prefillTarget)}</span>}
                </label>
                <input
                  type="number" step="0.01" value={targetPrice}
                  onChange={e => setTargetPrice(e.target.value)}
                  placeholder={isBearishPrefill ? `below ${fmt$(priceNum)}` : `above ${fmt$(priceNum)}`}
                />
              </div>
            </div>
          )}

          {mode === 'option' && (
            <div className="fl-ticket-grid2">
              <div className="fl-field">
                <label>Stop premium *</label>
                <input
                  type="number" step="0.01" value={optionStop}
                  onChange={e => setOptionStop(e.target.value)}
                  placeholder={`cut below ${fmt$(premiumNum)}`}
                />
              </div>
              <div className="fl-field">
                <label>Target premium *</label>
                <input
                  type="number" step="0.01" value={optionTarget}
                  onChange={e => setOptionTarget(e.target.value)}
                  placeholder={`exit above ${fmt$(premiumNum)}`}
                />
              </div>
            </div>
          )}

          {stopTargetValid && !stopTargetDirValid && (
            <div className="fl-ticket-hint fl-ticket-hint-warn">
              {mode === 'stock'
                ? (isBearishPrefill
                    ? 'For a bearish trade: stop should be ABOVE entry, target BELOW.'
                    : 'For a bullish trade: stop should be BELOW entry, target ABOVE.')
                : 'Target premium must be above entry and stop premium below — the premium rises when your option wins.'}
            </div>
          )}

          <div className="fl-field">
            <label>
              Why this trade? *
              <span style={{ opacity: 0.5, fontSize: '10px', marginLeft: 6 }}>min 10 characters</span>
            </label>
            <textarea
              value={rationale}
              onChange={e => setRationale(e.target.value)}
              placeholder="Your thesis: catalyst, technical setup, or why council signal convinced you…"
              rows={2}
            />
            {rationale.length > 0 && !rationaleValid && (
              <div className="fl-field-hint">Needs at least 10 characters — a real thesis, not "idk"</div>
            )}
          </div>

          <div className="fl-field">
            <label>Extra notes <span style={{ opacity: 0.5 }}>(optional)</span></label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Anything else — risk sizing reasoning, prior similar trades…" rows={2} />
          </div>
        </div>

        <div className="fl-ticket-disclaimer">
          {mode === 'option'
            ? 'This is educational only. Options are high-risk and can expire worthless — never trade more than you can afford to lose. Wali-OS does not guarantee any outcome.'
            : 'This is educational only. Markets can move against you and past performance is not indicative of future results. Wali-OS does not guarantee any outcome.'}
        </div>

        <div className="fl-ticket-footer">
          <button className="fl-ghost-btn" onClick={onClose}>Cancel</button>
          <button className="fl-primary-btn" disabled={!valid || overBudget || saving}
            onClick={async () => {
              if (!valid || overBudget) return
              // Commit A: for options, show 1-step confirmation before writing
              if (mode === 'option' && !confirmingOption) {
                setConfirmingOption(true)
                return
              }
              setSaving(true)
              try {
                if (mode === 'option') {
                  await onSave({
                    ticker: ticker.toUpperCase(),
                    underlying: ticker.toUpperCase(),
                    position_type: 'option',
                    option_type: optionType,
                    strike: strikeNum,
                    expiry,
                    contracts: contractsNum,
                    entry_premium: premiumNum,
                    // For server compatibility: shares derived, entry_price = premium
                    shares: contractsNum * 100,
                    entry_price: premiumNum,
                    council_signal: prefill?.signal,
                    confidence: prefill?.confidence,
                    notes: notes || undefined,
                    // Commit A additions
                    stop_price: optionStopNum,
                    target_price: optionTargetNum,
                    verdict_id: prefill?.verdictId,
                    rationale: rationale.trim(),
                  })
                } else {
                  await onSave({
                    ticker: ticker.toUpperCase(),
                    position_type: 'stock',
                    shares: sharesNum,
                    entry_price: priceNum,
                    council_signal: prefill?.signal,
                    confidence: prefill?.confidence,
                    notes: notes || undefined,
                    // Commit A additions
                    stop_price: stopNum,
                    target_price: targetNum,
                    verdict_id: prefill?.verdictId,
                    rationale: rationale.trim(),
                  })
                }
              } finally { setSaving(false); setConfirmingOption(false) }
            }}>
            {saving
              ? 'Submitting…'
              : mode === 'option' && confirmingOption
                ? `Confirm — max loss ${fmt$(cost)}`
                : 'Submit order →'}
          </button>
        </div>
        {mode === 'option' && confirmingOption && !saving && (
          <div className="fl-ticket-confirm-hint">
            Tap again to confirm. If this option expires worthless, you lose {fmt$(cost)} — the entire contract cost.
          </div>
        )}
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
          <h2 className="fl-ticket-title">
            {trade.position_type === 'option' ? 'Close contract at market.' : 'Close position at market.'}
          </h2>
          <p className="fl-ticket-sub">
            {trade.position_type === 'option' ? (
              <>
                Held: <span className="mono">{trade.contracts ?? 1}</span> {trade.option_type?.toUpperCase()} contract{(trade.contracts ?? 1) > 1 ? 's' : ''} @ <span className="mono">{fmt$(trade.entry_premium ?? trade.entry_price)}</span>/share. What premium did you sell for?
              </>
            ) : (
              <>
                Held: <span className="mono">{trade.shares}</span> shares @ <span className="mono">{fmt$(trade.entry_price)}</span>. What was your fill?
              </>
            )}
          </p>
          <div className="fl-field">
            <label>{trade.position_type === 'option' ? 'Exit premium / share' : 'Exit price'}</label>
            <input type="number" value={exitPrice} onChange={e => setExitPrice(e.target.value)}
              placeholder="0.00" min="0" step="0.01" autoFocus inputMode="decimal" />
          </div>
          {valid && (
            <div className={`fl-pnl-preview ${isWin ? 'win' : 'loss'}`}>
              <div className="fl-pnl-label mono">Realized P&L</div>
              <div className="fl-pnl-big mono">{pnl >= 0 ? '+' : ''}{fmt$(pnl)}</div>
              <div className="fl-pnl-sub mono">
                {fmtPct(pnlPct)}
                {trade.position_type === 'option' ? ' on premium' : ''} · {isWin ? 'profit' : 'loss'}
              </div>
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
  const [rulesOpen, setRulesOpen] = useState(false)

  // Relative building heights: Buyer small, Sovereign tallest
  const heights = [20, 32, 48, 68, 92]

  return (
    <aside className="fl-ladder">
      <div className="fl-ladder-head">
        <div className="fl-eyebrow">capital hierarchy</div>
        <div className="fl-ladder-head-row">
          <h3>Five tiers, one book</h3>
          <button
            className="fl-tier-info-btn"
            onClick={() => setRulesOpen(v => !v)}
            aria-label="How tier progression works"
            title="How tier progression works"
          >
            ?
          </button>
        </div>
      </div>

      {rulesOpen && (
        <div className="fl-tier-rules">
          <div className="fl-tier-rules-head">
            <span>How progression works</span>
            <button className="fl-tier-rules-close" onClick={() => setRulesOpen(false)}>×</button>
          </div>
          <div className="fl-tier-rules-body">
            <p>Tiers unlock based on your <strong>total realized profit</strong> (wins minus losses from closed trades). Nothing is gated by time or subscription — only by compounding.</p>
            <ul>
              {tiers.map((t) => (
                <li key={t.name}>
                  <span className="fl-tier-rules-name" style={{ color: t.color }}>{t.name}</span>
                  <span className="fl-tier-rules-req mono">
                    {t.max == null ? `$${t.min.toLocaleString()}+` : `$${t.min.toLocaleString()} — $${t.max.toLocaleString()}`}
                  </span>
                  <span className="fl-tier-rules-tag">{t.tagline}</span>
                </li>
              ))}
            </ul>
            <p className="fl-tier-rules-foot">
              Options desk unlocks at <strong>Operator</strong>. Realized P/L updates when you close positions.
              Losing trades subtract from your running total, so tier can drop — this is a feature, not a bug.
            </p>
          </div>
        </div>
      )}

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

  // Options ideas (Operator+ only — empty array at lower tiers)
  const [optionIdeas, setOptionIdeas] = useState<Idea[]>([])
  const [optionsBudgetWarning, setOptionsBudgetWarning] = useState<string | null>(null)

  // Post-mortem cache — keyed by trade_id
  const [postmortems, setPostmortems] = useState<Record<string, Postmortem>>({})
  const [expandedPostmortem, setExpandedPostmortem] = useState<string | null>(null)

  // Tracks trades awaiting post-mortem generation. UI polls while this set is non-empty.
  const [pendingPostmortems, setPendingPostmortems] = useState<Set<string>>(new Set())

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

  // Load cached post-mortems for all closed trades when data refreshes.
  useEffect(() => {
    if (!data?.closedTrades || data.closedTrades.length === 0) return
    // Only fetch for trades we don't already have cached locally
    const missing = data.closedTrades
      .filter(t => !postmortems[t.id])
      .slice(0, 10) // cap request count — we show at most ~5 at a time anyway

    if (missing.length === 0) return

    Promise.all(missing.map(async (t) => {
      try {
        const res = await fetch(`/api/invest/analyze-trade?tradeId=${t.id}`)
        const body = await res.json()
        if (body.postmortem) return { id: t.id, pm: body.postmortem as Postmortem }
      } catch { /* ignore */ }
      return null
    })).then(results => {
      const updates: Record<string, Postmortem> = {}
      for (const r of results) if (r) updates[r.id] = r.pm
      if (Object.keys(updates).length > 0) {
        setPostmortems(prev => ({ ...prev, ...updates }))
      }
    })
  }, [data?.closedTrades, postmortems])

  // Poll for pending post-mortems every 3s. Drops them from `pending` once
  // we receive the analysis, so the loop terminates naturally.
  useEffect(() => {
    if (pendingPostmortems.size === 0) return
    const interval = setInterval(async () => {
      const pending = Array.from(pendingPostmortems)
      const results = await Promise.all(pending.map(async (tradeId) => {
        try {
          const res = await fetch(`/api/invest/analyze-trade?tradeId=${tradeId}`)
          const body = await res.json()
          if (body.postmortem) return { tradeId, pm: body.postmortem as Postmortem }
        } catch { /* ignore */ }
        return null
      }))
      const received: Record<string, Postmortem> = {}
      for (const r of results) if (r) received[r.tradeId] = r.pm
      if (Object.keys(received).length > 0) {
        setPostmortems(prev => ({ ...prev, ...received }))
        setPendingPostmortems(prev => {
          const next = new Set(prev)
          for (const id of Object.keys(received)) next.delete(id)
          return next
        })
      }
    }, 3000)
    return () => clearInterval(interval)
  }, [pendingPostmortems])

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
      setOptionIdeas(body.options ?? [])
      setOptionsBudgetWarning(body.optionsBudgetWarning ?? null)
      setPulledAt(new Date())
    } catch { /* ignore */ }
    setLoadingIdeas(false)
  }

  const openTicketFromSignal = (idea: Idea) => { setTicketPrefill(idea); setTicketOpen(true) }
  const openTicketBlank = () => { setTicketPrefill(undefined); setTicketOpen(true) }

  const submitOrder = async (payload: {
    ticker: string
    shares: number
    entry_price: number
    council_signal?: string
    confidence?: number
    notes?: string
    position_type?: 'stock' | 'option'
    option_type?: 'call' | 'put'
    strike?: number
    expiry?: string
    contracts?: number
    entry_premium?: number
    underlying?: string
    // Commit A additions
    stop_price?: number
    target_price?: number
    verdict_id?: string
    rationale?: string
  }) => {
    await fetch('/api/invest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'open_trade', ...payload }),
    })
    setTicketOpen(false); setTicketPrefill(undefined)
    await loadData()
  }

  const closePosition = async (exitValue: number) => {
    if (!closeTarget) return
    const isOption = closeTarget.position_type === 'option'
    const closedTradeId = closeTarget.id
    const res = await fetch('/api/invest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'close_trade',
        id: closedTradeId,
        // Server reads exit_premium for options, exit_price for stocks
        ...(isOption ? { exit_premium: exitValue } : { exit_price: exitValue }),
      }),
    })
    const body = await res.json()
    const pnl = (exitValue - closeTarget.entry_price) * closeTarget.shares
    const isFirstWin = body.isWin && !data?.stats.firstWinAt
    setCloseTarget(null)
    await loadData()
    if (isFirstWin) setFirstWinAmount(pnl)

    // Mark this trade as awaiting post-mortem. Polling effect below picks it up.
    if (body.postmortemPending || body.ok) {
      setPendingPostmortems(prev => new Set(prev).add(closedTradeId))
    }
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
            ) : ideas.length === 0 && optionIdeas.length === 0 ? (
              <div className="fl-signals-empty">
                <p>No setups queued. Pull new signals to see today's screen.</p>
              </div>
            ) : (
              <>
                <div className="fl-signals-grid">
                  {ideas.map((idea, i) => {
                    const price = idea.livePrice ?? idea.price
                    return (
                      <div key={`stock-${idea.ticker}-${i}`} className="fl-signal-tile"
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
                        {idea.verdictId && (
                          <button
                            className="fl-signal-attribution"
                            onClick={(e) => {
                              e.stopPropagation()
                              router.push(`/?ticker=${idea.ticker}&verdict=${idea.verdictId}`)
                            }}
                          >
                            view full debate →
                          </button>
                        )}
                        <div className="fl-signal-disclaimer">
                          Educational setup · not a guarantee of profit
                        </div>
                      </div>
                    )
                  })}
                </div>

                {tier.name !== 'Buyer' && tier.name !== 'Builder' && optionIdeas.length > 0 && (
                  <div className="fl-options-section">
                    <div className="fl-options-header">
                      <span className="fl-eyebrow">options desk &middot; operator unlock</span>
                      <h3>Leveraged setups</h3>
                    </div>
                    {optionsBudgetWarning && (
                      <div className="fl-options-warning">
                        {optionsBudgetWarning}
                      </div>
                    )}
                    <div className="fl-options-grid">
                      {optionIdeas.map((opt, i) => {
                        const dte = opt.dte ?? getDTE(opt.expiry)
                        const isCall = opt.optionType === 'call'
                        const maxLoss = opt.maxLoss ?? opt.cost ?? ((opt.estimatedPremium ?? 0) * 100)
                        const delta = typeof opt.delta === 'number' ? opt.delta : null
                        const breakeven = opt.breakeven ?? null
                        const underlyingPx = opt.underlyingPrice ?? opt.price
                        // Breakeven move needed as % of underlying
                        const breakevenMovePct = (breakeven && underlyingPx)
                          ? ((breakeven - underlyingPx) / underlyingPx) * 100
                          : null
                        return (
                          <div key={`opt-${opt.underlying}-${opt.strike}-${i}`}
                            className={`fl-option-tile ${isCall ? 'call' : 'put'}`}
                            onClick={() => openTicketFromSignal(opt)}
                            style={{ animationDelay: `${i * 0.08}s` }}>
                            <div className="fl-signal-top">
                              <span className="fl-signal-sym">
                                {opt.underlying ?? opt.ticker}
                                <span className={`fl-option-badge ${isCall ? 'call' : 'put'}`}>
                                  {isCall ? 'CALL' : 'PUT'}
                                </span>
                              </span>
                              <span className="fl-signal-px mono">
                                {fmt$(opt.estimatedPremium ?? 0)}/sh
                                <span className={`fl-option-est-label ${opt.dataSource === 'tradier' ? 'is-live' : ''}`}>
                                  {opt.dataSource === 'tradier' ? 'live' : 'est'}
                                </span>
                              </span>
                            </div>
                            <div className="fl-option-strike-row mono">
                              <span>${opt.strike} strike</span>
                              <span>&middot;</span>
                              <span className={dte <= 7 ? 'fl-option-dte-urgent' : ''}>{dte}d</span>
                            </div>
                            {opt.catalyst && <div className="fl-signal-catalyst">{opt.catalyst}</div>}

                            {/* Commit B: risk surfacing block */}
                            <div className="fl-option-risks">
                              <div className="fl-option-risk-row">
                                <span className="fl-option-risk-k">Max loss</span>
                                <span className="fl-option-risk-v mono fl-option-risk-danger">
                                  {fmt$(-maxLoss)}
                                </span>
                              </div>
                              {delta !== null && (
                                <div className="fl-option-risk-row">
                                  <span className="fl-option-risk-k">Delta</span>
                                  <span className="fl-option-risk-v mono">
                                    {delta >= 0 ? '+' : ''}{delta.toFixed(2)}
                                  </span>
                                </div>
                              )}
                              {typeof opt.iv === 'number' && opt.iv > 0 && (
                                <div className="fl-option-risk-row">
                                  <span className="fl-option-risk-k">IV</span>
                                  <span className="fl-option-risk-v mono">
                                    {(opt.iv * 100).toFixed(0)}%
                                  </span>
                                </div>
                              )}
                              {breakeven !== null && (
                                <div className="fl-option-risk-row">
                                  <span className="fl-option-risk-k">Breakeven</span>
                                  <span className="fl-option-risk-v mono">
                                    {fmt$(breakeven)}
                                    {breakevenMovePct !== null && (
                                      <span className="fl-option-risk-sub">
                                        &nbsp;({breakevenMovePct >= 0 ? '+' : ''}{breakevenMovePct.toFixed(1)}%)
                                      </span>
                                    )}
                                  </span>
                                </div>
                              )}
                            </div>

                            <div className="fl-signal-meta">
                              <span className="mono">{fmt$(opt.cost ?? ((opt.estimatedPremium ?? 0) * 100))} / contract</span>
                              <span className="fl-signal-conf mono">
                                {opt.confidence ?? 0}%
                              </span>
                            </div>
                            {opt.verdictId && (
                              <button
                                className="fl-signal-attribution"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  router.push(`/?ticker=${opt.underlying ?? opt.ticker}&verdict=${opt.verdictId}`)
                                }}
                              >
                                view full debate →
                              </button>
                            )}
                            <div className="fl-signal-disclaimer fl-signal-disclaimer-option">
                              Educational · options can expire worthless · no guarantees
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Commit C: options empty state at Operator+ when none returned */}
                {tier.name !== 'Buyer' && tier.name !== 'Builder' && optionIdeas.length === 0 && ideas.length > 0 && pulledAt && (
                  <div className="fl-options-section">
                    <div className="fl-options-header">
                      <span className="fl-eyebrow">options desk &middot; operator unlock</span>
                      <h3>Leveraged setups</h3>
                    </div>
                    <div className="fl-empty-state fl-empty-state-options">
                      <p>No leveraged setups fit your budget this scan.</p>
                      <p className="fl-empty-state-sub">
                        The council only flags options when a high-conviction stock idea also has an option contract that fits within ~40% of your per-position budget.
                        Try pulling again later, or grow your account to see more leveraged opportunities.
                      </p>
                    </div>
                  </div>
                )}
              </>
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
                  const isOption = t.position_type === 'option'
                  const dte = isOption ? getDTE(t.expiry) : null
                  const dteUrgent = dte !== null && dte <= 7
                  const isCall = t.option_type === 'call'
                  return (
                    <button key={t.id} className="fl-position-row"
                      style={{ ['--pc' as string]: isUp ? '#10b981' : '#dc2626' }}
                      onClick={() => setCloseTarget(t)}>
                      <div className="fl-position-pulse" />
                      <div className="fl-position-row1">
                        <span className="fl-position-sym">
                          {t.underlying ?? t.ticker}
                          {isOption && (
                            <span className={`fl-position-option-badge ${isCall ? 'call' : 'put'}`}>
                              {isCall ? 'C' : 'P'}${t.strike}
                            </span>
                          )}
                        </span>
                        <span className={`fl-position-pnl mono ${isUp ? 'up' : 'dn'}`}>
                          {t.pnlPct != null ? fmtPct(t.pnlPct) : '—'}
                        </span>
                      </div>
                      <div className="fl-position-row2 mono">
                        {isOption ? (
                          <>
                            <span>{t.contracts ?? 1}× @ {fmt$(t.entry_premium ?? t.entry_price)}</span>
                            <span className={`fl-dte-pill ${dteUrgent ? 'urgent' : ''}`}>
                              {dte}d
                            </span>
                          </>
                        ) : (
                          <>
                            <span>{t.shares} sh @ {fmt$(t.entry_price)}</span>
                            <span>{t.currentPrice != null ? fmt$(t.currentPrice) : 'live…'}</span>
                          </>
                        )}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          )}

          {(mobileView === 'portfolio' || mobileView === 'positions') && data.closedTrades.length === 0 && data.openTrades.length > 0 && (
            <div className="fl-right-section">
              <div className="fl-eyebrow">closed &middot; reviewed</div>
              <h3>Recent reviews</h3>
              <div className="fl-empty-state fl-empty-state-compact">
                <p>No closed trades yet.</p>
                <p className="fl-empty-state-sub">Close a position to see your first review with a grade and process score.</p>
              </div>
            </div>
          )}

          {(mobileView === 'portfolio' || mobileView === 'positions') && data.closedTrades.length > 0 && (
            <div className="fl-right-section">
              <div className="fl-eyebrow">closed &middot; reviewed</div>
              <h3>Recent reviews</h3>
              {data.closedTrades.slice(0, 5).map(t => {
                const pm = postmortems[t.id]
                const pending = pendingPostmortems.has(t.id)
                const isUp = t.exit_price != null && t.exit_price > t.entry_price
                const pnlDollar = t.exit_price != null ? (t.exit_price - t.entry_price) * t.shares : 0
                const pnlPct = t.exit_price != null ? ((t.exit_price - t.entry_price) / t.entry_price) * 100 : 0
                const isOption = t.position_type === 'option'
                const expanded = expandedPostmortem === t.id

                return (
                  <div key={`closed-${t.id}`} className={`fl-postmortem-card ${expanded ? 'expanded' : ''}`}>
                    <button
                      className="fl-postmortem-head"
                      onClick={() => setExpandedPostmortem(expanded ? null : t.id)}>
                      <div className="fl-postmortem-top">
                        <span className="fl-position-sym">
                          {t.underlying ?? t.ticker}
                          {isOption && (
                            <span className={`fl-position-option-badge ${t.option_type === 'call' ? 'call' : 'put'}`}>
                              {t.option_type === 'call' ? 'C' : 'P'}${t.strike}
                            </span>
                          )}
                        </span>
                        {pm ? (
                          <span className={`fl-grade-badge ${gradeToClass(pm.grade)}`}>
                            {pm.grade}
                          </span>
                        ) : pending ? (
                          <span className="fl-grade-badge pending">reviewing…</span>
                        ) : (
                          <span className="fl-grade-badge pending">—</span>
                        )}
                      </div>
                      <div className="fl-postmortem-meta mono">
                        <span className={isUp ? 'up' : 'dn'}>
                          {pnlDollar >= 0 ? '+' : ''}{fmt$(pnlDollar)}
                        </span>
                        <span className={isUp ? 'up' : 'dn'}>
                          {fmtPct(pnlPct)}
                        </span>
                        {pm && (
                          <span className="fl-postmortem-score">
                            process {pm.process_score}/100
                          </span>
                        )}
                      </div>
                    </button>

                    {expanded && pm && (
                      <div className="fl-postmortem-body">
                        {/* Commit C: Council context block — shown when trade had verdict/rationale/stop/target metadata */}
                        {(t.rationale || t.council_signal || t.stop_price || t.target_price || t.plan_outcome) && (
                          <div className="fl-postmortem-context">
                            <div className="fl-postmortem-context-header">Council context</div>
                            {t.council_signal && (
                              <div className="fl-postmortem-context-row">
                                <span className="k">Council called</span>
                                <span className="v mono">
                                  <span className={t.council_signal.toLowerCase().includes('bull') ? 'up' : t.council_signal.toLowerCase().includes('bear') ? 'dn' : ''}>
                                    {t.council_signal}
                                  </span>
                                  {t.confidence != null && <span className="fl-postmortem-context-sub"> · {t.confidence}%</span>}
                                </span>
                              </div>
                            )}
                            {t.rationale && (
                              <div className="fl-postmortem-context-row fl-postmortem-context-row-stacked">
                                <span className="k">Your thesis at entry</span>
                                <span className="v fl-postmortem-rationale">&ldquo;{t.rationale}&rdquo;</span>
                              </div>
                            )}
                            {(t.stop_price || t.target_price) && (
                              <div className="fl-postmortem-context-row">
                                <span className="k">Plan</span>
                                <span className="v mono">
                                  {t.stop_price ? `stop ${fmt$(t.stop_price)}` : '—'}
                                  {' / '}
                                  {t.target_price ? `target ${fmt$(t.target_price)}` : '—'}
                                </span>
                              </div>
                            )}
                            {t.plan_outcome && t.plan_outcome !== 'still_open' && (
                              <div className="fl-postmortem-context-row">
                                <span className="k">Plan outcome</span>
                                <span className={`v mono fl-plan-outcome fl-plan-${t.plan_outcome}`}>
                                  {t.plan_outcome === 'target_hit' ? '✓ target reached'
                                    : t.plan_outcome === 'stop_hit' ? '✗ stop hit'
                                    : '~ closed early (neither stop nor target)'}
                                </span>
                              </div>
                            )}
                          </div>
                        )}

                        {pm.analysis.honestSummary && (
                          <p className="fl-postmortem-summary">{pm.analysis.honestSummary}</p>
                        )}
                        {pm.analysis.whatWorked.length > 0 && (
                          <div className="fl-postmortem-block">
                            <div className="fl-postmortem-block-label worked">What worked</div>
                            <ul>
                              {pm.analysis.whatWorked.map((w, i) => <li key={`w${i}`}>{w}</li>)}
                            </ul>
                          </div>
                        )}
                        {pm.analysis.whatMissed.length > 0 && (
                          <div className="fl-postmortem-block">
                            <div className="fl-postmortem-block-label missed">What was missed</div>
                            <ul>
                              {pm.analysis.whatMissed.map((w, i) => <li key={`m${i}`}>{w}</li>)}
                            </ul>
                          </div>
                        )}
                        {pm.analysis.ruleReferences.length > 0 && (
                          <div className="fl-postmortem-block">
                            <div className="fl-postmortem-block-label rules">Lesson references</div>
                            <ul>
                              {pm.analysis.ruleReferences.map((r, i) => (
                                <li key={`r${i}`}>
                                  <button className="fl-postmortem-lesson-link"
                                    onClick={(e) => { e.stopPropagation(); openLessonById(r.lessonId) }}>
                                    {r.lessonTitle}
                                  </button>
                                  {' — '}{r.reason}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {pm.analysis.nextTimeTip && (
                          <div className="fl-postmortem-tip">
                            <span className="fl-postmortem-tip-label">Next time</span>
                            <span>{pm.analysis.nextTimeTip}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {expanded && !pm && (
                      <div className="fl-postmortem-body">
                        <p className="fl-postmortem-pending-msg">
                          {pending
                            ? 'Generating review — typically takes 5–15 seconds.'
                            : 'Post-mortem not yet generated. Close another trade or refresh.'}
                        </p>
                      </div>
                    )}
                  </div>
                )
              })}
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

      /* ── Disclaimers on idea tiles ─────────────────── */
      .fl-signal-disclaimer {
        margin-top: 8px;
        padding-top: 6px;
        border-top: 1px dashed rgba(148, 163, 184, 0.15);
        font-size: 8px;
        letter-spacing: 0.05em;
        color: rgba(148, 163, 184, 0.5);
        text-align: center;
        font-style: italic;
      }
      .fl-signal-disclaimer-option {
        color: rgba(251, 191, 36, 0.65);
        border-top-color: rgba(251, 191, 36, 0.2);
      }

      /* ── Commit B: verdict attribution link on tiles ─────────── */
      .fl-signal-attribution {
        display: block;
        width: 100%;
        margin-top: 6px;
        padding: 4px 0;
        background: transparent;
        border: none;
        border-top: 1px solid rgba(96, 165, 250, 0.15);
        color: rgba(96, 165, 250, 0.8);
        font-family: 'IBM Plex Mono', monospace;
        font-size: 9px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        cursor: pointer;
        transition: color 0.15s ease;
      }
      .fl-signal-attribution:hover {
        color: #60a5fa;
      }

      /* ── Commit B: options risk surfacing block ─────────── */
      .fl-option-risks {
        margin-top: 8px;
        padding: 8px 10px;
        background: rgba(15, 23, 42, 0.5);
        border-radius: 3px;
        border: 1px solid rgba(148, 163, 184, 0.1);
      }
      .fl-option-risk-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 2px 0;
      }
      .fl-option-risk-k {
        font-size: 9px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: rgba(148, 163, 184, 0.7);
      }
      .fl-option-risk-v {
        font-size: 11px;
        color: rgba(226, 232, 240, 0.9);
        font-weight: 600;
      }
      .fl-option-risk-danger {
        color: #dc2626 !important;
      }
      .fl-option-risk-sub {
        font-size: 9px;
        color: rgba(148, 163, 184, 0.6);
        font-weight: 400;
      }
      .fl-option-dte-urgent {
        color: #dc2626;
        font-weight: 700;
      }

      /* ── Commit B: tier info button + rules popover ─────────── */
      .fl-ladder-head-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .fl-tier-info-btn {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: rgba(212, 168, 87, 0.1);
        border: 1px solid rgba(212, 168, 87, 0.25);
        color: rgba(212, 168, 87, 0.85);
        font-size: 11px;
        font-weight: 600;
        font-family: 'IBM Plex Mono', monospace;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        transition: all 0.15s ease;
      }
      .fl-tier-info-btn:hover {
        background: rgba(212, 168, 87, 0.18);
        color: #d4a857;
      }
      .fl-tier-rules {
        margin: 10px 0 16px;
        background: rgba(15, 23, 42, 0.6);
        border: 1px solid rgba(212, 168, 87, 0.2);
        border-radius: 4px;
        overflow: hidden;
        animation: tierRulesIn 0.25s ease;
      }
      @keyframes tierRulesIn {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .fl-tier-rules-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        background: rgba(212, 168, 87, 0.05);
        border-bottom: 1px solid rgba(212, 168, 87, 0.15);
        font-size: 10px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: rgba(212, 168, 87, 0.9);
        font-family: 'IBM Plex Mono', monospace;
      }
      .fl-tier-rules-close {
        background: transparent;
        border: none;
        color: rgba(148, 163, 184, 0.6);
        font-size: 16px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }
      .fl-tier-rules-close:hover { color: rgba(226, 232, 240, 0.9); }
      .fl-tier-rules-body {
        padding: 10px 12px;
        font-size: 11px;
        line-height: 1.5;
        color: rgba(148, 163, 184, 0.9);
      }
      .fl-tier-rules-body p {
        margin: 0 0 8px;
      }
      .fl-tier-rules-body ul {
        list-style: none;
        padding: 0;
        margin: 8px 0;
      }
      .fl-tier-rules-body li {
        display: grid;
        grid-template-columns: 90px 110px 1fr;
        gap: 8px;
        padding: 4px 0;
        border-top: 1px dashed rgba(148, 163, 184, 0.08);
        align-items: baseline;
      }
      .fl-tier-rules-body li:first-child {
        border-top: none;
      }
      .fl-tier-rules-name {
        font-weight: 600;
        font-size: 11px;
      }
      .fl-tier-rules-req {
        font-size: 10px;
        color: rgba(148, 163, 184, 0.7);
      }
      .fl-tier-rules-tag {
        font-size: 10px;
        color: rgba(148, 163, 184, 0.55);
        font-style: italic;
      }
      .fl-tier-rules-foot {
        margin-top: 10px !important;
        padding-top: 10px;
        border-top: 1px dashed rgba(212, 168, 87, 0.2);
        font-size: 10px !important;
        color: rgba(148, 163, 184, 0.7) !important;
      }

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

      /* ── Commit A: ticket disclaimer + stop/target + rationale styles ─────────── */
      .fl-ticket-disclaimer {
        padding: 10px 20px;
        margin: 0;
        font-size: 11px;
        line-height: 1.45;
        color: rgba(251, 191, 36, 0.8);
        background: rgba(251, 191, 36, 0.05);
        border-top: 1px solid rgba(251, 191, 36, 0.2);
        text-align: center;
      }
      .fl-ticket-grid2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .fl-ticket-hint {
        padding: 8px 12px;
        margin: -2px 0 8px 0;
        font-size: 11px;
        line-height: 1.4;
        border-radius: 4px;
        color: rgba(148, 163, 184, 0.8);
        background: rgba(148, 163, 184, 0.06);
      }
      .fl-ticket-hint-warn {
        color: #fbbf24;
        background: rgba(251, 191, 36, 0.08);
        border-left: 2px solid rgba(251, 191, 36, 0.5);
      }
      .fl-field-hint {
        font-size: 10px;
        letter-spacing: 0.04em;
        color: rgba(251, 191, 36, 0.75);
        margin-top: 4px;
        font-style: italic;
      }
      .fl-ticket-confirm-hint {
        padding: 10px 20px 12px;
        font-size: 11px;
        line-height: 1.45;
        color: rgba(220, 38, 38, 0.85);
        background: rgba(220, 38, 38, 0.06);
        border-top: 1px solid rgba(220, 38, 38, 0.2);
        text-align: center;
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

      /* ══════════════════════════════════════════════════════
         OPTIONS + POST-MORTEM STYLES
         Added for Operator-tier options feature + trade reviews.
         ══════════════════════════════════════════════════════ */

      /* Stock/Option mode toggle on the order ticket */
      .fl-mode-toggle {
        display: flex;
        gap: 6px;
        background: rgba(15, 23, 42, 0.6);
        padding: 3px;
        border-radius: 8px;
        border: 1px solid rgba(148, 163, 184, 0.1);
      }
      .fl-mode-toggle button {
        flex: 1;
        padding: 8px 12px;
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.04em;
        background: transparent;
        color: rgba(148, 163, 184, 0.7);
        border: none;
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .fl-mode-toggle button:hover:not(:disabled):not(.active) {
        color: #f5f5f5;
        background: rgba(148, 163, 184, 0.05);
      }
      .fl-mode-toggle button.active {
        background: rgba(212, 168, 87, 0.15);
        color: #d4a857;
        box-shadow: 0 0 0 1px rgba(212, 168, 87, 0.4);
      }
      .fl-mode-toggle button.active.call {
        background: rgba(16, 185, 129, 0.15);
        color: #34d399;
        box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.4);
      }
      .fl-mode-toggle button.active.put {
        background: rgba(220, 38, 38, 0.15);
        color: #f87171;
        box-shadow: 0 0 0 1px rgba(220, 38, 38, 0.4);
      }
      .fl-mode-toggle button:disabled {
        cursor: not-allowed;
        opacity: 0.6;
      }

      /* Options signals section below the stock grid */
      .fl-options-section {
        margin-top: 28px;
        padding-top: 20px;
        border-top: 1px solid rgba(99, 102, 241, 0.15);
      }
      .fl-options-header {
        margin-bottom: 14px;
      }
      .fl-options-header .fl-eyebrow {
        color: rgba(99, 102, 241, 0.85);
      }
      .fl-options-header h3 {
        margin: 2px 0 0;
        font-size: 14px;
        font-weight: 500;
        color: #f5f5f5;
        letter-spacing: -0.01em;
      }
      .fl-options-warning {
        margin: 0 0 14px;
        padding: 10px 12px;
        font-size: 11px;
        line-height: 1.5;
        color: rgba(251, 191, 36, 0.85);
        background: rgba(251, 191, 36, 0.06);
        border-left: 2px solid rgba(251, 191, 36, 0.5);
        border-radius: 3px;
      }
      .fl-option-est-label {
        display: inline-block;
        margin-left: 5px;
        padding: 1px 4px;
        font-size: 7px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: rgba(251, 191, 36, 0.7);
        background: rgba(251, 191, 36, 0.08);
        border-radius: 2px;
        font-weight: 500;
        vertical-align: middle;
      }
      .fl-option-est-label.is-live {
        color: rgba(16, 185, 129, 0.85);
        background: rgba(16, 185, 129, 0.1);
      }
      .fl-options-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
        gap: 10px;
      }
      .fl-option-tile {
        padding: 11px 12px;
        border-radius: 10px;
        background: rgba(15, 23, 42, 0.4);
        border: 1px solid rgba(99, 102, 241, 0.2);
        cursor: pointer;
        transition: all 0.2s ease;
        animation: flSignalIn 0.4s ease both;
      }
      .fl-option-tile.call {
        border-color: rgba(16, 185, 129, 0.25);
        background: linear-gradient(180deg, rgba(16, 185, 129, 0.06), rgba(15, 23, 42, 0.4));
      }
      .fl-option-tile.put {
        border-color: rgba(220, 38, 38, 0.25);
        background: linear-gradient(180deg, rgba(220, 38, 38, 0.06), rgba(15, 23, 42, 0.4));
      }
      .fl-option-tile:hover {
        transform: translateY(-1px);
        border-color: rgba(212, 168, 87, 0.4);
      }
      .fl-option-tile.call:hover { border-color: rgba(16, 185, 129, 0.5); }
      .fl-option-tile.put:hover { border-color: rgba(220, 38, 38, 0.5); }

      .fl-option-badge {
        display: inline-block;
        font-size: 9px;
        font-weight: 600;
        letter-spacing: 0.08em;
        padding: 2px 6px;
        margin-left: 6px;
        border-radius: 3px;
        vertical-align: middle;
      }
      .fl-option-badge.call {
        background: rgba(16, 185, 129, 0.2);
        color: #34d399;
      }
      .fl-option-badge.put {
        background: rgba(220, 38, 38, 0.2);
        color: #f87171;
      }
      .fl-option-strike-row {
        display: flex;
        gap: 6px;
        align-items: center;
        font-size: 11px;
        color: rgba(148, 163, 184, 0.75);
        margin: 4px 0 6px;
      }

      /* Inline option badge on a position row */
      .fl-position-option-badge {
        display: inline-block;
        font-size: 9px;
        font-weight: 600;
        letter-spacing: 0.04em;
        padding: 2px 5px;
        margin-left: 6px;
        border-radius: 3px;
        font-family: ui-monospace, Menlo, monospace;
        vertical-align: middle;
      }
      .fl-position-option-badge.call {
        background: rgba(16, 185, 129, 0.15);
        color: #34d399;
        border: 1px solid rgba(16, 185, 129, 0.3);
      }
      .fl-position-option-badge.put {
        background: rgba(220, 38, 38, 0.15);
        color: #f87171;
        border: 1px solid rgba(220, 38, 38, 0.3);
      }

      /* DTE pill on option position row */
      .fl-dte-pill {
        display: inline-block;
        padding: 2px 7px;
        border-radius: 9px;
        font-size: 10px;
        font-weight: 500;
        background: rgba(148, 163, 184, 0.12);
        color: rgba(148, 163, 184, 0.9);
        border: 1px solid rgba(148, 163, 184, 0.2);
      }
      .fl-dte-pill.urgent {
        background: rgba(220, 38, 38, 0.15);
        color: #f87171;
        border-color: rgba(220, 38, 38, 0.4);
      }

      /* Math preview sub-rows (for option-mode) */
      .fl-math-row.sub {
        font-size: 11px;
        color: rgba(148, 163, 184, 0.7);
      }

      /* ══ POST-MORTEM CARDS ══ */
      .fl-postmortem-card {
        margin-bottom: 10px;
        border-radius: 10px;
        background: rgba(15, 23, 42, 0.3);
        border: 1px solid rgba(148, 163, 184, 0.12);
        overflow: hidden;
        transition: border-color 0.2s ease;
      }
      .fl-postmortem-card.expanded {
        border-color: rgba(212, 168, 87, 0.35);
      }

      .fl-postmortem-head {
        display: block;
        width: 100%;
        padding: 11px 13px;
        background: transparent;
        border: none;
        cursor: pointer;
        text-align: left;
        transition: background 0.15s ease;
      }
      .fl-postmortem-head:hover {
        background: rgba(148, 163, 184, 0.04);
      }
      .fl-postmortem-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
      }
      .fl-postmortem-meta {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 11px;
      }
      .fl-postmortem-meta .up { color: #34d399; }
      .fl-postmortem-meta .dn { color: #f87171; }
      .fl-postmortem-score {
        color: rgba(148, 163, 184, 0.6);
        margin-left: auto;
        font-size: 10px;
      }

      /* Grade badge styling — A green, B amber, C gray, D orange, F red */
      .fl-grade-badge {
        font-family: ui-monospace, Menlo, monospace;
        font-size: 12px;
        font-weight: 600;
        padding: 4px 10px;
        border-radius: 6px;
        letter-spacing: 0.02em;
      }
      .fl-grade-badge.grade-a {
        background: rgba(16, 185, 129, 0.18);
        color: #34d399;
        border: 1px solid rgba(16, 185, 129, 0.4);
      }
      .fl-grade-badge.grade-b {
        background: rgba(212, 168, 87, 0.18);
        color: #d4a857;
        border: 1px solid rgba(212, 168, 87, 0.4);
      }
      .fl-grade-badge.grade-c {
        background: rgba(148, 163, 184, 0.12);
        color: rgba(203, 213, 225, 0.95);
        border: 1px solid rgba(148, 163, 184, 0.3);
      }
      .fl-grade-badge.grade-d {
        background: rgba(251, 146, 60, 0.15);
        color: #fb923c;
        border: 1px solid rgba(251, 146, 60, 0.4);
      }
      .fl-grade-badge.grade-f {
        background: rgba(220, 38, 38, 0.18);
        color: #f87171;
        border: 1px solid rgba(220, 38, 38, 0.4);
      }
      .fl-grade-badge.pending {
        background: rgba(148, 163, 184, 0.08);
        color: rgba(148, 163, 184, 0.6);
        border: 1px solid rgba(148, 163, 184, 0.2);
        font-size: 10px;
        font-weight: 400;
      }

      /* Expanded post-mortem body */
      .fl-postmortem-body {
        padding: 4px 13px 13px;
        border-top: 1px solid rgba(148, 163, 184, 0.08);
      }
      .fl-postmortem-summary {
        margin: 10px 0 12px;
        font-size: 12px;
        line-height: 1.5;
        color: rgba(203, 213, 225, 0.85);
        font-style: italic;
      }
      .fl-postmortem-block {
        margin-bottom: 10px;
      }
      .fl-postmortem-block-label {
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        margin-bottom: 4px;
      }
      .fl-postmortem-block-label.worked { color: #34d399; }
      .fl-postmortem-block-label.missed { color: #f87171; }
      .fl-postmortem-block-label.rules { color: #d4a857; }
      .fl-postmortem-block ul {
        margin: 0;
        padding-left: 18px;
        font-size: 12px;
        line-height: 1.5;
        color: rgba(203, 213, 225, 0.85);
      }
      .fl-postmortem-block ul li {
        margin-bottom: 4px;
      }
      .fl-postmortem-lesson-link {
        background: none;
        border: none;
        padding: 0;
        margin: 0;
        color: #d4a857;
        cursor: pointer;
        font: inherit;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .fl-postmortem-lesson-link:hover {
        color: #fbbf24;
      }

      .fl-postmortem-tip {
        display: flex;
        gap: 8px;
        padding: 10px 12px;
        margin-top: 8px;
        background: rgba(212, 168, 87, 0.08);
        border: 1px solid rgba(212, 168, 87, 0.25);
        border-radius: 8px;
        font-size: 12px;
        line-height: 1.5;
      }
      .fl-postmortem-tip-label {
        font-weight: 600;
        font-size: 10px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: #d4a857;
        white-space: nowrap;
        padding-top: 1px;
      }
      .fl-postmortem-pending-msg {
        margin: 10px 0;
        font-size: 12px;
        color: rgba(148, 163, 184, 0.7);
        font-style: italic;
      }

      /* ── Commit C: postmortem council-context block ─────────── */
      .fl-postmortem-context {
        padding: 10px 12px;
        margin: 0 0 12px;
        background: rgba(99, 102, 241, 0.05);
        border: 1px solid rgba(99, 102, 241, 0.15);
        border-radius: 4px;
      }
      .fl-postmortem-context-header {
        font-size: 9px;
        letter-spacing: 0.15em;
        text-transform: uppercase;
        color: rgba(99, 102, 241, 0.9);
        margin-bottom: 8px;
        font-family: 'IBM Plex Mono', monospace;
      }
      .fl-postmortem-context-row {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        padding: 3px 0;
        font-size: 11px;
        gap: 10px;
      }
      .fl-postmortem-context-row .k {
        color: rgba(148, 163, 184, 0.7);
        font-size: 10px;
        letter-spacing: 0.03em;
      }
      .fl-postmortem-context-row .v {
        color: rgba(226, 232, 240, 0.92);
        text-align: right;
      }
      .fl-postmortem-context-row .v .up { color: #10b981; }
      .fl-postmortem-context-row .v .dn { color: #dc2626; }
      .fl-postmortem-context-sub {
        color: rgba(148, 163, 184, 0.7);
        font-size: 10px;
      }
      .fl-postmortem-context-row-stacked {
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        padding: 6px 0 3px;
      }
      .fl-postmortem-context-row-stacked .v {
        text-align: left;
        width: 100%;
      }
      .fl-postmortem-rationale {
        color: rgba(226, 232, 240, 0.85) !important;
        font-style: italic;
        line-height: 1.45;
      }
      .fl-plan-outcome { font-weight: 600; }
      .fl-plan-target_hit { color: #10b981 !important; }
      .fl-plan-stop_hit { color: #dc2626 !important; }
      .fl-plan-closed_early { color: rgba(251, 191, 36, 0.9) !important; }

      /* ── Commit C: empty states ─────────── */
      .fl-empty-state {
        padding: 20px 16px;
        text-align: center;
        background: rgba(15, 23, 42, 0.3);
        border: 1px dashed rgba(148, 163, 184, 0.2);
        border-radius: 6px;
      }
      .fl-empty-state p {
        margin: 0 0 6px;
        font-size: 13px;
        color: rgba(226, 232, 240, 0.8);
      }
      .fl-empty-state-sub {
        font-size: 11px !important;
        color: rgba(148, 163, 184, 0.7) !important;
        line-height: 1.5 !important;
        margin: 0 !important;
        max-width: 360px;
        margin-left: auto !important;
        margin-right: auto !important;
      }
      .fl-empty-state-compact {
        padding: 14px 12px;
      }
      .fl-empty-state-options {
        border-color: rgba(99, 102, 241, 0.2);
      }

      /* ── Commit C: mobile media queries for Commit A+B elements ─────── */
      @media (max-width: 640px) {
        /* Order ticket: stop/target grid collapses to single column */
        .fl-ticket-grid2 {
          grid-template-columns: 1fr !important;
          gap: 8px !important;
        }

        /* Tier rules popover: wider on narrow screens, smaller text */
        .fl-tier-rules-body li {
          grid-template-columns: 80px 90px 1fr;
          gap: 6px;
          font-size: 10px;
        }
        .fl-tier-rules-name { font-size: 10px !important; }
        .fl-tier-rules-req { font-size: 9px !important; }
        .fl-tier-rules-tag { font-size: 9px !important; }

        /* Option risk block: slightly tighter on mobile */
        .fl-option-risks {
          padding: 6px 8px;
        }
        .fl-option-risk-k { font-size: 8px !important; }
        .fl-option-risk-v { font-size: 10px !important; }

        /* Signal attribution link: smaller on mobile */
        .fl-signal-attribution {
          font-size: 8px !important;
          padding: 3px 0 !important;
        }

        /* Ticket disclaimer: smaller padding on mobile */
        .fl-ticket-disclaimer {
          padding: 8px 14px !important;
          font-size: 10px !important;
        }

        /* Options grid: single column on narrow */
        .fl-options-grid {
          grid-template-columns: 1fr !important;
        }

        /* Signals grid: keep 2-col on phones but shrink tiles */
        .fl-signals-grid {
          grid-template-columns: repeat(2, 1fr) !important;
          gap: 8px !important;
        }
        .fl-signal-tile, .fl-option-tile {
          padding: 9px 10px !important;
        }
      }

      @media (max-width: 380px) {
        /* Very narrow phones: signals grid also becomes single col */
        .fl-signals-grid {
          grid-template-columns: 1fr !important;
        }
        .fl-postmortem-context-row {
          flex-direction: column;
          align-items: flex-start;
          gap: 2px;
        }
        .fl-postmortem-context-row .v {
          text-align: left;
        }
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
