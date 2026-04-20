'use client'

// ═════════════════════════════════════════════════════════════
// app/components/MoversHitRateWidget.tsx
//
// Small collapsible widget showing actual hit rate of the movers system.
// Meant for the /today page header so users can see real performance
// data rather than just promises of accuracy.
//
// Shows:
//   - Total calls made in the last N days
//   - Overall 1-day and 3-day hit rates
//   - Breakdown by confidence bucket (proves higher confidence = better)
//   - Breakdown by regime (shows which regime we're accurate in)
//
// Empty state for first 7 days when no data has accumulated yet.
// ═════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react'
import { TrendingUp, ChevronDown, ChevronUp, Target } from 'lucide-react'

interface StatsBucket {
  total: number
  resolved1d: number
  correct1d: number
  hitRate1dPct: number | null
  resolved3d: number
  correct3d: number
  hitRate3dPct: number | null
}

interface StatsResponse {
  days: number
  source: string
  totalCalls: number
  resolvedCalls1d: number
  resolvedCalls3d: number
  overallHitRate1d: number | null
  overallHitRate3d: number | null
  bySignal: Record<string, StatsBucket>
  byConfidenceBucket: Record<string, StatsBucket>
  byRegime: Record<string, StatsBucket>
  message?: string
}

export function MoversHitRateWidget({ source }: { source?: 'today' | 'tomorrow' }) {
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [days, setDays] = useState(30)

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams()
    if (source) params.set('source', source)
    params.set('days', String(days))

    fetch(`/api/movers/stats?${params}`)
      .then(r => r.json())
      .then((d: StatsResponse) => setStats(d))
      .catch(() => setStats(null))
      .finally(() => setLoading(false))
  }, [source, days])

  if (loading) {
    return (
      <div className="rounded-lg border p-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="text-xs font-mono opacity-60">Loading accuracy stats…</div>
      </div>
    )
  }

  if (!stats || stats.totalCalls === 0) {
    return (
      <div className="rounded-lg border p-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2 text-xs">
          <Target size={12} style={{ color: '#60a5fa' }} />
          <span className="font-mono opacity-80">Accuracy tracking active</span>
          <span className="opacity-50">— data arrives after 2-3 days of usage</span>
        </div>
      </div>
    )
  }

  const rate1d = stats.overallHitRate1d
  const rate3d = stats.overallHitRate3d

  // Color-code the hit rate: green >= 55%, amber 45-55%, red < 45%
  const rateColor = (r: number | null): string => {
    if (r === null) return '#94a3b8'
    if (r >= 55) return '#10b981'
    if (r >= 45) return '#fbbf24'
    return '#dc2626'
  }

  return (
    <div className="rounded-lg border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      {/* Header — always visible */}
      <button
        className="w-full flex items-center justify-between gap-2 p-3 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <Target size={13} style={{ color: '#60a5fa' }} />
          <span className="text-sm font-bold">Accuracy (last {days}d)</span>
          <span className="text-xs opacity-70 font-mono">
            {stats.totalCalls} calls, {stats.resolvedCalls1d} resolved
          </span>
          <span className="ml-2 flex items-center gap-1.5 text-xs font-mono">
            <span className="opacity-60">1-day:</span>
            <span style={{ color: rateColor(rate1d), fontWeight: 600 }}>
              {rate1d !== null ? `${rate1d}%` : '—'}
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-xs font-mono">
            <span className="opacity-60">3-day:</span>
            <span style={{ color: rateColor(rate3d), fontWeight: 600 }}>
              {rate3d !== null ? `${rate3d}%` : '—'}
            </span>
          </span>
        </div>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
          {/* Time range selector */}
          <div className="flex gap-1 text-xs">
            {[7, 14, 30, 90].map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className="px-2 py-1 rounded font-mono"
                style={{
                  background: days === d ? 'rgba(96, 165, 250, 0.15)' : 'transparent',
                  color: days === d ? '#60a5fa' : 'var(--text3)',
                  border: `1px solid ${days === d ? 'rgba(96, 165, 250, 0.3)' : 'transparent'}`,
                }}
              >
                {d}d
              </button>
            ))}
          </div>

          {/* By confidence bucket — the most important view */}
          {Object.keys(stats.byConfidenceBucket).length > 0 && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest opacity-60 mb-1.5">
                By confidence bucket
              </div>
              <div className="space-y-1">
                {Object.entries(stats.byConfidenceBucket)
                  .sort(([a], [b]) => b.localeCompare(a))
                  .map(([bucket, s]) => (
                    <div key={bucket} className="flex items-center gap-2 text-xs">
                      <span className="font-mono flex-1 truncate">{bucket}</span>
                      <span className="opacity-60 font-mono">{s.total} calls</span>
                      <span
                        className="font-mono w-14 text-right"
                        style={{ color: rateColor(s.hitRate1dPct), fontWeight: 600 }}
                      >
                        {s.hitRate1dPct !== null ? `${s.hitRate1dPct}%` : '—'}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* By signal direction */}
          {Object.keys(stats.bySignal).length > 0 && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest opacity-60 mb-1.5">
                By signal
              </div>
              <div className="space-y-1">
                {Object.entries(stats.bySignal).map(([signal, s]) => (
                  <div key={signal} className="flex items-center gap-2 text-xs">
                    <span
                      className="font-mono flex-1"
                      style={{
                        color: signal === 'BULLISH' ? '#10b981' : signal === 'BEARISH' ? '#dc2626' : '#94a3b8',
                      }}
                    >
                      {signal}
                    </span>
                    <span className="opacity-60 font-mono">{s.total}</span>
                    <span
                      className="font-mono w-14 text-right"
                      style={{ color: rateColor(s.hitRate1dPct), fontWeight: 600 }}
                    >
                      {s.hitRate1dPct !== null ? `${s.hitRate1dPct}%` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* By regime — does the system work better in some markets? */}
          {Object.keys(stats.byRegime).length > 1 && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest opacity-60 mb-1.5">
                By market regime
              </div>
              <div className="space-y-1">
                {Object.entries(stats.byRegime).map(([regime, s]) => (
                  <div key={regime} className="flex items-center gap-2 text-xs">
                    <span className="font-mono flex-1">{regime}</span>
                    <span className="opacity-60 font-mono">{s.total}</span>
                    <span
                      className="font-mono w-14 text-right"
                      style={{ color: rateColor(s.hitRate1dPct), fontWeight: 600 }}
                    >
                      {s.hitRate1dPct !== null ? `${s.hitRate1dPct}%` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Honest disclaimer */}
          <div className="text-[10px] opacity-60 italic leading-relaxed pt-1">
            Hit rates reflect the actual outcome vs our call direction. Short-term
            stock prediction ceiling is ~55-60% even for professionals.
            Always verify before trading real money.
          </div>
        </div>
      )}
    </div>
  )
}
