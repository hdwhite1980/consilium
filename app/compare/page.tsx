'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Tutorial, TutorialLauncher, COMPARE_TUTORIAL } from '@/app/components/Tutorial'
import { ArrowLeft, TrendingUp, TrendingDown, Minus, ArrowRight } from 'lucide-react'

type Signal = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
type Persona = 'balanced' | 'technical' | 'fundamental'

interface JudgeResult {
  signal: Signal; confidence: number; target: string; risk: string
  summary: string; entryPrice: string; stopLoss: string; takeProfit: string
  timeHorizon: string; plainEnglish: string; actionPlan: string
  winningArgument: string; scenarios: Array<{ label: string; probability: number; trigger: string }>
  invalidationTrigger: string
}

interface ComparisonResult {
  winner: string
  winnerReason: string
  verdictA: Signal; verdictB: Signal
  riskRewardA: number; riskRewardB: number
  strengthsA: string[]; strengthsB: string[]
  weaknessesA: string[]; weaknessesB: string[]
  relativeValue: string
  recommendation: string
  ifYouCanOnlyPick: string
}

interface MarketData {
  ticker: string; currentPrice: number
  technicals: { rsi: number; macdHistogram: number; goldenCross: boolean; technicalScore: number }
  conviction: { direction: Signal; convergenceScore: number; convergingSignals: number; divergingSignals: number }
  fundamentals: { peRatio: number | null; analystConsensus: string; analystUpside: number | null; earningsRisk: string; daysToEarnings: number | null }
}

