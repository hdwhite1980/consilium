'use client'

import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, RefreshCw, Calendar, Clock, TrendingUp, TrendingDown, AlertTriangle,
  BookOpen, Zap, Eye, BarChart3, Factory, Newspaper, Globe, Search, ShieldCheck,
  ChevronDown, ChevronUp, Activity, Target,
} from 'lucide-react'
import { createClient } from '@/app/lib/auth/client'
import { MoversHitRateWidget } from '@/app/components/MoversHitRateWidget'

// ─────────────────────────────────────────────────────────────
// Types (unchanged from previous version)
// ─────────────────────────────────────────────────────────────
interface WatchlistItem {
  ticker: string
  companyName: string
  type: string
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  catalyst: string
  setupType: string
  magnitude: 'high' | 'medium' | 'low'
  keyLevel: string
  planBull: string
  planBear: string
  timeOfDay: string
  riskLevel: 'high' | 'medium' | 'low'
  plainEnglish: string
  confidence?: number
  verified?: boolean
  verificationSources?: string[]
  verificationNote?: string
}

interface EarningsItem {
  ticker: string
  companyName: string
  reportTime: string
  expectedMove?: string
  analystExpectation?: string
  watchFor?: string
}

interface EconomicEvent {
  event: string
  time: string
  impact: 'high' | 'medium' | 'low'
  whatToWatch: string
}

interface SectorSetup {
  sector: string
  etf: string
  direction: 'bullish' | 'bearish' | 'mixed'
  reason: string
  topPlay: string
}

interface SectorTopMover {
  sector: string
  emoji: string
  topMovers: Array<{ ticker: string; price: number; changePct: number }>
}

interface WorldEvent {
  category: 'geopolitical' | 'central_bank' | 'macro_data' | 'corporate' | 'energy' | 'other'
  headline: string
  summary: string
  marketImpact: 'high' | 'medium' | 'low'
  affectedSectors?: string[]
  affectedTickers?: string[]
}

interface InternationalSnapshot {
  fetchedAt: string
  indices: Array<{ name: string; symbol: string; price: number; changePct: number }>
  forex: Array<{ name: string; symbol: string; price: number; changePct: number }>
  commodities: Array<{ name: string; symbol: string; price: number; changePct: number }>
  futures: Array<{ name: string; symbol: string; price: number; changePct: number }>
  sentiment: {
    indices: 'up' | 'down' | 'mixed' | 'unknown'
    forex: 'up' | 'down' | 'mixed' | 'unknown'
    commodities: 'up' | 'down' | 'mixed' | 'unknown'
    futures: 'up' | 'down' | 'mixed' | 'unknown'
  }
}

interface TomorrowData {
  nextTradingDay: string
  generatedAt: string
  marketOutlook: string
  keyTheme: string
  preMarketWatchlist: WatchlistItem[]
  earningsCalendar: EarningsItem[]
  economicEvents: EconomicEvent[]
  sectorSetups: SectorSetup[]
  sectorTopMovers?: SectorTopMover[]
  cryptoSetup: string
  openingBellPlaybook: string
  riskFactors: string[]
  cached?: boolean
  ageMinutes?: number
  regime?: {
    label: 'risk-on' | 'risk-off' | 'mixed'
    spyChangePct: number | null
    vixLevel: number | null
    context: string
  }
  forwardCounts?: {
    tomorrowEarnings: number
    afterHoursMovers: number
    economicEvents: number
  }
  newsCounts?: {
    alpaca: number
    finnhub: number
    geminiGrounded: number
    afterDedupe: number
  }
  elapsedMs?: number
  // Weekend-only
  worldEvents?: WorldEvent[]
  internationalSummary?: string
  internationalSnapshot?: InternationalSnapshot
  briefMode?: 'weekday' | 'weekend' | 'fri-after-close'
  internationalCounts?: { fetched: number }
}

const SIG_COLOR = { BULLISH: '#34d399', BEARISH: '#f87171', NEUTRAL: '#fbbf24' }
const RISK_COLOR = { high: '#f87171', medium: '#fbbf24', low: '#34d399' }
const IMPACT_COLOR = { high: '#f87171', medium: '#fbbf24', low: '#94a3b8' }
const REGIME_COLOR = { 'risk-on': '#34d399', 'risk-off': '#f87171', 'mixed': '#fbbf24' }

function setupIcon(setupType: string, color: string) {
  const props = { size: 16, style: { color, flexShrink: 0 } }
  switch (setupType) {
    case 'earnings':           return <BarChart3 {...props} />
    case 'technical_breakout': return <TrendingUp {...props} />
    case 'news_continuation':  return <Newspaper {...props} />
    case 'sector_play':        return <Factory {...props} />
    case 'macro_event':        return <Globe {...props} />
    case 'catalyst':           return <Zap {...props} />
    default:                   return <Search {...props} />
  }
}

