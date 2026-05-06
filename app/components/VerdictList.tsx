'use client'

// =============================================================
// app/components/VerdictList.tsx
//
// Filterable, paginated list of verdicts for the /track-record
// page. Each row shows: ticker, signal, confidence, trade plan,
// trader decision, 1D + 1W outcomes, version, date.
//
// Click a row to expand and see entry/stop/target details.
//
// Props:
//   - externalVersion: when set (e.g. user clicked a version card
//     above this list), forces the version filter to that number
//     and locks the dropdown.
//
// Data: GET /api/track-record/verdicts?version=N&signal=S&...
// =============================================================

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  ChevronDown, ChevronRight, ChevronLeft,
  TrendingUp, TrendingDown, Minus,
  CheckCircle2, XCircle, Clock, AlertCircle, RefreshCw,
} from 'lucide-react'
import {
  SYSTEM_VERSIONS, type SystemVersion,
} from '@/app/lib/system-versions'

interface VerdictRow {
  id: number
  ticker: string
  signal: string
  confidence: number | null
  entryPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  timeHorizon: string | null
  timeframe: string | null
  traderDecision: string | null
  traderGrade: string | null
  traderRiskReward: number | null
  outcome1dStrict: string | null
  outcome1dDirectional: string | null
  outcome1wStrict: string | null
  outcome1wDirectional: string | null
  outcome1wPrice: number | null
  versionNumber: number | null
  versionLabel: string | null
  createdAt: string
}

