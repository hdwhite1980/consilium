'use client'

import { useState, useRef, useCallback, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'
import TechnicalCharts from '@/app/components/TechnicalCharts'
import OptionsRecommendations from '@/app/components/OptionsRecommendations'
import {
  TrendingUp, TrendingDown, Minus, Clock, AlertTriangle,
  BarChart2, Globe, DollarSign, Activity, Shield, Zap, LogOut, BookOpen
} from 'lucide-react'

type Signal = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
type Stage  = 'idle' | 'building' | 'gemini' | 'claude' | 'gpt' | 'judge' | 'done' | 'error'
type TF     = '1D' | '1W' | '1M' | '3M'
type Persona = 'balanced' | 'technical' | 'fundamental'

const PERSONAS: Record<Persona, { label: string; icon: string; color: string; desc: string }> = {
  balanced:    { label: 'Balanced',    icon: '⚖',  color: '#a78bfa', desc: 'Equal weight to technicals and fundamentals' },
  technical:   { label: 'Technical',   icon: '📈', color: '#60a5fa', desc: 'Follows price action and chart patterns' },
  fundamental: { label: 'Fundamental', icon: '📊', color: '#34d399', desc: 'Prioritizes business value and analyst consensus' },
}

interface Bar { t: string; o: number; h: number; l: number; c: number; v: number }
interface Scenario { label: string; probability: number; trigger: string }
interface SignalRow { category: string; signal: string; direction: string; weight: number; score: number }

interface MarketData {
  bars: Bar[]
  currentPrice: number
  technicals: {
    rsi: number; technicalBias: string; technicalScore: number
    sma50: number; sma200: number; ema9: number; ema20: number
    support: number; support2: number; resistance: number; resistance2: number
    goldenCross: boolean; ema9CrossEma20: string
    macdLine: number; macdSignal: number; macdHistogram: number; macdCrossover: string
    bbSignal: string; bbPosition: number; bbUpper: number; bbMiddle: number; bbLower: number
    stochK: number; stochD: number; stochSignal: string; stochCrossover: string
    vwap: number; priceVsVwap: number; vwapSignal: string
    obv: number; obvTrend: string; obvDivergence: string
    volumeRatio: number; priceChange1D: number
    fibLevels: Array<{ level: number; price: number; label: string; type: string }>
    nearestFibLevel: { level: number; price: number; label: string; type: string } | null
  }
  conviction: {
    direction: Signal; conviction: string; convergenceScore: number
    convergingSignals: number; divergingSignals: number
    scenarios: Scenario[]; regime: string
    signals: SignalRow[]; invalidationConditions: string[]
  }
  fundamentals: {
    earningsDate: string | null; daysToEarnings: number | null; earningsRisk: string
    analystConsensus: string; analystUpside: number | null
    analystBuy: number; analystHold: number; analystSell: number
    peRatio: number | null; consistentBeater: boolean; avgSurprisePct: number | null
    insiderSignal: string
  }
  smartMoney: {
    insiderSignal: string; congressSignal: string
    congressTrades: number; notableHolders: string[]
  }
  options: {
    putCallRatio: number | null; putCallSignal: string
    shortInterestPct: number | null; shortSignal: string
    unusualCount: number; ivSignal: string; maxPainStrike: number | null
  }
  marketContext: {
    regime: string
    spy: { change1D: number; changePeriod: number; trend: string }
    vix: { level: number; signal: string; description: string }
    sectorETF: string
    competitors: Array<{ ticker: string; change1D: number; changePeriod: number }>
  }
}

interface GeminiResult {
  summary: string; headlines: string[]; sentiment: string
  confidence: number; keyEvents: string[]; macroFactors: string[]
  regimeAssessment: string
}

interface ClaudeResult {
  signal: Signal; reasoning: string; target: string; confidence: number
  technicalBasis: string; fundamentalBasis: string
  catalysts: string[]; keyRisks: string[]
}

interface GptResult {
  agrees: boolean; signal: Signal; reasoning: string; confidence: number
  challenges: string[]; alternateScenario: string; strongestCounterArgument: string
}

interface RebuttalResult {
  signal: Signal; confidence: number; rebuttal: string
  concedes: string[]; maintains: string[]; updatedTarget: string; finalStance: string
}

interface CounterResult {
  finalChallenge: string; yieldsOn: string[]; pressesOn: string[]; closingArgument: string
}

interface JudgeResult {
  signal: Signal; confidence: number; target: string; risk: string
  summary: string; winningArgument: string; dissent: string
  scenarios: Scenario[]; invalidationTrigger: string; rounds: number
  entryPrice: string; stopLoss: string; takeProfit: string; timeHorizon: string
  plainEnglish: string; technicalsExplained: string
  fundamentalsExplained: string; smartMoneyExplained: string; actionPlan: string; optionsStrategy?: string
}

const SIG_COLOR: Record<Signal, string> = { BULLISH: '#34d399', BEARISH: '#f87171', NEUTRAL: '#fbbf24' }
const SIG_BG: Record<Signal, string> = {
  BULLISH: 'rgba(52,211,153,0.1)', BEARISH: 'rgba(248,113,113,0.1)', NEUTRAL: 'rgba(251,191,36,0.1)'
}
const pct = (n: number | undefined | null) => { const v = Number(n ?? 0); return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` }

function SBadge({ s, sm }: { s: Signal; sm?: boolean }) {
  const Icon = s === 'BULLISH' ? TrendingUp : s === 'BEARISH' ? TrendingDown : Minus
  return (
    <span style={{ background: SIG_BG[s], color: SIG_COLOR[s], border: `1px solid ${SIG_COLOR[s]}30` }}
      className={`inline-flex items-center gap-1 rounded-full font-mono font-semibold ${sm ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2.5 py-1'}`}>
      <Icon size={sm ? 9 : 11} />{s}
    </span>
  )
}

function Bar2({ val, color, label }: { val: number; color: string; label?: string }) {
  return (
    <div className="flex items-center gap-2 mt-1.5">
      {label && <span className="text-[10px] font-mono text-white/30 w-14 shrink-0">{label}</span>}
      <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)' }}>
        <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${Math.min(val, 100)}%`, background: color }} />
      </div>
      <span className="text-[10px] font-mono text-white/40 w-7 text-right">{val}%</span>
    </div>
  )
}

function Spark({ bars }: { bars: Bar[] }) {
  if (bars.length < 2) return null
  const closes = bars.map(b => b.c)
  const mn = Math.min(...closes), mx = Math.max(...closes), rng = mx - mn || 1
  const W = 180, H = 44
  const pts = closes.map((c, i) => `${(i / (closes.length - 1)) * W},${H - ((c - mn) / rng) * H}`).join(' ')
  const up = closes[closes.length - 1] >= closes[0]
  return (
    <svg width={W} height={H} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={up ? '#34d399' : '#f87171'} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function Chip({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-block text-[10px] font-mono px-2 py-0.5 rounded-full"
      style={{ background: `${color}18`, color, border: `1px solid ${color}28` }}>
      {label}
    </span>
  )
}

function Card({ title, icon, color, children }: { title: string; icon: React.ReactNode; color: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-3 space-y-2.5" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.07)' }}>
      <div className="flex items-center gap-1.5">
        <span style={{ color }}>{icon}</span>
        <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color }}>{title}</span>
      </div>
      {children}
    </div>
  )
}

function Think({ label, color }: { label: string; color: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <div className="flex gap-1">
        {[0, 1, 2].map(i => (
          <span key={i} className="w-1.5 h-1.5 rounded-full thinking-dot" style={{ background: color, animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
      <span className="text-xs font-mono text-white/25">{label} is thinking…</span>
    </div>
  )
}

function Collapsible({
  title, icon, color, badge, defaultOpen = false, children
}: {
  title: string; icon: React.ReactNode; color: string; badge?: React.ReactNode
  defaultOpen?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-xl border overflow-hidden"
      style={{ borderColor: open ? `${color}30` : 'rgba(255,255,255,0.07)', background: '#111620' }}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left transition-all hover:bg-white/[0.02]">
        <span style={{ color }}>{icon}</span>
        <span className="text-sm font-semibold text-white flex-1">{title}</span>
        {badge}
        <span className="text-white/25 text-xs ml-auto">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          {children}
        </div>
      )}
    </div>
  )
}

function HomeInner() {
  const [ticker, setTicker]     = useState('AAPL')
  const [tf, setTf]             = useState<TF>('1W')
  const [persona, setPersona]   = useState<Persona>('balanced')
  const [stage, setStage]       = useState<Stage>('idle')
  const [statusMsg, setStatus]  = useState('')
  const [md, setMd]             = useState<MarketData | null>(null)
  const [gem, setGem]           = useState<GeminiResult | null>(null)
  const [cla, setCla]           = useState<ClaudeResult | null>(null)
  const [gpt, setGpt]           = useState<GptResult | null>(null)
  const [reb, setReb]           = useState<RebuttalResult | null>(null)
  const [ctr, setCtr]           = useState<CounterResult | null>(null)
  const [jud, setJud]           = useState<JudgeResult | null>(null)
  const [err, setErr]           = useState<string | null>(null)
  const [cached, setCached]     = useState<{ at: string; ageMinutes: number } | null>(null)

  const router = useRouter()
  const searchParams = useSearchParams()
  const debateRef = useRef<HTMLDivElement>(null)
  const [userEmail, setUserEmail] = useState<string | null>(null)
  const [subStatus, setSubStatus] = useState<{ status: string; daysLeft: number | null } | null>(null)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data }) => {
      setUserEmail(data.user?.email ?? null)
      if (data.user) {
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('status, trial_ends_at, is_exempt')
          .eq('user_id', data.user.id)
          .single()
        if (sub) {
          if (sub.is_exempt) {
            setSubStatus({ status: 'exempt', daysLeft: null })
          } else {
            const daysLeft = sub.status === 'trialing' && sub.trial_ends_at
              ? Math.max(0, Math.ceil((new Date(sub.trial_ends_at).getTime() - Date.now()) / 86400000))
              : null
            setSubStatus({ status: sub.status, daysLeft })
          }
        }
      }
    })
  }, [])

  const handleSignOut = async () => {
    // Clear server session record first
    await fetch('/api/auth/session', { method: 'DELETE' })
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }
  const abortRef  = useRef<AbortController | null>(null)
  const scroll    = useCallback(() => setTimeout(() => debateRef.current?.scrollTo({ top: 99999, behavior: 'smooth' }), 80), [])

  // Persist last result to sessionStorage so navigation away and back restores it
  useEffect(() => {
    if (stage === 'done' && md && gem && jud) {
      try {
        sessionStorage.setItem('consilium_last', JSON.stringify({
          ticker, tf, stage, md, gem, cla, gpt, reb, ctr, jud, cached
        }))
      } catch { /* storage full or unavailable */ }
    }
  }, [stage, md, gem, cla, gpt, jud, ticker, tf, cached])

  // Restore last result on mount (if no ticker param in URL)
  useEffect(() => {
    const urlTicker = searchParams.get('ticker')
    if (!urlTicker) {
      try {
        const saved = sessionStorage.getItem('consilium_last')
        if (saved) {
          const s = JSON.parse(saved)
          setTicker(s.ticker ?? 'AAPL')
          setTf(s.tf ?? '1W')
          setStage(s.stage ?? 'idle')
          setMd(s.md ?? null)
          setGem(s.gem ?? null)
          setCla(s.cla ?? null)
          setGpt(s.gpt ?? null)
          setReb(s.reb ?? null)
          setCtr(s.ctr ?? null)
          setJud(s.jud ?? null)
          setCached(s.cached ?? null)
        }
      } catch { /* ignore parse errors */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-populate ticker from URL param (e.g. from news page)
  useEffect(() => {
    const t = searchParams.get('ticker')
    if (t) setTicker(t.toUpperCase())
  }, [searchParams])

  const run = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setStage('building'); setStatus(''); setMd(null); setGem(null); setCla(null); setGpt(null); setReb(null); setCtr(null); setJud(null); setErr(null); setCached(null)

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: ticker.toUpperCase(), timeframe: tf, forceRefresh: false, persona }),
        signal: abortRef.current.signal,
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
          const ev   = part.split('\n').find(l => l.startsWith('event:'))?.replace('event:', '').trim()
          const data = (() => { try { return JSON.parse(part.split('\n').find(l => l.startsWith('data:'))?.replace('data:', '').trim() || '{}') } catch { return {} } })()
          switch (ev) {
            case 'status':       setStatus(data.message); break
            case 'market_data':  setMd(data); break
            case 'gemini_start': setStage('gemini'); scroll(); break
            case 'gemini_done':  setGem(data); scroll(); break
            case 'claude_start': setStage('claude'); scroll(); break
            case 'claude_done':  setCla(data); scroll(); break
            case 'gpt_start':    setStage('gpt'); scroll(); break
            case 'gpt_done':     setGpt(data); scroll(); break
            case 'rebuttal_start': setStage('rebuttal' as Stage); scroll(); break
            case 'rebuttal_done':  setReb(data); scroll(); break
            case 'counter_start':  setStage('counter' as Stage); scroll(); break
            case 'counter_done':   setCtr(data); scroll(); break
            case 'judge_start':  setStage('judge'); scroll(); break
            case 'judge_done':   setJud(data); scroll(); break
            case 'complete':     setStage('done'); if (data.cached) setCached({ at: data.cachedAt, ageMinutes: data.ageMinutes }); scroll(); break
            case 'error':        setStage('error'); setErr(data.message); break
          }
        }
      }
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') { setStage('error'); setErr((e as Error).message) }
    }
  }, [ticker, tf, persona, scroll])

  const running = !['idle', 'done', 'error'].includes(stage)

  const forceRun = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setStage('building'); setStatus(''); setMd(null); setGem(null); setCla(null); setGpt(null); setReb(null); setCtr(null); setJud(null); setErr(null); setCached(null)
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: ticker.toUpperCase(), timeframe: tf, forceRefresh: true, persona }),
        signal: abortRef.current.signal,
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
          const ev   = part.split('\n').find(l => l.startsWith('event:'))?.replace('event:', '').trim()
          const data = (() => { try { return JSON.parse(part.split('\n').find(l => l.startsWith('data:'))?.replace('data:', '').trim() || '{}') } catch { return {} } })()
          switch (ev) {
            case 'status':       setStatus(data.message); break
            case 'market_data':  setMd(data); break
            case 'gemini_start': setStage('gemini'); scroll(); break
            case 'gemini_done':  setGem(data); scroll(); break
            case 'claude_start': setStage('claude'); scroll(); break
            case 'claude_done':  setCla(data); scroll(); break
            case 'gpt_start':    setStage('gpt'); scroll(); break
            case 'gpt_done':     setGpt(data); scroll(); break
            case 'rebuttal_start': setStage('rebuttal' as Stage); scroll(); break
            case 'rebuttal_done':  setReb(data); scroll(); break
            case 'counter_start':  setStage('counter' as Stage); scroll(); break
            case 'counter_done':   setCtr(data); scroll(); break
            case 'judge_start':  setStage('judge'); scroll(); break
            case 'judge_done':   setJud(data); scroll(); break
            case 'complete':     setStage('done'); scroll(); break
            case 'error':        setStage('error'); setErr(data.message); break
          }
        }
      }
    } catch (e: unknown) {
      if ((e as Error).name !== 'AbortError') { setStage('error'); setErr((e as Error).message) }
    }
  }, [ticker, tf, persona, scroll])
  const finalSig = jud?.signal ?? cla?.signal ?? md?.conviction?.direction

  return (
    <div className="flex flex-col min-h-screen md:h-screen md:overflow-hidden" style={{ background: '#0a0d12' }}>

      {/* Header */}
      <header className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-b shrink-0"
        style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.07)' }}>
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center text-sm font-bold text-white"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>Σ</div>
          <div>
            <div className="text-sm font-bold tracking-tight leading-none">CONSILIUM</div>
            <div className="text-[9px] font-mono text-white/20 mt-0.5">Signal Convergence Engine v2</div>
          </div>
        </div>

        <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && !running && run()}
          placeholder="AAPL" maxLength={6}
          className="w-16 sm:w-20 rounded-lg px-3 py-1.5 text-sm font-mono font-semibold tracking-widest outline-none border"
          style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.12)', color: 'white' }} />

        <div className="flex gap-1">
          {(['1D','1W','1M','3M'] as TF[]).map(t => (
            <button key={t} onClick={() => setTf(t)}
              className="px-2.5 py-1.5 rounded-md text-xs font-mono border transition-all"
              style={{
                background: tf === t ? 'rgba(167,139,250,0.15)' : '#181e2a',
                borderColor: tf === t ? '#a78bfa' : 'rgba(255,255,255,0.08)',
                color: tf === t ? '#a78bfa' : 'rgba(255,255,255,0.3)',
              }}>{t}</button>
          ))}
        </div>

        {/* Persona selector */}
        <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
          {(Object.entries(PERSONAS) as [Persona, typeof PERSONAS[Persona]][]).map(([key, p]) => (
            <button key={key} onClick={() => setPersona(key)}
              title={p.desc}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-mono transition-all"
              style={{
                background: persona === key ? `${p.color}18` : 'transparent',
                color: persona === key ? p.color : 'rgba(255,255,255,0.3)',
                border: persona === key ? `1px solid ${p.color}35` : '1px solid transparent',
              }}>
              <span>{p.icon}</span>
              <span className="hidden sm:inline">{p.label}</span>
            </button>
          ))}
        </div>

        <button onClick={run} disabled={running}
          className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-95 disabled:opacity-40"
          style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
          {running ? 'Analyzing…' : 'Analyze'}
        </button>

        <button onClick={() => router.push('/news')}
          className="flex items-center gap-1.5 px-3 sm:px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all hover:opacity-80"
          style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.25)' }}>
          <Zap size={13} />
          <span className="hidden sm:inline">Today</span>
        </button>

        <button onClick={() => router.push('/tomorrow')}
          className="flex items-center gap-1.5 px-3 sm:px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all hover:opacity-80"
          style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.25)' }}>
          <span className="text-xs">📅</span>
          <span className="hidden sm:inline">Tomorrow</span>
        </button>

        <button onClick={() => router.push('/guide')}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm transition-all hover:opacity-80"
          style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}
          title="Help & FAQ">
          <BookOpen size={13} />
        </button>

        {running && <span className="text-xs font-mono text-white/25 truncate flex-1">{statusMsg}</span>}
        {cached && !running && (
          <div className="flex items-center gap-2 ml-2">
            <span className="flex items-center gap-1.5 text-[10px] font-mono px-2.5 py-1 rounded-full"
              style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.25)' }}>
              <span>⏱</span>
              Cached · {cached.ageMinutes}m ago
            </span>
            <button onClick={forceRun} disabled={running}
              className="text-[10px] font-mono px-2.5 py-1 rounded-full transition-all hover:opacity-80"
              style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.1)' }}>
              ↻ Refresh
            </button>
          </div>
        )}

        <div className="flex items-center gap-2 ml-auto shrink-0">
          {finalSig && <SBadge s={finalSig} />}
          <span className="w-1.5 h-1.5 rounded-full animate-pulse-dot"
            style={{ background: stage === 'done' ? '#34d399' : stage === 'error' ? '#f87171' : running ? '#fbbf24' : '#ffffff18' }} />
          {userEmail && (
            <div className="flex items-center gap-2 pl-2 border-l" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
              <button onClick={() => router.push('/settings')}
                className="text-[10px] font-mono text-white/25 hidden sm:block max-w-[120px] truncate hover:text-white/50 transition-colors"
                title="Account settings">
                {userEmail}
              </button>
              {subStatus?.status !== 'exempt' && subStatus?.status === 'trialing' && subStatus.daysLeft !== null && (
                <button onClick={async () => {
                  const res = await fetch('/api/stripe/checkout', { method: 'POST' })
                  const d = await res.json()
                  if (d.url) window.location.href = d.url
                }}
                  className="text-[10px] font-mono px-2.5 py-1 rounded-full transition-all hover:opacity-80 flex items-center gap-1"
                  style={{ background: subStatus.daysLeft <= 2 ? 'rgba(248,113,113,0.12)' : 'rgba(251,191,36,0.12)', color: subStatus.daysLeft <= 2 ? '#f87171' : '#fbbf24', border: `1px solid ${subStatus.daysLeft <= 2 ? 'rgba(248,113,113,0.3)' : 'rgba(251,191,36,0.25)'}` }}>
                  ⏳ {subStatus.daysLeft}d left — Subscribe
                </button>
              )}
              {subStatus?.status !== 'exempt' && subStatus?.status === 'active' && (
                <button onClick={async () => {
                  const res = await fetch('/api/stripe/portal', { method: 'POST' })
                  const d = await res.json()
                  if (d.url) window.location.href = d.url
                }}
                  className="text-[10px] font-mono px-2.5 py-1 rounded-full transition-all hover:opacity-80 hidden sm:flex items-center gap-1"
                  style={{ background: 'rgba(52,211,153,0.08)', color: '#34d399', border: '1px solid rgba(52,211,153,0.2)' }}>
                  ✓ Pro
                </button>
              )}
              <button onClick={handleSignOut}
                className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded-md transition-all hover:opacity-80"
                style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}
                title="Sign out">
                <LogOut size={10} />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="flex flex-col md:flex-row flex-1 md:overflow-hidden">

        {/* Left sidebar: signal dashboard */}
        <aside className="w-full md:w-60 md:shrink-0 flex flex-col gap-2.5 p-3.5 md:overflow-y-auto border-b md:border-b-0 md:border-r"
          style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.07)' }}>

          {/* Mobile: grid layout for sidebar cards */}
          <div className="grid grid-cols-2 md:grid-cols-1 gap-2.5">

          {/* Price + sparkline */}
          {md && (
            <div className="col-span-2 md:col-span-1 rounded-xl border p-3" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.07)' }}>
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="text-lg font-bold font-mono">${(md!.currentPrice ?? 0).toFixed(2)}</span>
                <span className="text-xs font-mono" style={{ color: md!.technicals?.priceChange1D >= 0 ? '#34d399' : '#f87171' }}>
                  {pct(md!.technicals?.priceChange1D)}
                </span>
                <span className="text-[9px] font-mono text-white/20 ml-auto">15m delay</span>
              </div>
              <Spark bars={md!.bars} />
            </div>
          )}

          {/* Conviction bar */}
          {md?.conviction && (
            <div className="rounded-xl border p-3 space-y-2" style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.07)' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Zap size={11} style={{ color: SIG_COLOR[(md!.conviction?.direction ?? 'NEUTRAL') as Signal] }} />
                  <span className="text-[10px] font-mono font-semibold" style={{ color: SIG_COLOR[(md!.conviction?.direction ?? 'NEUTRAL') as Signal] }}>
                    {md!.conviction?.direction ?? ''}
                  </span>
                </div>
                <span className="text-[10px] font-mono text-white/30 capitalize">{md!.conviction?.conviction?.replace('_',' ')}</span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)' }}>
                <div className="h-full rounded-full transition-all duration-1000"
                  style={{ width: `${((md!.conviction?.convergenceScore ?? 0) + 100) / 2}%`, background: SIG_COLOR[(md!.conviction?.direction ?? 'NEUTRAL') as Signal] }} />
              </div>
              <div className="flex justify-between text-[10px] font-mono">
                <span style={{ color: '#34d399' }}>{md!.conviction?.convergingSignals ?? 0} converging</span>
                <span style={{ color: '#f87171' }}>{md!.conviction?.divergingSignals ?? 0} diverging</span>
              </div>
            </div>
          )}

          {/* Technicals */}
          {md?.technicals && (
            <Card title="Technicals" icon={<BarChart2 size={11}/>} color="#a78bfa">
              {[
                ['RSI (14)', <span style={{ color: md!.technicals?.rsi > 70 ? '#f87171' : md!.technicals?.rsi < 30 ? '#34d399' : 'white' }}>{md!.technicals?.rsi.toFixed(1)}</span>],
                ['MACD', <span style={{ color: md!.technicals?.macdHistogram >= 0 ? '#34d399' : '#f87171' }}>{md!.technicals?.macdHistogram >= 0 ? '▲ pos' : '▼ neg'}</span>],
                ['MA cross', <span style={{ color: md!.technicals?.goldenCross ? '#34d399' : '#f87171' }}>{md!.technicals?.goldenCross ? 'Golden ✓' : 'Death ✗'}</span>],
                ['vs SMA200', <span style={{ color: md!.currentPrice >= md!.technicals?.sma200 ? '#34d399' : '#f87171' }}>{pct((md!.currentPrice / md!.technicals?.sma200 - 1) * 100)}</span>],
                ['Volume', <span>{md!.technicals?.volumeRatio.toFixed(1)}x avg</span>],
                ['Bollinger', <span>{md!.technicals?.bbSignal}</span>],
                ['Support', <span>${md!.technicals?.support.toFixed(2)}</span>],
                ['Resistance', <span>${md!.technicals?.resistance.toFixed(2)}</span>],
              ].map(([k, v]) => (
                <div key={String(k)} className="flex justify-between text-xs">
                  <span className="text-white/35">{k}</span>
                  <span className="font-mono text-[11px]">{v}</span>
                </div>
              ))}
            </Card>
          )}

          {/* Fundamentals */}
          {md?.fundamentals && (
            <Card title="Fundamentals" icon={<DollarSign size={11}/>} color="#60a5fa">
              {md!.fundamentals?.peRatio !== null && (
                <div className="flex justify-between text-xs"><span className="text-white/35">P/E</span><span className="font-mono">{md!.fundamentals?.peRatio.toFixed(1)}x</span></div>
              )}
              <div className="flex justify-between text-xs">
                <span className="text-white/35">Analysts</span>
                <span className="font-mono text-[10px]" style={{ color: '#60a5fa' }}>{md!.fundamentals?.analystConsensus.replace('_',' ')}</span>
              </div>
              {md!.fundamentals?.analystUpside !== null && (
                <div className="flex justify-between text-xs">
                  <span className="text-white/35">Upside</span>
                  <span className="font-mono" style={{ color: md!.fundamentals?.analystUpside >= 0 ? '#34d399' : '#f87171' }}>{pct(md!.fundamentals?.analystUpside)}</span>
                </div>
              )}
              {md!.fundamentals?.daysToEarnings !== null && (
                <div className="flex justify-between text-xs">
                  <span className="text-white/35">Earnings</span>
                  <span className="font-mono text-[10px]"
                    style={{ color: md!.fundamentals?.earningsRisk === 'high' ? '#f87171' : md!.fundamentals?.earningsRisk === 'moderate' ? '#fbbf24' : '#34d399' }}>
                    {md!.fundamentals?.daysToEarnings}d — {md!.fundamentals?.earningsRisk}
                  </span>
                </div>
              )}
              <div className="flex justify-between text-xs">
                <span className="text-white/35">EPS record</span>
                <span className="font-mono text-[10px]" style={{ color: md!.fundamentals?.consistentBeater ? '#34d399' : '#fbbf24' }}>
                  {md!.fundamentals?.consistentBeater ? 'beater ✓' : 'mixed'}
                </span>
              </div>
            </Card>
          )}

          {/* Smart money */}
          {md?.smartMoney && (
            <Card title="Smart Money" icon={<Shield size={11}/>} color="#34d399">
              <div className="flex justify-between text-xs">
                <span className="text-white/35">Insiders</span>
                <Chip label={md!.smartMoney?.insiderSignal.replace('_',' ')}
                  color={md!.smartMoney?.insiderSignal.includes('buy') ? '#34d399' : md!.smartMoney?.insiderSignal.includes('sell') ? '#f87171' : '#fbbf24'} />
              </div>
              {md!.smartMoney?.congressSignal !== 'none' && (
                <div className="flex justify-between text-xs">
                  <span className="text-white/35">Congress</span>
                  <Chip label={`${md!.smartMoney?.congressSignal} (${md!.smartMoney?.congressTrades})`}
                    color={md!.smartMoney?.congressSignal === 'buying' ? '#34d399' : '#f87171'} />
                </div>
              )}
              {md!.smartMoney?.notableHolders.length > 0 && (
                <div className="text-[9px] text-white/30 leading-relaxed">{md!.smartMoney?.notableHolders.join(' · ')}</div>
              )}
            </Card>
          )}

          {/* Options */}
          {md?.options && (
            <Card title="Options Flow" icon={<Activity size={11}/>} color="#f87171">
              {md!.options?.putCallRatio !== null && (
                <div className="flex justify-between text-xs">
                  <span className="text-white/35">P/C ratio</span>
                  <span className="font-mono text-[10px]" style={{ color: md!.options?.putCallSignal === 'bullish' ? '#34d399' : md!.options?.putCallSignal === 'bearish' ? '#f87171' : 'white' }}>
                    {md!.options?.putCallRatio.toFixed(2)} — {md!.options?.putCallSignal}
                  </span>
                </div>
              )}
              {md!.options?.shortInterestPct !== null && (
                <div className="flex justify-between text-xs">
                  <span className="text-white/35">Short int.</span>
                  <span className="font-mono text-[10px]" style={{ color: md!.options?.shortInterestPct > 20 ? '#fbbf24' : 'white' }}>
                    {md!.options?.shortInterestPct.toFixed(1)}% float
                  </span>
                </div>
              )}
              {md!.options?.unusualCount > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-white/35">Sweeps</span>
                  <span className="font-mono text-[10px]" style={{ color: '#fbbf24' }}>{md!.options?.unusualCount} unusual</span>
                </div>
              )}
              {md!.options?.maxPainStrike && (
                <div className="flex justify-between text-xs">
                  <span className="text-white/35">Max pain</span>
                  <span className="font-mono text-[10px]">${md!.options?.maxPainStrike}</span>
                </div>
              )}
            </Card>
          )}

          {/* Market */}
          {md?.marketContext && (
            <Card title="Market" icon={<Globe size={11}/>} color="#fbbf24">
              <div className="text-[10px] font-mono mb-1" style={{ color: '#fbbf24' }}>
                {md!.marketContext?.regime.replace(/_/g,' ').toUpperCase()}
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-white/35">SPY</span>
                <span className="font-mono" style={{ color: md!.marketContext?.spy.change1D >= 0 ? '#34d399' : '#f87171' }}>
                  {pct(md!.marketContext?.spy.change1D)}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-white/35">VIX</span>
                <span className="font-mono" style={{ color: md!.marketContext?.vix.level > 25 ? '#f87171' : '#34d399' }}>
                  {md!.marketContext?.vix.level.toFixed(1)}
                </span>
              </div>
              {md!.marketContext?.competitors.slice(0,3).map(c => (
                <div key={c.ticker} className="flex justify-between text-xs">
                  <span className="text-white/30 font-mono">{c.ticker}</span>
                  <span className="font-mono text-[10px]" style={{ color: c.change1D >= 0 ? '#34d399' : '#f87171' }}>{pct(c.change1D)}</span>
                </div>
              ))}
            </Card>
          )}

          </div>{/* end sidebar grid */}
        </aside>

        {/* Main debate area */}
        <main className="flex-1 flex flex-col md:overflow-hidden">

          <div ref={debateRef} className="flex-1 md:overflow-y-auto p-3 sm:p-5 space-y-4">

            {cached && stage === 'done' && (
              <div className="flex items-center justify-between px-4 py-2.5 rounded-xl mb-1"
                style={{
                  background: cached.ageMinutes > 60 ? 'rgba(248,113,113,0.07)' : 'rgba(251,191,36,0.07)',
                  border: `1px solid ${cached.ageMinutes > 60 ? 'rgba(248,113,113,0.3)' : 'rgba(251,191,36,0.18)'}`,
                }}>
                <div className="flex items-center gap-2">
                  <span>{cached.ageMinutes > 60 ? '⚠' : '⏱'}</span>
                  <span className="text-xs text-white/60">
                    {cached.ageMinutes > 60
                      ? <><strong style={{ color: '#f87171' }}>Stale analysis — {cached.ageMinutes} minutes old.</strong> Price may have moved significantly. Run a fresh analysis.</>
                      : <>Cached analysis from <strong style={{ color: '#fbbf24' }}>{cached.ageMinutes} minute{cached.ageMinutes === 1 ? '' : 's'} ago</strong> — no AI credits used</>
                    }
                  </span>
                </div>
                <button onClick={forceRun}
                  className="text-[10px] font-mono px-3 py-1 rounded-full transition-all hover:opacity-80 shrink-0"
                  style={{
                    background: cached.ageMinutes > 60 ? 'rgba(248,113,113,0.15)' : 'rgba(251,191,36,0.15)',
                    color: cached.ageMinutes > 60 ? '#f87171' : '#fbbf24',
                    border: `1px solid ${cached.ageMinutes > 60 ? 'rgba(248,113,113,0.3)' : 'rgba(251,191,36,0.3)'}`,
                  }}>
                  ↻ Run fresh analysis
                </button>
              </div>
            )}

            {stage === 'idle' && (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                <div className="text-4xl opacity-60">📊</div>
                <div className="text-base font-semibold text-white/70">Enter a ticker and click Analyze</div>
              </div>
            )}

            {/* Gemini */}
            {stage === 'gemini' && !gem && <Think label="News Scout" color="#60a5fa" />}
            {gem && (
              <Collapsible
                title="News Scout"
                icon={<span className="text-xs font-bold">N</span>}
                color="#60a5fa"
                badge={<><span className="text-[10px] font-mono px-2 py-0.5 rounded-full" style={{ background: 'rgba(96,165,250,0.12)', color: '#60a5fa' }}>{gem.sentiment}</span><span className="text-[10px] font-mono text-white/20 ml-1">Stage 1</span></>}
                defaultOpen={false}>
              <div className="pt-2">
                <p className="text-sm text-white/70 leading-relaxed mb-3">{gem.summary}</p>
                <div className="space-y-1 mb-3">
                  {gem.headlines.map((h, i) => (
                    <div key={i} className="text-xs text-white/40 flex gap-1.5">
                      <span className="text-[8px] mt-0.5 shrink-0" style={{ color: '#60a5fa60' }}>●</span>{h}
                    </div>
                  ))}
                </div>
                {gem.keyEvents.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">{gem.keyEvents.map((e, i) => <Chip key={i} label={e} color="#60a5fa" />)}</div>
                )}
                <div className="text-xs italic text-white/30 border-t pt-2" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                  Regime: {gem.regimeAssessment}
                </div>
                <Bar2 val={gem.confidence} color="#60a5fa" label="confidence" />
              </div>
              </Collapsible>
            )}

            {/* Claude */}
            {stage === 'claude' && !cla && <Think label="Lead Analyst" color="#a78bfa" />}
            {cla && (
              <Collapsible
                title="Lead Analyst"
                icon={<span className="text-xs font-bold">L</span>}
                color="#a78bfa"
                badge={<><SBadge s={cla.signal} sm /><span className="text-[10px] font-mono text-white/20 ml-1">Stage 2</span></>}
                defaultOpen={false}>
              <div className="pt-2">
                <p className="text-sm text-white/70 leading-relaxed mb-3">{cla.reasoning}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                  <div className="text-xs"><div className="text-white/25 mb-1">Technical</div><div className="text-white/50 leading-relaxed">{cla.technicalBasis}</div></div>
                  <div className="text-xs"><div className="text-white/25 mb-1">Fundamental</div><div className="text-white/50 leading-relaxed">{cla.fundamentalBasis}</div></div>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-1.5">{cla.catalysts.map((c, i) => <Chip key={i} label={c} color="#a78bfa" />)}</div>
                <div className="flex flex-wrap gap-1.5">{cla.keyRisks.map((r, i) => <Chip key={i} label={`⚠ ${r}`} color="#f87171" />)}</div>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs font-mono" style={{ color: '#a78bfa' }}>Target: {cla.target}</span>
                </div>
                <Bar2 val={cla.confidence} color="#a78bfa" label="confidence" />
              </div>
              </Collapsible>
            )}

            {/* GPT */}
            {stage === 'gpt' && !gpt && <Think label="Devil's Advocate" color="#f87171" />}
            {gpt && (
              <Collapsible
                title="Devil's Advocate"
                icon={<span className="text-xs font-bold">D</span>}
                color="#f87171"
                badge={<>
                  <SBadge s={gpt.signal} sm />
                  <span className="text-[10px] font-mono ml-1" style={{ color: gpt.agrees ? '#34d399' : '#fbbf24' }}>
                    {gpt.agrees ? '✓ agrees' : '⚡ challenges'}
                  </span>
                  <span className="text-[10px] font-mono text-white/20 ml-1">Stage 3</span>
                </>}
                defaultOpen={false}>
              <div className="pt-2 space-y-3">
                <p className="text-sm text-white/70 leading-relaxed">{gpt.reasoning}</p>
                {gpt.challenges.length > 0 && (
                  <div className="space-y-1">
                    {gpt.challenges.map((c, i) => (
                      <div key={i} className="text-xs flex gap-1.5 text-white/45"><span style={{ color: '#fbbf24' }}>⚠</span>{c}</div>
                    ))}
                  </div>
                )}
                {gpt.strongestCounterArgument && (
                  <div className="text-xs italic text-white/30 border-t pt-2" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                    Strongest counter: {gpt.strongestCounterArgument}
                  </div>
                )}
                <Bar2 val={gpt.confidence} color="#f87171" label="confidence" />
              </div>
              </Collapsible>
            )}

            {/* Rebuttal */}
            {(stage as string) === 'rebuttal' && !reb && <Think label="Lead Analyst rebutting…" color="#a78bfa" />}
            {reb && (
              <Collapsible
                title="Lead Analyst — Rebuttal"
                icon={<span className="text-xs font-bold">L</span>}
                color="#a78bfa"
                badge={<><SBadge s={reb.signal} sm /><span className="text-[10px] font-mono text-white/20 ml-1">Round 2</span></>}
                defaultOpen={true}>
              <div className="pt-2 space-y-3">
                <p className="text-sm text-white/75 leading-relaxed">{reb.rebuttal}</p>
                {reb.concedes.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#f87171' }}>Concedes</div>
                    {reb.concedes.map((c, i) => <div key={i} className="text-xs text-white/55 flex gap-1.5 mb-1"><span style={{ color: '#f87171' }}>✓</span>{c}</div>)}
                  </div>
                )}
                {reb.maintains.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#a78bfa' }}>Stands firm on</div>
                    {reb.maintains.map((m, i) => <div key={i} className="text-xs text-white/55 flex gap-1.5 mb-1"><span style={{ color: '#a78bfa' }}>▶</span>{m}</div>)}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-white/30">Updated target:</span>
                  <span className="text-xs font-bold font-mono" style={{ color: '#a78bfa' }}>{reb.updatedTarget}</span>
                </div>
                <p className="text-xs italic text-white/35 border-l-2 pl-3" style={{ borderColor: 'rgba(167,139,250,0.35)' }}>{reb.finalStance}</p>
                <Bar2 val={reb.confidence} color="#a78bfa" label="confidence" />
              </div>
              </Collapsible>
            )}

            {/* Counter */}
            {(stage as string) === 'counter' && !ctr && <Think label="Devil's Advocate countering…" color="#f87171" />}
            {ctr && (
              <Collapsible
                title="Devil's Advocate — Final Counter"
                icon={<span className="text-xs font-bold">D</span>}
                color="#f87171"
                badge={<span className="text-[10px] font-mono text-white/20 ml-1">Round 2</span>}
                defaultOpen={true}>
              <div className="pt-2 space-y-3">
                <p className="text-sm text-white/75 leading-relaxed">{ctr.finalChallenge}</p>
                {ctr.yieldsOn.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#34d399' }}>Now agrees on</div>
                    {ctr.yieldsOn.map((y, i) => <div key={i} className="text-xs text-white/55 flex gap-1.5 mb-1"><span style={{ color: '#34d399' }}>✓</span>{y}</div>)}
                  </div>
                )}
                {ctr.pressesOn.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#f87171' }}>Still pressing</div>
                    {ctr.pressesOn.map((p, i) => <div key={i} className="text-xs text-white/55 flex gap-1.5 mb-1"><span style={{ color: '#fbbf24' }}>⚠</span>{p}</div>)}
                  </div>
                )}
                <p className="text-xs italic text-white/35 border-l-2 pl-3" style={{ borderColor: 'rgba(248,113,113,0.35)' }}>Closing: {ctr.closingArgument}</p>
              </div>
              </Collapsible>
            )}

            {/* Judge */}
            {stage === 'judge' && !jud && <Think label="Council" color="#fbbf24" />}
            {jud && (
              <div className="animate-slide-up rounded-xl p-5 border-2 space-y-4"
                style={{ background: 'rgba(251,191,36,0.03)', borderColor: 'rgba(251,191,36,0.28)' }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span style={{ color: '#fbbf24', fontSize: 15 }}>⚖</span>
                  <span className="text-sm font-bold" style={{ color: '#fbbf24' }}>Council Verdict</span>
                  <SBadge s={jud.signal} />
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                    style={{ background: `${PERSONAS[persona].color}12`, color: PERSONAS[persona].color, border: `1px solid ${PERSONAS[persona].color}25` }}>
                    {PERSONAS[persona].icon} {PERSONAS[persona].label}
                  </span>
                  <span className="ml-auto text-[10px] font-mono text-white/20">Final</span>
                </div>

                <p className="text-sm text-white/75 leading-relaxed">{jud.summary}</p>

                {/* ── TRADE PLAN — prominent, right under verdict ── */}
                {jud.entryPrice && (
                  <div className="rounded-2xl p-4 mt-1"
                    style={{ background: 'rgba(251,191,36,0.08)', border: '2px solid rgba(251,191,36,0.3)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-3" style={{ color: '#fbbf24' }}>
                      ⚡ Trade Plan
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {([
                        { label: 'Entry',        val: jud.entryPrice,   color: '#34d399',  icon: '▶',  bg: 'rgba(52,211,153,0.1)',   border: 'rgba(52,211,153,0.25)' },
                        { label: 'Stop Loss',    val: jud.stopLoss,     color: '#f87171',  icon: '✕',  bg: 'rgba(248,113,113,0.1)',  border: 'rgba(248,113,113,0.25)' },
                        { label: 'Take Profit',  val: jud.takeProfit,   color: '#fbbf24',  icon: '★',  bg: 'rgba(251,191,36,0.1)',   border: 'rgba(251,191,36,0.25)' },
                        { label: 'Time Horizon', val: jud.timeHorizon,  color: '#a78bfa',  icon: '◷',  bg: 'rgba(167,139,250,0.1)',  border: 'rgba(167,139,250,0.25)' },
                      ] as Array<{label:string;val:string;color:string;icon:string;bg:string;border:string}>).map(({ label, val, color, icon, bg, border }) => (
                        <div key={label} className="rounded-xl p-3 flex flex-col gap-1"
                          style={{ background: bg, border: `1px solid ${border}` }}>
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm" style={{ color }}>{icon}</span>
                            <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: `${color}99` }}>{label}</span>
                          </div>
                          <div className="text-sm font-bold leading-snug" style={{ color }}>{val}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="text-xs italic text-white/35 border-l-2 pl-3" style={{ borderColor: 'rgba(251,191,36,0.35)' }}>
                  {jud.winningArgument}
                </div>

                {jud.dissent && <div className="text-xs text-white/25 italic">Dissent: {jud.dissent}</div>}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {[
                    { label: 'Signal',   val: jud.signal,  color: SIG_COLOR[jud.signal] },
                    { label: 'Target',   val: jud.target,  color: '#e2e8f0' },
                    { label: 'Key Risk', val: jud.risk,    color: '#f87171' },
                  ].map(({ label, val, color }) => (
                    <div key={label} className="rounded-lg p-2.5 text-center border"
                      style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.07)' }}>
                      <div className="text-[9px] font-mono uppercase tracking-widest text-white/25 mb-1">{label}</div>
                      <div className="text-xs font-bold" style={{ color }}>{val}</div>
                    </div>
                  ))}
                </div>

                {jud.scenarios?.length > 0 && (
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-widest text-white/20 mb-2">Scenarios</div>
                    <div className="space-y-2">
                      {jud.scenarios.map(sc => {
                        const col = sc.label === 'bull' ? '#34d399' : sc.label === 'bear' ? '#f87171' : '#fbbf24'
                        return (
                          <div key={sc.label} className="flex items-start gap-3">
                            <div className="w-14 shrink-0 text-right">
                              <div className="text-[10px] font-mono uppercase" style={{ color: col }}>{sc.label}</div>
                              <div className="text-base font-bold font-mono leading-none" style={{ color: col }}>{sc.probability}%</div>
                            </div>
                            <div className="flex-1">
                              <div className="h-1 rounded-full mb-1 overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                                <div className="h-full rounded-full" style={{ width: `${sc.probability}%`, background: col }} />
                              </div>
                              <div className="text-[10px] text-white/30 leading-relaxed">{sc.trigger}</div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {jud.invalidationTrigger && (
                  <div className="flex items-start gap-2 p-3 rounded-lg"
                    style={{ background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.18)' }}>
                    <AlertTriangle size={11} className="shrink-0 mt-0.5" style={{ color: '#f87171' }} />
                    <div>
                      <div className="text-[9px] font-mono uppercase tracking-widest text-white/25 mb-1">Invalidation trigger</div>
                      <div className="text-xs text-white/55">{jud.invalidationTrigger}</div>
                    </div>
                  </div>
                )}

                <Bar2 val={jud.confidence} color="#fbbf24" label="confidence" />

                {/* Plain English — always visible */}
                {jud.plainEnglish && (
                  <div className="rounded-xl p-4 space-y-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-2">Plain English</div>
                    <p className="text-sm text-white/80 leading-relaxed">{jud.plainEnglish}</p>
                  </div>
                )}

                {/* Action plan — always visible */}
                {jud.actionPlan && (
                  <div className="rounded-xl p-4" style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: '#fbbf24' }}>Action plan</div>
                    <p className="text-sm text-white/75 leading-relaxed">{jud.actionPlan}</p>
                  </div>
                )}

                {/* Collapsible deep-dive sections — inside the verdict card */}
                {(jud.technicalsExplained || jud.fundamentalsExplained || jud.smartMoneyExplained) && (
                  <Collapsible title="Signal Explanations" icon={<BarChart2 size={14}/>} color="#a78bfa">
                    <div className="space-y-3 pt-2">
                      {jud.technicalsExplained && (
                        <div className="rounded-lg p-3" style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
                          <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#a78bfa' }}>Technicals</div>
                          <p className="text-xs text-white/65 leading-relaxed">{jud.technicalsExplained}</p>
                        </div>
                      )}
                      {jud.fundamentalsExplained && (
                        <div className="rounded-lg p-3" style={{ background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.15)' }}>
                          <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#60a5fa' }}>Fundamentals</div>
                          <p className="text-xs text-white/65 leading-relaxed">{jud.fundamentalsExplained}</p>
                        </div>
                      )}
                      {jud.smartMoneyExplained && (
                        <div className="rounded-lg p-3" style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)' }}>
                          <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#34d399' }}>Smart Money</div>
                          <p className="text-xs text-white/65 leading-relaxed">{jud.smartMoneyExplained}</p>
                        </div>
                      )}
                    </div>
                  </Collapsible>
                )}

                {/* Council options view — collapsible */}
                {jud.optionsStrategy && (
                  <Collapsible title="Council Options View" icon={<span>⚖</span>} color="#a78bfa">
                    <p className="text-sm text-white/70 leading-relaxed pt-2">{jud.optionsStrategy}</p>
                  </Collapsible>
                )}
              </div>
            )}

            {/* Technical Charts — collapsible */}
            {stage === 'done' && md && (
              <Collapsible title="Technical Charts" icon={<BarChart2 size={14}/>} color="#a78bfa">
                <div className="pt-2">
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  <TechnicalCharts ticker={ticker} technicals={md.technicals as any} />
                </div>
              </Collapsible>
            )}

            {/* Options Recommendations — collapsible */}
            {stage === 'done' && jud && md && (
              <Collapsible title="Options Strategy" icon={<span>📊</span>} color="#34d399"
                badge={<span className="text-[10px] font-mono px-2 py-0.5 rounded-full ml-1" style={{ background: `${SIG_COLOR[jud.signal]}15`, color: SIG_COLOR[jud.signal], border: `1px solid ${SIG_COLOR[jud.signal]}25` }}>{jud.signal} on {ticker}</span>}>
                <div className="pt-2">
              <OptionsRecommendations
                ticker={ticker}
                currentPrice={md.currentPrice ?? 0}
                signal={jud.signal}
                timeHorizon={jud.timeHorizon ?? '2-4 weeks'}
                target={jud.target ?? ''}
                technicals={md.technicals ? {
                  technicalScore: md.technicals.technicalScore,
                  goldenCross: md.technicals.goldenCross,
                  rsi: md.technicals.rsi,
                } : null}
                verdict={jud.summary ?? ''}
              />
              </div>
              </Collapsible>
            )}


            {/* Signal matrix */}
            {stage === 'done' && (md?.conviction?.signals?.length ?? 0) > 0 && (
              <div className="animate-slide-up rounded-xl p-4 border"
                style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.06)' }}>
                <div className="text-[10px] font-mono uppercase tracking-widest text-white/20 mb-3">Signal matrix — {md!.conviction?.signals?.length ?? 0} signals analyzed</div>
                <div className="space-y-1">
                  {(md!.conviction?.signals ?? []).map((s, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: s.direction === 'bullish' ? '#34d399' : s.direction === 'bearish' ? '#f87171' : '#fbbf24' }} />
                      <span className="text-white/25 w-20 shrink-0 text-[10px] font-mono">{s.category}</span>
                      <span className="text-white/45 flex-1 text-[10px] truncate">{s.signal}</span>
                      <div className="w-14 h-1 rounded-full overflow-hidden shrink-0" style={{ background: 'rgba(255,255,255,0.05)' }}>
                        <div className="h-full rounded-full"
                          style={{
                            width: `${Math.abs(s.score / 10) * 100}%`,
                            background: s.direction === 'bullish' ? '#34d399' : s.direction === 'bearish' ? '#f87171' : '#fbbf24',
                          }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {err && (
              <div className="rounded-xl p-4 text-sm font-mono"
                style={{ background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.22)', color: '#f87171' }}>
                ⚠ {err}
              </div>
            )}
          </div>

          <div className="px-5 py-2 border-t shrink-0 flex items-center gap-2"
            style={{ borderColor: 'rgba(255,255,255,0.05)', background: '#111620' }}>
            <Clock size={9} className="text-white/12" />
            <span className="text-[9px] font-mono text-white/15">
              For informational purposes only. Not financial advice. AI models can be wrong. Always do your own research.
            </span>
          </div>
        </main>
      </div>
    </div>
  )
}

export default function Home() {
  return (
    <Suspense fallback={<div style={{ background: '#0a0d12', minHeight: '100vh' }} />}>
      <HomeInner />
    </Suspense>
  )
}
