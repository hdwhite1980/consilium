'use client'

import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  LogOut, TrendingUp, TrendingDown, RefreshCw, ArrowLeft, Eye, Zap, Globe,
  AlertTriangle, BarChart3, Sun, Moon, Calendar, Clock, ShieldCheck,
  Activity, ChevronDown, ChevronUp, History, Check, Radio,
} from 'lucide-react'
import { MoversHitRateWidget } from '@/app/components/MoversHitRateWidget'

// ── Types ──────────────────────────────────────────────────────
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

interface MacroTheme {
  id: string
  theme_name: string
  theme_summary: string
  playbook: string
  sectors_to_watch: string[]
  tickers_to_watch: string[]
  urgency: string
}

interface MonitorAlert {
  id: string
  headline: string
  analysis?: string
  action?: string
  urgency: 'critical' | 'high' | 'medium' | 'low'
  market_impact?: 'bullish' | 'bearish' | 'neutral'
  ticker?: string
  acknowledged: boolean
  created_at: string
}

interface SocialSignal {
  id: string
  source: string
  headline: string
  analysis?: string
  impact?: 'bullish' | 'bearish' | 'neutral' | 'mixed'
  urgency?: 'high' | 'medium' | 'low'
  tickers?: string[]
  posted_at?: string
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

function urgencyColor(u: string): string {
  if (u === 'critical') return '#f87171'
  if (u === 'high') return '#fbbf24'
  if (u === 'medium') return '#a78bfa'
  return '#94a3b8'
}

function impactColor(i?: string): string {
  if (i === 'bullish') return '#34d399'
  if (i === 'bearish') return '#f87171'
  if (i === 'mixed') return '#fbbf24'
  return '#94a3b8'
}

// ── Story card (full version, identical to Phase 3) ─────────────────

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
      <div className="p-4 cursor-pointer" onClick={() => setExpanded(v => !v)}>
        <div className="flex items-start justify-between gap-3">
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

          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            {isPlayingOut && (
              <div
                className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-mono font-semibold"
                style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.25)' }}
                title="Catalyst is unfolding right now"
              >
                <Activity size={9} className="animate-pulse" /> playing out
              </div>
            )}
            <div
              className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-mono font-semibold"
              style={{ background: confColors.bg, color: confColors.color, border: `1px solid ${confColors.border}` }}
              title={`Model confidence: ${story.confidence}%`}
            >
              {story.confidence}%
            </div>
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

        {story.headline && (
          <p className="text-xs text-white/55 mt-2.5 leading-relaxed line-clamp-2">{story.headline}</p>
        )}

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

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t" style={{ borderColor: `${colors.accent}15` }}>
          {story.reason && (
            <div className="pt-3">
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: colors.accent }}>
                What this means
              </div>
              <p className="text-sm text-white/75 leading-relaxed">{story.reason}</p>
            </div>
          )}
          {story.catalyst && (
            <div className="rounded-lg p-3" style={{ background: 'var(--surface2)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-1">Catalyst</div>
              <p className="text-xs text-white/65 leading-relaxed">{story.catalyst}</p>
            </div>
          )}
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

// ── Sidebar panel wrapper for visual consistency ────────────────────

function SidePanel({ icon, title, children, accentColor = '#a78bfa', headerExtra }: {
  icon: ReactNode
  title: string
  children: ReactNode
  accentColor?: string
  headerExtra?: ReactNode
}) {
  return (
    <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ color: accentColor }} className="shrink-0">{icon}</span>
          <span className="text-xs font-bold truncate">{title}</span>
        </div>
        {headerExtra}
      </div>
      {children}
    </div>
  )
}

// ── Macro Intelligence panel ────────────────────────────────────────

