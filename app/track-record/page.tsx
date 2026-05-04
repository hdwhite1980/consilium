// ════════════════════════════════════════════════════════════════
// app/track-record/page.tsx
//
// Server component shell for the public track record page.
//
// Reads the wali_track_record_unlocked cookie:
//   - present  -> renders <BacktestDashboard /> (full interactive client island)
//   - missing  -> renders preview tiles + 3 most recent verdicts + <TrackRecordGate />
//
// The cookie is set server-side by /api/subscribe (httpOnly), so the gate
// is genuinely server-enforced. A curl without the cookie cannot pull the
// full dashboard HTML — it gets the preview shell only.
// ════════════════════════════════════════════════════════════════

import { cookies } from 'next/headers'
import Link from 'next/link'
import { createClient } from '@/app/lib/auth/server'
import BacktestDashboard from '@/app/components/BacktestDashboard'
import TrackRecordGate from '@/app/components/TrackRecordGate'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UNLOCK_COOKIE_NAME = 'wali_track_record_unlocked'

interface PreviewVerdict {
  ticker: string
  signal: string
  confidence: number | null
  verdict_date: string
  entry_price: number | null
  outcome_strict: string
  outcome_price: number | null
}

interface PreviewStats {
  totalVerdicts: number
  hitRatePct: string | null
  directionPct: string | null
  recent: PreviewVerdict[]
}

async function fetchPreviewStats(): Promise<PreviewStats | null> {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://wali-os.com'
  try {
    const res = await fetch(`${base}/api/backtest/stats?scope=public&horizon=1w`, {
      cache: 'no-store',
      headers: { 'x-internal': '1' },
    })
    if (!res.ok) return null
    const json = await res.json()
    if (!json || json.ok !== true) return null

    const hitRate = json.overall?.hitRate?.hitRate
    const direction = json.overall?.direction?.accuracy

    const recent: PreviewVerdict[] = Array.isArray(json.recent)
      ? json.recent.slice(0, 3).map((r: PreviewVerdict) => ({
          ticker: String(r.ticker ?? ''),
          signal: String(r.signal ?? ''),
          confidence: typeof r.confidence === 'number' ? r.confidence : null,
          verdict_date: String(r.verdict_date ?? ''),
          entry_price: typeof r.entry_price === 'number' ? r.entry_price : null,
          outcome_strict: String(r.outcome_strict ?? 'pending'),
          outcome_price: typeof r.outcome_price === 'number' ? r.outcome_price : null,
        }))
      : []

    return {
      totalVerdicts: typeof json.totalVerdicts === 'number' ? json.totalVerdicts : 0,
      hitRatePct: typeof hitRate === 'number' ? (hitRate * 100).toFixed(1) + '%' : null,
      directionPct: typeof direction === 'number' ? (direction * 100).toFixed(1) + '%' : null,
      recent,
    }
  } catch (e) {
    console.error('[track-record] preview fetch failed:', (e as Error).message)
    return null
  }
}

