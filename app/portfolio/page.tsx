/**
 * Wali-OS — Portfolio Page (v3 Unified)
 *
 * 2026-04-29 — Full rewrite. Combines former Holdings + Dividends + Reinvest
 * tabs into one unified surface. Each position is a row that expands inline
 * to show a full per-position panel with health check, council history,
 * dividends received, linked reinvest trades, and journal entries. Cross-
 * linking is first-class: a dividend row shows what reinvest trade it
 * funded; a reinvest row shows what dividend funded it.
 *
 * What changed:
 *   - DROPPED: Holdings/Dividends/Reinvest tabs. Single unified page.
 *   - DROPPED: Journal tab — Journal moved to its standalone page (see
 *     /app/journal/page.tsx). The header now has a "Journal →" link.
 *   - ADDED: Action Required strip — TERMINAL/EXIT/expiring/stop-breached/
 *     unlogged-dividends, sorted by severity.
 *   - ADDED: Recent Activity strip — pending Council outcomes, resolved
 *     Council outcomes, recent reinvest opens/closes. Configurable window
 *     (default 14 days, persisted to localStorage).
 *   - ADDED: Inline-expanding position rows with 6 sub-sections:
 *       1. Health Check (existing PositionCheck rendering)
 *       2. Council History (verdict_log lookup)
 *       3. Dividends (received + linked reinvest trades)
 *       4. Reinvest trades (filtered to this ticker; "Log new" prefilled)
 *       5. Linked journal entries (read-only summary, "View in Journal" link)
 *       6. Actions footer (Run Council, Edit, Remove)
 *   - ADDED: "Log dividend from position" workflow — opens existing modal
 *     with ticker prefilled.
 *   - ADDED: "Log reinvest from dividend" workflow — auto-populates
 *     funded_by_dividend_id FK from Part 1.
 *   - ADDED: localStorage persistence for expanded-rows state, recent-
 *     activity window, and filter state.
 *
 * What's preserved (must keep working — verify after deploy):
 *   - loadCachedAnalysis() SSE stream parsing (events: status,
 *     position_data, complete, error)
 *   - runAnalysis(forceRefresh) — same SSE flow
 *   - addPosition() — both stock and option types, all field validation
 *   - runHealthCheck(ticker?) — single position or all-positions
 *   - removePosition() — with confirm
 *   - All Drawer/FormField patterns
 *   - saveDiv(), addReinvestTrade(), deleteDiv(), deleteReinvestTrade()
 *   - Sort by ticker/value/day/pnl/alloc/signal
 *   - Live ticker price enrichment for reinvest trades
 *   - cachedAge display ('just analyzed' / 'Xm old' / 'Xh old')
 *   - statusMsg display during streaming
 *   - 'Add Position' / 'Health Check' / 'Analyze' top-level buttons
 *   - AI Portfolio Summary card at bottom (existing render unchanged)
 */

'use client'

import { useState, useEffect, useCallback, useMemo, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, Plus, Trash2, RefreshCw, TrendingUp, TrendingDown,
  AlertTriangle, Calendar, DollarSign, Check, X, Clock,
  Star, Repeat2, ChevronDown, ChevronRight, Activity, Briefcase,
  BookOpen, Stethoscope, Target, FileText, ExternalLink, Settings,
  Archive,
} from 'lucide-react'
import { CloseModal, type ClosablePosition, type CloseResult } from '@/app/components/portfolio/CloseModal'
import { ClosedTab } from '@/app/components/portfolio/ClosedTab'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Position {
  id: string; ticker: string; shares: number; avg_cost: number | null
  notes: string | null; position_type: 'stock' | 'option'
  option_type: 'call' | 'put' | null; strike: number | null; expiry: string | null
  contracts: number | null; entry_premium: number | null; underlying: string | null
}
interface PositionData {
  ticker: string; shares: number; avg_cost: number | null; currentPrice: number
  marketValue: number; gainLoss: number | null; gainLossPct: number | null
  priceChange1D: number; rsi: number | null; signal: string; goldenCross: boolean | null
  earningsDate: string | null; daysToEarnings: number | null; sector: string
  analystConsensus: string; analystTarget: number | null
}
interface PortfolioMetrics {
  totalValue: number; totalGainLoss: number; totalGainLossPct: number
  sectorConcentration: Array<{ sector: string; pct: number }>
  upcomingEarnings: PositionData[]
  signals: { BULLISH: number; NEUTRAL: number; BEARISH: number }
  exposureByUnderlying?: Array<{
    underlying: string; netExposure: number; totalCapitalAtRisk: number
    positionCount: number; hasStock: boolean; hasOptions: boolean; description: string
  }>
}
interface PortfolioAnalysis {
  overallSignal: string; overallConviction: string; headline: string; summary: string
  topRisks: Array<{ risk: string; tickers: string[]; severity: string }>
  opportunities: Array<{ opportunity: string; tickers: string[] }>
  sectorAnalysis: string; earningsWatch: string; rebalancingSuggestions: string
  actionPlan: string; portfolioScore: number
}

// CouncilHistoryContext from PositionCheck v2
interface CouncilHistoryContext {
  recentSignal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  recentConfidence: number | null
  recentEntry: number | null
  recentStop: number | null
  recentTarget: number | null
  recentTimeframe: string | null
  recentPersona: string | null
  daysSinceVerdict: number
  outcomeStatus: 'pending' | 'correct' | 'incorrect' | 'unknown'
  outcomeHorizon: '1w' | '1m' | null
  positionContradictsCouncil: boolean
  alignmentNote: string
  personaDisagreement: string | null
}

interface PositionCheck {
  ticker: string; position_type: 'stock' | 'option'
  underlyingPrice: number; underlyingChange1D: number
  underlyingRsi: number | null; underlyingVolumeRatio: number | null
  entryPrice: number | null; pnlPct: number | null; pnlDollar: number | null
  stopLoss: number | null; takeProfit: number | null
  pctFromStop: number | null; pctFromTarget: number | null
  optionType?: string; strike?: number; expiry?: string; contracts?: number
  entryPremium: number | null; currentPremium: number | null
  optionPnlPct: number | null; optionPnlDollar: number | null
  daysToExpiry: number | null; timeDecayUrgent: boolean
  delta: number | null; theta: number | null; gamma: number | null; vega: number | null
  impliedVolatility: number | null; intrinsicValue: number | null; timeValue: number | null
  moneyness: string; breakeven: number | null

  // v2 added fields (all optional/nullable for back-compat)
  directionalExposure?: number | null
  capitalAtRisk?: number | null
  bid?: number | null
  ask?: number | null
  realisticProceedsLow?: number | null
  realisticProceedsHigh?: number | null
  realisticProceedsNote?: string | null
  hoursUntilExpiry?: number | null
  deadlineLabel?: string | null
  savePathSummary?: string | null
  savePathProbabilityVerbal?: string | null
  savePathProbabilityNumeric?: string | null
  terminal?: boolean
  terminalReason?: string | null
  councilHistory?: CouncilHistoryContext | null

  verdict: 'HOLD' | 'EXIT' | 'ADD' | 'WATCH' | 'TERMINAL'
  conviction: 'high' | 'medium' | 'low'; reason: string; action: string; flags: string[]
}

interface JournalEntry {
  id: string; ticker: string; signal: string; entry_price: number | null
  stop_loss: number | null; take_profit: number | null; timeframe: string | null
  confidence: number | null; exit_price: number | null; outcome: string
  pnl_percent: number | null; position_type: 'stock' | 'option'
  option_type: 'call' | 'put' | null; strike: number | null; expiry: string | null
  contracts: number | null; entry_premium: number | null; exit_premium: number | null
  underlying: string | null
  postmortem: {
    what_worked: string; what_missed: string; key_lesson: string
    signal_quality: string; council_grade: string; improve_next_time: string
  } | null
  notes: string | null; tags: string[] | null; created_at: string
}

interface LinkedReinvestTrade {
  id: string; ticker: string; shares: number; entry_price: number
  exit_price: number | null; exit_date: string | null
  council_signal: string | null; confidence: number | null
  notes: string | null; opened_at: string
}

interface Dividend {
  id: string; ticker: string; ex_date: string; pay_date: string | null
  amount_per_share: number; shares_held: number; total_received: number
  reinvested: boolean; reinvest_shares: number | null
  reinvest_price: number | null; notes: string | null
  // NEW from Part 1 — array of trades funded by this dividend
  linkedReinvestTrades?: LinkedReinvestTrade[]
}

interface DividendSchedule {
  ticker: string; ex_date: string; pay_date: string | null
  amount: number | null; frequency: string | null
}

interface ReinvestTrade {
  id: string; ticker: string; shares: number; entry_price: number
  exit_price: number | null; exit_date: string | null
  council_signal: string | null; confidence: number | null
  notes: string | null; opened_at: string
  // NEW from Part 1
  funded_by_dividend_id?: string | null
  // Computed client-side
  currentPrice?: number | null; pnl?: number | null; pnlPct?: number | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const UP = '#34d399'
const DN = '#f87171'
const FLAT = '#fbbf24'
const ACCENT = '#a78bfa'
const TERMINAL_RED = '#dc2626'

const VERDICT_COLOR: Record<string, string> = {
  TERMINAL: TERMINAL_RED, EXIT: DN, WATCH: FLAT, HOLD: UP, ADD: '#60a5fa',
}
const VERDICT_BG: Record<string, string> = {
  TERMINAL: 'rgba(220,38,38,0.18)',
  EXIT: 'rgba(248,113,113,0.08)',
  WATCH: 'rgba(251,191,36,0.06)',
  HOLD: 'rgba(52,211,153,0.05)',
  ADD: 'rgba(96,165,250,0.06)',
}

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
const gradeColor = (g: string) => ({ A: UP, B: '#60a5fa', C: FLAT, D: '#f97316', F: DN }[g] || '#94a3b8')
const pnlColor = (n: number | null | undefined) => {
  if (n == null || n === 0) return 'var(--text3)'
  return n > 0 ? UP : DN
}

// ─────────────────────────────────────────────────────────────────────────────
// localStorage helpers — for persisted UI state
// ─────────────────────────────────────────────────────────────────────────────

const LS_KEYS = {
  expandedRows: 'wali.portfolio.expandedRows',
  recentActivityDays: 'wali.portfolio.recentActivityDays',
  positionFilter: 'wali.portfolio.positionFilter',
  sortPref: 'wali.portfolio.sortPref',
  actionRequiredCollapsed: 'wali.portfolio.actionRequiredCollapsed',
  recentActivityCollapsed: 'wali.portfolio.recentActivityCollapsed',
}

function lsGet<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch { return fallback }
}

function lsSet(key: string, value: unknown) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* quota or disabled */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types continued — Action Required + Recent Activity items
// ─────────────────────────────────────────────────────────────────────────────

type SortKey = 'ticker' | 'value' | 'day' | 'pnl' | 'alloc' | 'signal'
type SortDir = 'asc' | 'desc'
type PositionFilter = 'all' | 'stocks' | 'options'

interface ActionRequiredItem {
  id: string                              // unique id for React key + dedup
  severity: 'critical' | 'warning'
  category: 'TERMINAL' | 'EXIT' | 'EXPIRING' | 'STOP_BREACH' | 'UNLOGGED_DIV' | 'WATCH'
  ticker: string
  primary: string                         // headline text
  secondary?: string                      // subtext (the "why")
  ctaLabel: string                        // button label
  onClick: () => void                     // action handler
}

interface RecentActivityItem {
  id: string
  category: 'COUNCIL_RESOLVED' | 'COUNCIL_PENDING' | 'REINVEST_OPENED' | 'REINVEST_CLOSED' | 'DIV_RECEIVED'
  ticker: string
  primary: string
  secondary?: string
  date: Date                              // for sorting and 14-day filter
  ctaLabel?: string
  onClick?: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper components — Drawer + FormField (preserved from old page)
// ─────────────────────────────────────────────────────────────────────────────

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] font-mono uppercase tracking-wider block mb-1.5" style={{ color: 'var(--text3)' }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <>
      <div onClick={onClose}
        className="fixed inset-0 z-30"
        style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
        aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-labelledby="drawer-title"
        className="fixed right-0 top-0 bottom-0 z-40 w-full sm:w-[480px] overflow-y-auto animate-slide-in-right"
        style={{ background: 'var(--surface)', borderLeft: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b sticky top-0"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <h3 id="drawer-title" className="text-sm font-bold" style={{ color: 'var(--text)' }}>{title}</h3>
          <button onClick={onClose}
            className="p-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ color: 'var(--text3)' }}
            aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="p-5">
          {children}
        </div>
      </div>
    </>
  )
}
// ═════════════════════════════════════════════════════════════════════════════
// Main component
// ═════════════════════════════════════════════════════════════════════════════

