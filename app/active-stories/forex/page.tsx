'use client'

// =============================================================
// app/active-stories/forex/page.tsx
//
// Forex Active Stories surface — companion to the equity active
// stories page. Shows currently-tracked forex pairs with their
// catalysts, signals, and recent updates.
//
// Architecture:
//   - Reads from same tracked_stories table as equity page
//   - Filters client-side OR server-side to asset_type='forex'
//   - Pulls run metadata from active_stories_meta row id=2
//   - Refreshes every 60s to catch fresh cron runs
// =============================================================

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, RefreshCw, AlertCircle, TrendingUp, TrendingDown, Minus,
  Clock, Globe, Activity,
} from 'lucide-react'

interface ForexStory {
  id: string
  ticker: string
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number
  magnitude?: 'high' | 'medium' | 'low'
  timeframes: string[]
  sessionAnchor: 'today' | 'tomorrow' | 'weekend'
  catalyst: string
  reason?: string
  headline?: string
  riskLevel?: 'high' | 'medium' | 'low'
  status: 'active' | 'playing_out' | 'resolved'
  firstSeen: string
  lastUpdated: string
  entryPrice?: number | null
  updates?: Array<{
    runId: number
    at: string
    note: string
    signalChange?: string
    confidenceChange?: number
  }>
}

interface ForexRunMeta {
  runId: number
  generatedAt: string
  marketTheme: string
  marketStatus: string
  summary: string
}

interface ForexPageData {
  stories: ForexStory[]
  meta: ForexRunMeta | null
}

export default function ForexActiveStoriesPage() {
  const router = useRouter()
  const [data, setData] = useState<ForexPageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/active-stories?assetType=forex')
      if (!res.ok) throw new Error(`Failed: ${res.status}`)
      const json = await res.json() as ForexPageData
      setData(json)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    const id = setInterval(loadData, 60_000)
    return () => clearInterval(id)
  }, [loadData])

  const stories = data?.stories ?? []
  const meta = data?.meta ?? null
  const playingOut = stories.filter(s => s.status === 'playing_out')
  const today = stories.filter(s => s.status === 'active' && s.sessionAnchor === 'today')
  const tomorrow = stories.filter(s => s.status === 'active' && (s.sessionAnchor === 'tomorrow' || s.sessionAnchor === 'weekend'))

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>

      {/* Header */}
      <header
        className="flex flex-wrap items-center gap-2 px-3 py-3 border-b sticky top-0 z-10"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70">
          <ArrowLeft size={13} />
          Back
        </button>
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        <div className="flex items-center gap-2">
          <Globe size={14} style={{ color: '#60a5fa' }} />
          <span className="text-sm font-bold">Forex Active Stories</span>
        </div>
        <span className="text-[10px] font-mono text-white/25">currency pairs being tracked</span>

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => router.push('/active-stories')}
            className="text-[10px] font-mono text-white/40 hover:text-white/70 px-2 py-1 rounded border"
            style={{ borderColor: 'var(--border)' }}
          >
            Stocks →
          </button>
          <button
            onClick={loadData}
            className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70"
            disabled={loading}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-5xl mx-auto w-full px-3 py-5 space-y-5">

        {/* Market theme banner */}
        {meta && (
          <section
            className="rounded-xl p-4 border"
            style={{
              background: 'linear-gradient(135deg, rgba(96,165,250,0.05) 0%, rgba(167,139,250,0.05) 100%)',
              borderColor: 'rgba(96,165,250,0.15)',
            }}
          >
            <div className="flex items-start gap-3">
              <Activity size={18} style={{ color: '#60a5fa' }} className="mt-0.5 shrink-0" />
              <div className="flex-1">
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <h2 className="text-sm font-bold">{meta.marketTheme}</h2>
                  <span className="text-[10px] font-mono text-white/30">{formatRelativeTime(meta.generatedAt)}</span>
                </div>
                <p className="text-xs text-white/65 italic mb-2">{meta.marketStatus}</p>
                <p className="text-xs text-white/55 leading-relaxed">{meta.summary}</p>
              </div>
            </div>
          </section>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-xl border p-4 flex items-start gap-2"
            style={{ background: 'rgba(248,113,113,0.05)', borderColor: 'rgba(248,113,113,0.2)' }}>
            <AlertCircle size={14} style={{ color: '#f87171' }} className="shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-semibold" style={{ color: '#f87171' }}>Failed to load forex stories</div>
              <p className="text-[11px] text-white/55 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && stories.length === 0 && (
          <div className="rounded-xl border p-8 text-center" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <Globe size={32} className="mx-auto mb-3 text-white/20" />
            <h3 className="text-sm font-bold text-white/70 mb-1">No forex stories active</h3>
            <p className="text-xs text-white/40">The forex tracker runs 3× daily at session opens. New stories will appear here when catalysts arrive.</p>
          </div>
        )}

        {/* Playing out section (highest priority) */}
        {playingOut.length > 0 && (
          <StorySection
            title="Playing out now"
            count={playingOut.length}
            color="#fbbf24"
            stories={playingOut}
          />
        )}

        {/* Today */}
        {today.length > 0 && (
          <StorySection
            title="Active today"
            count={today.length}
            color="#34d399"
            stories={today}
          />
        )}

        {/* Tomorrow / weekend */}
        {tomorrow.length > 0 && (
          <StorySection
            title="Scheduled — tomorrow / weekend"
            count={tomorrow.length}
            color="#60a5fa"
            stories={tomorrow}
          />
        )}

        {/* Footer */}
        <div className="pt-4 pb-8 text-center">
          <p className="text-[10px] text-white/25 font-mono leading-relaxed">
            Forex stories refresh 3× daily at London (08:00 UTC), NY (13:30 UTC), and Asia (22:00 UTC) opens.
            <br />
            Tracking: EURUSD · GBPUSD · USDJPY · AUDUSD · USDCAD · USDCHF · NZDUSD
          </p>
        </div>
      </main>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function StorySection({
  title, count, color, stories,
}: {
  title: string
  count: number
  color: string
  stories: ForexStory[]
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2.5 px-1">
        <div className="w-1 h-4 rounded-full" style={{ background: color }} />
        <h2 className="text-xs font-bold uppercase tracking-widest text-white/55">{title}</h2>
        <span className="text-[10px] font-mono text-white/30">({count})</span>
      </div>
      <div className="space-y-2">
        {stories.map(s => <StoryCard key={s.id} story={s} />)}
      </div>
    </section>
  )
}

