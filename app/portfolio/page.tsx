'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Tutorial, TutorialLauncher, PORTFOLIO_TUTORIAL } from '@/app/components/Tutorial'
import { ArrowLeft, Plus, Trash2, RefreshCw, TrendingUp, TrendingDown, Minus, AlertTriangle, BarChart2, DollarSign, Calendar, ChevronDown, ChevronUp } from 'lucide-react'

interface Position {
  id: string
  ticker: string
  shares: number
  avg_cost: number | null
  notes: string | null
}

interface PositionData {
  ticker: string
  shares: number
  avg_cost: number | null
  currentPrice: number
  marketValue: number
  gainLoss: number | null
  gainLossPct: number | null
  priceChange1D: number
  rsi: number | null
  signal: string
  goldenCross: boolean | null
  earningsDate: string | null
  daysToEarnings: number | null
  sector: string
  analystConsensus: string
  analystTarget: number | null
}

interface PortfolioMetrics {
  totalValue: number
  totalGainLoss: number
  totalGainLossPct: number
  sectorConcentration: Array<{ sector: string; pct: number }>
  upcomingEarnings: PositionData[]
  signals: { BULLISH: number; NEUTRAL: number; BEARISH: number }
}

interface PortfolioAnalysis {
  overallSignal: string
  overallConviction: string
  headline: string
  summary: string
  topRisks: Array<{ risk: string; tickers: string[]; severity: string }>
  opportunities: Array<{ opportunity: string; tickers: string[] }>
  sectorAnalysis: string
  earningsWatch: string
  rebalancingSuggestions: string
  actionPlan: string
  portfolioScore: number
}

