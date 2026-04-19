'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, RefreshCw, Calendar, Clock, TrendingUp, TrendingDown, AlertTriangle, BookOpen, Zap } from 'lucide-react'
import { createClient } from '@/app/lib/auth/client'

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
}

interface EarningsItem {
  ticker: string
  companyName: string
  reportTime: string
  expectedMove: string
  analystExpectation: string
  watchFor: string
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
  sector: string; etf: string; emoji: string; direction: string; etfChange: number
  topMovers: Array<{ ticker: string; change: number; signal: 'up' | 'down' }>
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
}

const SIG_COLOR = { BULLISH: '#34d399', BEARISH: '#f87171', NEUTRAL: '#fbbf24' }
const MAG_LABEL = { high: 'Big move expected', medium: 'Moderate move', low: 'Small move' }
const RISK_COLOR = { high: '#f87171', medium: '#fbbf24', low: '#34d399' }
const IMPACT_COLOR = { high: '#f87171', medium: '#fbbf24', low: '#94a3b8' }

const SETUP_ICONS: Record<string, string> = {
  earnings: '📊',
  technical_breakout: '📈',
  news_continuation: '📰',
  sector_play: '🏭',
  macro_event: '🌐',
  catalyst: '⚡',
}

function WatchCard({ item, onAnalyze }: { item: WatchlistItem; onAnalyze: (t: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const color = SIG_COLOR[item.signal]
  const icon = SETUP_ICONS[item.setupType] ?? '🔍'

  return (
    <div className="rounded-xl border transition-all"
      style={{ background: `${color}04`, borderColor: `${color}18` }}>
      <div className="p-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-lg shrink-0">{icon}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-sm px-2 py-0.5 rounded-md"
                  style={{ background: `${color}18`, color }}>
                  {item.ticker}
                </span>
                <span className="text-xs text-white/60 truncate">{item.companyName}</span>
              </div>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className="text-[10px] font-mono" style={{ color: MAG_LABEL[item.magnitude] === 'Big move expected' ? '#f87171' : 'rgba(255,255,255,0.4)' }}>
                  {MAG_LABEL[item.magnitude]}
                </span>
                <span className="text-[10px] text-white/25">·</span>
                <span className="text-[10px] font-mono text-white/40">{item.timeOfDay.replace('-', ' ')}</span>
                <span className="text-[10px] text-white/25">·</span>
                <span className="text-[10px] font-mono" style={{ color: RISK_COLOR[item.riskLevel] }}>
                  {item.riskLevel} risk
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-mono font-bold px-2 py-1 rounded-full"
              style={{ background: `${color}15`, color, border: `1px solid ${color}28` }}>
              {item.signal === 'BULLISH' ? <TrendingUp size={10} className="inline mr-1" /> : item.signal === 'BEARISH' ? <TrendingDown size={10} className="inline mr-1" /> : null}
              {item.signal}
            </span>
            <span className="text-white/25 text-xs">{expanded ? '▲' : '▼'}</span>
          </div>
        </div>
        <p className="text-xs text-white/50 mt-2.5 leading-relaxed">{item.catalyst}</p>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t" style={{ borderColor: `${color}12` }}>
          <div className="pt-3">
            <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color }}>What this means</div>
            <p className="text-sm text-white/75 leading-relaxed">{item.plainEnglish}</p>
          </div>

          {item.keyLevel && (
            <div className="rounded-lg p-3" style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.15)' }}>
              <div className="text-[10px] font-mono uppercase tracking-widest text-yellow-400/70 mb-1">Key level to watch</div>
              <p className="text-xs text-white/65">{item.keyLevel}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg p-3" style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)' }}>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: '#34d399' }}>If bullish</div>
              <p className="text-[11px] text-white/60 leading-relaxed">{item.planBull}</p>
            </div>
            <div className="rounded-lg p-3" style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)' }}>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: '#f87171' }}>If bearish</div>
              <p className="text-[11px] text-white/60 leading-relaxed">{item.planBear}</p>
            </div>
          </div>

          <button onClick={() => onAnalyze(item.ticker)}
            className="w-full py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
            style={{ background: `${color}18`, color, border: `1px solid ${color}30` }}>
            Run full AI analysis on {item.ticker} →
          </button>
        </div>
      )}
    </div>
  )
}