export default async function TrackRecordPage() {
  const cookieStore = await cookies()
  const unlocked = cookieStore.get(UNLOCK_COOKIE_NAME)?.value === '1'

  // Logged-in users bypass the gate entirely — we already have their email
  // from signup, so the lead-capture form is pointless. Wrap in try/catch
  // because auth failures shouldn't break the page; worst case we fall
  // through to the cookie-only check below.
  let isAuthenticated = false
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    isAuthenticated = !!user
  } catch {
    isAuthenticated = false
  }

  if (unlocked || isAuthenticated) {
    return <BacktestDashboard />
  }

  const stats = await fetchPreviewStats()

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

        {/* Headline tiles (preview) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="t-card rounded p-6">
            <div className="t-text2 text-sm mb-1">Total Verdicts</div>
            <div className="text-3xl font-bold t-text">
              {stats?.totalVerdicts.toLocaleString() ?? '\u2014'}
            </div>
            <div className="text-xs t-text3 mt-1">non-neutral calls tracked</div>
          </div>
          <div className="t-card rounded p-6">
            <div className="t-text2 text-sm mb-1">Hit Rate (1w)</div>
            <div className="text-3xl font-bold text-green-400">
              {stats?.hitRatePct ?? '\u2014'}
            </div>
            <div className="text-xs t-text3 mt-1">target hit vs stop hit</div>
          </div>
          <div className="t-card rounded p-6">
            <div className="t-text2 text-sm mb-1">Direction Accuracy (1w)</div>
            <div className="text-3xl font-bold text-blue-400">
              {stats?.directionPct ?? '\u2014'}
            </div>
            <div className="text-xs t-text3 mt-1">price moved in right direction</div>
          </div>
        </div>

        {/* Methodology callout */}
        <div className="bg-blue-950/30 border border-blue-900/50 rounded p-5 mb-8">
          <h2 className="font-semibold text-blue-300 mb-2">How we measure the track record</h2>
          <p className="text-sm t-text2 leading-relaxed">
            Every non-neutral AI council verdict is logged with its entry price, stop, and target.
            Outcomes are resolved against real market data: a verdict is a <span className="text-green-400">win</span> if
            price hits the target, a <span className="text-red-400">loss</span> if it hits the stop,
            and <span className="t-text3">expired</span> otherwise. Hit rate excludes expired
            verdicts. Direction accuracy measures whether price moved the predicted direction
            regardless of stop/target. Updated daily at 4am ET. NEUTRAL verdicts are excluded.
          </p>
        </div>

        {/* Filter row (visible but disabled) */}
        <div className="flex flex-wrap gap-3 mb-6 text-sm opacity-50 pointer-events-none select-none">
          <div className="flex t-surface rounded overflow-hidden">
            <button disabled className="px-4 py-2 bg-blue-600 text-white">All Users</button>
            <button disabled className="px-4 py-2 t-text2">My Verdicts</button>
          </div>
          <div className="flex t-surface rounded overflow-hidden">
            <button disabled className="px-4 py-2 t-text2">1 Day</button>
            <button disabled className="px-4 py-2 bg-blue-600 text-white">1 Week</button>
            <button disabled className="px-4 py-2 t-text2">1 Month</button>
          </div>
          <select disabled className="t-surface t-border t-text border rounded px-3 py-2">
            <option>All personas</option>
          </select>
          <select disabled className="t-surface t-border t-text border rounded px-3 py-2">
            <option>All timeframes</option>
          </select>
        </div>

        {/* 3 most recent verdicts */}
        <div className="t-card rounded overflow-hidden mb-8">
          <div className="px-4 py-3 border-b t-border">
            <h2 className="font-semibold t-text">Most Recent Verdicts</h2>
            <div className="text-xs t-text3 mt-1">Showing 3 of {stats?.totalVerdicts ?? 0} {'\u2014'} unlock to see all</div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="t-surface3 t-text2 text-xs">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Ticker</th>
                  <th className="px-3 py-2 text-left">Signal</th>
                  <th className="px-3 py-2 text-right">Confidence</th>
                  <th className="px-3 py-2 text-right">Entry</th>
                  <th className="px-3 py-2 text-right">Close@1w</th>
                  <th className="px-3 py-2 text-left">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {(stats?.recent ?? []).map((v, i) => {
                  const outcomeColor =
                    v.outcome_strict === 'win' ? 'text-green-400' :
                    v.outcome_strict === 'loss' ? 'text-red-400' :
                    v.outcome_strict === 'expired' ? 't-text3' :
                    'text-yellow-400'
                  const outcomeLabel =
                    v.outcome_strict === 'win' ? 'Win' :
                    v.outcome_strict === 'loss' ? 'Loss' :
                    v.outcome_strict === 'expired' ? 'Expired' :
                    'Pending'
                  return (
                    <tr key={i} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                      <td className="px-3 py-2 t-text2">{v.verdict_date}</td>
                      <td className="px-3 py-2 font-mono font-semibold t-text">{v.ticker}</td>
                      <td className={`px-3 py-2 font-semibold ${v.signal === 'BULLISH' ? 'text-green-400' : 'text-red-400'}`}>
                        {v.signal}
                      </td>
                      <td className="px-3 py-2 text-right t-text">{v.confidence ?? '\u2014'}%</td>
                      <td className="px-3 py-2 text-right font-mono t-text">{v.entry_price ? '$' + v.entry_price.toFixed(2) : '\u2014'}</td>
                      <td className="px-3 py-2 text-right font-mono t-text">{v.outcome_price ? '$' + v.outcome_price.toFixed(2) : '\u2014'}</td>
                      <td className={`px-3 py-2 ${outcomeColor}`}>{outcomeLabel}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {(!stats || stats.recent.length === 0) && (
            <div className="p-8 text-center t-text3">
              No verdicts to display yet.
            </div>
          )}
        </div>

        {/* Email gate */}
        <TrackRecordGate />

        <div className="mt-8 text-xs t-text3 text-center">
          Outcomes updated daily at 4am ET. NEUTRAL verdicts excluded from all stats.
        </div>
      </div>
    </div>
  )
}