const SIG_COLOR: Record<string, string> = { BULLISH: '#34d399', BEARISH: '#f87171', NEUTRAL: '#fbbf24' }
const SEV_COLOR: Record<string, string> = { high: '#f87171', medium: '#fbbf24', low: '#94a3b8' }
const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtK = (n: number) => n >= 1000 ? `$${(n/1000).toFixed(1)}k` : `$${fmt(n)}`
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`

function Section({ title, icon, color, children, defaultOpen = true }: {
  title: string; icon: React.ReactNode; color: string; children: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-2xl border overflow-hidden" style={{ background: '#111620', borderColor: `${color}20` }}>
      <button className="w-full flex items-center gap-2.5 px-5 py-4 border-b text-left"
        style={{ borderColor: `${color}15` }}
        onClick={() => setOpen(!open)}>
        <span style={{ color }}>{icon}</span>
        <span className="text-sm font-bold text-white flex-1">{title}</span>
        {open ? <ChevronUp size={14} className="text-white/30" /> : <ChevronDown size={14} className="text-white/30" />}
      </button>
      {open && <div className="px-5 py-4">{children}</div>}
    </div>
  )
}

export default function PortfolioPage() {
  const router = useRouter()
  const [positions, setPositions] = useState<Position[]>([])
  const [positionData, setPositionData] = useState<PositionData[]>([])
  const [metrics, setMetrics] = useState<PortfolioMetrics | null>(null)
  const [analysis, setAnalysis] = useState<PortfolioAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [showTutorial, setShowTutorial] = useState(false)

  // Add position form
  const [showAdd, setShowAdd] = useState(false)
  const [addTicker, setAddTicker] = useState('')
  const [addShares, setAddShares] = useState('')
  const [addCost, setAddCost] = useState('')
  const [addLoading, setAddLoading] = useState(false)

  const loadPositions = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/portfolio/positions')
    const data = await res.json()
    setPositions(data.positions ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { loadPositions() }, [loadPositions])

  useEffect(() => {
    fetch('/api/tutorial?id=portfolio')
      .then(r => r.json())
      .then(({ progress }) => {
        if (!progress || (!progress.completed && !progress.skipped)) setShowTutorial(true)
      }).catch(() => {})
  }, [])

  useEffect(() => {
    const handler = (e: Event) => {
      const { tutorialId } = (e as CustomEvent).detail
      if (tutorialId === 'portfolio') {
        // Force remount by toggling off then on
        setShowTutorial(false)
        setTimeout(() => setShowTutorial(true), 0)
      }
    }
    window.addEventListener('consilium:launch_tutorial', handler)
    return () => window.removeEventListener('consilium:launch_tutorial', handler)
  }, [])

  const addPosition = async () => {
    if (!addTicker || !addShares) return
    setAddLoading(true)
    await fetch('/api/portfolio/positions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: addTicker.toUpperCase(),
        shares: parseFloat(addShares),
        avg_cost: addCost ? parseFloat(addCost) : null,
      })
    })
    setAddTicker(''); setAddShares(''); setAddCost('')
    setShowAdd(false)
    setAddLoading(false)
    await loadPositions()
  }

  const removePosition = async (ticker: string) => {
    await fetch('/api/portfolio/positions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker })
    })
    await loadPositions()
    setPositionData(prev => prev.filter(p => p.ticker !== ticker))
  }

  const runAnalysis = useCallback(async () => {
    if (!positions.length) return
    setAnalyzing(true)
    setAnalysis(null)
    setPositionData([])
    setMetrics(null)
    setStatusMsg('Starting analysis...')

    const res = await fetch('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positions: positions.map(p => ({ ticker: p.ticker, shares: p.shares, avg_cost: p.avg_cost })) })
    })

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
        if (ev === 'status') setStatusMsg(d.message)
        if (ev === 'position_data') setPositionData(d)
        if (ev === 'complete') {
          setPositionData(d.positionData)
          setMetrics(d.metrics)
          setAnalysis(d.analysis)
          setAnalyzing(false)
        }
        if (ev === 'error') { setStatusMsg(d.message); setAnalyzing(false) }
      }
    }
  }, [positions])

  const totalValue = positionData.reduce((s, p) => s + p.marketValue, 0)

  return (
    <>
    <div className="flex flex-col min-h-screen" style={{ background: '#0a0d12', color: 'white' }}>

      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b sticky top-0 z-10"
        style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.07)' }}>
        <button onClick={() => router.push('/')}
          className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.1)' }} />
        <div className="flex items-center gap-2">
          <BarChart2 size={14} style={{ color: '#a78bfa' }} />
          <span className="text-sm font-bold">My Portfolio</span>
          {positions.length > 0 && (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
              {positions.length} positions
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <TutorialLauncher tutorialId="portfolio" label="How it works" />
          <button onClick={() => setShowAdd(!showAdd)} data-tutorial="add-position-btn" 
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.25)' }}>
            <Plus size={12} /> Add position
          </button>
          {positions.length > 0 && (
            <button onClick={runAnalysis} disabled={analyzing}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)', color: 'white' }}>
              <RefreshCw size={12} className={analyzing ? 'animate-spin' : ''} />
              {analyzing ? 'Analyzing...' : 'Analyze portfolio'}
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">

          {/* Add position form */}
          {showAdd && (
            <div className="rounded-2xl border p-5" style={{ background: '#111620', borderColor: 'rgba(167,139,250,0.25)' }}>
              <h3 className="text-sm font-bold text-white mb-4">Add position</h3>
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div>
                  <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Ticker</label>
                  <input value={addTicker} onChange={e => setAddTicker(e.target.value.toUpperCase())}
                    placeholder="AAPL" maxLength={6}
                    className="w-full rounded-xl px-3 py-2.5 text-sm font-mono font-bold tracking-widest outline-none border"
                    style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }}
                    onKeyDown={e => e.key === 'Enter' && addPosition()} />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Shares</label>
                  <input value={addShares} onChange={e => setAddShares(e.target.value)}
                    placeholder="100" type="number" min="0"
                    className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                    style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                </div>
                <div>
                  <label className="text-[10px] font-mono text-white/40 uppercase tracking-wider block mb-1.5">Avg cost (optional)</label>
                  <input value={addCost} onChange={e => setAddCost(e.target.value)}
                    placeholder="$0.00" type="number" min="0"
                    className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                    style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={addPosition} disabled={addLoading || !addTicker || !addShares}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-40"
                  style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
                  {addLoading ? 'Adding...' : 'Add position'}
                </button>
                <button onClick={() => setShowAdd(false)}
                  className="px-4 py-2 rounded-xl text-sm transition-all hover:opacity-80"
                  style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!loading && positions.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
              <div className="text-5xl opacity-40">📊</div>
              <div className="text-lg font-bold text-white/70">No positions yet</div>
              <p className="text-sm text-white/40 max-w-sm">Add your stock holdings to get a holistic AI analysis of your entire portfolio — concentration risk, earnings events, and actionable rebalancing suggestions.</p>
              <button onClick={() => setShowAdd(true)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-white transition-all hover:opacity-90 mt-2"
                style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
                <Plus size={14} /> Add your first position
              </button>
            </div>
          )}

          {/* Positions list */}
          {positions.length > 0 && (
            <div className="rounded-2xl border overflow-hidden" style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
                <span className="text-xs font-bold text-white/60 uppercase tracking-wider">Holdings</span>
                {totalValue > 0 && <span className="text-xs font-mono text-white/40">Total: {fmtK(totalValue)}</span>}
              </div>
              <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                {positions.map(pos => {
                  const data = positionData.find(p => p.ticker === pos.ticker)
                  const signalColor = data ? SIG_COLOR[data.signal] : 'rgba(255,255,255,0.3)'
                  return (
                    <div key={pos.ticker} className="flex items-center gap-3 px-5 py-3.5">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2.5">
                          <span className="font-mono font-bold text-sm text-white">{pos.ticker}</span>
                          <span className="text-xs text-white/40">{pos.shares} shares</span>
                          {pos.avg_cost && <span className="text-[10px] text-white/30">@ ${pos.avg_cost.toFixed(2)}</span>}
                          {data && (
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: `${signalColor}15`, color: signalColor }}>
                              {data.signal}
                            </span>
                          )}
                        </div>
                        {data && (
                          <div className="flex items-center gap-3 mt-0.5">
                            <span className="text-xs font-mono text-white/60">${fmt(data.currentPrice)}</span>
                            <span className="text-[10px] font-mono" style={{ color: data.priceChange1D >= 0 ? '#34d399' : '#f87171' }}>
                              {pct(data.priceChange1D)} today
                            </span>
                            <span className="text-[10px] text-white/40">{fmtK(data.marketValue)} ({(data.marketValue/totalValue*100).toFixed(1)}%)</span>
                            {data.gainLossPct !== null && (
                              <span className="text-[10px] font-mono" style={{ color: data.gainLossPct >= 0 ? '#34d399' : '#f87171' }}>
                                {pct(data.gainLossPct)} P&L
                              </span>
                            )}
                            {data.daysToEarnings !== null && data.daysToEarnings <= 14 && (
                              <span className="text-[10px] font-mono" style={{ color: '#fbbf24' }}>⚡ earnings {data.daysToEarnings}d</span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => router.push(`/?ticker=${pos.ticker}`)}
                          className="text-[10px] font-mono px-2 py-1 rounded-lg transition-all hover:opacity-80"
                          style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
                          Analyze
                        </button>
                        <button onClick={() => removePosition(pos.ticker)}
                          className="p-1.5 rounded-lg transition-all hover:opacity-80"
                          style={{ background: 'rgba(248,113,113,0.08)', color: '#f87171' }}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Analyzing status */}
          {analyzing && (
            <div className="flex items-center gap-3 px-5 py-4 rounded-2xl"
              style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.2)' }}>
              <div className="flex gap-1">
                {[0,1,2].map(i => <span key={i} className="w-1.5 h-1.5 rounded-full thinking-dot" style={{ background: '#a78bfa', animationDelay: `${i*0.15}s` }} />)}
              </div>
              <span className="text-sm text-white/60 font-mono">{statusMsg}</span>
            </div>
          )}

          {/* Portfolio overview metrics */}
          {metrics && analysis && (
            <>
              {/* Score and headline */}
              <div className="rounded-2xl p-5 border-2"
                style={{ background: `${SIG_COLOR[analysis.overallSignal]}05`, borderColor: `${SIG_COLOR[analysis.overallSignal]}30` }}>
                <div className="flex items-start justify-between gap-4 mb-4">
                  <div>
                    <div className="flex items-center gap-2.5 mb-1">
                      <span className="text-sm font-bold" style={{ color: SIG_COLOR[analysis.overallSignal] }}>
                        {analysis.overallSignal === 'BULLISH' ? <TrendingUp size={16} className="inline mr-1" /> :
                         analysis.overallSignal === 'BEARISH' ? <TrendingDown size={16} className="inline mr-1" /> :
                         <Minus size={16} className="inline mr-1" />}
                        {analysis.overallSignal}
                      </span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                        style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)' }}>
                        {analysis.overallConviction} conviction
                      </span>
                    </div>
                    <h2 className="text-base font-bold text-white leading-snug">{analysis.headline}</h2>
                  </div>
                  <div className="text-center shrink-0">
                    <div className="text-3xl font-bold font-mono" style={{ color: analysis.portfolioScore >= 60 ? '#34d399' : analysis.portfolioScore >= 40 ? '#fbbf24' : '#f87171' }}>
                      {analysis.portfolioScore}
                    </div>
                    <div className="text-[10px] font-mono text-white/30">score /100</div>
                  </div>
                </div>
                <p className="text-sm text-white/70 leading-relaxed">{analysis.summary}</p>
              </div>

              {/* Key metrics row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Portfolio Value', val: fmtK(metrics.totalValue), color: 'white' },
                  { label: 'Total P&L', val: `${metrics.totalGainLoss >= 0 ? '+' : ''}${fmtK(Math.abs(metrics.totalGainLoss))} (${pct(metrics.totalGainLossPct)})`, color: metrics.totalGainLoss >= 0 ? '#34d399' : '#f87171' },
                  { label: 'Signal breakdown', val: `${metrics.signals.BULLISH}B · ${metrics.signals.NEUTRAL}N · ${metrics.signals.BEARISH}Be`, color: 'white' },
                  { label: 'Earnings in 30d', val: `${metrics.upcomingEarnings.length} position${metrics.upcomingEarnings.length !== 1 ? 's' : ''}`, color: metrics.upcomingEarnings.length > 0 ? '#fbbf24' : '#34d399' },
                ].map(m => (
                  <div key={m.label} className="rounded-xl p-3.5 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.07)' }}>
                    <div className="text-[10px] font-mono text-white/30 mb-1">{m.label}</div>
                    <div className="text-sm font-bold font-mono" style={{ color: m.color }}>{m.val}</div>
                  </div>
                ))}
              </div>

              {/* Top risks */}
              {analysis.topRisks.length > 0 && (
                <Section title="Top Risks" icon={<AlertTriangle size={14} />} color="#f87171">
                  <div className="space-y-2.5">
                    {analysis.topRisks.map((r, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 mt-0.5"
                          style={{ background: `${SEV_COLOR[r.severity]}15`, color: SEV_COLOR[r.severity] }}>
                          {r.severity}
                        </span>
                        <div>
                          <p className="text-sm text-white/70">{r.risk}</p>
                          <div className="flex gap-1 mt-1">
                            {r.tickers.map(t => (
                              <span key={t} className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                                style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' }}>{t}</span>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* Opportunities */}
              {analysis.opportunities.length > 0 && (
                <Section title="Opportunities" icon={<TrendingUp size={14} />} color="#34d399">
                  <div className="space-y-2.5">
                    {analysis.opportunities.map((o, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <span style={{ color: '#34d399' }}>▶</span>
                        <div>
                          <p className="text-sm text-white/70">{o.opportunity}</p>
                          <div className="flex gap-1 mt-1">
                            {o.tickers.map(t => (
                              <span key={t} className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                                style={{ background: 'rgba(52,211,153,0.1)', color: '#34d399' }}>{t}</span>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* Sector & earnings */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Section title="Sector Concentration" icon={<BarChart2 size={14} />} color="#a78bfa">
                  <div className="space-y-2 mb-3">
                    {metrics.sectorConcentration.slice(0, 5).map(s => (
                      <div key={s.sector}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-white/60">{s.sector}</span>
                          <span className="font-mono text-white/80">{s.pct.toFixed(1)}%</span>
                        </div>
                        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                          <div className="h-full rounded-full" style={{ width: `${s.pct}%`, background: s.pct > 40 ? '#f87171' : s.pct > 25 ? '#fbbf24' : '#a78bfa' }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-white/50 leading-relaxed">{analysis.sectorAnalysis}</p>
                </Section>

                <Section title="Earnings Watch" icon={<Calendar size={14} />} color="#fbbf24">
                  {metrics.upcomingEarnings.length === 0 ? (
                    <p className="text-sm text-white/40">No earnings in the next 30 days</p>
                  ) : (
                    <div className="space-y-2 mb-3">
                      {metrics.upcomingEarnings.map(p => (
                        <div key={p.ticker} className="flex items-center justify-between">
                          <span className="font-mono font-bold text-sm text-white">{p.ticker}</span>
                          <span className="text-xs font-mono" style={{ color: (p.daysToEarnings ?? 99) <= 7 ? '#f87171' : '#fbbf24' }}>
                            {p.earningsDate} ({p.daysToEarnings}d)
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-white/50 leading-relaxed">{analysis.earningsWatch}</p>
                </Section>
              </div>

              {/* Action plan */}
              <Section title="Action Plan" icon={<DollarSign size={14} />} color="#34d399">
                <p className="text-sm text-white/70 leading-relaxed mb-3">{analysis.actionPlan}</p>
                <div className="rounded-xl p-3.5" style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-white/30 mb-1.5">Rebalancing suggestions</div>
                  <p className="text-xs text-white/60 leading-relaxed">{analysis.rebalancingSuggestions}</p>
                </div>
              </Section>

              <p className="text-[10px] text-white/15 text-center leading-relaxed pb-4">
                Portfolio analysis is for informational purposes only. Not financial advice. Past performance does not guarantee future results.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
    {showTutorial && (
      <Tutorial config={PORTFOLIO_TUTORIAL} autoStart onComplete={() => setShowTutorial(false)} onSkip={() => setShowTutorial(false)} />
    )}
    </>
  )
}
