'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowLeft, Plus, Trash2, RefreshCw, TrendingUp, TrendingDown,
  Minus, AlertTriangle, Calendar, DollarSign, Check, X, Clock,
  Star, Repeat2, ChevronDown, ChevronRight, Activity, Briefcase,
  BookOpen, RotateCw, Stethoscope, ArrowUpDown, ArrowUp, ArrowDown,
  Zap, Flame, PieChart, Target
} from 'lucide-react'

// -- Types ----------------------------------------

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

// -- Constants ----------------------------------------

const UP = '#34d399'
const DN = '#f87171'
const FLAT = '#fbbf24'
const ACCENT = '#a78bfa'

const SIG_COLOR: Record<string, string> = { BULLISH: UP, BEARISH: DN, NEUTRAL: FLAT }
const SEV_COLOR: Record<string, string> = { high: DN, medium: FLAT, low: '#94a3b8' }
const VERDICT_COLOR: Record<string, string> = { EXIT: DN, WATCH: FLAT, HOLD: UP, ADD: '#60a5fa' }
const VERDICT_BG: Record<string, string> = { EXIT: 'rgba(248,113,113,0.08)', WATCH: 'rgba(251,191,36,0.06)', HOLD: 'rgba(52,211,153,0.05)', ADD: 'rgba(96,165,250,0.06)' }

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtCompact = (n: number) => {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${n < 0 ? '-' : ''}$${(abs/1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${n < 0 ? '-' : ''}$${(abs/1000).toFixed(1)}k`
  return `${n < 0 ? '-' : ''}$${fmt(abs)}`
}
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
const gradeColor = (g: string) => ({ A: UP, B: '#60a5fa', C: FLAT, D: '#f97316', F: DN }[g] || '#94a3b8')
const pnlColor = (n: number | null | undefined) => {
  if (n == null || n === 0) return 'var(--text3)'
  return n > 0 ? UP : DN
}

// -- Main component ----------------------------------------

type Tab = 'holdings' | 'dividends' | 'reinvest' | 'journal'
type SortKey = 'ticker' | 'value' | 'day' | 'pnl' | 'alloc' | 'signal'
type SortDir = 'asc' | 'desc'

function PortfolioInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialTab = (searchParams.get('tab') as Tab) || 'holdings'
  const [tab, setTab] = useState<Tab>(initialTab)

  // -- Holdings state
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
  const [addLoading, setAddLoading] = useState(false)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('value')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // -- Journal state
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

  // -- Dividend state
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

  // -- Reinvest state
  const [reinvestTrades, setReinvestTrades] = useState<ReinvestTrade[]>([])
  const [loadingReinvest, setLoadingReinvest] = useState(false)
  const [showAddReinvest, setShowAddReinvest] = useState(false)
  const [rTicker, setRTicker] = useState('')
  const [rShares, setRShares] = useState('')
  const [rEntry, setREntry] = useState('')
  const [rNotes, setRNotes] = useState('')
  const [savingReinvest, setSavingReinvest] = useState(false)

  // -- Holdings loading ----------------------------------------

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
    setAddContracts('1'); setShowAdd(false); setAddLoading(false)
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

  // -- Journal loading ----------------------------------------

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

  const outcomeIcon = (o: string) => o === 'win' ? <Check size={12} style={{ color: UP }} /> : o === 'loss' ? <X size={12} style={{ color: DN }} /> : <Clock size={12} style={{ color: FLAT }} />

  // -- Dividend loading ----------------------------------------

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

  // -- Reinvest loading ----------------------------------------

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
            const pnl = cp && t.shares ? (cp - t.entry_price) * t.shares : null
            const pPct = t.entry_price > 0 && cp ? ((cp - t.entry_price) / t.entry_price * 100) : null
            return { ...t, currentPrice: cp, pnl, pnlPct: pPct }
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

  // -- Load on tab change ----------------------------------------

  useEffect(() => { loadPositions() }, [loadPositions])

  useEffect(() => {
    if (tab === 'journal' && journalEntries.length === 0) loadJournal()
    if (tab === 'dividends' && dividends.length === 0) loadDividends()
    if (tab === 'reinvest' && reinvestTrades.length === 0) loadReinvest()
  }, [tab]) // eslint-disable-line

  // -- Derived metrics ----------------------------------------

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
  const totalDividends = dividends.reduce((s, d) => s + d.total_received, 0)
  const reinvestedDividends = dividends.filter(d => d.reinvested).reduce((s, d) => s + d.total_received, 0)
  const openReinvestTrades = reinvestTrades.filter(t => !t.exit_price)
  const realizedReinvestPnL = reinvestTrades.filter(t => t.exit_price).reduce((s, t) => { const p = t.exit_price ? (t.exit_price - t.entry_price) * t.shares : 0; return s + p }, 0)

  const stockCount = positions.filter(p => p.position_type === 'stock').length
  const optionCount = positions.filter(p => p.position_type === 'option').length

  // Sorted positions for table
  const sortedPositions = [...positions].sort((a, b) => {
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

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('desc') }
  }

  const SortHeader = ({ k, label, align = 'right' }: { k: SortKey; label: string; align?: 'left' | 'right' }) => (
    <button onClick={() => toggleSort(k)}
      className="flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider transition-colors hover:opacity-80 w-full"
      style={{
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        color: sortKey === k ? ACCENT : 'var(--text3)',
      }}>
      <span>{label}</span>
      {sortKey === k
        ? (sortDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)
        : <ArrowUpDown size={10} style={{ opacity: 0.3 }} />}
    </button>
  )

  const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: 'holdings',  label: 'Holdings',  icon: <Briefcase size={13} /> },
    { id: 'dividends', label: 'Dividends', icon: <DollarSign size={13} /> },
    { id: 'reinvest',  label: 'Reinvest',  icon: <RotateCw size={13} /> },
    { id: 'journal',   label: 'Journal',   icon: <BookOpen size={13} /> },
  ]

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>

      {/* -- Header ---------------------------------------- */}
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
          </span>
        )}

        {/* Tab-specific action buttons */}
        <div className="ml-auto flex items-center gap-2">
          {tab === 'holdings' && positions.length > 0 && (
            <>
              {cachedAge !== null && !analyzing && (
                <span className="text-[10px] hidden md:inline" style={{ color: 'var(--text3)' }}>
                  {cachedAge === 0 ? 'just analyzed' : `${cachedAge < 60 ? `${cachedAge}m` : `${Math.round(cachedAge/60)}h`} old`}
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
          <button onClick={() => {
            if (tab === 'holdings') setShowAdd(true)
            else if (tab === 'dividends') setShowLogDiv(true)
            else if (tab === 'reinvest') setShowAddReinvest(true)
            else if (tab === 'journal') setShowAddJournal(true)
          }}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ background: ACCENT, color: '#0a0d12' }}
            aria-label={tab === 'holdings' ? 'Add position' : tab === 'dividends' ? 'Log dividend' : tab === 'reinvest' ? 'Add trade' : 'Log journal entry'}>
            <Plus size={12} />
            <span>
              {tab === 'holdings' ? 'Add position' : tab === 'dividends' ? 'Log dividend' : tab === 'reinvest' ? 'Add trade' : 'Log trade'}
            </span>
          </button>
        </div>
      </header>

      {/* -- Hero strip (only for Holdings tab) ------------------------------- */}
      {tab === 'holdings' && positions.length > 0 && (
        <div className="border-b px-6 py-5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
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
                  {cachedAge === 0 ? 'Live' : `as of ${cachedAge < 60 ? `${cachedAge}m` : `${Math.round(cachedAge/60)}h`} ago`}
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
              <div className="text-xs font-mono mt-1 flex items-center gap-1" style={{ color: pnlColor(totalGainLoss) }}>
                {totalGainLoss >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                {pct(totalGainLossPct)} all time
              </div>
            </div>

            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: 'var(--text3)' }}>
                Positions
              </div>
              <div className="text-2xl md:text-3xl font-bold font-mono tabular-nums" style={{ color: 'var(--text)' }}>
                {positions.length}
              </div>
              <div className="text-xs font-mono mt-1" style={{ color: 'var(--text3)' }}>
                {stockCount} stock{stockCount !== 1 ? 's' : ''} · {optionCount} option{optionCount !== 1 ? 's' : ''}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* -- Tab bar ---------------------------------------- */}
      <div className="flex border-b px-6 gap-1 sticky top-[49px] z-10"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className="flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold transition-all border-b-2 hover:opacity-90"
            style={{
              borderColor: tab === t.id ? ACCENT : 'transparent',
              color: tab === t.id ? ACCENT : 'var(--text3)',
            }}
            aria-current={tab === t.id ? 'page' : undefined}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* -- Content ---------------------------------------- */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1400px] mx-auto px-6 py-5">

          {/* -- HOLDINGS TAB ---------------------------------------- */}
          {tab === 'holdings' && (
            <>
              {/* Health check results */}
              {checks.length > 0 && (
                <div className="space-y-2 mb-5">
                  <div className="flex items-center justify-between px-1">
                    <div className="flex items-center gap-1.5">
                      <Stethoscope size={12} style={{ color: 'var(--text3)' }} />
                      <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text3)' }}>Position health</span>
                    </div>
                    {checkedAt && <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>{new Date(checkedAt).toLocaleTimeString()}</span>}
                  </div>
                  {checks.map(c => (
                    <div key={c.ticker} className="rounded-xl overflow-hidden"
                      style={{ background: VERDICT_BG[c.verdict], border: `1px solid ${VERDICT_COLOR[c.verdict]}22` }}>
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
                                style={{ background: c.optionType === 'call' ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)', color: c.optionType === 'call' ? UP : DN }}>
                                {c.optionType.toUpperCase()} ${c.strike} {c.expiry?.slice(5)}
                              </span>
                            )}
                            <span className="text-[10px] font-mono" style={{ color: c.underlyingChange1D >= 0 ? UP : DN }}>
                              ${c.underlyingPrice} ({c.underlyingChange1D >= 0 ? '+' : ''}{c.underlyingChange1D}%)
                            </span>
                            {c.position_type === 'option' && c.optionPnlPct !== null && (
                              <span className="text-[10px] font-mono font-bold" style={{ color: c.optionPnlPct >= 0 ? UP : DN }}>
                                {c.optionPnlPct >= 0 ? '+' : ''}{c.optionPnlPct}% premium
                              </span>
                            )}
                            {c.position_type === 'stock' && c.pnlPct !== null && (
                              <span className="text-[10px] font-mono font-bold" style={{ color: c.pnlPct >= 0 ? UP : DN }}>
                                {c.pnlPct >= 0 ? '+' : ''}{c.pnlPct}% P/L
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: 'var(--text2)' }}>{c.reason}</p>
                          {/* Options Greeks row */}
                          {c.position_type === 'option' && (c.delta !== null || c.theta !== null || c.impliedVolatility !== null) && (
                            <div className="flex gap-2 mt-1 flex-wrap">
                              {c.currentPremium !== null && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(167,139,250,0.1)', color: ACCENT }}>
                                  ${c.currentPremium}
                                </span>
                              )}
                              {c.delta !== null && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(96,165,250,0.08)', color: '#60a5fa' }}>
                                  Δ {c.delta}
                                </span>
                              )}
                              {c.theta !== null && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(248,113,113,0.08)', color: DN }}>
                                  θ {c.theta}/d
                                </span>
                              )}
                              {c.impliedVolatility !== null && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(251,191,36,0.08)', color: FLAT }}>
                                  IV {(c.impliedVolatility*100).toFixed(0)}%
                                </span>
                              )}
                              {c.daysToExpiry !== null && (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                                  style={{ background: c.timeDecayUrgent ? 'rgba(248,113,113,0.12)' : 'var(--surface2)', color: c.timeDecayUrgent ? DN : 'var(--text3)' }}>
                                  {c.daysToExpiry}d left
                                </span>
                              )}
                              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded capitalize"
                                style={{ background: 'var(--surface2)', color: 'var(--text3)' }}>
                                {c.moneyness?.replace('_', ' ')}
                              </span>
                            </div>
                          )}
                        </div>
                        <button onClick={() => runHealthCheck(c.ticker)} disabled={checkTicker === c.ticker}
                          className="shrink-0 p-1.5 rounded-lg hover:opacity-80 disabled:opacity-30 transition-opacity"
                          style={{ color: 'var(--text3)' }}
                          aria-label={`Re-check ${c.ticker}`}>
                          {checkTicker === c.ticker
                            ? <div className="w-3 h-3 rounded-full border border-t-transparent animate-spin" style={{ borderColor: 'var(--text3)', borderTopColor: 'transparent' }} />
                            : <RefreshCw size={12} />}
                        </button>
                      </div>
                      <div className="px-3 pb-2">
                        <p className="text-[10px] font-semibold" style={{ color: VERDICT_COLOR[c.verdict] }}>
                          → {c.action}
                        </p>
                      </div>
                      {c.flags.length > 0 && (
                        <div className="px-3 pb-2.5 flex flex-wrap gap-1">
                          {c.flags.map(f => (
                            <span key={f} className="text-[9px] px-1.5 py-0.5 rounded-full font-mono"
                              style={{ background: 'var(--surface2)', color: 'var(--text3)', border: '1px solid var(--border)' }}>
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
                    style={{ background: ACCENT, color: '#0a0d12' }}
                    aria-label="Add your first position">
                    <Plus size={14} /> Add your first position
                  </button>
                </div>
              )}

              {/* Analyzing spinner */}
              {analyzing && (
                <div className="flex items-center gap-3 px-5 py-4 rounded-xl mb-4"
                  style={{ background: 'rgba(167,139,250,0.05)', border: '1px solid rgba(167,139,250,0.18)' }}>
                  <div className="flex gap-1">{[0,1,2].map(i => <span key={i} className="w-1.5 h-1.5 rounded-full thinking-dot" style={{ background: ACCENT, animationDelay: `${i*0.15}s` }} />)}</div>
                  <span className="text-sm font-mono" style={{ color: 'var(--text2)' }}>{statusMsg}</span>
                </div>
              )}

              {/* Main layout: positions table + right rail */}
              {positions.length > 0 && (
                <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-5">

                  {/* -- Positions table ------------------------------------ */}
                  <div className="rounded-xl border overflow-hidden"
                    style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                    {/* Column headers */}
                    <div className="grid items-center gap-3 px-4 py-2.5 border-b text-[10px] font-mono uppercase tracking-wider"
                      style={{
                        borderColor: 'var(--border)',
                        gridTemplateColumns: 'minmax(130px,1.4fr) 80px 1fr 1fr 1fr 1fr 0.9fr 70px',
                        color: 'var(--text3)',
                      }}>
                      <SortHeader k="ticker" label="Ticker" align="left" />
                      <div className="text-right">Qty</div>
                      <div className="text-right">Current</div>
                      <SortHeader k="day" label="Day" />
                      <div className="text-right">Value</div>
                      <SortHeader k="pnl" label="P/L" />
                      <SortHeader k="signal" label="Signal" />
                      <div />
                    </div>

                    {/* Rows */}
                    <div>
                      {sortedPositions.map((pos, idx) => {
                        const data = positionData.find(p => p.ticker === pos.ticker)
                        const isOption = pos.position_type === 'option'
                        const daysToExpiry = pos.expiry ? Math.ceil((new Date(pos.expiry).getTime() - Date.now()) / 86400000) : null
                        const expiryUrgent = daysToExpiry !== null && daysToExpiry <= 7
                        const expiryExpired = daysToExpiry !== null && daysToExpiry < 0
                        const signalC = data ? SIG_COLOR[data.signal] : 'var(--text3)'
                        const isExpanded = expandedRow === pos.id
                        const alloc = totalValue > 0 && data ? (data.marketValue / totalValue) * 100 : 0

                        return (
                          <div key={pos.id} style={{ borderTop: idx === 0 ? 'none' : '1px solid var(--border)' }}>
                            {/* Main row */}
                            <button
                              onClick={() => setExpandedRow(isExpanded ? null : pos.id)}
                              className="grid items-center gap-3 px-4 py-3 w-full text-left hover:bg-white/[0.02] transition-colors"
                              style={{
                                gridTemplateColumns: 'minmax(130px,1.4fr) 80px 1fr 1fr 1fr 1fr 0.9fr 70px',
                                borderLeft: isOption
                                  ? `3px solid ${pos.option_type === 'call' ? 'rgba(52,211,153,0.5)' : 'rgba(248,113,113,0.5)'}`
                                  : '3px solid transparent',
                              }}
                              aria-expanded={isExpanded}
                              aria-label={`${pos.ticker} — tap to ${isExpanded ? 'collapse' : 'expand'}`}>
                              {/* Ticker column */}
                              <div className="flex items-center gap-2 min-w-0">
                                <ChevronRight size={12}
                                  style={{
                                    color: 'var(--text3)',
                                    transform: isExpanded ? 'rotate(90deg)' : 'none',
                                    transition: 'transform 0.15s',
                                  }} />
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-mono font-bold text-sm">{pos.ticker}</span>
                                    {isOption && (
                                      <span className="text-[9px] font-bold px-1 py-0.5 rounded font-mono"
                                        style={{
                                          background: pos.option_type === 'call' ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
                                          color: pos.option_type === 'call' ? UP : DN,
                                        }}>
                                        {pos.option_type?.toUpperCase()} {pos.strike}
                                      </span>
                                    )}
                                  </div>
                                  {isOption ? (
                                    <div className="text-[10px] font-mono mt-0.5" style={{ color: expiryExpired ? DN : expiryUrgent ? DN : 'var(--text3)' }}>
                                      {expiryExpired ? 'Expired' : `${daysToExpiry}d · ${pos.expiry}`}
                                    </div>
                                  ) : (
                                    pos.avg_cost && (
                                      <div className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--text3)' }}>
                                        @ ${pos.avg_cost.toFixed(2)}
                                      </div>
                                    )
                                  )}
                                </div>
                              </div>

                              {/* Qty */}
                              <div className="text-right font-mono text-xs tabular-nums" style={{ color: 'var(--text2)' }}>
                                {isOption
                                  ? `${pos.contracts || 1}x`
                                  : pos.shares % 1 === 0 ? pos.shares.toString() : pos.shares.toFixed(4)}
                              </div>

                              {/* Current price */}
                              <div className="text-right font-mono text-xs tabular-nums" style={{ color: 'var(--text)' }}>
                                {data ? `$${fmt(data.currentPrice)}` : <span style={{ color: 'var(--text3)' }}>—</span>}
                              </div>

                              {/* Day change */}
                              <div className="text-right font-mono text-xs tabular-nums" style={{ color: data ? pnlColor(data.priceChange1D) : 'var(--text3)' }}>
                                {data ? pct(data.priceChange1D) : '—'}
                              </div>

                              {/* Market value */}
                              <div className="text-right font-mono text-xs tabular-nums" style={{ color: 'var(--text)' }}>
                                {data ? `$${fmt(data.marketValue)}` : <span style={{ color: 'var(--text3)' }}>—</span>}
                              </div>

                              {/* P/L % */}
                              <div className="text-right font-mono text-xs tabular-nums"
                                style={{ color: data && data.gainLossPct !== null ? pnlColor(data.gainLossPct) : 'var(--text3)' }}>
                                {data?.gainLossPct !== null && data?.gainLossPct !== undefined ? pct(data.gainLossPct) : '—'}
                              </div>

                              {/* Signal */}
                              <div className="text-right">
                                {data?.signal ? (
                                  <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded"
                                    style={{ background: `${signalC}18`, color: signalC }}>
                                    {data.signal.slice(0, 4)}
                                  </span>
                                ) : (
                                  <span className="text-[10px]" style={{ color: 'var(--text3)' }}>—</span>
                                )}
                              </div>

                              {/* Action column */}
                              <div className="flex justify-end gap-1">
                                {data?.daysToEarnings != null && data.daysToEarnings <= 14 && (
                                  <span className="text-[9px] font-mono px-1 py-0.5 rounded"
                                    style={{ background: 'rgba(251,191,36,0.1)', color: FLAT }}
                                    title={`Earnings in ${data.daysToEarnings} days`}>
                                    E{data.daysToEarnings}
                                  </span>
                                )}
                              </div>
                            </button>

                            {/* Expanded row */}
                            {isExpanded && (
                              <div className="px-4 pb-4 pt-1 border-t" style={{ borderColor: 'var(--border)', background: 'var(--surface2)' }}>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-3">
                                  {/* Allocation */}
                                  <div>
                                    <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>Allocation</div>
                                    <div className="text-sm font-bold font-mono" style={{ color: 'var(--text)' }}>
                                      {alloc.toFixed(1)}%
                                    </div>
                                    <div className="h-1 rounded-full mt-1.5 overflow-hidden" style={{ background: 'var(--border)' }}>
                                      <div className="h-full rounded-full"
                                        style={{ width: `${Math.min(alloc, 100)}%`, background: alloc > 25 ? FLAT : ACCENT }} />
                                    </div>
                                  </div>
                                  {/* Sector */}
                                  {data?.sector && (
                                    <div>
                                      <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>Sector</div>
                                      <div className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{data.sector}</div>
                                    </div>
                                  )}
                                  {/* Analyst target */}
                                  {data?.analystTarget && (
                                    <div>
                                      <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>Analyst target</div>
                                      <div className="text-sm font-bold font-mono" style={{ color: 'var(--text)' }}>
                                        ${fmt(data.analystTarget)}
                                      </div>
                                      <div className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>{data.analystConsensus}</div>
                                    </div>
                                  )}
                                  {/* RSI */}
                                  {data?.rsi !== null && data?.rsi !== undefined && (
                                    <div>
                                      <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>RSI</div>
                                      <div className="text-sm font-bold font-mono"
                                        style={{ color: data.rsi > 70 ? DN : data.rsi < 30 ? UP : 'var(--text)' }}>
                                        {data.rsi.toFixed(0)}
                                      </div>
                                      <div className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                                        {data.rsi > 70 ? 'overbought' : data.rsi < 30 ? 'oversold' : 'neutral'}
                                      </div>
                                    </div>
                                  )}
                                  {/* Option specifics */}
                                  {isOption && pos.entry_premium && (
                                    <div>
                                      <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>Entry premium</div>
                                      <div className="text-sm font-bold font-mono" style={{ color: 'var(--text)' }}>
                                        ${pos.entry_premium.toFixed(2)}
                                      </div>
                                      <div className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                                        ${((pos.entry_premium || 0) * (pos.contracts || 1) * 100).toFixed(0)} cost
                                      </div>
                                    </div>
                                  )}
                                  {/* Earnings */}
                                  {data?.daysToEarnings != null && data.daysToEarnings <= 30 && (
                                    <div>
                                      <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>Next earnings</div>
                                      <div className="text-sm font-bold font-mono" style={{ color: FLAT }}>
                                        {data.daysToEarnings}d
                                      </div>
                                      {data.earningsDate && (
                                        <div className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>{data.earningsDate}</div>
                                      )}
                                    </div>
                                  )}
                                </div>

                                {/* Action row */}
                                <div className="flex items-center gap-2 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                                  <button onClick={(e) => { e.stopPropagation(); router.push(`/?ticker=${pos.ticker}`) }}
                                    className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
                                    style={{ background: 'rgba(167,139,250,0.1)', color: ACCENT, border: '1px solid rgba(167,139,250,0.22)' }}>
                                    <Activity size={12} /> Analyze
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); runHealthCheck(pos.ticker) }}
                                    disabled={checkTicker === pos.ticker}
                                    className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-40"
                                    style={{ background: 'rgba(248,113,113,0.08)', color: DN, border: '1px solid rgba(248,113,113,0.22)' }}>
                                    <Stethoscope size={12} /> {checkTicker === pos.ticker ? 'Checking...' : 'Check'}
                                  </button>
                                  <div className="ml-auto">
                                    <button onClick={(e) => { e.stopPropagation(); removePosition(pos.ticker) }}
                                      className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
                                      style={{ background: 'var(--surface)', color: 'var(--text3)', border: '1px solid var(--border)' }}
                                      aria-label={`Remove ${pos.ticker} from portfolio`}>
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
                  </div>

                  {/* -- Right rail ---------------------------------------- */}
                  <aside className="space-y-4">

                    {/* Signals summary */}
                    {metrics && (
                      <div className="rounded-xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                        <div className="flex items-center gap-1.5 mb-3">
                          <Activity size={12} style={{ color: 'var(--text3)' }} />
                          <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text3)' }}>Signals</span>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {[
                            { label: 'Bull', count: metrics.signals.BULLISH, color: UP },
                            { label: 'Neutral', count: metrics.signals.NEUTRAL, color: FLAT },
                            { label: 'Bear', count: metrics.signals.BEARISH, color: DN },
                          ].map(s => (
                            <div key={s.label}
                              className="rounded-lg py-2 text-center"
                              style={{ background: `${s.color}10`, border: `1px solid ${s.color}22` }}>
                              <div className="text-lg font-bold font-mono" style={{ color: s.color }}>{s.count}</div>
                              <div className="text-[9px] font-mono uppercase" style={{ color: s.color }}>{s.label}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Sector concentration */}
                    {metrics && metrics.sectorConcentration.length > 0 && (
                      <div className="rounded-xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                        <div className="flex items-center gap-1.5 mb-3">
                          <PieChart size={12} style={{ color: 'var(--text3)' }} />
                          <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text3)' }}>Sector concentration</span>
                        </div>
                        <div className="space-y-2.5">
                          {metrics.sectorConcentration.slice(0, 5).map(s => (
                            <div key={s.sector}>
                              <div className="flex justify-between text-xs mb-1">
                                <span style={{ color: 'var(--text2)' }}>{s.sector}</span>
                                <span className="font-mono tabular-nums" style={{ color: 'var(--text)' }}>{s.pct.toFixed(1)}%</span>
                              </div>
                              <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--surface2)' }}>
                                <div className="h-full rounded-full"
                                  style={{ width: `${s.pct}%`, background: s.pct > 40 ? DN : s.pct > 25 ? FLAT : ACCENT }} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Upcoming earnings */}
                    {metrics && metrics.upcomingEarnings.length > 0 && (
                      <div className="rounded-xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                        <div className="flex items-center gap-1.5 mb-3">
                          <Calendar size={12} style={{ color: 'var(--text3)' }} />
                          <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text3)' }}>Upcoming earnings</span>
                        </div>
                        <div className="space-y-1.5">
                          {metrics.upcomingEarnings.slice(0, 6).map(p => (
                            <button key={p.ticker}
                              onClick={() => router.push(`/?ticker=${p.ticker}`)}
                              className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-left transition-all hover:opacity-80"
                              style={{ background: 'var(--surface2)' }}>
                              <span className="font-mono font-bold text-xs">{p.ticker}</span>
                              <span className="text-[10px] font-mono tabular-nums"
                                style={{ color: (p.daysToEarnings ?? 99) <= 7 ? DN : FLAT }}>
                                {p.earningsDate} ({p.daysToEarnings}d)
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* AI portfolio take */}
                    {analysis && (
                      <div className="rounded-xl border p-4"
                        style={{ background: 'var(--surface)', borderColor: `${SIG_COLOR[analysis.overallSignal]}33` }}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-1.5">
                            <Zap size={12} style={{ color: SIG_COLOR[analysis.overallSignal] }} />
                            <span className="text-[10px] font-mono uppercase tracking-wider font-bold" style={{ color: SIG_COLOR[analysis.overallSignal] }}>
                              {analysis.overallSignal}
                            </span>
                          </div>
                          <div className="text-xl font-bold font-mono"
                            style={{ color: analysis.portfolioScore >= 60 ? UP : analysis.portfolioScore >= 40 ? FLAT : DN }}>
                            {analysis.portfolioScore}
                          </div>
                        </div>
                        <h3 className="text-sm font-bold leading-snug mb-2" style={{ color: 'var(--text)' }}>{analysis.headline}</h3>
                        <p className="text-xs leading-relaxed mb-3" style={{ color: 'var(--text2)' }}>{analysis.summary}</p>

                        {analysis.topRisks.length > 0 && (
                          <div className="mb-3 pb-3 border-b" style={{ borderColor: 'var(--border)' }}>
                            <div className="flex items-center gap-1 mb-1.5">
                              <AlertTriangle size={10} style={{ color: DN }} />
                              <span className="text-[9px] font-mono uppercase tracking-wider font-semibold" style={{ color: DN }}>Top risk</span>
                            </div>
                            <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>{analysis.topRisks[0].risk}</p>
                            <div className="flex gap-1 mt-1.5 flex-wrap">
                              {analysis.topRisks[0].tickers.map(t => (
                                <span key={t} className="text-[9px] font-mono px-1 py-0.5 rounded"
                                  style={{ background: 'var(--surface2)', color: 'var(--text3)' }}>
                                  {t}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {analysis.opportunities.length > 0 && (
                          <div className="mb-3 pb-3 border-b" style={{ borderColor: 'var(--border)' }}>
                            <div className="flex items-center gap-1 mb-1.5">
                              <Target size={10} style={{ color: UP }} />
                              <span className="text-[9px] font-mono uppercase tracking-wider font-semibold" style={{ color: UP }}>Opportunity</span>
                            </div>
                            <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>{analysis.opportunities[0].opportunity}</p>
                            <div className="flex gap-1 mt-1.5 flex-wrap">
                              {analysis.opportunities[0].tickers.map(t => (
                                <span key={t} className="text-[9px] font-mono px-1 py-0.5 rounded"
                                  style={{ background: 'rgba(52,211,153,0.1)', color: UP }}>
                                  {t}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {analysis.actionPlan && (
                          <div>
                            <div className="flex items-center gap-1 mb-1.5">
                              <Flame size={10} style={{ color: ACCENT }} />
                              <span className="text-[9px] font-mono uppercase tracking-wider font-semibold" style={{ color: ACCENT }}>Action plan</span>
                            </div>
                            <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>{analysis.actionPlan}</p>
                          </div>
                        )}

                        <p className="text-[9px] mt-3" style={{ color: 'var(--text3)' }}>
                          For informational purposes only. Not financial advice.
                        </p>
                      </div>
                    )}
                  </aside>
                </div>
              )}
            </>
          )}

          {/* -- DIVIDENDS TAB ---------------------------------------- */}
          {tab === 'dividends' && (
            <div className="space-y-4">
              {/* Summary strip */}
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: 'Total received', val: `$${totalDividends.toFixed(2)}`, color: UP },
                  { label: 'Reinvested', val: `$${reinvestedDividends.toFixed(2)}`, color: ACCENT },
                  { label: 'Cash kept', val: `$${(totalDividends - reinvestedDividends).toFixed(2)}`, color: FLAT },
                ].map(s => (
                  <div key={s.label} className="rounded-xl border p-4"
                    style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text3)' }}>{s.label}</div>
                    <div className="text-2xl font-bold font-mono tabular-nums" style={{ color: s.color }}>{s.val}</div>
                  </div>
                ))}
              </div>

              {/* Upcoming dividends */}
              {divSchedule.length > 0 && (
                <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                  <div className="flex items-center gap-1.5 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                    <Calendar size={12} style={{ color: 'var(--text3)' }} />
                    <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text3)' }}>Upcoming dividends</span>
                  </div>
                  <div>
                    {divSchedule.slice(0, 10).map((d, i) => (
                      <div key={i} className="flex items-center gap-4 px-4 py-2.5"
                        style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                        <span className="font-mono font-bold text-sm w-16">{d.ticker}</span>
                        <span className="text-xs" style={{ color: 'var(--text2)' }}>Ex: {d.ex_date}</span>
                        {d.pay_date && <span className="text-xs" style={{ color: 'var(--text3)' }}>Pay: {d.pay_date}</span>}
                        {d.amount && <span className="text-xs font-mono tabular-nums" style={{ color: UP }}>${d.amount.toFixed(4)}/sh</span>}
                        {d.frequency && <span className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                          style={{ background: 'rgba(167,139,250,0.1)', color: ACCENT }}>{d.frequency}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Empty state */}
              {loadingDividends && <div className="text-center py-10 text-sm" style={{ color: 'var(--text3)' }}>Loading dividends...</div>}
              {!loadingDividends && dividends.length === 0 && (
                <div className="flex flex-col items-center py-16 gap-3 text-center">
                  <div className="p-4 rounded-full" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    <DollarSign size={28} style={{ color: 'var(--text3)' }} />
                  </div>
                  <div className="text-base font-bold" style={{ color: 'var(--text2)' }}>No dividends logged yet</div>
                  <p className="text-sm max-w-sm" style={{ color: 'var(--text3)' }}>
                    Track dividends you receive and whether you reinvested them. Wali-OS fetches upcoming dividend dates for your portfolio automatically.
                  </p>
                  <button onClick={() => setShowLogDiv(true)}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl font-semibold mt-2 transition-all hover:opacity-90"
                    style={{ background: UP, color: '#0a0d12' }}
                    aria-label="Log first dividend">
                    <Plus size={13} /> Log first dividend
                  </button>
                </div>
              )}

              {/* Dividend history */}
              {dividends.length > 0 && (
                <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                  <div className="flex items-center gap-1.5 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                    <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text3)' }}>Dividend history</span>
                  </div>
                  <div>
                    {dividends.map((d, i) => (
                      <div key={d.id} className="flex items-center gap-3 px-4 py-3"
                        style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                        <div className="flex-1 flex items-center gap-3 flex-wrap">
                          <span className="font-mono font-bold text-sm">{d.ticker}</span>
                          <span className="text-xs" style={{ color: 'var(--text3)' }}>{d.ex_date}</span>
                          <span className="text-xs font-mono tabular-nums" style={{ color: UP }}>${d.total_received.toFixed(2)}</span>
                          <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                            ${d.amount_per_share.toFixed(4)}/sh × {d.shares_held}
                          </span>
                          {d.reinvested && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono font-bold"
                              style={{ background: 'rgba(167,139,250,0.12)', color: ACCENT }}>
                              <Repeat2 size={9} className="inline mr-0.5" style={{ verticalAlign: 'middle' }} />
                              DRIP {d.reinvest_shares ? `+${d.reinvest_shares}` : ''}
                            </span>
                          )}
                        </div>
                        <button onClick={() => deleteDiv(d.id)}
                          className="p-1.5 rounded-lg hover:opacity-80"
                          style={{ color: DN }}
                          aria-label={`Delete ${d.ticker} dividend record`}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* -- REINVEST TAB ---------------------------------------- */}
          {tab === 'reinvest' && (
            <div className="space-y-4">
              {/* Summary strip */}
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: 'Open trades', val: `${openReinvestTrades.length}`, color: ACCENT },
                  { label: 'Realized P/L', val: `${realizedReinvestPnL >= 0 ? '+' : ''}$${realizedReinvestPnL.toFixed(2)}`, color: pnlColor(realizedReinvestPnL) },
                  { label: 'Dividend capital', val: `$${reinvestedDividends.toFixed(2)}`, color: FLAT },
                ].map(s => (
                  <div key={s.label} className="rounded-xl border p-4"
                    style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text3)' }}>{s.label}</div>
                    <div className="text-2xl font-bold font-mono tabular-nums" style={{ color: s.color }}>{s.val}</div>
                  </div>
                ))}
              </div>

              {/* Quick-add from holdings */}
              {positions.length > 0 && (
                <div className="rounded-xl border p-4"
                  style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                  <div className="text-[10px] font-mono uppercase tracking-wider mb-2" style={{ color: 'var(--text3)' }}>Your holdings — tap to prefill</div>
                  <div className="flex flex-wrap gap-1.5">
                    {positions.map(p => {
                      const alreadyTracked = reinvestTrades.some(t => t.ticker === p.ticker && !t.exit_price)
                      return (
                        <button key={p.ticker}
                          onClick={() => { setRTicker(p.ticker); setShowAddReinvest(true) }}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold transition-all hover:opacity-80"
                          style={{
                            background: alreadyTracked ? 'rgba(52,211,153,0.1)' : 'var(--surface2)',
                            color: alreadyTracked ? UP : 'var(--text2)',
                            border: `1px solid ${alreadyTracked ? 'rgba(52,211,153,0.22)' : 'var(--border)'}`,
                          }}>
                          {alreadyTracked && <Check size={9} />}
                          {p.ticker}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {loadingReinvest && <div className="text-center py-10 text-sm" style={{ color: 'var(--text3)' }}>Loading...</div>}

              {!loadingReinvest && reinvestTrades.length === 0 && (
                <div className="flex flex-col items-center py-16 gap-3 text-center">
                  <div className="p-4 rounded-full" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    <RotateCw size={28} style={{ color: 'var(--text3)' }} />
                  </div>
                  <div className="text-base font-bold" style={{ color: 'var(--text2)' }}>No reinvestment trades yet</div>
                  <p className="text-sm max-w-sm" style={{ color: 'var(--text3)' }}>
                    Log trades you make using dividend income. Track how your reinvestment capital performs separately from your main portfolio.
                  </p>
                </div>
              )}

              {reinvestTrades.length > 0 && (
                <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                  <div>
                    {reinvestTrades.map((t, i) => {
                      const isOpen = !t.exit_price
                      return (
                        <div key={t.id} className="flex items-center gap-3 px-4 py-3"
                          style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                          <div className="flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono font-bold text-sm">{t.ticker}</span>
                              <span className="text-xs font-mono" style={{ color: 'var(--text3)' }}>
                                {t.shares} @ ${t.entry_price.toFixed(2)}
                              </span>
                              {isOpen ? (
                                <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded"
                                  style={{ background: 'rgba(52,211,153,0.1)', color: UP }}>OPEN</span>
                              ) : (
                                <span className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                                  style={{ background: 'var(--surface2)', color: 'var(--text3)' }}>CLOSED</span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 mt-0.5">
                              {t.currentPrice && <span className="text-xs font-mono tabular-nums" style={{ color: 'var(--text2)' }}>${t.currentPrice.toFixed(2)}</span>}
                              {t.pnl != null && <span className="text-[11px] font-mono tabular-nums" style={{ color: pnlColor(t.pnl) }}>{t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}</span>}
                              {t.pnlPct != null && <span className="text-[11px] font-mono tabular-nums" style={{ color: pnlColor(t.pnlPct) }}>{t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(2)}%</span>}
                              {t.notes && <span className="text-[10px] truncate max-w-[180px]" style={{ color: 'var(--text3)' }}>{t.notes}</span>}
                            </div>
                          </div>
                          <div className="flex gap-1.5">
                            <button onClick={() => router.push(`/?ticker=${t.ticker}`)}
                              className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded-lg transition-all hover:opacity-80"
                              style={{ background: 'rgba(167,139,250,0.1)', color: ACCENT, border: '1px solid rgba(167,139,250,0.22)' }}>
                              <Activity size={10} /> Analyze
                            </button>
                            <button onClick={() => deleteReinvestTrade(t.id)}
                              className="p-1.5 rounded-lg hover:opacity-80"
                              style={{ color: DN }}
                              aria-label={`Delete ${t.ticker} trade`}>
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* -- JOURNAL TAB ---------------------------------------- */}
          {tab === 'journal' && (
            <div className="space-y-4">
              {/* Summary strip */}
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: 'Win rate', val: journalStats.winRate != null ? `${journalStats.winRate.toFixed(0)}%` : '—', color: journalStats.winRate != null && journalStats.winRate >= 50 ? UP : DN },
                  { label: 'Avg P/L', val: journalStats.avgPnl != null ? `${journalStats.avgPnl >= 0 ? '+' : ''}${journalStats.avgPnl.toFixed(1)}%` : '—', color: journalStats.avgPnl != null ? pnlColor(journalStats.avgPnl) : 'var(--text3)' },
                  { label: 'Total trades', val: `${journalStats.totalTrades}`, color: 'var(--text)' },
                ].map(s => (
                  <div key={s.label} className="rounded-xl border p-4"
                    style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text3)' }}>{s.label}</div>
                    <div className="text-2xl font-bold font-mono tabular-nums" style={{ color: s.color }}>{s.val}</div>
                  </div>
                ))}
              </div>

              {/* Journal coverage chips */}
              {!loadingJournal && positions.length > 0 && (
                <div className="rounded-xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                  <div className="text-[10px] font-mono uppercase tracking-wider mb-2" style={{ color: 'var(--text3)' }}>Journal coverage</div>
                  <div className="flex flex-wrap gap-1.5">
                    {positions.map(p => {
                      const hasEntry = journalEntries.some(e => e.ticker === p.ticker)
                      const openEntry = journalEntries.find(e => e.ticker === p.ticker && e.outcome === 'pending')
                      return (
                        <button key={p.ticker}
                          onClick={() => router.push(`/?ticker=${p.ticker}`)}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-mono font-bold transition-all hover:opacity-80"
                          style={{
                            background: openEntry ? 'rgba(251,191,36,0.1)' : hasEntry ? 'rgba(52,211,153,0.1)' : 'var(--surface2)',
                            color: openEntry ? FLAT : hasEntry ? UP : 'var(--text2)',
                            border: `1px solid ${openEntry ? 'rgba(251,191,36,0.22)' : hasEntry ? 'rgba(52,211,153,0.22)' : 'var(--border)'}`,
                          }}
                          title={openEntry ? 'Open trade' : hasEntry ? 'Has journal entries' : 'No journal entry — analyze to add'}>
                          {openEntry ? <Clock size={9} /> : hasEntry ? <Check size={9} /> : null}
                          {p.ticker}
                        </button>
                      )
                    })}
                  </div>
                  <div className="text-[9px] mt-2" style={{ color: 'var(--text3)' }}>journaled · open trade · not yet tracked</div>
                </div>
              )}

              {loadingJournal && <div className="text-center py-10 text-sm" style={{ color: 'var(--text3)' }}>Loading journal...</div>}

              {!loadingJournal && journalEntries.length === 0 && (
                <div className="flex flex-col items-center py-16 gap-3 text-center">
                  <div className="p-4 rounded-full" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    <BookOpen size={28} style={{ color: 'var(--text3)' }} />
                  </div>
                  <div className="text-base font-bold" style={{ color: 'var(--text2)' }}>No journal entries yet</div>
                  <p className="text-sm max-w-sm" style={{ color: 'var(--text3)' }}>
                    After running a council analysis, tap the verdict dropdown and select &quot;Log to Journal&quot; to track your trades here.
                  </p>
                </div>
              )}

              {journalEntries.length > 0 && (
                <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                  {journalEntries.map((entry, i) => {
                    const isOpen = entry.outcome === 'pending'
                    const isExpanded = expandedEntry === entry.id
                    const signalC = SIG_COLOR[entry.signal] || '#94a3b8'
                    return (
                      <div key={entry.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                        <button
                          onClick={() => setExpandedEntry(isExpanded ? null : entry.id)}
                          className="flex items-center gap-3 px-4 py-3 w-full text-left hover:bg-white/[0.02] transition-colors">
                          <ChevronRight size={12}
                            style={{
                              color: 'var(--text3)',
                              transform: isExpanded ? 'rotate(90deg)' : 'none',
                              transition: 'transform 0.15s',
                            }} />
                          <div className="flex items-center gap-1.5">
                            {outcomeIcon(entry.outcome)}
                            <span className="font-bold font-mono text-sm">{entry.ticker}</span>
                            {entry.position_type === 'option' && entry.option_type && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded font-bold"
                                style={{ background: entry.option_type === 'call' ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)', color: entry.option_type === 'call' ? UP : DN }}>
                                {entry.option_type.toUpperCase()} ${entry.strike} {entry.expiry?.slice(0,10)}
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded"
                            style={{ background: `${signalC}15`, color: signalC }}>{entry.signal}</span>
                          {entry.pnl_percent != null && (
                            <span className="text-xs font-mono tabular-nums" style={{ color: pnlColor(entry.pnl_percent) }}>
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
                            <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>{entry.timeframe}</span>
                            <span
                              onClick={e => { e.stopPropagation(); handleDeleteJournal(entry.id) }}
                              className="p-1 rounded-lg hover:opacity-80 cursor-pointer"
                              style={{ color: DN }}
                              role="button"
                              aria-label={`Delete ${entry.ticker} journal entry`}>
                              <Trash2 size={13} />
                            </span>
                          </div>
                        </button>

                        {isExpanded && (
                          <div className="px-4 pb-4 space-y-3 border-t" style={{ borderColor: 'var(--border)', background: 'var(--surface2)' }}>
                            <div className="grid grid-cols-3 gap-2 pt-3">
                              {(entry.position_type === 'option' ? [
                                { label: 'Premium', val: entry.entry_premium ? `$${entry.entry_premium.toFixed(2)}/sh` : '—' },
                                { label: 'Contracts', val: entry.contracts ? `${entry.contracts}x` : '1x' },
                                { label: 'Total cost', val: entry.entry_premium && entry.contracts ? `$${(entry.entry_premium * entry.contracts * 100).toFixed(0)}` : '—' },
                              ] : [
                                { label: 'Entry', val: entry.entry_price ? `$${entry.entry_price.toFixed(2)}` : '—' },
                                { label: 'Stop', val: entry.stop_loss ? `$${entry.stop_loss.toFixed(2)}` : '—' },
                                { label: 'Target', val: entry.take_profit ? `$${entry.take_profit.toFixed(2)}` : '—' },
                              ]).map(f => (
                                <div key={f.label} className="rounded-lg p-2.5"
                                  style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                                  <div className="text-[10px] font-mono uppercase tracking-wider mb-0.5" style={{ color: 'var(--text3)' }}>{f.label}</div>
                                  <div className="text-sm font-mono font-bold tabular-nums" style={{ color: 'var(--text)' }}>{f.val}</div>
                                </div>
                              ))}
                            </div>

                            {entry.notes && <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>{entry.notes}</p>}

                            {entry.postmortem && (
                              <div className="rounded-lg p-3 space-y-2"
                                style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                                <div className="flex items-center gap-2">
                                  <Star size={11} style={{ color: gradeColor(entry.postmortem.council_grade) }} />
                                  <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: gradeColor(entry.postmortem.council_grade) }}>
                                    Grade {entry.postmortem.council_grade} · post-mortem
                                  </span>
                                </div>
                                {[
                                  { label: 'What worked', val: entry.postmortem.what_worked },
                                  { label: 'What missed', val: entry.postmortem.what_missed },
                                  { label: 'Key lesson', val: entry.postmortem.key_lesson },
                                ].map(f => (
                                  <div key={f.label}>
                                    <div className="text-[9px] font-mono uppercase tracking-wider mb-0.5" style={{ color: 'var(--text3)' }}>{f.label}</div>
                                    <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>{f.val}</p>
                                  </div>
                                ))}
                              </div>
                            )}

                            {isOpen && (
                              <div className="rounded-lg p-3 space-y-3"
                                style={{ background: 'rgba(52,211,153,0.04)', border: '1px solid rgba(52,211,153,0.18)' }}>
                                <p className="text-xs font-semibold" style={{ color: UP }}>Resolve trade</p>
                                <div className="grid grid-cols-2 gap-3">
                                  <div>
                                    <label className="text-[10px] font-mono uppercase tracking-wider block mb-1" style={{ color: 'var(--text3)' }}>
                                      {entry.position_type === 'option' ? 'Exit premium/share ($)' : 'Exit price ($)'}
                                    </label>
                                    {entry.position_type === 'option' ? (
                                      <input value={resolveData.exit_premium} onChange={e => setResolveData(d => ({ ...d, exit_premium: e.target.value }))}
                                        placeholder="e.g. 4.50" type="number"
                                        className="w-full rounded-lg px-3 py-2 text-sm outline-none border font-mono"
                                        style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                                    ) : (
                                      <input value={resolveData.exit_price} onChange={e => setResolveData(d => ({ ...d, exit_price: e.target.value }))}
                                        placeholder="0.00" type="number"
                                        className="w-full rounded-lg px-3 py-2 text-sm outline-none border font-mono"
                                        style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                                    )}
                                    {entry.position_type === 'option' && resolveData.exit_premium && entry.entry_premium && (
                                      <div className="text-[9px] mt-1 font-mono"
                                        style={{ color: parseFloat(resolveData.exit_premium) >= entry.entry_premium ? UP : DN }}>
                                        {((parseFloat(resolveData.exit_premium) - entry.entry_premium) / entry.entry_premium * 100).toFixed(1)}% on premium
                                      </div>
                                    )}
                                  </div>
                                  <div>
                                    <label className="text-[10px] font-mono uppercase tracking-wider block mb-1" style={{ color: 'var(--text3)' }}>Outcome</label>
                                    <select value={resolveData.outcome} onChange={e => setResolveData(d => ({ ...d, outcome: e.target.value }))}
                                      className="w-full rounded-lg px-3 py-2 text-sm outline-none border"
                                      style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }}>
                                      <option value="win">Win</option>
                                      <option value="loss">Loss</option>
                                      <option value="breakeven">Breakeven</option>
                                    </select>
                                  </div>
                                </div>
                                <input value={resolveData.notes} onChange={e => setResolveData(d => ({ ...d, notes: e.target.value }))}
                                  placeholder="What happened? (optional)"
                                  className="w-full rounded-lg px-3 py-2 text-sm outline-none border"
                                  style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                                <button onClick={() => handleResolve(entry.id)}
                                  disabled={!!resolving || (entry.position_type === 'option' ? !resolveData.exit_premium : !resolveData.exit_price)}
                                  className="w-full py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                                  style={{ background: ACCENT, color: '#0a0d12' }}>
                                  {resolving === entry.id ? 'Generating post-mortem...' : 'Resolve trade + generate post-mortem'}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

        </div>
      </div>

      {/* ----------------------------------------
          DRAWERS — modal-style overlays that slide from the right
          ==================================================== */}

      {/* Add position drawer */}
      {showAdd && (
        <Drawer title="Add position" onClose={() => setShowAdd(false)}>
          <div className="space-y-4">
            {/* Type toggle */}
            <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border)' }}>
              {(['stock','option'] as const).map(t => (
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

            {/* Ticker */}
            <FormField label={addType === 'option' ? 'Underlying ticker' : 'Ticker'}>
              <input value={addTicker} onChange={e => setAddTicker(e.target.value.toUpperCase())}
                placeholder={addType === 'option' ? 'NVDA' : 'AAPL'} maxLength={6}
                className="w-full rounded-lg px-3 py-2.5 text-sm font-mono font-bold outline-none border"
                style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
            </FormField>

            {addType === 'stock' ? (
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Shares">
                  <input value={addShares} onChange={e => setAddShares(e.target.value)} placeholder="100" type="number" min="0"
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                    style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                </FormField>
                <FormField label="Avg cost/share ($)">
                  <input value={addCost} onChange={e => setAddCost(e.target.value)} placeholder="0.00" type="number" min="0"
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                    style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                </FormField>
              </div>
            ) : (
              <div className="space-y-3">
                <FormField label="Type">
                  <div className="grid grid-cols-2 gap-2">
                    {(['call','put'] as const).map(ot => (
                      <button key={ot} onClick={() => setAddOptionType(ot)}
                        className="py-2 rounded-lg text-xs font-bold transition-all"
                        style={{
                          background: addOptionType === ot
                            ? (ot === 'call' ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)')
                            : 'var(--surface2)',
                          color: addOptionType === ot ? (ot === 'call' ? UP : DN) : 'var(--text3)',
                          border: `1px solid ${addOptionType === ot ? (ot === 'call' ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)') : 'var(--border)'}`,
                        }}>
                        {ot.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </FormField>

                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Strike ($)">
                    <input value={addStrike} onChange={e => setAddStrike(e.target.value)} placeholder="195" type="number" min="0"
                      className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                      style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                  </FormField>
                  <FormField label="Expiry">
                    <input value={addExpiry} onChange={e => setAddExpiry(e.target.value)} type="date"
                      className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
                      style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                  </FormField>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Contracts">
                    <input value={addContracts} onChange={e => setAddContracts(e.target.value)} placeholder="1" type="number" min="1"
                      className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                      style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                  </FormField>
                  <FormField label="Entry premium/share ($)">
                    <input value={addCost} onChange={e => setAddCost(e.target.value)} placeholder="2.50" type="number" min="0" step="0.01"
                      className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                      style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                  </FormField>
                </div>
                {addCost && addContracts && (
                  <div className="flex items-center justify-between rounded-lg px-3 py-2"
                    style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.18)' }}>
                    <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text3)' }}>Total cost</span>
                    <span className="text-sm font-bold font-mono tabular-nums" style={{ color: ACCENT }}>
                      ${(parseFloat(addCost) * parseInt(addContracts) * 100).toFixed(2)}
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button onClick={addPosition}
                disabled={addLoading || !addTicker || (addType === 'stock' ? !addShares : !addStrike || !addExpiry)}
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

      {/* Log dividend drawer */}
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
              <FormField label="Pay date (opt.)">
                <input value={divPayDate} onChange={e => setDivPayDate(e.target.value)} type="date"
                  className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
                  style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
              </FormField>
            </div>

            {divAmount && divShares && (
              <div className="flex items-center justify-between rounded-lg px-3 py-2"
                style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.18)' }}>
                <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text3)' }}>Total received</span>
                <span className="text-sm font-bold font-mono tabular-nums" style={{ color: UP }}>
                  ${(parseFloat(divAmount || '0') * parseFloat(divShares || '0')).toFixed(2)}
                </span>
              </div>
            )}

            {/* Reinvestment toggle */}
            <button onClick={() => setDivReinvested(!divReinvested)}
              className="w-full flex items-center gap-2 text-sm font-semibold px-3 py-2.5 rounded-lg transition-all"
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

      {/* Add reinvest trade drawer */}
      {showAddReinvest && (
        <Drawer title="Log reinvestment trade" onClose={() => setShowAddReinvest(false)}>
          <div className="space-y-3">
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
              <button onClick={() => setShowAddReinvest(false)}
                className="px-4 py-2.5 rounded-lg text-sm transition-all hover:opacity-80"
                style={{ background: 'var(--surface2)', color: 'var(--text2)', border: '1px solid var(--border)' }}>
                Cancel
              </button>
            </div>
          </div>
        </Drawer>
      )}

      {/* Add journal entry drawer */}
      {showAddJournal && (
        <Drawer title="Log trade" onClose={() => setShowAddJournal(false)}>
          <div className="space-y-3">
            <div className="flex rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border)' }}>
              {(['stock','option'] as const).map(t => (
                <button key={t} onClick={() => setJType(t)}
                  className="flex-1 py-2 text-xs font-semibold transition-all"
                  style={{
                    background: jType === t ? 'rgba(167,139,250,0.15)' : 'transparent',
                    color: jType === t ? ACCENT : 'var(--text3)',
                  }}>
                  {t === 'stock' ? 'Stock' : 'Option'}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Ticker">
                <input value={jTicker} onChange={e => setJTicker(e.target.value.toUpperCase())} placeholder="AAPL"
                  className="w-full rounded-lg px-3 py-2.5 text-sm font-mono font-bold outline-none border"
                  style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
              </FormField>
              <FormField label="Signal">
                <select value={jSignal} onChange={e => setJSignal(e.target.value as 'BULLISH' | 'BEARISH' | 'NEUTRAL')}
                  className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
                  style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }}>
                  <option value="BULLISH">Bullish</option>
                  <option value="BEARISH">Bearish</option>
                  <option value="NEUTRAL">Neutral</option>
                </select>
              </FormField>
            </div>

            {jType === 'option' && (
              <>
                <FormField label="Option type">
                  <div className="grid grid-cols-2 gap-2">
                    {(['call','put'] as const).map(ot => (
                      <button key={ot} onClick={() => setJOptionType(ot)}
                        className="py-2 rounded-lg text-xs font-bold transition-all"
                        style={{
                          background: jOptionType === ot
                            ? (ot === 'call' ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)')
                            : 'var(--surface2)',
                          color: jOptionType === ot ? (ot === 'call' ? UP : DN) : 'var(--text3)',
                          border: `1px solid ${jOptionType === ot ? (ot === 'call' ? 'rgba(52,211,153,0.3)' : 'rgba(248,113,113,0.3)') : 'var(--border)'}`,
                        }}>
                        {ot.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </FormField>
                <div className="grid grid-cols-3 gap-3">
                  <FormField label="Strike">
                    <input value={jStrike} onChange={e => setJStrike(e.target.value)} placeholder="$" type="number"
                      className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                      style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                  </FormField>
                  <FormField label="Expiry">
                    <input value={jExpiry} onChange={e => setJExpiry(e.target.value)} type="date"
                      className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
                      style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                  </FormField>
                  <FormField label="Contracts">
                    <input value={jContracts} onChange={e => setJContracts(e.target.value)} placeholder="1" type="number"
                      className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                      style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                  </FormField>
                </div>
                <FormField label="Entry premium/share ($)">
                  <input value={jPremium} onChange={e => setJPremium(e.target.value)} placeholder="2.50" type="number"
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                    style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                </FormField>
                {jPremium && jContracts && (
                  <div className="flex items-center justify-between rounded-lg px-3 py-2"
                    style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.18)' }}>
                    <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text3)' }}>Total cost</span>
                    <span className="text-sm font-bold font-mono tabular-nums" style={{ color: ACCENT }}>
                      ${(parseFloat(jPremium) * parseInt(jContracts) * 100).toFixed(2)}
                    </span>
                  </div>
                )}
              </>
            )}

            {jType === 'stock' && (
              <div className="grid grid-cols-3 gap-3">
                <FormField label="Entry">
                  <input value={jEntryPrice} onChange={e => setJEntryPrice(e.target.value)} placeholder="$" type="number"
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                    style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                </FormField>
                <FormField label="Stop">
                  <input value={jStop} onChange={e => setJStop(e.target.value)} placeholder="$" type="number"
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                    style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                </FormField>
                <FormField label="Target">
                  <input value={jTarget} onChange={e => setJTarget(e.target.value)} placeholder="$" type="number"
                    className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border"
                    style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
                </FormField>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Timeframe">
                <select value={jTimeframe} onChange={e => setJTimeframe(e.target.value)}
                  className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
                  style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }}>
                  <option value="1D">1D</option><option value="1W">1W</option>
                  <option value="1M">1M</option><option value="3M">3M</option>
                </select>
              </FormField>
              <FormField label="Notes (opt.)">
                <input value={jNotes} onChange={e => setJNotes(e.target.value)} placeholder="Thesis..."
                  className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
                  style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }} />
              </FormField>
            </div>

            <div className="flex gap-2 pt-2">
              <button onClick={addJournalEntry}
                disabled={!jTicker}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                style={{ background: ACCENT, color: '#0a0d12' }}>
                Log trade
              </button>
              <button onClick={() => setShowAddJournal(false)}
                className="px-4 py-2.5 rounded-lg text-sm transition-all hover:opacity-80"
                style={{ background: 'var(--surface2)', color: 'var(--text2)', border: '1px solid var(--border)' }}>
                Cancel
              </button>
            </div>
          </div>
        </Drawer>
      )}
    </div>
  )
}

// -- Helper components ----------------------------------------

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
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 z-30"
        style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }}
        aria-hidden="true" />
      {/* Drawer panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
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

export default function PortfolioPage() {
  return (
    <Suspense fallback={<div style={{ background: 'var(--bg)', minHeight: '100vh' }} />}>
      <PortfolioInner />
    </Suspense>
  )
}