interface VerdictsPayload {
  rows: VerdictRow[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

type SignalFilter = 'all' | 'BULLISH' | 'BEARISH'
type OutcomeFilter = 'all' | 'win' | 'loss' | 'expired' | 'pending'
type VersionFilter = number | 'all'

interface Props {
  /** When set, forces the version filter and disables the dropdown */
  externalVersion?: VersionFilter | null
  /** Callback when user clears the external version lock */
  onClearExternalVersion?: () => void
}

export function VerdictList({ externalVersion, onClearExternalVersion }: Props) {
  const [versionFilter, setVersionFilter] = useState<VersionFilter>(externalVersion ?? 'all')
  const [signalFilter, setSignalFilter] = useState<SignalFilter>('all')
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('all')
  const [page, setPage] = useState(1)

  const [payload, setPayload] = useState<VerdictsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  // Sync external filter
  useEffect(() => {
    if (externalVersion !== undefined && externalVersion !== null) {
      setVersionFilter(externalVersion)
      setPage(1)
    }
  }, [externalVersion])

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1)
  }, [versionFilter, signalFilter, outcomeFilter])

  // Cancel in-flight requests when filters change rapidly
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        version: versionFilter === 'all' ? 'all' : String(versionFilter),
        signal: signalFilter,
        outcome: outcomeFilter,
        page: String(page),
        pageSize: '20',
      })
      const res = await fetch(`/api/track-record/verdicts?${params}`, { signal: ac.signal })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data: VerdictsPayload = await res.json()
      if (!ac.signal.aborted) setPayload(data)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setError((e as Error).message)
    } finally {
      if (!ac.signal.aborted) setLoading(false)
    }
  }, [versionFilter, signalFilter, outcomeFilter, page])

  useEffect(() => { load() }, [load])

  const versionFilterLocked = externalVersion !== undefined && externalVersion !== null
  const versions = useMemo(() => SYSTEM_VERSIONS, [])

  return (
    <section
      className="rounded-xl border"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
        <div>
          <h2 className="text-base font-bold">Recent verdicts</h2>
          <p className="text-[11px] text-white/40 mt-0.5">
            Every directional call the Council has made, with outcomes once they grade
          </p>
        </div>
        {payload && (
          <span className="text-[10px] font-mono text-white/35">
            {payload.total} total
          </span>
        )}
      </div>

      {/* Filter strip */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
        {/* Version */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono uppercase tracking-widest text-white/35">Version</span>
          {versionFilterLocked ? (
            <button
              onClick={onClearExternalVersion}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono"
              style={{
                background: 'rgba(167,139,250,0.10)',
                color: '#a78bfa',
                border: '1px solid rgba(167,139,250,0.25)',
              }}
              title="Click to clear filter"
            >
              {labelForVersionFilter(versionFilter, versions)}
              <XCircle size={11} />
            </button>
          ) : (
            <FilterSelect
              value={versionFilter === 'all' ? 'all' : String(versionFilter)}
              onChange={v => setVersionFilter(v === 'all' ? 'all' : parseInt(v, 10))}
              options={[
                { value: 'all', label: 'All' },
                ...versions.map(ver => ({ value: String(ver.number), label: ver.label })),
              ]}
            />
          )}
        </div>

        {/* Signal */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono uppercase tracking-widest text-white/35">Signal</span>
          <FilterSelect
            value={signalFilter}
            onChange={v => setSignalFilter(v as SignalFilter)}
            options={[
              { value: 'all', label: 'All' },
              { value: 'BULLISH', label: 'Bullish' },
              { value: 'BEARISH', label: 'Bearish' },
            ]}
          />
        </div>

        {/* Outcome */}
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono uppercase tracking-widest text-white/35">Outcome (1W)</span>
          <FilterSelect
            value={outcomeFilter}
            onChange={v => setOutcomeFilter(v as OutcomeFilter)}
            options={[
              { value: 'all', label: 'All' },
              { value: 'win', label: 'Win' },
              { value: 'loss', label: 'Loss' },
              { value: 'expired', label: 'Expired' },
              { value: 'pending', label: 'Pending' },
            ]}
          />
        </div>
      </div>

      {/* Body */}
      {loading && !payload && (
        <div className="flex items-center justify-center py-10">
          <RefreshCw size={16} className="animate-spin text-white/30" />
          <span className="ml-2 text-xs text-white/40">Loading verdicts…</span>
        </div>
      )}

      {error && (
        <div className="p-4 flex items-start gap-2 m-4 rounded-lg"
          style={{ background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.2)' }}>
          <AlertCircle size={14} style={{ color: '#f87171' }} className="shrink-0 mt-0.5" />
          <div>
            <div className="text-xs font-semibold" style={{ color: '#f87171' }}>Failed to load</div>
            <p className="text-[11px] text-white/55 mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {!loading && !error && payload && payload.rows.length === 0 && (
        <div className="py-10 text-center text-xs text-white/40">
          No verdicts match these filters.
        </div>
      )}

      {payload && payload.rows.length > 0 && (
        <div>
          {/* Subtle loading indicator while filtering */}
          {loading && (
            <div className="px-4 py-1 text-[10px] font-mono text-white/35 flex items-center gap-1.5">
              <RefreshCw size={9} className="animate-spin" />
              Updating…
            </div>
          )}
          {payload.rows.map(v => (
            <VerdictRow
              key={v.id}
              v={v}
              expanded={expandedId === v.id}
              onToggle={() => setExpandedId(prev => prev === v.id ? null : v.id)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {payload && payload.totalPages > 1 && (
        <div
          className="flex items-center justify-between px-4 py-3 border-t"
          style={{ borderColor: 'var(--border)' }}
        >
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-mono disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-80 transition-opacity"
            style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <ChevronLeft size={11} />
            Prev
          </button>
          <span className="text-[11px] font-mono text-white/45">
            Page {page} / {payload.totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(payload.totalPages, p + 1))}
            disabled={page >= payload.totalPages}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-mono disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-80 transition-opacity"
            style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            Next
            <ChevronRight size={11} />
          </button>
        </div>
      )}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────

function VerdictRow({
  v, expanded, onToggle,
}: {
  v: VerdictRow
  expanded: boolean
  onToggle: () => void
}) {
  const SignalIcon =
    v.signal === 'BULLISH' ? TrendingUp :
    v.signal === 'BEARISH' ? TrendingDown :
    Minus
  const signalColor =
    v.signal === 'BULLISH' ? '#34d399' :
    v.signal === 'BEARISH' ? '#f87171' :
    '#94a3b8'

  return (
    <div
      className="border-b last:border-b-0"
      style={{ borderColor: 'var(--border)' }}
    >
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        {/* Caret */}
        <ChevronRight
          size={11}
          className="shrink-0 text-white/25 transition-transform"
          style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
        />

        {/* Ticker */}
        <div className="shrink-0 w-14">
          <div className="text-sm font-bold font-mono">{v.ticker}</div>
          <div className="text-[9px] font-mono text-white/30 mt-0.5">{formatDate(v.createdAt)}</div>
        </div>

        {/* Signal + confidence */}
        <div className="shrink-0 flex items-center gap-1.5">
          <SignalIcon size={11} style={{ color: signalColor }} />
          <span className="text-[11px] font-mono font-semibold" style={{ color: signalColor }}>
            {v.signal}
          </span>
          {v.confidence !== null && (
            <span className="text-[10px] font-mono text-white/45">{v.confidence}%</span>
          )}
        </div>

        {/* Trader decision pill */}
        {v.traderDecision && (
          <TraderPill decision={v.traderDecision} grade={v.traderGrade} />
        )}

        {/* Outcome pills (1D + 1W) */}
        <div className="ml-auto flex items-center gap-1.5">
          <OutcomePill label="1D" strict={v.outcome1dStrict} directional={v.outcome1dDirectional} />
          <OutcomePill label="1W" strict={v.outcome1wStrict} directional={v.outcome1wDirectional} />
        </div>

        {/* Version */}
        {v.versionLabel && (
          <span
            className="shrink-0 text-[9px] font-mono px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.45)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            {v.versionLabel}
          </span>
        )}
      </button>

      {/* Expanded body */}
      {expanded && (
        <div
          className="px-4 pb-4 pl-11 grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]"
        >
          <DetailItem label="Entry" value={fmtPrice(v.entryPrice)} />
          <DetailItem label="Stop" value={fmtPrice(v.stopLoss)} accent="#f87171" />
          <DetailItem label="Target" value={fmtPrice(v.takeProfit)} accent="#34d399" />
          <DetailItem label="R:R" value={v.traderRiskReward !== null ? `${v.traderRiskReward.toFixed(2)}:1` : '—'} />

          <DetailItem label="Time horizon" value={v.timeHorizon ?? '—'} />
          <DetailItem label="Timeframe" value={v.timeframe ?? '—'} />
          <DetailItem label="1W close" value={fmtPrice(v.outcome1wPrice)} />
          <DetailItem
            label="Direction (1W)"
            value={v.outcome1wDirectional ?? '—'}
            accent={
              v.outcome1wDirectional === 'correct' ? '#34d399' :
              v.outcome1wDirectional === 'incorrect' ? '#f87171' :
              undefined
            }
          />
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function TraderPill({ decision, grade }: { decision: string; grade: string | null }) {
  const color =
    decision === 'TAKE' ? '#34d399' :
    decision === 'WAIT' ? '#fbbf24' :
    decision === 'PASS' ? '#94a3b8' :
    'rgba(255,255,255,0.5)'
  return (
    <span
      className="shrink-0 text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-widest"
      style={{ background: `${color}15`, color, border: `1px solid ${color}30` }}
      title={grade ? `Grade ${grade}` : undefined}
    >
      {decision}{grade && decision === 'TAKE' ? ` ${grade}` : ''}
    </span>
  )
}

function OutcomePill({
  label, strict, directional,
}: {
  label: string
  strict: string | null
  directional: string | null
}) {
  // Use strict for the primary label (win/loss/expired/pending)
  // Color by strict; show small directional indicator if differs
  const isPending = strict === null || strict === 'pending'
  const shown =
    isPending ? 'pending' :
    strict === 'win' ? 'win' :
    strict === 'loss' ? 'loss' :
    strict === 'expired' ? 'expired' :
    strict ?? '—'

  const color =
    shown === 'win'      ? '#34d399' :
    shown === 'loss'     ? '#f87171' :
    shown === 'expired'  ? '#94a3b8' :
    shown === 'pending'  ? '#fbbf24' :
    'rgba(255,255,255,0.4)'

  const Icon =
    shown === 'win'      ? CheckCircle2 :
    shown === 'loss'     ? XCircle :
    shown === 'expired'  ? Minus :
    Clock

  return (
    <div className="shrink-0 flex items-center gap-1">
      <span
        className="text-[8px] font-mono uppercase tracking-widest"
        style={{ color: 'rgba(255,255,255,0.35)' }}
      >
        {label}
      </span>
      <span
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-widest"
        style={{ background: `${color}12`, color, border: `1px solid ${color}25` }}
      >
        <Icon size={9} />
        {shown}
      </span>
    </div>
  )
}

function DetailItem({
  label, value, accent,
}: {
  label: string
  value: string
  accent?: string
}) {
  return (
    <div>
      <div className="text-[9px] font-mono uppercase tracking-widest text-white/30 mb-0.5">{label}</div>
      <div className="font-mono" style={{ color: accent ?? 'rgba(255,255,255,0.7)' }}>{value}</div>
    </div>
  )
}

function FilterSelect({
  value, onChange, options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="appearance-none pl-2 pr-6 py-1 rounded text-[11px] font-mono cursor-pointer focus:outline-none"
        style={{
          background: 'rgba(255,255,255,0.04)',
          color: 'rgba(255,255,255,0.7)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value} style={{ background: '#1a1a1a' }}>{o.label}</option>
        ))}
      </select>
      <ChevronDown
        size={10}
        className="absolute right-1.5 top-1/2 pointer-events-none"
        style={{ color: 'rgba(255,255,255,0.4)', transform: 'translateY(-50%)' }}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function fmtPrice(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '—'
  return `$${p.toFixed(2)}`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const ms = now.getTime() - d.getTime()
  const days = Math.floor(ms / (1000 * 60 * 60 * 24))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function labelForVersionFilter(v: VersionFilter, versions: SystemVersion[]): string {
  if (v === 'all') return 'All versions'
  return versions.find(x => x.number === v)?.label ?? `Version ${v}`
}
