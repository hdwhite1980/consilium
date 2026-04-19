'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'
import { LogOut } from 'lucide-react'
import { TrendingUp, TrendingDown, RefreshCw, ArrowLeft, Eye, Zap, Globe } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────
interface NewsMover {
  ticker: string
  companyName: string
  type: 'stock' | 'crypto'
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  magnitude: 'high' | 'medium' | 'low'
  headline: string
  reason: string
  catalyst: string
  riskLevel: 'high' | 'medium' | 'low'
  timeframe: string
  relatedNews: string[]
}

interface SectorTopMover {
  sector: string; etf: string; emoji: string; direction: string; etfChange: number
  topMovers: Array<{ ticker: string; change: number; signal: 'up' | 'down' }>
}

interface NewsPageData {
  generatedAt: string
  marketStatus: string
  topBullish: NewsMover[]
  topBearish: NewsMover[]
  watchlist: NewsMover[]
  marketTheme: string
  sectorMovers: Array<{ sector: string; direction: string; reason: string }>
  sectorTopMovers?: SectorTopMover[]
  cryptoAlert: string | null
  summary: string
  cached?: boolean
  cachedAt?: string
  ageMinutes?: number
}

// ── Helpers ────────────────────────────────────────────────────
const MAG_COLOR = { high: '#f87171', medium: '#fbbf24', low: '#94a3b8' }
const MAG_LABEL = { high: 'Big move expected', medium: 'Moderate move', low: 'Small move' }
const RISK_COLOR = { high: '#f87171', medium: '#fbbf24', low: '#34d399' }

