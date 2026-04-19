// ═════════════════════════════════════════════════════════════
// BacktestSummaryCard
// Compact "your track record" stats card for embedding on the
// Portfolio page. Shows only the user's own verdicts and links
// to the full /backtest page for the public aggregate view.
// ═════════════════════════════════════════════════════════════

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface CompactStats {
  totalVerdicts: number
  hitRate: number
  hitRateDecidedSize: number
  directionAccuracy: number
  directionDecidedSize: number
}

export default function BacktestSummaryCard() {
  const [stats1w, setStats1w] = useState<CompactStats | null>(null)
  const [stats1m, setStats1m] = useState<CompactStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState(false)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetch('/api/backtest/stats?scope=user&horizon=1w').then(r => r.json()),
      fetch('/api/backtest/stats?scope=user&horizon=1m').then(r => r.json()),
    ])
      .then(([d1w, d1m]) => {
        if (d1w.error || d1m.error) {
          setAuthError(true)
          return
        }
        setStats1w({
          totalVerdicts: d1w.totalVerdicts,
          hitRate: d1w.overall.hitRate.hitRate,
          hitRateDecidedSize: d1w.overall.hitRate.wins + d1w.overall.hitRate.losses,
          directionAccuracy: d1w.overall.direction.accuracy,
          directionDecidedSize: d1w.overall.direction.correct + d1w.overall.direction.incorrect,
        })
        setStats1m({
          totalVerdicts: d1m.totalVerdicts,
          hitRate: d1m.overall.hitRate.hitRate,
          hitRateDecidedSize: d1m.overall.hitRate.wins + d1m.overall.hitRate.losses,
          directionAccuracy: d1m.overall.direction.accuracy,
          directionDecidedSize: d1m.overall.direction.correct + d1m.overall.direction.incorrect,
        })
      })
      .catch(() => setAuthError(true))
      .finally(() => setLoading(false))
  }, [])

  if (authError) return null  // don't show card if not signed in

  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Your Verdict Track Record</h3>
        <Link href="/backtest" className="text-xs text-blue-400 hover:text-blue-300">
          View public stats →
        </Link>
      </div>

      {loading && <div className="text-gray-500 text-sm py-2">Loading...</div>}

      {!loading && stats1w && stats1m && (
        <>
          {stats1w.totalVerdicts === 0 ? (
            <div className="text-sm text-gray-500 py-2">
              No verdicts yet. Run analyses to populate your track record.
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <StatBlock
                label="1-Week Hit Rate"
                value={stats1w.hitRateDecidedSize > 0 ? (stats1w.hitRate * 100).toFixed(0) + '%' : '—'}
                sample={stats1w.hitRateDecidedSize}
                accent={stats1w.hitRate >= 0.5 ? 'green' : 'red'}
              />
              <StatBlock
                label="1-Week Direction"
                value={stats1w.directionDecidedSize > 0 ? (stats1w.directionAccuracy * 100).toFixed(0) + '%' : '—'}
                sample={stats1w.directionDecidedSize}
                accent={stats1w.directionAccuracy >= 0.5 ? 'blue' : 'gray'}
              />
              <StatBlock
                label="1-Month Hit Rate"
                value={stats1m.hitRateDecidedSize > 0 ? (stats1m.hitRate * 100).toFixed(0) + '%' : '—'}
                sample={stats1m.hitRateDecidedSize}
                accent={stats1m.hitRate >= 0.5 ? 'green' : 'red'}
              />
              <StatBlock
                label="1-Month Direction"
                value={stats1m.directionDecidedSize > 0 ? (stats1m.directionAccuracy * 100).toFixed(0) + '%' : '—'}
                sample={stats1m.directionDecidedSize}
                accent={stats1m.directionAccuracy >= 0.5 ? 'blue' : 'gray'}
              />
            </div>
          )}

          <div className="text-xs text-gray-500 mt-3">
            {stats1w.totalVerdicts} total verdict{stats1w.totalVerdicts === 1 ? '' : 's'} tracked
          </div>
        </>
      )}
    </div>
  )
}

function StatBlock({ label, value, sample, accent }: {
  label: string; value: string; sample: number; accent: 'green' | 'red' | 'blue' | 'gray';
}) {
  const colors: Record<string, string> = {
    green: 'text-green-400',
    red: 'text-red-400',
    blue: 'text-blue-400',
    gray: 'text-gray-400',
  }
  return (
    <div className="bg-gray-950/50 rounded p-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`font-semibold text-lg ${colors[accent]}`}>{value}</div>
      <div className="text-xs text-gray-600">{sample} resolved</div>
    </div>
  )
}
