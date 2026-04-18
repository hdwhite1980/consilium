'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, RefreshCw, TrendingUp, TrendingDown, Minus, Globe, BarChart2, DollarSign, Shield } from 'lucide-react'

interface SectorData {
  etf: string; name: string; emoji: string
  price: number; change1D: number; change5D: number
  rsi: number | null; signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
}

interface SmartMoneyData {
  ticker: string; name: string
  price: number; change1D: number; change5D: number; rsi: number | null
}

interface MacroDashboard {
  timestamp: string
  regime: string; regimeColor: string
  breadth: { bullish: number; neutral: number; bearish: number; advancing: number; declining: number }
  topSector: SectorData; worstSector: SectorData
  sectors: SectorData[]
  smartMoney: SmartMoneyData[]
  spy: { price: number; change1D: number; change5D: number; rsi: number | null }
  qqq: { price: number; change1D: number; change5D: number; rsi: number | null }
  bonds: { price: number; change1D: number }
  cached?: boolean
}

const SIG_COLOR = { BULLISH: '#34d399', BEARISH: '#f87171', NEUTRAL: '#fbbf24' }
const SIG_BG = { BULLISH: 'rgba(52,211,153,0.1)', BEARISH: 'rgba(248,113,113,0.1)', NEUTRAL: 'rgba(251,191,36,0.1)' }
const pct = (n: number, decimals = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`

function SignalBadge({ s }: { s: 'BULLISH' | 'BEARISH' | 'NEUTRAL' }) {
  const Icon = s === 'BULLISH' ? TrendingUp : s === 'BEARISH' ? TrendingDown : Minus
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold px-2 py-0.5 rounded-full"
      style={{ background: SIG_BG[s], color: SIG_COLOR[s], border: `1px solid ${SIG_COLOR[s]}30` }}>
      <Icon size={9} />{s}
    </span>
  )
}

function MiniBar({ value, max = 100 }: { value: number; max?: number }) {
  const pctWidth = Math.min(Math.abs(value) / max * 100, 100)
  const color = value >= 0 ? '#34d399' : '#f87171'
  return (
    <div className="flex items-center gap-1.5 flex-1">
      {value < 0 && <div className="flex-1 h-1.5 rounded-full overflow-hidden flex justify-end" style={{ background: 'var(--surface2)' }}>
        <div className="h-full rounded-full" style={{ width: `${pctWidth}%`, background: color }} />
      </div>}
      <span className="text-[11px] font-mono w-12 text-center" style={{ color }}>{pct(value)}</span>
      {value >= 0 && <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--surface2)' }}>
        <div className="h-full rounded-full" style={{ width: `${pctWidth}%`, background: color }} />
      </div>}
    </div>
  )
}

export default function MacroDashboard() {
  const router = useRouter()
  const [data, setData] = useState<MacroDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastFetch, setLastFetch] = useState<Date | null>(null)
  const [macroThemes, setMacroThemes] = useState<Array<{id:string;theme_name:string;theme_summary:string;playbook:string;sectors_to_watch:string[];tickers_to_watch:string[];urgency:string}>>([])

  const load = useCallback(async (force = false) => {
    setLoading(true)
    const res = await fetch(`/api/macro${force ? '?force=1' : ''}`)
    const json = await res.json()
    setData(json)
    setLastFetch(new Date())
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    fetch('/api/macro-intelligence')
      .then(r => r.json())
      .then(d => setMacroThemes(d.themes || []))
      .catch(() => {})
  }, [load])

  const ageMinutes = lastFetch ? Math.round((Date.now() - lastFetch.getTime()) / 60000) : 0

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>

      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b sticky top-0 z-10"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        <Globe size={14} style={{ color: '#60a5fa' }} />
        <span className="text-sm font-bold">Macro Dashboard</span>
        {data && (
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
            style={{ background: `${data.regimeColor}15`, color: data.regimeColor, border: `1px solid ${data.regimeColor}30` }}>
            {data.regime}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {lastFetch && <span className="text-[10px] font-mono text-white/25">{ageMinutes}m ago</span>}
          <button onClick={() => load(true)} disabled={loading}
            className="flex items-center gap-1.5 text-[11px] font-mono px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-40"
            style={{ background: 'var(--surface2)', color: 'var(--text3)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </header>

      {loading && !data && (
        <div className="flex items-center justify-center flex-1 gap-3">
          <div className="flex gap-1">
            {[0,1,2].map(i => <span key={i} className="w-1.5 h-1.5 rounded-full thinking-dot" style={{ background: '#60a5fa', animationDelay: `${i*0.15}s` }} />)}
          </div>
          <span className="text-sm text-white/40 font-mono">Loading macro data...</span>
        </div>
      )}

      {data && (
        <div className="max-w-6xl mx-auto w-full px-4 py-6 space-y-5">

          {/* Active Macro Intelligence Themes */}
          {macroThemes.length > 0 && (
            <div className="rounded-2xl border overflow-hidden" style={{ background: 'rgba(251,191,36,0.04)', borderColor: 'rgba(251,191,36,0.2)' }}>
              <div className="px-4 py-3 border-b flex items-center gap-2" style={{ borderColor: 'rgba(251,191,36,0.15)' }}>
                <span style={{ color: '#fbbf24' }}>🌍</span>
                <span className="text-xs font-bold" style={{ color: '#fbbf24' }}>Active Macro Intelligence Themes</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full ml-auto" style={{ background: 'rgba(251,191,36,0.1)', color: '#fbbf24' }}>
                  {macroThemes.length} active
                </span>
              </div>
              <div className="divide-y divide-white/5">
                {macroThemes.map(theme => (
                  <div key={theme.id} className="px-4 py-3 space-y-1.5">
                    <div className="flex items-start gap-2">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 mt-0.5"
                        style={{
                          background: theme.urgency === 'high' ? 'rgba(248,113,113,0.15)' : theme.urgency === 'medium' ? 'rgba(251,191,36,0.12)' : 'rgba(255,255,255,0.06)',
                          color: theme.urgency === 'high' ? '#f87171' : theme.urgency === 'medium' ? '#fbbf24' : 'rgba(255,255,255,0.4)'
                        }}>
                        {theme.urgency.toUpperCase()}
                      </span>
                      <span className="text-xs font-semibold text-white/90">{theme.theme_name}</span>
                    </div>
                    <p className="text-xs text-white/55 leading-relaxed pl-10">{theme.theme_summary}</p>
                    {theme.playbook && (
                      <div className="pl-10 flex items-start gap-1.5">
                        <span className="text-[10px] font-mono text-white/25 shrink-0">Historical playbook →</span>
                        <span className="text-[11px] text-white/50">{theme.playbook}</span>
                      </div>
                    )}
                    {(theme.sectors_to_watch.length > 0 || theme.tickers_to_watch.length > 0) && (
                      <div className="pl-10 flex flex-wrap gap-1.5 mt-1">
                        {theme.sectors_to_watch.map(s => (
                          <span key={s} className="text-[10px] px-2 py-0.5 rounded-full font-mono"
                            style={{ background: 'rgba(96,165,250,0.1)', color: '#60a5fa' }}>{s}</span>
                        ))}
                        {theme.tickers_to_watch.map(t => (
                          <span key={t} className="text-[10px] px-2 py-0.5 rounded-full font-mono"
                            style={{ background: 'rgba(52,211,153,0.1)', color: '#34d399' }}>{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Regime + Breadth row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="col-span-2 rounded-2xl p-4 border-2"
              style={{ background: `${data.regimeColor}08`, borderColor: `${data.regimeColor}30` }}>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: data.regimeColor }}>Market Regime</div>
              <div className="text-2xl font-bold mb-1" style={{ color: data.regimeColor }}>{data.regime}</div>
              <div className="flex gap-3 text-xs font-mono text-white/50">
                <span style={{ color: '#34d399' }}>{data.breadth.bullish} bull sectors</span>
                <span style={{ color: '#fbbf24' }}>{data.breadth.neutral} neutral</span>
                <span style={{ color: '#f87171' }}>{data.breadth.bearish} bear sectors</span>
              </div>
              <div className="mt-2 h-2 rounded-full overflow-hidden flex gap-0.5">
                <div style={{ width: `${(data.breadth.bullish/11)*100}%`, background: '#34d399', borderRadius: '4px 0 0 4px' }} />
                <div style={{ width: `${(data.breadth.neutral/11)*100}%`, background: '#fbbf24' }} />
                <div style={{ width: `${(data.breadth.bearish/11)*100}%`, background: '#f87171', borderRadius: '0 4px 4px 0' }} />
              </div>
            </div>

            {[
              { label: 'SPY', data: data.spy, color: data.spy.change1D >= 0 ? '#34d399' : '#f87171' },
              { label: 'QQQ', data: data.qqq, color: data.qqq.change1D >= 0 ? '#34d399' : '#f87171' },
            ].map(({ label, data: d, color }) => (
              <div key={label} className="rounded-2xl p-4 border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                <div className="text-[10px] font-mono text-white/40 mb-1">{label}</div>
                <div className="text-xl font-bold font-mono mb-0.5">${d.price.toFixed(2)}</div>
                <div className="font-mono text-sm" style={{ color }}>{pct(d.change1D)} today</div>
                <div className="font-mono text-xs text-white/30">{pct(d.change5D)} 5d · RSI {d.rsi ?? 'N/A'}</div>
              </div>
            ))}
          </div>

          {/* Sector heatmap */}
          <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2.5 px-5 py-3.5 border-b" style={{ borderColor: 'var(--border)' }}>
              <BarChart2 size={14} style={{ color: '#a78bfa' }} />
              <span className="text-sm font-bold">Sector Performance</span>
              <span className="text-[10px] text-white/30 ml-auto">Sorted by daily change</span>
            </div>
            <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
              {data.sectors.map(s => (
                <div key={s.etf}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-white/[0.02] cursor-pointer transition-colors"
                  onClick={() => router.push(`/?ticker=${s.etf}`)}>
                  <span className="text-base w-6 shrink-0">{s.emoji}</span>
                  <div className="w-36 shrink-0">
                    <div className="text-sm font-semibold text-white">{s.name}</div>
                    <div className="text-[10px] font-mono text-white/30">{s.etf} · ${s.price.toFixed(2)}</div>
                  </div>
                  <MiniBar value={s.change1D} max={3} />
                  <div className="w-20 text-right shrink-0">
                    <div className="text-[10px] font-mono text-white/40">5d: <span style={{ color: s.change5D >= 0 ? '#34d399' : '#f87171' }}>{pct(s.change5D)}</span></div>
                    <div className="text-[10px] font-mono text-white/30">RSI {s.rsi ?? 'N/A'}</div>
                  </div>
                  <div className="w-20 shrink-0 text-right">
                    <SignalBadge s={s.signal} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Smart money flows */}
          <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2.5 px-5 py-3.5 border-b" style={{ borderColor: 'var(--border)' }}>
              <Shield size={14} style={{ color: '#34d399' }} />
              <span className="text-sm font-bold">Smart Money Flows</span>
              <span className="text-[10px] text-white/30 ml-auto">Cross-asset signals</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-4">
              {data.smartMoney.map(s => (
                <div key={s.ticker} className="rounded-xl p-3.5 border" style={{ background: 'var(--surface2)', borderColor: 'var(--border)' }}>
                  <div className="flex justify-between items-start mb-1">
                    <div>
                      <div className="text-xs font-mono font-bold text-white">{s.ticker}</div>
                      <div className="text-[10px] text-white/35">{s.name}</div>
                    </div>
                    <span className="text-xs font-mono font-bold" style={{ color: s.change1D >= 0 ? '#34d399' : '#f87171' }}>
                      {pct(s.change1D)}
                    </span>
                  </div>
                  <div className="text-lg font-bold font-mono text-white">${s.price.toFixed(2)}</div>
                  <div className="flex justify-between text-[10px] font-mono text-white/30 mt-1">
                    <span>5d: <span style={{ color: s.change5D >= 0 ? '#34d399' : '#f87171' }}>{pct(s.change5D)}</span></span>
                    <span>RSI {s.rsi ?? 'N/A'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Top / worst sectors */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              { label: '🔥 Leading sector', s: data.topSector, color: '#34d399' },
              { label: '❄ Lagging sector', s: data.worstSector, color: '#f87171' },
            ].map(({ label, s, color }) => (
              <div key={s.etf} className="rounded-2xl p-4 border cursor-pointer hover:opacity-80 transition-opacity"
                style={{ background: `${color}06`, borderColor: `${color}25` }}
                onClick={() => router.push(`/?ticker=${s.etf}`)}>
                <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: 'var(--text3)' }}>{label}</div>
                <div className="flex items-center gap-2.5 mb-1">
                  <span className="text-xl">{s.emoji}</span>
                  <span className="text-base font-bold text-white">{s.name}</span>
                  <span className="font-mono text-xs font-bold ml-auto" style={{ color }}>{pct(s.change1D)}</span>
                </div>
                <div className="text-xs text-white/40">{s.etf} · RSI {s.rsi ?? 'N/A'} · 5d {pct(s.change5D)}</div>
              </div>
            ))}
          </div>

          {/* Compare CTA */}
          <div className="rounded-2xl p-5 border text-center" style={{ background: 'rgba(167,139,250,0.05)', borderColor: 'rgba(167,139,250,0.2)' }}>
            <div className="text-sm font-bold text-white mb-1">Want to compare two stocks head-to-head?</div>
            <div className="text-xs text-white/40 mb-3">Run a full analysis on two tickers simultaneously and get a clear recommendation on which has better risk/reward.</div>
            <button onClick={() => router.push('/compare')}
              className="px-5 py-2 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
              Open comparison tool →
            </button>
          </div>

          <p className="text-[10px] text-white/15 text-center pb-4">Data refreshes every 30 minutes. For informational purposes only.</p>
        </div>
      )}
    </div>
  )
}
