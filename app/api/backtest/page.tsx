// ═════════════════════════════════════════════════════════════
// /backtest — Public dashboard showing Wali-OS verdict track record
//
// This is a MARKETING + CREDIBILITY page. Anyone can view it (including
// anonymous users). Shows aggregate performance across all users' verdicts.
//
// If authenticated, adds a "Your Personal Stats" toggle at the top.
// ═════════════════════════════════════════════════════════════

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

export default function BacktestPage() {
  const [scope, setScope] = useState<'public' | 'user'>('public')
  const [horizon, setHorizon] = useState<'1w' | '1m'>('1w')
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
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <Link href="/" className="text-blue-400 hover:text-blue-300 text-sm">← Back</Link>
          <h1 className="text-3xl font-bold mt-2">Wali-OS Verdict Track Record</h1>
          <p className="text-gray-400 mt-2">
            Transparent backtest of every non-neutral AI council verdict. Updated daily.
          </p>
        </div>

        {/* Scope + filter controls */}
        <div className="flex flex-wrap gap-3 mb-6 text-sm">
          <div className="flex bg-gray-900 rounded overflow-hidden">
            <button
              onClick={() => setScope('public')}
              className={`px-4 py-2 ${scope === 'public' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              All Users
            </button>
            <button
              onClick={() => setScope('user')}
              className={`px-4 py-2 ${scope === 'user' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              My Verdicts
            </button>
          </div>

          <div className="flex bg-gray-900 rounded overflow-hidden">
            <button
              onClick={() => setHorizon('1w')}
              className={`px-4 py-2 ${horizon === '1w' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              1 Week
            </button>
            <button
              onClick={() => setHorizon('1m')}
              className={`px-4 py-2 ${horizon === '1m' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              1 Month
            </button>
          </div>

          <select
            value={personaFilter}
            onChange={(e) => setPersonaFilter(e.target.value)}
            className="bg-gray-900 border border-gray-800 rounded px-3 py-2"
          >
            <option value="all">All personas</option>
            <option value="balanced">Balanced</option>
            <option value="technical">Technical</option>
            <option value="fundamental">Fundamental</option>
          </select>

          <select
            value={timeframeFilter}
            onChange={(e) => setTimeframeFilter(e.target.value)}
            className="bg-gray-900 border border-gray-800 rounded px-3 py-2"
          >
            <option value="all">All timeframes</option>
            <option value="1D">1 Day</option>
            <option value="1W">1 Week</option>
            <option value="1M">1 Month</option>
            <option value="3M">3 Month</option>
          </select>
        </div>

        {loading && <div className="text-gray-400 py-8 text-center">Loading stats...</div>}
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
              <div className="bg-gray-900 border border-gray-800 rounded p-6">
                <div className="text-gray-400 text-sm mb-1">Total Verdicts</div>
                <div className="text-3xl font-bold">{data.totalVerdicts.toLocaleString()}</div>
                <div className="text-xs text-gray-500 mt-1">non-neutral calls tracked</div>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded p-6">
                <div className="text-gray-400 text-sm mb-1">Hit Rate ({horizon})</div>
                <div className="text-3xl font-bold text-green-400">
                  {pct(data.overall.hitRate.hitRate)}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {data.overall.hitRate.wins}W / {data.overall.hitRate.losses}L / {data.overall.hitRate.expired} expired
                </div>
                <div className="text-xs text-gray-600 mt-1">target hit vs stop hit</div>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded p-6">
                <div className="text-gray-400 text-sm mb-1">Direction Accuracy ({horizon})</div>
                <div className="text-3xl font-bold text-blue-400">
                  {pct(data.overall.direction.accuracy)}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {data.overall.direction.correct} correct / {data.overall.direction.incorrect} incorrect
                </div>
                <div className="text-xs text-gray-600 mt-1">price moved in right direction</div>
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
            <div className="bg-gray-900 border border-gray-800 rounded overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-800">
                <h2 className="font-semibold">Recent Verdicts</h2>
                <div className="text-xs text-gray-500 mt-1">Last 100 verdicts (newest first)</div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-950/50 text-gray-400 text-xs">
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
                  <tbody className="divide-y divide-gray-800">
                    {data.recent.map((v, i) => {
                      const strict = formatOutcome(v.outcome_strict)
                      const direction = formatOutcome(v.outcome_directional)
                      return (
                        <tr key={i} className="hover:bg-gray-950/50">
                          <td className="px-3 py-2 text-gray-400">{v.verdict_date}</td>
                          <td className="px-3 py-2 font-mono font-semibold">{v.ticker}</td>
                          <td className={`px-3 py-2 font-semibold ${v.signal === 'BULLISH' ? 'text-green-400' : 'text-red-400'}`}>
                            {v.signal}
                          </td>
                          <td className="px-3 py-2 text-right">{v.confidence ?? '—'}%</td>
                          <td className="px-3 py-2 text-gray-400 capitalize">{v.persona ?? '—'}</td>
                          <td className="px-3 py-2 text-gray-400">{v.timeframe ?? '—'}</td>
                          <td className="px-3 py-2 text-right font-mono">{v.entry_price ? '$' + v.entry_price.toFixed(2) : '—'}</td>
                          <td className="px-3 py-2 text-right font-mono">{v.outcome_price ? '$' + v.outcome_price.toFixed(2) : '—'}</td>
                          <td className={`px-3 py-2 ${strict.color}`}>{strict.label}</td>
                          <td className={`px-3 py-2 ${direction.color}`}>{direction.label}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {data.recent.length === 0 && (
                <div className="p-8 text-center text-gray-500">
                  No verdicts yet — run some analyses to populate the track record.
                </div>
              )}
            </div>

            <div className="mt-6 text-xs text-gray-500 text-center">
              Stats generated at {new Date(data.generatedAt).toLocaleString()}. 
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
    <div className="bg-gray-900 border border-gray-800 rounded">
      <div className="px-4 py-3 border-b border-gray-800">
        <h3 className="font-semibold">{title}</h3>
      </div>
      <table className="w-full text-sm">
        <thead className="text-gray-400 text-xs">
          <tr>
            <th className="px-3 py-2 text-left">Group</th>
            <th className="px-3 py-2 text-right">Sample</th>
            <th className="px-3 py-2 text-right">Hit Rate</th>
            <th className="px-3 py-2 text-right">Direction</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="px-3 py-2 capitalize">{r.label}</td>
              <td className="px-3 py-2 text-right text-gray-400">{r.sampleSize}</td>
              <td className="px-3 py-2 text-right">
                {r.decidedSize > 0 ? (
                  <span className={r.hitRate >= 0.5 ? 'text-green-400' : 'text-red-400'}>
                    {pct(r.hitRate)} <span className="text-xs text-gray-500">({r.decidedSize})</span>
                  </span>
                ) : <span className="text-gray-600">—</span>}
              </td>
              <td className="px-3 py-2 text-right">
                {r.directionSize > 0 ? (
                  <span className={r.direction >= 0.5 ? 'text-blue-400' : 'text-gray-400'}>
                    {pct(r.direction)} <span className="text-xs text-gray-500">({r.directionSize})</span>
                  </span>
                ) : <span className="text-gray-600">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
