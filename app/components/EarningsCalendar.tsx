// ═════════════════════════════════════════════════════════════
// EarningsCalendar component
// Displays market-wide earnings calendar grouped by date.
// - User's portfolio holdings pinned to top of each day, starred + "YOURS" badge
// - Each row has a bell toggle to subscribe for day-of email notifications
// - Master toggle at top: "Auto-notify for all my holdings"
// - Pagination for long ranges
// ═════════════════════════════════════════════════════════════

'use client'

import { useEffect, useState, useCallback } from 'react'

interface EarningsRow {
  ticker: string
  date: string
  hour: string              // 'bmo' | 'amc' | 'dmh'
  epsEstimate: number | null
  revenueEstimate: number | null
  year: number
  quarter: number
  isYours: boolean
  isSubscribed: boolean
}

interface CalendarResponse {
  ok: boolean
  range: string
  page: number
  pageSize: number
  totalCount: number
  totalPages: number
  earnings: EarningsRow[]
  userContext: {
    authenticated: boolean
    holdingsCount?: number
    autoPortfolioEnabled?: boolean
    manualSubscriptions?: string[]
  }
}

function hourLabel(hour: string): string {
  if (hour === 'bmo') return 'Before Open'
  if (hour === 'amc') return 'After Close'
  if (hour === 'dmh') return 'During Market'
  return hour || '—'
}

