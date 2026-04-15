'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowLeft, Plus, Trash2, TrendingUp, TrendingDown, RefreshCw,
  DollarSign, Lightbulb, BarChart2, X, CheckCircle, AlertTriangle, Info
} from 'lucide-react'
import { UpgradeGate } from '@/app/components/UpgradeGate'
import { useFeature } from '@/app/lib/use-subscription'

// ── Types ──────────────────────────────────────────────────────
interface Trade {
  id: string
  ticker: string
  shares: number
  entry_price: number
  exit_price: number | null
  exit_date: string | null
  council_signal: string | null
  confidence: number | null
  persona: string | null
  notes: string | null
  opened_at: string
}

interface TradeSummary extends Trade {
  currentPrice: number | null
  pnl: number | null
  pnlPct: number | null
}

interface IdeaTier {
  label: string               // e.g. "Aggressive", "Moderate", "Conservative"
  tierColor: string           // color for the tier badge
  strategy: string            // e.g. "Sector rotation", "Partial profit-taking", "Diversification"
  strategyNote: string        // 1 sentence on WHY this strategy fits their situation
  ticker: string
  isAddToExisting: boolean
  signal: string
  confidence: number
  rationale: string           // 2-3 sentences connecting to their specific gains
  suggestedAmount: number | string
  suggestedShares: string
  pctOfGains: number          // % of available capital this represents
  risk: 'low' | 'medium' | 'high'
  timeframe: string
  currentPrice: number | null
  entryNote: string           // e.g. "Buy on a pullback to $X support"
  stopNote: string            // e.g. "Stop below $X (2× ATR)"
  targetNote: string          // e.g. "First target $X, full exit $Y"
}

interface Idea extends IdeaTier {}

interface Insight {
  type: 'success' | 'warning' | 'info'
  text: string
}

interface AllocItem {
  label: string
  pct: number
  amount: number
  color: string
}

// ── Helpers ────────────────────────────────────────────────────
const SIG_COLOR: Record<string, string> = {
  BULLISH: '#34d399', BEARISH: '#f87171', NEUTRAL: '#fbbf24'
}
const RISK_COLOR: Record<string, string> = {
  low: '#34d399', medium: '#fbbf24', high: '#f87171'
}
const ALLOC_COLORS: Record<string, string> = {
  blue: '#60a5fa', green: '#34d399', amber: '#fbbf24', purple: '#a78bfa', red: '#f87171'
}
const sf = (n: number | null | undefined, d = 2) => (n == null || isNaN(n as number) ? '0.00' : (n as number).toFixed(d))
const fmt$ = (n: number | string | null | undefined) => {
  const v = typeof n === 'string' ? parseFloat(n.replace(/[^0-9.-]/g, '')) : (n ?? 0)
  return `$${Math.abs(isNaN(v) ? 0 : v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}
const fmtPct = (n: number | null | undefined) => { const v = n ?? 0; return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` }

function SigBadge({ s }: { s: string | null }) {
  const sig = s?.toUpperCase() ?? 'NEUTRAL'
  const color = SIG_COLOR[sig] ?? '#fbbf24'
  return (
    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full"
      style={{ background: `${color}18`, color, border: `1px solid ${color}30` }}>
      {sig}
    </span>
  )
}