// ─────────────────────────────────────────────────────────────
// Defensive number formatters - return em-dash on undefined/null
// API responses occasionally have missing fields (Yahoo timeouts,
// etc.). These prevent the whole page from crashing on a single
// missing value.
// ─────────────────────────────────────────────────────────────
function fmtPct(n: number | null | undefined, digits = 2): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(digits)}%`
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  return n.toFixed(digits)
}

function pctColor(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '#94a3b8'
  return n >= 0 ? '#34d399' : '#f87171'
}

// ─────────────────────────────────────────────────────────────
// Reusable: Section component
// Unifies the visual language of every section (consistent header,
// border, padding, optional collapse toggle on mobile).
// On mobile (below md), collapsible sections are collapsed by default.
// On desktop (md+), they are always expanded.
// ─────────────────────────────────────────────────────────────
function Section({
  title, icon, accent, count, mobileCollapsible, defaultOpen, children, action,
}: {
  title: string
  icon?: ReactNode
  accent?: string
  count?: number
  mobileCollapsible?: boolean
  defaultOpen?: boolean
  children: ReactNode
  action?: ReactNode
}) {
  // Track mobile state to decide if we render the collapse button
  const [isMobile, setIsMobile] = useState(false)
  const [open, setOpen] = useState(defaultOpen ?? false)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // On desktop or if not collapsible, always show content
  const shouldCollapse = mobileCollapsible && isMobile
  const showContent = !shouldCollapse || open

  return (
    <section className="rounded-2xl border overflow-hidden"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <header
        className={`flex items-center justify-between px-5 py-3 border-b ${shouldCollapse ? 'cursor-pointer select-none' : ''}`}
        style={{ borderColor: 'var(--border)' }}
        onClick={() => { if (shouldCollapse) setOpen(!open) }}
      >
        <div className="flex items-center gap-2 min-w-0">
          {icon}
          <span className="text-base font-bold" style={{ color: accent ?? 'var(--text)' }}>
            {title}
          </span>
          {typeof count === 'number' && count > 0 && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-full"
              style={{
                background: accent ? `${accent}1a` : 'var(--surface2)',
                color: accent ?? 'var(--text3)',
                border: `1px solid ${accent ? `${accent}33` : 'var(--border)'}`,
              }}>
              {count}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {action}
          {shouldCollapse && (open ? <ChevronUp size={16} className="opacity-60" /> : <ChevronDown size={16} className="opacity-60" />)}
        </div>
      </header>
      {showContent && <div>{children}</div>}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────
// Hero tile - one of three always-visible tiles at top of page
// ─────────────────────────────────────────────────────────────
function HeroTile({
  label, accent, children,
}: {
  label: string
  accent: string
  children: ReactNode
}) {
  return (
    <div className="rounded-2xl border p-4 flex flex-col"
      style={{
        background: `linear-gradient(135deg, ${accent}10, ${accent}04)`,
        borderColor: `${accent}33`,
      }}>
      <div className="text-[11px] font-mono uppercase tracking-widest mb-2"
        style={{ color: accent }}>
        {label}
      </div>
      <div className="flex-1 flex flex-col justify-center">
        {children}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// WatchCard - redesigned with cleaner collapsed state
// Collapsed state shows ONLY: ticker, signal+confidence, one-line catalyst.
// Risk/magnitude/time are moved to the expanded view.
// ─────────────────────────────────────────────────────────────
function WatchCard({ item, onAnalyze, defaultExpanded }: { item: WatchlistItem; onAnalyze: (t: string) => void; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false)
  const color = SIG_COLOR[item.signal]

  return (
    <div className="rounded-xl border transition-all"
      style={{ background: `${color}06`, borderColor: `${color}1f` }}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {setupIcon(item.setupType, color)}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono font-bold text-base px-2 py-0.5 rounded-md"
                  style={{ background: `${color}1a`, color }}>
                  {item.ticker}
                </span>
                <span className="text-sm" style={{ color: 'var(--text2)' }}>
                  {item.companyName}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {typeof item.confidence === 'number' && (
              <span className="text-xs font-mono font-semibold px-2.5 py-1 rounded-full"
                style={{
                  background: item.confidence >= 80 ? 'rgba(52,211,153,0.15)'
                    : item.confidence >= 70 ? 'rgba(251,191,36,0.15)'
                    : 'rgba(148,163,184,0.12)',
                  color: item.confidence >= 80 ? '#34d399'
                    : item.confidence >= 70 ? '#fbbf24'
                    : '#94a3b8',
                  border: `1px solid ${item.confidence >= 80 ? 'rgba(52,211,153,0.3)' : item.confidence >= 70 ? 'rgba(251,191,36,0.3)' : 'rgba(148,163,184,0.2)'}`,
                }}
                title={`Model confidence: ${item.confidence}%`}>
                {item.confidence}%
              </span>
            )}
            <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-full inline-flex items-center gap-1"
              style={{ background: `${color}1a`, color, border: `1px solid ${color}33` }}>
              {item.signal === 'BULLISH' ? <TrendingUp size={11} /> : item.signal === 'BEARISH' ? <TrendingDown size={11} /> : null}
              {item.signal}
            </span>
            <span className="opacity-40 text-sm" aria-hidden="true">{expanded ? '▲' : '▼'}</span>
          </div>
        </div>
        <p className="text-sm leading-relaxed mt-2.5" style={{ color: 'var(--text2)' }}>
          {item.catalyst}
        </p>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t" style={{ borderColor: `${color}1a` }}>
          {/* Verified + secondary metadata row */}
          <div className="pt-3 flex items-center gap-2 flex-wrap">
            {item.verified === true && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono font-semibold"
                style={{ background: 'rgba(96,165,250,0.12)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.25)' }}
                title={item.verificationNote || 'Verified against Reuters/Bloomberg/WSJ'}>
                <ShieldCheck size={11} />
                <span>verified</span>
              </span>
            )}
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-full"
              style={{ background: 'var(--surface2)', color: 'var(--text3)' }}>
              {item.timeOfDay.replace('-', ' ')}
            </span>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-full"
              style={{ background: 'var(--surface2)', color: RISK_COLOR[item.riskLevel] }}>
              {item.riskLevel} risk
            </span>
            {item.magnitude === 'high' && (
              <span className="text-[11px] font-mono px-2 py-0.5 rounded-full"
                style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171' }}>
                Big move expected
              </span>
            )}
          </div>

          <div>
            <div className="text-[11px] font-mono uppercase tracking-widest mb-1.5" style={{ color }}>
              What this means
            </div>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text2)' }}>
              {item.plainEnglish}
            </p>
          </div>

          {item.keyLevel && (
            <div className="rounded-lg p-3"
              style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)' }}>
              <div className="text-[11px] font-mono uppercase tracking-widest mb-1" style={{ color: '#fbbf24' }}>
                Key level to watch
              </div>
              <p className="text-sm" style={{ color: 'var(--text2)' }}>{item.keyLevel}</p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="rounded-lg p-3"
              style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)' }}>
              <div className="text-[11px] font-mono uppercase tracking-widest mb-1" style={{ color: '#34d399' }}>
                If bullish
              </div>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text2)' }}>{item.planBull}</p>
            </div>
            <div className="rounded-lg p-3"
              style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)' }}>
              <div className="text-[11px] font-mono uppercase tracking-widest mb-1" style={{ color: '#f87171' }}>
                If bearish
              </div>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--text2)' }}>{item.planBear}</p>
            </div>
          </div>

          <button onClick={(e) => { e.stopPropagation(); onAnalyze(item.ticker) }}
            className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90"
            style={{ background: `${color}1f`, color, border: `1px solid ${color}40` }}>
            Run full AI analysis on {item.ticker} →
          </button>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────
export default function TomorrowPage() {
  const router = useRouter()
  const [data, setData] = useState<TomorrowData | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('Preparing tomorrow\'s playbook...')
  const [error, setError] = useState<string | null>(null)

  // Pre-Market Brief state (from /api/market-digest)
  const [premarket, setPremarket] = useState<{
    brief_date?: string; headline?: string; sentiment_score?: number; sentiment_label?: string;
    open_direction?: string; expected_move?: number; top_catalysts?: string[];
    sectors_bullish?: string[]; sectors_bearish?: string[]; tickers_to_watch?: string[];
    brief_text?: string;
  } | null>(null)
  const [briefExpanded, setBriefExpanded] = useState(false)
  const [briefLoading, setBriefLoading] = useState(false)

  // Social & Political Signals state (from /api/social-signals)
  const [socialSignals, setSocialSignals] = useState<Array<{
    id: string; person_label: string; headline: string; analysis?: string;
    action_signal?: string; market_impact?: 'bullish' | 'bearish' | 'neutral';
    impact_magnitude?: string; affected_tickers?: string[]; detected_at: string;
  }>>([])
  const [socialLoading, setSocialLoading] = useState(false)

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    setError(null)
    setData(null)

    try {
      const res = await fetch(`/api/tomorrow${refresh ? '?refresh=true' : ''}`)
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n'); buf = parts.pop() || ''
        for (const part of parts) {
          const ev = part.split('\n').find(l => l.startsWith('event:'))?.replace('event:', '').trim()
          const d = (() => { try { return JSON.parse(part.split('\n').find(l => l.startsWith('data:'))?.replace('data:', '').trim() || '{}') } catch { return {} } })()
          if (ev === 'status') setStatus(d.message)
          if (ev === 'complete') { setData(d as TomorrowData); setLoading(false) }
          if (ev === 'error') { setError(d.message); setLoading(false) }
        }
      }
    } catch (e) {
      setError((e as Error).message)
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Pull latest pre-market brief on mount
  useEffect(() => {
    fetch('/api/market-digest')
      .then(r => r.json())
      .then(d => { if (d.brief) setPremarket(d.brief) })
      .catch(() => {})
  }, [])

  // Pull cached social signals on mount
  useEffect(() => {
    fetch('/api/social-signals')
      .then(r => r.json())
      .then(d => setSocialSignals(d.signals || []))
      .catch(() => {})
  }, [])

  const runPreMarketBrief = async () => {
    setBriefLoading(true)
    try {
      await fetch('/api/market-digest?type=premarket', { method: 'POST' })
      const d = await fetch('/api/market-digest').then(r => r.json())
      if (d.brief) setPremarket(d.brief)
    } finally { setBriefLoading(false) }
  }

  const scanSocial = async () => {
    setSocialLoading(true)
    try {
      await fetch('/api/social-signals', { method: 'POST' })
      const d = await fetch('/api/social-signals').then(r => r.json())
      setSocialSignals(d.signals || [])
    } finally { setSocialLoading(false) }
  }

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

  const handleAnalyze = (ticker: string) => router.push(`/?ticker=${ticker}`)

  // Derived: top conviction watchlist item (highest confidence)
  const topConviction = data?.preMarketWatchlist?.length
    ? [...data.preMarketWatchlist].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]
    : null

  // Derived: top economic event (highest impact, earliest)
  const topEvent = data?.economicEvents?.length
    ? [...data.economicEvents].sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 }
        return (order[a.impact] ?? 3) - (order[b.impact] ?? 3)
      })[0]
    : null

  // Derived: weekend mode flag
  const isWeekendMode = data?.briefMode === 'weekend' || data?.briefMode === 'fri-after-close'

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>

      {/* Header */}
      <header className="flex flex-wrap items-center gap-2 px-3 py-3 border-b sticky top-0 z-10"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <button onClick={() => router.push('/')}
          className="flex items-center gap-1.5 text-xs hover:opacity-100 transition-opacity"
          style={{ color: 'var(--text3)' }}>
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        {/* Today | Tomorrow tab pair */}
        <div className="flex items-center gap-1" role="tablist" aria-label="Brief">
          <button
            type="button"
            role="tab"
            aria-selected="false"
            onClick={() => router.push('/news')}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'transparent', color: 'var(--text3)', border: '1px solid var(--border)' }}>
            <Zap size={12} aria-hidden="true" />
            <span>Today</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected="true"
            className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg transition-all"
            style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)' }}>
            <Calendar size={12} aria-hidden="true" />
            <span>Tomorrow</span>
          </button>
        </div>
        <div className="w-px h-4 hidden sm:block" style={{ background: 'var(--border)' }} />
        <span className="text-xs font-semibold hidden sm:inline" style={{ color: 'var(--text2)' }}>
          {isWeekendMode ? 'Weekend Brief' : 'Tomorrow\u2019s Movers'}
        </span>
        <span className="text-[11px] font-mono hidden md:inline" style={{ color: 'var(--text3)' }}>
          {isWeekendMode ? 'Monday open playbook' : 'Next trading day playbook'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {data?.cached && !loading && (
            <span className="text-[11px] font-mono px-2.5 py-1 rounded-full"
              style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.25)' }}>
              <Clock size={10} aria-hidden="true" className="inline-block mr-1" />{data.ageMinutes}m ago
            </span>
          )}
          <button onClick={() => load(true)} disabled={loading}
            className="flex items-center gap-1.5 text-xs font-mono px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-40"
            style={{ background: 'var(--surface2)', color: 'var(--text3)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          <button onClick={handleSignOut}
            className="text-[11px] font-mono px-2.5 py-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
            Sign out
          </button>
        </div>
      </header>

      {/* Loading */}
      {loading && (
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="text-center max-w-md">
            <RefreshCw size={32} className="mx-auto mb-4 animate-spin" style={{ color: '#a78bfa' }} />
            <p className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>{status}</p>
            <p className="text-sm" style={{ color: 'var(--text3)' }}>This typically takes 20-40 seconds.</p>
          </div>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="text-center max-w-md">
            <AlertTriangle size={32} className="mx-auto mb-4" style={{ color: '#f87171' }} />
            <p className="text-base font-semibold mb-2" style={{ color: 'var(--text)' }}>Failed to load</p>
            <p className="text-sm mb-4" style={{ color: 'var(--text3)' }}>{error}</p>
            <button onClick={() => load(true)}
              className="text-sm font-semibold px-4 py-2 rounded-lg"
              style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)' }}>
              Try again
            </button>
          </div>
        </div>
      )}

      {data && !loading && (
        <div className="flex-1 overflow-y-auto">

          {/* Compact next-day banner */}
          <div className="px-4 py-3 border-b"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <div className="max-w-7xl mx-auto flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <Calendar size={14} style={{ color: '#a78bfa' }} />
                <span className="text-[11px] font-mono uppercase tracking-widest" style={{ color: '#a78bfa' }}>
                  {isWeekendMode ? 'Monday open' : 'Next trading day'}
                </span>
                <span className="text-sm font-bold" style={{ color: 'var(--text)' }}>
                  {data.nextTradingDay}
                </span>
              </div>
              {data.keyTheme && (
                <span className="text-[11px] font-mono px-2.5 py-1 rounded-full"
                  style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
                  {data.keyTheme}
                </span>
              )}
              {isWeekendMode && (
                <span className="text-[11px] font-mono px-2.5 py-1 rounded-full"
                  style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.25)' }}>
                  Weekend Brief
                </span>
              )}
            </div>
          </div>

          {/* Hero: Tomorrow at a glance */}
          <div className="px-4 sm:px-6 pt-5 pb-4">
            <div className="max-w-7xl mx-auto">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

                {/* Tile 1: Regime */}
                <HeroTile
                  label="Market regime"
                  accent={data.regime ? REGIME_COLOR[data.regime.label] : '#94a3b8'}>
                  {data.regime ? (
                    <>
                      <div className="text-2xl font-bold mb-1"
                        style={{ color: REGIME_COLOR[data.regime.label] }}>
                        {data.regime.label === 'risk-on' ? 'Risk-On' : data.regime.label === 'risk-off' ? 'Risk-Off' : 'Mixed'}
                      </div>
                      <div className="flex items-center gap-3 text-sm font-mono" style={{ color: 'var(--text2)' }}>
                        {typeof data.regime.spyChangePct === 'number' && (
                          <span>
                            <span style={{ color: 'var(--text3)' }}>SPY</span>{' '}
                            <span style={{ color: data.regime.spyChangePct >= 0 ? '#34d399' : '#f87171' }}>
                              {data.regime.spyChangePct >= 0 ? '+' : ''}{data.regime.spyChangePct.toFixed(2)}%
                            </span>
                          </span>
                        )}
                        {typeof data.regime.vixLevel === 'number' && (
                          <span>
                            <span style={{ color: 'var(--text3)' }}>VIX</span>{' '}
                            <span style={{ color: 'var(--text)' }}>{data.regime.vixLevel.toFixed(1)}</span>
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="text-sm" style={{ color: 'var(--text3)' }}>No regime data</div>
                  )}
                </HeroTile>

                {/* Tile 2: Top Conviction */}
                <HeroTile
                  label="Top conviction"
                  accent={topConviction ? SIG_COLOR[topConviction.signal] : '#94a3b8'}>
                  {topConviction ? (
                    <button
                      type="button"
                      onClick={() => handleAnalyze(topConviction.ticker)}
                      className="text-left flex flex-col h-full hover:opacity-90 transition-opacity">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="font-mono font-bold text-xl"
                          style={{ color: SIG_COLOR[topConviction.signal] }}>
                          {topConviction.ticker}
                        </span>
                        <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                          style={{
                            background: `${SIG_COLOR[topConviction.signal]}1a`,
                            color: SIG_COLOR[topConviction.signal],
                            border: `1px solid ${SIG_COLOR[topConviction.signal]}33`,
                          }}>
                          {topConviction.signal === 'BULLISH' ? <TrendingUp size={10} /> : topConviction.signal === 'BEARISH' ? <TrendingDown size={10} /> : null}
                          {topConviction.signal}
                        </span>
                        {typeof topConviction.confidence === 'number' && (
                          <span className="text-[11px] font-mono font-semibold"
                            style={{ color: 'var(--text2)' }}>
                            {topConviction.confidence}%
                          </span>
                        )}
                      </div>
                      <div className="text-xs leading-relaxed line-clamp-2" style={{ color: 'var(--text2)' }}>
                        {topConviction.catalyst}
                      </div>
                    </button>
                  ) : (
                    <div className="text-sm" style={{ color: 'var(--text3)' }}>No setups flagged</div>
                  )}
                </HeroTile>

                {/* Tile 3: weekend = International, weekday = Big Event */}
                {isWeekendMode && data.internationalSnapshot ? (
                  <HeroTile label="International" accent="#a78bfa">
                    <div className="space-y-1.5">
                      {(data.internationalSnapshot.indices ?? []).slice(0, 3).map(idx => (
                        <div key={idx.symbol} className="flex items-center justify-between gap-2 text-sm">
                          <span style={{ color: 'var(--text2)' }}>{idx.name}</span>
                          <span className="font-mono font-semibold" style={{ color: pctColor(idx.changePct) }}>
                            {fmtPct(idx.changePct)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </HeroTile>
                ) : (
                  <HeroTile
                    label={topEvent ? 'Big event' : 'Tomorrow'}
                    accent={topEvent ? IMPACT_COLOR[topEvent.impact] : '#94a3b8'}>
                    {topEvent ? (
                      <>
                        <div className="text-base font-bold mb-1 leading-tight" style={{ color: 'var(--text)' }}>
                          {topEvent.event}
                        </div>
                        <div className="flex items-center gap-2 text-xs font-mono mb-1.5" style={{ color: 'var(--text3)' }}>
                          <span>{topEvent.time}</span>
                          <span style={{ color: IMPACT_COLOR[topEvent.impact] }}>
                            {topEvent.impact} impact
                          </span>
                        </div>
                        <div className="text-xs leading-relaxed line-clamp-2" style={{ color: 'var(--text2)' }}>
                          {topEvent.whatToWatch}
                        </div>
                      </>
                    ) : data.earningsCalendar && data.earningsCalendar.length > 0 ? (
                      <>
                        <div className="text-base font-bold mb-1" style={{ color: 'var(--text)' }}>
                          {data.earningsCalendar.length} earnings tomorrow
                        </div>
                        <div className="text-sm" style={{ color: 'var(--text3)' }}>
                          {data.earningsCalendar.slice(0, 3).map(e => e.ticker).join(', ')}
                          {data.earningsCalendar.length > 3 && '...'}
                        </div>
                      </>
                    ) : (
                      <div className="text-sm" style={{ color: 'var(--text3)' }}>No major events scheduled</div>
                    )}
                  </HeroTile>
                )}

              </div>
            </div>
          </div>

          {/* Accuracy widget - small horizontal strip */}
          <div className="px-4 sm:px-6 pb-4">
            <div className="max-w-7xl mx-auto">
              <MoversHitRateWidget source="tomorrow" />
            </div>
          </div>

          {/* Two-column main content */}
          <div className="px-4 sm:px-6 pb-10">
            <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-5">

              {/* LEFT COLUMN (lg: 2/3) - primary content */}
              <div className="lg:col-span-2 space-y-5">

                {/* Outlook */}
                <Section
                  title="Market Outlook"
                  icon={<Target size={16} style={{ color: '#60a5fa' }} />}
                  accent="#60a5fa">
                  <div className="px-5 py-4">
                    <p className="text-base leading-relaxed" style={{ color: 'var(--text2)' }}>
                      {data.marketOutlook}
                    </p>
                    {isWeekendMode && data.internationalSummary && (
                      <p className="text-sm leading-relaxed mt-3 pt-3 border-t" style={{ color: 'var(--text3)', borderColor: 'var(--border)' }}>
                        <span className="text-[11px] font-mono uppercase tracking-widest mr-2" style={{ color: '#a78bfa' }}>
                          International
                        </span>
                        {data.internationalSummary}
                      </p>
                    )}
                  </div>
                </Section>

                {/* Watchlist */}
                {data.preMarketWatchlist?.length > 0 && (
                  <Section
                    title="Pre-Market Watchlist"
                    icon={<Eye size={16} style={{ color: '#a78bfa' }} />}
                    accent="#a78bfa"
                    count={data.preMarketWatchlist.length}>
                    <div className="px-5 py-4 space-y-3">
                      {data.preMarketWatchlist.map(item => (
                        <WatchCard key={item.ticker} item={item} onAnalyze={handleAnalyze} />
                      ))}
                    </div>
                  </Section>
                )}

                {/* Opening Bell Playbook */}
                {data.openingBellPlaybook && (
                  <Section
                    title="Opening Bell Playbook"
                    icon={<BookOpen size={16} style={{ color: '#a78bfa' }} />}
                    accent="#a78bfa">
                    <div className="px-5 py-4">
                      <p className="text-base leading-relaxed" style={{ color: 'var(--text2)' }}>
                        {data.openingBellPlaybook}
                      </p>
                    </div>
                  </Section>
                )}

                {/* World Events (weekend only) */}
                {isWeekendMode && data.worldEvents && data.worldEvents.length > 0 && (
                  <Section
                    title="World Events"
                    icon={<Newspaper size={16} style={{ color: '#fbbf24' }} />}
                    accent="#fbbf24"
                    count={data.worldEvents.length}>
                    <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                      {data.worldEvents.map((ev, i) => {
                        const impactColor = IMPACT_COLOR[ev.marketImpact] ?? '#94a3b8'
                        const categoryLabel: Record<string, string> = {
                          geopolitical: 'Geopolitical',
                          central_bank: 'Central Bank',
                          macro_data: 'Macro Data',
                          corporate: 'Corporate',
                          energy: 'Energy',
                          other: 'Other',
                        }
                        return (
                          <div key={i} className="px-5 py-4">
                            <div className="flex items-start gap-3">
                              <div className="w-1 self-stretch rounded-full shrink-0" style={{ background: impactColor }} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap mb-1">
                                  <span className="text-[11px] font-mono uppercase tracking-widest" style={{ color: impactColor }}>
                                    {categoryLabel[ev.category] ?? ev.category}
                                  </span>
                                  <span className="text-[11px] font-mono uppercase tracking-widest" style={{ color: 'var(--text3)' }}>
                                    {ev.marketImpact} impact
                                  </span>
                                  {ev.affectedTickers && ev.affectedTickers.length > 0 && (
                                    <div className="flex gap-1 flex-wrap">
                                      {ev.affectedTickers.slice(0, 4).map(t => (
                                        <button key={t} onClick={() => handleAnalyze(t)}
                                          className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded hover:opacity-80"
                                          style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa' }}>
                                          {t}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <div className="text-base font-semibold mb-1" style={{ color: 'var(--text)' }}>
                                  {ev.headline}
                                </div>
                                <div className="text-sm leading-relaxed" style={{ color: 'var(--text2)' }}>
                                  {ev.summary}
                                </div>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </Section>
                )}

              </div>

              {/* RIGHT COLUMN (lg: 1/3) - supporting content (collapsible on mobile) */}
              <div className="space-y-5">

                {/* Pre-Market Brief */}
                <Section
                  title="Pre-Market Brief"
                  icon={<Calendar size={16} style={{ color: '#60a5fa' }} />}
                  accent="#60a5fa"
                  mobileCollapsible
                  defaultOpen={false}
                  action={
                    <button onClick={(e) => { e.stopPropagation(); runPreMarketBrief() }} disabled={briefLoading}
                      className="text-[11px] font-mono px-2.5 py-1 rounded-lg disabled:opacity-40 hover:opacity-80"
                      style={{ background: 'rgba(96,165,250,0.1)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.2)' }}>
                      {briefLoading ? '...' : 'Refresh'}
                    </button>
                  }>
                  {premarket ? (
                    <div className="px-5 py-4">
                      {premarket.headline && (
                        <p className="text-sm font-semibold mb-3" style={{ color: 'var(--text)' }}>
                          {premarket.headline}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mb-3 flex-wrap">
                        {typeof premarket.sentiment_score === 'number' && (
                          <span className="text-[11px] px-2 py-0.5 rounded-full font-mono font-bold"
                            style={{
                              background: premarket.sentiment_score > 20 ? 'rgba(52,211,153,0.12)' : premarket.sentiment_score < -20 ? 'rgba(248,113,113,0.12)' : 'rgba(251,191,36,0.12)',
                              color: premarket.sentiment_score > 20 ? '#34d399' : premarket.sentiment_score < -20 ? '#f87171' : '#fbbf24',
                            }}>
                            {premarket.sentiment_label?.replace('_', ' ')} {premarket.sentiment_score > 0 ? '+' : ''}{premarket.sentiment_score}
                          </span>
                        )}
                        {premarket.open_direction && (
                          <span className="text-[11px] font-mono px-2 py-0.5 rounded-full"
                            style={{ background: 'var(--surface2)', color: 'var(--text3)' }}>
                            {premarket.open_direction.replace('_', ' ')}{premarket.expected_move ? ` +/- ${premarket.expected_move}%` : ''}
                          </span>
                        )}
                      </div>
                      {premarket.tickers_to_watch && premarket.tickers_to_watch.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-3">
                          {premarket.tickers_to_watch.map(t => (
                            <button key={t} onClick={() => handleAnalyze(t)}
                              className="text-xs font-mono font-bold px-2.5 py-1 rounded-lg hover:opacity-80"
                              style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
                              {t}
                            </button>
                          ))}
                        </div>
                      )}
                      {(premarket.sectors_bullish?.length || premarket.sectors_bearish?.length) ? (
                        <div className="grid grid-cols-2 gap-3 mb-3">
                          {premarket.sectors_bullish && premarket.sectors_bullish.length > 0 && (
                            <div>
                              <p className="text-[11px] font-mono mb-1" style={{ color: 'var(--text3)' }}>BULLISH</p>
                              <div className="flex flex-wrap gap-1">
                                {premarket.sectors_bullish.map(s => (
                                  <span key={s} className="text-[11px] px-1.5 py-0.5 rounded font-mono"
                                    style={{ background: 'rgba(52,211,153,0.1)', color: '#34d399' }}>{s}</span>
                                ))}
                              </div>
                            </div>
                          )}
                          {premarket.sectors_bearish && premarket.sectors_bearish.length > 0 && (
                            <div>
                              <p className="text-[11px] font-mono mb-1" style={{ color: 'var(--text3)' }}>BEARISH</p>
                              <div className="flex flex-wrap gap-1">
                                {premarket.sectors_bearish.map(s => (
                                  <span key={s} className="text-[11px] px-1.5 py-0.5 rounded font-mono"
                                    style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171' }}>{s}</span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ) : null}
                      {premarket.brief_text && (
                        <>
                          <button onClick={() => setBriefExpanded(!briefExpanded)}
                            className="text-[11px] font-mono transition-opacity hover:opacity-80"
                            style={{ color: 'var(--text3)' }}>
                            {briefExpanded ? 'collapse' : 'read full brief'}
                          </button>
                          {briefExpanded && (
                            <div className="mt-2 text-xs leading-relaxed whitespace-pre-wrap border-t pt-3 max-h-96 overflow-y-auto"
                              style={{ borderColor: 'var(--border)', color: 'var(--text2)' }}>
                              {premarket.brief_text.replace(/<json>[\s\S]*?<\/json>/gi, '').trim()}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="px-5 py-6 text-center">
                      <p className="text-sm mb-1" style={{ color: 'var(--text3)' }}>No pre-market brief yet</p>
                      <p className="text-xs" style={{ color: 'var(--text3)' }}>Tap Refresh to generate one</p>
                    </div>
                  )}
                </Section>

                {/* Earnings Calendar */}
                {data.earningsCalendar?.length > 0 && (
                  <Section
                    title="Earnings"
                    icon={<BarChart3 size={16} style={{ color: '#fbbf24' }} />}
                    accent="#fbbf24"
                    count={data.earningsCalendar.length}
                    mobileCollapsible>
                    <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                      {data.earningsCalendar.map((e, i) => (
                        <div key={i} className="px-5 py-3">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <button onClick={() => handleAnalyze(e.ticker)}
                              className="text-sm font-mono font-bold px-2 py-0.5 rounded hover:opacity-80"
                              style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24' }}>
                              {e.ticker}
                            </button>
                            <span className="text-xs" style={{ color: 'var(--text2)' }}>{e.companyName}</span>
                          </div>
                          <div className="flex items-center gap-2 text-[11px] font-mono mb-1" style={{ color: 'var(--text3)' }}>
                            <span>{e.reportTime}</span>
                            {e.expectedMove && <span>· {e.expectedMove}</span>}
                          </div>
                          {e.watchFor && (
                            <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>{e.watchFor}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </Section>
                )}

                {/* Economic Events */}
                {data.economicEvents?.length > 0 && (
                  <Section
                    title="Economic Events"
                    icon={<Activity size={16} style={{ color: '#60a5fa' }} />}
                    accent="#60a5fa"
                    count={data.economicEvents.length}
                    mobileCollapsible>
                    <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                      {data.economicEvents.map((e, i) => (
                        <div key={i} className="px-5 py-3">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: IMPACT_COLOR[e.impact] }} />
                            <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{e.event}</span>
                            <span className="text-[11px] font-mono ml-auto" style={{ color: 'var(--text3)' }}>{e.time}</span>
                          </div>
                          {e.whatToWatch && (
                            <p className="text-xs leading-relaxed pl-4" style={{ color: 'var(--text2)' }}>{e.whatToWatch}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </Section>
                )}

                {/* Sector Setups */}
                {data.sectorSetups?.length > 0 && (
                  <Section
                    title="Sector Setups"
                    icon={<Factory size={16} style={{ color: 'var(--text2)' }} />}
                    count={data.sectorSetups.length}
                    mobileCollapsible>
                    <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                      {data.sectorSetups.map((s, i) => {
                        const dirColor = s.direction === 'bullish' ? '#34d399' : s.direction === 'bearish' ? '#f87171' : '#fbbf24'
                        return (
                          <div key={i} className="px-5 py-3">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{s.sector}</span>
                              <span className="text-[11px] font-mono px-1.5 py-0.5 rounded"
                                style={{ background: `${dirColor}1a`, color: dirColor }}>
                                {s.direction}
                              </span>
                              {s.etf && (
                                <button onClick={() => handleAnalyze(s.etf)}
                                  className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded hover:opacity-80"
                                  style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa' }}>
                                  {s.etf}
                                </button>
                              )}
                            </div>
                            <p className="text-xs leading-relaxed mb-1" style={{ color: 'var(--text2)' }}>{s.reason}</p>
                            {s.topPlay && (
                              <p className="text-[11px]" style={{ color: 'var(--text3)' }}>
                                Top play: <span style={{ color: 'var(--text2)' }}>{s.topPlay}</span>
                              </p>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </Section>
                )}

                {/* Live Top Movers (sub-section, only if available) */}
                {Array.isArray(data.sectorTopMovers) && data.sectorTopMovers.length > 0 && (
                  <Section
                    title="Live Top Movers"
                    icon={<TrendingUp size={16} style={{ color: 'var(--text2)' }} />}
                    mobileCollapsible>
                    <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                      {data.sectorTopMovers.map(s => (
                        <div key={s.sector} className="px-5 py-3">
                          <div className="text-[11px] font-mono uppercase tracking-widest mb-1.5" style={{ color: 'var(--text3)' }}>
                            {s.emoji} {s.sector}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {(s.topMovers ?? []).slice(0, 5).map(m => {
                              const isPositive = typeof m.changePct === 'number' && m.changePct >= 0
                              return (
                                <button key={m.ticker} onClick={() => handleAnalyze(m.ticker)}
                                  className="text-[11px] font-mono px-1.5 py-0.5 rounded hover:opacity-80"
                                  style={{
                                    background: isPositive ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)',
                                    color: isPositive ? '#34d399' : '#f87171',
                                  }}>
                                  {m.ticker} {fmtPct(m.changePct, 1)}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </Section>
                )}

                {/* Social & Political Signals */}
                <Section
                  title="Social & Political"
                  icon={<Eye size={16} style={{ color: '#fbbf24' }} />}
                  accent="#fbbf24"
                  count={socialSignals.length}
                  mobileCollapsible
                  action={
                    <button onClick={(e) => { e.stopPropagation(); scanSocial() }} disabled={socialLoading}
                      className="text-[11px] font-mono px-2.5 py-1 rounded-lg disabled:opacity-40 hover:opacity-80"
                      style={{ background: 'rgba(251,191,36,0.1)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)' }}>
                      {socialLoading ? '...' : 'Scan'}
                    </button>
                  }>
                  {socialSignals.length > 0 ? (
                    <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                      {socialSignals.slice(0, 6).map(s => (
                        <div key={s.id} className="px-5 py-3">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="text-[11px] font-bold px-2 py-0.5 rounded-full"
                              style={{
                                background: s.market_impact === 'bullish' ? 'rgba(52,211,153,0.12)' : s.market_impact === 'bearish' ? 'rgba(248,113,113,0.12)' : 'rgba(251,191,36,0.1)',
                                color: s.market_impact === 'bullish' ? '#34d399' : s.market_impact === 'bearish' ? '#f87171' : '#fbbf24',
                              }}>
                              {s.impact_magnitude?.toUpperCase()} {s.market_impact?.toUpperCase()}
                            </span>
                            <span className="text-[11px] font-semibold" style={{ color: 'var(--text2)' }}>{s.person_label}</span>
                          </div>
                          {s.affected_tickers && s.affected_tickers.length > 0 && (
                            <div className="flex gap-1 flex-wrap mb-1">
                              {s.affected_tickers.slice(0, 4).map(t => (
                                <button key={t} onClick={() => handleAnalyze(t)}
                                  className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded hover:opacity-80"
                                  style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa' }}>
                                  {t}
                                </button>
                              ))}
                            </div>
                          )}
                          <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>{s.headline}</p>
                          {s.action_signal && (
                            <p className="text-[11px] mt-1 font-semibold" style={{ color: '#fbbf24' }}>→ {s.action_signal}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="px-5 py-5 text-center">
                      <p className="text-sm mb-1" style={{ color: 'var(--text3)' }}>No signals yet</p>
                      <p className="text-xs" style={{ color: 'var(--text3)' }}>Scan to detect statements affecting markets</p>
                    </div>
                  )}
                </Section>

                {/* Crypto */}
                {data.cryptoSetup && (
                  <Section
                    title="Crypto"
                    icon={<Globe size={16} style={{ color: '#fbbf24' }} />}
                    mobileCollapsible>
                    <div className="px-5 py-4">
                      <p className="text-sm leading-relaxed" style={{ color: 'var(--text2)' }}>{data.cryptoSetup}</p>
                    </div>
                  </Section>
                )}

                {/* Risk Factors */}
                {data.riskFactors?.length > 0 && (
                  <Section
                    title="Risk Factors"
                    icon={<AlertTriangle size={16} style={{ color: '#f87171' }} />}
                    accent="#f87171"
                    count={data.riskFactors.length}
                    mobileCollapsible>
                    <ul className="px-5 py-4 space-y-2">
                      {data.riskFactors.map((r, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm" style={{ color: 'var(--text2)' }}>
                          <span className="mt-1 w-1 h-1 rounded-full shrink-0" style={{ background: '#f87171' }} />
                          <span className="leading-relaxed">{r}</span>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}

                {/* International Markets full table (weekend only) */}
                {isWeekendMode && data.internationalSnapshot && (
                  <Section
                    title="International Markets"
                    icon={<Globe size={16} style={{ color: '#a78bfa' }} />}
                    accent="#a78bfa"
                    mobileCollapsible>
                    <div className="px-5 py-4 space-y-4">
                      {(data.internationalSnapshot.indices ?? []).length > 0 && (
                        <div>
                          <div className="text-[11px] font-mono uppercase tracking-widest mb-2" style={{ color: 'var(--text3)' }}>Indices</div>
                          <div className="space-y-1">
                            {(data.internationalSnapshot.indices ?? []).map(idx => (
                              <div key={idx.symbol} className="flex items-center justify-between text-sm">
                                <span style={{ color: 'var(--text2)' }}>{idx.name}</span>
                                <div className="flex items-center gap-2 font-mono">
                                  <span style={{ color: 'var(--text)' }}>{fmtNum(idx.price, 2)}</span>
                                  <span className="w-16 text-right" style={{ color: pctColor(idx.changePct) }}>{fmtPct(idx.changePct)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {(data.internationalSnapshot.forex ?? []).length > 0 && (
                        <div>
                          <div className="text-[11px] font-mono uppercase tracking-widest mb-2" style={{ color: 'var(--text3)' }}>Forex</div>
                          <div className="space-y-1">
                            {(data.internationalSnapshot.forex ?? []).map(fx => (
                              <div key={fx.symbol} className="flex items-center justify-between text-sm">
                                <span style={{ color: 'var(--text2)' }}>{fx.name}</span>
                                <div className="flex items-center gap-2 font-mono">
                                  <span style={{ color: 'var(--text)' }}>{fmtNum(fx.price, 4)}</span>
                                  <span className="w-16 text-right" style={{ color: pctColor(fx.changePct) }}>{fmtPct(fx.changePct)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {((data.internationalSnapshot.commodities ?? []).length + (data.internationalSnapshot.futures ?? []).length) > 0 && (
                        <div>
                          <div className="text-[11px] font-mono uppercase tracking-widest mb-2" style={{ color: 'var(--text3)' }}>
                            Futures &amp; Commodities
                          </div>
                          <div className="space-y-1">
                            {[...(data.internationalSnapshot.futures ?? []), ...(data.internationalSnapshot.commodities ?? [])].map(item => (
                              <div key={item.symbol} className="flex items-center justify-between text-sm">
                                <span style={{ color: 'var(--text2)' }}>{item.name}</span>
                                <div className="flex items-center gap-2 font-mono">
                                  <span style={{ color: 'var(--text)' }}>{fmtNum(item.price, 2)}</span>
                                  <span className="w-16 text-right" style={{ color: pctColor(item.changePct) }}>{fmtPct(item.changePct)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="text-[11px] font-mono pt-2 border-t" style={{ color: 'var(--text3)', borderColor: 'var(--border)' }}>
                        Data via Yahoo Finance.
                      </div>
                    </div>
                  </Section>
                )}

              </div>

            </div>
          </div>

          {/* Footer */}
          <footer className="px-4 py-4 border-t" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
            <div className="max-w-7xl mx-auto flex items-center justify-between gap-2 text-[11px] font-mono flex-wrap" style={{ color: 'var(--text3)' }}>
              <span>Generated {new Date(data.generatedAt).toLocaleString()}</span>
              {data.elapsedMs && <span>{(data.elapsedMs / 1000).toFixed(1)}s</span>}
            </div>
          </footer>
        </div>
      )}
    </div>
  )
}
