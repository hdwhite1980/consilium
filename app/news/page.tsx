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

interface NewsPageData {
  generatedAt: string
  marketStatus: string
  topBullish: NewsMover[]
  topBearish: NewsMover[]
  watchlist: NewsMover[]
  marketTheme: string
  sectorMovers: Array<{ sector: string; direction: string; reason: string }>
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
          <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
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

  useEffect(() => { load() }, [load])

  const handleSignOut = async () => {
    await fetch('/api/auth/session', { method: 'DELETE' })
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const handleAnalyze = (ticker: string) => {
    router.push(`/?ticker=${ticker}`)
  }

  const timeAgo = generatedAt
    ? Math.round((Date.now() - new Date(generatedAt).getTime()) / 60000)
    : null

  return (
    <div className="flex flex-col min-h-screen" style={{ background: '#0a0d12', color: 'white' }}>

      {/* Header */}
      <header className="flex flex-wrap items-center gap-2 px-3 py-3 border-b sticky top-0 z-10"
        style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.07)' }}>
        <button onClick={() => router.push('/')}
          className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors">
          <ArrowLeft size={13} />
          Back
        </button>
        <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.1)' }} />
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
            style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.1)' }}>
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
          <div className="px-5 py-4 border-b" style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.07)' }}>
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

            {/* Sector movers */}
            {data.sectorMovers?.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[10px] font-mono uppercase tracking-widest text-white/25">Sector movements</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {data.sectorMovers.map((s, i) => {
                    const col = s.direction === 'up' ? '#34d399' : s.direction === 'down' ? '#f87171' : '#fbbf24'
                    return (
                      <div key={i} className="rounded-lg p-3 border"
                        style={{ background: `${col}06`, borderColor: `${col}20` }}>
                        <div className="text-xs font-semibold mb-1" style={{ color: col }}>
                          {s.direction === 'up' ? '▲' : s.direction === 'down' ? '▼' : '◆'} {s.sector}
                        </div>
                        <div className="text-[10px] text-white/40 leading-relaxed">{s.reason}</div>
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
