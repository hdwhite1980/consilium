// ════════════════════════════════════════════════════════════════
// app/components/BacktestDashboard.tsx
//
// Full interactive dashboard for the Wali-OS verdict track record.
// Rendered by app/track-record/page.tsx ONLY when the email gate
// cookie is set. Anonymous visitors see the gated preview instead.
//
// This is a client component — owns its own filter state and fetches
// /api/backtest/stats whenever those filters change.
// ════════════════════════════════════════════════════════════════

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

type HitRate = { wins: number; losses: number; expired: number; total: number; hitRate: number }
type Direction = { correct: number; incorrect: number; pending: number; total: number; accuracy: number }

interface StatsResponse {
  ok: boolean
  scope: string
  horizon: string
  filters: { persona: string; timeframe: string }
  totalVerdicts: number
  overall: { hitRate: HitRate; direction: Direction }
  byPersona: Array<{ persona: string; sampleSize: number; hitRate: HitRate; direction: Direction }>
  byTimeframe: Array<{ timeframe: string; sampleSize: number; hitRate: HitRate; direction: Direction }>
  byConfidence: Array<{ band: string; sampleSize: number; hitRate: HitRate; direction: Direction }>
  bySignal: Array<{ signal: string; sampleSize: number; hitRate: HitRate; direction: Direction }>
  recent: Array<{
    ticker: string; signal: string; confidence: number | null; persona: string | null;
    timeframe: string | null; verdict_date: string; entry_price: number | null;
    outcome_strict: string; outcome_directional: string; outcome_price: number | null;
  }>
  generatedAt: string
}

function pct(n: number): string {
  return (n * 100).toFixed(1) + '%'
}

function formatOutcome(outcome: string): { label: string; color: string } {
  switch (outcome) {
    case 'win':    return { label: 'Win',    color: 'text-green-400' }
    case 'loss':   return { label: 'Loss',   color: 'text-red-400' }
    case 'expired': return { label: 'Expired', color: 'text-gray-400' }
    case 'pending': return { label: 'Pending', color: 'text-yellow-400' }
    default: return { label: outcome, color: 'text-gray-500' }
  }
}

