// app/components/portfolio/ClosedTab.tsx
//
// Renders the Closed tab on the portfolio page.
// Shows: closed positions, partial-closed positions, close events history,
// and aggregate realized P&L.

'use client'

import { useState, useEffect, useCallback } from 'react'
import { TrendingUp, TrendingDown, ChevronDown, ChevronRight, Calendar } from 'lucide-react'

// ─────────────────────────────────────────────────────────────
// Types — match API response shape from /api/portfolio/closed
// ─────────────────────────────────────────────────────────────

interface ClosedPosition {
  id: string
  ticker: string
  position_type: 'stock' | 'option' | null
  option_type: 'call' | 'put' | null
  strike: number | null
  expiry: string | null
  contracts: number | null
  shares: number
  avg_cost: number | null
  entry_premium: number | null
  status: 'open' | 'closed' | 'partial'
  closed_at: string | null
  closed_reason: string | null
  added_at: string
}

interface CloseEvent {
  id: string
  position_id: string
  closed_at: string
  close_type: 'full' | 'partial' | 'scale_out_step'
  closed_reason: string
  quantity_closed: number
  exit_price: number
  exit_value: number
  realized_pnl: number
  realized_pnl_pct: number | null
  postmortem: PostmortemShape | null
  notes: string | null
}

interface PostmortemShape {
  grade?: string
  outcome?: string
  what_worked?: string
  what_missed?: string
  key_lesson?: string
  next_time?: string
  [k: string]: unknown
}

