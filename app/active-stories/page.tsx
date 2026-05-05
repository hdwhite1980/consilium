'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'
import {
  LogOut, TrendingUp, TrendingDown, RefreshCw, ArrowLeft, Eye, Zap, Globe,
  AlertTriangle, BarChart3, Sun, Moon, Radio, Calendar, Clock, ShieldCheck,
  Activity, ChevronDown, ChevronUp, History,
} from 'lucide-react'

// ── Types — mirror the API contract from active-stories-types.ts ──────
type Signal = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
type SessionAnchor = 'today' | 'tomorrow' | 'weekend'
type AssetType = 'stock' | 'crypto'
type Magnitude = 'high' | 'medium' | 'low'
type RiskLevel = 'high' | 'medium' | 'low'
type Timeframe = '1D' | '1W' | '1M' | '3M'
type Status = 'active' | 'playing_out' | 'resolved'

interface StoryUpdate {
  ts: string
  note: string
  signalChange?: Signal
  confidenceChange?: number
  runId: number
}

interface TrackedStory {
  id: string
  ticker: string
  companyName: string | null
  assetType: AssetType
  signal: Signal
  confidence: number
  magnitude: Magnitude | null
  status: Status
  timeframes: Timeframe[]
  sessionAnchor: SessionAnchor
  catalyst: string | null
  reason: string | null
  headline: string | null
  riskLevel: RiskLevel | null
  firstSeen: string
  lastUpdated: string
  lastTouchedRun: number
  updates: StoryUpdate[]
  verified: boolean | null
  verificationSources: string[] | null
  verificationNote: string | null
}

interface ActiveStoriesPayload {
  generatedAt: string
  lastRunSource: string
  marketTheme: string
  marketStatus: string
  summary: string
  stories: TrackedStory[]
  counts: {
    total: number
    bySession: Record<SessionAnchor, number>
    byTimeframe: Record<Timeframe, number>
    bySignal: Record<Signal, number>
  }
}

// ── Visual constants ─────────────────────────────────────────────────
const MAG_COLOR: Record<Magnitude, string> = { high: '#f87171', medium: '#fbbf24', low: '#94a3b8' }
const MAG_LABEL: Record<Magnitude, string> = { high: 'Big move expected', medium: 'Moderate move', low: 'Small move' }
const RISK_COLOR: Record<RiskLevel, string> = { high: '#f87171', medium: '#fbbf24', low: '#34d399' }

const SESSION_LABELS: Record<SessionAnchor, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  weekend: 'Weekend',
}

const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  '1D': '1-Day',
  '1W': '1-Week',
  '1M': '1-Month',
  '3M': '3-Month',
}

const TIMEFRAME_DESC: Record<Timeframe, string> = {
  '1D': 'Catalyst plays out within the session',
  '1W': 'Catalyst plays out over 3-10 trading days',
  '1M': 'Catalyst plays out over weeks',
  '3M': 'Multi-month theme',
}

const TIMEFRAME_ORDER: Timeframe[] = ['1D', '1W', '1M', '3M']

// ── Helpers ──────────────────────────────────────────────────────────

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = ms / 60000
  if (mins < 60) return `${Math.round(mins)}m`
  const hrs = mins / 60
  if (hrs < 24) return `${hrs.toFixed(1)}h`
  const days = hrs / 24
  return `${days.toFixed(1)}d`
}

function signalColors(signal: Signal) {
  if (signal === 'BULLISH') return {
    accent: '#34d399',
    bg: 'rgba(52,211,153,0.04)',
    border: 'rgba(52,211,153,0.18)',
  }
  if (signal === 'BEARISH') return {
    accent: '#f87171',
    bg: 'rgba(248,113,113,0.04)',
    border: 'rgba(248,113,113,0.18)',
  }
  return {
    accent: '#fbbf24',
    bg: 'rgba(251,191,36,0.04)',
    border: 'rgba(251,191,36,0.18)',
  }
}

function confidenceColor(c: number): { color: string; bg: string; border: string } {
  if (c >= 80) return { color: '#34d399', bg: 'rgba(52,211,153,0.12)', border: 'rgba(52,211,153,0.25)' }
  if (c >= 70) return { color: '#fbbf24', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.25)' }
  return { color: '#94a3b8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.18)' }
}

// ── Story card ───────────────────────────────────────────────────────

