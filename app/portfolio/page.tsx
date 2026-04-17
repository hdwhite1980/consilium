'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowLeft, BarChart2, Plus, Trash2, RefreshCw, TrendingUp, TrendingDown,
  Minus, AlertTriangle, Calendar, DollarSign, BookOpen, Check, X, Clock,
  Star, Repeat2, ChevronDown, ChevronUp
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

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
}
interface PortfolioAnalysis {
  overallSignal: string; overallConviction: string; headline: string; summary: string
  topRisks: Array<{ risk: string; tickers: string[]; severity: string }>
  opportunities: Array<{ opportunity: string; tickers: string[] }>
  sectorAnalysis: string; earningsWatch: string; rebalancingSuggestions: string
  actionPlan: string; portfolioScore: number
}
interface JournalEntry {
  id: string; ticker: string; signal: string; entry_price: number | null
  stop_loss: number | null; take_profit: number | null; timeframe: string | null
  confidence: number | null; exit_price: number | null; outcome: string
  pnl_percent: number | null
  position_type: 'stock' | 'option'
  option_type: 'call' | 'put' | null
  strike: number | null; expiry: string | null
  contracts: number | null; entry_premium: number | null; exit_premium: number | null
  underlying: string | null
  postmortem: { what_worked: string; what_missed: string; key_lesson: string; signal_quality: string; council_grade: string; improve_next_time: string } | null
  notes: string | null; tags: string[] | null; created_at: string
}
interface JournalStats { winRate: number | null; avgPnl: number | null; totalTrades: number }

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
  verdict: 'HOLD' | 'EXIT' | 'ADD' | 'WATCH'
  conviction: 'high' | 'medium' | 'low'; reason: string; action: string; flags: string[]
}
interface Dividend {
  id: string; ticker: string; ex_date: string; pay_date: string | null
  amount_per_share: number; shares_held: number; total_received: number
  reinvested: boolean; reinvest_shares: number | null; reinvest_price: number | null; notes: string | null
}
interface DividendSchedule {
  ticker: string; ex_date: string; pay_date: string | null
  amount: number | null; frequency: string | null
}
interface ReinvestTrade {
  id: string; ticker: string; shares: number; entry_price: number
  exit_price: number | null; exit_date: string | null
  council_signal: string | null; confidence: number | null; notes: string | null; opened_at: string
  currentPrice?: number | null; pnl?: number | null; pnlPct?: number | null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const SIG_COLOR: Record<string, string> = { BULLISH: '#34d399', BEARISH: '#f87171', NEUTRAL: '#fbbf24' }
const SEV_COLOR: Record<string, string> = { high: '#f87171', medium: '#fbbf24', low: '#94a3b8' }
const RISK_COLOR: Record<string, string> = { low: '#34d399', medium: '#fbbf24', high: '#f87171' }
const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtK = (n: number) => Math.abs(n) >= 1000 ? `$${(n/1000).toFixed(1)}k` : `$${fmt(n)}`
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
const gradeColor = (g: string) => ({ A: '#34d399', B: '#60a5fa', C: '#fbbf24', D: '#f97316', F: '#f87171' }[g] || '#94a3b8')

function Section({ title, icon, color, children, defaultOpen = true }: { title: string; icon: React.ReactNode; color: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-2xl border overflow-hidden" style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-5 py-3.5 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <span style={{ color }}>{icon}</span>
        <span className="text-xs font-bold uppercase tracking-wider" style={{ color }}>{title}</span>
        <span className="ml-auto" style={{ color: 'rgba(255,255,255,0.3)' }}>{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
      </button>
      {open && <div className="px-5 py-4">{children}</div>}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

type Tab = 'holdings' | 'dividends' | 'reinvest' | 'journal'

function PortfolioInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialTab = (searchParams.get('tab') as Tab) || 'holdings'
  const [tab, setTab] = useState<Tab>(initialTab)

  // ── Holdings state
  const [positions, setPositions] = useState<Position[]>([])
  const [positionData, setPositionData] = useState<PositionData[]>([])
  const [metrics, setMetrics] = useState<PortfolioMetrics | null>(null)
  const [analysis, setAnalysis] = useState<PortfolioAnalysis | null>(null)
  const [loadingHoldings, setLoadingHoldings] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [cachedAge, setCachedAge] = useState<number | null>(null)
  const [statusMsg, setStatusMsg] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [addType, setAddType] = useState<'stock' | 'option'>('stock')
  const [addTicker, setAddTicker] = useState('')
  const [addShares, setAddShares] = useState('')
  const [addCost, setAddCost] = useState('')
  const [addOptionType, setAddOptionType] = useState<'call' | 'put'>('call')
  const [addStrike, setAddStrike] = useState('')
  const [addExpiry, setAddExpiry] = useState('')
  const [addContracts, setAddContracts] = useState('1')
  const [checks, setChecks] = useState<PositionCheck[]>([])
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [checkTicker, setCheckTicker] = useState<string | null>(null)
  const [addPremium, setAddPremium] = useState('')
  const [addLoading, setAddLoading] = useState(false)

  // ── Journal state
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([])
  const [journalStats, setJournalStats] = useState<JournalStats>({ winRate: null, avgPnl: null, totalTrades: 0 })
  const [loadingJournal, setLoadingJournal] = useState(false)
  const [expandedEntry, setExpandedEntry] = useState<string | null>(null)
  const [resolving, setResolving] = useState<string | null>(null)
  const [showAddJournal, setShowAddJournal] = useState(false)
  const [jTicker, setJTicker] = useState(''); const [jType, setJType] = useState<'stock'|'option'>('stock')
  const [jSignal, setJSignal] = useState<'BULLISH'|'BEARISH'|'NEUTRAL'>('BULLISH')
  const [jOptionType, setJOptionType] = useState<'call'|'put'>('call')
  const [jStrike, setJStrike] = useState(''); const [jExpiry, setJExpiry] = useState('')
  const [jContracts, setJContracts] = useState('1'); const [jPremium, setJPremium] = useState('')
  const [jEntryPrice, setJEntryPrice] = useState(''); const [jStop, setJStop] = useState('')
  const [jTarget, setJTarget] = useState(''); const [jTimeframe, setJTimeframe] = useState('1D')
  const [jNotes, setJNotes] = useState('')
  const [resolveData, setResolveData] = useState({ exit_price: '', exit_premium: '', outcome: 'win', notes: '' })

  // ── Dividend state
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

  // ── Reinvest state
  const [reinvestTrades, setReinvestTrades] = useState<ReinvestTrade[]>([])
  const [loadingReinvest, setLoadingReinvest] = useState(false)
  const [showAddReinvest, setShowAddReinvest] = useState(false)
  const [rTicker, setRTicker] = useState('')
  const [rShares, setRShares] = useState('')
  const [rEntry, setREntry] = useState('')
  const [rNotes, setRNotes] = useState('')
  const [savingReinvest, setSavingReinvest] = useState(false)

  // ── Holdings loading ───────────────────────────────────────────────────────

  const loadCachedAnalysis = useCallback(async (pos: typeof positions) => {
    if (!pos.length) return
    const res = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positions: pos.map(p => ({ ticker: p.ticker, shares: p.shares, avg_cost: p.avg_cost, position_type: p.position_type, option_type: p.option_type, strike: p.strike, expiry: p.expiry, contracts: p.contracts, entry_premium: p.entry_premium, underlying: p.underlying })), forceRefresh: false })
    })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n'); buf = parts.pop() || ''
      for (const part of parts) {
        const ev = part.split('\n').find(l => l.startsWith('event:'))?.replace('event:', '').trim()
        const d = (() => { try { return JSON.parse(part.split('\n').find(l => l.startsWith('data:'))?.replace('data:', '').trim() || '{}') } catch { return {} } })()
        if (ev === 'position_data' && d.length) setPositionData(d)
        if (ev === 'complete' && d.cached) { setPositionData(d.positionData ?? []); setMetrics(d.metrics); setAnalysis(d.analysis); setCachedAge(d.ageMinutes ?? null) }
      }
    }
  }, [])

  const loadPositions = useCallback(async () => {
    setLoadingHoldings(true)
    const res = await fetch('/api/portfolio/positions')
    const data = await res.json()
    const loaded = data.positions ?? []
    setPositions(loaded)
    setLoadingHoldings(false)
    if (loaded.length > 0) loadCachedAnalysis(loaded)
  }, [loadCachedAnalysis])

  const runAnalysis = useCallback(async (forceRefresh = false) => {
    if (!positions.length) return
    setAnalyzing(true); setAnalysis(null); setPositionData([]); setMetrics(null); setCachedAge(null); setStatusMsg('Starting analysis...')
    const res = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positions: positions.map(p => ({ ticker: p.ticker, shares: p.shares, avg_cost: p.avg_cost, position_type: p.position_type, option_type: p.option_type, strike: p.strike, expiry: p.expiry, contracts: p.contracts, entry_premium: p.entry_premium, underlying: p.underlying })), forceRefresh })
    })
    const reader = res.body!.getReader()
    const dec = new TextDecoder(); let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n'); buf = parts.pop() || ''
      for (const part of parts) {
        const ev = part.split('\n').find(l => l.startsWith('event:'))?.replace('event:', '').trim()
        const d = (() => { try { return JSON.parse(part.split('\n').find(l => l.startsWith('data:'))?.replace('data:', '').trim() || '{}') } catch { return {} } })()
        if (ev === 'status') setStatusMsg(d.message)
        if (ev === 'position_data') setPositionData(d)
        if (ev === 'complete') { setPositionData(d.positionData); setMetrics(d.metrics); setAnalysis(d.analysis); setCachedAge(d.cached ? (d.ageMinutes ?? 0) : 0); setAnalyzing(false) }
        if (ev === 'error') { setStatusMsg(d.message); setAnalyzing(false) }
      }
    }
  }, [positions])

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
    await fetch('/api/portfolio/positions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setAddTicker(''); setAddShares(''); setAddCost(''); setAddStrike(''); setAddExpiry('')
    setAddContracts('1'); setAddPremium(''); setShowAdd(false); setAddLoading(false)
    await loadPositions()
  }

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
        const res = await fetch('/api/portfolio/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
        const data = await res.json()
        setChecks(data.checks || [])
        setCheckedAt(data.checkedAt || null)
      }
    } finally { setChecking(false); setCheckTicker(null) }
  }

  const removePosition = async (ticker: string) => {
    if (!confirm(`Remove ${ticker} from portfolio?`)) return
    await fetch('/api/portfolio/positions', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker }) })
    await loadPositions()
    setPositionData(prev => prev.filter(p => p.ticker !== ticker))
  }

  // ── Journal loading ────────────────────────────────────────────────────────

  const loadJournal = useCallback(async () => {
    setLoadingJournal(true)
    const res = await fetch('/api/trade-journal')
    const data = await res.json()
    setJournalEntries(data.entries || [])
    setJournalStats(data.stats || { winRate: null, avgPnl: null, totalTrades: 0 })
    setLoadingJournal(false)
  }, [])

  const handleDeleteJournal = async (id: string) => {
    if (!confirm('Delete this trade from your journal?')) return
    await fetch('/api/trade-journal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', id }) })
    await loadJournal()
  }

  const addJournalEntry = async () => {
    if (!jTicker) return
    const isOption = jType === 'option'
    const body: Record<string, unknown> = {
      action: 'add', ticker: jTicker.toUpperCase(), signal: jSignal,
      position_type: jType, timeframe: jTimeframe, notes: jNotes || null,
    }
    if (isOption) {
      body.option_type = jOptionType; body.strike = jStrike ? parseFloat(jStrike) : null
      body.expiry = jExpiry || null; body.contracts = jContracts ? parseInt(jContracts) : 1
      body.entry_premium = jPremium ? parseFloat(jPremium) : null
      body.underlying = jTicker.toUpperCase()
    } else {
      body.entry_price = jEntryPrice ? parseFloat(jEntryPrice) : null
      body.stop_loss = jStop ? parseFloat(jStop) : null
      body.take_profit = jTarget ? parseFloat(jTarget) : null
    }
    await fetch('/api/trade-journal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setShowAddJournal(false)
    setJTicker(''); setJStrike(''); setJExpiry(''); setJPremium(''); setJEntryPrice(''); setJStop(''); setJTarget(''); setJNotes('')
    await loadJournal()
  }

  const handleResolve = async (id: string) => {
    const entry = journalEntries.find(e => e.id === id)
    const isOption = entry?.position_type === 'option'
    if (!isOption && !resolveData.exit_price) return
    if (isOption && !resolveData.exit_premium) return
    setResolving(id)
    await fetch('/api/trade-journal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'resolve', id,
        exit_price: resolveData.exit_price ? parseFloat(resolveData.exit_price) : null,
        exit_premium: resolveData.exit_premium ? parseFloat(resolveData.exit_premium) : null,
        outcome: resolveData.outcome, notes: resolveData.notes
      })
    })
    setResolving(null); setExpandedEntry(null)
    await loadJournal()
  }

  const outcomeIcon = (o: string) => o === 'win' ? <Check size={12} style={{ color: '#34d399' }} /> : o === 'loss' ? <X size={12} style={{ color: '#f87171' }} /> : <Clock size={12} style={{ color: '#fbbf24' }} />

  // ── Dividend loading ───────────────────────────────────────────────────────

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
      })
    })
    setDivTicker(''); setDivAmount(''); setDivShares(''); setDivExDate(''); setDivPayDate('')
    setDivReinvested(false); setDivReinvestShares(''); setDivReinvestPrice('')
    setShowLogDiv(false); setSavingDiv(false)
    await loadDividends()
  }

  const deleteDiv = async (id: string) => {
    if (!confirm('Delete this dividend record?')) return
    await fetch('/api/dividends', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    await loadDividends()
  }

  // ── Reinvest loading ───────────────────────────────────────────────────────

  const loadReinvest = useCallback(async () => {
    setLoadingReinvest(true)
    try {
      const res = await fetch('/api/reinvestment/trades')
      if (res.ok) {
        const data = await res.json()
        const trades: ReinvestTrade[] = data.trades || data || []
        // Enrich with current prices
        const enriched = await Promise.all(trades.map(async (t) => {
          try {
            const q = await fetch(`/api/ticker?ticker=${t.ticker}`)
            const qd = q.ok ? await q.json() : null
            const cpRaw = qd?.quote?.c || null
            const cp = cpRaw !== null ? parseFloat(cpRaw) : null
            const pnl = cp && t.shares ? (cp - t.entry_price) * t.shares : null
            const pnlPct = t.entry_price > 0 && cp ? ((cp - t.entry_price) / t.entry_price * 100) : null
            return { ...t, currentPrice: cp, pnl, pnlPct }
          } catch { return t }
        }))
        setReinvestTrades(enriched)
      }
    } finally { setLoadingReinvest(false) }
  }, [])

  const addReinvestTrade = async () => {
    if (!rTicker || !rShares || !rEntry) return
    setSavingReinvest(true)
    await fetch('/api/reinvestment/trades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker: rTicker.toUpperCase(), shares: parseFloat(rShares), entry_price: parseFloat(rEntry), notes: rNotes || null })
    })
    setRTicker(''); setRShares(''); setREntry(''); setRNotes('')
    setShowAddReinvest(false); setSavingReinvest(false)
    await loadReinvest()
  }

  const deleteReinvestTrade = async (id: string) => {
    if (!confirm('Delete this reinvestment trade?')) return
    await fetch(`/api/reinvestment/trades?id=${id}`, { method: 'DELETE' })
    await loadReinvest()
  }

  // ── Load on tab change ─────────────────────────────────────────────────────

  useEffect(() => { loadPositions() }, [loadPositions])

  useEffect(() => {
    if (tab === 'journal' && journalEntries.length === 0) loadJournal()
    if (tab === 'dividends' && dividends.length === 0) loadDividends()
    if (tab === 'reinvest' && reinvestTrades.length === 0) loadReinvest()
  }, [tab]) // eslint-disable-line

  const totalValue = positionData.reduce((s, p) => s + p.marketValue, 0)
  const totalDividends = dividends.reduce((s, d) => s + d.total_received, 0)
  const reinvestedDividends = dividends.filter(d => d.reinvested).reduce((s, d) => s + d.total_received, 0)
  const openReinvestTrades = reinvestTrades.filter(t => !t.exit_price)
  const realizedReinvestPnL = reinvestTrades.filter(t => t.exit_price).reduce((s, t) => { const p = t.exit_price ? (t.exit_price - t.entry_price) * t.shares : 0; return s + p }, 0)

  // ── Tab bar ────────────────────────────────────────────────────────────────

  const TABS: Array<{ id: Tab; label: string; icon: string }> = [
    { id: 'holdings', label: 'Holdings', icon: '💼' },
    { id: 'dividends', label: 'Dividends', icon: '💵' },
    { id: 'reinvest', label: 'Reinvest', icon: '🔄' },
    { id: 'journal', label: 'Journal', icon: '📒' },
  ]

  const VERDICT_COLOR: Record<string, string> = { EXIT: '#f87171', WATCH: '#fbbf24', HOLD: '#34d399', ADD: '#60a5fa' }
  const VERDICT_BG: Record<string, string> = { EXIT: 'rgba(248,113,113,0.1)', WATCH: 'rgba(251,191,36,0.08)', HOLD: 'rgba(52,211,153,0.06)', ADD: 'rgba(96,165,250,0.08)' }

  return (
    <div className="flex flex-col min-h-screen" style={{ background: '#0a0d12', color: 'white' }}>

      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b sticky top-0 z-10"
        style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.07)' }}>
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.1)' }} />
        <BarChart2 size={14} style={{ color: '#a78bfa' }} />
        <span className="text-sm font-bold">Portfolio</span>
        {positions.length > 0 && (
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
            style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
            {positions.length} positions
          </span>
        )}
        {totalValue > 0 && (
          <span className="text-[10px] font-mono text-white/40">{fmtK(totalValue)}</span>
        )}
        {/* Holdings tab actions */}
        {tab === 'holdings' && (
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setShowAdd(!showAdd)}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
              style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.25)' }}>
              <Plus size={12} /> Add
            </button>
            {positions.length > 0 && (
              <>
                {cachedAge !== null && !analyzing && (
                  <span className="text-[10px] hidden sm:block" style={{ color: 'rgba(255,255,255,0.3)' }}>
                    {cachedAge === 0 ? 'just analyzed' : `${cachedAge < 60 ? `${cachedAge}m` : `${Math.round(cachedAge/60)}h`} old`}
                  </span>
                )}
                <button onClick={() => runHealthCheck()} disabled={checking || positions.length === 0}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-40"
                  style={{ background: 'rgba(248,113,113,0.12)', color: '#f87171', border: '1px solid rgba(248,113,113,0.25)' }}>
                  {checking && !checkTicker ? <div className="w-3 h-3 rounded-full border border-t-red-400 border-red-200/30 animate-spin" /> : '🩺'}
                  {checking && !checkTicker ? 'Checking...' : 'Check'}
                </button>
                <button onClick={() => runAnalysis(true)} disabled={analyzing}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-40"
                  style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)', color: 'white' }}>
                  <RefreshCw size={12} className={analyzing ? 'animate-spin' : ''} />
                  {analyzing ? 'Analyzing...' : cachedAge !== null ? '↻ Re-analyze' : 'Analyze'}
                </button>
              </>
            )}
          </div>
        )}
        {tab === 'dividends' && (
          <button onClick={() => setShowLogDiv(true)} className="ml-auto flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'rgba(52,211,153,0.15)', color: '#34d399', border: '1px solid rgba(52,211,153,0.25)' }}>
            <Plus size={12} /> Log dividend
          </button>
        )}
        {tab === 'reinvest' && (
          <button onClick={() => setShowAddReinvest(true)} className="ml-auto flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.25)' }}>
            <Plus size={12} /> Add trade
          </button>
        )}
      </header>

      {/* Tab bar */}
      <div className="flex border-b px-4 gap-1 sticky top-[49px] z-10"
        style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.07)' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className="flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold transition-all border-b-2"
            style={{
              borderColor: tab === t.id ? '#a78bfa' : 'transparent',
              color: tab === t.id ? '#a78bfa' : 'rgba(255,255,255,0.35)',
            }}>
            <span>{t.icon}</span> {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-4 py-5 space-y-4">

          {/* ── HOLDINGS TAB ──────────────────────────────────────────────── */}
          {tab === 'holdings' && (
            <>
              {/* Add position form */}
              {showAdd && (
                <div className="rounded-2xl border p-5 space-y-4" style={{ background: '#111620', borderColor: 'rgba(167,139,250,0.25)' }}>
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-white">Add position</h3>
                    <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
                      {(['stock','option'] as const).map(t => (
                        <button key={t} onClick={() => setAddType(t)}
                          className="px-3 py-1.5 text-xs font-semibold transition-all"
                          style={{ background: addType === t ? 'rgba(167,139,250,0.2)' : 'transparent', color: addType === t ? '#a78bfa' : 'rgba(255,255,255,0.4)' }}>
                          {t === 'stock' ? '📈 Stock' : '⚡ Option'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Ticker — always shown */}
                  <div>
                    <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">
                      {addType === 'option' ? 'Underlying ticker' : 'Ticker'}
                    </label>
                    <input value={addTicker} onChange={e => setAddTicker(e.target.value.toUpperCase())}
                      placeholder={addType === 'option' ? 'NVDA' : 'AAPL'} maxLength={6}
                      className="w-full rounded-xl px-3 py-2.5 text-sm font-mono font-bold outline-none border"
                      style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                  </div>

                  {addType === 'stock' ? (
                    /* ── Stock fields ── */
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Shares</label>
                        <input value={addShares} onChange={e => setAddShares(e.target.value)} placeholder="100" type="number" min="0"
                          className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                          style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                      </div>
                      <div>
                        <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Avg cost per share ($)</label>
                        <input value={addCost} onChange={e => setAddCost(e.target.value)} placeholder="0.00" type="number" min="0"
                          className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                          style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                      </div>
                    </div>
                  ) : (
                    /* ── Option fields ── */
                    <div className="space-y-3">
                      {/* Call / Put */}
                      <div>
                        <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Type</label>
                        <div className="grid grid-cols-2 gap-2">
                          {(['call','put'] as const).map(ot => (
                            <button key={ot} onClick={() => setAddOptionType(ot)}
                              className="py-2 rounded-xl text-xs font-bold transition-all"
                              style={{
                                background: addOptionType === ot
                                  ? (ot === 'call' ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)')
                                  : 'rgba(255,255,255,0.04)',
                                color: addOptionType === ot
                                  ? (ot === 'call' ? '#34d399' : '#f87171')
                                  : 'rgba(255,255,255,0.35)',
                                border: `1px solid ${addOptionType === ot ? (ot === 'call' ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)') : 'rgba(255,255,255,0.08)'}`,
                              }}>
                              {ot.toUpperCase()}
                            </button>
                          ))}
                        </div>
                      </div>
                      {/* Strike + Expiry */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Strike price ($)</label>
                          <input value={addStrike} onChange={e => setAddStrike(e.target.value)} placeholder="195" type="number" min="0"
                            className="w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none border"
                            style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                        </div>
                        <div>
                          <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Expiry date</label>
                          <input value={addExpiry} onChange={e => setAddExpiry(e.target.value)} type="date"
                            className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                            style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                        </div>
                      </div>
                      {/* Contracts + Premium */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Contracts</label>
                          <input value={addContracts} onChange={e => setAddContracts(e.target.value)} placeholder="1" type="number" min="1"
                            className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                            style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                        </div>
                        <div>
                          <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Entry premium / share ($)</label>
                          <input value={addCost} onChange={e => setAddCost(e.target.value)} placeholder="2.50" type="number" min="0" step="0.01"
                            className="w-full rounded-xl px-3 py-2.5 text-sm font-mono outline-none border"
                            style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                        </div>
                      </div>
                      {/* Total cost preview */}
                      {addCost && addContracts && (
                        <div className="flex items-center justify-between rounded-lg px-3 py-2"
                          style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
                          <span className="text-[10px] text-white/40">Total cost</span>
                          <span className="text-sm font-bold font-mono" style={{ color: '#a78bfa' }}>
                            ${(parseFloat(addCost) * parseInt(addContracts) * 100).toFixed(2)}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button onClick={addPosition}
                      disabled={addLoading || !addTicker || (addType === 'stock' ? !addShares : !addStrike || !addExpiry)}
                      className="flex-1 py-2 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-40"
                      style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
                      {addLoading ? 'Adding...' : `Add ${addType === 'option' ? `${addOptionType.toUpperCase()} option` : 'position'}`}
                    </button>
                    <button onClick={() => setShowAdd(false)} className="px-4 py-2 rounded-xl text-sm transition-all hover:opacity-80"
                      style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' }}>Cancel</button>
                  </div>
                </div>
              )}

              {/* Health Check Results */}
              {checks.length > 0 && (
                <div className="space-y-2 mt-1">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-white/25">🩺 Position Health</span>
                    {checkedAt && <span className="text-[9px] text-white/20">{new Date(checkedAt).toLocaleTimeString()}</span>}
                  </div>
                  {checks.map(c => (
                    <div key={c.ticker} className="rounded-xl overflow-hidden" style={{ background: VERDICT_BG[c.verdict], border: `1px solid ${VERDICT_COLOR[c.verdict]}22` }}>
                      <div className="flex items-center gap-2.5 px-3 py-2.5">
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg min-w-[40px] text-center font-mono"
                          style={{ background: `${VERDICT_COLOR[c.verdict]}18`, color: VERDICT_COLOR[c.verdict] }}>
                          {c.verdict}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-bold font-mono text-sm">{c.ticker}</span>
                            {c.optionType && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded font-bold"
                                style={{ background: c.optionType === 'call' ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)', color: c.optionType === 'call' ? '#34d399' : '#f87171' }}>
                                {c.optionType.toUpperCase()} ${c.strike} {c.expiry?.slice(5)}
                              </span>
                            )}
                            <span className="text-[10px] font-mono" style={{ color: c.underlyingChange1D >= 0 ? '#34d399' : '#f87171' }}>
                              ${c.underlyingPrice} ({c.underlyingChange1D >= 0 ? '+' : ''}{c.underlyingChange1D}%)
                            </span>
                            {c.position_type === 'option' && c.optionPnlPct !== null && (
                              <span className="text-[10px] font-mono font-bold" style={{ color: c.optionPnlPct >= 0 ? '#34d399' : '#f87171' }}>
                                {c.optionPnlPct >= 0 ? '+' : ''}{c.optionPnlPct}% premium
                              </span>
                            )}
                            {c.position_type === 'stock' && c.pnlPct !== null && (
                              <span className="text-[10px] font-mono font-bold" style={{ color: c.pnlPct >= 0 ? '#34d399' : '#f87171' }}>
                                {c.pnlPct >= 0 ? '+' : ''}{c.pnlPct}% P&L
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-white/45 mt-0.5 leading-relaxed">{c.reason}</p>
                          {/* Options Greeks row */}
                          {c.position_type === 'option' && (c.delta !== null || c.theta !== null || c.impliedVolatility !== null) && (
                            <div className="flex gap-2 mt-1 flex-wrap">
                              {c.currentPremium !== null && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa' }}>
                                  ${c.currentPremium}
                                </span>
                              )}
                              {c.delta !== null && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(96,165,250,0.08)', color: '#60a5fa' }}>
                                  Δ {c.delta}
                                </span>
                              )}
                              {c.theta !== null && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(248,113,113,0.08)', color: '#f87171' }}>
                                  θ {c.theta}/d
                                </span>
                              )}
                              {c.impliedVolatility !== null && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(251,191,36,0.08)', color: '#fbbf24' }}>
                                  IV {(c.impliedVolatility*100).toFixed(0)}%
                                </span>
                              )}
                              {c.daysToExpiry !== null && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                                  style={{ background: c.timeDecayUrgent ? 'rgba(248,113,113,0.12)' : 'rgba(255,255,255,0.05)', color: c.timeDecayUrgent ? '#f87171' : 'rgba(255,255,255,0.35)' }}>
                                  {c.daysToExpiry}d left
                                </span>
                              )}
                              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded capitalize"
                                style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.3)' }}>
                                {c.moneyness?.replace('_', ' ')}
                              </span>
                            </div>
                          )}
                        </div>
                        <button onClick={() => runHealthCheck(c.ticker)} disabled={checkTicker === c.ticker}
                          className="shrink-0 p-1.5 rounded-lg hover:opacity-80 disabled:opacity-30 transition-opacity"
                          style={{ color: 'rgba(255,255,255,0.2)' }}>
                          {checkTicker === c.ticker
                            ? <div className="w-3 h-3 rounded-full border border-t-white/60 border-white/20 animate-spin" />
                            : <RefreshCw size={12} />}
                        </button>
                      </div>
                      {/* Action */}
                      <div className="px-3 pb-2">
                        <p className="text-[10px] font-semibold" style={{ color: VERDICT_COLOR[c.verdict] }}>
                          → {c.action}
                        </p>
                      </div>
                      {/* Flags */}
                      {c.flags.length > 0 && (
                        <div className="px-3 pb-2.5 flex flex-wrap gap-1">
                          {c.flags.map(f => (
                            <span key={f} className="text-[9px] px-1.5 py-0.5 rounded-full font-mono"
                              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.35)', border: '1px solid rgba(255,255,255,0.08)' }}>
                              {f}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Empty state */}
              {!loadingHoldings && positions.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
                  <div className="text-5xl opacity-40">💼</div>
                  <div className="text-lg font-bold text-white/70">No positions yet</div>
                  <p className="text-sm text-white/40 max-w-sm">Add your holdings to get AI portfolio analysis — concentration risk, earnings events, and rebalancing suggestions.</p>
                  <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-white mt-2"
                    style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
                    <Plus size={14} /> Add your first position
                  </button>
                </div>
              )}

              {/* Positions list */}
              {positions.length > 0 && (
                <div className="rounded-2xl border overflow-hidden" style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}>
                  <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
                    <span className="text-xs font-bold text-white/60 uppercase tracking-wider">Holdings</span>
                    {totalValue > 0 && <span className="text-xs font-mono text-white/40">Total: {fmtK(totalValue)}</span>}
                  </div>
                  <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                    {positions.map(pos => {
                      const data = positionData.find(p => p.ticker === pos.ticker)
                      const signalColor = data ? SIG_COLOR[data.signal] : 'rgba(255,255,255,0.3)'
                      const isOption = pos.position_type === 'option'
                      const daysToExpiry = pos.expiry ? Math.ceil((new Date(pos.expiry).getTime() - Date.now()) / 86400000) : null
                      const expiryUrgent = daysToExpiry !== null && daysToExpiry <= 7
                      const expiryExpired = daysToExpiry !== null && daysToExpiry < 0
                      return (
                        <div key={pos.id} className="flex items-center gap-3 px-5 py-3.5"
                          style={{ borderLeft: isOption ? `2px solid ${pos.option_type === 'call' ? 'rgba(52,211,153,0.4)' : 'rgba(248,113,113,0.4)'}` : 'none' }}>
                          <div className="flex-1 min-w-0">
                            {/* Row 1: ticker + badges */}
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono font-bold text-sm">{pos.ticker}</span>

                              {isOption ? (
                                /* Option badge */
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                                  style={{ background: pos.option_type === 'call' ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)', color: pos.option_type === 'call' ? '#34d399' : '#f87171' }}>
                                  {pos.option_type?.toUpperCase()} ${pos.strike}
                                </span>
                              ) : (
                                /* Stock: shares count */
                                <span className="text-xs text-white/40">{pos.shares} shares</span>
                              )}

                              {isOption && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                                  style={{ background: expiryExpired ? 'rgba(248,113,113,0.15)' : expiryUrgent ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.06)', color: expiryExpired ? '#f87171' : expiryUrgent ? '#ef4444' : 'rgba(255,255,255,0.4)' }}>
                                  {expiryExpired ? 'EXPIRED' : `${daysToExpiry}d · ${pos.expiry}`}
                                </span>
                              )}

                              {!isOption && pos.avg_cost && (
                                <span className="text-[10px] text-white/30">@ ${pos.avg_cost.toFixed(2)}</span>
                              )}
                              {data && !isOption && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: `${signalColor}15`, color: signalColor }}>{data.signal}</span>}
                              {data?.daysToEarnings != null && data.daysToEarnings <= 14 && (
                                <span className="text-[10px] font-mono" style={{ color: '#fbbf24' }}>⚡ earnings {data.daysToEarnings}d</span>
                              )}
                            </div>

                            {/* Row 2: price / option details */}
                            {isOption ? (
                              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                <span className="text-[10px] text-white/40">{pos.contracts || 1} contract{(pos.contracts || 1) > 1 ? 's' : ''}</span>
                                {pos.entry_premium && (
                                  <span className="text-[10px] font-mono text-white/40">entry ${pos.entry_premium.toFixed(2)}/sh · cost ${(pos.entry_premium * (pos.contracts || 1) * 100).toFixed(0)}</span>
                                )}
                                {data && (
                                  <span className="text-[10px] font-mono" style={{ color: data.priceChange1D >= 0 ? '#34d399' : '#f87171' }}>
                                    underlying ${fmt(data.currentPrice)} ({pct(data.priceChange1D)})
                                  </span>
                                )}
                              </div>
                            ) : (
                              data && (
                                <div className="flex items-center gap-3 mt-0.5">
                                  <span className="text-xs font-mono text-white/60">${fmt(data.currentPrice)}</span>
                                  <span className="text-[10px] font-mono" style={{ color: data.priceChange1D >= 0 ? '#34d399' : '#f87171' }}>{pct(data.priceChange1D)} today</span>
                                  <span className="text-[10px] text-white/40">{fmtK(data.marketValue)}</span>
                                  {data.gainLossPct !== null && <span className="text-[10px] font-mono" style={{ color: data.gainLossPct >= 0 ? '#34d399' : '#f87171' }}>{pct(data.gainLossPct)} P&L</span>}
                                </div>
                              )
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            <button onClick={() => router.push(`/?ticker=${pos.ticker}`)}
                              className="text-[10px] font-mono px-2 py-1 rounded-lg transition-all hover:opacity-80"
                              style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
                              Analyze
                            </button>
                            <button onClick={() => removePosition(pos.ticker)} className="p-1.5 rounded-lg hover:opacity-80" style={{ background: 'rgba(248,113,113,0.08)', color: '#f87171' }}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Analyzing spinner */}
              {analyzing && (
                <div className="flex items-center gap-3 px-5 py-4 rounded-2xl"
                  style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.2)' }}>
                  <div className="flex gap-1">{[0,1,2].map(i => <span key={i} className="w-1.5 h-1.5 rounded-full thinking-dot" style={{ background: '#a78bfa', animationDelay: `${i*0.15}s` }} />)}</div>
                  <span className="text-sm text-white/60 font-mono">{statusMsg}</span>
                </div>
              )}

              {/* Analysis results */}
              {metrics && analysis && (
                <>
                  <div className="rounded-2xl p-5 border-2"
                    style={{ background: `${SIG_COLOR[analysis.overallSignal]}05`, borderColor: `${SIG_COLOR[analysis.overallSignal]}30` }}>
                    <div className="flex items-start justify-between gap-4 mb-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-bold" style={{ color: SIG_COLOR[analysis.overallSignal] }}>
                            {analysis.overallSignal === 'BULLISH' ? <TrendingUp size={16} className="inline mr-1" /> : analysis.overallSignal === 'BEARISH' ? <TrendingDown size={16} className="inline mr-1" /> : <Minus size={16} className="inline mr-1" />}
                            {analysis.overallSignal}
                          </span>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)' }}>{analysis.overallConviction} conviction</span>
                        </div>
                        <h2 className="text-base font-bold text-white leading-snug">{analysis.headline}</h2>
                      </div>
                      <div className="text-center shrink-0">
                        <div className="text-3xl font-bold font-mono" style={{ color: analysis.portfolioScore >= 60 ? '#34d399' : analysis.portfolioScore >= 40 ? '#fbbf24' : '#f87171' }}>{analysis.portfolioScore}</div>
                        <div className="text-[10px] font-mono text-white/30">score /100</div>
                      </div>
                    </div>
                    <p className="text-sm text-white/70 leading-relaxed">{analysis.summary}</p>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { label: 'Portfolio Value', val: fmtK(metrics.totalValue), color: 'white' },
                      { label: 'Total P&L', val: `${metrics.totalGainLoss >= 0 ? '+' : ''}${fmtK(Math.abs(metrics.totalGainLoss))} (${pct(metrics.totalGainLossPct)})`, color: metrics.totalGainLoss >= 0 ? '#34d399' : '#f87171' },
                      { label: 'Signals', val: `${metrics.signals.BULLISH}B · ${metrics.signals.NEUTRAL}N · ${metrics.signals.BEARISH}Be`, color: 'white' },
                      { label: 'Earnings 30d', val: `${metrics.upcomingEarnings.length} positions`, color: metrics.upcomingEarnings.length > 0 ? '#fbbf24' : '#34d399' },
                    ].map(m => (
                      <div key={m.label} className="rounded-xl p-3.5 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.07)' }}>
                        <div className="text-[10px] font-mono text-white/30 mb-1">{m.label}</div>
                        <div className="text-sm font-bold font-mono" style={{ color: m.color }}>{m.val}</div>
                      </div>
                    ))}
                  </div>

                  {analysis.topRisks.length > 0 && (
                    <Section title="Top Risks" icon={<AlertTriangle size={14} />} color="#f87171">
                      <div className="space-y-2.5">
                        {analysis.topRisks.map((r, i) => (
                          <div key={i} className="flex items-start gap-3">
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 mt-0.5" style={{ background: `${SEV_COLOR[r.severity]}15`, color: SEV_COLOR[r.severity] }}>{r.severity}</span>
                            <div>
                              <p className="text-sm text-white/70">{r.risk}</p>
                              <div className="flex gap-1 mt-1">{r.tickers.map(t => <span key={t} className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' }}>{t}</span>)}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}

                  {analysis.opportunities.length > 0 && (
                    <Section title="Opportunities" icon={<TrendingUp size={14} />} color="#34d399">
                      <div className="space-y-2.5">
                        {analysis.opportunities.map((o, i) => (
                          <div key={i} className="flex items-start gap-3">
                            <span style={{ color: '#34d399' }}>▶</span>
                            <div>
                              <p className="text-sm text-white/70">{o.opportunity}</p>
                              <div className="flex gap-1 mt-1">{o.tickers.map(t => <span key={t} className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(52,211,153,0.1)', color: '#34d399' }}>{t}</span>)}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Section title="Sector Concentration" icon={<BarChart2 size={14} />} color="#a78bfa">
                      <div className="space-y-2 mb-3">
                        {metrics.sectorConcentration.slice(0, 5).map(s => (
                          <div key={s.sector}>
                            <div className="flex justify-between text-xs mb-1">
                              <span className="text-white/60">{s.sector}</span>
                              <span className="font-mono text-white/80">{s.pct.toFixed(1)}%</span>
                            </div>
                            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                              <div className="h-full rounded-full" style={{ width: `${s.pct}%`, background: s.pct > 40 ? '#f87171' : s.pct > 25 ? '#fbbf24' : '#a78bfa' }} />
                            </div>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-white/50 leading-relaxed">{analysis.sectorAnalysis}</p>
                    </Section>
                    <Section title="Earnings Watch" icon={<Calendar size={14} />} color="#fbbf24">
                      {metrics.upcomingEarnings.length === 0 ? <p className="text-sm text-white/40">No earnings in the next 30 days</p> : (
                        <div className="space-y-2 mb-3">
                          {metrics.upcomingEarnings.map(p => (
                            <div key={p.ticker} className="flex items-center justify-between">
                              <span className="font-mono font-bold text-sm">{p.ticker}</span>
                              <span className="text-xs font-mono" style={{ color: (p.daysToEarnings ?? 99) <= 7 ? '#f87171' : '#fbbf24' }}>{p.earningsDate} ({p.daysToEarnings}d)</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <p className="text-xs text-white/50 leading-relaxed">{analysis.earningsWatch}</p>
                    </Section>
                  </div>

                  <Section title="Action Plan" icon={<DollarSign size={14} />} color="#34d399">
                    <p className="text-sm text-white/70 leading-relaxed mb-3">{analysis.actionPlan}</p>
                    <div className="rounded-xl p-3.5" style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
                      <div className="text-[10px] font-mono uppercase tracking-widest text-white/30 mb-1.5">Rebalancing suggestions</div>
                      <p className="text-xs text-white/60 leading-relaxed">{analysis.rebalancingSuggestions}</p>
                    </div>
                  </Section>
                  <p className="text-[10px] text-white/15 text-center pb-4">Portfolio analysis is for informational purposes only. Not financial advice.</p>
                </>
              )}
            </>
          )}

          {/* ── DIVIDENDS TAB ─────────────────────────────────────────────── */}
          {tab === 'dividends' && (
            <>
              {/* Stats row */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Total Received', val: `$${totalDividends.toFixed(2)}`, color: '#34d399' },
                  { label: 'Reinvested', val: `$${reinvestedDividends.toFixed(2)}`, color: '#a78bfa' },
                  { label: 'Cash Kept', val: `$${(totalDividends - reinvestedDividends).toFixed(2)}`, color: '#fbbf24' },
                ].map(s => (
                  <div key={s.label} className="rounded-xl p-3 border" style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}>
                    <div className="text-[10px] font-mono text-white/30 mb-1">{s.label}</div>
                    <div className="text-sm font-bold font-mono" style={{ color: s.color }}>{s.val}</div>
                  </div>
                ))}
              </div>

              {/* Upcoming dividends from portfolio */}
              {divSchedule.length > 0 && (
                <div className="rounded-2xl border overflow-hidden" style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}>
                  <div className="px-4 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
                    <span className="text-xs font-bold text-white/60 uppercase tracking-wider">📅 Upcoming Dividends</span>
                  </div>
                  <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                    {divSchedule.slice(0, 10).map((d, i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-3">
                        <span className="font-mono font-bold text-sm">{d.ticker}</span>
                        <span className="text-xs text-white/50">Ex: {d.ex_date}</span>
                        {d.pay_date && <span className="text-xs text-white/40">Pay: {d.pay_date}</span>}
                        {d.amount && <span className="text-xs font-mono" style={{ color: '#34d399' }}>${d.amount.toFixed(4)}/share</span>}
                        {d.frequency && <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa' }}>{d.frequency}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Log dividend form */}
              {showLogDiv && (
                <div className="rounded-2xl border p-5" style={{ background: '#111620', borderColor: 'rgba(52,211,153,0.25)' }}>
                  <h3 className="text-sm font-bold text-white mb-4">Log dividend received</h3>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Ticker</label>
                      <input value={divTicker} onChange={e => setDivTicker(e.target.value.toUpperCase())} placeholder="AAPL"
                        className="w-full rounded-xl px-3 py-2.5 text-sm font-mono font-bold outline-none border"
                        style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Amount per share ($)</label>
                      <input value={divAmount} onChange={e => setDivAmount(e.target.value)} placeholder="0.24" type="number" step="0.0001"
                        className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                        style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Shares held</label>
                      <input value={divShares} onChange={e => setDivShares(e.target.value)} placeholder="100" type="number"
                        className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                        style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Ex-dividend date</label>
                      <input value={divExDate} onChange={e => setDivExDate(e.target.value)} type="date"
                        className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                        style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Pay date (optional)</label>
                      <input value={divPayDate} onChange={e => setDivPayDate(e.target.value)} type="date"
                        className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                        style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                    </div>
                    <div className="flex items-end">
                      {divAmount && divShares && (
                        <div className="rounded-xl p-3 w-full" style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)' }}>
                          <div className="text-[10px] text-white/40">Total received</div>
                          <div className="text-sm font-bold font-mono" style={{ color: '#34d399' }}>
                            ${(parseFloat(divAmount || '0') * parseFloat(divShares || '0')).toFixed(2)}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Reinvestment toggle */}
                  <div className="flex items-center gap-3 mb-3 p-3 rounded-xl" style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
                    <button onClick={() => setDivReinvested(!divReinvested)}
                      className="flex items-center gap-2 text-sm font-semibold transition-all"
                      style={{ color: divReinvested ? '#a78bfa' : 'rgba(255,255,255,0.4)' }}>
                      <Repeat2 size={14} />
                      {divReinvested ? 'Reinvested ✓' : 'Reinvest this dividend?'}
                    </button>
                  </div>
                  {divReinvested && (
                    <div className="grid grid-cols-2 gap-3 mb-3">
                      <div>
                        <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Shares purchased</label>
                        <input value={divReinvestShares} onChange={e => setDivReinvestShares(e.target.value)} placeholder="1.2" type="number" step="0.0001"
                          className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                          style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                      </div>
                      <div>
                        <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Price paid per share</label>
                        <input value={divReinvestPrice} onChange={e => setDivReinvestPrice(e.target.value)} placeholder="185.00" type="number"
                          className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                          style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                      </div>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button onClick={saveDiv} disabled={savingDiv || !divTicker || !divAmount || !divShares || !divExDate}
                      className="px-4 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                      style={{ background: 'linear-gradient(135deg,#059669,#065f46)' }}>
                      {savingDiv ? 'Saving...' : 'Save dividend'}
                    </button>
                    <button onClick={() => setShowLogDiv(false)} className="px-4 py-2 rounded-xl text-sm"
                      style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' }}>Cancel</button>
                  </div>
                </div>
              )}

              {/* Dividend history */}
              {loadingDividends && <div className="text-center py-10 text-white/30 text-sm">Loading dividends...</div>}
              {!loadingDividends && dividends.length === 0 && !showLogDiv && (
                <div className="flex flex-col items-center py-16 gap-3 text-center">
                  <div className="text-4xl opacity-40">💵</div>
                  <div className="text-base font-bold text-white/60">No dividends logged yet</div>
                  <p className="text-sm text-white/35 max-w-xs">Track dividends you receive and whether you reinvested them. Wali-OS will fetch upcoming dividend dates for your portfolio automatically.</p>
                  <button onClick={() => setShowLogDiv(true)} className="flex items-center gap-2 px-4 py-2 rounded-xl font-semibold text-white mt-1"
                    style={{ background: 'linear-gradient(135deg,#059669,#065f46)' }}>
                    <Plus size={13} /> Log first dividend
                  </button>
                </div>
              )}
              {dividends.length > 0 && (
                <div className="rounded-2xl border overflow-hidden" style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}>
                  <div className="px-4 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
                    <span className="text-xs font-bold text-white/60 uppercase tracking-wider">Dividend History</span>
                  </div>
                  <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                    {dividends.map(d => (
                      <div key={d.id} className="flex items-center gap-3 px-4 py-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-bold text-sm">{d.ticker}</span>
                            <span className="text-xs text-white/40">{d.ex_date}</span>
                            <span className="text-xs font-mono" style={{ color: '#34d399' }}>${d.total_received.toFixed(2)}</span>
                            <span className="text-[10px] text-white/30">(${d.amount_per_share.toFixed(4)}/sh × {d.shares_held} shares)</span>
                            {d.reinvested && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-mono font-bold" style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
                                DRIP {d.reinvest_shares ? `+${d.reinvest_shares} shares` : ''}
                              </span>
                            )}
                          </div>
                        </div>
                        <button onClick={() => deleteDiv(d.id)} className="p-1.5 rounded-lg hover:opacity-80" style={{ color: 'rgba(248,113,113,0.4)' }}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── REINVEST TAB ──────────────────────────────────────────────── */}
          {tab === 'reinvest' && (
            <>
              {/* Stats */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Open Trades', val: `${openReinvestTrades.length}`, color: '#a78bfa' },
                  { label: 'Realized P&L', val: `${realizedReinvestPnL >= 0 ? '+' : ''}$${realizedReinvestPnL.toFixed(2)}`, color: realizedReinvestPnL >= 0 ? '#34d399' : '#f87171' },
                  { label: 'Dividend Capital', val: `$${reinvestedDividends.toFixed(2)}`, color: '#fbbf24' },
                ].map(s => (
                  <div key={s.label} className="rounded-xl p-3 border" style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}>
                    <div className="text-[10px] font-mono text-white/30 mb-1">{s.label}</div>
                    <div className="text-sm font-bold font-mono" style={{ color: s.color }}>{s.val}</div>
                  </div>
                ))}
              </div>

              {/* Portfolio sync chips — quick-add from holdings */}
              {positions.length > 0 && (
                <div className="rounded-xl p-3 border" style={{ background: 'rgba(251,191,36,0.04)', borderColor: 'rgba(251,191,36,0.15)' }}>
                  <div className="text-[10px] font-mono text-white/25 uppercase tracking-wider mb-2">Your holdings — tap to prefill</div>
                  <div className="flex flex-wrap gap-1.5">
                    {positions.map(p => {
                      const alreadyTracked = reinvestTrades.some(t => t.ticker === p.ticker && !t.exit_price)
                      return (
                        <button key={p.ticker}
                          onClick={() => { setRTicker(p.ticker); setShowAddReinvest(true) }}
                          className="px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold transition-all"
                          style={{
                            background: alreadyTracked ? 'rgba(52,211,153,0.1)' : 'rgba(255,255,255,0.06)',
                            color: alreadyTracked ? '#34d399' : 'rgba(255,255,255,0.5)',
                            border: `1px solid ${alreadyTracked ? 'rgba(52,211,153,0.2)' : 'rgba(255,255,255,0.08)'}`,
                          }}>
                          {alreadyTracked ? '✓ ' : ''}{p.ticker}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Add reinvest trade form */}
              {showAddReinvest && (
                <div className="rounded-2xl border p-5" style={{ background: '#111620', borderColor: 'rgba(251,191,36,0.25)' }}>
                  <h3 className="text-sm font-bold mb-4">Log reinvestment trade</h3>
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    <div>
                      <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Ticker</label>
                      <input value={rTicker} onChange={e => setRTicker(e.target.value.toUpperCase())} placeholder="NVDA"
                        className="w-full rounded-xl px-3 py-2.5 text-sm font-mono font-bold outline-none border"
                        style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Shares</label>
                      <input value={rShares} onChange={e => setRShares(e.target.value)} placeholder="5" type="number"
                        className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                        style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                    </div>
                    <div>
                      <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Entry price</label>
                      <input value={rEntry} onChange={e => setREntry(e.target.value)} placeholder="185.00" type="number"
                        className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                        style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                    </div>
                  </div>
                  <div className="mb-3">
                    <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Notes (optional)</label>
                    <input value={rNotes} onChange={e => setRNotes(e.target.value)} placeholder="e.g. AAPL dividend reinvestment"
                      className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                      style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={addReinvestTrade} disabled={savingReinvest || !rTicker || !rShares || !rEntry}
                      className="px-4 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                      style={{ background: 'linear-gradient(135deg,#b45309,#92400e)' }}>
                      {savingReinvest ? 'Saving...' : 'Add trade'}
                    </button>
                    <button onClick={() => setShowAddReinvest(false)} className="px-4 py-2 rounded-xl text-sm"
                      style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' }}>Cancel</button>
                  </div>
                </div>
              )}

              {loadingReinvest && <div className="text-center py-10 text-white/30 text-sm">Loading...</div>}
              {!loadingReinvest && reinvestTrades.length === 0 && (
                <div className="flex flex-col items-center py-16 gap-3 text-center">
                  <div className="text-4xl opacity-40">🔄</div>
                  <div className="text-base font-bold text-white/60">No reinvestment trades yet</div>
                  <p className="text-sm text-white/35 max-w-xs">Log trades you make using dividend income. Track how your reinvestment capital is performing separately from your main portfolio.</p>
                </div>
              )}
              {reinvestTrades.length > 0 && (
                <div className="rounded-2xl border overflow-hidden" style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}>
                  <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                    {reinvestTrades.map(t => {
                      const isOpen = !t.exit_price
                      const pnlColor = (t.pnl ?? 0) >= 0 ? '#34d399' : '#f87171'
                      return (
                        <div key={t.id} className="flex items-center gap-3 px-4 py-3.5">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono font-bold text-sm">{t.ticker}</span>
                              <span className="text-xs text-white/40">{t.shares} shares @ ${t.entry_price.toFixed(2)}</span>
                              {isOpen ? (
                                <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'rgba(52,211,153,0.1)', color: '#34d399' }}>OPEN</span>
                              ) : (
                                <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)' }}>CLOSED</span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 mt-0.5">
                              {t.currentPrice && <span className="text-xs font-mono text-white/50">${t.currentPrice.toFixed(2)}</span>}
                              {t.pnl != null && <span className="text-[10px] font-mono" style={{ color: pnlColor }}>{t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}</span>}
                              {t.pnlPct != null && <span className="text-[10px] font-mono" style={{ color: pnlColor }}>{t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(1)}%</span>}
                              {t.notes && <span className="text-[10px] text-white/30 truncate max-w-[120px]">{t.notes}</span>}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button onClick={() => router.push(`/?ticker=${t.ticker}`)}
                              className="text-[10px] font-mono px-2 py-1 rounded-lg" style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
                              Analyze
                            </button>
                            <button onClick={() => deleteReinvestTrade(t.id)} className="p-1.5 rounded-lg hover:opacity-80" style={{ color: 'rgba(248,113,113,0.4)' }}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── JOURNAL TAB ───────────────────────────────────────────────── */}
          {tab === 'journal' && (
            <>
              {/* Stats */}
              {journalStats.totalTrades > 0 && (
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Win Rate', val: journalStats.winRate != null ? `${journalStats.winRate.toFixed(0)}%` : '—', color: (journalStats.winRate ?? 0) >= 50 ? '#34d399' : '#f87171' },
                    { label: 'Avg P&L', val: journalStats.avgPnl != null ? `${journalStats.avgPnl >= 0 ? '+' : ''}${journalStats.avgPnl.toFixed(1)}%` : '—', color: (journalStats.avgPnl ?? 0) >= 0 ? '#34d399' : '#f87171' },
                    { label: 'Total Trades', val: `${journalStats.totalTrades}`, color: 'white' },
                  ].map(s => (
                    <div key={s.label} className="rounded-xl p-3 border" style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}>
                      <div className="text-[10px] font-mono text-white/30 mb-1">{s.label}</div>
                      <div className="text-sm font-bold font-mono" style={{ color: s.color }}>{s.val}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Manual add journal entry */}
              <button onClick={() => setShowAddJournal(!showAddJournal)}
                className="w-full py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5"
                style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)', color: '#a78bfa' }}>
                <Plus size={13} /> Log Trade Manually
              </button>

              {showAddJournal && (
                <div className="rounded-2xl p-4 space-y-3" style={{ background: '#111620', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <div className="text-xs font-semibold text-white/50">Log a trade manually</div>
                  {/* Stock vs Option */}
                  <div className="grid grid-cols-2 gap-2">
                    {(['stock','option'] as const).map(t => (
                      <button key={t} onClick={() => setJType(t)}
                        className="py-1.5 rounded-lg text-xs font-semibold"
                        style={{ background: jType === t ? 'rgba(167,139,250,0.15)' : 'rgba(255,255,255,0.04)', color: jType === t ? '#a78bfa' : 'rgba(255,255,255,0.4)', border: `1px solid ${jType === t ? 'rgba(167,139,250,0.3)' : 'rgba(255,255,255,0.08)'}` }}>
                        {t === 'stock' ? '📈 Stock' : '⚡ Option'}
                      </button>
                    ))}
                  </div>
                  {/* Ticker + Signal */}
                  <div className="grid grid-cols-2 gap-2">
                    <input value={jTicker} onChange={e => setJTicker(e.target.value.toUpperCase())} placeholder="Ticker"
                      className="rounded-xl px-3 py-2 text-sm outline-none border" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                    <select value={jSignal} onChange={e => setJSignal(e.target.value as any)}
                      className="rounded-xl px-3 py-2 text-sm outline-none border" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }}>
                      <option value="BULLISH">BULLISH</option>
                      <option value="BEARISH">BEARISH</option>
                      <option value="NEUTRAL">NEUTRAL</option>
                    </select>
                  </div>
                  {/* Options-specific fields */}
                  {jType === 'option' && (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        {(['call','put'] as const).map(ot => (
                          <button key={ot} onClick={() => setJOptionType(ot)}
                            className="py-1.5 rounded-lg text-xs font-bold"
                            style={{ background: jOptionType === ot ? (ot === 'call' ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)') : 'rgba(255,255,255,0.04)', color: jOptionType === ot ? (ot === 'call' ? '#34d399' : '#f87171') : 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}>
                            {ot.toUpperCase()}
                          </button>
                        ))}
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <input value={jStrike} onChange={e => setJStrike(e.target.value)} placeholder="Strike $" type="number"
                          className="rounded-xl px-3 py-2 text-sm outline-none border" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                        <input value={jExpiry} onChange={e => setJExpiry(e.target.value)} placeholder="Expiry" type="date"
                          className="rounded-xl px-3 py-2 text-sm outline-none border" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                        <input value={jContracts} onChange={e => setJContracts(e.target.value)} placeholder="Contracts" type="number"
                          className="rounded-xl px-3 py-2 text-sm outline-none border" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                      </div>
                      <input value={jPremium} onChange={e => setJPremium(e.target.value)} placeholder="Entry premium per share ($)" type="number"
                        className="w-full rounded-xl px-3 py-2 text-sm outline-none border" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                      {jPremium && jContracts && (
                        <div className="text-[10px] text-white/40 text-center">
                          Total cost: <span style={{ color: '#a78bfa' }}>${(parseFloat(jPremium) * parseInt(jContracts) * 100).toFixed(2)}</span>
                        </div>
                      )}
                    </div>
                  )}
                  {/* Stock-specific fields */}
                  {jType === 'stock' && (
                    <div className="grid grid-cols-3 gap-2">
                      <input value={jEntryPrice} onChange={e => setJEntryPrice(e.target.value)} placeholder="Entry $" type="number"
                        className="rounded-xl px-3 py-2 text-sm outline-none border" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                      <input value={jStop} onChange={e => setJStop(e.target.value)} placeholder="Stop $" type="number"
                        className="rounded-xl px-3 py-2 text-sm outline-none border" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                      <input value={jTarget} onChange={e => setJTarget(e.target.value)} placeholder="Target $" type="number"
                        className="rounded-xl px-3 py-2 text-sm outline-none border" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                    </div>
                  )}
                  {/* Timeframe + notes */}
                  <div className="grid grid-cols-2 gap-2">
                    <select value={jTimeframe} onChange={e => setJTimeframe(e.target.value)}
                      className="rounded-xl px-3 py-2 text-sm outline-none border" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }}>
                      <option value="1D">1D</option><option value="1W">1W</option>
                      <option value="1M">1M</option><option value="3M">3M</option>
                    </select>
                    <input value={jNotes} onChange={e => setJNotes(e.target.value)} placeholder="Notes (optional)"
                      className="rounded-xl px-3 py-2 text-sm outline-none border" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={addJournalEntry}
                      className="flex-1 py-2 rounded-xl text-xs font-bold"
                      style={{ background: 'rgba(167,139,250,0.2)', color: '#a78bfa' }}>Log Trade</button>
                    <button onClick={() => setShowAddJournal(false)} className="px-4 py-2 rounded-xl text-xs text-white/40">Cancel</button>
                  </div>
                </div>
              )}

              {/* Portfolio sync chips — shows which holdings have journal entries */}
              {!loadingJournal && positions.length > 0 && (
                <div className="rounded-xl p-3 border" style={{ background: 'rgba(167,139,250,0.04)', borderColor: 'rgba(167,139,250,0.15)' }}>
                  <div className="text-[10px] font-mono text-white/25 uppercase tracking-wider mb-2">Holdings — journal coverage</div>
                  <div className="flex flex-wrap gap-1.5">
                    {positions.map(p => {
                      const hasEntry = journalEntries.some(e => e.ticker === p.ticker)
                      const openEntry = journalEntries.find(e => e.ticker === p.ticker && e.outcome === 'pending')
                      return (
                        <button key={p.ticker}
                          onClick={() => router.push(`/?ticker=${p.ticker}`)}
                          className="px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold transition-all"
                          style={{
                            background: openEntry ? 'rgba(251,191,36,0.1)' : hasEntry ? 'rgba(52,211,153,0.1)' : 'rgba(255,255,255,0.06)',
                            color: openEntry ? '#fbbf24' : hasEntry ? '#34d399' : 'rgba(255,255,255,0.4)',
                            border: `1px solid ${openEntry ? 'rgba(251,191,36,0.2)' : hasEntry ? 'rgba(52,211,153,0.2)' : 'rgba(255,255,255,0.08)'}`,
                          }}
                          title={openEntry ? 'Open trade' : hasEntry ? 'Has journal entries' : 'No journal entry — analyze to add'}>
                          {openEntry ? '⏳ ' : hasEntry ? '✓ ' : ''}{p.ticker}
                        </button>
                      )
                    })}
                  </div>
                  <div className="text-[9px] text-white/20 mt-1.5">✓ journaled • ⏳ open trade • gray = not yet tracked</div>
                </div>
              )}

              {loadingJournal && <div className="text-center py-10 text-white/30 text-sm">Loading journal...</div>}
              {!loadingJournal && journalEntries.length === 0 && (
                <div className="flex flex-col items-center py-16 gap-3 text-center">
                  <div className="text-4xl opacity-40">📒</div>
                  <div className="text-base font-bold text-white/60">No journal entries yet</div>
                  <p className="text-sm text-white/35 max-w-xs">After running a council analysis, tap the verdict dropdown and select "Log to Journal" to track your trades here.</p>
                </div>
              )}

              {journalEntries.map(entry => {
                const isOpen = entry.outcome === 'pending'
                const isExpanded = expandedEntry === entry.id
                const signalColor = SIG_COLOR[entry.signal] || '#94a3b8'
                return (
                  <div key={entry.id} className="rounded-2xl border overflow-hidden" style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}>
                    <div className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                      onClick={() => setExpandedEntry(isExpanded ? null : entry.id)}>
                      <div className="flex items-center gap-1.5">
                        {outcomeIcon(entry.outcome)}
                        <span className="font-bold font-mono text-sm">{entry.ticker}</span>
                        {entry.position_type === 'option' && entry.option_type && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded font-bold"
                            style={{ background: entry.option_type === 'call' ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)', color: entry.option_type === 'call' ? '#34d399' : '#f87171' }}>
                            {entry.option_type.toUpperCase()} ${entry.strike} {entry.expiry?.slice(0,10)}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: `${signalColor}15`, color: signalColor }}>{entry.signal}</span>
                      {entry.pnl_percent != null && (
                        <span className="text-xs font-mono" style={{ color: entry.pnl_percent >= 0 ? '#34d399' : '#f87171' }}>
                          {entry.pnl_percent >= 0 ? '+' : ''}{entry.pnl_percent.toFixed(1)}%
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-2">
                        {entry.postmortem?.council_grade && (
                          <span className="text-xs font-bold w-6 h-6 rounded-full flex items-center justify-center text-[10px]"
                            style={{ background: `${gradeColor(entry.postmortem.council_grade)}20`, color: gradeColor(entry.postmortem.council_grade) }}>
                            {entry.postmortem.council_grade}
                          </span>
                        )}
                        <span className="text-[10px] text-white/25 font-mono">{entry.timeframe}</span>
                        <button onClick={e => { e.stopPropagation(); handleDeleteJournal(entry.id) }}
                          className="p-1 rounded-lg hover:opacity-80" style={{ color: 'rgba(248,113,113,0.4)' }}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-4 pb-4 space-y-3 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                        <div className="grid grid-cols-3 gap-2 pt-3">
                          {(entry.position_type === 'option' ? [
                            { label: 'Premium', val: entry.entry_premium ? `$${entry.entry_premium.toFixed(2)}/sh` : '—' },
                            { label: 'Contracts', val: entry.contracts ? `${entry.contracts}x` : '1x' },
                            { label: 'Total Cost', val: entry.entry_premium && entry.contracts ? `$${(entry.entry_premium * entry.contracts * 100).toFixed(0)}` : '—' },
                          ] : [
                            { label: 'Entry', val: entry.entry_price ? `$${entry.entry_price.toFixed(2)}` : '—' },
                            { label: 'Stop', val: entry.stop_loss ? `$${entry.stop_loss.toFixed(2)}` : '—' },
                            { label: 'Target', val: entry.take_profit ? `$${entry.take_profit.toFixed(2)}` : '—' },
                          ]).map(f => (
                            <div key={f.label} className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.03)' }}>
                              <div className="text-[10px] text-white/30 mb-0.5">{f.label}</div>
                              <div className="text-sm font-mono font-bold">{f.val}</div>
                            </div>
                          ))}
                        </div>

                        {entry.notes && <p className="text-xs text-white/50 leading-relaxed">{entry.notes}</p>}

                        {entry.postmortem && (
                          <div className="rounded-xl p-3 space-y-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
                            <div className="flex items-center gap-2">
                              <Star size={11} style={{ color: gradeColor(entry.postmortem.council_grade) }} />
                              <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: gradeColor(entry.postmortem.council_grade) }}>
                                Grade {entry.postmortem.council_grade} — Post-mortem
                              </span>
                            </div>
                            {[
                              { label: 'What worked', val: entry.postmortem.what_worked },
                              { label: 'What missed', val: entry.postmortem.what_missed },
                              { label: 'Key lesson', val: entry.postmortem.key_lesson },
                            ].map(f => (
                              <div key={f.label}>
                                <div className="text-[9px] font-mono uppercase text-white/25 mb-0.5">{f.label}</div>
                                <p className="text-xs text-white/60 leading-relaxed">{f.val}</p>
                              </div>
                            ))}
                          </div>
                        )}

                        {isOpen && (
                          <div className="rounded-xl p-3 space-y-3" style={{ background: 'rgba(52,211,153,0.05)', border: '1px solid rgba(52,211,153,0.15)' }}>
                            <p className="text-xs font-semibold" style={{ color: '#34d399' }}>Resolve trade</p>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-[10px] text-white/30 block mb-1">
                                  {entry.position_type === 'option' ? 'Exit premium/share ($)' : 'Exit price ($)'}
                                </label>
                                {entry.position_type === 'option' ? (
                                  <input value={resolveData.exit_premium} onChange={e => setResolveData(d => ({ ...d, exit_premium: e.target.value }))}
                                    placeholder="e.g. 4.50" type="number"
                                    className="w-full rounded-lg px-3 py-2 text-sm outline-none border"
                                    style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                                ) : (
                                  <input value={resolveData.exit_price} onChange={e => setResolveData(d => ({ ...d, exit_price: e.target.value }))}
                                    placeholder="$0.00" type="number"
                                    className="w-full rounded-lg px-3 py-2 text-sm outline-none border"
                                    style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                                )}
                                {entry.position_type === 'option' && resolveData.exit_premium && entry.entry_premium && (
                                  <div className="text-[9px] mt-1" style={{ color: parseFloat(resolveData.exit_premium) >= entry.entry_premium ? '#34d399' : '#f87171' }}>
                                    {((parseFloat(resolveData.exit_premium) - entry.entry_premium) / entry.entry_premium * 100).toFixed(1)}% on premium
                                  </div>
                                )}
                              </div>
                              <div>
                                <label className="text-[10px] text-white/30 block mb-1">Outcome</label>
                                <select value={resolveData.outcome} onChange={e => setResolveData(d => ({ ...d, outcome: e.target.value }))}
                                  className="w-full rounded-lg px-3 py-2 text-sm outline-none border"
                                  style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }}>
                                  <option value="win">Win ✓</option>
                                  <option value="loss">Loss ✗</option>
                                  <option value="breakeven">Breakeven</option>
                                </select>
                              </div>
                            </div>
                            <input value={resolveData.notes} onChange={e => setResolveData(d => ({ ...d, notes: e.target.value }))}
                              placeholder="What happened? (optional)"
                              className="w-full rounded-lg px-3 py-2 text-sm outline-none border"
                              style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                            <button onClick={() => handleResolve(entry.id)} disabled={!!resolving || !resolveData.exit_price}
                              className="w-full py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-40"
                              style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
                              {resolving === entry.id ? 'Generating post-mortem...' : 'Resolve trade + generate post-mortem'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}

        </div>
      </div>
    </div>
  )
}

export default function PortfolioPage() {
  return <Suspense fallback={<div style={{ background: '#0a0d12', minHeight: '100vh' }} />}><PortfolioInner /></Suspense>
}