export default function TomorrowPage() {
  const router = useRouter()
  const [data, setData] = useState<TomorrowData | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('Preparing tomorrow\'s playbook...')
  const [error, setError] = useState<string | null>(null)

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

  const handleSignOut = async () => {
    // Server cleanup first (best effort)
    try { await fetch('/api/auth/session', { method: 'DELETE' }) } catch {}
    // Nuke client-side auth state directly - don't call supabase.auth.signOut()
    // because that hits Supabase's /logout endpoint which fails intermittently
    // and leaves zombie SDK state that breaks subsequent logins.
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

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>

      {/* Header */}
      <header className="flex flex-wrap items-center gap-2 px-3 py-3 border-b sticky top-0 z-10"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <button onClick={() => router.push('/')}
          className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        <div className="flex items-center gap-2">
          <Calendar size={14} style={{ color: '#a78bfa' }} />
          <span className="text-sm font-bold">Tomorrow&apos;s Movers</span>
          <span className="text-[10px] font-mono text-white/25 hidden sm:inline">Next trading day playbook</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {data?.cached && !loading && (
            <span className="text-[10px] font-mono px-2.5 py-1 rounded-full"
              style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.25)' }}>
              ⏱ {data.ageMinutes}m ago
            </span>
          )}
          <button onClick={() => load(true)} disabled={loading}
            className="flex items-center gap-1.5 text-[11px] font-mono px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-40"
            style={{ background: 'var(--surface2)', color: 'var(--text3)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          <button onClick={handleSignOut}
            className="text-[10px] font-mono px-2.5 py-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
            Sign out
          </button>
        </div>
      </header>

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 p-8">
          <div className="flex gap-1.5">
            {[0,1,2].map(i => <span key={i} className="w-2 h-2 rounded-full thinking-dot" style={{ background: '#a78bfa', animationDelay: `${i*0.15}s` }} />)}
          </div>
          <p className="text-sm text-white/40 font-mono">{status}</p>
          <p className="text-xs text-white/20 text-center max-w-sm">
            Analyzing catalysts, earnings, economic events, and technical setups for the next trading day
          </p>
        </div>
      )}

      {error && !loading && (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 p-8">
          <div className="text-sm text-red-400">⚠ {error}</div>
          <button onClick={() => load()} className="text-xs text-white/40 hover:text-white/60 underline">Try again</button>
        </div>
      )}

      {data && !loading && (
        <div className="flex-1 overflow-y-auto">

          {/* Next day banner */}
          <div className="px-4 py-4 border-b" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <div className="max-w-4xl mx-auto">
              <div className="flex items-start gap-3">
                <Calendar size={16} className="shrink-0 mt-0.5" style={{ color: '#a78bfa' }} />
                <div>
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: '#a78bfa' }}>
                      Next trading day
                    </span>
                    <span className="text-xs font-bold text-white">{data.nextTradingDay}</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
                      {data.keyTheme}
                    </span>
                  </div>
                  <p className="text-sm text-white/70 leading-relaxed">{data.marketOutlook}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="max-w-4xl mx-auto px-3 sm:px-5 py-5 space-y-8">

            {/* Opening bell playbook */}
            <div className="rounded-xl p-4" style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.2)' }}>
              <div className="flex items-center gap-2 mb-3">
                <BookOpen size={14} style={{ color: '#a78bfa' }} />
                <span className="text-sm font-bold" style={{ color: '#a78bfa' }}>Opening Bell Playbook</span>
                <span className="text-[10px] font-mono text-white/30">First 30 minutes</span>
              </div>
              <p className="text-sm text-white/70 leading-relaxed">{data.openingBellPlaybook}</p>
            </div>

            {/* Pre-market watchlist */}
            {data.preMarketWatchlist?.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Zap size={14} style={{ color: '#fbbf24' }} />
                  <span className="text-sm font-semibold text-white">Pre-Market Watchlist</span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                    style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.2)' }}>
                    {data.preMarketWatchlist.length} setups
                  </span>
                </div>
                <div className="space-y-3">
                  {data.preMarketWatchlist.map(item => (
                    <WatchCard key={item.ticker} item={item} onAnalyze={handleAnalyze} />
                  ))}
                </div>
              </div>
            )}

            {/* Earnings calendar */}
            {data.earningsCalendar?.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-sm">📊</span>
                  <span className="text-sm font-semibold text-white">Earnings Tomorrow</span>
                </div>
                <div className="space-y-2">
                  {data.earningsCalendar.map((e, i) => (
                    <div key={i} className="rounded-xl p-4 border"
                      style={{ background: 'var(--surface2)', borderColor: 'var(--border)' }}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-mono font-bold text-sm text-white">{e.ticker}</span>
                            <span className="text-xs text-white/50">{e.companyName}</span>
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded"
                              style={{ background: 'rgba(96,165,250,0.12)', color: '#60a5fa' }}>
                              {e.reportTime.replace('-', ' ')}
                            </span>
                            <span className="text-[10px] font-mono text-white/40">Expected move: {e.expectedMove}</span>
                          </div>
                        </div>
                        <button onClick={() => handleAnalyze(e.ticker)}
                          className="text-[10px] font-mono px-2.5 py-1 rounded-lg shrink-0 transition-all hover:opacity-80"
                          style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
                          Analyze
                        </button>
                      </div>
                      <p className="text-xs text-white/50 mt-2">{e.analystExpectation}</p>
                      <p className="text-[11px] text-white/35 mt-1">Watch for: {e.watchFor}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Economic events */}
            {data.economicEvents?.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Clock size={14} style={{ color: '#60a5fa' }} />
                  <span className="text-sm font-semibold text-white">Economic Events</span>
                </div>
                <div className="space-y-2">
                  {data.economicEvents.map((e, i) => (
                    <div key={i} className="flex items-start gap-3 rounded-xl p-3.5 border"
                      style={{ background: 'var(--surface2)', borderColor: `${IMPACT_COLOR[e.impact]}18` }}>
                      <div className="shrink-0 mt-0.5">
                        <div className="w-2 h-2 rounded-full mt-1" style={{ background: IMPACT_COLOR[e.impact] }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="text-sm font-semibold text-white">{e.event}</span>
                          <span className="text-[10px] font-mono text-white/35">{e.time}</span>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                            style={{ background: `${IMPACT_COLOR[e.impact]}15`, color: IMPACT_COLOR[e.impact] }}>
                            {e.impact} impact
                          </span>
                        </div>
                        <p className="text-xs text-white/55 leading-relaxed">{e.whatToWatch}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Sector Setups + Live Top Movers */}
            {((data.sectorSetups?.length ?? 0) > 0 || (data.sectorTopMovers?.length ?? 0) > 0) && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm">🏭</span>
                  <span className="text-sm font-semibold text-white">Sector Setups</span>
                </div>

                {/* AI sector analysis */}
                {data.sectorSetups?.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {data.sectorSetups.map((s, i) => {
                      const col = s.direction === 'bullish' ? '#34d399' : s.direction === 'bearish' ? '#f87171' : '#fbbf24'
                      return (
                        <div key={i} className="rounded-xl p-3 border"
                          style={{ background: `${col}05`, borderColor: `${col}18` }}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-semibold" style={{ color: col }}>{s.sector}</span>
                            <span className="text-[10px] font-mono text-white/30">{s.etf}</span>
                          </div>
                          <p className="text-[11px] text-white/50 leading-relaxed mb-1.5">{s.reason}</p>
                          <div className="text-[10px] font-mono" style={{ color: col }}>
                            Top play: {s.topPlay}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Live top 10 per sector */}
                {Array.isArray(data.sectorTopMovers) && data.sectorTopMovers.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-white/25">Live top movers by sector</span>
                    {data.sectorTopMovers.map((s) => {
                      const col = s.direction === 'up' ? '#34d399' : s.direction === 'down' ? '#f87171' : '#fbbf24'
                      return (
                        <div key={s.etf} className="rounded-xl border overflow-hidden"
                          style={{ background: `${col}05`, borderColor: `${col}18` }}>
                          <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: `${col}12` }}>
                            <span className="text-sm">{s.emoji}</span>
                            <span className="text-xs font-bold" style={{ color: col }}>{s.sector}</span>
                            <span className="text-[10px] font-mono" style={{ color: col }}>
                              {s.etfChange > 0 ? '+' : ''}{s.etfChange}%
                            </span>
                            <span className="text-[10px] text-white/25 ml-auto font-mono">{s.etf}</span>
                          </div>
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
                )}
              </div>
            )}

            {/* Crypto setup */}
            {data.cryptoSetup && (
              <div className="rounded-xl p-4" style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <span>₿</span>
                  <span className="text-sm font-semibold" style={{ color: '#fbbf24' }}>Crypto Setup</span>
                </div>
                <p className="text-sm text-white/70 leading-relaxed">{data.cryptoSetup}</p>
              </div>
            )}

            {/* Risk factors */}
            {data.riskFactors?.length > 0 && (
              <div className="rounded-xl p-4" style={{ background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.15)' }}>
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle size={14} style={{ color: '#f87171' }} />
                  <span className="text-sm font-semibold" style={{ color: '#f87171' }}>Risk Factors to Watch</span>
                </div>
                <div className="space-y-1.5">
                  {data.riskFactors.map((r, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className="text-[10px] mt-0.5" style={{ color: '#f87171' }}>•</span>
                      <span className="text-xs text-white/60 leading-relaxed">{r}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p className="text-[10px] font-mono text-white/15 text-center pb-4 leading-relaxed">
              AI-generated forward-looking analysis. Not financial advice. Always do your own research.
              Catalysts and events may change. Data from Alpaca Markets · Powered by Wali-OS.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