function PortfolioInner() {
  const router = useRouter()

  // ── Holdings state (preserved from old page) ─────────────────────
  const [positions, setPositions] = useState<Position[]>([])
  const [positionData, setPositionData] = useState<PositionData[]>([])
  const [metrics, setMetrics] = useState<PortfolioMetrics | null>(null)
  const [analysis, setAnalysis] = useState<PortfolioAnalysis | null>(null)
  const [loadingHoldings, setLoadingHoldings] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [cachedAge, setCachedAge] = useState<number | null>(null)
  const [statusMsg, setStatusMsg] = useState('')

  // Add-position drawer state (preserved)
  const [showAdd, setShowAdd] = useState(false)
  const [addType, setAddType] = useState<'stock' | 'option'>('stock')
  const [addTicker, setAddTicker] = useState('')
  const [addShares, setAddShares] = useState('')
  const [addCost, setAddCost] = useState('')
  const [addOptionType, setAddOptionType] = useState<'call' | 'put'>('call')
  const [addStrike, setAddStrike] = useState('')
  const [addExpiry, setAddExpiry] = useState('')
  const [addContracts, setAddContracts] = useState('1')
  const [addLoading, setAddLoading] = useState(false)

  // Health check state (preserved)
  const [checks, setChecks] = useState<PositionCheck[]>([])
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [checkTicker, setCheckTicker] = useState<string | null>(null)

  // Close-position state (Commit 1+2)
  const [closeTarget, setCloseTarget] = useState<ClosablePosition | null>(null)
  const [closedReloadKey, setClosedReloadKey] = useState(0)
  const [showClosed, setShowClosed] = useState(false)
  const [realizedPnlTotal, setRealizedPnlTotal] = useState(0)

  // Sort state (persisted)
  const [sortKey, setSortKey] = useState<SortKey>('value')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // ── NEW v3 state ────────────────────────────────────────────────
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [positionFilter, setPositionFilter] = useState<PositionFilter>('all')
  const [recentActivityDays, setRecentActivityDays] = useState<number>(14)
  const [actionRequiredCollapsed, setActionRequiredCollapsed] = useState<boolean>(false)
  const [recentActivityCollapsed, setRecentActivityCollapsed] = useState<boolean>(false)
  const [showSettings, setShowSettings] = useState<boolean>(false)

  // ── Dividend state (preserved + extended) ────────────────────────
  const [dividends, setDividends] = useState<Dividend[]>([])
  const [divSchedule, setDivSchedule] = useState<DividendSchedule[]>([])
  const [loadingDividends, setLoadingDividends] = useState(false)
  const [showLogDiv, setShowLogDiv] = useState(false)
  const [divTicker, setDivTicker] = useState('')
  const [divAmount, setDivAmount] = useState('')
  const [divShares, setDivShares] = useState('')
  const [divExDate, setDivExDate] = useState('')
  const [divPayDate, setDivPayDate] = useState('')
  const [divReinvested, setDivReinvested] = useState(false)
  const [divReinvestShares, setDivReinvestShares] = useState('')
  const [divReinvestPrice, setDivReinvestPrice] = useState('')
  const [savingDiv, setSavingDiv] = useState(false)

  // ── Reinvest state (preserved + extended) ────────────────────────
  const [reinvestTrades, setReinvestTrades] = useState<ReinvestTrade[]>([])
  const [loadingReinvest, setLoadingReinvest] = useState(false)
  const [showAddReinvest, setShowAddReinvest] = useState(false)
  const [rTicker, setRTicker] = useState('')
  const [rShares, setRShares] = useState('')
  const [rEntry, setREntry] = useState('')
  const [rNotes, setRNotes] = useState('')
  const [rFundedByDividendId, setRFundedByDividendId] = useState<string | null>(null)
  const [savingReinvest, setSavingReinvest] = useState(false)

  // ── Journal state (read-only preview here; full management in /journal) ──
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([])
  const [loadingJournal, setLoadingJournal] = useState(false)

  // ── Hydrate persisted state on mount ────────────────────────────
  useEffect(() => {
    setExpandedRows(new Set(lsGet<string[]>(LS_KEYS.expandedRows, [])))
    setRecentActivityDays(lsGet<number>(LS_KEYS.recentActivityDays, 14))
    setPositionFilter(lsGet<PositionFilter>(LS_KEYS.positionFilter, 'all'))
    setActionRequiredCollapsed(lsGet<boolean>(LS_KEYS.actionRequiredCollapsed, false))
    setRecentActivityCollapsed(lsGet<boolean>(LS_KEYS.recentActivityCollapsed, false))
    const sortPref = lsGet<{ key: SortKey; dir: SortDir }>(LS_KEYS.sortPref, { key: 'value', dir: 'desc' })
    setSortKey(sortPref.key)
    setSortDir(sortPref.dir)
  }, [])

  // ── Persist on change ────────────────────────────────────────────
  useEffect(() => { lsSet(LS_KEYS.expandedRows, Array.from(expandedRows)) }, [expandedRows])
  useEffect(() => { lsSet(LS_KEYS.recentActivityDays, recentActivityDays) }, [recentActivityDays])
  useEffect(() => { lsSet(LS_KEYS.positionFilter, positionFilter) }, [positionFilter])
  useEffect(() => { lsSet(LS_KEYS.actionRequiredCollapsed, actionRequiredCollapsed) }, [actionRequiredCollapsed])
  useEffect(() => { lsSet(LS_KEYS.recentActivityCollapsed, recentActivityCollapsed) }, [recentActivityCollapsed])
  useEffect(() => { lsSet(LS_KEYS.sortPref, { key: sortKey, dir: sortDir }) }, [sortKey, sortDir])

  // ═════════════════════════════════════════════════════════════════
  // PRESERVED HANDLERS — exactly the same behavior as the old page
  // ═════════════════════════════════════════════════════════════════

  // -- Cached analysis SSE flow (preserved) --
  const loadCachedAnalysis = useCallback(async (pos: typeof positions) => {
    if (!pos.length) return
    const res = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        positions: pos.map(p => ({
          ticker: p.ticker, shares: p.shares, avg_cost: p.avg_cost,
          position_type: p.position_type, option_type: p.option_type,
          strike: p.strike, expiry: p.expiry, contracts: p.contracts,
          entry_premium: p.entry_premium, underlying: p.underlying,
        })),
        forceRefresh: false,
      }),
    })
    if (!res.body) return
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n'); buf = parts.pop() || ''
      for (const part of parts) {
        const ev = part.split('\n').find(l => l.startsWith('event:'))?.replace('event:', '').trim()
        const d = (() => {
          try { return JSON.parse(part.split('\n').find(l => l.startsWith('data:'))?.replace('data:', '').trim() || '{}') }
          catch { return {} }
        })()
        if (ev === 'position_data' && d.length) setPositionData(d)
        if (ev === 'complete' && d.cached) {
          setPositionData(d.positionData ?? [])
          setMetrics(d.metrics)
          setAnalysis(d.analysis)
          setCachedAge(d.ageMinutes ?? null)
        }
      }
    }
  }, [])

  // -- Load positions (preserved) --
  const loadPositions = useCallback(async () => {
    setLoadingHoldings(true)
    const res = await fetch('/api/portfolio/positions')
    const data = await res.json()
    const loaded: Position[] = data.positions ?? []
    setPositions(loaded)
    setLoadingHoldings(false)
    if (loaded.length > 0) loadCachedAnalysis(loaded)
  }, [loadCachedAnalysis])

  // -- Run analysis (preserved) --
  const runAnalysis = useCallback(async (forceRefresh = false) => {
    if (!positions.length) return
    setAnalyzing(true); setAnalysis(null); setPositionData([]); setMetrics(null)
    setCachedAge(null); setStatusMsg('Starting analysis...')
    const res = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        positions: positions.map(p => ({
          ticker: p.ticker, shares: p.shares, avg_cost: p.avg_cost,
          position_type: p.position_type, option_type: p.option_type,
          strike: p.strike, expiry: p.expiry, contracts: p.contracts,
          entry_premium: p.entry_premium, underlying: p.underlying,
        })),
        forceRefresh,
      }),
    })
    if (!res.body) { setAnalyzing(false); return }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n'); buf = parts.pop() || ''
      for (const part of parts) {
        const ev = part.split('\n').find(l => l.startsWith('event:'))?.replace('event:', '').trim()
        const d = (() => {
          try { return JSON.parse(part.split('\n').find(l => l.startsWith('data:'))?.replace('data:', '').trim() || '{}') }
          catch { return {} }
        })()
        if (ev === 'status') setStatusMsg(d.message)
        if (ev === 'position_data') setPositionData(d)
        if (ev === 'complete') {
          setPositionData(d.positionData)
          setMetrics(d.metrics)
          setAnalysis(d.analysis)
          setCachedAge(d.cached ? (d.ageMinutes ?? 0) : 0)
          setAnalyzing(false)
        }
        if (ev === 'error') { setStatusMsg(d.message); setAnalyzing(false) }
      }
    }
  }, [positions])

  // -- Add position (preserved) --
  const addPosition = async () => {
    if (!addTicker) return
    const isOption = addType === 'option'
    if (!isOption && !addShares) return
    if (isOption && (!addStrike || !addExpiry)) return
    setAddLoading(true)
    const body: Record<string, unknown> = {
      ticker: addTicker.toUpperCase(),
      position_type: addType,
    }
    if (isOption) {
      body.option_type    = addOptionType
      body.strike         = parseFloat(addStrike)
      body.expiry         = addExpiry
      body.contracts      = addContracts ? parseInt(addContracts) : 1
      body.entry_premium  = addCost ? parseFloat(addCost) : null
      body.underlying     = addTicker.toUpperCase()
      body.shares         = (addContracts ? parseInt(addContracts) : 1) * 100
    } else {
      body.shares   = parseFloat(addShares)
      body.avg_cost = addCost ? parseFloat(addCost) : null
    }
    await fetch('/api/portfolio/positions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setAddTicker(''); setAddShares(''); setAddCost(''); setAddStrike(''); setAddExpiry('')
    setAddContracts('1'); setShowAdd(false); setAddLoading(false)
    await loadPositions()
  }

  // -- Health check (preserved) --
  const runHealthCheck = async (ticker?: string) => {
    setChecking(true)
    try {
      if (ticker) {
        setCheckTicker(ticker)
        const res = await fetch(`/api/portfolio/check?ticker=${ticker}`)
        const data = await res.json()
        if (data.check) {
          setChecks(prev => {
            const filtered = prev.filter(c => c.ticker !== ticker)
            return [data.check, ...filtered]
          })
        }
      } else {
        const res = await fetch('/api/portfolio/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        const data = await res.json()
        setChecks(data.checks || [])
        setCheckedAt(data.checkedAt || null)
      }
    } finally {
      setChecking(false)
      setCheckTicker(null)
    }
  }

  // -- Remove position (preserved) --
  const removePosition = async (ticker: string) => {
    if (!confirm(`Remove ${ticker} from portfolio?`)) return
    await fetch('/api/portfolio/positions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker }),
    })
    await loadPositions()
    setPositionData(prev => prev.filter(p => p.ticker !== ticker))
    setChecks(prev => prev.filter(c => c.ticker !== ticker))
    // Also collapse the row if it was expanded
    setExpandedRows(prev => {
      const next = new Set(prev)
      next.delete(ticker)
      return next
    })
  }

  // -- Load dividends (preserved + receives linkedReinvestTrades from Part 1) --
  const loadDividends = useCallback(async () => {
    setLoadingDividends(true)
    try {
      const res = await fetch('/api/dividends')
      if (res.ok) {
        const data = await res.json()
        setDividends(data.dividends || [])
        setDivSchedule(data.schedule || [])
      }
    } finally {
      setLoadingDividends(false)
    }
  }, [])

  // -- Save dividend (preserved) --
  const saveDiv = async () => {
    if (!divTicker || !divAmount || !divShares || !divExDate) return
    setSavingDiv(true)
    const amountPerShare = parseFloat(divAmount)
    const shares = parseFloat(divShares)
    await fetch('/api/dividends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: divTicker.toUpperCase(),
        ex_date: divExDate,
        pay_date: divPayDate || null,
        amount_per_share: amountPerShare,
        shares_held: shares,
        total_received: amountPerShare * shares,
        reinvested: divReinvested,
        reinvest_shares: divReinvested && divReinvestShares ? parseFloat(divReinvestShares) : null,
        reinvest_price: divReinvested && divReinvestPrice ? parseFloat(divReinvestPrice) : null,
      }),
    })
    setDivTicker(''); setDivAmount(''); setDivShares(''); setDivExDate(''); setDivPayDate('')
    setDivReinvested(false); setDivReinvestShares(''); setDivReinvestPrice('')
    setShowLogDiv(false); setSavingDiv(false)
    await loadDividends()
  }

  // -- Delete dividend (preserved) --
  const deleteDiv = async (id: string) => {
    if (!confirm('Delete this dividend record?')) return
    await fetch('/api/dividends', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    await loadDividends()
  }

  // -- Load reinvest trades with live prices (preserved) --
  const loadReinvest = useCallback(async () => {
    setLoadingReinvest(true)
    try {
      const res = await fetch('/api/reinvestment/trades')
      if (res.ok) {
        const data = await res.json()
        const trades: ReinvestTrade[] = data.trades || data || []
        const enriched = await Promise.all(trades.map(async (t) => {
          try {
            const q = await fetch(`/api/ticker?ticker=${t.ticker}`)
            const qd = q.ok ? await q.json() : null
            const cpRaw = qd?.quote?.c || null
            const cp = cpRaw !== null ? parseFloat(cpRaw) : null
            const pnlVal = cp && t.shares ? (cp - t.entry_price) * t.shares : null
            const pPct = t.entry_price > 0 && cp ? ((cp - t.entry_price) / t.entry_price * 100) : null
            return { ...t, currentPrice: cp, pnl: pnlVal, pnlPct: pPct }
          } catch { return t }
        }))
        setReinvestTrades(enriched)
      }
    } finally {
      setLoadingReinvest(false)
    }
  }, [])

  // -- Add reinvest trade (preserved + Part 1 linkage) --
  const addReinvestTrade = async () => {
    if (!rTicker || !rShares || !rEntry) return
    setSavingReinvest(true)
    await fetch('/api/reinvestment/trades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: rTicker.toUpperCase(),
        shares: parseFloat(rShares),
        entry_price: parseFloat(rEntry),
        notes: rNotes || null,
        funded_by_dividend_id: rFundedByDividendId,   // ← Part 1 FK
      }),
    })
    setRTicker(''); setRShares(''); setREntry(''); setRNotes('')
    setRFundedByDividendId(null)
    setShowAddReinvest(false); setSavingReinvest(false)
    await loadReinvest()
    await loadDividends()  // Refresh so linkedReinvestTrades on dividends updates
  }

  // -- Delete reinvest (preserved) --
  const deleteReinvestTrade = async (id: string) => {
    if (!confirm('Delete this reinvestment trade?')) return
    await fetch(`/api/reinvestment/trades?id=${id}`, { method: 'DELETE' })
    await loadReinvest()
    await loadDividends()
  }

  // -- Load journal (preserved, used for read-only preview in expanded rows) --
  const loadJournal = useCallback(async () => {
    setLoadingJournal(true)
    try {
      const res = await fetch('/api/trade-journal')
      const data = await res.json()
      setJournalEntries(data.entries || [])
    } finally {
      setLoadingJournal(false)
    }
  }, [])

  // ── Initial load ────────────────────────────────────────────────
  useEffect(() => { loadPositions() }, [loadPositions])

  // Load realized P&L total (closed positions). Re-runs when a close happens.
  useEffect(() => {
    fetch('/api/portfolio/closed')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setRealizedPnlTotal(d.realized_pnl_total ?? 0) })
      .catch(() => {})
  }, [closedReloadKey])

  // Load dividends, reinvest, journal eagerly — they're now used by the
  // strips and per-position expansions, not gated by tab switch.
  useEffect(() => {
    loadDividends()
    loadReinvest()
    loadJournal()
  }, [loadDividends, loadReinvest, loadJournal])
  // ═════════════════════════════════════════════════════════════════
  // DERIVED METRICS (preserved + extended)
  // ═════════════════════════════════════════════════════════════════

  const totalValue = positionData.reduce((s, p) => s + p.marketValue, 0)
  const totalGainLoss = positionData.reduce((s, p) => s + (p.gainLoss ?? 0), 0)
  const totalCostBasis = positionData.reduce((s, p) => {
    if (p.avg_cost == null) return s
    return s + (p.avg_cost * p.shares)
  }, 0)
  const totalGainLossPct = totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0
  const dayChangeDollar = positionData.reduce((s, p) => {
    const prev = p.currentPrice / (1 + (p.priceChange1D / 100))
    return s + ((p.currentPrice - prev) * p.shares)
  }, 0)
  const dayChangePct = totalValue > 0 && (totalValue - dayChangeDollar) > 0
    ? (dayChangeDollar / (totalValue - dayChangeDollar)) * 100
    : 0

  const stockCount = positions.filter(p => p.position_type === 'stock').length
  const optionCount = positions.filter(p => p.position_type === 'option').length

  // ── Filter positions ─────────────────────────────────────────────
  const filteredPositions = useMemo(() => {
    if (positionFilter === 'all') return positions
    if (positionFilter === 'stocks') return positions.filter(p => p.position_type === 'stock')
    return positions.filter(p => p.position_type === 'option')
  }, [positions, positionFilter])

  // ── Sort ─────────────────────────────────────────────────────────
  const sortedPositions = useMemo(() => {
    return [...filteredPositions].sort((a, b) => {
      const aData = positionData.find(p => p.ticker === a.ticker)
      const bData = positionData.find(p => p.ticker === b.ticker)
      const mul = sortDir === 'asc' ? 1 : -1
      switch (sortKey) {
        case 'ticker': return a.ticker.localeCompare(b.ticker) * mul
        case 'value': return ((aData?.marketValue ?? 0) - (bData?.marketValue ?? 0)) * mul
        case 'day':   return ((aData?.priceChange1D ?? 0) - (bData?.priceChange1D ?? 0)) * mul
        case 'pnl':   return ((aData?.gainLossPct ?? 0) - (bData?.gainLossPct ?? 0)) * mul
        case 'alloc': return ((aData?.marketValue ?? 0) - (bData?.marketValue ?? 0)) * mul
        case 'signal': {
          const order: Record<string, number> = { BULLISH: 2, NEUTRAL: 1, BEARISH: 0 }
          return ((order[aData?.signal ?? ''] ?? -1) - (order[bData?.signal ?? ''] ?? -1)) * mul
        }
        default: return 0
      }
    })
  }, [filteredPositions, positionData, sortKey, sortDir])

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('desc') }
  }

  // ── Toggle row expansion ─────────────────────────────────────────
  const toggleRow = (ticker: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(ticker)) next.delete(ticker)
      else next.add(ticker)
      return next
    })
  }

  const expandAndScrollTo = (ticker: string) => {
    setExpandedRows(prev => new Set(prev).add(ticker))
    // Scroll to the row after a tick (let it render first)
    setTimeout(() => {
      const el = document.getElementById(`pos-row-${ticker}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 50)
  }

  // ═════════════════════════════════════════════════════════════════
  // ACTION REQUIRED — items needing attention now
  // ═════════════════════════════════════════════════════════════════

  const actionRequired = useMemo<ActionRequiredItem[]>(() => {
    const items: ActionRequiredItem[] = []

    // 1. Health check verdicts: TERMINAL, EXIT, WATCH (warning)
    for (const c of checks) {
      if (c.verdict === 'TERMINAL') {
        items.push({
          id: `terminal-${c.ticker}`,
          severity: 'critical',
          category: 'TERMINAL',
          ticker: c.ticker,
          primary: `${c.ticker} — ${c.terminalReason ?? c.reason ?? 'Position is mathematically over'}`,
          secondary: c.action,
          ctaLabel: 'Open',
          onClick: () => expandAndScrollTo(c.ticker),
        })
      } else if (c.verdict === 'EXIT') {
        items.push({
          id: `exit-${c.ticker}`,
          severity: 'critical',
          category: 'EXIT',
          ticker: c.ticker,
          primary: `${c.ticker} — Exit criteria met`,
          secondary: c.action,
          ctaLabel: 'Open',
          onClick: () => expandAndScrollTo(c.ticker),
        })
      } else if (c.verdict === 'WATCH') {
        items.push({
          id: `watch-${c.ticker}`,
          severity: 'warning',
          category: 'WATCH',
          ticker: c.ticker,
          primary: `${c.ticker} — Watch closely`,
          secondary: c.action,
          ctaLabel: 'Open',
          onClick: () => expandAndScrollTo(c.ticker),
        })
      }
    }

    // 2. Options expiring ≤ 2 calendar days (regardless of health-check verdict)
    for (const pos of positions) {
      if (pos.position_type !== 'option' || !pos.expiry) continue
      // Calendar-day count from today midnight ET to expiry midnight ET
      const [y, m, d] = pos.expiry.split('-').map(Number)
      if (!y || !m || !d) continue
      const expMidnightET = new Date(Date.UTC(y, m - 1, d, 4, 0, 0))
      const now = new Date()
      const todayMidnightET = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 0, 0))
      const todayAnchor = now.getTime() < todayMidnightET.getTime()
        ? new Date(todayMidnightET.getTime() - 86400000)
        : todayMidnightET
      const daysToExpiry = Math.round((expMidnightET.getTime() - todayAnchor.getTime()) / 86400000)
      if (daysToExpiry < 0 || daysToExpiry > 2) continue

      // Skip if already covered by TERMINAL/EXIT
      if (items.find(i => i.ticker === pos.ticker && (i.category === 'TERMINAL' || i.category === 'EXIT'))) continue

      const dayLabel = daysToExpiry === 0 ? 'today' : daysToExpiry === 1 ? 'tomorrow' : `${daysToExpiry}d`
      items.push({
        id: `expiring-${pos.ticker}`,
        severity: 'critical',
        category: 'EXPIRING',
        ticker: pos.ticker,
        primary: `${pos.ticker} ${pos.option_type?.toUpperCase()} $${pos.strike} expires ${dayLabel}`,
        secondary: `Decide today: close, roll, or let expire.`,
        ctaLabel: 'Open',
        onClick: () => expandAndScrollTo(pos.ticker),
      })
    }

    // 3. Stop-breached positions (from health checks)
    for (const c of checks) {
      if (c.pctFromStop !== null && c.pctFromStop !== undefined && c.pctFromStop < 0) {
        // Skip if already covered by TERMINAL/EXIT
        if (items.find(i => i.ticker === c.ticker && (i.category === 'TERMINAL' || i.category === 'EXIT'))) continue
        items.push({
          id: `stop-${c.ticker}`,
          severity: 'critical',
          category: 'STOP_BREACH',
          ticker: c.ticker,
          primary: `${c.ticker} — Stop loss breached`,
          secondary: `Current $${c.underlyingPrice} vs stop $${c.stopLoss}. ${Math.abs(c.pctFromStop).toFixed(1)}% past stop.`,
          ctaLabel: 'Open',
          onClick: () => expandAndScrollTo(c.ticker),
        })
      }
    }

    // 4. Unlogged dividends — schedule entries with ex_date in the past
    //    and no matching dividend in the user's dividends list
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    for (const sched of divSchedule) {
      const exDate = new Date(sched.ex_date)
      if (exDate.getTime() > today.getTime()) continue   // future, not unlogged
      // Match by ticker + ex_date (both stored as 'YYYY-MM-DD')
      const matched = dividends.find(d =>
        d.ticker === sched.ticker && d.ex_date === sched.ex_date
      )
      if (matched) continue

      // Days since ex-date
      const daysAgo = Math.floor((today.getTime() - exDate.getTime()) / 86400000)
      if (daysAgo > 30) continue   // very old, probably user doesn't care

      items.push({
        id: `unlogged-${sched.ticker}-${sched.ex_date}`,
        severity: 'warning',
        category: 'UNLOGGED_DIV',
        ticker: sched.ticker,
        primary: `${sched.ticker} dividend paid ${daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo}d ago`}${sched.amount ? ` ($${sched.amount.toFixed(2)}/sh)` : ''}`,
        secondary: 'Log to track yield and reinvestment opportunity.',
        ctaLabel: 'Log',
        onClick: () => {
          // Open the Log Dividend drawer prefilled with this ticker + ex-date
          setDivTicker(sched.ticker)
          setDivExDate(sched.ex_date)
          setDivPayDate(sched.pay_date || '')
          if (sched.amount) setDivAmount(String(sched.amount))
          // Try to prefill shares from the position
          const pos = positions.find(p => p.ticker === sched.ticker)
          if (pos && pos.position_type === 'stock') setDivShares(String(pos.shares))
          setShowLogDiv(true)
        },
      })
    }

    // Sort: critical first, then by ticker
    items.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1
      return a.ticker.localeCompare(b.ticker)
    })
    return items
  }, [checks, positions, divSchedule, dividends])

  // ═════════════════════════════════════════════════════════════════
  // RECENT ACTIVITY — informational items (FYI, not actionable)
  // ═════════════════════════════════════════════════════════════════

  const recentActivity = useMemo<RecentActivityItem[]>(() => {
    const items: RecentActivityItem[] = []
    const cutoffMs = Date.now() - recentActivityDays * 86400000

    // 1. Council history items (resolved + pending) — pulled from each PositionCheck
    for (const c of checks) {
      if (!c.councilHistory) continue
      const ch = c.councilHistory
      const verdictDate = new Date(Date.now() - ch.daysSinceVerdict * 86400000)
      if (verdictDate.getTime() < cutoffMs) continue

      if (ch.outcomeStatus === 'correct' || ch.outcomeStatus === 'incorrect') {
        items.push({
          id: `council-resolved-${c.ticker}`,
          category: 'COUNCIL_RESOLVED',
          ticker: c.ticker,
          primary: `${c.ticker} — Council was ${ch.outcomeStatus} ${ch.outcomeHorizon ?? ''}`.trim(),
          secondary: ch.alignmentNote,
          date: verdictDate,
          ctaLabel: 'View',
          onClick: () => expandAndScrollTo(c.ticker),
        })
      } else if (ch.outcomeStatus === 'pending' && ch.daysSinceVerdict >= 1) {
        items.push({
          id: `council-pending-${c.ticker}`,
          category: 'COUNCIL_PENDING',
          ticker: c.ticker,
          primary: `${c.ticker} — Council ${ch.recentSignal} from ${ch.daysSinceVerdict}d ago, outcome pending`,
          secondary: ch.alignmentNote,
          date: verdictDate,
          ctaLabel: 'View',
          onClick: () => expandAndScrollTo(c.ticker),
        })
      }
    }

    // 2. Reinvest trades opened/closed within window
    for (const t of reinvestTrades) {
      const openedAt = new Date(t.opened_at)
      if (openedAt.getTime() >= cutoffMs) {
        items.push({
          id: `reinvest-opened-${t.id}`,
          category: 'REINVEST_OPENED',
          ticker: t.ticker,
          primary: `${t.ticker} reinvest opened — ${t.shares} sh @ $${t.entry_price.toFixed(2)}`,
          secondary: t.pnl !== null && t.pnl !== undefined
            ? `Current P/L: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(0)}${t.pnlPct !== null && t.pnlPct !== undefined ? ` (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%)` : ''}`
            : undefined,
          date: openedAt,
        })
      }
      if (t.exit_date) {
        const closedAt = new Date(t.exit_date)
        if (closedAt.getTime() >= cutoffMs) {
          const pnl = t.exit_price ? (t.exit_price - t.entry_price) * t.shares : 0
          items.push({
            id: `reinvest-closed-${t.id}`,
            category: 'REINVEST_CLOSED',
            ticker: t.ticker,
            primary: `${t.ticker} reinvest closed — ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`,
            secondary: t.exit_price ? `Exit: $${t.exit_price.toFixed(2)} vs entry $${t.entry_price.toFixed(2)}` : undefined,
            date: closedAt,
          })
        }
      }
    }

    // 3. Dividends received within window
    for (const d of dividends) {
      const exDate = new Date(d.ex_date)
      if (exDate.getTime() < cutoffMs) continue
      items.push({
        id: `div-${d.id}`,
        category: 'DIV_RECEIVED',
        ticker: d.ticker,
        primary: `${d.ticker} dividend received — $${d.total_received.toFixed(2)}${d.reinvested ? ' (reinvested)' : ''}`,
        secondary: `${d.shares_held} sh × $${d.amount_per_share.toFixed(4)}/sh`,
        date: exDate,
        ctaLabel: 'View',
        onClick: () => expandAndScrollTo(d.ticker),
      })
    }

    // Sort by date descending
    items.sort((a, b) => b.date.getTime() - a.date.getTime())
    return items
  }, [checks, reinvestTrades, dividends, recentActivityDays])
  // ═════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>

      {/* ─── Header ─── */}
      <header className="flex items-center gap-3 px-6 py-3 border-b sticky top-0 z-20"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <button onClick={() => router.push('/')}
          className="flex items-center gap-1.5 text-xs hover:opacity-80 transition-opacity"
          style={{ color: 'var(--text3)' }}
          aria-label="Back to dashboard">
          <ArrowLeft size={13} /> <span className="hidden sm:inline">Back</span>
        </button>
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        <Briefcase size={14} style={{ color: ACCENT }} />
        <span className="text-sm font-bold">Portfolio</span>
        {positions.length > 0 && (
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
            style={{ background: 'rgba(167,139,250,0.12)', color: ACCENT, border: '1px solid rgba(167,139,250,0.2)' }}>
            {positions.length} {positions.length === 1 ? 'position' : 'positions'}
            {stockCount > 0 && optionCount > 0 && (
              <span style={{ color: 'var(--text3)' }}> · {stockCount}s/{optionCount}o</span>
            )}
          </span>
        )}

        {/* Action buttons (preserved) */}
        <div className="ml-auto flex items-center gap-2">
          {positions.length > 0 && (
            <>
              {cachedAge !== null && !analyzing && (
                <span className="text-[10px] hidden md:inline" style={{ color: 'var(--text3)' }}>
                  {cachedAge === 0 ? 'just analyzed' : `${cachedAge < 60 ? `${cachedAge}m` : `${Math.round(cachedAge / 60)}h`} old`}
                </span>
              )}
              <button onClick={() => runHealthCheck()} disabled={checking || positions.length === 0}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-40"
                style={{ background: 'rgba(248,113,113,0.1)', color: DN, border: '1px solid rgba(248,113,113,0.22)' }}
                aria-label="Run health check on all positions">
                {checking && !checkTicker ? (
                  <div className="w-3 h-3 rounded-full border border-t-transparent animate-spin" style={{ borderColor: DN, borderTopColor: 'transparent' }} />
                ) : <Stethoscope size={12} />}
                <span>{checking && !checkTicker ? 'Checking...' : 'Check'}</span>
              </button>
              <button onClick={() => runAnalysis(true)} disabled={analyzing}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-40"
                style={{ background: 'rgba(167,139,250,0.15)', color: ACCENT, border: '1px solid rgba(167,139,250,0.28)' }}
                aria-label={analyzing ? 'Analyzing portfolio' : 'Run portfolio analysis'}>
                <RefreshCw size={12} className={analyzing ? 'animate-spin' : ''} />
                <span>{analyzing ? 'Analyzing...' : cachedAge !== null ? 'Re-analyze' : 'Analyze'}</span>
              </button>
            </>
          )}
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ background: ACCENT, color: '#0a0d12' }}
            aria-label="Add position">
            <Plus size={12} />
            <span>Add</span>
          </button>
          <button onClick={() => router.push('/journal')}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'var(--surface2)', color: 'var(--text2)', border: '1px solid var(--border)' }}
            aria-label="Open Journal">
            <BookOpen size={12} /> <span className="hidden sm:inline">Journal</span>
            <ExternalLink size={10} style={{ opacity: 0.5 }} />
          </button>
          <button onClick={() => setShowSettings(true)}
            className="p-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ color: 'var(--text3)' }}
            aria-label="Settings">
            <Settings size={14} />
          </button>
        </div>
      </header>

      {/* ─── Hero strip — portfolio totals (preserved) ─── */}
      {positions.length > 0 && (
        <div className="border-b px-6 py-5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-6">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: 'var(--text3)' }}>
                Portfolio value
              </div>
              <div className="text-2xl md:text-3xl font-bold font-mono tabular-nums" style={{ color: 'var(--text)' }}>
                ${fmt(totalValue)}
              </div>
              {cachedAge !== null && (
                <div className="text-[10px] font-mono mt-1" style={{ color: 'var(--text3)' }}>
                  <Clock size={9} className="inline mr-1" style={{ verticalAlign: 'middle' }} />
                  {cachedAge === 0 ? 'Live' : `as of ${cachedAge < 60 ? `${cachedAge}m` : `${Math.round(cachedAge / 60)}h`} ago`}
                </div>
              )}
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: 'var(--text3)' }}>
                Day change
              </div>
              <div className="text-2xl md:text-3xl font-bold font-mono tabular-nums" style={{ color: pnlColor(dayChangeDollar) }}>
                {dayChangeDollar >= 0 ? '+' : ''}${fmt(Math.abs(dayChangeDollar))}
              </div>
              <div className="text-xs font-mono mt-1 flex items-center gap-1" style={{ color: pnlColor(dayChangeDollar) }}>
                {dayChangeDollar >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                {pct(dayChangePct)} today
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: 'var(--text3)' }}>
                Total P/L
              </div>
              <div className="text-2xl md:text-3xl font-bold font-mono tabular-nums" style={{ color: pnlColor(totalGainLoss) }}>
                {totalGainLoss >= 0 ? '+' : ''}${fmt(Math.abs(totalGainLoss))}
              </div>
              <div className="text-xs font-mono mt-1" style={{ color: pnlColor(totalGainLoss) }}>
                {pct(totalGainLossPct)} all-time
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: 'var(--text3)' }}>
                Realized P/L
              </div>
              <div className="text-2xl md:text-3xl font-bold font-mono tabular-nums" style={{ color: pnlColor(realizedPnlTotal) }}>
                {realizedPnlTotal >= 0 ? '+' : ''}${fmt(Math.abs(realizedPnlTotal))}
              </div>
              <button
                onClick={() => setShowClosed(s => !s)}
                className="text-[10px] font-mono mt-1 transition-opacity hover:opacity-80"
                style={{ color: 'var(--text3)' }}
              >
                {showClosed ? 'hide closed positions' : 'view closed positions'}
              </button>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: 'var(--text3)' }}>
                Positions
              </div>
              <div className="text-2xl md:text-3xl font-bold font-mono tabular-nums" style={{ color: 'var(--text)' }}>
                {positions.length}
              </div>
              <div className="text-xs font-mono mt-1" style={{ color: 'var(--text3)' }}>
                {stockCount} stock{stockCount === 1 ? '' : 's'} · {optionCount} option{optionCount === 1 ? '' : 's'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Main content ─── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1400px] mx-auto px-6 py-5">

          {/* ─── Analyzing status ─── */}
          {analyzing && (
            <div className="flex items-center gap-3 px-5 py-4 rounded-xl mb-4"
              style={{ background: 'rgba(167,139,250,0.05)', border: '1px solid rgba(167,139,250,0.18)' }}>
              <div className="flex gap-1">
                {[0, 1, 2].map(i => <span key={i} className="w-1.5 h-1.5 rounded-full thinking-dot" style={{ background: ACCENT, animationDelay: `${i * 0.15}s` }} />)}
              </div>
              <span className="text-sm font-mono" style={{ color: 'var(--text2)' }}>{statusMsg}</span>
            </div>
          )}

          {/* ─── Action Required strip ─── */}
          {actionRequired.length > 0 && (
            <div className="mb-5 rounded-xl border overflow-hidden"
              style={{
                background: 'var(--surface)',
                borderColor: actionRequired.some(i => i.severity === 'critical')
                  ? 'rgba(248,113,113,0.3)'
                  : 'rgba(251,191,36,0.25)',
              }}>
              <button onClick={() => setActionRequiredCollapsed(c => !c)}
                className="w-full flex items-center gap-2 px-4 py-2.5 hover:opacity-90 transition-opacity"
                style={{ background: 'rgba(248,113,113,0.06)', borderBottom: actionRequiredCollapsed ? 'none' : '1px solid var(--border)' }}>
                <AlertTriangle size={13} style={{ color: actionRequired.some(i => i.severity === 'critical') ? DN : FLAT }} />
                <span className="text-[11px] font-mono uppercase tracking-widest font-bold"
                  style={{ color: actionRequired.some(i => i.severity === 'critical') ? DN : FLAT }}>
                  Action Required ({actionRequired.length})
                </span>
                <span className="ml-auto text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                  {actionRequiredCollapsed ? 'Show' : 'Collapse'}
                </span>
                {actionRequiredCollapsed
                  ? <ChevronRight size={12} style={{ color: 'var(--text3)' }} />
                  : <ChevronDown size={12} style={{ color: 'var(--text3)' }} />}
              </button>
              {!actionRequiredCollapsed && (
                <div>
                  {actionRequired.map(item => {
                    const accentColor = item.severity === 'critical' ? DN : FLAT
                    const bgColor = item.category === 'TERMINAL' ? 'rgba(220,38,38,0.08)' : undefined
                    return (
                      <div key={item.id}
                        className="flex items-center gap-3 px-4 py-2.5 border-b last:border-b-0"
                        style={{ borderColor: 'var(--border)', background: bgColor }}>
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded font-bold min-w-[68px] text-center"
                          style={{
                            background: item.category === 'TERMINAL' ? `${TERMINAL_RED}30` : `${accentColor}18`,
                            color: item.category === 'TERMINAL' ? TERMINAL_RED : accentColor,
                          }}>
                          {item.category.replace('_', ' ')}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold truncate" style={{ color: 'var(--text)' }}>
                            {item.primary}
                          </div>
                          {item.secondary && (
                            <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text2)' }}>
                              → {item.secondary}
                            </div>
                          )}
                        </div>
                        <button onClick={item.onClick}
                          className="shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-lg hover:opacity-80 transition-opacity"
                          style={{ background: `${accentColor}15`, color: accentColor, border: `1px solid ${accentColor}30` }}>
                          {item.ctaLabel}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* ─── Recent Activity strip ─── */}
          {recentActivity.length > 0 && (
            <div className="mb-5 rounded-xl border overflow-hidden"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <button onClick={() => setRecentActivityCollapsed(c => !c)}
                className="w-full flex items-center gap-2 px-4 py-2.5 hover:opacity-90 transition-opacity"
                style={{ borderBottom: recentActivityCollapsed ? 'none' : '1px solid var(--border)' }}>
                <Activity size={13} style={{ color: '#60a5fa' }} />
                <span className="text-[11px] font-mono uppercase tracking-widest font-bold" style={{ color: '#60a5fa' }}>
                  Recent Activity ({recentActivity.length})
                </span>
                <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                  · last {recentActivityDays}d
                </span>
                <span className="ml-auto text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                  {recentActivityCollapsed ? 'Show' : 'Collapse'}
                </span>
                {recentActivityCollapsed
                  ? <ChevronRight size={12} style={{ color: 'var(--text3)' }} />
                  : <ChevronDown size={12} style={{ color: 'var(--text3)' }} />}
              </button>
              {!recentActivityCollapsed && (
                <div>
                  {recentActivity.slice(0, 12).map(item => {
                    const catColor = item.category === 'COUNCIL_RESOLVED' ? UP
                      : item.category === 'COUNCIL_PENDING' ? FLAT
                      : item.category === 'REINVEST_OPENED' ? '#60a5fa'
                      : item.category === 'REINVEST_CLOSED' ? ACCENT
                      : UP
                    const catLabel = item.category === 'COUNCIL_RESOLVED' ? 'COUNCIL'
                      : item.category === 'COUNCIL_PENDING' ? 'PENDING'
                      : item.category === 'REINVEST_OPENED' ? 'REINVEST'
                      : item.category === 'REINVEST_CLOSED' ? 'CLOSED'
                      : 'DIV'
                    const ageMs = Date.now() - item.date.getTime()
                    const ageLabel = ageMs < 86400000
                      ? 'today'
                      : `${Math.floor(ageMs / 86400000)}d`

                    return (
                      <div key={item.id}
                        className="flex items-center gap-3 px-4 py-2 border-b last:border-b-0"
                        style={{ borderColor: 'var(--border)' }}>
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded font-bold min-w-[68px] text-center"
                          style={{ background: `${catColor}15`, color: catColor }}>
                          {catLabel}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] font-semibold truncate" style={{ color: 'var(--text)' }}>
                            {item.primary}
                          </div>
                          {item.secondary && (
                            <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text3)' }}>
                              {item.secondary}
                            </div>
                          )}
                        </div>
                        <span className="shrink-0 text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                          {ageLabel}
                        </span>
                        {item.onClick && (
                          <button onClick={item.onClick}
                            className="shrink-0 text-[10px] font-semibold px-2 py-1 rounded-lg hover:opacity-80 transition-opacity"
                            style={{ background: 'var(--surface2)', color: 'var(--text2)' }}>
                            {item.ctaLabel ?? 'View'}
                          </button>
                        )}
                      </div>
                    )
                  })}
                  {recentActivity.length > 12 && (
                    <div className="px-4 py-2 text-center text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                      + {recentActivity.length - 12} more (adjust window in settings)
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ─── Empty state ─── */}
          {!loadingHoldings && positions.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
              <div className="p-4 rounded-full" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <Briefcase size={32} style={{ color: 'var(--text3)' }} />
              </div>
              <div className="text-lg font-bold" style={{ color: 'var(--text)' }}>No positions yet</div>
              <p className="text-sm max-w-sm" style={{ color: 'var(--text2)' }}>
                Add your holdings to get AI portfolio analysis — concentration risk, earnings events, and rebalancing suggestions.
              </p>
              <button onClick={() => setShowAdd(true)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold mt-2 transition-all hover:opacity-90"
                style={{ background: ACCENT, color: '#0a0d12' }}>
                <Plus size={14} /> Add your first position
              </button>
            </div>
          )}

          {/* ─── Single-position notice (improvement #2) ─── */}
          {positions.length === 1 && analysis && (
            <div className="mb-4 rounded-xl px-4 py-3"
              style={{ background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.2)' }}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[9px] font-mono uppercase tracking-widest font-bold" style={{ color: '#60a5fa' }}>
                  Portfolio analysis paused
                </span>
              </div>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>
                With one position, holistic portfolio analysis (sector concentration, correlation, rebalancing) doesn&apos;t produce useful output. The Position Health Check below is the relevant signal. Add 2+ holdings to enable real portfolio analysis.
              </p>
            </div>
          )}

          {/* ─── Filter + sort bar ─── */}
          {positions.length > 0 && (
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text3)' }}>Filter:</span>
              {(['all', 'stocks', 'options'] as const).map(f => (
                <button key={f} onClick={() => setPositionFilter(f)}
                  className="text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded-lg transition-all hover:opacity-80"
                  style={{
                    background: positionFilter === f ? `${ACCENT}18` : 'var(--surface2)',
                    color: positionFilter === f ? ACCENT : 'var(--text3)',
                    border: `1px solid ${positionFilter === f ? `${ACCENT}30` : 'transparent'}`,
                  }}>
                  {f}
                </button>
              ))}
              <span className="ml-4 text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text3)' }}>Sort:</span>
              {([
                { k: 'value' as SortKey, label: 'Value' },
                { k: 'day' as SortKey, label: 'Day' },
                { k: 'pnl' as SortKey, label: 'P/L' },
                { k: 'ticker' as SortKey, label: 'Ticker' },
                { k: 'signal' as SortKey, label: 'Signal' },
              ]).map(s => (
                <button key={s.k} onClick={() => toggleSort(s.k)}
                  className="text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded-lg transition-all hover:opacity-80"
                  style={{
                    background: sortKey === s.k ? `${ACCENT}18` : 'var(--surface2)',
                    color: sortKey === s.k ? ACCENT : 'var(--text3)',
                    border: `1px solid ${sortKey === s.k ? `${ACCENT}30` : 'transparent'}`,
                  }}>
                  {s.label} {sortKey === s.k && (sortDir === 'desc' ? '↓' : '↑')}
                </button>
              ))}
            </div>
          )}
          {/* ─── Position rows ─── */}
          {positions.length > 0 && (
            <div className="space-y-2">
              {sortedPositions.map(pos => {
                const data = positionData.find(p => p.ticker === pos.ticker)
                const check = checks.find(c => c.ticker === pos.ticker)
                const isOption = pos.position_type === 'option'
                const isExpanded = expandedRows.has(pos.ticker)
                const allocPct = totalValue > 0 && data ? (data.marketValue / totalValue * 100) : 0

                // Per-position dividends/reinvest/journal (filtered)
                const posDivs = dividends.filter(d => d.ticker === pos.ticker)
                const posReinvest = reinvestTrades.filter(t => t.ticker === pos.ticker)
                const posJournal = journalEntries.filter(j => j.ticker === pos.ticker)
                const posSchedule = divSchedule.filter(s => s.ticker === pos.ticker)

                // Verdict styling
                const verdictColor = check ? VERDICT_COLOR[check.verdict] : 'var(--text3)'
                const verdictBg = check ? VERDICT_BG[check.verdict] : 'var(--surface)'

                return (
                  <div key={pos.ticker} id={`pos-row-${pos.ticker}`}
                    className="rounded-xl border overflow-hidden transition-all"
                    style={{
                      background: isExpanded ? 'var(--surface)' : verdictBg,
                      borderColor: isExpanded
                        ? `${ACCENT}40`
                        : (check ? `${verdictColor}${check.verdict === 'TERMINAL' ? '55' : '22'}` : 'var(--border)'),
                    }}>

                    {/* ─── Collapsed/header row (always visible) ─── */}
                    <button onClick={() => toggleRow(pos.ticker)}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:opacity-95 transition-opacity text-left">
                      {/* Verdict badge */}
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg min-w-[68px] text-center font-mono"
                        style={{
                          background: check
                            ? `${verdictColor}${check.verdict === 'TERMINAL' ? '30' : '18'}`
                            : 'var(--surface2)',
                          color: check ? verdictColor : 'var(--text3)',
                        }}>
                        {check?.verdict ?? '— — —'}
                      </span>

                      {/* Ticker + position details */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold font-mono text-sm">{pos.ticker}</span>
                          {isOption && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded font-bold"
                              style={{
                                background: pos.option_type === 'call' ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
                                color: pos.option_type === 'call' ? UP : DN,
                              }}>
                              {pos.option_type?.toUpperCase()} ${pos.strike} {pos.expiry?.slice(5)}
                            </span>
                          )}
                          <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                            {isOption
                              ? `${pos.contracts ?? 1}x`
                              : `${pos.shares} sh`}
                          </span>
                          {data && (
                            <>
                              <span className="text-[11px] font-mono tabular-nums" style={{ color: 'var(--text2)' }}>
                                ${data.currentPrice.toFixed(2)}
                              </span>
                              <span className="text-[10px] font-mono tabular-nums" style={{ color: pnlColor(data.priceChange1D) }}>
                                {data.priceChange1D >= 0 ? '+' : ''}{data.priceChange1D.toFixed(2)}%
                              </span>
                            </>
                          )}
                        </div>
                        {/* Subtitle row — sector / allocation / option deadline */}
                        <div className="flex items-center gap-2 mt-1 flex-wrap text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                          {data?.sector && data.sector !== 'Unknown' && (
                            <span>{data.sector}</span>
                          )}
                          {totalValue > 0 && data && (
                            <span>· {allocPct.toFixed(1)}% alloc</span>
                          )}
                          {check?.deadlineLabel && (
                            <span style={{ color: check.timeDecayUrgent ? DN : 'var(--text3)' }}>
                              · {check.deadlineLabel}
                            </span>
                          )}
                          {posDivs.length > 0 && (
                            <span>· {posDivs.length} div{posDivs.length === 1 ? '' : 's'}</span>
                          )}
                          {posReinvest.filter(t => !t.exit_price).length > 0 && (
                            <span style={{ color: ACCENT }}>· {posReinvest.filter(t => !t.exit_price).length} reinvest open</span>
                          )}
                        </div>
                      </div>

                      {/* P/L + value */}
                      {data && (
                        <div className="text-right shrink-0 hidden sm:block">
                          <div className="text-sm font-mono font-bold tabular-nums" style={{ color: 'var(--text)' }}>
                            ${fmt(data.marketValue)}
                          </div>
                          {data.gainLossPct !== null && (
                            <div className="text-[10px] font-mono tabular-nums" style={{ color: pnlColor(data.gainLossPct) }}>
                              {data.gainLossPct >= 0 ? '+' : ''}{data.gainLossPct.toFixed(1)}% P/L
                            </div>
                          )}
                        </div>
                      )}

                      {/* Expand icon */}
                      <span className="shrink-0" style={{ color: 'var(--text3)' }}>
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </span>
                    </button>

                    {/* ─── Expanded body — 6 sub-sections ─── */}
                    {isExpanded && (
                      <div className="border-t" style={{ borderColor: 'var(--border)' }}>

                        {/* ── Section 1: Health Check ── */}
                        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                          <div className="flex items-center gap-1.5 mb-2">
                            <Stethoscope size={11} style={{ color: 'var(--text3)' }} />
                            <span className="text-[10px] font-mono uppercase tracking-widest font-bold" style={{ color: 'var(--text3)' }}>
                              Health Check
                            </span>
                            {!check && (
                              <button onClick={(e) => { e.stopPropagation(); runHealthCheck(pos.ticker) }}
                                disabled={checkTicker === pos.ticker}
                                className="ml-auto flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg hover:opacity-80 disabled:opacity-40 transition-opacity"
                                style={{ background: 'rgba(248,113,113,0.1)', color: DN, border: '1px solid rgba(248,113,113,0.22)' }}>
                                {checkTicker === pos.ticker ? 'Checking...' : 'Run check'}
                              </button>
                            )}
                            {check && check.verdict !== 'TERMINAL' && (
                              <button onClick={(e) => { e.stopPropagation(); runHealthCheck(pos.ticker) }}
                                disabled={checkTicker === pos.ticker}
                                className="ml-auto p-1 rounded hover:opacity-80 transition-opacity"
                                style={{ color: 'var(--text3)' }}
                                aria-label="Re-check">
                                {checkTicker === pos.ticker
                                  ? <div className="w-3 h-3 rounded-full border border-t-transparent animate-spin" style={{ borderColor: 'var(--text3)', borderTopColor: 'transparent' }} />
                                  : <RefreshCw size={11} />}
                              </button>
                            )}
                          </div>

                          {check ? (
                            <div className="space-y-2">
                              {/* Reason */}
                              {check.reason && (
                                <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text2)' }}>
                                  {check.reason}
                                </p>
                              )}
                              {/* Action */}
                              <p className="text-[11px] font-semibold leading-relaxed" style={{ color: verdictColor }}>
                                → {check.action}
                              </p>

                              {/* Save path (if present) */}
                              {check.savePathSummary && (
                                <div className="rounded-lg px-2.5 py-2"
                                  style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}>
                                  <div className="flex items-center gap-1.5 mb-1">
                                    <span className="text-[8px] font-mono uppercase tracking-wider font-bold" style={{ color: 'var(--text3)' }}>
                                      Path to recovery
                                    </span>
                                    {check.savePathProbabilityVerbal && (
                                      <span className="text-[8px] font-mono px-1 py-0.5 rounded font-bold"
                                        style={{
                                          background: check.savePathProbabilityVerbal === 'likely' ? 'rgba(52,211,153,0.15)'
                                            : check.savePathProbabilityVerbal === 'plausible' ? 'rgba(251,191,36,0.15)'
                                            : 'rgba(248,113,113,0.15)',
                                          color: check.savePathProbabilityVerbal === 'likely' ? UP
                                            : check.savePathProbabilityVerbal === 'plausible' ? FLAT
                                            : DN,
                                        }}>
                                        {check.savePathProbabilityVerbal} {check.savePathProbabilityNumeric ? `(${check.savePathProbabilityNumeric})` : ''}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[10px] leading-snug" style={{ color: 'var(--text2)' }}>
                                    {check.savePathSummary}
                                  </p>
                                </div>
                              )}

                              {/* Realistic proceeds */}
                              {check.realisticProceedsNote && (
                                <div className="rounded-lg px-2.5 py-2"
                                  style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}>
                                  <div className="text-[8px] font-mono uppercase tracking-wider font-bold mb-1" style={{ color: 'var(--text3)' }}>
                                    Realistic close proceeds
                                  </div>
                                  <p className="text-[10px] leading-snug" style={{ color: 'var(--text2)' }}>
                                    {check.realisticProceedsNote}
                                  </p>
                                </div>
                              )}

                              {/* Exposure strip */}
                              {check.directionalExposure !== null && check.directionalExposure !== undefined && (
                                <div className="flex items-center gap-3 px-2.5 py-1.5 rounded-lg"
                                  style={{ background: 'var(--surface2)' }}>
                                  <span className="text-[9px] font-mono uppercase tracking-wider" style={{ color: 'var(--text3)' }}>Exposure</span>
                                  <span className="text-[10px] font-mono font-bold"
                                    style={{ color: check.directionalExposure > 0 ? UP : check.directionalExposure < 0 ? DN : 'var(--text3)' }}>
                                    {check.directionalExposure > 0 ? '+' : ''}${Math.abs(check.directionalExposure).toFixed(0)} {check.directionalExposure > 0 ? 'long' : check.directionalExposure < 0 ? 'short' : 'flat'}
                                  </span>
                                  {check.capitalAtRisk !== null && check.capitalAtRisk !== undefined && (
                                    <>
                                      <span className="text-[9px] font-mono" style={{ color: 'var(--text3)' }}>·</span>
                                      <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                                        ${check.capitalAtRisk.toFixed(0)} at risk
                                      </span>
                                    </>
                                  )}
                                </div>
                              )}

                              {/* Flags (collapsed) */}
                              {check.flags.length > 0 && (
                                <details {...(check.verdict === 'TERMINAL' ? { open: true } : {})}>
                                  <summary className="text-[9px] font-mono uppercase tracking-wider cursor-pointer hover:opacity-80"
                                    style={{ color: 'var(--text3)' }}>
                                    {check.flags.length} flag{check.flags.length === 1 ? '' : 's'} {check.verdict === 'TERMINAL' ? '' : '(click to expand)'}
                                  </summary>
                                  <div className="flex flex-wrap gap-1 mt-1.5">
                                    {check.flags.map(f => (
                                      <span key={f} className="text-[9px] px-1.5 py-0.5 rounded-full font-mono"
                                        style={{ background: 'var(--surface2)', color: 'var(--text3)', border: '1px solid var(--border)' }}>
                                        {f}
                                      </span>
                                    ))}
                                  </div>
                                </details>
                              )}
                            </div>
                          ) : (
                            <p className="text-[11px]" style={{ color: 'var(--text3)' }}>
                              No health check yet. Run one to see the verdict, save path, and realistic close proceeds.
                            </p>
                          )}
                        </div>

                        {/* ── Section 2: Council History ── */}
                        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                          <div className="flex items-center gap-1.5 mb-2">
                            <Star size={11} style={{ color: 'var(--text3)' }} />
                            <span className="text-[10px] font-mono uppercase tracking-widest font-bold" style={{ color: 'var(--text3)' }}>
                              Council History
                            </span>
                            <button onClick={(e) => { e.stopPropagation(); router.push(`/?ticker=${pos.ticker}`) }}
                              className="ml-auto flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg hover:opacity-80 transition-opacity"
                              style={{ background: 'rgba(167,139,250,0.1)', color: ACCENT, border: '1px solid rgba(167,139,250,0.22)' }}>
                              <Activity size={10} /> Run Council
                            </button>
                          </div>
                          {check?.councilHistory ? (
                            <div className="rounded-lg px-2.5 py-2"
                              style={{
                                background: check.councilHistory.positionContradictsCouncil
                                  ? 'rgba(251,191,36,0.08)'
                                  : 'rgba(96,165,250,0.06)',
                                border: `1px solid ${check.councilHistory.positionContradictsCouncil ? 'rgba(251,191,36,0.25)' : 'rgba(96,165,250,0.18)'}`,
                              }}>
                              <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded font-bold"
                                  style={{
                                    background: check.councilHistory.recentSignal === 'BULLISH' ? 'rgba(52,211,153,0.15)'
                                      : check.councilHistory.recentSignal === 'BEARISH' ? 'rgba(248,113,113,0.15)'
                                      : 'rgba(251,191,36,0.15)',
                                    color: check.councilHistory.recentSignal === 'BULLISH' ? UP
                                      : check.councilHistory.recentSignal === 'BEARISH' ? DN
                                      : FLAT,
                                  }}>
                                  {check.councilHistory.recentSignal} {check.councilHistory.recentConfidence !== null ? `${check.councilHistory.recentConfidence}%` : ''}
                                </span>
                                <span className="text-[9px] font-mono" style={{ color: 'var(--text3)' }}>
                                  {check.councilHistory.daysSinceVerdict}d ago
                                </span>
                                {check.councilHistory.recentPersona && (
                                  <span className="text-[9px] font-mono" style={{ color: 'var(--text3)' }}>
                                    · {check.councilHistory.recentPersona}
                                  </span>
                                )}
                                {check.councilHistory.outcomeStatus !== 'unknown' && (
                                  <span className="text-[9px] font-mono px-1 py-0.5 rounded ml-auto"
                                    style={{
                                      background: check.councilHistory.outcomeStatus === 'correct' ? 'rgba(52,211,153,0.15)'
                                        : check.councilHistory.outcomeStatus === 'incorrect' ? 'rgba(248,113,113,0.15)'
                                        : 'var(--surface2)',
                                      color: check.councilHistory.outcomeStatus === 'correct' ? UP
                                        : check.councilHistory.outcomeStatus === 'incorrect' ? DN
                                        : 'var(--text3)',
                                    }}>
                                    {check.councilHistory.outcomeStatus} {check.councilHistory.outcomeHorizon ?? ''}
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] leading-snug" style={{ color: 'var(--text2)' }}>
                                {check.councilHistory.alignmentNote}
                              </p>
                              {check.councilHistory.personaDisagreement && (
                                <p className="text-[10px] leading-snug mt-1 italic" style={{ color: 'var(--text3)' }}>
                                  {check.councilHistory.personaDisagreement}
                                </p>
                              )}
                            </div>
                          ) : (
                            <p className="text-[11px]" style={{ color: 'var(--text3)' }}>
                              No recent Council verdict. Run one to log a directional call you can later check against outcomes.
                            </p>
                          )}
                        </div>

                        {/* ── Section 3: Dividends ── */}
                        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                          <div className="flex items-center gap-1.5 mb-2">
                            <DollarSign size={11} style={{ color: 'var(--text3)' }} />
                            <span className="text-[10px] font-mono uppercase tracking-widest font-bold" style={{ color: 'var(--text3)' }}>
                              Dividends {posDivs.length > 0 && `(${posDivs.length})`}
                            </span>
                            <span className="text-[10px] font-mono ml-2" style={{ color: UP }}>
                              {posDivs.length > 0 && `$${posDivs.reduce((s, d) => s + d.total_received, 0).toFixed(2)} received`}
                            </span>
                            <button onClick={(e) => {
                              e.stopPropagation()
                              setDivTicker(pos.ticker)
                              if (!isOption) setDivShares(String(pos.shares))
                              setShowLogDiv(true)
                            }}
                              className="ml-auto flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg hover:opacity-80 transition-opacity"
                              style={{ background: 'rgba(52,211,153,0.1)', color: UP, border: '1px solid rgba(52,211,153,0.22)' }}>
                              <Plus size={10} /> Log dividend
                            </button>
                          </div>

                          {posDivs.length === 0 ? (
                            <p className="text-[11px]" style={{ color: 'var(--text3)' }}>
                              No dividends logged for {pos.ticker}.
                              {posSchedule.length > 0 && ` Next ex-date: ${posSchedule[0].ex_date}${posSchedule[0].amount ? ` ($${posSchedule[0].amount.toFixed(2)}/sh)` : ''}.`}
                            </p>
                          ) : (
                            <div className="space-y-1.5">
                              {posDivs.slice(0, 6).map(d => (
                                <div key={d.id} className="rounded-lg px-2.5 py-1.5"
                                  style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>{d.ex_date}</span>
                                    <span className="text-[10px] font-mono tabular-nums font-semibold" style={{ color: UP }}>
                                      ${d.total_received.toFixed(2)}
                                    </span>
                                    <span className="text-[9px] font-mono" style={{ color: 'var(--text3)' }}>
                                      ${d.amount_per_share.toFixed(4)}/sh × {d.shares_held}
                                    </span>
                                    {d.reinvested && (
                                      <span className="text-[9px] px-1 py-0.5 rounded font-mono font-bold"
                                        style={{ background: 'rgba(167,139,250,0.12)', color: ACCENT }}>
                                        DRIP
                                      </span>
                                    )}
                                    <button onClick={(e) => {
                                      e.stopPropagation()
                                      // Open Add-Reinvest drawer with funded_by_dividend_id prefilled
                                      setRTicker('')
                                      setRShares('')
                                      setREntry('')
                                      setRNotes(`Funded by ${d.ticker} dividend from ${d.ex_date}`)
                                      setRFundedByDividendId(d.id)
                                      setShowAddReinvest(true)
                                    }}
                                      className="ml-auto text-[9px] font-semibold px-1.5 py-0.5 rounded hover:opacity-80 transition-opacity"
                                      style={{ background: 'rgba(167,139,250,0.1)', color: ACCENT }}>
                                      Reinvest →
                                    </button>
                                    <button onClick={(e) => { e.stopPropagation(); deleteDiv(d.id) }}
                                      className="p-1 rounded hover:opacity-80"
                                      style={{ color: DN }}
                                      aria-label="Delete dividend">
                                      <Trash2 size={10} />
                                    </button>
                                  </div>
                                  {/* Linked reinvest trades from Part 1 */}
                                  {d.linkedReinvestTrades && d.linkedReinvestTrades.length > 0 && (
                                    <div className="mt-1.5 pl-3 border-l-2" style={{ borderColor: ACCENT }}>
                                      {d.linkedReinvestTrades.map(t => (
                                        <div key={t.id} className="text-[9px] font-mono" style={{ color: 'var(--text3)' }}>
                                          → funded {t.ticker} reinvest: {t.shares} sh @ ${t.entry_price.toFixed(2)}
                                          {t.exit_price ? ` (closed @ $${t.exit_price.toFixed(2)})` : ' (open)'}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                              {posDivs.length > 6 && (
                                <p className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                                  + {posDivs.length - 6} older dividends
                                </p>
                              )}
                            </div>
                          )}
                          {/* Schedule preview */}
                          {posSchedule.length > 0 && (
                            <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                              <div className="text-[9px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>
                                Upcoming
                              </div>
                              {posSchedule.slice(0, 3).map((s, i) => (
                                <div key={i} className="text-[10px] font-mono flex items-center gap-2" style={{ color: 'var(--text2)' }}>
                                  <Calendar size={9} style={{ color: 'var(--text3)' }} />
                                  <span>{s.ex_date}</span>
                                  {s.amount && <span style={{ color: UP }}>${s.amount.toFixed(2)}/sh</span>}
                                  {s.frequency && <span style={{ color: 'var(--text3)' }}>· {s.frequency}</span>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* ── Section 4: Reinvest trades ── */}
                        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                          <div className="flex items-center gap-1.5 mb-2">
                            <Repeat2 size={11} style={{ color: 'var(--text3)' }} />
                            <span className="text-[10px] font-mono uppercase tracking-widest font-bold" style={{ color: 'var(--text3)' }}>
                              Reinvest trades {posReinvest.length > 0 && `(${posReinvest.length})`}
                            </span>
                          </div>
                          {posReinvest.length === 0 ? (
                            <p className="text-[11px]" style={{ color: 'var(--text3)' }}>
                              No reinvest trades for {pos.ticker}. To log one, click &quot;Reinvest →&quot; on a dividend above.
                            </p>
                          ) : (
                            <div className="space-y-1.5">
                              {posReinvest.map(t => {
                                const isOpen = !t.exit_price
                                // Find the dividend that funded this trade (if any)
                                const fundingDiv = t.funded_by_dividend_id
                                  ? dividends.find(d => d.id === t.funded_by_dividend_id)
                                  : null
                                return (
                                  <div key={t.id} className="rounded-lg px-2.5 py-1.5"
                                    style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}>
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                                        {new Date(t.opened_at).toLocaleDateString()}
                                      </span>
                                      <span className="text-[10px] font-mono">
                                        {t.shares} sh @ ${t.entry_price.toFixed(2)}
                                      </span>
                                      {isOpen ? (
                                        <span className="text-[9px] px-1 py-0.5 rounded font-bold" style={{ background: 'rgba(167,139,250,0.15)', color: ACCENT }}>
                                          OPEN
                                        </span>
                                      ) : (
                                        <span className="text-[9px] px-1 py-0.5 rounded font-bold" style={{ background: 'var(--surface)', color: 'var(--text3)' }}>
                                          CLOSED
                                        </span>
                                      )}
                                      {t.pnl !== null && t.pnl !== undefined && (
                                        <span className="text-[10px] font-mono font-semibold" style={{ color: pnlColor(t.pnl) }}>
                                          {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(0)}
                                          {t.pnlPct !== null && t.pnlPct !== undefined && ` (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%)`}
                                        </span>
                                      )}
                                      <button onClick={(e) => { e.stopPropagation(); deleteReinvestTrade(t.id) }}
                                        className="ml-auto p-1 rounded hover:opacity-80"
                                        style={{ color: DN }}
                                        aria-label="Delete reinvest trade">
                                        <Trash2 size={10} />
                                      </button>
                                    </div>
                                    {fundingDiv && (
                                      <div className="text-[9px] font-mono mt-0.5" style={{ color: 'var(--text3)' }}>
                                        ← funded by {fundingDiv.ticker} dividend ({fundingDiv.ex_date}, ${fundingDiv.total_received.toFixed(2)})
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>

                        {/* ── Section 5: Journal ── */}
                        {posJournal.length > 0 && (
                          <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                            <div className="flex items-center gap-1.5 mb-2">
                              <FileText size={11} style={{ color: 'var(--text3)' }} />
                              <span className="text-[10px] font-mono uppercase tracking-widest font-bold" style={{ color: 'var(--text3)' }}>
                                Journal entries ({posJournal.length})
                              </span>
                              <button onClick={(e) => { e.stopPropagation(); router.push('/journal') }}
                                className="ml-auto flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg hover:opacity-80 transition-opacity"
                                style={{ background: 'var(--surface2)', color: 'var(--text2)' }}>
                                <ExternalLink size={10} /> Open Journal
                              </button>
                            </div>
                            <div className="space-y-1.5">
                              {posJournal.slice(0, 3).map(j => (
                                <div key={j.id} className="rounded-lg px-2.5 py-1.5"
                                  style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[9px] font-mono px-1 py-0.5 rounded font-bold"
                                      style={{
                                        background: j.signal === 'BULLISH' ? 'rgba(52,211,153,0.15)' : j.signal === 'BEARISH' ? 'rgba(248,113,113,0.15)' : 'rgba(251,191,36,0.15)',
                                        color: j.signal === 'BULLISH' ? UP : j.signal === 'BEARISH' ? DN : FLAT,
                                      }}>
                                      {j.signal}
                                    </span>
                                    <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                                      {new Date(j.created_at).toLocaleDateString()}
                                    </span>
                                    <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                                      {j.outcome === 'pending' ? 'pending' : j.outcome}
                                    </span>
                                    {j.pnl_percent !== null && (
                                      <span className="text-[10px] font-mono font-semibold" style={{ color: pnlColor(j.pnl_percent) }}>
                                        {j.pnl_percent >= 0 ? '+' : ''}{j.pnl_percent.toFixed(1)}%
                                      </span>
                                    )}
                                    {j.postmortem?.council_grade && (
                                      <span className="text-[9px] font-bold w-5 h-5 rounded-full flex items-center justify-center ml-auto"
                                        style={{ background: `${gradeColor(j.postmortem.council_grade)}20`, color: gradeColor(j.postmortem.council_grade) }}>
                                        {j.postmortem.council_grade}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* ── Section 6: Actions footer ── */}
                        <div className="px-4 py-3 flex items-center gap-2 flex-wrap">
                          <button onClick={(e) => { e.stopPropagation(); router.push(`/?ticker=${pos.ticker}`) }}
                            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
                            style={{ background: 'rgba(167,139,250,0.1)', color: ACCENT, border: '1px solid rgba(167,139,250,0.22)' }}>
                            <Activity size={12} /> Run Council
                          </button>
                          {check && check.verdict !== 'TERMINAL' && (
                            <button onClick={(e) => { e.stopPropagation(); runHealthCheck(pos.ticker) }}
                              disabled={checkTicker === pos.ticker}
                              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-40"
                              style={{ background: 'rgba(248,113,113,0.08)', color: DN, border: '1px solid rgba(248,113,113,0.22)' }}>
                              <Stethoscope size={12} /> {checkTicker === pos.ticker ? 'Checking...' : 'Re-check'}
                            </button>
                          )}
                          <button onClick={(e) => {
                              e.stopPropagation()
                              setCloseTarget({
                                id: pos.id,
                                ticker: pos.ticker,
                                position_type: pos.position_type,
                                option_type: pos.option_type,
                                strike: pos.strike,
                                expiry: pos.expiry,
                                contracts: pos.contracts,
                                entry_premium: pos.entry_premium,
                                underlying: pos.underlying,
                                shares: pos.shares,
                                avg_cost: pos.avg_cost,
                                currentPrice: data?.currentPrice,
                              })
                            }}
                            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
                            style={{ background: 'rgba(251,191,36,0.1)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.25)' }}>
                            <Archive size={12} /> Close
                          </button>
                          <div className="ml-auto">
                            <button onClick={(e) => { e.stopPropagation(); removePosition(pos.ticker) }}
                              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
                              style={{ background: 'var(--surface)', color: 'var(--text3)', border: '1px solid var(--border)' }}>
                              <Trash2 size={12} /> Remove
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {/* ─── Closed positions section (Commit 1+2) ─── */}
          {showClosed && (
            <div className="mt-6">
              <div className="flex items-center gap-2 mb-3">
                <Archive size={14} style={{ color: 'var(--text2)' }} />
                <span className="text-sm font-bold" style={{ color: 'var(--text)' }}>Closed Positions</span>
                <button
                  onClick={() => setShowClosed(false)}
                  className="ml-auto text-[10px] font-mono"
                  style={{ color: 'var(--text3)' }}
                >
                  hide
                </button>
              </div>
              <ClosedTab reloadKey={closedReloadKey} />
            </div>
          )}

          {/* ─── AI Portfolio Summary (preserved from original page) ─── */}
          {analysis && positions.length >= 2 && (
            <div className="mt-6 rounded-xl border p-5"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-[10px] font-mono uppercase tracking-widest font-bold" style={{ color: ACCENT }}>
                  AI Portfolio Summary
                </span>
                <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                  Score: <span style={{ color: analysis.portfolioScore >= 70 ? UP : analysis.portfolioScore >= 40 ? FLAT : DN }}>
                    {analysis.portfolioScore}
                  </span>
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded font-bold"
                  style={{
                    background: analysis.overallSignal === 'BULLISH' ? 'rgba(52,211,153,0.15)'
                      : analysis.overallSignal === 'BEARISH' ? 'rgba(248,113,113,0.15)'
                      : 'rgba(251,191,36,0.15)',
                    color: analysis.overallSignal === 'BULLISH' ? UP
                      : analysis.overallSignal === 'BEARISH' ? DN
                      : FLAT,
                  }}>
                  {analysis.overallSignal} · {analysis.overallConviction}
                </span>
              </div>

              <h3 className="text-sm font-bold leading-snug mb-2" style={{ color: 'var(--text)' }}>
                {analysis.headline}
              </h3>
              <p className="text-xs leading-relaxed mb-4" style={{ color: 'var(--text2)' }}>
                {analysis.summary}
              </p>

              {analysis.topRisks.length > 0 && (
                <div className="mb-3 pb-3 border-b" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center gap-1 mb-1.5">
                    <AlertTriangle size={11} style={{ color: DN }} />
                    <span className="text-[10px] font-mono uppercase tracking-wider font-bold" style={{ color: DN }}>Top risks</span>
                  </div>
                  {analysis.topRisks.slice(0, 3).map((r, i) => (
                    <div key={i} className="mb-2 last:mb-0">
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>{r.risk}</p>
                      {r.tickers.length > 0 && (
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {r.tickers.map(t => (
                            <button key={t} onClick={() => expandAndScrollTo(t)}
                              className="text-[9px] font-mono px-1 py-0.5 rounded hover:opacity-80 transition-opacity"
                              style={{ background: 'var(--surface2)', color: 'var(--text2)' }}>
                              {t}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {analysis.opportunities.length > 0 && (
                <div className="mb-3 pb-3 border-b" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center gap-1 mb-1.5">
                    <Target size={11} style={{ color: UP }} />
                    <span className="text-[10px] font-mono uppercase tracking-wider font-bold" style={{ color: UP }}>Opportunities</span>
                  </div>
                  {analysis.opportunities.slice(0, 3).map((o, i) => (
                    <div key={i} className="mb-2 last:mb-0">
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>{o.opportunity}</p>
                      {o.tickers.length > 0 && (
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {o.tickers.map(t => (
                            <button key={t} onClick={() => expandAndScrollTo(t)}
                              className="text-[9px] font-mono px-1 py-0.5 rounded hover:opacity-80 transition-opacity"
                              style={{ background: 'var(--surface2)', color: 'var(--text2)' }}>
                              {t}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>
                    Sector analysis
                  </div>
                  <p style={{ color: 'var(--text2)' }}>{analysis.sectorAnalysis}</p>
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>
                    Earnings watch
                  </div>
                  <p style={{ color: 'var(--text2)' }}>{analysis.earningsWatch}</p>
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>
                    Rebalancing
                  </div>
                  <p style={{ color: 'var(--text2)' }}>{analysis.rebalancingSuggestions}</p>
                </div>
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>
                    Action plan
                  </div>
                  <p style={{ color: 'var(--text2)' }}>{analysis.actionPlan}</p>
                </div>
              </div>

              <p className="text-[10px] mt-4 italic" style={{ color: 'var(--text3)' }}>
                AI-generated analysis. Not financial advice.
              </p>
            </div>
          )}

        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════ */}
      {/* DRAWERS — preserved from original page                        */}
      {/* ════════════════════════════════════════════════════════════ */}

      {/* Add position drawer (preserved) */}
      {showAdd && (
        <Drawer title="Add position" onClose={() => setShowAdd(false)}>
          <div className="space-y-4">
            <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border)' }}>
              {(['stock', 'option'] as const).map(t => (
                <button key={t} onClick={() => setAddType(t)}
                  className="flex-1 px-3 py-2 text-xs font-semibold transition-all"
                  style={{
                    background: addType === t ? 'rgba(167,139,250,0.15)' : 'transparent',
                    color: addType === t ? ACCENT : 'var(--text3)',
                  }}>
                  {t === 'stock' ? 'Stock' : 'Option'}
                </button>
              ))}
            </div>
            <FormField label={addType === 'option' ? 'Underlying ticker' : 'Ticker'}>
              <input value={addTicker} onChange={e => setAddTicker(e.target.value.toUpperCase())}
                placeholder={addType === 'option' ? 'NVDA' : 'AAPL'} maxLength={6}
                className="w-full rounded-lg px-3 py-2.5 text-sm font-mono font-bold outline-none border"
                style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
            </FormField>
            {addType === 'stock' ? (
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Shares">
                  <input value={addShares} onChange={e => setAddShares(e.target.value)} placeholder="100" type="number"
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                    style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                </FormField>
                <FormField label="Avg cost (optional)">
                  <input value={addCost} onChange={e => setAddCost(e.target.value)} placeholder="180.50" type="number"
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                    style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                </FormField>
              </div>
            ) : (
              <>
                <FormField label="Type">
                  <div className="grid grid-cols-2 gap-2">
                    {(['call', 'put'] as const).map(ot => (
                      <button key={ot} onClick={() => setAddOptionType(ot)}
                        className="py-2 rounded-lg text-xs font-bold transition-all"
                        style={{
                          background: addOptionType === ot
                            ? (ot === 'call' ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)')
                            : 'var(--surface2)',
                          color: addOptionType === ot ? (ot === 'call' ? UP : DN) : 'var(--text3)',
                          border: `1px solid ${addOptionType === ot ? (ot === 'call' ? UP : DN) + '30' : 'var(--border)'}`,
                        }}>
                        {ot.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </FormField>
                <div className="grid grid-cols-3 gap-3">
                  <FormField label="Strike">
                    <input value={addStrike} onChange={e => setAddStrike(e.target.value)} placeholder="180" type="number"
                      className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                      style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                  </FormField>
                  <FormField label="Expiry">
                    <input value={addExpiry} onChange={e => setAddExpiry(e.target.value)} type="date"
                      className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
                      style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                  </FormField>
                  <FormField label="Contracts">
                    <input value={addContracts} onChange={e => setAddContracts(e.target.value)} placeholder="1" type="number"
                      className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                      style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                  </FormField>
                </div>
                <FormField label="Premium paid/contract (optional)">
                  <input value={addCost} onChange={e => setAddCost(e.target.value)} placeholder="2.50" type="number"
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                    style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                </FormField>
              </>
            )}
            <div className="flex gap-2 pt-2">
              <button onClick={addPosition} disabled={addLoading || !addTicker || (addType === 'stock' ? !addShares : !addStrike || !addExpiry)}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                style={{ background: ACCENT, color: '#0a0d12' }}>
                {addLoading ? 'Adding...' : `Add ${addType === 'option' ? `${addOptionType.toUpperCase()} option` : 'position'}`}
              </button>
              <button onClick={() => setShowAdd(false)}
                className="px-4 py-2.5 rounded-lg text-sm transition-all hover:opacity-80"
                style={{ background: 'var(--surface2)', color: 'var(--text2)', border: '1px solid var(--border)' }}>
                Cancel
              </button>
            </div>
          </div>
        </Drawer>
      )}

      {/* Log dividend drawer (preserved) */}
      {showLogDiv && (
        <Drawer title="Log dividend" onClose={() => setShowLogDiv(false)}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Ticker">
                <input value={divTicker} onChange={e => setDivTicker(e.target.value.toUpperCase())} placeholder="AAPL"
                  className="w-full rounded-lg px-3 py-2.5 text-sm font-mono font-bold outline-none border"
                  style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
              </FormField>
              <FormField label="Amount/share ($)">
                <input value={divAmount} onChange={e => setDivAmount(e.target.value)} placeholder="0.24" type="number" step="0.0001"
                  className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                  style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
              </FormField>
              <FormField label="Shares held">
                <input value={divShares} onChange={e => setDivShares(e.target.value)} placeholder="100" type="number"
                  className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                  style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
              </FormField>
              <FormField label="Ex-date">
                <input value={divExDate} onChange={e => setDivExDate(e.target.value)} type="date"
                  className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
                  style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
              </FormField>
              <FormField label="Pay date (optional)">
                <input value={divPayDate} onChange={e => setDivPayDate(e.target.value)} type="date"
                  className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
                  style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
              </FormField>
            </div>
            <button onClick={() => setDivReinvested(v => !v)}
              className="flex items-center gap-2 w-full px-3 py-2.5 rounded-lg text-sm font-semibold transition-all"
              style={{
                background: divReinvested ? 'rgba(167,139,250,0.1)' : 'var(--surface2)',
                color: divReinvested ? ACCENT : 'var(--text2)',
                border: `1px solid ${divReinvested ? 'rgba(167,139,250,0.28)' : 'var(--border)'}`,
              }}>
              <Repeat2 size={14} />
              {divReinvested ? 'Reinvesting' : 'Reinvest this dividend?'}
              {divReinvested && <Check size={12} className="ml-auto" />}
            </button>
            {divReinvested && (
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Shares purchased">
                  <input value={divReinvestShares} onChange={e => setDivReinvestShares(e.target.value)} placeholder="1.2" type="number" step="0.0001"
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                    style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                </FormField>
                <FormField label="Price paid/share">
                  <input value={divReinvestPrice} onChange={e => setDivReinvestPrice(e.target.value)} placeholder="185.00" type="number"
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                    style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                </FormField>
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button onClick={saveDiv} disabled={savingDiv || !divTicker || !divAmount || !divShares || !divExDate}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                style={{ background: UP, color: '#0a0d12' }}>
                {savingDiv ? 'Saving...' : 'Save dividend'}
              </button>
              <button onClick={() => setShowLogDiv(false)}
                className="px-4 py-2.5 rounded-lg text-sm transition-all hover:opacity-80"
                style={{ background: 'var(--surface2)', color: 'var(--text2)', border: '1px solid var(--border)' }}>
                Cancel
              </button>
            </div>
          </div>
        </Drawer>
      )}

      {/* Add reinvest trade drawer (preserved + funded_by linkage) */}
      {showAddReinvest && (
        <Drawer title="Log reinvestment trade" onClose={() => {
          setShowAddReinvest(false)
          setRFundedByDividendId(null)
        }}>
          <div className="space-y-3">
            {rFundedByDividendId && (() => {
              const fundingDiv = dividends.find(d => d.id === rFundedByDividendId)
              if (!fundingDiv) return null
              return (
                <div className="rounded-lg px-3 py-2"
                  style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.22)' }}>
                  <div className="text-[9px] font-mono uppercase tracking-wider mb-0.5" style={{ color: ACCENT }}>
                    Funded by
                  </div>
                  <div className="text-xs font-mono" style={{ color: 'var(--text2)' }}>
                    {fundingDiv.ticker} dividend · {fundingDiv.ex_date} · ${fundingDiv.total_received.toFixed(2)}
                  </div>
                </div>
              )
            })()}
            <div className="grid grid-cols-3 gap-3">
              <FormField label="Ticker">
                <input value={rTicker} onChange={e => setRTicker(e.target.value.toUpperCase())} placeholder="NVDA"
                  className="w-full rounded-lg px-3 py-2.5 text-sm font-mono font-bold outline-none border"
                  style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
              </FormField>
              <FormField label="Shares">
                <input value={rShares} onChange={e => setRShares(e.target.value)} placeholder="5" type="number"
                  className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                  style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
              </FormField>
              <FormField label="Entry $">
                <input value={rEntry} onChange={e => setREntry(e.target.value)} placeholder="185.00" type="number"
                  className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                  style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
              </FormField>
            </div>
            <FormField label="Notes (optional)">
              <input value={rNotes} onChange={e => setRNotes(e.target.value)} placeholder="e.g. AAPL dividend reinvestment"
                className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
                style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
            </FormField>
            <div className="flex gap-2 pt-2">
              <button onClick={addReinvestTrade} disabled={savingReinvest || !rTicker || !rShares || !rEntry}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                style={{ background: FLAT, color: '#0a0d12' }}>
                {savingReinvest ? 'Saving...' : 'Add trade'}
              </button>
              <button onClick={() => { setShowAddReinvest(false); setRFundedByDividendId(null) }}
                className="px-4 py-2.5 rounded-lg text-sm transition-all hover:opacity-80"
                style={{ background: 'var(--surface2)', color: 'var(--text2)', border: '1px solid var(--border)' }}>
                Cancel
              </button>
            </div>
          </div>
        </Drawer>
      )}

      {/* Settings drawer (NEW v3) */}
      {showSettings && (
        <Drawer title="Settings" onClose={() => setShowSettings(false)}>
          <div className="space-y-5">
            <div>
              <FormField label="Recent Activity window">
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="number"
                    min={1}
                    max={90}
                    value={recentActivityDays}
                    onChange={e => setRecentActivityDays(Math.max(1, Math.min(90, parseInt(e.target.value) || 14)))}
                    className="w-20 rounded-lg px-3 py-2 text-sm font-mono outline-none border"
                    style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                  <span className="text-xs" style={{ color: 'var(--text3)' }}>days back</span>
                </div>
              </FormField>
              <p className="text-[10px] mt-2" style={{ color: 'var(--text3)' }}>
                How far back to look for Recent Activity items (Council outcomes, reinvest trades, dividends).
                Default 14 days.
              </p>
            </div>

            <div className="pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
              <FormField label="Reset UI state">
                <button onClick={() => {
                  if (!confirm('Reset all UI preferences (expanded rows, filter, sort, collapsed strips)?')) return
                  Object.values(LS_KEYS).forEach(k => window.localStorage.removeItem(k))
                  window.location.reload()
                }}
                  className="w-full py-2 rounded-lg text-sm transition-all hover:opacity-80 mt-1"
                  style={{ background: 'var(--surface2)', color: 'var(--text2)', border: '1px solid var(--border)' }}>
                  Reset to defaults
                </button>
              </FormField>
            </div>
          </div>
        </Drawer>
      )}

      {/* ─── Close-position modal (Commit 1+2) ─── */}
      {closeTarget && (
        <CloseModal
          position={closeTarget}
          onClose={() => setCloseTarget(null)}
          onSuccess={(result: CloseResult) => {
            setCloseTarget(null)
            // Reload positions (will be removed if full close, reduced if partial)
            void loadPositions()
            // Trigger ClosedTab + realized P&L refresh
            setClosedReloadKey(k => k + 1)
            // If full close, expand the closed view so user can see it
            if (result.close_event.close_type === 'full') {
              setShowClosed(true)
            }
          }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Default export wrapper (preserved Suspense boundary)
// ─────────────────────────────────────────────────────────────────────────────

export default function PortfolioPage() {
  return (
    <Suspense fallback={<div style={{ background: 'var(--bg)', minHeight: '100vh' }} />}>
      <PortfolioInner />
    </Suspense>
  )
}