export default function BacktestDashboard() {
  const [scope, setScope] = useState<'public' | 'user'>('public')
  const [horizon, setHorizon] = useState<'1d' | '1w' | '1m'>('1w')
  const [personaFilter, setPersonaFilter] = useState<string>('all')
  const [timeframeFilter, setTimeframeFilter] = useState<string>('all')
  const [data, setData] = useState<StatsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ scope, horizon, persona: personaFilter, timeframe: timeframeFilter })
    fetch(`/api/backtest/stats?${params}`)
      .then(async r => {
        if (!r.ok) throw new Error(await r.text())
        return r.json()
      })
      .then((d: StatsResponse) => setData(d))
      .catch(e => setError(e.message ?? 'Failed to load stats'))
      .finally(() => setLoading(false))
  }, [scope, horizon, personaFilter, timeframeFilter])

  return (
    <div className="min-h-screen t-bg t-text">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <Link href="/" className="text-blue-400 hover:text-blue-300 text-sm">{'\u2190'} Back</Link>
          <h1 className="text-3xl font-bold mt-2 t-text">Wali-OS Verdict Track Record</h1>
          <p className="t-text2 mt-2">
            Transparent backtest of every non-neutral AI council verdict. Updated daily.
          </p>
        </div>

        {/* Scope + filter controls */}
        <div className="flex flex-wrap gap-3 mb-6 text-sm">
          <div className="flex t-surface rounded overflow-hidden">
            <button
              onClick={() => setScope('public')}
              className={`px-4 py-2 ${scope === 'public' ? 'bg-blue-600 text-white' : 't-text2 hover:t-text'}`}
            >
              All Users
            </button>
            <button
              onClick={() => setScope('user')}
              className={`px-4 py-2 ${scope === 'user' ? 'bg-blue-600 text-white' : 't-text2 hover:t-text'}`}
            >
              My Verdicts
            </button>
          </div>

          <div className="flex t-surface rounded overflow-hidden">
            <button
              onClick={() => setHorizon('1d')}
              className={`px-4 py-2 ${horizon === '1d' ? 'bg-blue-600 text-white' : 't-text2 hover:t-text'}`}
            >
              1 Day
            </button>
            <button
              onClick={() => setHorizon('1w')}
              className={`px-4 py-2 ${horizon === '1w' ? 'bg-blue-600 text-white' : 't-text2 hover:t-text'}`}
            >
              1 Week
            </button>
            <button
              onClick={() => setHorizon('1m')}
              className={`px-4 py-2 ${horizon === '1m' ? 'bg-blue-600 text-white' : 't-text2 hover:t-text'}`}
            >
              1 Month
            </button>
          </div>

          <select
            value={personaFilter}
            onChange={(e) => setPersonaFilter(e.target.value)}
            className="t-surface t-border t-text border rounded px-3 py-2"
          >
            <option value="all">All personas</option>
            <option value="balanced">Balanced</option>
            <option value="technical">Technical</option>
            <option value="fundamental">Fundamental</option>
          </select>

          <select
            value={timeframeFilter}
            onChange={(e) => setTimeframeFilter(e.target.value)}
            className="t-surface t-border t-text border rounded px-3 py-2"
          >
            <option value="all">All timeframes</option>
            <option value="1D">1 Day</option>
            <option value="1W">1 Week</option>
            <option value="1M">1 Month</option>
            <option value="3M">3 Month</option>
          </select>
        </div>

        {loading && <div className="t-text2 py-8 text-center">Loading stats...</div>}
        {error && !loading && (
          <div className="bg-red-900/30 border border-red-800 rounded p-4 text-red-300">
            {error.includes('authentication required')
              ? 'Sign in to view your personal stats.'
              : `Error: ${error}`}
          </div>
        )}

        {data && !loading && (
          <>
            {/* Headline stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <div className="t-card rounded p-6">
                <div className="t-text2 text-sm mb-1">Total Verdicts</div>
                <div className="text-3xl font-bold t-text">{data.totalVerdicts.toLocaleString()}</div>
                <div className="text-xs t-text3 mt-1">non-neutral calls tracked</div>
              </div>
              <div className="t-card rounded p-6">
                <div className="t-text2 text-sm mb-1">Hit Rate ({horizon})</div>
                <div className="text-3xl font-bold text-green-400">
                  {pct(data.overall.hitRate.hitRate)}
                </div>
                <div className="text-xs t-text3 mt-1">
                  {data.overall.hitRate.wins}W / {data.overall.hitRate.losses}L / {data.overall.hitRate.expired} expired
                </div>
                <div className="text-xs t-text3 mt-1">target hit vs stop hit</div>
              </div>
              <div className="t-card rounded p-6">
                <div className="t-text2 text-sm mb-1">Direction Accuracy ({horizon})</div>
                <div className="text-3xl font-bold text-blue-400">
                  {pct(data.overall.direction.accuracy)}
                </div>
                <div className="text-xs t-text3 mt-1">
                  {data.overall.direction.correct} correct / {data.overall.direction.incorrect} incorrect
                </div>
                <div className="text-xs t-text3 mt-1">price moved in right direction</div>
              </div>
            </div>

            {/* Breakdowns */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
              <BreakdownTable
                title="By Persona"
                rows={data.byPersona.map(p => ({
                  label: p.persona,
                  sampleSize: p.sampleSize,
                  hitRate: p.hitRate.hitRate,
                  decidedSize: p.hitRate.wins + p.hitRate.losses,
                  direction: p.direction.accuracy,
                  directionSize: p.direction.correct + p.direction.incorrect,
                }))}
              />
              <BreakdownTable
                title="By Timeframe"
                rows={data.byTimeframe.map(t => ({
                  label: t.timeframe,
                  sampleSize: t.sampleSize,
                  hitRate: t.hitRate.hitRate,
                  decidedSize: t.hitRate.wins + t.hitRate.losses,
                  direction: t.direction.accuracy,
                  directionSize: t.direction.correct + t.direction.incorrect,
                }))}
              />
              <BreakdownTable
                title="By Confidence Band"
                rows={data.byConfidence.map(c => ({
                  label: c.band,
                  sampleSize: c.sampleSize,
                  hitRate: c.hitRate.hitRate,
                  decidedSize: c.hitRate.wins + c.hitRate.losses,
                  direction: c.direction.accuracy,
                  directionSize: c.direction.correct + c.direction.incorrect,
                }))}
              />
              <BreakdownTable
                title="Bullish vs Bearish"
                rows={data.bySignal.map(s => ({
                  label: s.signal,
                  sampleSize: s.sampleSize,
                  hitRate: s.hitRate.hitRate,
                  decidedSize: s.hitRate.wins + s.hitRate.losses,
                  direction: s.direction.accuracy,
                  directionSize: s.direction.correct + s.direction.incorrect,
                }))}
              />
            </div>

            {/* Recent verdicts */}
            <div className="t-card rounded overflow-hidden">
              <div className="px-4 py-3 border-b t-border">
                <h2 className="font-semibold t-text">Recent Verdicts</h2>
                <div className="text-xs t-text3 mt-1">Last 100 verdicts (newest first)</div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="t-surface3 t-text2 text-xs">
                    <tr>
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-left">Ticker</th>
                      <th className="px-3 py-2 text-left">Signal</th>
                      <th className="px-3 py-2 text-right">Confidence</th>
                      <th className="px-3 py-2 text-left">Persona</th>
                      <th className="px-3 py-2 text-left">TF</th>
                      <th className="px-3 py-2 text-right">Entry</th>
                      <th className="px-3 py-2 text-right">Close@{horizon}</th>
                      <th className="px-3 py-2 text-left">Strict</th>
                      <th className="px-3 py-2 text-left">Directional</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((v, i) => {
                      const strict = formatOutcome(v.outcome_strict)
                      const direction = formatOutcome(v.outcome_directional)
                      return (
                        <tr key={i} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                          <td className="px-3 py-2 t-text2">{v.verdict_date}</td>
                          <td className="px-3 py-2 font-mono font-semibold t-text">{v.ticker}</td>
                          <td className={`px-3 py-2 font-semibold ${v.signal === 'BULLISH' ? 'text-green-400' : 'text-red-400'}`}>
                            {v.signal}
                          </td>
                          <td className="px-3 py-2 text-right t-text">{v.confidence ?? '\u2014'}%</td>
                          <td className="px-3 py-2 t-text2 capitalize">{v.persona ?? '\u2014'}</td>
                          <td className="px-3 py-2 t-text2">{v.timeframe ?? '\u2014'}</td>
                          <td className="px-3 py-2 text-right font-mono t-text">{v.entry_price ? '$' + v.entry_price.toFixed(2) : '\u2014'}</td>
                          <td className="px-3 py-2 text-right font-mono t-text">{v.outcome_price ? '$' + v.outcome_price.toFixed(2) : '\u2014'}</td>
                          <td className={`px-3 py-2 ${strict.color}`}>{strict.label}</td>
                          <td className={`px-3 py-2 ${direction.color}`}>{direction.label}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {data.recent.length === 0 && (
                <div className="p-8 text-center t-text3">
                  No verdicts yet {'\u2014'} run some analyses to populate the track record.
                </div>
              )}
            </div>

            <div className="mt-6 text-xs t-text3 text-center">
              Stats generated at {new Date(data.generatedAt).toLocaleString()}.{' '}
              Outcomes updated daily at 4am ET. NEUTRAL verdicts excluded from all stats.
            </div>
          </>
        )}
      </div>
    </div>
  )
}

interface BreakdownRow {
  label: string
  sampleSize: number
  hitRate: number
  decidedSize: number
  direction: number
  directionSize: number
}

function BreakdownTable({ title, rows }: { title: string; rows: BreakdownRow[] }) {
  return (
    <div className="t-card rounded">
      <div className="px-4 py-3 border-b t-border">
        <h3 className="font-semibold t-text">{title}</h3>
      </div>
      <table className="w-full text-sm">
        <thead className="t-text2 text-xs">
          <tr>
            <th className="px-3 py-2 text-left">Group</th>
            <th className="px-3 py-2 text-right">Sample</th>
            <th className="px-3 py-2 text-right">Hit Rate</th>
            <th className="px-3 py-2 text-right">Direction</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r.label} style={{ borderTop: idx === 0 ? 'none' : '1px solid var(--border)' }}>
              <td className="px-3 py-2 capitalize t-text">{r.label}</td>
              <td className="px-3 py-2 text-right t-text2">{r.sampleSize}</td>
              <td className="px-3 py-2 text-right">
                {r.decidedSize > 0 ? (
                  <span className={r.hitRate >= 0.5 ? 'text-green-400' : 'text-red-400'}>
                    {pct(r.hitRate)} <span className="text-xs t-text3">({r.decidedSize})</span>
                  </span>
                ) : <span className="t-text3">{'\u2014'}</span>}
              </td>
              <td className="px-3 py-2 text-right">
                {r.directionSize > 0 ? (
                  <span className={r.direction >= 0.5 ? 'text-blue-400' : 't-text2'}>
                    {pct(r.direction)} <span className="text-xs t-text3">({r.directionSize})</span>
                  </span>
                ) : <span className="t-text3">{'\u2014'}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
