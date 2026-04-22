'use client'

// ═════════════════════════════════════════════════════════════
// app/watchlist/page.tsx
//
// User's research watchlist with 15-min exit signals.
//
// Each row shows: ticker, source, exit level (color-coded green/amber/red),
// current price, change, and the original Council verdict if any.
// Click a row to expand — shows the full technicals table (same data as
// /analyze view) plus Claude's exit reasoning.
//
// Actions: mute (soft hide), delete (hard remove), manual compute-now.
// ═════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'
import {
  ArrowLeft, Eye, EyeOff, RefreshCw, Trash2, Plus, X, LogOut,
  TrendingUp, TrendingDown, Minus, AlertTriangle, Shield,
  Activity, Clock,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────
// Types (must match /api/watchlist response)
// ─────────────────────────────────────────────────────────────
interface WatchlistRow {
  entryId: number
  ticker: string
  source: string
  addedAt: string
  muted: boolean
  notes: string | null

  computedAt: string | null
  exitLevel: 'hold' | 'watch' | 'exit' | null
  exitConfidence: number | null
  exitReasons: string[] | null
  thesisStatus: 'intact' | 'weakening' | 'broken' | null

  currentPrice: number | null
  priceChange1dPct: number | null
  priceChangeSinceVerdictPct: number | null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  technicals: any | null
  technicalBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null

  originalSignal: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null
  originalConfidence: number | null
}

interface WatchlistResponse {
  rows: WatchlistRow[]
  summary: {
    total: number
    holdCount: number
    watchCount: number
    exitCount: number
    pendingCount: number
    lastComputedAt: string | null
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.round(hr / 24)
  return `${d}d ago`
}

function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(decimals)}%`
}

function fmt$(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `$${n.toFixed(decimals)}`
}

const EXIT_COLOR = {
  hold:  '#34d399',   // green
  watch: '#fbbf24',   // amber
  exit:  '#f87171',   // red
} as const

const EXIT_LABEL = {
  hold:  'HOLD',
  watch: 'WATCH',
  exit:  'EXIT',
} as const

const SOURCE_LABEL: Record<string, string> = {
  manual:  'Manual',
  analyze: 'Analyzed',
  invest:  'Position',
  movers:  'Movers',
}

// ─────────────────────────────────────────────────────────────
// Technicals table — identical fields as /analyze Council view
// ─────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TechnicalsTable({ t }: { t: any }) {
  if (!t) return <p className="text-xs text-white/50">No technicals computed yet.</p>

  const Row = ({ label, value, sub }: { label: string; value: string; sub?: string | null }) => (
    <div className="flex items-baseline justify-between gap-2 py-1">
      <span className="text-[10px] font-mono uppercase tracking-widest text-white/40">{label}</span>
      <span className="text-xs font-mono text-white/85 text-right">
        {value}
        {sub && <span className="text-white/40 ml-1">{sub}</span>}
      </span>
    </div>
  )

  const crossLabel = t.goldenCross ? 'Golden' : t.deathCross ? 'Death' : 'None'
  const macdDir = t.macdHistogram >= 0 ? '▲ pos' : '▼ neg'
  const bbLabel = t.bbSignal === 'squeeze' ? 'compression' : t.bbSignal

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-0.5">
      {/* Column 1 — Momentum */}
      <div>
        <div className="text-[9px] font-mono uppercase tracking-widest text-white/30 mb-1 pt-1">Momentum</div>
        <Row label="RSI" value={typeof t.rsi === 'number' ? t.rsi.toFixed(1) : '—'} sub={t.rsiSignal} />
        <Row label="MACD" value={macdDir} />
        <Row label="Williams %R" value={typeof t.williamsR === 'number' ? t.williamsR.toFixed(1) : '—'} sub={t.williamsSignal} />
        <Row label="CCI" value={typeof t.cci === 'number' ? t.cci.toFixed(0) : '—'} sub={t.cciSignal} />
        <Row label="ROC 10d" value={typeof t.roc10 === 'number' ? `${t.roc10.toFixed(1)}%` : '—'} />
        <Row label="Stoch %K/%D" value={
          typeof t.stochK === 'number' ? `${t.stochK.toFixed(0)}/${t.stochD.toFixed(0)}` : '—'
        } sub={t.stochSignal} />
      </div>

      {/* Column 2 — Trend & Volatility */}
      <div>
        <div className="text-[9px] font-mono uppercase tracking-widest text-white/30 mb-1 pt-1">Trend</div>
        <Row label="MA cross" value={crossLabel} />
        <Row label="vs SMA20" value={fmtPct(t.priceVsSma20)} />
        <Row label="vs SMA50" value={fmtPct(t.priceVsSma50)} />
        <Row label="vs SMA200" value={fmtPct(t.priceVsSma200)} />
        <Row label="Ichimoku" value={String(t.ichimokuSignal ?? '—').replace(/_/g, ' ')} />
        <Row label="Rel Str" value={typeof t.relStrengthVsSector === 'number' ? fmtPct(t.relStrengthVsSector) : '—'} sub={t.relStrengthSignal !== 'unknown' ? t.relStrengthSignal : null} />
      </div>

      <div>
        <div className="text-[9px] font-mono uppercase tracking-widest text-white/30 mb-1 pt-2">Volatility & Volume</div>
        <Row label="ATR(14)" value={
          typeof t.atr14 === 'number' ? `${t.atr14.toFixed(4)}` : '—'
        } sub={typeof t.atrPct === 'number' ? `(${t.atrPct.toFixed(2)}%)` : null} />
        <Row label="Bollinger" value={bbLabel ?? '—'} />
        <Row label="Volume" value={
          typeof t.volumeRatio === 'number' ? `${t.volumeRatio.toFixed(2)}x avg` : '—'
        } sub={t.volumeSignal} />
        <Row label="OBV trend" value={t.obvTrend ?? '—'} sub={t.obvDivergence !== 'none' ? `${t.obvDivergence} div` : null} />
        <Row label="VWAP" value={typeof t.priceVsVwap === 'number' ? fmtPct(t.priceVsVwap) : '—'} sub={t.vwapSignal} />
      </div>

      <div>
        <div className="text-[9px] font-mono uppercase tracking-widest text-white/30 mb-1 pt-2">Levels</div>
        <Row label="Support" value={fmt$(t.support, 2)} sub={t.support2 ? `→ ${fmt$(t.support2, 2)}` : null} />
        <Row label="Resist" value={fmt$(t.resistance, 2)} sub={t.resistance2 ? `→ ${fmt$(t.resistance2, 2)}` : null} />
        <Row label="ATR stop" value={fmt$(t.stopLossATR, 2)} />
        <Row label="ATR target" value={fmt$(t.takeProfitATR, 2)} />
        <Row label="52w range" value={`${fmt$(t.low52w, 2)} – ${fmt$(t.high52w, 2)}`} />
      </div>

      {/* Patterns — if any detected */}
      {(t.candlePattern || t.chartPattern || t.gapPattern) && (
        <div className="sm:col-span-2 pt-3 border-t mt-2 space-y-1" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
          <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">Patterns detected</div>
          {t.candlePattern && (
            <p className="text-[11px] text-white/70">
              <span className="font-mono" style={{ color: t.candlePattern.type === 'bullish' ? '#34d399' : t.candlePattern.type === 'bearish' ? '#f87171' : '#94a3b8' }}>
                Candle: {t.candlePattern.name}
              </span>
              <span className="text-white/40"> — {t.candlePattern.description}</span>
            </p>
          )}
          {t.chartPattern && (
            <p className="text-[11px] text-white/70">
              <span className="font-mono" style={{ color: t.chartPattern.type === 'bullish' ? '#34d399' : t.chartPattern.type === 'bearish' ? '#f87171' : '#94a3b8' }}>
                Chart: {t.chartPattern.name}
              </span>
              <span className="text-white/40"> — {t.chartPattern.description}</span>
            </p>
          )}
          {t.gapPattern && (
            <p className="text-[11px] text-white/70">
              <span className="font-mono" style={{ color: t.gapPattern.type === 'up' ? '#34d399' : '#f87171' }}>
                Gap: {t.gapPattern.type} {t.gapPattern.size?.toFixed(2)}%
              </span>
              <span className="text-white/40"> — {t.gapPattern.description}</span>
            </p>
          )}
        </div>
      )}

      {/* Overall */}
      {t.summary && (
        <div className="sm:col-span-2 pt-2 mt-2 border-t" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
          <div className="text-[9px] font-mono uppercase tracking-widest text-white/30 mb-1">Summary</div>
          <p className="text-[11px] text-white/65 leading-relaxed">{t.summary}</p>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Single watchlist row
// ─────────────────────────────────────────────────────────────
function WatchRow({
  row, onMute, onDelete, onAnalyze,
}: {
  row: WatchlistRow
  onMute: (ticker: string, muted: boolean) => void
  onDelete: (ticker: string) => void
  onAnalyze: (ticker: string) => void
}) {
  const [expanded, setExpanded] = useState(false)

  const exitLevel = row.exitLevel
  const color = exitLevel ? EXIT_COLOR[exitLevel] : '#94a3b8'
  const bg = exitLevel ? `${color}08` : 'rgba(148,163,184,0.04)'
  const border = exitLevel ? `${color}20` : 'rgba(148,163,184,0.12)'

  const dayColor = row.priceChange1dPct !== null
    ? (row.priceChange1dPct >= 0 ? '#34d399' : '#f87171')
    : '#94a3b8'

  return (
    <div className="rounded-xl border transition-all"
      style={{ background: bg, borderColor: border }}>
      <div className="p-3 sm:p-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            {/* Ticker */}
            <div className="shrink-0 px-2.5 py-1 rounded-lg font-mono font-bold text-sm"
              style={{ background: `${color}18`, color, border: `1px solid ${color}30` }}>
              {row.ticker}
            </div>

            {/* Price + change */}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-mono font-semibold text-white/90">
                  {fmt$(row.currentPrice)}
                </span>
                <span className="text-xs font-mono" style={{ color: dayColor }}>
                  {fmtPct(row.priceChange1dPct, 2)}
                </span>
                {row.priceChangeSinceVerdictPct !== null && (
                  <span className="text-[10px] font-mono text-white/40"
                    title="Change since original verdict">
                    (v: {fmtPct(row.priceChangeSinceVerdictPct, 1)})
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(148,163,184,0.1)', color: '#94a3b8' }}>
                  {SOURCE_LABEL[row.source] ?? row.source}
                </span>
                {row.originalSignal && (
                  <span className="text-[10px] font-mono text-white/40"
                    title={`Original Council verdict ${row.originalConfidence}%`}>
                    Council: {row.originalSignal}
                    {row.originalConfidence ? ` ${row.originalConfidence}%` : ''}
                  </span>
                )}
                {row.computedAt && (
                  <span className="text-[10px] font-mono text-white/30"
                    title={new Date(row.computedAt).toLocaleString()}>
                    {timeAgo(row.computedAt)}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Exit level badge */}
          <div className="flex items-center gap-2 shrink-0">
            {exitLevel ? (
              <div className="flex flex-col items-end">
                <span className="text-[11px] font-mono font-bold px-2 py-1 rounded-full"
                  style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}>
                  {exitLevel === 'hold' ? <Shield size={10} className="inline mr-1" />
                    : exitLevel === 'watch' ? <Eye size={10} className="inline mr-1" />
                    : <AlertTriangle size={10} className="inline mr-1" />}
                  {EXIT_LABEL[exitLevel]}
                </span>
                {typeof row.exitConfidence === 'number' && (
                  <span className="text-[9px] text-white/40 font-mono mt-0.5">
                    {row.exitConfidence}% conf
                  </span>
                )}
              </div>
            ) : (
              <span className="text-[10px] font-mono px-2 py-1 rounded-full"
                style={{ background: 'rgba(148,163,184,0.1)', color: '#94a3b8' }}>
                <Clock size={9} className="inline mr-1" />
                Pending
              </span>
            )}
            <span className="text-white/25 text-xs">{expanded ? '▲' : '▼'}</span>
          </div>
        </div>

        {/* Reasons preview — always shown when exit or watch */}
        {exitLevel && exitLevel !== 'hold' && row.exitReasons && row.exitReasons.length > 0 && (
          <div className="mt-2 pt-2 border-t flex flex-wrap gap-1.5"
            style={{ borderColor: `${color}15` }}>
            {row.exitReasons.slice(0, 3).map((r, i) => (
              <span key={i} className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: `${color}10`, color, border: `1px solid ${color}20` }}>
                {r}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Expanded: full detail */}
      {expanded && (
        <div className="px-3 sm:px-4 pb-4 space-y-4 border-t"
          style={{ borderColor: `${color}15` }}>

          {/* Exit reasoning */}
          {row.exitReasons && row.exitReasons.length > 0 && (
            <div className="pt-3">
              <div className="flex items-center gap-1.5 mb-2">
                <Activity size={11} style={{ color }} />
                <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color }}>
                  Why {EXIT_LABEL[exitLevel ?? 'hold']}
                </div>
                {row.thesisStatus && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded ml-auto"
                    style={{
                      background: row.thesisStatus === 'intact' ? 'rgba(52,211,153,0.1)'
                        : row.thesisStatus === 'weakening' ? 'rgba(251,191,36,0.1)'
                        : 'rgba(248,113,113,0.1)',
                      color: row.thesisStatus === 'intact' ? '#34d399'
                        : row.thesisStatus === 'weakening' ? '#fbbf24' : '#f87171',
                    }}>
                    thesis: {row.thesisStatus}
                  </span>
                )}
              </div>
              <ul className="space-y-1">
                {row.exitReasons.map((r, i) => (
                  <li key={i} className="text-xs text-white/75 flex items-start gap-2">
                    <span className="mt-1.5 inline-block w-1 h-1 rounded-full shrink-0"
                      style={{ background: color }} />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Full technicals table */}
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-2">
              Technicals (same as Council view)
            </div>
            <TechnicalsTable t={row.technicals} />
          </div>

          {/* Notes */}
          {row.notes && (
            <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="text-[10px] font-mono uppercase tracking-widest text-white/30 mb-1">Your notes</div>
              <p className="text-xs text-white/70 leading-relaxed whitespace-pre-wrap">{row.notes}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              onClick={(e) => { e.stopPropagation(); onAnalyze(row.ticker) }}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-90"
              style={{ background: 'rgba(96,165,250,0.15)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)' }}>
              <RefreshCw size={11} />
              Re-run Council
            </button>

            <button
              onClick={(e) => { e.stopPropagation(); onMute(row.ticker, !row.muted) }}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-90"
              style={{ background: 'rgba(148,163,184,0.12)', color: '#94a3b8', border: '1px solid rgba(148,163,184,0.2)' }}>
              {row.muted ? <Eye size={11} /> : <EyeOff size={11} />}
              {row.muted ? 'Unmute' : 'Mute'}
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation()
                if (confirm(`Remove ${row.ticker} from watchlist?`)) onDelete(row.ticker)
              }}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-90 ml-auto"
              style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
              <Trash2 size={11} />
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────
export default function WatchlistPage() {
  const router = useRouter()
  const supabase = createClient()

  const [authLoaded, setAuthLoaded] = useState(false)
  const [data, setData] = useState<WatchlistResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Add-ticker input
  const [showAdd, setShowAdd] = useState(false)
  const [newTicker, setNewTicker] = useState('')
  const [adding, setAdding] = useState(false)

  // Filter
  const [filter, setFilter] = useState<'all' | 'hold' | 'watch' | 'exit' | 'pending'>('all')

  // ── Auth gate ────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!mounted) return
      if (!user) { window.location.replace('/login'); return }
      setAuthLoaded(true)
    })
    return () => { mounted = false }
  }, [supabase])

  // ── Load data ────────────────────────────────────────────────
  const loadWatchlist = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch('/api/watchlist', { credentials: 'include' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const body: WatchlistResponse = await res.json()
      setData(body)
    } catch (e) {
      setErr((e as Error).message?.slice(0, 200) ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (authLoaded) void loadWatchlist()
  }, [authLoaded, loadWatchlist])

  // ── Actions ──────────────────────────────────────────────────
  const handleAdd = useCallback(async () => {
    const ticker = newTicker.trim().toUpperCase()
    if (!/^[A-Z0-9\-\.]{1,10}$/.test(ticker)) {
      setErr('Invalid ticker — letters/numbers only, up to 10 chars')
      return
    }
    setAdding(true)
    setErr(null)
    try {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, source: 'manual' }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error ?? 'Failed to add')
      setNewTicker('')
      setShowAdd(false)
      await loadWatchlist()
    } catch (e) {
      setErr((e as Error).message?.slice(0, 200) ?? 'Failed to add')
    } finally {
      setAdding(false)
    }
  }, [newTicker, loadWatchlist])

  const handleMute = useCallback(async (ticker: string, muted: boolean) => {
    try {
      await fetch('/api/watchlist', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, muted }),
      })
      await loadWatchlist()
    } catch { /* ignore, reload will show state */ }
  }, [loadWatchlist])

  const handleDelete = useCallback(async (ticker: string) => {
    try {
      await fetch(`/api/watchlist?ticker=${encodeURIComponent(ticker)}&hard=true`, {
        method: 'DELETE',
      })
      await loadWatchlist()
    } catch { /* ignore */ }
  }, [loadWatchlist])

  const handleAnalyze = useCallback((ticker: string) => {
    router.push(`/?ticker=${encodeURIComponent(ticker)}`)
  }, [router])

  const handleSignOut = async () => {
    try { await fetch('/api/auth/session', { method: 'DELETE' }) } catch { /* ignore */ }
    await supabase.auth.signOut()
    window.location.replace('/login')
  }

  // ── Render ───────────────────────────────────────────────────
  if (!authLoaded) {
    return (
      <main className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="flex gap-1.5">
          {[0, 1, 2].map(i => (
            <span key={i} className="w-2 h-2 rounded-full thinking-dot"
              style={{ background: '#a78bfa', animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
      </main>
    )
  }

  const rows = data?.rows ?? []
  const summary = data?.summary

  const filteredRows = rows.filter(r => {
    if (filter === 'all') return true
    if (filter === 'pending') return r.exitLevel === null
    return r.exitLevel === filter
  })

  return (
    <main className="min-h-screen flex flex-col" style={{ background: 'var(--bg)', color: 'var(--text1)' }}>
      {/* Header */}
      <header className="flex items-center justify-between px-3 sm:px-5 py-3 border-b"
        style={{ background: 'var(--nav-bg)', borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-3">
          <button onClick={() => router.push('/')}
            className="flex items-center gap-1 text-[11px] font-mono px-2.5 py-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'var(--surface2)', color: 'var(--text3)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <ArrowLeft size={11} />
            <span className="hidden sm:inline">Home</span>
          </button>
          <div className="flex items-center gap-2">
            <Eye size={14} style={{ color: '#a78bfa' }} />
            <h1 className="text-sm font-bold">Watchlist</h1>
            {summary && (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                style={{ background: 'var(--surface2)', color: 'var(--text3)' }}>
                {summary.total}
              </span>
            )}
            {summary?.lastComputedAt && (
              <span className="text-[10px] font-mono text-white/40 hidden sm:inline">
                · updated {timeAgo(summary.lastComputedAt)}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={loadWatchlist}
            className="p-1.5 rounded-lg transition-all hover:opacity-80"
            title="Refresh"
            style={{ background: 'var(--surface2)', color: 'var(--text3)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={handleSignOut}
            className="p-1.5 rounded-lg transition-all hover:opacity-80"
            title="Sign out"
            style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
            <LogOut size={12} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-3 sm:px-5 py-4 space-y-4">

          {/* Summary bar */}
          {summary && summary.total > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label: 'HOLD',  count: summary.holdCount,  color: '#34d399', filter: 'hold' as const },
                { label: 'WATCH', count: summary.watchCount, color: '#fbbf24', filter: 'watch' as const },
                { label: 'EXIT',  count: summary.exitCount,  color: '#f87171', filter: 'exit' as const },
                { label: 'PEND',  count: summary.pendingCount, color: '#94a3b8', filter: 'pending' as const },
              ].map(s => (
                <button key={s.label}
                  onClick={() => setFilter(filter === s.filter ? 'all' : s.filter)}
                  className="rounded-xl border p-3 text-left transition-all hover:opacity-90"
                  style={{
                    background: filter === s.filter ? `${s.color}12` : 'var(--surface)',
                    borderColor: filter === s.filter ? `${s.color}30` : 'var(--border)',
                  }}>
                  <div className="text-[9px] font-mono uppercase tracking-widest"
                    style={{ color: s.color }}>{s.label}</div>
                  <div className="text-2xl font-bold font-mono mt-0.5"
                    style={{ color: s.color }}>{s.count}</div>
                </button>
              ))}
            </div>
          )}

          {/* Error */}
          {err && (
            <div className="rounded-xl border p-3 text-xs"
              style={{ background: 'rgba(248,113,113,0.08)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
              <div className="flex items-start gap-2">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>{err}</span>
              </div>
            </div>
          )}

          {/* Add ticker — inline expandable */}
          <div className="rounded-xl border"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            {!showAdd ? (
              <button onClick={() => setShowAdd(true)}
                className="w-full flex items-center gap-2 px-4 py-3 text-sm text-white/60 hover:text-white/80 transition-all">
                <Plus size={14} />
                Add ticker to watchlist
              </button>
            ) : (
              <div className="p-3 flex items-center gap-2">
                <input
                  type="text"
                  autoFocus
                  value={newTicker}
                  onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
                  placeholder="e.g. NVDA"
                  disabled={adding}
                  className="flex-1 px-3 py-2 rounded-lg text-sm font-mono"
                  style={{ background: 'var(--surface2)', color: 'var(--text1)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
                <button onClick={handleAdd}
                  disabled={adding || !newTicker.trim()}
                  className="px-3 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50"
                  style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)' }}>
                  {adding ? '...' : 'Add'}
                </button>
                <button onClick={() => { setShowAdd(false); setNewTicker(''); setErr(null) }}
                  className="p-2 rounded-lg transition-all hover:opacity-80"
                  style={{ background: 'var(--surface2)', color: 'var(--text3)' }}>
                  <X size={12} />
                </button>
              </div>
            )}
          </div>

          {/* Rows */}
          {loading && !data && (
            <div className="text-center py-8 text-sm text-white/50">Loading…</div>
          )}

          {!loading && rows.length === 0 && (
            <div className="rounded-2xl border p-8 text-center"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <Eye size={24} className="mx-auto mb-3 opacity-40" style={{ color: '#a78bfa' }} />
              <h3 className="text-sm font-semibold text-white/80 mb-1">No stocks in your watchlist yet</h3>
              <p className="text-xs text-white/50 max-w-sm mx-auto leading-relaxed mb-4">
                Add tickers manually, or they'll auto-populate when you run Council analysis on /analyze.
                Every 15 minutes during market hours, the system checks technicals and tells you hold / watch / exit.
              </p>
              <button onClick={() => setShowAdd(true)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90"
                style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)' }}>
                <Plus size={12} />
                Add first ticker
              </button>
            </div>
          )}

          {filteredRows.length > 0 && (
            <div className="space-y-2">
              {filteredRows.map(row => (
                <WatchRow key={row.entryId}
                  row={row}
                  onMute={handleMute}
                  onDelete={handleDelete}
                  onAnalyze={handleAnalyze} />
              ))}
            </div>
          )}

          {rows.length > 0 && filteredRows.length === 0 && (
            <div className="text-center py-6 text-sm text-white/40">
              No stocks match the "{filter}" filter.
              {' '}
              <button onClick={() => setFilter('all')}
                className="underline hover:text-white/70">Show all</button>
            </div>
          )}

          {/* Footer */}
          <div className="text-center py-4">
            <p className="text-[10px] text-white/30 leading-relaxed max-w-md mx-auto">
              Exit signals update every 15 minutes during market hours.
              {' '}Technicals are identical to /analyze Council view. Educational — verify independently before trading real money.
            </p>
          </div>
        </div>
      </div>
    </main>
  )
}
