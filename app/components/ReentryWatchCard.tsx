'use client'

// =============================================================
// app/components/ReentryWatchCard.tsx
//
// Self-contained panel for the auto-trader dashboard. Fetches
// /api/auto-trader/dashboard/reentry-watch and shows the tickers the
// position monitor exited that are eligible for automated re-entry
// (status='watching'), plus recently exhausted ones, with side,
// re-entry count, and exit price.
//
// Self-fetching so the dashboard page only needs to render <ReentryWatchCard/>.
// =============================================================

import { useEffect, useState } from 'react'
import { RotateCcw, TrendingUp, TrendingDown } from 'lucide-react'

interface ReentryWatchItem {
  ticker: string
  side: 'buy' | 'sell'
  direction: 'long' | 'short'
  reentryCount: number
  maxReentries: number
  exitPrice: number | null
  exitAt: string
  status: string
  lastReentryAt: string | null
}

interface ReentryWatchData {
  ok: boolean
  watching: ReentryWatchItem[]
  exhausted: ReentryWatchItem[]
  error?: string
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function DirBadge({ direction }: { direction: 'long' | 'short' }) {
  const long = direction === 'long'
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase"
      style={{
        color: long ? '#34d399' : '#f87171',
        background: long ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
      }}>
      {long ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
      {direction}
    </span>
  )
}

function Row({ item, dim }: { item: ReentryWatchItem; dim?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5" style={{ opacity: dim ? 0.55 : 1 }}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-bold" style={{ color: 'var(--text)' }}>{item.ticker}</span>
        <DirBadge direction={item.direction} />
      </div>
      <div className="flex items-center gap-3 shrink-0 text-[11px]" style={{ color: 'var(--text3)' }}>
        {item.exitPrice !== null && (
          <span>exit ${item.exitPrice.toFixed(2)}</span>
        )}
        <span style={{ color: 'var(--text2)' }}>
          {item.reentryCount}/{item.maxReentries} used
        </span>
        <span>{timeAgo(item.exitAt)}</span>
      </div>
    </div>
  )
}

export default function ReentryWatchCard() {
  const [data, setData] = useState<ReentryWatchData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    fetch('/api/auto-trader/dashboard/reentry-watch', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then((d: ReentryWatchData | null) => { if (alive) setData(d) })
      .catch(() => { if (alive) setData(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const watching = data?.watching ?? []
  const exhausted = data?.exhausted ?? []

  // Don't render the card at all when there's nothing to show (keeps the
  // dashboard clean until the monitor has actually exited something).
  if (!loading && watching.length === 0 && exhausted.length === 0) return null

  return (
    <div className="mb-4 p-4 rounded-xl"
      style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.18)' }}>
      <div className="flex items-center gap-2 mb-1">
        <RotateCcw size={15} style={{ color: '#a78bfa' }} />
        <span className="text-sm font-bold" style={{ color: 'var(--text)' }}>Re-entry Watch</span>
      </div>
      <div className="text-[11px] mb-2" style={{ color: 'var(--text3)' }}>
        Exited positions the monitor will re-enter if the setup returns (within 7 days).
      </div>

      {loading ? (
        <div className="text-xs py-2" style={{ color: 'var(--text3)' }}>Loading…</div>
      ) : (
        <>
          {watching.length > 0 ? (
            <div className="grid gap-0.5">
              {watching.map(item => <Row key={item.ticker} item={item} />)}
            </div>
          ) : (
            <div className="text-xs py-1" style={{ color: 'var(--text3)' }}>Nothing actively watched.</div>
          )}

          {exhausted.length > 0 && (
            <div className="mt-3 pt-2" style={{ borderTop: '1px solid rgba(167,139,250,0.12)' }}>
              <div className="text-[10px] uppercase font-semibold mb-1" style={{ color: 'var(--text3)' }}>
                Re-entries used up
              </div>
              <div className="grid gap-0.5">
                {exhausted.map(item => <Row key={item.ticker} item={item} dim />)}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