const SIG_COLOR: Record<Signal, string> = { BULLISH: '#34d399', BEARISH: '#f87171', NEUTRAL: '#fbbf24' }
const SIG_BG: Record<Signal, string> = { BULLISH: 'rgba(52,211,153,0.1)', BEARISH: 'rgba(248,113,113,0.1)', NEUTRAL: 'rgba(251,191,36,0.1)' }
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`

const PERSONAS: Record<Persona, { label: string; icon: string; color: string }> = {
  balanced:    { label: 'Balanced',    icon: '⚖',  color: '#a78bfa' },
  technical:   { label: 'Technical',   icon: '📈', color: '#60a5fa' },
  fundamental: { label: 'Fundamental', icon: '📊', color: '#34d399' },
}

function SigBadge({ s }: { s: Signal }) {
  const Icon = s === 'BULLISH' ? TrendingUp : s === 'BEARISH' ? TrendingDown : Minus
  return (
    <span className="inline-flex items-center gap-1 text-xs font-mono font-bold px-2.5 py-1 rounded-full"
      style={{ background: SIG_BG[s], color: SIG_COLOR[s], border: `1px solid ${SIG_COLOR[s]}30` }}>
      <Icon size={11} />{s}
    </span>
  )
}

function ScoreBar({ label, a, b, tickerA, tickerB }: { label: string; a: number; b: number; tickerA: string; tickerB: string }) {
  const max = Math.max(a, b, 1)
  return (
    <div className="mb-3">
      <div className="flex justify-between text-[10px] font-mono text-white/40 mb-1.5">
        <span>{tickerA}: {a.toFixed(1)}</span>
        <span className="text-white/60">{label}</span>
        <span>{tickerB}: {b.toFixed(1)}</span>
      </div>
      <div className="flex gap-1 items-center">
        <div className="flex-1 flex justify-end">
          <div className="h-2 rounded-full" style={{ width: `${(a/max)*100}%`, background: a >= b ? '#34d399' : '#475569' }} />
        </div>
        <div className="w-px h-3 bg-white/10 shrink-0" />
        <div className="flex-1">
          <div className="h-2 rounded-full" style={{ width: `${(b/max)*100}%`, background: b >= a ? '#34d399' : '#475569' }} />
        </div>
      </div>
    </div>

  )
}

export default function ComparePage() {
  const router = useRouter()
  const [tickerA, setTickerA] = useState('NVDA')
  const [tickerB, setTickerB] = useState('AMD')
  const [timeframe, setTimeframe] = useState<'1D'|'1W'|'1M'|'3M'>('1W')
  const [persona, setPersona] = useState<Persona>('balanced')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('')
  const [showTutorial, setShowTutorial] = useState(false)

  const [mdA, setMdA] = useState<MarketData | null>(null)
  const [mdB, setMdB] = useState<MarketData | null>(null)
  const [judgeA, setJudgeA] = useState<JudgeResult | null>(null)
  const [judgeB, setJudgeB] = useState<JudgeResult | null>(null)
  const [comparison, setComparison] = useState<ComparisonResult | null>(null)

  useEffect(() => {
    fetch('/api/tutorial?id=compare')
      .then(r => r.json())
      .then(({ progress }) => {
        if (!progress || (!progress.completed && !progress.skipped)) setShowTutorial(true)
      }).catch(() => {})
  }, [])

  useEffect(() => {
    const handler = (e: Event) => {
      const { tutorialId } = (e as CustomEvent).detail
      if (tutorialId === 'compare') {
        // Force remount by toggling off then on
        setShowTutorial(false)
        setTimeout(() => setShowTutorial(true), 0)
      }
    }
    window.addEventListener('consilium:launch_tutorial', handler)
    return () => window.removeEventListener('consilium:launch_tutorial', handler)
  }, [])

  const run = useCallback(async () => {
    if (!tickerA || !tickerB) return
    setRunning(true); setStatus(''); setMdA(null); setMdB(null); setJudgeA(null); setJudgeB(null); setComparison(null)

    const res = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickerA: tickerA.toUpperCase(), tickerB: tickerB.toUpperCase(), timeframe, persona }),
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
        if (ev === 'status') setStatus(d.message)
        if (ev === 'market_data_a') setMdA(d)
        if (ev === 'market_data_b') setMdB(d)
        if (ev === 'verdicts') { setJudgeA(d.judgeA); setJudgeB(d.judgeB) }
        if (ev === 'complete') {
          setJudgeA(d.judgeA); setJudgeB(d.judgeB); setComparison(d.comparison)
          setMdA(d.marketA); setMdB(d.marketB)
          setRunning(false)
        }
        if (ev === 'error') { setStatus(`Error: ${d.message}`); setRunning(false) }
      }
    }
  }, [tickerA, tickerB, timeframe, persona])

  return (
    <>
    <div className="flex flex-col min-h-screen" style={{ background: '#0a0d12', color: 'white' }}>
      <header className="flex items-center gap-3 px-4 py-3 border-b sticky top-0 z-10"
        style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.07)' }}>
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.1)' }} />
        <span className="text-sm font-bold">Head-to-Head</span>

        {/* Ticker inputs */}
        <div className="flex items-center gap-2 ml-2">
          <input value={tickerA} onChange={e => setTickerA(e.target.value.toUpperCase())} maxLength={6}
            placeholder="NVDA"
            className="w-16 rounded-lg px-2.5 py-1.5 text-sm font-mono font-bold tracking-widest text-center outline-none border"
            style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.12)', color: 'white' }} />
          <span className="text-white/30 text-xs">vs</span>
          <input value={tickerB} onChange={e => setTickerB(e.target.value.toUpperCase())} maxLength={6}
            placeholder="AMD"
            className="w-16 rounded-lg px-2.5 py-1.5 text-sm font-mono font-bold tracking-widest text-center outline-none border"
            style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.12)', color: 'white' }} />
        </div>

        {/* TF buttons */}
        <div className="flex gap-1">
          {(['1D','1W','1M','3M'] as const).map(t => (
            <button key={t} onClick={() => setTimeframe(t)}
              className="px-2 py-1.5 rounded-md text-xs font-mono border transition-all"
              style={{ background: timeframe === t ? 'rgba(167,139,250,0.15)' : '#181e2a', borderColor: timeframe === t ? '#a78bfa' : 'rgba(255,255,255,0.08)', color: timeframe === t ? '#a78bfa' : 'rgba(255,255,255,0.3)' }}>{t}</button>
          ))}
        </div>

        {/* Persona */}
        <div className="flex gap-1">
          {(Object.entries(PERSONAS) as [Persona, typeof PERSONAS[Persona]][]).map(([key, p]) => (
            <button key={key} onClick={() => setPersona(key)} title={p.label}
              className="px-2 py-1.5 rounded-md text-xs border transition-all"
              style={{ background: persona === key ? `${p.color}18` : '#181e2a', borderColor: persona === key ? p.color : 'rgba(255,255,255,0.08)', color: persona === key ? p.color : 'rgba(255,255,255,0.3)' }}>
              {p.icon}
            </button>
          ))}
        </div>

        <TutorialLauncher tutorialId="compare" label="How it works" />
        <button onClick={run} disabled={running || !tickerA || !tickerB}
          className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-40"
          style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
          {running ? 'Comparing…' : 'Compare'}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">

          {/* Idle state */}
          {!running && !judgeA && (
            <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
              <div className="text-5xl opacity-40">⚡</div>
              <div className="text-lg font-bold text-white/70">Head-to-head stock comparison</div>
              <p className="text-sm text-white/40 max-w-sm">Enter two tickers, pick your timeframe and analyst lens, then hit Compare. Get full analyses for both and a clear recommendation on which has better risk/reward right now.</p>
            </div>
          )}

          {/* Status */}
          {running && (
            <div className="flex items-center gap-3 px-5 py-4 rounded-2xl"
              style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.2)' }}>
              <div className="flex gap-1">
                {[0,1,2].map(i => <span key={i} className="w-1.5 h-1.5 rounded-full thinking-dot" style={{ background: '#a78bfa', animationDelay: `${i*0.15}s` }} />)}
              </div>
              <span className="text-sm text-white/60 font-mono">{status || 'Analyzing...'}</span>
            </div>
          )}

          {/* Side-by-side market data while loading */}
          {(mdA || mdB) && (
            <div className="grid grid-cols-2 gap-4">
              {[{ md: mdA, ticker: tickerA.toUpperCase() }, { md: mdB, ticker: tickerB.toUpperCase() }].map(({ md, ticker }) => (
                <div key={ticker} className="rounded-2xl border p-4 space-y-2" style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold text-lg text-white">{ticker}</span>
                    {md && <span className="font-mono text-white/60">${md.currentPrice.toFixed(2)}</span>}
                  </div>
                  {md && (
                    <>
                      <div className="flex items-center gap-2">
                        {md.conviction?.direction && <SigBadge s={md.conviction.direction} />}
                        <span className="text-[10px] font-mono text-white/30">{md.conviction?.convergingSignals ?? 0} converging</span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                        {[
                          ['RSI', md.technicals?.rsi?.toFixed(1) ?? 'N/A'],
                          ['MA cross', md.technicals?.goldenCross ? 'Golden ✓' : 'Death ✗'],
                          ['P/E', md.fundamentals?.peRatio ? `${md.fundamentals.peRatio.toFixed(1)}x` : 'N/A'],
                          ['Analysts', md.fundamentals?.analystConsensus ?? 'N/A'],
                        ].map(([k, v]) => (
                          <div key={k} className="flex justify-between">
                            <span className="text-white/30">{k}</span>
                            <span className="font-mono text-white/70">{v}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {!md && <div className="text-xs text-white/30 font-mono animate-pulse">Building data...</div>}
                </div>
              ))}
            </div>
          )}

          {/* Verdicts side by side */}
          {judgeA && judgeB && (
            <div className="grid grid-cols-2 gap-4">
              {[{ j: judgeA, ticker: tickerA.toUpperCase() }, { j: judgeB, ticker: tickerB.toUpperCase() }].map(({ j, ticker }) => (
                <div key={ticker} className="rounded-2xl border-2 p-4 space-y-3"
                  style={{ background: `${SIG_COLOR[j.signal]}04`, borderColor: `${SIG_COLOR[j.signal]}30` }}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold text-base text-white">{ticker}</span>
                    <SigBadge s={j.signal} />
                  </div>
                  <p className="text-xs text-white/60 leading-relaxed">{j.summary}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { l: 'Entry', v: j.entryPrice, c: '#34d399' },
                      { l: 'Stop', v: j.stopLoss, c: '#f87171' },
                      { l: 'Target', v: j.takeProfit, c: '#fbbf24' },
                      { l: 'Horizon', v: j.timeHorizon, c: '#a78bfa' },
                    ].map(({ l, v, c }) => (
                      <div key={l} className="rounded-lg p-2 border" style={{ background: `${c}08`, borderColor: `${c}20` }}>
                        <div className="text-[9px] font-mono uppercase tracking-widest mb-0.5" style={{ color: `${c}80` }}>{l}</div>
                        <div className="text-xs font-bold" style={{ color: c }}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)' }}>
                      <div className="h-full rounded-full" style={{ width: `${j.confidence}%`, background: SIG_COLOR[j.signal] }} />
                    </div>
                    <span className="text-[10px] font-mono text-white/40">{j.confidence}%</span>
                  </div>
                  <button onClick={() => router.push(`/?ticker=${ticker}`)}
                    className="w-full text-[10px] font-mono py-1.5 rounded-lg transition-all hover:opacity-80"
                    style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)' }}>
                    Full debate for {ticker} →
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Head-to-head comparison verdict */}
          {comparison && judgeA && judgeB && (
            <div className="rounded-2xl border-2 p-6 space-y-5"
              style={{ background: 'rgba(251,191,36,0.03)', borderColor: 'rgba(251,191,36,0.3)' }}>

              {/* Winner banner */}
              <div className="text-center">
                <div className="text-[10px] font-mono uppercase tracking-widest text-white/30 mb-2">Council recommendation</div>
                {comparison.winner === 'NEITHER' ? (
                  <div className="text-xl font-bold text-white/70">Neither — avoid both right now</div>
                ) : (
                  <div className="flex items-center justify-center gap-3">
                    <span className="text-2xl font-bold font-mono" style={{ color: '#fbbf24' }}>{comparison.winner}</span>
                    <span className="text-sm text-white/50">wins the comparison</span>
                  </div>
                )}
                <p className="text-sm text-white/60 mt-2 leading-relaxed">{comparison.winnerReason}</p>
              </div>

              {/* Risk/reward scores */}
              <div className="space-y-1">
                <ScoreBar label="Risk/Reward" a={comparison.riskRewardA} b={comparison.riskRewardB} tickerA={tickerA.toUpperCase()} tickerB={tickerB.toUpperCase()} />
                <ScoreBar label="Confidence" a={judgeA.confidence} b={judgeB.confidence} tickerA={tickerA.toUpperCase()} tickerB={tickerB.toUpperCase()} />
              </div>

              {/* Strengths & weaknesses */}
              <div className="grid grid-cols-2 gap-4">
                {[
                  { ticker: tickerA.toUpperCase(), strengths: comparison.strengthsA, weaknesses: comparison.weaknessesA },
                  { ticker: tickerB.toUpperCase(), strengths: comparison.strengthsB, weaknesses: comparison.weaknessesB },
                ].map(({ ticker, strengths, weaknesses }) => (
                  <div key={ticker} className="space-y-2">
                    <div className="text-xs font-bold font-mono text-white/60">{ticker}</div>
                    {strengths.map((s, i) => (
                      <div key={i} className="flex gap-2 text-xs text-white/55">
                        <span style={{ color: '#34d399' }}>+</span>{s}
                      </div>
                    ))}
                    {weaknesses.map((w, i) => (
                      <div key={i} className="flex gap-2 text-xs text-white/40">
                        <span style={{ color: '#f87171' }}>−</span>{w}
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {/* Relative value */}
              <div className="rounded-xl p-3.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-1.5">Relative valuation</div>
                <p className="text-xs text-white/60 leading-relaxed">{comparison.relativeValue}</p>
              </div>

              {/* Recommendation */}
              <div className="rounded-xl p-4" style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)' }}>
                <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#fbbf24' }}>Recommendation</div>
                <p className="text-sm text-white/75 leading-relaxed">{comparison.recommendation}</p>
              </div>

              {/* If you can only pick one */}
              <div className="flex items-start gap-3 px-4 py-3 rounded-xl" style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)' }}>
                <ArrowRight size={14} style={{ color: '#a78bfa', marginTop: 2, flexShrink: 0 }} />
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: '#a78bfa' }}>If you can only pick one</div>
                  <p className="text-sm font-semibold text-white/80">{comparison.ifYouCanOnlyPick}</p>
                </div>
              </div>
            </div>
          )}

          {judgeA && judgeB && comparison && (
            <p className="text-[10px] text-white/15 text-center pb-4">
              For informational purposes only. Not financial advice.
            </p>
          )}
        </div>
      </div>
    </div>
    {showTutorial && (
      <Tutorial config={COMPARE_TUTORIAL} autoStart onComplete={() => setShowTutorial(false)} onSkip={() => setShowTutorial(false)} />
    )}
    </>
  )
}