function StoryCard({ story }: { story: ForexStory }) {
  const signalColor =
    story.signal === 'BULLISH' ? '#34d399' :
    story.signal === 'BEARISH' ? '#f87171' :
    '#94a3b8'
  const SignalIcon =
    story.signal === 'BULLISH' ? TrendingUp :
    story.signal === 'BEARISH' ? TrendingDown :
    Minus

  // Pair display: EURUSD → EUR/USD
  const pairDisplay = story.ticker.length === 6
    ? `${story.ticker.slice(0, 3)}/${story.ticker.slice(3)}`
    : story.ticker

  return (
    <div
      className="rounded-lg border p-3.5"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base font-bold font-mono">{pairDisplay}</span>
          <div
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold"
            style={{ background: `${signalColor}15`, color: signalColor, border: `1px solid ${signalColor}30` }}
          >
            <SignalIcon size={10} />
            {story.signal}
          </div>
          <span className="text-[10px] font-mono text-white/40">
            {story.confidence}% · {story.magnitude ?? '—'}
          </span>
          {story.riskLevel === 'high' && (
            <span
              className="text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wider"
              style={{ background: 'rgba(251,191,36,0.1)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)' }}
            >
              high risk
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[9px] font-mono text-white/30">
          <Clock size={9} />
          {formatRelativeTime(story.lastUpdated)}
        </div>
      </div>

      <p className="text-[13px] text-white/80 leading-relaxed mb-1.5">
        {story.catalyst}
      </p>

      {story.reason && (
        <p className="text-[11px] text-white/50 leading-relaxed italic mb-2">
          {story.reason}
        </p>
      )}

      <div className="flex items-center gap-2 text-[9px] font-mono text-white/30">
        <span>Timeframes: {story.timeframes.join(', ')}</span>
        <span>·</span>
        <span>{story.sessionAnchor}</span>
        {story.entryPrice !== null && story.entryPrice !== undefined && (
          <>
            <span>·</span>
            <span>Entry: {story.entryPrice.toFixed(4)}</span>
          </>
        )}
      </div>

      {story.updates && story.updates.length > 0 && (
        <div className="mt-2.5 pt-2.5 space-y-1" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          {story.updates.slice(-2).map((u, i) => (
            <div key={i} className="text-[11px] text-white/55 flex items-start gap-2">
              <span className="text-[9px] font-mono text-white/25 mt-0.5 shrink-0">
                {formatRelativeTime(u.at)}
              </span>
              <span>{u.note}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  const d = Math.round(hr / 24)
  return `${d}d`
}