function MacroPanel({ themes }: { themes: MacroTheme[] }) {
  if (themes.length === 0) return null
  return (
    <SidePanel icon={<Globe size={12} />} title="Macro Themes" accentColor="#a78bfa"
      headerExtra={
        <span className="text-[10px] font-mono text-white/35">{themes.length}</span>
      }
    >
      <div className="divide-y max-h-80 overflow-y-auto" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
        {themes.slice(0, 5).map(t => (
          <div key={t.id} className="px-4 py-2.5">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded uppercase"
                style={{
                  background: t.urgency === 'high' ? 'rgba(248,113,113,0.12)' : 'rgba(167,139,250,0.10)',
                  color: t.urgency === 'high' ? '#f87171' : '#a78bfa',
                }}>
                {t.urgency}
              </span>
              <span className="text-xs font-semibold text-white/85 truncate">{t.theme_name}</span>
            </div>
            <p className="text-[11px] text-white/55 leading-relaxed line-clamp-2">{t.theme_summary}</p>
            {(t.tickers_to_watch?.length > 0 || t.sectors_to_watch?.length > 0) && (
              <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                {t.tickers_to_watch?.slice(0, 4).map(ticker => (
                  <span key={ticker} className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(167,139,250,0.10)', color: '#a78bfa' }}>
                    {ticker}
                  </span>
                ))}
                {t.sectors_to_watch?.slice(0, 2).map(sector => (
                  <span key={sector} className="text-[9px] font-mono text-white/35">
                    {sector}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </SidePanel>
  )
}

// ── Live Monitor panel (alerts) ─────────────────────────────────────

function MonitorPanel({
  alerts, newAlertCount, monitorRunning, onScan, onAcknowledge, onAnalyze,
}: {
  alerts: MonitorAlert[]
  newAlertCount: number
  monitorRunning: boolean
  onScan: () => void
  onAcknowledge: (id: string) => void
  onAnalyze: (ticker: string) => void
}) {
  const headerColor = alerts.some(a => !a.acknowledged && a.urgency === 'critical')
    ? 'rgba(248,113,113,0.4)'
    : alerts.some(a => !a.acknowledged && a.urgency === 'high')
    ? 'rgba(251,191,36,0.3)'
    : 'rgba(255,255,255,0.07)'

  return (
    <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: headerColor }}>
      <div className="flex items-center justify-between px-4 py-2.5 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2 min-w-0">
          <div className="relative shrink-0">
            <span className="w-2 h-2 rounded-full inline-block animate-pulse" style={{ background: '#f87171' }} />
            {newAlertCount > 0 && (
              <span className="absolute -top-1 -right-1 text-[8px] font-bold px-1 rounded-full"
                style={{ background: '#f87171', color: 'var(--text)', minWidth: '12px', textAlign: 'center' }}>
                {newAlertCount}
              </span>
            )}
          </div>
          <span className="text-xs font-bold">Live Monitor</span>
          <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-full"
            style={{ background: 'rgba(52,211,153,0.12)', color: '#34d399' }}>
            3min
          </span>
        </div>
        <button onClick={onScan} disabled={monitorRunning}
          className="text-[10px] font-mono px-2 py-1 rounded-lg disabled:opacity-40 hover:opacity-80 shrink-0"
          style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
          {monitorRunning ? '⟳' : 'Scan'}
        </button>
      </div>
      {alerts.length > 0 ? (
        <div className="divide-y max-h-96 overflow-y-auto" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
          {alerts.slice(0, 10).map(alert => (
            <div key={alert.id} className="px-4 py-2.5 transition-opacity"
              style={{ opacity: alert.acknowledged ? 0.4 : 1 }}>
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase"
                      style={{
                        background: alert.urgency === 'critical' ? 'rgba(248,113,113,0.2)' : alert.urgency === 'high' ? 'rgba(251,191,36,0.15)' : 'rgba(255,255,255,0.08)',
                        color: urgencyColor(alert.urgency),
                      }}>
                      {alert.urgency}
                    </span>
                    {alert.market_impact && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded font-mono"
                        style={{
                          background: `${impactColor(alert.market_impact)}15`,
                          color: impactColor(alert.market_impact),
                        }}>
                        {alert.market_impact}
                      </span>
                    )}
                    {alert.ticker && (
                      <button onClick={() => onAnalyze(alert.ticker!)}
                        className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded hover:opacity-80"
                        style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
                        {alert.ticker}
                      </button>
                    )}
                    <span className="text-[9px] text-white/25 ml-auto">
                      {Math.round((Date.now() - new Date(alert.created_at).getTime()) / 60000)}m
                    </span>
                  </div>
                  <p className="text-[11px] text-white/70 leading-relaxed font-medium line-clamp-2">{alert.headline}</p>
                  {alert.action && (
                    <p className="text-[10px] font-semibold mt-1" style={{ color: alert.urgency === 'critical' ? '#f87171' : '#fbbf24' }}>
                      → {alert.action}
                    </p>
                  )}
                </div>
                {!alert.acknowledged && (
                  <button onClick={() => onAcknowledge(alert.id)}
                    className="shrink-0 p-1 rounded hover:opacity-80 mt-0.5"
                    style={{ background: 'var(--surface2)', color: 'var(--text3)' }}
                    aria-label="Acknowledge alert">
                    <Check size={10} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-4 py-5 text-center">
          <p className="text-xs text-white/25">No alerts yet</p>
          <p className="text-[10px] text-white/15 mt-1">Auto-scanning every 3min</p>
        </div>
      )}
    </div>
  )
}

// ── Social Signals panel ────────────────────────────────────────────

function SocialPanel({ signals, onScan, loading, onAnalyze }: {
  signals: SocialSignal[]
  onScan: () => void
  loading: boolean
  onAnalyze: (ticker: string) => void
}) {
  return (
    <SidePanel icon={<Radio size={12} />} title="Social Signals" accentColor="#60a5fa"
      headerExtra={
        <button onClick={onScan} disabled={loading}
          className="text-[10px] font-mono px-2 py-1 rounded-lg disabled:opacity-40 hover:opacity-80 shrink-0"
          style={{ background: 'rgba(96,165,250,0.1)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.2)' }}>
          {loading ? '⟳' : 'Scan'}
        </button>
      }
    >
      {signals.length > 0 ? (
        <div className="divide-y max-h-96 overflow-y-auto" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
          {signals.slice(0, 8).map(s => (
            <div key={s.id} className="px-4 py-2.5">
              <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase"
                  style={{
                    background: s.urgency === 'high' ? 'rgba(248,113,113,0.15)' : 'rgba(96,165,250,0.10)',
                    color: s.urgency === 'high' ? '#f87171' : '#60a5fa',
                  }}>
                  {s.urgency || 'low'}
                </span>
                {s.impact && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded font-mono"
                    style={{ background: `${impactColor(s.impact)}15`, color: impactColor(s.impact) }}>
                    {s.impact}
                  </span>
                )}
                <span className="text-[10px] font-semibold text-white/65 truncate">{s.source}</span>
                {s.posted_at && (
                  <span className="text-[9px] text-white/25 ml-auto">
                    {new Date(s.posted_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-white/65 leading-relaxed line-clamp-2 mb-1">{s.headline}</p>
              {(s.tickers && s.tickers.length > 0) && (
                <div className="flex items-center gap-1 flex-wrap">
                  {s.tickers.slice(0, 4).map(t => (
                    <button key={t} onClick={() => onAnalyze(t)}
                      className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded hover:opacity-80"
                      style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="px-4 py-5 text-center">
          <p className="text-xs text-white/25">No signals yet</p>
          <p className="text-[10px] text-white/15 mt-1">Hit Scan to check for fresh posts</p>
        </div>
      )}
    </SidePanel>
  )
}

// ── Main Page ───────────────────────────────────────────────────────

export default function ActiveStoriesPage() {
  const router = useRouter()

  const [session, setSession] = useState<SessionAnchor>('today')
  const [data, setData] = useState<ActiveStoriesPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Sidebar panel state
  const [macroThemes, setMacroThemes] = useState<MacroTheme[]>([])
  const [monitorAlerts, setMonitorAlerts] = useState<MonitorAlert[]>([])
  const [newAlertCount, setNewAlertCount] = useState(0)
  const [monitorRunning, setMonitorRunning] = useState(false)
  const [socialSignals, setSocialSignals] = useState<SocialSignal[]>([])
  const [socialLoading, setSocialLoading] = useState(false)

  // ─── Active Stories load
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

  // ─── Macro themes
  useEffect(() => {
    fetch('/api/macro-intelligence')
      .then(r => r.json())
      .then(d => setMacroThemes(d.themes || []))
      .catch(() => {})
  }, [])

  // ─── Monitor alerts (auto-poll every 3 min)
  const loadMonitorAlerts = useCallback(async () => {
    try {
      const d = await fetch('/api/monitor').then(r => r.json())
      const alerts = d.alerts || []
      setMonitorAlerts(alerts)
      setNewAlertCount(alerts.filter((a: MonitorAlert) => !a.acknowledged).length)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    loadMonitorAlerts()
    const interval = setInterval(async () => {
      try {
        await fetch('/api/monitor', { method: 'POST' })
        await loadMonitorAlerts()
      } catch { /* ignore */ }
    }, 3 * 60 * 1000)
    return () => clearInterval(interval)
  }, [loadMonitorAlerts])

  const runMonitor = async () => {
    setMonitorRunning(true)
    try {
      await fetch('/api/monitor', { method: 'POST' })
      await loadMonitorAlerts()
    } finally {
      setMonitorRunning(false)
    }
  }

  const acknowledgeAlert = async (id: string) => {
    try {
      await fetch('/api/monitor', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      })
      setMonitorAlerts(prev => prev.map(a => a.id === id ? { ...a, acknowledged: true } : a))
      setNewAlertCount(prev => Math.max(0, prev - 1))
    } catch { /* ignore */ }
  }

  // ─── Social signals
  useEffect(() => {
    fetch('/api/social-signals')
      .then(r => r.json())
      .then(d => setSocialSignals(d.signals || []))
      .catch(() => {})
  }, [])

  const scanSocial = async () => {
    setSocialLoading(true)
    try {
      await fetch('/api/social-signals', { method: 'POST' })
      const d = await fetch('/api/social-signals').then(r => r.json())
      setSocialSignals(d.signals || [])
    } finally {
      setSocialLoading(false)
    }
  }

  // ─── Auth + nav
  const handleAnalyze = (ticker: string) => router.push(`/?ticker=${ticker}`)

  const handleSignOut = async () => {
    try { await fetch('/api/auth/session', { method: 'DELETE' }) } catch { /* ignore */ }
    try {
      Object.keys(localStorage).filter(k => k.startsWith('sb-')).forEach(k => localStorage.removeItem(k))
      document.cookie.split(';').forEach(c => {
        const name = c.split('=')[0].trim()
        if (name.startsWith('sb-') || name === 'wali_device_id') {
          document.cookie = name + '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
        }
      })
    } catch { /* ignore */ }
    window.location.replace('/login')
  }

  // ─── Group stories by timeframe
  const storiesByTimeframe = useMemo(() => {
    const groups: Record<Timeframe, TrackedStory[]> = { '1D': [], '1W': [], '1M': [], '3M': [] }
    if (!data?.stories) return groups
    for (const s of data.stories) {
      for (const tf of s.timeframes) {
        if (tf in groups) groups[tf].push(s)
      }
    }
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

      {/* ── Two-column layout: main + right sidebar ──────────────── */}
      <div className="flex-1 max-w-7xl mx-auto w-full px-3 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-5">

          {/* ── Main column ─────────────────────────────────────── */}
          <main className="space-y-5 min-w-0">

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

                <div className="flex items-center gap-3 mt-3 pt-3 border-t flex-wrap" style={{ borderColor: 'var(--border)' }}>
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
              if (stories.length === 0) return null
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

            {/* Empty state */}
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
          </main>

          {/* ── Right sidebar ─────────────────────────────────────── */}
          <aside className="space-y-4 lg:sticky lg:top-[68px] lg:self-start lg:max-h-[calc(100vh-80px)] lg:overflow-y-auto">

            {/* Macro themes */}
            <MacroPanel themes={macroThemes} />

            {/* Live monitor */}
            <MonitorPanel
              alerts={monitorAlerts}
              newAlertCount={newAlertCount}
              monitorRunning={monitorRunning}
              onScan={runMonitor}
              onAcknowledge={acknowledgeAlert}
              onAnalyze={handleAnalyze}
            />

            {/* Social signals */}
            <SocialPanel
              signals={socialSignals}
              loading={socialLoading}
              onScan={scanSocial}
              onAnalyze={handleAnalyze}
            />

            {/* Movers Hit Rate Widget */}
            <SidePanel icon={<BarChart3 size={12} />} title="Tracking Accuracy" accentColor="#34d399">
              <div className="px-2 py-2">
                <MoversHitRateWidget source="today" />
              </div>
            </SidePanel>

          </aside>
        </div>

        {/* Footer */}
        <div className="pt-8 pb-6 text-center">
          <p className="text-[10px] text-white/20 font-mono leading-relaxed">
            Stories tracked across cron runs · LLM-driven decay with time caps · Powered by Wali-OS
            <br />
            AI-generated analysis based on news headlines. Not financial advice.
          </p>
        </div>
      </div>
    </div>
  )
}