function MoverCard({ mover, onAnalyze }: { mover: NewsMover; onAnalyze: (ticker: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const isBull = mover.signal === 'BULLISH'
  const isNeutral = mover.signal === 'NEUTRAL'
  const accentColor = isBull ? '#34d399' : isNeutral ? '#fbbf24' : '#f87171'
  const bgColor = isBull ? 'rgba(52,211,153,0.04)' : isNeutral ? 'rgba(251,191,36,0.04)' : 'rgba(248,113,113,0.04)'
  const borderColor = isBull ? 'rgba(52,211,153,0.18)' : isNeutral ? 'rgba(251,191,36,0.18)' : 'rgba(248,113,113,0.18)'

  return (
    <div className="rounded-xl border transition-all duration-200"
      style={{ background: bgColor, borderColor }}>

      {/* Header */}
      <div className="p-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Ticker badge */}
            <div className="shrink-0 px-2.5 py-1 rounded-lg font-mono font-bold text-sm"
              style={{ background: `${accentColor}18`, color: accentColor, border: `1px solid ${accentColor}30` }}>
              {mover.ticker}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white/80 truncate">{mover.companyName}</div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] font-mono" style={{ color: MAG_COLOR[mover.magnitude] }}>
                  {MAG_LABEL[mover.magnitude]}
                </span>
                <span className="text-[10px] text-white/25">·</span>
                <span className="text-[10px] font-mono" style={{ color: RISK_COLOR[mover.riskLevel] }}>
                  {mover.riskLevel} risk
                </span>
                {mover.type === 'crypto' && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded font-mono"
                    style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>CRYPTO</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-mono font-semibold"
              style={{ background: `${accentColor}15`, color: accentColor, border: `1px solid ${accentColor}28` }}>
              {isBull ? <TrendingUp size={10} /> : isNeutral ? <Eye size={10} /> : <TrendingDown size={10} />}
              {mover.signal}
            </div>
            <span className="text-white/25 text-xs">{expanded ? '▲' : '▼'}</span>
          </div>
        </div>

        {/* Headline */}
        <p className="text-xs text-white/55 mt-2.5 leading-relaxed line-clamp-2">{mover.headline}</p>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t" style={{ borderColor: `${accentColor}15` }}>

          {/* What this means */}
          <div className="pt-3">
            <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: accentColor }}>
              What this means
            </div>
            <p className="text-sm text-white/75 leading-relaxed">{mover.reason}</p>
          </div>

          {/* Catalyst */}
          <div className="rounded-lg p-3" style={{ background: 'var(--surface2)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-1">Catalyst</div>
            <p className="text-xs text-white/65 leading-relaxed">{mover.catalyst}</p>
          </div>

          {/* Related news */}
          {mover.relatedNews?.length > 0 && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-1.5">Related</div>
              <div className="space-y-1">
                {mover.relatedNews.map((n, i) => (
                  <div key={i} className="text-[11px] text-white/40 flex gap-1.5">
                    <span className="shrink-0" style={{ color: `${accentColor}50` }}>•</span>{n}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Analyze button */}
          <button
            onClick={(e) => { e.stopPropagation(); onAnalyze(mover.ticker) }}
            className="w-full py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 active:scale-98"
            style={{ background: `${accentColor}20`, color: accentColor, border: `1px solid ${accentColor}35` }}>
            Run full AI analysis on {mover.ticker} →
          </button>
        </div>
      )}
    </div>
  )
}

function SectionHeader({ icon, label, count, color }: { icon: React.ReactNode; label: string; count: number; color: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span style={{ color }}>{icon}</span>
      <span className="text-sm font-semibold" style={{ color }}>{label}</span>
      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
        style={{ background: `${color}18`, color, border: `1px solid ${color}28` }}>
        {count}
      </span>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────
export default function NewsPage() {
  const router = useRouter()
  const [data, setData] = useState<NewsPageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [macroThemes, setMacroThemes] = useState<Array<{id:string;theme_name:string;theme_summary:string;playbook:string;sectors_to_watch:string[];tickers_to_watch:string[];urgency:string}>>([])
  const [digest, setDigest] = useState<any>(null)
  const [premarket, setPremarket] = useState<any>(null)
  const [digestLoading, setDigestLoading] = useState(false)
  const [digestExpanded, setDigestExpanded] = useState(false)
  const [socialSignals, setSocialSignals] = useState<any[]>([])
  const [socialLoading, setSocialLoading] = useState(false)
  const [monitorAlerts, setMonitorAlerts] = useState<any[]>([])
  const [monitorRunning, setMonitorRunning] = useState(false)
  const [lastMonitorRun, setLastMonitorRun] = useState<Date | null>(null)
  const [newAlertCount, setNewAlertCount] = useState(0)
  const [statusMsg, setStatusMsg] = useState('Loading today\'s market intelligence...')
  const [error, setError] = useState<string | null>(null)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [isCached, setIsCached]       = useState(false)
  const [cacheAge, setCacheAge]       = useState<number | null>(null)

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    setError(null)
    setData(null)
    setIsCached(false)
    setCacheAge(null)
    setStatusMsg('Scanning today\'s financial news...')

    try {
      const res = await fetch(`/api/news${refresh ? '?refresh=true' : ''}`)
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n'); buf = parts.pop() || ''

        for (const part of parts) {
          const ev   = part.split('\n').find(l => l.startsWith('event:'))?.replace('event:', '').trim()
          const d    = (() => { try { return JSON.parse(part.split('\n').find(l => l.startsWith('data:'))?.replace('data:', '').trim() || '{}') } catch { return {} } })()

          if (ev === 'status') setStatusMsg(d.message)
          if (ev === 'complete') {
            setData(d as NewsPageData)
            setGeneratedAt(d.cachedAt || d.generatedAt)
            setIsCached(d.cached === true)
            setCacheAge(typeof d.ageMinutes === 'number' ? d.ageMinutes : 0)
            setLoading(false)
          }
          if (ev === 'error') {
            setError(d.message)
            setLoading(false)
          }
        }
      }
    } catch (e) {
      setError((e as Error).message)
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetch('/api/macro-intelligence')
      .then(r => r.json())
      .then(d => setMacroThemes(d.themes || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch('/api/market-digest')
      .then(r => r.json())
      .then(d => { if (d.digest) setDigest(d.digest); if (d.brief) setPremarket(d.brief) })
      .catch(() => {})
  }, [])

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
    } finally { setSocialLoading(false) }
  }

  const loadMonitorAlerts = async () => {
    try {
      const d = await fetch('/api/monitor').then(r => r.json())
      const alerts = d.alerts || []
      setMonitorAlerts(alerts)
      setNewAlertCount(alerts.filter((a: any) => !a.acknowledged).length)
    } catch {}
  }

  const runMonitor = async () => {
    setMonitorRunning(true)
    try {
      await fetch('/api/monitor', { method: 'POST' })
      await loadMonitorAlerts()
      setLastMonitorRun(new Date())
    } finally { setMonitorRunning(false) }
  }

  const acknowledgeAlert = async (id: string) => {
    await fetch('/api/monitor', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    })
    setMonitorAlerts(prev => prev.map(a => a.id === id ? { ...a, acknowledged: true } : a))
    setNewAlertCount(prev => Math.max(0, prev - 1))
  }

  // Poll monitor alerts every 3 minutes while page is open
  useEffect(() => {
    loadMonitorAlerts()
    const interval = setInterval(async () => {
      // Auto-run monitor + refresh alerts
      try {
        await fetch('/api/monitor', { method: 'POST' })
        await loadMonitorAlerts()
        setLastMonitorRun(new Date())
      } catch {}
    }, 3 * 60 * 1000) // every 3 minutes
    return () => clearInterval(interval)
  }, [])

  const runDigest = async (type: 'digest' | 'premarket') => {
    setDigestLoading(true)
    try {
      await fetch(type === 'premarket' ? '/api/market-digest?type=premarket' : '/api/market-digest', { method: 'POST' })
      const d = await fetch('/api/market-digest').then(r => r.json())
      if (d.digest) setDigest(d.digest)
      if (d.brief) setPremarket(d.brief)
    } finally { setDigestLoading(false) }
  }

  useEffect(() => { load() }, [load])

  const handleSignOut = async () => {
    try { await (createClient()).auth.signOut({ scope: 'local' }) } catch {}
    try { await fetch('/api/auth/session', { method: 'DELETE' }) } catch {}
    window.location.href = '/login'
  }

  const handleAnalyze = (ticker: string) => {
    router.push(`/?ticker=${ticker}`)
  }

  const timeAgo = generatedAt
    ? Math.round((Date.now() - new Date(generatedAt).getTime()) / 60000)
    : null

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>

      {/* Header */}
      <header className="flex flex-wrap items-center gap-2 px-3 py-3 border-b sticky top-0 z-10"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <button onClick={() => router.push('/')}
          className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors">
          <ArrowLeft size={13} />
          Back
        </button>
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        <div className="flex items-center gap-2">
          <Zap size={14} style={{ color: '#fbbf24' }} />
          <span className="text-sm font-bold">Today&apos;s Movers</span>
        </div>
        <button onClick={() => router.push('/tomorrow')}
          className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg transition-all hover:opacity-80"
          style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
          📅 Tomorrow
        </button>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-white/25">AI-powered market intelligence</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {timeAgo !== null && !loading && (
            data?.cached
              ? (
                <span className="flex items-center gap-1.5 text-[10px] font-mono px-2.5 py-1 rounded-full"
                  style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.25)' }}>
                  ⏱ Cached today · {timeAgo}m ago
                </span>
              ) : (
                <span className="text-[10px] font-mono text-white/30">
                  Updated {timeAgo}m ago
                </span>
              )
          )}
          {isCached && !loading && (
            <span className="flex items-center gap-1.5 text-[10px] font-mono px-2.5 py-1 rounded-full"
              style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.25)' }}>
              ⏱ Cached · {cacheAge === 0 ? 'just now' : `${cacheAge}m ago`}
            </span>
          )}
          <button onClick={() => load(true)} disabled={loading}
            className="flex items-center gap-1.5 text-[11px] font-mono px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-40"
            style={{ background: 'var(--surface2)', color: 'var(--text3)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Loading...' : isCached ? '↻ Fresh run' : 'Refresh'}
          </button>
          <button onClick={handleSignOut}
            className="flex items-center gap-1 text-[10px] font-mono px-2.5 py-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
            <LogOut size={10} />
          </button>
        </div>
      </header>

      {/* Loading state */}
      {loading && (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 p-8">
          <div className="flex gap-1.5">
            {[0,1,2].map(i => (
              <span key={i} className="w-2 h-2 rounded-full thinking-dot"
                style={{ background: '#fbbf24', animationDelay: `${i * 0.15}s` }} />
            ))}
          </div>
          <p className="text-sm text-white/40 font-mono">{statusMsg}</p>
          <p className="text-xs text-white/20 text-center max-w-sm">
            The council is scanning today&apos;s news and identifying stocks and crypto that could move significantly
          </p>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 p-8">
          <div className="text-sm text-red-400 font-mono">⚠ {error}</div>
          <button onClick={() => load()} className="text-xs text-white/40 hover:text-white/60 underline">Try again</button>
        </div>
      )}

      {/* Content */}
      {data && !loading && (
        <div className="flex-1 overflow-y-auto">

          {/* Market summary banner */}
          <div className="px-5 py-4 border-b" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <div className="max-w-4xl mx-auto">
            {isCached && (
              <div className="flex items-center justify-between px-3 py-2 rounded-lg mb-3"
                style={{ background: 'rgba(251,191,36,0.07)', border: '1px solid rgba(251,191,36,0.15)' }}>
                <span className="text-[11px] text-white/50">
                  ⏱ Showing today&apos;s cached analysis — refreshes automatically each day
                </span>
                <button onClick={() => load(true)}
                  className="text-[10px] font-mono px-2.5 py-1 rounded-full transition-all hover:opacity-80"
                  style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}>
                  ↻ Force refresh
                </button>
              </div>
            )}
              <div className="flex items-start gap-3">
                <Globe size={16} className="shrink-0 mt-0.5" style={{ color: '#fbbf24' }} />
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: '#fbbf24' }}>
                      Market theme today
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)' }}>
                      {data.marketTheme}
                    </span>
                  </div>
                  <p className="text-sm text-white/70 leading-relaxed">{data.summary}</p>
                  <p className="text-xs text-white/40 mt-1">{data.marketStatus}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="max-w-4xl mx-auto px-3 sm:px-5 py-4 sm:py-6 space-y-6 sm:space-y-8">

            {/* Crypto alert */}
            {data.cryptoAlert && (
              <div className="flex items-start gap-3 p-4 rounded-xl"
                style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)' }}>
                <span style={{ color: '#fbbf24', fontSize: 16 }}>₿</span>
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: '#fbbf24' }}>Crypto alert</div>
                  <p className="text-sm text-white/70">{data.cryptoAlert}</p>
                </div>
              </div>
            )}

            {/* Two column layout for bull/bear */}
            <div className="grid grid-cols-1 gap-6">

              {/* Bullish */}
              <div>
                <SectionHeader
                  icon={<TrendingUp size={14} />}
                  label="Potential winners today"
                  count={data.topBullish.length}
                  color="#34d399"
                />
                <div className="space-y-3">
                  {data.topBullish.map(m => (
                    <MoverCard key={m.ticker} mover={m} onAnalyze={handleAnalyze} />
                  ))}
                </div>
              </div>

              {/* Bearish */}
              <div>
                <SectionHeader
                  icon={<TrendingDown size={14} />}
                  label="Potential losers today"
                  count={data.topBearish.length}
                  color="#f87171"
                />
                <div className="space-y-3">
                  {data.topBearish.map(m => (
                    <MoverCard key={m.ticker} mover={m} onAnalyze={handleAnalyze} />
                  ))}
                </div>
              </div>
            </div>

            {/* Watchlist */}
            {data.watchlist?.length > 0 && (
              <div>
                <SectionHeader
                  icon={<Eye size={14} />}
                  label="Worth watching today"
                  count={data.watchlist.length}
                  color="#fbbf24"
                />
                <div className="grid grid-cols-1 gap-3">
                  {data.watchlist.map(m => (
                    <MoverCard key={m.ticker} mover={m} onAnalyze={handleAnalyze} />
                  ))}
                </div>
              </div>
            )}

            {/* Live Market Monitor */}
            <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--nav-bg)', borderColor: monitorAlerts.some(a => !a.acknowledged && a.urgency === 'critical') ? 'rgba(248,113,113,0.4)' : monitorAlerts.some(a => !a.acknowledged && a.urgency === 'high') ? 'rgba(251,191,36,0.3)' : 'rgba(255,255,255,0.07)' }}>
              <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <span className="text-base">🔴</span>
                    {newAlertCount > 0 && (
                      <span className="absolute -top-1 -right-1 text-[9px] font-bold px-1 rounded-full" style={{ background: '#f87171', color: 'var(--text)', minWidth: '14px', textAlign: 'center' }}>
                        {newAlertCount}
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-bold">Live Monitor</span>
                  <span className="text-[9px] font-mono px-2 py-0.5 rounded-full" style={{ background: 'rgba(52,211,153,0.12)', color: '#34d399' }}>
                    auto-scan every 3min
                  </span>
                  {lastMonitorRun && (
                    <span className="text-[9px] text-white/25 font-mono">
                      last: {lastMonitorRun.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
                <button onClick={runMonitor} disabled={monitorRunning}
                  className="text-[10px] font-mono px-2.5 py-1.5 rounded-lg disabled:opacity-40 hover:opacity-80"
                  style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
                  {monitorRunning ? '⟳ Scanning...' : '⟳ Scan Now'}
                </button>
              </div>

              {monitorAlerts.length > 0 ? (
                <div className="divide-y max-h-96 overflow-y-auto" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
                  {monitorAlerts.map(alert => (
                    <div key={alert.id} className="px-5 py-3 transition-opacity" style={{ opacity: alert.acknowledged ? 0.4 : 1 }}>
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                              style={{
                                background: alert.urgency === 'critical' ? 'rgba(248,113,113,0.2)' : alert.urgency === 'high' ? 'rgba(251,191,36,0.15)' : 'rgba(255,255,255,0.08)',
                                color: alert.urgency === 'critical' ? '#f87171' : alert.urgency === 'high' ? '#fbbf24' : '#9ca3af',
                              }}>
                              {alert.urgency.toUpperCase()}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                              style={{
                                background: alert.market_impact === 'bullish' ? 'rgba(52,211,153,0.1)' : alert.market_impact === 'bearish' ? 'rgba(248,113,113,0.1)' : 'rgba(255,255,255,0.05)',
                                color: alert.market_impact === 'bullish' ? '#34d399' : alert.market_impact === 'bearish' ? '#f87171' : '#9ca3af',
                              }}>
                              {alert.market_impact}
                            </span>
                            {alert.ticker && (
                              <button onClick={() => handleAnalyze(alert.ticker)}
                                className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded hover:opacity-80"
                                style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>
                                {alert.ticker}
                              </button>
                            )}
                            {(alert.raw_data?.affected_tickers || []).filter((t: string) => t !== alert.ticker).slice(0, 3).map((t: string) => (
                              <button key={t} onClick={() => handleAnalyze(t)}
                                className="text-[9px] font-mono px-1.5 py-0.5 rounded hover:opacity-80"
                                style={{ background: 'var(--surface2)', color: 'var(--text3)' }}>
                                {t}
                              </button>
                            ))}
                            <span className="text-[9px] text-white/25 ml-auto">
                              {Math.round((Date.now() - new Date(alert.created_at).getTime()) / 60000)}m ago
                            </span>
                          </div>
                          <p className="text-[11px] text-white/70 mb-1 leading-relaxed font-medium">{alert.headline}</p>
                          {alert.analysis && <p className="text-[10px] text-white/45 mb-1 leading-relaxed">{alert.analysis}</p>}
                          {alert.action && (
                            <p className="text-[10px] font-semibold" style={{ color: alert.urgency === 'critical' ? '#f87171' : '#fbbf24' }}>
                              → {alert.action}
                            </p>
                          )}
                        </div>
                        {!alert.acknowledged && (
                          <button onClick={() => acknowledgeAlert(alert.id)}
                            className="shrink-0 text-[10px] px-2 py-1 rounded hover:opacity-80 mt-0.5"
                            style={{ background: 'var(--surface2)', color: 'var(--text3)' }}>
                            ✓
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-5 py-6 text-center">
                  <p className="text-sm text-white/25">No alerts yet</p>
                  <p className="text-[10px] text-white/15 mt-1">Monitoring news every 3 minutes. Hit Scan Now to check immediately.</p>
                </div>
              )}
            </div>

            {/* Market Intelligence Digest */}
            <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center gap-2">
                  <span>📊</span>
                  <span className="text-sm font-bold">Market Intelligence</span>
                  {(premarket?.brief_date || digest?.digest_date) && (
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full" style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
                      {premarket?.brief_date || digest?.digest_date}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button onClick={() => runDigest('premarket')} disabled={digestLoading}
                    className="text-[10px] font-mono px-2.5 py-1.5 rounded-lg disabled:opacity-40 hover:opacity-80"
                    style={{ background: 'rgba(96,165,250,0.1)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.2)' }}>
                    {digestLoading ? '...' : '☀ Pre-Market'}
                  </button>
                  <button onClick={() => runDigest('digest')} disabled={digestLoading}
                    className="text-[10px] font-mono px-2.5 py-1.5 rounded-lg disabled:opacity-40 hover:opacity-80"
                    style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
                    {digestLoading ? '...' : '🌙 EOD Digest'}
                  </button>
                </div>
              </div>

              {/* Pre-Market Brief */}
              {premarket && (
                <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="text-xs font-bold" style={{ color: '#60a5fa' }}>☀ Pre-Market</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-mono font-bold"
                      style={{ background: premarket.sentiment_score > 20 ? 'rgba(52,211,153,0.12)' : premarket.sentiment_score < -20 ? 'rgba(248,113,113,0.12)' : 'rgba(251,191,36,0.12)', color: premarket.sentiment_score > 20 ? '#34d399' : premarket.sentiment_score < -20 ? '#f87171' : '#fbbf24' }}>
                      {premarket.sentiment_label?.replace('_',' ')} {premarket.sentiment_score > 0 ? '+' : ''}{premarket.sentiment_score}
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full" style={{ background: 'var(--surface2)', color: 'var(--text3)' }}>
                      {premarket.open_direction?.replace('_',' ')}{premarket.expected_move ? ` ±${premarket.expected_move}%` : ''}
                    </span>
                  </div>
                  <p className="text-sm font-semibold text-white mb-2">{premarket.headline}</p>
                  {premarket.top_catalysts?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {premarket.top_catalysts.map((c: string) => (
                        <span key={c} className="text-[10px] px-2 py-0.5 rounded-full font-mono" style={{ background: 'rgba(96,165,250,0.08)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.15)' }}>{c}</span>
                      ))}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3 mb-2">
                    {premarket.sectors_bullish?.length > 0 && (
                      <div>
                        <p className="text-[10px] font-mono text-white/30 mb-1">BULLISH</p>
                        <div className="flex flex-wrap gap-1">
                          {premarket.sectors_bullish.map((s: string) => <span key={s} className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'rgba(52,211,153,0.1)', color: '#34d399' }}>{s}</span>)}
                        </div>
                      </div>
                    )}
                    {premarket.sectors_bearish?.length > 0 && (
                      <div>
                        <p className="text-[10px] font-mono text-white/30 mb-1">BEARISH</p>
                        <div className="flex flex-wrap gap-1">
                          {premarket.sectors_bearish.map((s: string) => <span key={s} className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171' }}>{s}</span>)}
                        </div>
                      </div>
                    )}
                  </div>
                  {premarket.tickers_to_watch?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {premarket.tickers_to_watch.map((t: string) => (
                        <button key={t} onClick={() => handleAnalyze(t)} className="text-xs font-mono font-bold px-2.5 py-1 rounded-lg hover:opacity-80" style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>{t}</button>
                      ))}
                    </div>
                  )}
                  <button onClick={() => setDigestExpanded(!digestExpanded)} className="text-[10px] font-mono text-white/30 hover:text-white/60">
                    {digestExpanded ? '▲ collapse' : '▼ read full brief'}
                  </button>
                  {digestExpanded && premarket.brief_text && (
                    <div className="mt-2 text-[11px] leading-relaxed text-white/55 whitespace-pre-wrap border-t pt-3 max-h-96 overflow-y-auto" style={{ borderColor: 'var(--border)' }}>
                      {premarket.brief_text.replace(/<json>[\s\S]*?<\/json>/gi, '').trim()}
                    </div>
                  )}
                </div>
              )}

              {/* EOD Digest */}
              {digest && (
                <div className="px-5 py-4">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="text-xs font-bold" style={{ color: '#a78bfa' }}>🌙 EOD Digest</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-mono font-bold"
                      style={{ background: digest.sentiment_score > 20 ? 'rgba(52,211,153,0.12)' : digest.sentiment_score < -20 ? 'rgba(248,113,113,0.12)' : 'rgba(251,191,36,0.12)', color: digest.sentiment_score > 20 ? '#34d399' : digest.sentiment_score < -20 ? '#f87171' : '#fbbf24' }}>
                      {digest.sentiment_label?.replace('_',' ')} {digest.sentiment_score > 0 ? '+' : ''}{digest.sentiment_score}
                    </span>
                  </div>
                  {digest.key_themes?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {digest.key_themes.map((t: string) => <span key={t} className="text-[10px] px-2 py-0.5 rounded-full font-mono" style={{ background: 'rgba(167,139,250,0.08)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.15)' }}>{t}</span>)}
                    </div>
                  )}
                  {digest.overnight_risks?.length > 0 && (
                    <div className="space-y-1">
                      {digest.overnight_risks.map((r: string) => <p key={r} className="text-[11px] text-white/45">⚠ {r}</p>)}
                    </div>
                  )}
                  {digest.premarket_outlook && <p className="text-[11px] text-white/40 italic mt-1">{digest.premarket_outlook}</p>}
                </div>
              )}

              {!digest && !premarket && (
                <div className="px-5 py-8 text-center">
                  <p className="text-sm text-white/30 mb-1">No market digest yet</p>
                  <p className="text-xs text-white/20">Run EOD Digest after 4pm or Pre-Market Brief before 9:30am</p>
                </div>
              )}
            </div>

            {/* Social & Political Signals */}
            <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
                <div className="flex items-center gap-2">
                  <span>📡</span>
                  <span className="text-sm font-bold">Social & Political Signals</span>
                  <span className="text-[10px] text-white/30 font-mono">Trump · Elon · Fed · Buffett</span>
                </div>
                <button onClick={scanSocial} disabled={socialLoading}
                  className="text-[10px] font-mono px-2.5 py-1.5 rounded-lg disabled:opacity-40 hover:opacity-80"
                  style={{ background: 'rgba(251,191,36,0.1)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)' }}>
                  {socialLoading ? 'Scanning...' : '⚡ Scan Now'}
                </button>
              </div>

              {socialSignals.length > 0 ? (
                <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
                  {socialSignals.slice(0, 8).map(s => (
                    <div key={s.id} className="px-5 py-3">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                          style={{
                            background: s.market_impact === 'bullish' ? 'rgba(52,211,153,0.12)' : s.market_impact === 'bearish' ? 'rgba(248,113,113,0.12)' : 'rgba(251,191,36,0.1)',
                            color: s.market_impact === 'bullish' ? '#34d399' : s.market_impact === 'bearish' ? '#f87171' : '#fbbf24',
                          }}>
                          {s.impact_magnitude?.toUpperCase()} {s.market_impact?.toUpperCase()}
                        </span>
                        <span className="text-[10px] font-semibold text-white/70">{s.person_label}</span>
                        <span className="text-[9px] text-white/25">{new Date(s.detected_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        {s.affected_tickers?.length > 0 && (
                          <div className="flex gap-1 flex-wrap">
                            {s.affected_tickers.slice(0, 4).map((t: string) => (
                              <button key={t} onClick={() => handleAnalyze(t)}
                                className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded hover:opacity-80"
                                style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa' }}>
                                {t}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <p className="text-[11px] text-white/60 mb-1 leading-relaxed">{s.headline}</p>
                      {s.analysis && <p className="text-[10px] text-white/40 leading-relaxed">{s.analysis}</p>}
                      {s.action_signal && (
                        <p className="text-[10px] mt-1 font-semibold" style={{ color: '#fbbf24' }}>→ {s.action_signal}</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-5 py-8 text-center">
                  <p className="text-sm text-white/30 mb-1">No signals yet</p>
                  <p className="text-xs text-white/20">Scan to detect Trump, Elon, Fed, and Buffett statements from today's news</p>
                </div>
              )}
            </div>

            {/* Sector Top Movers — live per-sector breakdown */}
            {Array.isArray(data.sectorTopMovers) && data.sectorTopMovers.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[10px] font-mono uppercase tracking-widest text-white/25">Top movers by sector</span>
                  <span className="text-[10px] font-mono text-white/15">— live</span>
                </div>
                <div className="space-y-2">
                  {data.sectorTopMovers.filter(s => Array.isArray(s.topMovers) && s.topMovers.length > 0).map((s) => {
                    const col = s.direction === 'up' ? '#34d399' : s.direction === 'down' ? '#f87171' : '#fbbf24'
                    return (
                      <div key={s.etf} className="rounded-xl border overflow-hidden"
                        style={{ background: `${col}05`, borderColor: `${col}18` }}>
                        {/* Sector header */}
                        <div className="flex items-center gap-2 px-3 py-2 border-b"
                          style={{ borderColor: `${col}12` }}>
                          <span className="text-sm">{s.emoji}</span>
                          <span className="text-xs font-bold" style={{ color: col }}>{s.sector}</span>
                          <span className="text-[10px] font-mono" style={{ color: col }}>
                            {s.etfChange > 0 ? '+' : ''}{s.etfChange}%
                          </span>
                          <span className="text-[10px] text-white/25 ml-auto font-mono">{s.etf}</span>
                        </div>
                        {/* Top 10 tickers */}
                        <div className="grid grid-cols-5 gap-0">
                          {(Array.isArray(s.topMovers) ? s.topMovers : []).map((m, i) => {
                            const tc = m.signal === 'up' ? '#34d399' : '#f87171'
                            return (
                              <div key={m.ticker} className="flex flex-col items-center py-2 px-1 text-center"
                                style={{ borderRight: i < 9 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                                         borderBottom: i < 5 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                                <span className="text-[10px] font-bold font-mono" style={{ color: 'var(--text2)' }}>{m.ticker}</span>
                                <span className="text-[10px] font-mono" style={{ color: tc }}>
                                  {m.change > 0 ? '+' : ''}{m.change}%
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Disclaimer */}
            <div className="text-[10px] font-mono text-white/15 text-center pb-4 leading-relaxed">
              AI-generated analysis based on news headlines. Not financial advice. Always do your own research before trading.
              News data from Alpaca Markets · Powered by Wali-OS
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