function StoryCard({ story, onAnalyze }: { story: TrackedStory; onAnalyze: (ticker: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const colors = signalColors(story.signal)
  const confColors = confidenceColor(story.confidence)
  const SignalIcon = story.signal === 'BULLISH' ? TrendingUp : story.signal === 'BEARISH' ? TrendingDown : Eye
  const isPlayingOut = story.status === 'playing_out'
  const ageStr = formatAge(story.firstSeen)
  const lastUpdateStr = formatAge(story.lastUpdated)
  const hasUpdates = story.updates.length > 0
  const latestUpdate = hasUpdates ? story.updates[story.updates.length - 1] : null

  return (
    <div
      className="rounded-xl border transition-all duration-200"
      style={{ background: colors.bg, borderColor: colors.border }}
    >
      {/* Header — clickable to expand */}
      <div className="p-4 cursor-pointer" onClick={() => setExpanded(v => !v)}>
        <div className="flex items-start justify-between gap-3">
          {/* Left: ticker + name + meta */}
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="shrink-0 px-2.5 py-1 rounded-lg font-mono font-bold text-sm"
              style={{ background: `${colors.accent}18`, color: colors.accent, border: `1px solid ${colors.accent}30` }}
            >
              {story.ticker}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white/80 truncate">
                {story.companyName ?? story.ticker}
              </div>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                {story.magnitude && (
                  <span className="text-[10px] font-mono" style={{ color: MAG_COLOR[story.magnitude] }}>
                    {MAG_LABEL[story.magnitude]}
                  </span>
                )}
                {story.magnitude && story.riskLevel && <span className="text-[10px] text-white/25">·</span>}
                {story.riskLevel && (
                  <span className="text-[10px] font-mono" style={{ color: RISK_COLOR[story.riskLevel] }}>
                    {story.riskLevel} risk
                  </span>
                )}
                {story.assetType === 'crypto' && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded font-mono"
                    style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>CRYPTO</span>
                )}
              </div>
            </div>
          </div>

          {/* Right: badges */}
          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            {/* Playing-out badge */}
            {isPlayingOut && (
              <div
                className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-mono font-semibold"
                style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.25)' }}
                title="Catalyst is unfolding right now"
              >
                <Activity size={9} className="animate-pulse" /> playing out
              </div>
            )}
            {/* Confidence */}
            <div
              className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-mono font-semibold"
              style={{ background: confColors.bg, color: confColors.color, border: `1px solid ${confColors.border}` }}
              title={`Model confidence: ${story.confidence}%`}
            >
              {story.confidence}%
            </div>
            {/* Verified */}
            {story.verified === true && (
              <div
                className="flex items-center gap-0.5 px-1.5 py-1 rounded-full text-[9px] font-mono font-semibold"
                style={{ background: 'rgba(96,165,250,0.12)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.25)' }}
                title={story.verificationNote || 'Verified against trusted sources'}
              >
                <ShieldCheck size={9} />
                <span>verified</span>
              </div>
            )}
            {/* Signal */}
            <div
              className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-mono font-semibold"
              style={{ background: `${colors.accent}15`, color: colors.accent, border: `1px solid ${colors.accent}28` }}
            >
              <SignalIcon size={10} />
              {story.signal}
            </div>
            <span className="text-white/25 text-xs">{expanded ? '▲' : '▼'}</span>
          </div>
        </div>

        {/* Timeframes + age line */}
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          {story.timeframes.map(tf => (
            <span
              key={tf}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.55)', border: '1px solid rgba(255,255,255,0.08)' }}
              title={TIMEFRAME_DESC[tf]}
            >
              {tf}
            </span>
          ))}
          <span className="text-[10px] text-white/25 font-mono ml-auto">
            tracked {ageStr} · updated {lastUpdateStr} ago
          </span>
        </div>

        {/* Headline */}
        {story.headline && (
          <p className="text-xs text-white/55 mt-2.5 leading-relaxed line-clamp-2">{story.headline}</p>
        )}

        {/* Latest update note (most recent run's note, prominent) */}
        {latestUpdate && (
          <div
            className="mt-2.5 rounded-md px-2.5 py-1.5 text-[11px] text-white/65 leading-relaxed"
            style={{ background: 'rgba(255,255,255,0.03)', borderLeft: `2px solid ${colors.accent}40` }}
          >
            <span className="text-[9px] font-mono uppercase tracking-widest mr-1.5" style={{ color: colors.accent }}>
              latest update
            </span>
            {latestUpdate.note}
            {(latestUpdate.signalChange || latestUpdate.confidenceChange !== undefined) && (
              <span className="ml-1.5 text-[10px] font-mono text-white/40">
                {latestUpdate.signalChange && `→${latestUpdate.signalChange} `}
                {latestUpdate.confidenceChange !== undefined && `(conf:${latestUpdate.confidenceChange}%)`}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t" style={{ borderColor: `${colors.accent}15` }}>
          {/* What this means */}
          {story.reason && (
            <div className="pt-3">
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: colors.accent }}>
                What this means
              </div>
              <p className="text-sm text-white/75 leading-relaxed">{story.reason}</p>
            </div>
          )}

          {/* Catalyst */}
          {story.catalyst && (
            <div className="rounded-lg p-3" style={{ background: 'var(--surface2)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-1">Catalyst</div>
              <p className="text-xs text-white/65 leading-relaxed">{story.catalyst}</p>
            </div>
          )}

          {/* Timeframe explanations */}
          <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-2">Trade horizons</div>
            <div className="space-y-1">
              {story.timeframes.map(tf => (
                <div key={tf} className="flex items-baseline gap-2">
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0"
                    style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.7)' }}>
                    {tf}
                  </span>
                  <span className="text-[11px] text-white/55">{TIMEFRAME_DESC[tf]}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Verification sources */}
          {story.verified && story.verificationSources && story.verificationSources.length > 0 && (
            <div className="rounded-lg p-3" style={{ background: 'rgba(96,165,250,0.05)', border: '1px solid rgba(96,165,250,0.18)' }}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <ShieldCheck size={10} style={{ color: '#60a5fa' }} />
                <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: '#60a5fa' }}>Verified by</div>
              </div>
              {story.verificationNote && (
                <p className="text-[11px] text-white/60 mb-1.5 italic">{story.verificationNote}</p>
              )}
              <div className="space-y-1">
                {story.verificationSources.slice(0, 3).map((url, i) => {
                  let domain = url
                  try { domain = new URL(url).hostname.replace(/^www\./, '') } catch { /* ignore */ }
                  return (
                    <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                      className="text-[11px] text-blue-300/80 hover:text-blue-300 truncate block">
                      → {domain}
                    </a>
                  )
                })}
              </div>
            </div>
          )}

          {/* Update timeline (collapsible) */}
          {hasUpdates && (
            <div>
              <button
                onClick={() => setShowHistory(v => !v)}
                className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-white/45 hover:text-white/70"
              >
                <History size={11} />
                Update history ({story.updates.length})
                {showHistory ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              </button>
              {showHistory && (
                <div className="mt-2 space-y-2">
                  {story.updates.slice().reverse().map((u, i) => (
                    <div
                      key={i}
                      className="rounded-md px-2.5 py-1.5 text-[11px] text-white/60 leading-relaxed"
                      style={{ background: 'rgba(255,255,255,0.03)', borderLeft: `2px solid rgba(255,255,255,0.15)` }}
                    >
                      <div className="flex items-baseline gap-2 mb-0.5">
                        <span className="text-[9px] font-mono text-white/35">
                          run {u.runId} · {formatAge(u.ts)} ago
                        </span>
                        {u.signalChange && (
                          <span className="text-[9px] font-mono" style={{ color: signalColors(u.signalChange).accent }}>
                            → {u.signalChange}
                          </span>
                        )}
                        {u.confidenceChange !== undefined && (
                          <span className="text-[9px] font-mono text-white/45">
                            conf: {u.confidenceChange}%
                          </span>
                        )}
                      </div>
                      <p>{u.note}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Action button */}
          <button
            onClick={(e) => { e.stopPropagation(); onAnalyze(story.ticker) }}
            className="w-full mt-1 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-80"
            style={{
              background: `${colors.accent}18`,
              color: colors.accent,
              border: `1px solid ${colors.accent}30`,
            }}
          >
            Run full Council analysis on {story.ticker} →
          </button>
        </div>
      )}
    </div>
  )
}

// ── Empty state ──────────────────────────────────────────────────────

function EmptyTimeframeBlock({ timeframe }: { timeframe: Timeframe }) {
  return (
    <div className="rounded-xl border border-dashed p-4 text-center"
      style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
      <span className="text-[10px] font-mono text-white/25 uppercase tracking-widest">
        No active stories at the {TIMEFRAME_LABELS[timeframe]} horizon
      </span>
    </div>
  )
}

// ── Main page ───────────────────────────────────────────────────────

export default function ActiveStoriesPage() {
  const router = useRouter()
  const supabase = createClient()

  const [session, setSession] = useState<SessionAnchor>('today')
  const [data, setData] = useState<ActiveStoriesPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (sess: SessionAnchor) => {
    setError(null)
    try {
      const res = await fetch(`/api/active-stories?session=${sess}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const payload = await res.json() as ActiveStoriesPayload
      setData(payload)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    load(session)
  }, [session, load])

  const refresh = () => {
    setRefreshing(true)
    load(session)
  }

  const handleAnalyze = (ticker: string) => router.push(`/?ticker=${ticker}`)

  const handleSignOut = async () => {
    try { await fetch('/api/auth/session', { method: 'DELETE' }) } catch {}
    try {
      Object.keys(localStorage).filter(k => k.startsWith('sb-')).forEach(k => localStorage.removeItem(k))
      document.cookie.split(';').forEach(c => {
        const name = c.split('=')[0].trim()
        if (name.startsWith('sb-') || name === 'wali_device_id') {
          document.cookie = name + '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
        }
      })
    } catch {}
    window.location.replace('/login')
  }

  // Group stories by timeframe — a story can appear in multiple groups
  const storiesByTimeframe = useMemo(() => {
    const groups: Record<Timeframe, TrackedStory[]> = { '1D': [], '1W': [], '1M': [], '3M': [] }
    if (!data?.stories) return groups
    for (const s of data.stories) {
      for (const tf of s.timeframes) {
        if (tf in groups) groups[tf].push(s)
      }
    }
    // Within each timeframe, sort by confidence desc
    for (const tf of TIMEFRAME_ORDER) {
      groups[tf].sort((a, b) => b.confidence - a.confidence)
    }
    return groups
  }, [data])

  const timeAgo = data?.generatedAt
    ? Math.round((Date.now() - new Date(data.generatedAt).getTime()) / 60000)
    : null

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>

      {/* ── Header ────────────────────────────────────────────────── */}
      <header
        className="flex flex-wrap items-center gap-2 px-3 py-3 border-b sticky top-0 z-10"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <button
          onClick={() => router.push('/')}
          className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors"
        >
          <ArrowLeft size={13} />
          Back
        </button>
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        <div className="flex items-center gap-2">
          <Zap size={14} style={{ color: '#fbbf24' }} />
          <span className="text-sm font-bold">Active Stories</span>
        </div>
        <span className="text-[10px] font-mono text-white/25">tracked across runs</span>

        <div className="ml-auto flex items-center gap-3">
          {timeAgo !== null && (
            <span className="text-[10px] font-mono text-white/30">
              Last cron run {timeAgo === 0 ? 'just now' : `${timeAgo}m ago`}
              {data?.lastRunSource && ` · ${data.lastRunSource}`}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={refreshing || loading}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg transition-all disabled:opacity-40"
            style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.7)', border: '1px solid rgba(255,255,255,0.08)' }}
            title="Reload from cache (cron-driven, no manual generation)"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Reloading...' : 'Reload'}
          </button>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors"
          >
            <LogOut size={13} />
          </button>
        </div>
      </header>

      {/* ── Main column ───────────────────────────────────────────── */}
      <main className="flex-1 max-w-5xl mx-auto w-full px-3 py-4 space-y-5">

        {/* Session toggle */}
        <div
          className="flex items-center gap-1 p-1 rounded-xl border"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)', width: 'fit-content' }}
        >
          {(['today', 'tomorrow', 'weekend'] as SessionAnchor[]).map(sess => {
            const isActive = session === sess
            const count = data?.counts.bySession[sess] ?? 0
            const Icon = sess === 'today' ? Sun : sess === 'tomorrow' ? Moon : Calendar
            return (
              <button
                key={sess}
                onClick={() => setSession(sess)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                style={{
                  background: isActive ? 'rgba(167,139,250,0.15)' : 'transparent',
                  color: isActive ? '#a78bfa' : 'rgba(255,255,255,0.55)',
                  border: isActive ? '1px solid rgba(167,139,250,0.3)' : '1px solid transparent',
                }}
              >
                <Icon size={12} />
                {SESSION_LABELS[sess]}
                <span className="text-[10px] font-mono opacity-60">({count})</span>
              </button>
            )
          })}
        </div>

        {/* Run metadata card */}
        {data && (data.marketTheme || data.summary) && (
          <div
            className="rounded-xl border p-4"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            <div className="flex items-center gap-1.5 mb-2">
              <Globe size={11} style={{ color: '#a78bfa' }} />
              <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: '#a78bfa' }}>
                Market theme
              </span>
            </div>
            {data.marketTheme && (
              <h2 className="text-base font-bold text-white/90 mb-2">{data.marketTheme}</h2>
            )}
            {data.marketStatus && (
              <p className="text-xs text-white/55 mb-2 italic">{data.marketStatus}</p>
            )}
            {data.summary && (
              <p className="text-sm text-white/70 leading-relaxed">{data.summary}</p>
            )}

            {/* Counts strip */}
            <div className="flex items-center gap-3 mt-3 pt-3 border-t" style={{ borderColor: 'var(--border)' }}>
              <span className="text-[10px] font-mono text-white/40">{data.counts.total} active</span>
              <span className="text-white/15">·</span>
              <span className="text-[10px] font-mono" style={{ color: '#34d399' }}>
                {data.counts.bySignal.BULLISH} bullish
              </span>
              <span className="text-[10px] font-mono" style={{ color: '#f87171' }}>
                {data.counts.bySignal.BEARISH} bearish
              </span>
              {data.counts.bySignal.NEUTRAL > 0 && (
                <span className="text-[10px] font-mono" style={{ color: '#fbbf24' }}>
                  {data.counts.bySignal.NEUTRAL} watching
                </span>
              )}
              <span className="text-white/15">·</span>
              {TIMEFRAME_ORDER.map(tf =>
                data.counts.byTimeframe[tf] > 0 && (
                  <span key={tf} className="text-[10px] font-mono text-white/35">
                    {data.counts.byTimeframe[tf]}× {tf}
                  </span>
                )
              )}
            </div>
          </div>
        )}

        {/* Loading state */}
        {loading && !data && (
          <div className="flex items-center justify-center py-12">
            <RefreshCw size={20} className="animate-spin text-white/30" />
            <span className="ml-2 text-xs text-white/40">Loading active stories...</span>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div
            className="rounded-xl border p-4 flex items-start gap-2"
            style={{ background: 'rgba(248,113,113,0.05)', borderColor: 'rgba(248,113,113,0.2)' }}
          >
            <AlertTriangle size={14} style={{ color: '#f87171' }} className="shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-semibold" style={{ color: '#f87171' }}>Failed to load</div>
              <p className="text-[11px] text-white/55 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* Timeframe sections */}
        {data && !loading && data.stories.length > 0 && TIMEFRAME_ORDER.map(tf => {
          const stories = storiesByTimeframe[tf]
          if (stories.length === 0) return null  // skip empty timeframes — only show what's populated
          return (
            <section key={tf}>
              <div className="flex items-baseline gap-2 mb-2.5">
                <h3 className="text-sm font-bold text-white/85">{TIMEFRAME_LABELS[tf]} horizon</h3>
                <span className="text-[10px] font-mono text-white/35">
                  {stories.length} {stories.length === 1 ? 'story' : 'stories'}
                </span>
                <span className="text-[10px] text-white/25 ml-1">{TIMEFRAME_DESC[tf]}</span>
              </div>
              <div className="space-y-2.5">
                {stories.map(s => (
                  <StoryCard key={`${tf}-${s.id}`} story={s} onAnalyze={handleAnalyze} />
                ))}
              </div>
            </section>
          )
        })}

        {/* Empty state — no stories at all in this session */}
        {data && !loading && data.stories.length === 0 && (
          <div
            className="rounded-xl border border-dashed p-8 text-center"
            style={{ borderColor: 'rgba(255,255,255,0.08)' }}
          >
            <Radio size={20} className="mx-auto text-white/20 mb-2" />
            <div className="text-xs text-white/45 font-semibold mb-1">No active stories for {SESSION_LABELS[session].toLowerCase()}</div>
            <p className="text-[11px] text-white/30 leading-relaxed max-w-md mx-auto">
              The classifier runs 4× daily (6 AM / 12 PM / 5 PM / 9 PM ET).
              Stories appear here when fresh news creates actionable catalysts.
            </p>
            {data.generatedAt && (
              <p className="text-[10px] text-white/25 font-mono mt-3">
                Last cron run: {formatAge(data.generatedAt)} ago
              </p>
            )}
          </div>
        )}

        {/* Footer note */}
        <div className="pt-4 pb-8 text-center">
          <p className="text-[10px] text-white/20 font-mono">
            Stories tracked across cron runs · LLM-driven decay with time caps · Powered by Wali-OS
          </p>
        </div>
      </main>
    </div>
  )
}