function hourColor(hour: string): string {
  if (hour === 'bmo') return 'text-blue-400'
  if (hour === 'amc') return 'text-purple-400'
  return 'text-gray-400'
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatRevenue(rev: number | null): string {
  if (rev === null || rev === undefined) return '—'
  if (rev >= 1e9) return '$' + (rev / 1e9).toFixed(2) + 'B'
  if (rev >= 1e6) return '$' + (rev / 1e6).toFixed(0) + 'M'
  return '$' + rev.toLocaleString()
}

export default function EarningsCalendar() {
  const [range, setRange] = useState<'week' | 'month'>('week')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<CalendarResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [togglingTicker, setTogglingTicker] = useState<string | null>(null)

  const loadCalendar = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/earnings/calendar?range=${range}&page=${page}`)
      if (!res.ok) throw new Error(await res.text())
      const d: CalendarResponse = await res.json()
      setData(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load calendar')
    } finally {
      setLoading(false)
    }
  }, [range, page])

  useEffect(() => {
    loadCalendar()
  }, [loadCalendar])

  // Reset to page 1 when range changes
  useEffect(() => { setPage(1) }, [range])

  async function toggleSubscription(ticker: string, currentlySubscribed: boolean) {
    setTogglingTicker(ticker)
    try {
      const method = currentlySubscribed ? 'DELETE' : 'POST'
      const res = await fetch('/api/earnings/subscribe', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker }),
      })
      if (!res.ok) throw new Error(await res.text())
      // Refresh calendar to reflect new subscription state
      await loadCalendar()
    } catch (e) {
      console.error('[earnings-calendar] toggle failed', e)
      alert('Could not update subscription — please try again')
    } finally {
      setTogglingTicker(null)
    }
  }

  async function toggleAutoPortfolio(enabled: boolean) {
    try {
      const res = await fetch('/api/earnings/subscribe', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoPortfolio: enabled }),
      })
      if (!res.ok) throw new Error(await res.text())
      await loadCalendar()
    } catch (e) {
      console.error('[earnings-calendar] auto-portfolio toggle failed', e)
      alert('Could not update setting — please try again')
    }
  }

  // Group earnings by date
  const grouped: Map<string, EarningsRow[]> = new Map()
  for (const e of data?.earnings ?? []) {
    if (!grouped.has(e.date)) grouped.set(e.date, [])
    grouped.get(e.date)!.push(e)
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded">
      <div className="px-4 py-3 border-b border-gray-800 flex flex-wrap gap-3 items-center justify-between">
        <div>
          <h2 className="font-semibold">Upcoming Earnings Calendar</h2>
          <div className="text-xs text-gray-500 mt-0.5">
            Market-wide earnings releases with EPS and revenue estimates
          </div>
        </div>
        <div className="flex gap-2">
          <div className="flex bg-gray-950 rounded overflow-hidden text-sm">
            <button
              onClick={() => setRange('week')}
              className={`px-3 py-1 ${range === 'week' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              1 Week
            </button>
            <button
              onClick={() => setRange('month')}
              className={`px-3 py-1 ${range === 'month' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              1 Month
            </button>
          </div>
        </div>
      </div>

      {/* Master auto-portfolio toggle */}
      {data?.userContext.authenticated && (
        <div className="px-4 py-3 border-b border-gray-800 bg-gray-950/30 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Auto-notify for my portfolio holdings</div>
            <div className="text-xs text-gray-500">
              Sends one email at 6am ET each day there&apos;s earnings for a ticker you hold
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={data.userContext.autoPortfolioEnabled ?? false}
              onChange={(e) => toggleAutoPortfolio(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-checked:bg-blue-600 peer-checked:after:translate-x-full after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
          </label>
        </div>
      )}

      {loading && <div className="px-4 py-8 text-center text-gray-400">Loading calendar...</div>}

      {error && (
        <div className="px-4 py-4 bg-red-900/30 border-t border-red-800 text-red-300 text-sm">
          {error}
        </div>
      )}

      {!loading && data && data.earnings.length === 0 && (
        <div className="px-4 py-8 text-center text-gray-500">
          No earnings scheduled in this range.
        </div>
      )}

      {!loading && data && data.earnings.length > 0 && (
        <>
          <div className="divide-y divide-gray-800">
            {Array.from(grouped.entries()).map(([date, rows]) => (
              <div key={date}>
                <div className="px-4 py-2 bg-gray-950/50 text-xs text-gray-400 font-medium">
                  {formatDate(date)}
                </div>
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-800/50">
                    {rows.map((r) => (
                      <tr key={`${r.date}-${r.ticker}`} className={r.isYours ? 'bg-blue-950/20 hover:bg-blue-950/40' : 'hover:bg-gray-950/50'}>
                        <td className="px-4 py-2 w-8">
                          {r.isYours && <span className="text-yellow-400" title="You hold this">★</span>}
                        </td>
                        <td className="px-2 py-2 font-mono font-semibold">
                          {r.ticker}
                          {r.isYours && (
                            <span className="ml-2 text-[10px] bg-blue-600 text-white rounded px-1.5 py-0.5 font-sans font-normal">
                              YOURS
                            </span>
                          )}
                        </td>
                        <td className={`px-2 py-2 text-xs ${hourColor(r.hour)}`}>{hourLabel(r.hour)}</td>
                        <td className="px-2 py-2 text-right text-xs">
                          <span className="text-gray-500">EPS:</span>{' '}
                          {r.epsEstimate !== null ? '$' + r.epsEstimate.toFixed(2) : '—'}
                        </td>
                        <td className="px-2 py-2 text-right text-xs">
                          <span className="text-gray-500">Rev:</span>{' '}
                          {formatRevenue(r.revenueEstimate)}
                        </td>
                        <td className="px-2 py-2 text-right w-10">
                          {data.userContext.authenticated && (
                            <button
                              onClick={() => toggleSubscription(r.ticker, r.isSubscribed)}
                              disabled={togglingTicker === r.ticker}
                              className="text-lg hover:scale-110 transition-transform disabled:opacity-50"
                              title={r.isSubscribed ? 'Unsubscribe from notifications' : 'Get notified on earnings day'}
                            >
                              {r.isSubscribed ? '🔔' : '🔕'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-between text-sm">
              <div className="text-gray-500">
                Page {data.page} of {data.totalPages} · {data.totalCount} total
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 bg-gray-800 rounded disabled:opacity-50 hover:bg-gray-700"
                >
                  ← Prev
                </button>
                <button
                  onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                  disabled={page === data.totalPages}
                  className="px-3 py-1 bg-gray-800 rounded disabled:opacity-50 hover:bg-gray-700"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {!data?.userContext.authenticated && (
        <div className="px-4 py-3 border-t border-gray-800 bg-gray-950/30 text-xs text-gray-500">
          Sign in to star your portfolio holdings and enable earnings notifications.
        </div>
      )}
    </div>
  )
}