interface ClosedTabProps {
  // Allow parent to trigger reload after a close happens
  reloadKey?: number
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const fmt = (n: number) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtSigned = (n: number) => `${n >= 0 ? '+' : '-'}$${fmt(Math.abs(n))}`
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`

const reasonLabel = (r: string): string => ({
  manual: 'Manual close',
  target_hit: 'Target hit',
  stop_hit: 'Stop hit',
  expired: 'Expired',
  assigned: 'Assigned',
  exercised: 'Exercised',
}[r] ?? r)

const gradeColor = (g: string | undefined): string => {
  if (!g) return '#94a3b8'
  return ({ A: '#34d399', B: '#60a5fa', C: '#fbbf24', D: '#f97316', F: '#f87171' } as Record<string, string>)[g] ?? '#94a3b8'
}

const formatDate = (iso: string | null): string => {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────

export function ClosedTab({ reloadKey }: ClosedTabProps) {
  const [closedPositions, setClosedPositions] = useState<ClosedPosition[]>([])
  const [partialPositions, setPartialPositions] = useState<ClosedPosition[]>([])
  const [closeEvents, setCloseEvents] = useState<CloseEvent[]>([])
  const [realizedPnlTotal, setRealizedPnlTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/portfolio/closed')
      if (res.ok) {
        const data = await res.json()
        setClosedPositions(data.closed_positions ?? [])
        setPartialPositions(data.partial_positions ?? [])
        setCloseEvents(data.close_events ?? [])
        setRealizedPnlTotal(data.realized_pnl_total ?? 0)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load, reloadKey])

  // Aggregate stats
  const winningEvents = closeEvents.filter(e => e.realized_pnl > 0)
  const losingEvents = closeEvents.filter(e => e.realized_pnl < 0)
  const breakEvenEvents = closeEvents.filter(e => e.realized_pnl === 0)
  const winRate = closeEvents.length > 0
    ? (winningEvents.length / closeEvents.length) * 100
    : 0
  const avgWin = winningEvents.length > 0
    ? winningEvents.reduce((s, e) => s + e.realized_pnl, 0) / winningEvents.length
    : 0
  const avgLoss = losingEvents.length > 0
    ? losingEvents.reduce((s, e) => s + e.realized_pnl, 0) / losingEvents.length
    : 0

  if (loading) {
    return (
      <div className="text-center py-12 text-sm" style={{ color: 'var(--text3)' }}>
        Loading closed positions…
      </div>
    )
  }

  if (closeEvents.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-sm mb-2" style={{ color: 'var(--text2)' }}>
          No closed positions yet
        </div>
        <div className="text-xs" style={{ color: 'var(--text3)' }}>
          When you close a position, it will appear here with realized P&L and postmortem.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div
          className="rounded-xl border p-4"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text3)' }}>
            Realized P&L
          </div>
          <div
            className="text-2xl font-bold font-mono tabular-nums"
            style={{ color: realizedPnlTotal >= 0 ? '#34d399' : '#f87171' }}
          >
            {fmtSigned(realizedPnlTotal)}
          </div>
          <div className="text-xs font-mono mt-1" style={{ color: 'var(--text3)' }}>
            across {closeEvents.length} close{closeEvents.length === 1 ? '' : 's'}
          </div>
        </div>

        <div
          className="rounded-xl border p-4"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text3)' }}>
            Win rate
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums" style={{ color: 'var(--text)' }}>
            {winRate.toFixed(0)}%
          </div>
          <div className="text-xs font-mono mt-1" style={{ color: 'var(--text3)' }}>
            {winningEvents.length}W / {losingEvents.length}L{breakEvenEvents.length > 0 ? ` / ${breakEvenEvents.length}BE` : ''}
          </div>
        </div>

        <div
          className="rounded-xl border p-4"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text3)' }}>
            Avg win
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums" style={{ color: '#34d399' }}>
            {avgWin > 0 ? fmtSigned(avgWin) : '—'}
          </div>
        </div>

        <div
          className="rounded-xl border p-4"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text3)' }}>
            Avg loss
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums" style={{ color: '#f87171' }}>
            {avgLoss < 0 ? fmtSigned(avgLoss) : '—'}
          </div>
        </div>
      </div>

      {/* Partial-closed positions warning (still open, partly closed) */}
      {partialPositions.length > 0 && (
        <div
          className="rounded-xl border p-4"
          style={{
            background: 'rgba(251,191,36,0.05)',
            borderColor: 'rgba(251,191,36,0.3)',
          }}
        >
          <div
            className="text-[10px] font-mono uppercase tracking-wider mb-2"
            style={{ color: '#fbbf24' }}
          >
            {partialPositions.length} partial{partialPositions.length === 1 ? '' : 's'} still open
          </div>
          <div className="space-y-2">
            {partialPositions.map(p => (
              <div
                key={p.id}
                className="flex items-center gap-3 text-sm"
                style={{ color: 'var(--text2)' }}
              >
                <span className="font-mono font-bold" style={{ color: 'var(--text)' }}>
                  {p.ticker}
                </span>
                <span style={{ color: 'var(--text3)' }}>
                  {p.position_type === 'option'
                    ? `${p.contracts} contract${p.contracts === 1 ? '' : 's'} remaining`
                    : `${p.shares} shares remaining`}
                </span>
              </div>
            ))}
          </div>
          <div className="text-[10px] mt-2" style={{ color: 'var(--text3)' }}>
            These positions are still open in the Holdings tab. The closed portions show in the events below.
          </div>
        </div>
      )}

      {/* Close events history */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <div
          className="flex items-center gap-2 px-4 py-3 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <Calendar size={12} style={{ color: 'var(--text3)' }} />
          <span
            className="text-[10px] font-mono uppercase tracking-wider"
            style={{ color: 'var(--text3)' }}
          >
            Close history
          </span>
        </div>

        <div>
          {closeEvents.map((event, i) => {
            const position = [...closedPositions, ...partialPositions].find(p => p.id === event.position_id)
            const isWin = event.realized_pnl > 0
            const expanded = expandedEvent === event.id

            return (
              <div
                key={event.id}
                style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}
              >
                <button
                  onClick={() => setExpandedEvent(expanded ? null : event.id)}
                  className="w-full flex items-center gap-4 px-4 py-3 transition-all hover:opacity-90 text-left"
                >
                  <div style={{ color: 'var(--text3)' }}>
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-bold text-sm" style={{ color: 'var(--text)' }}>
                        {position?.ticker ?? '—'}
                      </span>
                      {position?.position_type === 'option' && position?.option_type && (
                        <span
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                          style={{
                            background: position.option_type === 'call' ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)',
                            color: position.option_type === 'call' ? '#34d399' : '#f87171',
                          }}
                        >
                          {position.option_type.toUpperCase()} ${position.strike}
                        </span>
                      )}
                      <span
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                        style={{
                          background: 'rgba(255,255,255,0.05)',
                          color: 'var(--text3)',
                        }}
                      >
                        {event.close_type === 'full' ? 'Full' : 'Partial'}
                      </span>
                      <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                        {reasonLabel(event.closed_reason)}
                      </span>
                    </div>
                    <div className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--text3)' }}>
                      {event.quantity_closed} @ ${event.exit_price.toFixed(2)} · {formatDate(event.closed_at)}
                    </div>
                  </div>

                  <div className="text-right">
                    <div
                      className="text-sm font-mono font-bold tabular-nums"
                      style={{ color: isWin ? '#34d399' : event.realized_pnl < 0 ? '#f87171' : 'var(--text2)' }}
                    >
                      {fmtSigned(event.realized_pnl)}
                    </div>
                    {event.realized_pnl_pct !== null && (
                      <div
                        className="text-[10px] font-mono"
                        style={{ color: isWin ? '#34d399' : event.realized_pnl < 0 ? '#f87171' : 'var(--text3)' }}
                      >
                        {fmtPct(event.realized_pnl_pct)}
                      </div>
                    )}
                  </div>

                  {isWin ? (
                    <TrendingUp size={14} style={{ color: '#34d399' }} />
                  ) : event.realized_pnl < 0 ? (
                    <TrendingDown size={14} style={{ color: '#f87171' }} />
                  ) : null}
                </button>

                {/* Expanded — postmortem */}
                {expanded && (
                  <div
                    className="px-4 pb-4 space-y-3"
                    style={{ background: 'var(--surface2)' }}
                  >
                    {event.postmortem && (
                      <div
                        className="rounded-lg p-3 mt-3"
                        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
                      >
                        <div className="flex items-center gap-2 mb-2">
                          <span
                            className="text-[10px] font-mono uppercase tracking-wider"
                            style={{ color: 'var(--text3)' }}
                          >
                            AI Postmortem
                          </span>
                          {event.postmortem.grade && (
                            <span
                              className="text-xs font-mono font-bold px-2 py-0.5 rounded-full"
                              style={{
                                background: gradeColor(event.postmortem.grade) + '20',
                                color: gradeColor(event.postmortem.grade),
                                border: `1px solid ${gradeColor(event.postmortem.grade)}40`,
                              }}
                            >
                              {event.postmortem.grade}
                            </span>
                          )}
                        </div>

                        {event.postmortem.what_worked && (
                          <div className="mb-2">
                            <div className="text-[10px] font-mono uppercase tracking-wider mb-0.5" style={{ color: 'var(--text3)' }}>
                              What worked
                            </div>
                            <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>
                              {event.postmortem.what_worked}
                            </p>
                          </div>
                        )}

                        {event.postmortem.what_missed && (
                          <div className="mb-2">
                            <div className="text-[10px] font-mono uppercase tracking-wider mb-0.5" style={{ color: 'var(--text3)' }}>
                              What missed
                            </div>
                            <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>
                              {event.postmortem.what_missed}
                            </p>
                          </div>
                        )}

                        {event.postmortem.key_lesson && (
                          <div className="mb-2">
                            <div className="text-[10px] font-mono uppercase tracking-wider mb-0.5" style={{ color: 'var(--text3)' }}>
                              Key lesson
                            </div>
                            <p className="text-xs leading-relaxed font-medium" style={{ color: 'var(--text)' }}>
                              {event.postmortem.key_lesson}
                            </p>
                          </div>
                        )}

                        {event.postmortem.next_time && (
                          <div>
                            <div className="text-[10px] font-mono uppercase tracking-wider mb-0.5" style={{ color: 'var(--text3)' }}>
                              Next time
                            </div>
                            <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>
                              {event.postmortem.next_time}
                            </p>
                          </div>
                        )}
                      </div>
                    )}

                    {event.notes && (
                      <div className="text-xs italic" style={{ color: 'var(--text2)' }}>
                        Notes: {event.notes}
                      </div>
                    )}

                    {!event.postmortem && (
                      <div
                        className="text-xs italic mt-3"
                        style={{ color: 'var(--text3)' }}
                      >
                        No postmortem generated for this close.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
