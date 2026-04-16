'use client'

import { useState, useRef, useCallback, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'
import TechnicalCharts from '@/app/components/TechnicalCharts'
import OptionsRecommendations from '@/app/components/OptionsRecommendations'
import { useTheme } from '@/app/lib/theme'
import { Tutorial, TutorialLauncher, MAIN_TUTORIAL } from '@/app/components/Tutorial'
import {
  TrendingUp, TrendingDown, Minus, Clock, AlertTriangle,
  BarChart2, Globe, DollarSign, Activity, Shield, Zap, LogOut, BookOpen,
  Sun, Moon, Menu, X
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
    // New indicators
    atr14: number; atrPct: number; atrSignal: string
    stopLossATR: number; takeProfitATR: number
    roc10: number; roc20: number; rocSignal: string; momentum: number
    williamsR: number; williamsSignal: string
    cci: number; cciSignal: string
    ichimokuTenkan: number; ichimokuKijun: number
    ichimokuSignal: string; ichimokuCross: string
    relStrengthVsSector: number | null; relStrengthSignal: string
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
  signal: Signal; confidence: number
  researchQuestion: string; researchAnswer: string
  rebuttal: string
  concedes: string[]; maintains: string[]; updatedTarget: string; finalStance: string
}

interface CounterResult {
  researchQuestion: string; researchAnswer: string
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
      {label && <span className="text-[10px] font-mono w-14 shrink-0" style={{ color: 'var(--text3)' }}>{label}</span>}
      <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'var(--surface3)' }}>
        <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${Math.min(val, 100)}%`, background: color }} />
      </div>
      <span className="text-[10px] font-mono w-7 text-right" style={{ color: 'var(--text3)' }}>{val}%</span>
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

function Card({ title, icon, color, children, surf, brd, txt3 }: { title: string; icon: React.ReactNode; color: string; children: React.ReactNode; surf?: string; brd?: string; txt3?: string }) {
  return (
    <div className="rounded-xl border p-3 space-y-2.5" style={{ background: surf ?? '#181e2a', borderColor: brd ?? 'rgba(255,255,255,0.07)' }}>
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
      <span className="text-xs font-mono" style={{ color: 'var(--text3)' }}>{label} is thinking…</span>
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
      style={{ borderColor: open ? `${color}30` : 'var(--border)', background: 'var(--surface)' }}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left transition-all"
        style={{ ['--tw-bg-opacity' as string]: '1' }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
        <span style={{ color }}>{icon}</span>
        <span className="text-sm font-semibold flex-1" style={{ color: 'var(--text)' }}>{title}</span>
        {badge}
        <span className="text-xs ml-auto" style={{ color: 'var(--text3)' }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t" style={{ borderColor: 'var(--border)' }}>
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
  const { theme, toggle: toggleTheme } = useTheme()
  const [navOpen, setNavOpen] = useState(false)
  const [showTutorial, setShowTutorial] = useState(false)
  const [tutorialChecked, setTutorialChecked] = useState(false)

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

  // Auto-start tutorial on first visit
  useEffect(() => {
    if (tutorialChecked) return
    fetch('/api/tutorial?id=main')
      .then(r => r.json())
      .then(({ progress }) => {
        setTutorialChecked(true)
        // Show if never started or not completed/skipped
        if (!progress || (!progress.completed && !progress.skipped)) {
          setShowTutorial(true)
        }
      })
      .catch(() => setTutorialChecked(true))
  }, [tutorialChecked])

  // Listen for tutorial relaunch from TutorialLauncher button
  useEffect(() => {
    const handler = (e: Event) => {
      const { tutorialId } = (e as CustomEvent).detail
      if (tutorialId === 'main') {
        // Force remount by toggling off then on
        setShowTutorial(false)
        setTimeout(() => setShowTutorial(true), 0)
      }
    }
    window.addEventListener('consilium:launch_tutorial', handler)
    return () => window.removeEventListener('consilium:launch_tutorial', handler)
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

  // Stage progress steps
  const STEPS = [
    { key: 'building', label: 'Data' },
    { key: 'gemini',   label: 'News Scout' },
    { key: 'claude',   label: 'Lead Analyst' },
    { key: 'gpt',      label: 'Challenger' },
    { key: 'rebuttal', label: 'Rebuttal' },
    { key: 'counter',  label: 'Counter' },
    { key: 'judge',    label: 'Verdict' },
  ]
  const stepIdx = STEPS.findIndex(s => s.key === stage)
  const isDark = theme === 'dark'

  // Theme-aware inline style helpers
  const bg    = isDark ? '#0a0d12' : '#f0f2f7'
  const surf  = isDark ? '#111620' : '#ffffff'
  const surf2 = isDark ? '#181e2a' : '#f5f7fb'
  const brd   = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)'
  const brd2  = isDark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.15)'
  const txt   = isDark ? 'white' : '#0f172a'
  const txt2  = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
  const txt3  = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.35)'
  const inputBg = isDark ? '#181e2a' : '#f0f2f7'

  const NAV_ITEMS = [
    { label: 'Today', icon: '⚡', path: '/news',        color: '#fbbf24' },
    { label: 'Tomorrow', icon: '📅', path: '/tomorrow', color: '#a78bfa' },
    { label: 'Invest', icon: '🔥', path: '/invest',     color: '#f97316' },
    { label: 'Portfolio', icon: '💼', path: '/portfolio', color: '#34d399' },
    { label: 'Reinvest', icon: '💰', path: '/reinvestment', color: '#34d399' },
    { label: 'Macro', icon: '🌍', path: '/macro',       color: '#60a5fa' },
    { label: 'Compare', icon: '⚡', path: '/compare',   color: '#f87171' },
    { label: 'Academy', icon: '🎓', path: '/training',  color: '#a78bfa' },
    { label: 'Track Record', icon: '🏆', path: '/track-record', color: '#fbbf24' },
    { label: 'Guide', icon: '📖', path: '/guide',       color: txt3 },
  ]

  return (
    <>
    <div className="flex flex-col min-h-screen md:h-screen md:overflow-hidden" style={{ background: bg, color: txt }}>

      {/* ── Top nav bar ─────────────────────────────── */}
      <nav className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
        style={{ background: surf, borderColor: brd }}>

        {/* Logo */}
        <div className="flex items-center gap-2 shrink-0 mr-1">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center text-sm font-bold text-white shrink-0"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>Σ</div>
          <span className="text-sm font-bold tracking-tight hidden sm:block" style={{ color: txt }}>CONSILIUM</span>
        </div>

        {/* ── Analysis controls ── */}
        <div className="flex items-center gap-1.5 flex-1">
          <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase().replace(/[^A-Z/]/g, ''))}
            onKeyDown={e => { if (e.key === 'Enter' && !running) { setTicker(t => t.replace(/\//g, '')); setTimeout(run, 0) } }}
            placeholder="AAPL · EUR/USD · BTC" maxLength={7} data-tutorial="ticker-input"
            className="w-16 sm:w-20 rounded-lg px-2.5 py-1.5 text-sm font-mono font-bold tracking-widest outline-none border transition-colors"
            style={{ background: inputBg, borderColor: brd2, color: txt }} />

          <div className="flex gap-0.5" data-tutorial="timeframe-selector">
            {([
              { tf: '1D', label: '1D', title: 'Intraday — 15-min bars, same-day to next session targets' },
              { tf: '1W', label: '1W', title: 'Swing trade — hourly bars, 3-10 day targets' },
              { tf: '1M', label: '1M', title: 'Position trade — daily bars, 3-6 week targets' },
              { tf: '3M', label: '3M', title: 'Investment — daily bars, 6-13 week targets, fundamentals weighted heavily' },
            ] as { tf: TF; label: string; title: string }[]).map(({ tf: t, label, title }) => (
              <button key={t} onClick={() => setTf(t)} title={title}
                className="px-2 py-1.5 rounded-md text-xs font-mono border transition-all"
                style={{
                  background: tf === t ? 'rgba(167,139,250,0.15)' : inputBg,
                  borderColor: tf === t ? '#a78bfa' : brd,
                  color: tf === t ? '#a78bfa' : txt3,
                }}>{label}</button>
            ))}
          </div>

          {/* Persona selector */}
          <div className="flex items-center gap-0.5 rounded-lg p-0.5" data-tutorial="persona-selector" style={{ background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)', border: `1px solid ${brd}` }}>
            {(Object.entries(PERSONAS) as [Persona, typeof PERSONAS[Persona]][]).map(([key, p]) => (
              <button key={key} onClick={() => setPersona(key)} title={p.desc}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-mono transition-all"
                style={{
                  background: persona === key ? `${p.color}18` : 'transparent',
                  color: persona === key ? p.color : txt3,
                  border: persona === key ? `1px solid ${p.color}35` : '1px solid transparent',
                }}>
                <span>{p.icon}</span>
                <span className="hidden lg:inline">{p.label}</span>
              </button>
            ))}
          </div>

          <button onClick={run} disabled={running} data-tutorial="analyze-btn"
            className="px-3 sm:px-4 py-1.5 rounded-lg text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-95 disabled:opacity-40 shrink-0"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
            {running ? '…' : 'Analyze'}
          </button>
        </div>

        {/* ── Right side: nav links + user ── */}
        <div className="flex items-center gap-1.5 shrink-0">

          {/* Desktop nav links */}
          <div className="hidden md:flex items-center gap-0.5">
            {NAV_ITEMS.map(n => (
              <button key={n.path} onClick={() => router.push(n.path)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80"
                style={{ color: n.color, background: `${n.color}10`, border: `1px solid ${n.color}20` }}>
                <span className="text-[11px]">{n.icon}</span>
                <span className="hidden lg:inline">{n.label}</span>
              </button>
            ))}
            <TutorialLauncher tutorialId="main" />
          </div>

          {/* Theme toggle */}
          <button onClick={toggleTheme}
            className="p-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)', color: txt2, border: `1px solid ${brd}` }}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
            {isDark ? <Sun size={13} /> : <Moon size={13} />}
          </button>

          {/* Status dot */}
          <span className="w-1.5 h-1.5 rounded-full animate-pulse-dot shrink-0"
            style={{ background: stage === 'done' ? '#34d399' : stage === 'error' ? '#f87171' : running ? '#fbbf24' : brd2 }} />

          {/* User area */}
          {userEmail && (
            <div className="flex items-center gap-1.5 pl-1.5 border-l" style={{ borderColor: brd }}>
              {subStatus?.status !== 'exempt' && subStatus?.status === 'trialing' && subStatus.daysLeft !== null && (
                <button onClick={async () => { const r = await fetch('/api/stripe/checkout',{method:'POST'}); const d=await r.json(); if(d.url) window.location.href=d.url }}
                  className="text-[10px] font-mono px-2 py-1 rounded-full"
                  style={{ background: subStatus.daysLeft <= 2 ? 'rgba(248,113,113,0.12)' : 'rgba(251,191,36,0.12)', color: subStatus.daysLeft <= 2 ? '#f87171' : '#fbbf24', border: `1px solid ${subStatus.daysLeft <= 2 ? 'rgba(248,113,113,0.3)' : 'rgba(251,191,36,0.25)'}` }}>
                  ⏳ {subStatus.daysLeft}d
                </button>
              )}
              <button onClick={() => router.push('/settings')}
                className="text-[10px] font-mono hidden sm:block max-w-[100px] truncate hover:opacity-70 transition-opacity"
                style={{ color: txt3 }} title="Account settings">{userEmail}</button>
              <button onClick={handleSignOut}
                className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded-md transition-all hover:opacity-80"
                style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
                <LogOut size={10} />
              </button>
            </div>
          )}

          {/* Mobile menu toggle */}
          <button onClick={() => setNavOpen(!navOpen)}
            className="flex md:hidden p-1.5 rounded-lg transition-all"
            style={{ background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)', color: txt2, border: `1px solid ${brd}` }}>
            {navOpen ? <X size={14} /> : <Menu size={14} />}
          </button>
        </div>
      </nav>

      {/* Mobile nav drawer */}
      {navOpen && (
        <div className="md:hidden border-b px-3 py-2 flex flex-wrap gap-2" style={{ background: surf, borderColor: brd }}>
          {NAV_ITEMS.map(n => (
            <button key={n.path} onClick={() => { router.push(n.path); setNavOpen(false) }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{ color: n.color, background: `${n.color}12`, border: `1px solid ${n.color}25` }}>
              {n.icon} {n.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Stage progress bar ──────────────────────── */}
      {running && (
        <div className="px-3 py-2 border-b shrink-0" style={{ background: surf, borderColor: brd }}>
          <div className="flex items-center gap-1 max-w-2xl mx-auto">
            {STEPS.map((s, i) => {
              const done = stepIdx > i
              const active = stepIdx === i
              return (
                <div key={s.key} className="flex items-center gap-1 flex-1 min-w-0">
                  <div className="flex flex-col items-center gap-0.5 flex-1">
                    <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)' }}>
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: done ? '100%' : active ? '60%' : '0%', background: done ? '#34d399' : active ? '#a78bfa' : 'transparent' }} />
                    </div>
                    <span className="text-[8px] font-mono truncate w-full text-center"
                      style={{ color: done ? '#34d399' : active ? '#a78bfa' : txt3 }}>{s.label}</span>
                  </div>
                  {i < STEPS.length - 1 && <div className="w-2 h-px shrink-0" style={{ background: done ? '#34d399' : brd }} />}
                </div>
              )
            })}
          </div>
          {statusMsg && <p className="text-[10px] font-mono text-center mt-1" style={{ color: txt3 }}>{statusMsg}</p>}
        </div>
      )}

      {/* ── Cached / stale banner ────────────────────── */}
      {cached && stage === 'done' && (
        <div className="px-3 py-2 flex items-center justify-between border-b shrink-0"
          style={{
            background: cached.ageMinutes > 60 ? 'rgba(248,113,113,0.07)' : isDark ? 'rgba(251,191,36,0.06)' : 'rgba(251,191,36,0.08)',
            borderColor: cached.ageMinutes > 60 ? 'rgba(248,113,113,0.25)' : 'rgba(251,191,36,0.2)',
          }}>
          <span className="text-xs" style={{ color: txt2 }}>
            {cached.ageMinutes > 60
              ? <><strong style={{ color: '#f87171' }}>⚠ Stale — {cached.ageMinutes}m old.</strong> Price may have moved.</>
              : <>⏱ Cached analysis · {cached.ageMinutes}m ago</>
            }
          </span>
          <button onClick={forceRun}
            className="text-[10px] font-mono px-2.5 py-1 rounded-full transition-all hover:opacity-80"
            style={{ background: cached.ageMinutes > 60 ? 'rgba(248,113,113,0.15)' : 'rgba(251,191,36,0.15)', color: cached.ageMinutes > 60 ? '#f87171' : '#fbbf24', border: `1px solid ${cached.ageMinutes > 60 ? 'rgba(248,113,113,0.3)' : 'rgba(251,191,36,0.3)'}` }}>
            ↻ Refresh
          </button>
        </div>
      )}

      {/* ── Main layout: sidebar + debate ───────────── */}
      <div className="flex flex-col md:flex-row flex-1 md:overflow-hidden">

        {/* Left sidebar — only show when there's data */}
        {md && (
          <aside data-tutorial="sidebar" className="w-full md:w-56 lg:w-60 md:shrink-0 flex flex-col gap-2 p-3 md:overflow-y-auto border-b md:border-b-0 md:border-r"
            style={{ background: isDark ? '#0d1117' : '#f5f7fb', borderColor: brd }}>
          <div className="grid grid-cols-2 md:grid-cols-1 gap-2">

          {/* Price + sparkline */}
          <div className="col-span-2 md:col-span-1 rounded-xl border p-3" style={{ background: surf, borderColor: brd }}>
            <div className="flex items-baseline gap-2 mb-1.5">
              <span className="text-base font-bold font-mono" style={{ color: txt }}>
                {/* Forex rates need more decimal places */}
                {md!.currentPrice < 10 && md!.currentPrice > 0
                  ? (md!.currentPrice < 0.01 ? md!.currentPrice.toFixed(6) : md!.currentPrice.toFixed(4))
                  : `$${(md!.currentPrice ?? 0).toFixed(2)}`}
              </span>
              <span className="text-xs font-mono" style={{ color: md!.technicals?.priceChange1D >= 0 ? '#34d399' : '#f87171' }}>
                {((v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`)(md!.technicals?.priceChange1D)}
              </span>
              <span className="text-[9px] font-mono ml-auto" style={{ color: txt3 }}>live</span>
            </div>
            <Spark bars={md!.bars} />
          </div>

          {/* Conviction */}
          {md?.conviction && (
            <div className="rounded-xl border p-3 space-y-2" style={{ background: surf, borderColor: brd }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Zap size={11} style={{ color: SIG_COLOR[(md!.conviction?.direction ?? 'NEUTRAL') as Signal] }} />
                  <span className="text-[10px] font-mono font-semibold" style={{ color: SIG_COLOR[(md!.conviction?.direction ?? 'NEUTRAL') as Signal] }}>
                    {md!.conviction?.direction ?? ''}
                  </span>
                </div>
                <span className="text-[10px] font-mono capitalize" style={{ color: txt3 }}>{md!.conviction?.conviction?.replace('_',' ')}</span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)' }}>
                <div className="h-full rounded-full transition-all duration-1000"
                  style={{ width: `${((md!.conviction?.convergenceScore ?? 0) + 100) / 2}%`, background: SIG_COLOR[(md!.conviction?.direction ?? 'NEUTRAL') as Signal] }} />
              </div>
              <div className="flex justify-between text-[10px] font-mono">
                <span style={{ color: '#34d399' }}>{md!.conviction?.convergingSignals ?? 0} conv</span>
                <span style={{ color: '#f87171' }}>{md!.conviction?.divergingSignals ?? 0} div</span>
              </div>
            </div>
          )}

          {/* Technicals */}
          {md?.technicals && (
            <Card title="Technicals" icon={<BarChart2 size={11}/>} color="#a78bfa" surf={surf} brd={brd} txt3={txt3}>
              {([
                ['RSI', <span style={{ color: md!.technicals?.rsi > 70 ? '#f87171' : md!.technicals?.rsi < 30 ? '#34d399' : txt }}>{md!.technicals?.rsi?.toFixed(1)}</span>],
                ['MACD', <span style={{ color: md!.technicals?.macdHistogram >= 0 ? '#34d399' : '#f87171' }}>{md!.technicals?.macdHistogram >= 0 ? '▲ pos' : '▼ neg'}</span>],
                ['MA cross', (() => {
                    const t = md!.technicals
                    if (!t?.sma200 || !t?.sma50 || Math.abs(t.sma200 - t.sma50) / t.sma50 < 0.0001) {
                      return <span style={{ color: 'rgba(255,255,255,0.3)' }}>N/A</span>
                    }
                    return <span style={{ color: t.goldenCross ? '#34d399' : '#f87171' }}>{t.goldenCross ? 'Golden ✓' : 'Death ✗'}</span>
                  })()],
                ['vs SMA200', (() => {
                    const sma200 = md!.technicals?.sma200
                    if (!sma200 || sma200 <= 0) return <span style={{ color: 'rgba(255,255,255,0.3)' }}>N/A</span>
                    const pct = (md!.currentPrice / sma200 - 1) * 100
                    return <span style={{ color: pct >= 0 ? '#34d399' : '#f87171' }}>{(pct >= 0 ? '+' : '') + pct.toFixed(1) + '%'}</span>
                  })()],
                ['Williams %R', <span style={{ color: md!.technicals?.williamsR > -20 ? '#f87171' : md!.technicals?.williamsR < -80 ? '#34d399' : txt }}>{md!.technicals?.williamsR?.toFixed(1)}</span>],
                ['CCI', <span style={{ color: md!.technicals?.cci > 100 ? '#f87171' : md!.technicals?.cci < -100 ? '#34d399' : txt }}>{md!.technicals?.cci?.toFixed(0)}</span>],
                ['ATR(14)', <span style={{ color: txt }}>
                  {md!.currentPrice < 10
                    ? `${md!.technicals?.atr14?.toFixed(4)} (${md!.technicals?.atrPct?.toFixed(2)}%)`
                    : `$${md!.technicals?.atr14?.toFixed(2)} (${md!.technicals?.atrPct?.toFixed(1)}%)`}
                </span>],
                ['Ichimoku', <span style={{ color: md!.technicals?.ichimokuSignal === 'above_cloud' ? '#34d399' : md!.technicals?.ichimokuSignal === 'below_cloud' ? '#f87171' : '#fbbf24' }}>{(md!.technicals?.ichimokuSignal ?? 'N/A').replace(/_/g,' ')}</span>],
                ['ROC 10d', <span style={{ color: (md!.technicals?.roc10 ?? 0) >= 0 ? '#34d399' : '#f87171' }}>{md!.technicals?.roc10?.toFixed(1)}%</span>],
                ['Rel Str', <span style={{ color: (md!.technicals?.relStrengthVsSector ?? 0) > 0 ? '#34d399' : (md!.technicals?.relStrengthVsSector ?? 0) < 0 ? '#f87171' : txt }}>{md!.technicals?.relStrengthVsSector != null ? ((md!.technicals?.relStrengthVsSector >= 0 ? '+' : '') + md!.technicals?.relStrengthVsSector?.toFixed(1) + '%') : 'N/A'}</span>],
                ['Volume', <span style={{ color: txt }}>{md!.technicals?.volumeRatio?.toFixed(1)}x avg</span>],
                ['Bollinger', <span style={{ color: txt }}>{md!.technicals?.bbSignal}</span>],
                ['Support', <span style={{ color: txt }}>{md!.currentPrice < 10 ? md!.technicals?.support?.toFixed(4) : '$' + md!.technicals?.support?.toFixed(2)}</span>],
                ['Resist', <span style={{ color: txt }}>{md!.currentPrice < 10 ? md!.technicals?.resistance?.toFixed(4) : '$' + md!.technicals?.resistance?.toFixed(2)}</span>],
              ] as [string, React.ReactNode][]).map(([k, v]) => (
                <div key={k} className="flex justify-between text-xs">
                  <span style={{ color: txt3 }}>{k}</span>
                  <span className="font-mono text-[11px]">{v}</span>
                </div>
              ))}
            </Card>
          )}

          {/* Fundamentals */}
          {md?.fundamentals && (
            <Card title="Fundamentals" icon={<DollarSign size={11}/>} color="#60a5fa" surf={surf} brd={brd} txt3={txt3}>
              {md!.fundamentals?.peRatio !== null && (
                <div className="flex justify-between text-xs"><span style={{ color: txt3 }}>P/E</span><span className="font-mono" style={{ color: txt }}>{md!.fundamentals?.peRatio.toFixed(1)}x</span></div>
              )}
              <div className="flex justify-between text-xs">
                <span style={{ color: txt3 }}>Analysts</span>
                <span className="font-mono text-[10px]" style={{ color: '#60a5fa' }}>{md!.fundamentals?.analystConsensus.replace('_',' ')}</span>
              </div>
              {md!.fundamentals?.daysToEarnings !== null && (
                <div className="flex justify-between text-xs">
                  <span style={{ color: txt3 }}>Earnings</span>
                  <span className="font-mono text-[10px]" style={{ color: md!.fundamentals?.earningsRisk === 'high' ? '#f87171' : md!.fundamentals?.earningsRisk === 'moderate' ? '#fbbf24' : '#34d399' }}>
                    {md!.fundamentals?.daysToEarnings}d — {md!.fundamentals?.earningsRisk}
                  </span>
                </div>
              )}
            </Card>
          )}

          {/* Smart money */}
          {md?.smartMoney && (
            <Card title="Smart Money" icon={<Shield size={11}/>} color="#34d399" surf={surf} brd={brd} txt3={txt3}>
              <div className="flex justify-between text-xs">
                <span style={{ color: txt3 }}>Insiders</span>
                <Chip label={md!.smartMoney?.insiderSignal.replace('_',' ')}
                  color={md!.smartMoney?.insiderSignal.includes('buy') ? '#34d399' : md!.smartMoney?.insiderSignal.includes('sell') ? '#f87171' : '#fbbf24'} />
              </div>
              {md!.smartMoney?.notableHolders.length > 0 && (
                <div className="text-[9px] leading-relaxed" style={{ color: txt3 }}>{md!.smartMoney?.notableHolders.join(' · ')}</div>
              )}
            </Card>
          )}

          {/* Options */}
          {md?.options && (
            <Card title="Options Flow" icon={<Activity size={11}/>} color="#f87171" surf={surf} brd={brd} txt3={txt3}>
              {md!.options?.putCallRatio !== null && md!.options?.putCallRatio !== undefined ? (
                <div className="flex justify-between text-xs">
                  <span style={{ color: txt3 }}>P/C ratio</span>
                  <span className="font-mono text-[10px]" style={{ color: md!.options?.putCallSignal === 'bullish' ? '#34d399' : md!.options?.putCallSignal === 'bearish' ? '#f87171' : txt }}>
                    {md!.options?.putCallRatio.toFixed(2)} — {md!.options?.putCallSignal}
                  </span>
                </div>
              ) : (
                <div className="text-[10px]" style={{ color: txt3 }}>P/C ratio unavailable</div>
              )}
              {md!.options?.maxPainStrike != null && md!.options?.maxPainStrike > 0 && (
                <div className="flex justify-between text-xs">
                  <span style={{ color: txt3 }}>Max pain</span>
                  <span className="font-mono text-[10px]" style={{ color: txt }}>${md!.options?.maxPainStrike}</span>
                </div>
              )}
              {md!.options?.shortInterestPct != null && (
                <div className="flex justify-between text-xs">
                  <span style={{ color: txt3 }}>Short int.</span>
                  <span className="font-mono text-[10px]" style={{ color: txt }}>{md!.options?.shortInterestPct.toFixed(1)}% float</span>
                </div>
              )}
              {md!.options?.ivSignal && md!.options?.ivSignal !== 'normal' && (
                <div className="flex justify-between text-xs">
                  <span style={{ color: txt3 }}>IV skew</span>
                  <span className="font-mono text-[10px]" style={{ color: md!.options?.ivSignal === 'bearish_skew' ? '#f87171' : '#34d399' }}>{md!.options?.ivSignal?.replace('_', ' ')}</span>
                </div>
              )}
              {(md!.options?.unusualCount ?? 0) > 0 && (
                <div className="flex justify-between text-xs">
                  <span style={{ color: txt3 }}>Sweeps</span>
                  <span className="font-mono text-[10px]" style={{ color: '#fbbf24' }}>{md!.options?.unusualCount} unusual</span>
                </div>
              )}
            </Card>
          )}

          {/* Market */}
          {md?.marketContext && (
            <Card title="Market" icon={<Globe size={11}/>} color="#fbbf24" surf={surf} brd={brd} txt3={txt3}>
              <div className="text-[10px] font-mono mb-1" style={{ color: '#fbbf24' }}>
                {md!.marketContext?.regime.replace(/_/g,' ').toUpperCase()}
              </div>
              <div className="flex justify-between text-xs">
                <span style={{ color: txt3 }}>SPY</span>
                <span className="font-mono" style={{ color: md!.marketContext?.spy.change1D >= 0 ? '#34d399' : '#f87171' }}>
                  {((v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`)(md!.marketContext?.spy.change1D)}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span style={{ color: txt3 }}>VIX</span>
                <span className="font-mono" style={{ color: md!.marketContext?.vix.level > 25 ? '#f87171' : '#34d399' }}>
                  {md!.marketContext?.vix.level.toFixed(1)}
                </span>
              </div>
            </Card>
          )}

          </div>
          </aside>
        )}

        {/* Main debate area */}
        <main className="flex-1 flex flex-col md:overflow-hidden" style={{ background: 'var(--bg)' }}>

          <div ref={debateRef} className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-4">

            {cached && stage === 'done' && (
              <div className="flex items-center justify-between px-4 py-2.5 rounded-xl mb-1"
                style={{
                  background: cached.ageMinutes > 60 ? 'rgba(248,113,113,0.07)' : 'rgba(251,191,36,0.07)',
                  border: `1px solid ${cached.ageMinutes > 60 ? 'rgba(248,113,113,0.3)' : 'rgba(251,191,36,0.18)'}`,
                }}>
                <div className="flex items-center gap-2">
                  <span>{cached.ageMinutes > 60 ? '⚠' : '⏱'}</span>
                  <span className="text-xs" style={{ color: 'var(--text2)' }}>
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
                <div className="text-base font-semibold" style={{ color: 'var(--text2)' }}>Enter a ticker and click Analyze</div>
                <div className="text-xs font-mono" style={{ color: 'var(--text3)' }}>Stocks · Crypto · Forex (EUR/USD, GBP/JPY...)</div>
              </div>
            )}

            {/* News Scout */}
            {stage === 'gemini' && !gem && <Think label="News Scout" color="#60a5fa" />}
            {gem && (
              <Collapsible
                title="News Scout"
                icon={<span className="text-xs font-bold">N</span>}
                color="#60a5fa"
                badge={<><span className="text-[10px] font-mono px-2 py-0.5 rounded-full" style={{ background: 'rgba(96,165,250,0.12)', color: '#60a5fa' }}>{gem.sentiment}</span><span className="text-[10px] font-mono ml-1" style={{ color: 'var(--text3)' }}>Stage 1</span></>}
                defaultOpen={false}>
              <div className="pt-2">
                <p className="text-sm leading-relaxed mb-3" style={{ color: 'var(--text2)' }}>{gem.summary}</p>
                <div className="space-y-1 mb-3">
                  {gem.headlines.map((h, i) => (
                    <div key={i} className="text-xs flex gap-1.5" style={{ color: 'var(--text3)' }}>
                      <span className="text-[8px] mt-0.5 shrink-0" style={{ color: '#60a5fa60' }}>●</span>{h}
                    </div>
                  ))}
                </div>
                {gem.keyEvents.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">{gem.keyEvents.map((e, i) => <Chip key={i} label={e} color="#60a5fa" />)}</div>
                )}
                <div className="text-xs italic border-t pt-2" style={{ borderColor: 'var(--border)', color: 'var(--text3)' }}>
                  Regime: {gem.regimeAssessment}
                </div>
                <Bar2 val={gem.confidence} color="#60a5fa" label="confidence" />
              </div>
              </Collapsible>
            )}

            {/* Lead Analyst */}
            {stage === 'claude' && !cla && <Think label="Lead Analyst" color="#a78bfa" />}
            {cla && (
              <Collapsible
                title="Lead Analyst"
                icon={<span className="text-xs font-bold">L</span>}
                color="#a78bfa"
                badge={<><SBadge s={cla.signal} sm /><span className="text-[10px] font-mono ml-1" style={{ color: 'var(--text3)' }}>Stage 2</span></>}
                defaultOpen={false}>
              <div className="pt-2">
                <p className="text-sm leading-relaxed mb-3" style={{ color: 'var(--text2)' }}>{cla.reasoning}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                  <div className="text-xs"><div className="mb-1" style={{ color: 'var(--text3)' }}>Technical</div><div className="leading-relaxed" style={{ color: 'var(--text2)' }}>{cla.technicalBasis}</div></div>
                  <div className="text-xs"><div className="mb-1" style={{ color: 'var(--text3)' }}>Fundamental</div><div className="leading-relaxed" style={{ color: 'var(--text2)' }}>{cla.fundamentalBasis}</div></div>
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
                  <span className="text-[10px] font-mono ml-1" style={{ color: 'var(--text3)' }}>Stage 3</span>
                </>}
                defaultOpen={false}>
              <div className="pt-2 space-y-3">
                <p className="text-sm leading-relaxed" style={{ color: 'var(--text2)' }}>{gpt.reasoning}</p>
                {gpt.challenges.length > 0 && (
                  <div className="space-y-1">
                    {gpt.challenges.map((c, i) => (
                      <div key={i} className="text-xs flex gap-1.5" style={{ color: 'var(--text2)' }}><span style={{ color: '#fbbf24' }}>⚠</span>{c}</div>
                    ))}
                  </div>
                )}
                {gpt.strongestCounterArgument && (
                  <div className="text-xs italic border-t pt-2" style={{ borderColor: 'var(--border)', color: 'var(--text3)' }}>
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
                badge={<><SBadge s={reb.signal} sm /><span className="text-[10px] font-mono ml-1" style={{ color: 'var(--text3)' }}>Round 2</span></>}
                defaultOpen={true}>
              <div className="pt-2 space-y-3">
                {reb.researchQuestion && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: '#60a5fa' }}>🔍 News Scout consulted</div>
                    <div className="text-xs mb-1.5 italic" style={{ color: 'var(--text2)' }}>Q: {reb.researchQuestion}</div>
                    <div className="text-xs leading-relaxed" style={{ color: 'var(--text)' }}>{reb.researchAnswer}</div>
                  </div>
                )}
                <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{reb.rebuttal}</p>
                {reb.concedes.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#f87171' }}>Concedes</div>
                    {reb.concedes.map((c, i) => <div key={i} className="text-xs flex gap-1.5 mb-1" style={{ color: 'var(--text2)' }}><span style={{ color: '#f87171' }}>✓</span>{c}</div>)}
                  </div>
                )}
                {reb.maintains.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#a78bfa' }}>Stands firm on</div>
                    {reb.maintains.map((m, i) => <div key={i} className="text-xs flex gap-1.5 mb-1" style={{ color: 'var(--text2)' }}><span style={{ color: '#a78bfa' }}>▶</span>{m}</div>)}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>Updated target:</span>
                  <span className="text-xs font-bold font-mono" style={{ color: '#a78bfa' }}>{reb.updatedTarget}</span>
                </div>
                <p className="text-xs italic border-l-2 pl-3" style={{ color: 'var(--text3)', borderColor: 'rgba(167,139,250,0.35)' }}>{reb.finalStance}</p>
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
                badge={<span className="text-[10px] font-mono ml-1" style={{ color: 'var(--text3)' }}>Round 2</span>}
                defaultOpen={true}>
              <div className="pt-2 space-y-3">
                {ctr.researchQuestion && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: '#f87171' }}>🔍 News Scout consulted</div>
                    <div className="text-xs mb-1.5 italic" style={{ color: 'var(--text2)' }}>Q: {ctr.researchQuestion}</div>
                    <div className="text-xs leading-relaxed" style={{ color: 'var(--text)' }}>{ctr.researchAnswer}</div>
                  </div>
                )}
                <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{ctr.finalChallenge}</p>
                {ctr.yieldsOn.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#34d399' }}>Now agrees on</div>
                    {ctr.yieldsOn.map((y, i) => <div key={i} className="text-xs flex gap-1.5 mb-1" style={{ color: 'var(--text2)' }}><span style={{ color: '#34d399' }}>✓</span>{y}</div>)}
                  </div>
                )}
                {ctr.pressesOn.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#f87171' }}>Still pressing</div>
                    {ctr.pressesOn.map((p, i) => <div key={i} className="text-xs flex gap-1.5 mb-1" style={{ color: 'var(--text2)' }}><span style={{ color: '#fbbf24' }}>⚠</span>{p}</div>)}
                  </div>
                )}
                <p className="text-xs italic border-l-2 pl-3" style={{ color: 'var(--text3)', borderColor: 'rgba(248,113,113,0.35)' }}>Closing: {ctr.closingArgument}</p>
              </div>
              </Collapsible>
            )}

            {/* Judge */}
            {stage === 'judge' && !jud && <Think label="Council" color="#fbbf24" />}
            {jud && (
              <div className="animate-slide-up rounded-xl p-5 border-2 space-y-4"
                style={{ background: 'rgba(251,191,36,0.05)', borderColor: 'rgba(251,191,36,0.3)' }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span style={{ color: '#fbbf24', fontSize: 15 }}>⚖</span>
                  <span className="text-sm font-bold" style={{ color: '#fbbf24' }}>Council Verdict</span>
                  <SBadge s={jud.signal} />
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                    style={{ background: `${PERSONAS[persona].color}12`, color: PERSONAS[persona].color, border: `1px solid ${PERSONAS[persona].color}25` }}>
                    {PERSONAS[persona].icon} {PERSONAS[persona].label}
                  </span>
                  <span className="ml-auto text-[10px] font-mono" style={{ color: 'var(--text3)' }}>Final</span>
                </div>

                <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{jud.summary}</p>

                {/* ── TRADE PLAN — prominent, right under verdict ── */}
                {jud.entryPrice && (
                  <div className="rounded-2xl p-4 mt-1"
                    style={{ background: 'rgba(251,191,36,0.08)', border: '2px solid rgba(251,191,36,0.3)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-3" style={{ color: '#fbbf24' }}>
                      ⚡ Trade Plan
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {(() => {
                        const isBearish = jud.signal === 'BEARISH'
                        return ([
                          {
                            label: 'Entry',
                            val: jud.entryPrice,
                            color: isBearish ? '#f87171' : '#34d399',
                            icon: isBearish ? '▼' : '▶',
                            bg: isBearish ? 'rgba(248,113,113,0.1)' : 'rgba(52,211,153,0.1)',
                            border: isBearish ? 'rgba(248,113,113,0.25)' : 'rgba(52,211,153,0.25)',
                            hint: isBearish ? 'short / wait for drop' : 'buy zone',
                          },
                          {
                            label: 'Stop Loss',
                            val: jud.stopLoss,
                            color: '#f87171',
                            icon: '✕',
                            bg: 'rgba(248,113,113,0.1)',
                            border: 'rgba(248,113,113,0.25)',
                            hint: isBearish ? 'exit if price rises here' : 'exit if price falls here',
                          },
                          {
                            label: 'Take Profit',
                            val: jud.takeProfit,
                            color: '#34d399',
                            icon: '★',
                            bg: 'rgba(52,211,153,0.1)',
                            border: 'rgba(52,211,153,0.25)',
                            hint: isBearish ? 'target below entry' : 'target above entry',
                          },
                          {
                            label: 'Time Horizon',
                            val: jud.timeHorizon,
                            color: '#a78bfa',
                            icon: '◷',
                            bg: 'rgba(167,139,250,0.1)',
                            border: 'rgba(167,139,250,0.25)',
                            hint: '',
                          },
                        ] as Array<{label:string;val:string;color:string;icon:string;bg:string;border:string;hint:string}>)
                      })().map(({ label, val, color, icon, bg, border, hint }) => (
                        <div key={label} className="rounded-xl p-3 flex flex-col gap-1"
                          style={{ background: bg, border: `1px solid ${border}` }}>
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm" style={{ color }}>{icon}</span>
                            <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: `${color}99` }}>{label}</span>
                          </div>
                          <div className="text-sm font-bold leading-snug" style={{ color }}>{val}</div>
                          {hint && <div className="text-[10px] leading-snug" style={{ color: `${color}70` }}>{hint}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="text-xs italic border-l-2 pl-3" style={{ color: 'var(--text3)', borderColor: 'rgba(251,191,36,0.35)' }}>
                  {jud.winningArgument}
                </div>

                {jud.dissent && <div className="text-xs italic" style={{ color: 'var(--text3)' }}>Dissent: {jud.dissent}</div>}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {[
                    { label: 'Signal',   val: jud.signal,  color: SIG_COLOR[jud.signal] },
                    { label: 'Target',   val: jud.target,  color: '#e2e8f0' },
                    { label: 'Key Risk', val: jud.risk,    color: '#f87171' },
                  ].map(({ label, val, color }) => (
                    <div key={label} className="rounded-lg p-2.5 text-center border"
                      style={{ background: 'var(--surface2)', borderColor: 'var(--border)' }}>
                      <div className="text-[9px] font-mono uppercase tracking-widest mb-1" style={{ color: 'var(--text3)' }}>{label}</div>
                      <div className="text-xs font-bold" style={{ color }}>{val}</div>
                    </div>
                  ))}
                </div>

                {jud.scenarios?.length > 0 && (
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: 'var(--text3)' }}>Scenarios</div>
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
                              <div className="text-[10px] leading-relaxed" style={{ color: 'var(--text3)' }}>{sc.trigger}</div>
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
                      <div className="text-[9px] font-mono uppercase tracking-widest mb-1" style={{ color: 'var(--text3)' }}>Invalidation trigger</div>
                      <div className="text-xs" style={{ color: 'var(--text2)' }}>{jud.invalidationTrigger}</div>
                    </div>
                  </div>
                )}

                <Bar2 val={jud.confidence} color="#fbbf24" label="confidence" />

                {/* Plain English — always visible */}
                {jud.plainEnglish && (
                  <div className="rounded-xl p-4 space-y-2" style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: 'var(--text3)' }}>Plain English</div>
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{jud.plainEnglish}</p>
                  </div>
                )}

                {/* Action plan — always visible */}
                {jud.actionPlan && (
                  <div className="rounded-xl p-4" style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: '#fbbf24' }}>Action plan</div>
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{jud.actionPlan}</p>
                  </div>
                )}

                {/* Log Trade CTA */}
                {jud.signal && (jud.signal === 'BULLISH' || jud.signal === 'NEUTRAL') && (
                  <div className="flex items-center justify-between gap-3 px-1">
                    <p className="text-xs" style={{ color: 'var(--text3)' }}>
                      Acted on this analysis? Track your trade and get reinvestment ideas.
                    </p>
                    <button
                      onClick={() => {
                        const entryPrice = md?.currentPrice ?? 0
                        const params = new URLSearchParams({
                          ticker,
                          price: entryPrice.toFixed(2),
                          signal: jud.signal,
                          confidence: String(jud.confidence),
                        })
                        router.push(`/reinvestment?${params}`)
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold shrink-0 transition-all hover:opacity-80"
                      style={{ background: 'rgba(52,211,153,0.1)', color: '#34d399', border: '1px solid rgba(52,211,153,0.2)' }}>
                      💰 Log trade
                    </button>
                  </div>
                )}

                {/* Collapsible deep-dive sections — inside the verdict card */}
                {(jud.technicalsExplained || jud.fundamentalsExplained || jud.smartMoneyExplained) && (
                  <Collapsible title="Signal Explanations" icon={<BarChart2 size={14}/>} color="#a78bfa">
                    <div className="space-y-3 pt-2">
                      {jud.technicalsExplained && (
                        <div className="rounded-lg p-3" style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
                          <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#a78bfa' }}>Technicals</div>
                          <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>{jud.technicalsExplained}</p>
                        </div>
                      )}
                      {jud.fundamentalsExplained && (
                        <div className="rounded-lg p-3" style={{ background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.15)' }}>
                          <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#60a5fa' }}>Fundamentals</div>
                          <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>{jud.fundamentalsExplained}</p>
                        </div>
                      )}
                      {jud.smartMoneyExplained && (
                        <div className="rounded-lg p-3" style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)' }}>
                          <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#34d399' }}>Smart Money</div>
                          <p className="text-xs leading-relaxed" style={{ color: 'var(--text2)' }}>{jud.smartMoneyExplained}</p>
                        </div>
                      )}
                    </div>
                  </Collapsible>
                )}

                {/* Council options view — collapsible */}
                {jud.optionsStrategy && (
                  <Collapsible title="Council Options View" icon={<span>⚖</span>} color="#a78bfa">
                    <p className="text-sm leading-relaxed pt-2" style={{ color: 'var(--text2)' }}>{jud.optionsStrategy}</p>
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
                stopLoss={jud.stopLoss ?? ''}
                entryPrice={jud.entryPrice ?? ''}
                takeProfit={jud.takeProfit ?? ''}
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
                <div className="text-[10px] font-mono uppercase tracking-widest mb-3" style={{ color: 'var(--text3)' }}>Signal matrix — {md!.conviction?.signals?.length ?? 0} signals analyzed</div>
                <div className="space-y-1">
                  {(md!.conviction?.signals ?? []).map((s, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: s.direction === 'bullish' ? '#34d399' : s.direction === 'bearish' ? '#f87171' : '#fbbf24' }} />
                      <span className="w-20 shrink-0 text-[10px] font-mono" style={{ color: 'var(--text3)' }}>{s.category}</span>
                      <span className="flex-1 text-[10px] truncate" style={{ color: 'var(--text2)' }}>{s.signal}</span>
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
            <Clock size={9} style={{ color: 'var(--text3)' }} />
            <span className="text-[9px] font-mono" style={{ color: 'var(--text3)' }}>
              For informational purposes only. Not financial advice. AI models can be wrong. Always do your own research.
            </span>
          </div>
        </main>
      </div>
    </div>
    {/* Tutorial overlay */}
    {showTutorial && (
      <Tutorial
        config={MAIN_TUTORIAL}
        autoStart={true}
        onComplete={() => setShowTutorial(false)}
        onSkip={() => setShowTutorial(false)}
      />
    )}
    </>
  )
}

export default function Home() {
  return (
    <Suspense fallback={<div style={{ background: '#0a0d12', minHeight: '100vh' }} />}>
      <HomeInner />
    </Suspense>
  )
}
