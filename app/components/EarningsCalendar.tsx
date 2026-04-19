// ═════════════════════════════════════════════════════════════
// EarningsCalendar — market-wide earnings calendar
// Designed to match the Macro page's visual language:
//   - var(--surface), var(--surface2), var(--border), var(--text3)
//   - rounded-2xl containers with subtle borders
//   - Hex accent colors (#34d399, #f87171, #60a5fa, #fbbf24, #a78bfa)
//   - text-[10px] font-mono uppercase tracking-widest for subheaders
//   - Portfolio holdings highlighted with star + "YOURS" badge, pinned to
//     top of each day
// ═════════════════════════════════════════════════════════════

'use client'

import { useEffect, useState, useCallback } from 'react'
import { Calendar, Bell, BellOff, Star, ChevronLeft, ChevronRight } from 'lucide-react'

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
  return '—'
}

function hourColor(hour: string): string {
  if (hour === 'bmo') return '#60a5fa'
  if (hour === 'amc') return '#a78bfa'
  if (hour === 'dmh') return '#fbbf24'
  return 'rgba(255,255,255,0.4)'
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

  // Filter out rows with no useful data (no EPS, no rev, no scheduled time)
  // These are typically tiny ADRs or incomplete Finnhub entries — pure noise.
  // Exception: if it's in the user's "YOURS" set, always keep it visible.
  const usefulEarnings = (data?.earnings ?? []).filter(e => {
    if (e.isYours) return true
    const hasEps = e.epsEstimate !== null && e.epsEstimate !== undefined
    const hasRev = e.revenueEstimate !== null && e.revenueEstimate !== undefined
    const hasTime = e.hour === 'bmo' || e.hour === 'amc' || e.hour === 'dmh'
    return hasEps || hasRev || hasTime
  })

  // Group earnings by date
  const grouped: Map<string, EarningsRow[]> = new Map()
  for (const e of usefulEarnings) {
    if (!grouped.has(e.date)) grouped.set(e.date, [])
    grouped.get(e.date)!.push(e)
  }

  const hiddenCount = (data?.earnings.length ?? 0) - usefulEarnings.length

  return (
    <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2.5">
          <Calendar size={16} style={{ color: '#60a5fa' }} />
          <div>
            <div className="text-sm font-bold text-white">Upcoming Earnings Calendar</div>
            <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text3)' }}>
              Market-wide · EPS + revenue estimates
            </div>
          </div>
        </div>

        <div className="flex gap-1.5 p-1 rounded-lg" style={{ background: 'var(--surface2)' }}>
          {(['week', 'month'] as const).map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className="px-3 py-1 text-[10px] font-mono uppercase tracking-widest rounded-md transition-colors"
              style={{
                background: range === r ? 'rgba(96,165,250,0.15)' : 'transparent',
                color: range === r ? '#60a5fa' : 'var(--text3)',
                border: range === r ? '1px solid rgba(96,165,250,0.3)' : '1px solid transparent',
              }}
            >
              {r === 'week' ? '1 Week' : '1 Month'}
            </button>
          ))}
        </div>
      </div>

      {/* Master auto-portfolio toggle */}
      {data?.userContext.authenticated && (
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border)', background: 'rgba(96,165,250,0.04)' }}>
          <div>
            <div className="text-xs font-medium text-white">Auto-notify for my holdings</div>
            <div className="text-[10px]" style={{ color: 'var(--text3)' }}>
              Email at 6am ET on earnings days for tickers you hold or recently analyzed
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={data.userContext.autoPortfolioEnabled ?? false}
              onChange={(e) => toggleAutoPortfolio(e.target.checked)}
              className="sr-only peer"
            />
            <div
              className="w-10 h-5 rounded-full peer peer-checked:after:translate-x-5 after:absolute after:top-0.5 after:left-0.5 after:rounded-full after:h-4 after:w-4 after:transition-all"
              style={{
                background: data.userContext.autoPortfolioEnabled ? '#60a5fa' : 'var(--surface2)',
              }}
            >
              <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full transition-transform" style={{
                background: 'white',
                transform: data.userContext.autoPortfolioEnabled ? 'translateX(20px)' : 'translateX(0)',
              }} />
            </div>
          </label>
        </div>
      )}

      {loading && (
        <div className="px-5 py-8 text-center" style={{ color: 'var(--text3)' }}>
          <div className="inline-flex items-center gap-1.5">
            {[0, 1, 2].map(i => (
              <span
                key={i}
                className="w-1.5 h-1.5 rounded-full thinking-dot"
                style={{ background: '#60a5fa', animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </div>
          <div className="text-[10px] font-mono uppercase tracking-widest mt-2">Loading calendar</div>
        </div>
      )}

      {error && (
        <div className="px-5 py-4 text-xs" style={{ background: 'rgba(248,113,113,0.08)', color: '#f87171', borderTop: '1px solid rgba(248,113,113,0.2)' }}>
          {error}
        </div>
      )}

      {!loading && data && usefulEarnings.length === 0 && (
        <div className="px-5 py-8 text-center text-xs" style={{ color: 'var(--text3)' }}>
          {data.earnings.length > 0 
            ? `No scheduled earnings with estimates in this range. ${data.earnings.length} low-data entries hidden.`
            : 'No earnings scheduled in this range.'}
        </div>
      )}

      {!loading && data && usefulEarnings.length > 0 && (
        <>
          <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
            {Array.from(grouped.entries()).map(([date, rows]) => {
              // Parse date for a cleaner display with day + date on separate lines
              const d = new Date(date + 'T12:00:00')
              const dayName = d.toLocaleDateString(undefined, { weekday: 'long' })
              const monthDay = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
              const today = new Date()
              today.setHours(0, 0, 0, 0)
              const isToday = d.toDateString() === today.toDateString()
              const tomorrow = new Date(today.getTime() + 86400000)
              const isTomorrow = d.toDateString() === tomorrow.toDateString()
              const relativeLabel = isToday ? 'Today' : isTomorrow ? 'Tomorrow' : ''
              const yoursCount = rows.filter(r => r.isYours).length

              return (
              <div key={date}>
                {/* Date header — prominent, scannable, with calendar icon */}
                <div
                  className="flex items-center gap-3 px-5 py-3 border-b"
                  style={{
                    background: isToday ? 'rgba(96,165,250,0.08)' : 'var(--surface2)',
                    borderColor: isToday ? 'rgba(96,165,250,0.25)' : 'var(--border)',
                  }}
                >
                  <Calendar size={14} style={{ color: isToday ? '#60a5fa' : 'var(--text3)' }} />
                  <div className="flex items-baseline gap-2">
                    <span className="text-base font-bold text-white">{dayName}</span>
                    <span className="text-sm text-white/60">{monthDay}</span>
                    {relativeLabel && (
                      <span
                        className="text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded-full"
                        style={{ background: 'rgba(96,165,250,0.15)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)' }}
                      >
                        {relativeLabel}
                      </span>
                    )}
                  </div>
                  <div className="flex-1" />
                  <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text3)' }}>
                    {rows.length} report{rows.length === 1 ? '' : 's'}
                    {yoursCount > 0 && (
                      <span className="ml-2" style={{ color: '#fbbf24' }}>· {yoursCount} yours</span>
                    )}
                  </span>
                </div>

                {/* Earnings rows for this date */}
                <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
                  {rows.map((r) => (
                    <div
                      key={`${r.date}-${r.ticker}`}
                      className="flex items-center gap-3 px-5 py-2.5 text-sm hover:opacity-80 transition-opacity"
                      style={{
                        background: r.isYours ? 'rgba(251,191,36,0.06)' : 'transparent',
                      }}
                    >
                      {/* Star */}
                      <div className="w-4 flex-shrink-0">
                        {r.isYours && <Star size={12} fill="#fbbf24" style={{ color: '#fbbf24' }} />}
                      </div>

                      {/* Ticker + YOURS badge */}
                      <div className="flex items-center gap-1.5 w-24 flex-shrink-0">
                        <span className="font-mono font-bold text-white">{r.ticker}</span>
                        {r.isYours && (
                          <span
                            className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded"
                            style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}
                          >
                            YOURS
                          </span>
                        )}
                      </div>

                      {/* Time-of-day */}
                      <div
                        className="text-[10px] font-mono uppercase tracking-widest w-28 flex-shrink-0"
                        style={{ color: hourColor(r.hour) }}
                      >
                        {hourLabel(r.hour)}
                      </div>

                      {/* EPS + Rev estimates */}
                      <div className="flex gap-4 flex-1 text-right">
                        <div className="flex-1">
                          <span className="text-[10px] font-mono uppercase tracking-widest mr-1.5" style={{ color: 'var(--text3)' }}>EPS</span>
                          <span className="font-mono text-white/80">
                            {r.epsEstimate !== null ? '$' + r.epsEstimate.toFixed(2) : '—'}
                          </span>
                        </div>
                        <div className="flex-1">
                          <span className="text-[10px] font-mono uppercase tracking-widest mr-1.5" style={{ color: 'var(--text3)' }}>REV</span>
                          <span className="font-mono text-white/80">{formatRevenue(r.revenueEstimate)}</span>
                        </div>
                      </div>

                      {/* Bell toggle */}
                      {data.userContext.authenticated && (
                        <button
                          onClick={() => toggleSubscription(r.ticker, r.isSubscribed)}
                          disabled={togglingTicker === r.ticker}
                          className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors disabled:opacity-50"
                          style={{
                            background: r.isSubscribed ? 'rgba(96,165,250,0.15)' : 'transparent',
                            border: `1px solid ${r.isSubscribed ? 'rgba(96,165,250,0.3)' : 'rgba(255,255,255,0.08)'}`,
                          }}
                          title={r.isSubscribed ? 'Unsubscribe from earnings alert' : 'Get email alert on earnings day'}
                        >
                          {r.isSubscribed ? (
                            <Bell size={12} style={{ color: '#60a5fa' }} />
                          ) : (
                            <BellOff size={12} style={{ color: 'var(--text3)' }} />
                          )}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              )
            })}
          </div>

          {/* Filtered count indicator */}
          {hiddenCount > 0 && (
            <div className="px-5 py-2 border-t text-[10px] font-mono uppercase tracking-widest text-center" style={{ borderColor: 'var(--border)', color: 'var(--text3)' }}>
              {hiddenCount} low-data entr{hiddenCount === 1 ? 'y' : 'ies'} hidden · small-cap ADRs without estimates
            </div>
          )}

          {/* Pagination */}
          {data.totalPages > 1 && (
            <div className="flex items-center justify-between px-5 py-3 border-t text-xs" style={{ borderColor: 'var(--border)' }}>
              <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text3)' }}>
                Page {data.page} of {data.totalPages} · {data.totalCount} total
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="flex items-center gap-1 px-3 py-1 rounded-lg text-[10px] font-mono uppercase tracking-widest disabled:opacity-40"
                  style={{ background: 'var(--surface2)', color: 'var(--text3)', border: '1px solid var(--border)' }}
                >
                  <ChevronLeft size={10} /> Prev
                </button>
                <button
                  onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                  disabled={page === data.totalPages}
                  className="flex items-center gap-1 px-3 py-1 rounded-lg text-[10px] font-mono uppercase tracking-widest disabled:opacity-40"
                  style={{ background: 'var(--surface2)', color: 'var(--text3)', border: '1px solid var(--border)' }}
                >
                  Next <ChevronRight size={10} />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {!data?.userContext.authenticated && !loading && (
        <div className="px-5 py-3 border-t text-[10px] font-mono uppercase tracking-widest" style={{ borderColor: 'var(--border)', color: 'var(--text3)' }}>
          Sign in to star your holdings and enable earnings notifications
        </div>
      )}
    </div>
  )
}