// ── Log Trade Modal ────────────────────────────────────────────
function LogTradeModal({
  onClose, onSave, prefill
}: {
  onClose: () => void
  onSave: (data: { ticker: string; shares: number; entry_price: number; notes?: string }) => void
  prefill?: { ticker?: string; entry_price?: number; council_signal?: string; confidence?: number }
}) {
  const [ticker, setTicker] = useState(prefill?.ticker ?? '')
  const [shares, setShares] = useState('')
  const [entryPrice, setEntryPrice] = useState(prefill?.entry_price ? sf(prefill.entry_price) : '')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!ticker || !shares || !entryPrice) return
    setSaving(true)
    await onSave({ ticker: ticker.toUpperCase(), shares: parseFloat(shares), entry_price: parseFloat(entryPrice), notes })
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="w-full max-w-md rounded-2xl shadow-2xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <span className="font-semibold text-sm" style={{ color: 'var(--text)' }}>Log a trade</span>
          <button onClick={onClose} style={{ color: 'var(--text3)' }}><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          {prefill?.council_signal && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs" style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)', color: 'var(--text2)' }}>
              <span>Council said</span>
              <SigBadge s={prefill.council_signal} />
              <span>{prefill.confidence}% confidence on your last analysis</span>
            </div>
          )}
          <div>
            <label className="block text-xs mb-1.5" style={{ color: 'var(--text3)' }}>Ticker</label>
            <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} maxLength={6}
              placeholder="AAPL" className="w-full h-9 px-3 rounded-lg text-sm font-mono"
              style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)' }} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs mb-1.5" style={{ color: 'var(--text3)' }}>Shares purchased</label>
              <input value={shares} onChange={e => setShares(e.target.value)} type="number" min="0" step="0.01"
                placeholder="25" className="w-full h-9 px-3 rounded-lg text-sm font-mono"
                style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)' }} />
            </div>
            <div>
              <label className="block text-xs mb-1.5" style={{ color: 'var(--text3)' }}>Entry price</label>
              <input value={entryPrice} onChange={e => setEntryPrice(e.target.value)} type="number" min="0" step="0.01"
                placeholder="118.40" className="w-full h-9 px-3 rounded-lg text-sm font-mono"
                style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)' }} />
            </div>
          </div>
          <div>
            <label className="block text-xs mb-1.5" style={{ color: 'var(--text3)' }}>Notes (optional)</label>
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. earnings play"
              className="w-full h-9 px-3 rounded-lg text-sm"
              style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)' }} />
          </div>
          {prefill?.entry_price && (
            <p className="text-[10px]" style={{ color: 'var(--text3)' }}>
              Entry price pre-filled from your last analysis. Adjust to your actual fill price.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 pb-5">
          <button onClick={onClose} className="px-4 py-1.5 rounded-lg text-sm"
            style={{ color: 'var(--text2)', background: 'var(--surface2)', border: '1px solid var(--border)' }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={!ticker || !shares || !entryPrice || saving}
            className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
            {saving ? 'Saving...' : 'Log trade'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Close Trade Modal ──────────────────────────────────────────
function CloseTradeModal({
  trade, onClose, onSave
}: {
  trade: Trade
  onClose: () => void
  onSave: (id: string, exit_price: number) => void
}) {
  const [exitPrice, setExitPrice] = useState('')
  const [saving, setSaving] = useState(false)

  const cost = trade.entry_price * trade.shares
  const exit = parseFloat(exitPrice)
  const pnl = exitPrice ? (exit - trade.entry_price) * trade.shares : null
  const pnlPct = exitPrice ? ((exit - trade.entry_price) / trade.entry_price) * 100 : null

  const handleSave = async () => {
    if (!exitPrice) return
    setSaving(true)
    await onSave(trade.id, parseFloat(exitPrice))
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="w-full max-w-sm rounded-2xl shadow-2xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <span className="font-semibold text-sm" style={{ color: 'var(--text)' }}>Close {trade.ticker}</span>
          <button onClick={onClose} style={{ color: 'var(--text3)' }}><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex justify-between text-xs" style={{ color: 'var(--text2)' }}>
            <span>{trade.shares} shares × ${sf(trade.entry_price)} entry = {fmt$(cost)}</span>
          </div>
          <div>
            <label className="block text-xs mb-1.5" style={{ color: 'var(--text3)' }}>Exit price</label>
            <input value={exitPrice} onChange={e => setExitPrice(e.target.value)} type="number" min="0" step="0.01"
              placeholder="0.00" autoFocus className="w-full h-9 px-3 rounded-lg text-sm font-mono"
              style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)' }} />
          </div>
          {pnl !== null && (
            <div className="px-3 py-2 rounded-lg text-sm font-mono font-semibold text-center"
              style={{ background: pnl >= 0 ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)', color: pnl >= 0 ? '#34d399' : '#f87171' }}>
              {(pnl ?? 0) >= 0 ? '+' : ''}{fmt$(pnl)} ({fmtPct(pnlPct)}) — will be added to available cash
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 pb-5">
          <button onClick={onClose} className="px-4 py-1.5 rounded-lg text-sm"
            style={{ color: 'var(--text2)', background: 'var(--surface2)', border: '1px solid var(--border)' }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={!exitPrice || saving}
            className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg,#059669,#0d9488)' }}>
            {saving ? 'Saving...' : 'Close trade'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────
function ReinvestmentInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [tab, setTab] = useState<'trades' | 'ideas' | 'history'>('trades')
  const [trades, setTrades] = useState<Trade[]>([])
  const [summaries, setSummaries] = useState<TradeSummary[]>([])
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [insights, setInsights] = useState<Insight[]>([])
  const [allocation, setAllocation] = useState<AllocItem[]>([])
  const { allowed: canAccess, loaded: subLoaded } = useFeature('reinvestment')
  const [realizedPnL, setRealizedPnL] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingIdeas, setLoadingIdeas] = useState(false)
  const [showLogModal, setShowLogModal] = useState(false)
  const [closingTrade, setClosingTrade] = useState<Trade | null>(null)
  const [prefill, setPrefill] = useState<{ ticker?: string; entry_price?: number; council_signal?: string; confidence?: number } | undefined>()

  // Check for pre-fill from analysis page
  useEffect(() => {
    const ticker = searchParams.get('ticker')
    const price = searchParams.get('price')
    const signal = searchParams.get('signal')
    const conf = searchParams.get('confidence')
    if (ticker) {
      setPrefill({
        ticker,
        entry_price: price ? parseFloat(price) : undefined,
        council_signal: signal ?? undefined,
        confidence: conf ? parseInt(conf) : undefined,
      })
      setShowLogModal(true)
    }
  }, [searchParams])

  const loadTrades = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/reinvestment/trades')
      const data = await res.json()
      setTrades(data.trades ?? [])
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadTrades() }, [loadTrades])

  // Fetch live prices for open trades
  useEffect(() => {
    if (!trades.length) { setSummaries([]); return }
    const open = trades.filter(t => !t.exit_price)
    if (!open.length) { setSummaries([]); return }

    Promise.all(open.map(async t => {
      try {
        // fetch live price via ticker API
        const res = await fetch(`/api/ticker?ticker=${t.ticker}`)
        const data = await res.json()
        const currentPrice: number | null = data?.price ?? null
        const pnl = currentPrice ? (currentPrice - t.entry_price) * t.shares : null
        const pnlPct = currentPrice ? ((currentPrice - t.entry_price) / t.entry_price) * 100 : null
        return { ...t, currentPrice, pnl, pnlPct } as TradeSummary
      } catch {
        return { ...t, currentPrice: null, pnl: null, pnlPct: null } as TradeSummary
      }
    })).then(setSummaries)
  }, [trades])

  // Available capital = realized cash + unrealized gains (so ideas work even without closed trades)
  const unrealizedTotal = summaries.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const availableCash = realizedPnL > 0 ? realizedPnL : Math.max(0, unrealizedTotal)

  const loadIdeas = async () => {
    setLoadingIdeas(true)
    try {
      // Pass live summaries (with currentPrice/pnl) not raw trades so the AI gets real numbers
      const tradesForIdeas = summaries.length > 0 ? summaries : trades
      const res = await fetch('/api/reinvestment/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trades: tradesForIdeas, availableCash, unrealizedTotal })
      })
      const data = await res.json()
      setIdeas(data.ideas ?? [])
      setInsights(data.insights ?? [])
      setAllocation(data.allocation ?? [])
      setRealizedPnL(data.realizedPnL ?? 0)
      if (tab !== 'ideas') setTab('ideas')
    } catch { /* ignore */ }
    setLoadingIdeas(false)
  }

  const logTrade = async (d: { ticker: string; shares: number; entry_price: number; notes?: string }) => {
    const res = await fetch('/api/reinvestment/trades', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...d, ...prefill })
    })
    if (res.ok) {
      await loadTrades()
      setShowLogModal(false)
      setPrefill(undefined)
    }
  }

  const closeTrade = async (id: string, exit_price: number) => {
    const res = await fetch('/api/reinvestment/trades', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, exit_price })
    })
    if (res.ok) {
      await loadTrades()
      setClosingTrade(null)
    }
  }

  const deleteTrade = async (id: string) => {
    if (!confirm('Delete this trade?')) return
    await fetch(`/api/reinvestment/trades?id=${id}`, { method: 'DELETE' })
    await loadTrades()
  }

  // Metrics
  const openTrades = summaries
  const closedTrades = trades.filter(t => t.exit_price)
  const realizedTotal = closedTrades.reduce((s, t) => s + (t.exit_price! - t.entry_price) * t.shares, 0)
  const totalInvested = summaries.reduce((s, t) => s + t.entry_price * t.shares, 0)

  const isDark = typeof document !== 'undefined'
    ? document.documentElement.getAttribute('data-theme') !== 'light' : true
  const surf  = isDark ? '#111620' : '#ffffff'
  const surf2 = isDark ? '#181e2a' : '#f5f7fb'
  const brd   = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)'
  const txt   = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)'
  const txt2  = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
  const txt3  = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.35)'

  return (
    <UpgradeGate feature="reinvestment" featureName="Reinvestment Tracker" description="Log trades, track live P&L, and get AI-powered tiered strategies for deploying your gains." allowed={canAccess} loaded={subLoaded}>
    <>
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: txt }}>

      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b shrink-0 sticky top-0 z-10"
        style={{ background: surf, borderColor: brd }}>
        <button onClick={() => router.push('/')}
          className="flex items-center gap-1.5 text-xs hover:opacity-70 transition-opacity"
          style={{ color: txt3 }}>
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: brd }} />
        <div className="flex items-center gap-2">
          <DollarSign size={14} style={{ color: '#34d399' }} />
          <span className="text-sm font-bold" style={{ color: txt }}>Reinvestment Tracker</span>
        </div>
        <div className="flex-1" />
        {availableCash > 0 && (
          <div className="flex items-center gap-2 mr-2">
            <span className="text-xs" style={{ color: txt3 }}>
              {realizedTotal > 0 ? 'Available to reinvest' : 'Deployable gains'}
            </span>
            <span className="text-base font-bold font-mono" style={{ color: '#34d399' }}>{fmt$(availableCash)}</span>
          </div>
        )}
        <button onClick={() => { setPrefill(undefined); setShowLogModal(true) }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white"
          style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
          <Plus size={12} /> Log trade
        </button>
      </header>

      {/* Tabs */}
      <div className="flex gap-0 border-b px-4" style={{ borderColor: brd, background: surf }}>
        {(['trades', 'ideas', 'history'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className="px-4 py-2.5 text-xs font-semibold capitalize transition-all border-b-2"
            style={{
              color: tab === t ? '#a78bfa' : txt3,
              borderColor: tab === t ? '#a78bfa' : 'transparent',
            }}>
            {t === 'ideas' ? '✨ Reinvest Ideas' : t === 'trades' ? '📊 Open Trades' : '📋 History'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">

          {/* ── METRICS ─────────────────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Open trades', value: openTrades.length.toString(), sub: `${closedTrades.length} closed` },
              {
                label: 'Unrealized P&L',
                value: (unrealizedTotal ?? 0) >= 0 ? `+${fmt$(unrealizedTotal)}` : `${fmt$(unrealizedTotal)}`,
                sub: totalInvested > 0 ? fmtPct((unrealizedTotal / totalInvested) * 100) : '0%',
                color: (unrealizedTotal ?? 0) >= 0 ? '#34d399' : '#f87171'
              },
              {
                label: 'Realized gains',
                value: fmt$(realizedTotal),
                sub: `${closedTrades.length} exits`,
                color: realizedTotal >= 0 ? '#34d399' : '#f87171'
              },
              {
                label: realizedTotal > 0 ? 'Available cash' : 'Deployable capital',
                value: fmt$(availableCash),
                sub: realizedTotal > 0 ? 'from closed trades' : unrealizedTotal > 0 ? 'unrealized gains' : 'no gains yet',
                color: availableCash > 0 ? '#60a5fa' : txt3 as string
              },
            ].map(({ label, value, sub, color }) => (
              <div key={label} className="rounded-xl p-3" style={{ background: surf2, border: `1px solid ${brd}` }}>
                <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: txt3 }}>{label}</div>
                <div className="text-xl font-bold font-mono" style={{ color: color ?? txt }}>{value}</div>
                <div className="text-[10px] font-mono mt-0.5" style={{ color: txt3 }}>{sub}</div>
              </div>
            ))}
          </div>

          {/* ── OPEN TRADES TAB ──────────────────────────────────── */}
          {tab === 'trades' && (
            <div className="space-y-4">
              {loading ? (
                <div className="text-sm text-center py-12" style={{ color: txt3 }}>Loading trades…</div>
              ) : openTrades.length === 0 ? (
                <div className="rounded-2xl p-10 text-center" style={{ background: surf2, border: `1px solid ${brd}` }}>
                  <DollarSign size={28} className="mx-auto mb-3" style={{ color: txt3 }} />
                  <p className="text-sm font-semibold mb-1" style={{ color: txt }}>No open trades yet</p>
                  <p className="text-xs mb-4" style={{ color: txt3 }}>Log the shares you bought after an analysis to start tracking P&L and reinvestment opportunities.</p>
                  <button onClick={() => setShowLogModal(true)}
                    className="flex items-center gap-1.5 mx-auto px-4 py-2 rounded-lg text-xs font-semibold text-white"
                    style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
                    <Plus size={12} /> Log your first trade
                  </button>
                </div>
              ) : (
                <>
                  <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${brd}` }}>
                    <table className="w-full text-sm">
                      <thead>
                        <tr style={{ background: surf2, borderBottom: `1px solid ${brd}` }}>
                          {['Ticker', 'Shares', 'Entry', 'Current', 'P&L', 'Council', ''].map(h => (
                            <th key={h} className={`px-4 py-2.5 text-[10px] font-mono uppercase tracking-widest ${h === '' || h === 'P&L' || h === 'Current' || h === 'Council' ? 'text-right' : 'text-left'}`}
                              style={{ color: txt3 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {openTrades.map((t, i) => (
                          <tr key={t.id} style={{ borderBottom: i < openTrades.length - 1 ? `1px solid ${brd}` : 'none', background: surf }}>
                            <td className="px-4 py-3 font-bold font-mono" style={{ color: txt }}>{t.ticker}</td>
                            <td className="px-4 py-3 font-mono text-right" style={{ color: txt2 }}>{t.shares}</td>
                            <td className="px-4 py-3 font-mono text-right" style={{ color: txt2 }}>${sf(t.entry_price)}</td>
                            <td className="px-4 py-3 font-mono text-right" style={{ color: txt }}>
                              {t.currentPrice ? `$${sf(t.currentPrice)}` : <span style={{ color: txt3 }}>—</span>}
                            </td>
                            <td className="px-4 py-3 font-mono text-right">
                              {t.pnl !== null ? (
                                <span style={{ color: t.pnl >= 0 ? '#34d399' : '#f87171' }}>
                                  {(t.pnl ?? 0) >= 0 ? '+' : ''}{fmt$(t.pnl)} ({fmtPct(t.pnlPct)})
                                </span>
                              ) : <span style={{ color: txt3 }}>—</span>}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <SigBadge s={t.council_signal} />
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center justify-end gap-1.5">
                                <button onClick={() => setClosingTrade(t)}
                                  className="px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all hover:opacity-80"
                                  style={{ background: 'rgba(52,211,153,0.1)', color: '#34d399', border: '1px solid rgba(52,211,153,0.2)' }}>
                                  Close
                                </button>
                                <button onClick={() => deleteTrade(t.id)}
                                  className="p-1 rounded-md hover:opacity-70 transition-opacity"
                                  style={{ color: txt3 }}>
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Get Ideas CTA */}
                  <div className="rounded-2xl p-5 flex items-center justify-between gap-4"
                    style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.2)' }}>
                    <div>
                      <p className="text-sm font-semibold mb-0.5" style={{ color: '#a78bfa' }}>Ready to see reinvestment ideas?</p>
                      <p className="text-xs" style={{ color: txt2 }}>
                        The council will analyze your gains and suggest where to redeploy your capital next.
                      </p>
                    </div>
                    <button onClick={loadIdeas} disabled={loadingIdeas}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold text-white shrink-0 disabled:opacity-50"
                      style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
                      {loadingIdeas ? <RefreshCw size={12} className="animate-spin" /> : <Lightbulb size={12} />}
                      {loadingIdeas ? 'Analyzing...' : 'Get ideas'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── REINVEST IDEAS TAB ───────────────────────────────── */}
          {tab === 'ideas' && (
            <div className="space-y-5">
              {ideas.length === 0 ? (
                <div className="rounded-2xl p-10 text-center" style={{ background: surf2, border: `1px solid ${brd}` }}>
                  <Lightbulb size={28} className="mx-auto mb-3" style={{ color: txt3 }} />
                  <p className="text-sm font-semibold mb-1" style={{ color: txt }}>No ideas yet</p>
                  <p className="text-xs mb-4" style={{ color: txt3 }}>Log some trades first, then the council will generate contextual reinvestment ideas based on your gains.</p>
                  <button onClick={() => setTab('trades')}
                    className="text-xs px-4 py-2 rounded-lg" style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)' }}>
                    Go to trades
                  </button>
                </div>
              ) : (
                <>
                  {/* Tiered Ideas */}
                  <div className="space-y-4">
                    <p className="text-[10px] font-mono uppercase tracking-widest" style={{ color: txt3 }}>
                      Council reinvestment strategies — 3 tiers based on your gains
                    </p>
                    {ideas.map((idea, i) => {
                      const tierBg: Record<string, string> = {
                        aggressive: 'rgba(248,113,113,0.06)',
                        moderate: 'rgba(167,139,250,0.06)',
                        conservative: 'rgba(52,211,153,0.06)',
                      }
                      const tierBorder: Record<string, string> = {
                        aggressive: 'rgba(248,113,113,0.25)',
                        moderate: 'rgba(167,139,250,0.25)',
                        conservative: 'rgba(52,211,153,0.25)',
                      }
                      const tierKey = (idea.label ?? '').toLowerCase()
                      return (
                        <div key={`${idea.ticker}-${i}`} className="rounded-2xl overflow-hidden"
                          style={{ border: `1px solid ${tierBorder[tierKey] ?? brd}` }}>

                          {/* Tier header */}
                          <div className="flex items-center justify-between px-5 py-3"
                            style={{ background: tierBg[tierKey] ?? surf2, borderBottom: `1px solid ${tierBorder[tierKey] ?? brd}` }}>
                            <div className="flex items-center gap-3">
                              <span className="text-xs font-bold px-2.5 py-0.5 rounded-full"
                                style={{ background: `${idea.tierColor}20`, color: idea.tierColor, border: `1px solid ${idea.tierColor}30` }}>
                                {idea.label}
                              </span>
                              <div>
                                <span className="text-xs font-semibold" style={{ color: txt }}>{idea.strategy}</span>
                                <span className="text-xs ml-2" style={{ color: txt3 }}>·</span>
                                <span className="text-xs ml-2" style={{ color: txt2 }}>{idea.strategyNote}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-3 shrink-0">
                              <span className="text-[10px] font-mono" style={{ color: txt3 }}>
                                {idea.pctOfGains}% of gains
                              </span>
                              <span className="text-sm font-bold font-mono" style={{ color: idea.tierColor }}>
                                {fmt$(idea.suggestedAmount)}
                              </span>
                            </div>
                          </div>

                          {/* Body */}
                          <div className="px-5 py-4 space-y-4" style={{ background: surf }}>
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1.5">
                                  <span className="text-lg font-bold font-mono" style={{ color: txt }}>
                                    {idea.ticker}
                                    {idea.isAddToExisting && (
                                      <span className="text-[10px] font-normal ml-1.5" style={{ color: txt3 }}>add to position</span>
                                    )}
                                  </span>
                                  <SigBadge s={idea.signal} />
                                  <span className="text-[10px] font-mono" style={{ color: txt3 }}>{idea.confidence}% conf.</span>
                                  {idea.currentPrice != null && (
                                    <span className="text-xs font-mono" style={{ color: txt2 }}>${sf(idea.currentPrice)}</span>
                                  )}
                                </div>
                                <p className="text-xs leading-relaxed" style={{ color: txt2 }}>{idea.rationale}</p>
                              </div>
                              <div className="text-right shrink-0 space-y-1">
                                <div className="text-[10px] font-mono uppercase" style={{ color: txt3 }}>shares</div>
                                <div className="text-sm font-bold font-mono" style={{ color: txt }}>{idea.suggestedShares}</div>
                                <div className="text-[10px] font-mono px-2 py-0.5 rounded-full inline-block"
                                  style={{ background: `${RISK_COLOR[idea.risk]}15`, color: RISK_COLOR[idea.risk] }}>
                                  {idea.risk} risk
                                </div>
                              </div>
                            </div>

                            {/* Trade plan strip */}
                            {(idea.entryNote || idea.stopNote || idea.targetNote) && (
                              <div className="grid grid-cols-3 gap-3 pt-3 border-t" style={{ borderColor: brd }}>
                                {[
                                  { label: 'Entry', val: idea.entryNote, color: '#34d399' },
                                  { label: 'Stop', val: idea.stopNote, color: '#f87171' },
                                  { label: 'Target', val: idea.targetNote, color: '#60a5fa' },
                                ].map(({ label, val, color }) => val ? (
                                  <div key={label}>
                                    <div className="text-[9px] font-mono uppercase mb-0.5" style={{ color: txt3 }}>{label}</div>
                                    <div className="text-[11px] leading-snug" style={{ color }}>{val}</div>
                                  </div>
                                ) : null)}
                              </div>
                            )}

                            <div className="flex items-center justify-between pt-1">
                              <span className="text-[10px]" style={{ color: txt3 }}>⏱ {idea.timeframe}</span>
                              <button onClick={() => router.push(`/?ticker=${idea.ticker}`)}
                                className="text-[11px] font-semibold px-3 py-1 rounded-lg transition-all hover:opacity-80"
                                style={{ background: 'rgba(167,139,250,0.08)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.15)' }}>
                                Full council analysis →
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Insights */}
                  {insights.length > 0 && (
                    <div>
                      <p className="text-[10px] font-mono uppercase tracking-widest mb-3" style={{ color: txt3 }}>
                        Council insights on your performance
                      </p>
                      <div className="space-y-2">
                        {insights.map((ins, i) => {
                          const Icon = ins.type === 'success' ? CheckCircle : ins.type === 'warning' ? AlertTriangle : Info
                          const color = ins.type === 'success' ? '#34d399' : ins.type === 'warning' ? '#fbbf24' : '#60a5fa'
                          return (
                            <div key={i} className="flex gap-3 items-start px-4 py-3 rounded-xl"
                              style={{ background: surf2, border: `1px solid ${brd}` }}>
                              <Icon size={13} style={{ color, flexShrink: 0, marginTop: 1 }} />
                              <p className="text-xs leading-relaxed" style={{ color: txt2 }}
                                dangerouslySetInnerHTML={{ __html: ins.text.replace(/\*\*(.*?)\*\*/g, `<strong style="color:${txt}">$1</strong>`) }} />
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Allocation */}
                  {allocation.length > 0 && availableCash > 0 && (
                    <div className="rounded-2xl p-5" style={{ background: surf, border: `1px solid ${brd}` }}>
                      <p className="text-[10px] font-mono uppercase tracking-widest mb-4" style={{ color: txt3 }}>
                        Suggested allocation of {fmt$(availableCash)} {realizedTotal <= 0 ? '(unrealized gains)' : ''}
                      </p>
                      <div className="space-y-3">
                        {allocation.map(a => (
                          <div key={a.label} className="flex items-center gap-3">
                            <div className="w-20 text-xs font-semibold font-mono shrink-0" style={{ color: txt }}>{a.label}</div>
                            <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: surf2 }}>
                              <div className="h-full rounded-full transition-all duration-700"
                                style={{ width: `${a.pct}%`, background: ALLOC_COLORS[a.color] ?? '#a78bfa' }} />
                            </div>
                            <div className="text-xs font-mono w-8 text-right" style={{ color: ALLOC_COLORS[a.color] ?? txt3 }}>{a.pct}%</div>
                            <div className="text-xs font-mono w-16 text-right" style={{ color: txt2 }}>{fmt$(a.amount)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex justify-center">
                    <button onClick={loadIdeas} disabled={loadingIdeas}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs transition-all hover:opacity-80"
                      style={{ color: txt3, border: `1px solid ${brd}` }}>
                      <RefreshCw size={11} className={loadingIdeas ? 'animate-spin' : ''} />
                      {loadingIdeas ? 'Refreshing...' : 'Refresh ideas'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── HISTORY TAB ──────────────────────────────────────── */}
          {tab === 'history' && (
            <div className="space-y-4">
              {closedTrades.length === 0 ? (
                <div className="rounded-2xl p-10 text-center" style={{ background: surf2, border: `1px solid ${brd}` }}>
                  <BarChart2 size={28} className="mx-auto mb-3" style={{ color: txt3 }} />
                  <p className="text-sm font-semibold mb-1" style={{ color: txt }}>No closed trades yet</p>
                  <p className="text-xs" style={{ color: txt3 }}>Close open trades to build your track record and unlock reinvestment cash.</p>
                </div>
              ) : (
                <>
                  <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${brd}` }}>
                    <table className="w-full text-sm">
                      <thead>
                        <tr style={{ background: surf2, borderBottom: `1px solid ${brd}` }}>
                          {['Ticker', 'Shares', 'Entry', 'Exit', 'P&L', 'Council', 'Closed'].map(h => (
                            <th key={h} className={`px-4 py-2.5 text-[10px] font-mono uppercase tracking-widest ${['P&L','Exit','Council','Closed'].includes(h) ? 'text-right' : 'text-left'}`}
                              style={{ color: txt3 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {closedTrades.map((t, i) => {
                          const pnl = (t.exit_price! - t.entry_price) * t.shares
                          const pnlPct = ((t.exit_price! - t.entry_price) / t.entry_price) * 100
                          return (
                            <tr key={t.id} style={{ borderBottom: i < closedTrades.length - 1 ? `1px solid ${brd}` : 'none', background: surf }}>
                              <td className="px-4 py-3 font-bold font-mono" style={{ color: txt }}>{t.ticker}</td>
                              <td className="px-4 py-3 font-mono" style={{ color: txt2 }}>{t.shares}</td>
                              <td className="px-4 py-3 font-mono" style={{ color: txt2 }}>${sf(t.entry_price)}</td>
                              <td className="px-4 py-3 font-mono text-right" style={{ color: txt }}>${sf(t.exit_price!)}</td>
                              <td className="px-4 py-3 font-mono text-right">
                                <span style={{ color: pnl >= 0 ? '#34d399' : '#f87171' }}>
                                  {(pnl ?? 0) >= 0 ? '+' : ''}{fmt$(pnl)} ({fmtPct(pnlPct)})
                                </span>
                              </td>
                              <td className="px-4 py-3 text-right"><SigBadge s={t.council_signal} /></td>
                              <td className="px-4 py-3 text-right text-xs" style={{ color: txt3 }}>
                                {t.exit_date ? new Date(t.exit_date).toLocaleDateString() : '—'}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Win rate */}
                  <div className="grid grid-cols-3 gap-3">
                    {(() => {
                      const wins = closedTrades.filter(t => t.exit_price! > t.entry_price).length
                      const totalClosed = closedTrades.length
                      const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0
                      const totalRealPnl = closedTrades.reduce((s, t) => s + (t.exit_price! - t.entry_price) * t.shares, 0)
                      const avgWin = wins > 0 ? closedTrades.filter(t => t.exit_price! > t.entry_price).reduce((s, t) => s + ((t.exit_price! - t.entry_price) / t.entry_price) * 100, 0) / wins : 0
                      return [
                        { label: 'Win rate', value: `${winRate.toFixed(0)}%`, sub: `${wins} of ${totalClosed} trades` },
                        { label: 'Total realized', value: totalRealPnl >= 0 ? `+${fmt$(totalRealPnl)}` : fmt$(totalRealPnl), sub: 'from all exits', color: totalRealPnl >= 0 ? '#34d399' : '#f87171' },
                        { label: 'Avg winning trade', value: `+${avgWin.toFixed(1)}%`, sub: 'when profitable', color: '#34d399' },
                      ].map(({ label, value, sub, color }) => (
                        <div key={label} className="rounded-xl p-3" style={{ background: surf2, border: `1px solid ${brd}` }}>
                          <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: txt3 }}>{label}</div>
                          <div className="text-xl font-bold font-mono" style={{ color: color ?? txt }}>{value}</div>
                          <div className="text-[10px] mt-0.5" style={{ color: txt3 }}>{sub}</div>
                        </div>
                      ))
                    })()}
                  </div>
                </>
              )}
            </div>
          )}

        </div>
      </div>
    </div>

    {showLogModal && (
      <LogTradeModal
        onClose={() => { setShowLogModal(false); setPrefill(undefined) }}
        onSave={logTrade}
        prefill={prefill}
      />
    )}
    {closingTrade && (
      <CloseTradeModal
        trade={closingTrade}
        onClose={() => setClosingTrade(null)}
        onSave={closeTrade}
      />
    )}
    </>
    </UpgradeGate>
  )
}

export default function ReinvestmentPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen" style={{ color: 'var(--text3)', fontSize: 14 }}>
        Loading...
      </div>
    }>
      <ReinvestmentInner />
    </Suspense>
  )
}
