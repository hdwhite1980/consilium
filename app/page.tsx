'use client'

import { useState, useRef, useCallback, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'
import TechnicalCharts from '@/app/components/TechnicalCharts'
import OptionsRecommendations from '@/app/components/OptionsRecommendations'
import { useTheme } from '@/app/lib/theme'
import { Tutorial, TutorialLauncher, MAIN_TUTORIAL } from '@/app/components/Tutorial'
import PortfolioAlerts from '@/app/components/PortfolioAlerts'
import {
import WaliLogo from '@/app/components/WaliLogo'
  TrendingUp, TrendingDown, Minus, Clock, AlertTriangle,
  BarChart2, Globe, DollarSign, Activity, Shield, Zap, LogOut, BookOpen,
  Sun, Moon, Menu, X
} from 'lucide-react'

type Signal = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

// â”€â”€ Log Trade Menu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function LogTradeMenu({ destinations }: {
  destinations: Array<{ icon: string; label: string; desc: string; color: string; onClick: () => void }>
}) {
  const [open, setOpen] = useState(false)
  const idRef = useRef<string>(`logtrade-${Math.random().toString(36).slice(2, 9)}`)
  const panelId = idRef.current
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Log your trade â€” choose a destination"
        className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition-all hover:opacity-90 focus:outline focus:outline-2 focus:outline-offset-1"
        style={{ background: 'rgba(52,211,153,0.08)', color: '#34d399', border: '1px solid rgba(52,211,153,0.2)', outlineColor: '#34d399' }}>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true">ðŸ“‹</span>
          <span>Acted on this analysis? Log your trade</span>
        </span>
        <span style={{ color: 'rgba(52,211,153,0.5)' }} aria-hidden="true">{open ? 'â–²' : 'â–¼'}</span>
      </button>
      {open && (
        <div id={panelId} role="menu" className="mt-1 rounded-xl overflow-hidden z-10 relative"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          {destinations.map((d, i) => (
            <button
              key={d.label}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); d.onClick() }}
              aria-label={`${d.label} â€” ${d.desc}`}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-all hover:opacity-80 focus:outline focus:outline-2 focus:outline-offset-[-2px]"
              style={{ borderBottom: i < destinations.length - 1 ? '1px solid var(--border)' : 'none', outlineColor: d.color }}>
              <span className="text-base w-5 text-center" aria-hidden="true">{d.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold" style={{ color: d.color }}>{d.label}</div>
                <div className="text-[10px]" style={{ color: 'var(--text3)' }}>{d.desc}</div>
              </div>
              <span className="text-xs" style={{ color: 'var(--text3)' }} aria-hidden="true">â†’</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
type Stage  = 'idle' | 'building' | 'gemini' | 'claude' | 'gpt' | 'judge' | 'done' | 'error'
type TF     = '1D' | '1W' | '1M' | '3M'
type Persona = 'balanced' | 'technical' | 'fundamental'

const PERSONAS: Record<Persona, { label: string; icon: string; color: string; desc: string }> = {
  balanced:    { label: 'Balanced',    icon: 'âš–',  color: '#a78bfa', desc: 'Equal weight to technicals and fundamentals' },
  technical:   { label: 'Technical',   icon: 'ðŸ“ˆ', color: '#60a5fa', desc: 'Follows price action and chart patterns' },
  fundamental: { label: 'Fundamental', icon: 'ðŸ“Š', color: '#34d399', desc: 'Prioritizes business value and analyst consensus' },
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
    goldenCross: boolean; deathCross: boolean; ema9CrossEma20: string
    macdLine: number; macdSignal: number; macdHistogram: number; macdCrossover: string
    bbSignal: string; bbPosition: number; bbUpper: number; bbMiddle: number; bbLower: number
    stochK: number; stochD: number; stochSignal: string; stochCrossover: string
    vwap: number; priceVsVwap: number; vwapSignal: string
    obv: number; obvTrend: string; obvDivergence: string
    volumeRatio: number; priceChange1D: number
    fibLevels: Array<{ level: number; price: number; label: string; type: string }>
    nearestFibLevel: { level: number; price: number; label: string; type: string } | null
    goldenZone: { swingHigh: number; swingLow: number; trending: string; levels: Array<{ level: number; price: number; label: string; type: string }>; goldenPocketHigh: number; goldenPocketLow: number; inGoldenZone: boolean; distToZone: number } | null
    // New indicators
    atr14: number; atrPct: number; atrSignal: string
    stopLossATR: number; takeProfitATR: number
    roc10: number; roc20: number; rocSignal: string; momentum: number
    williamsR: number; williamsSignal: string
    cci: number; cciSignal: string
    ichimokuTenkan: number; ichimokuKijun: number
    ichimokuSignal: string; ichimokuCross: string
    relStrengthVsSector: number | null; relStrengthSignal: string
    // Pattern detection
    candlePattern: { name: string; type: string; strength: string; description: string } | null
    chartPattern: { name: string; type: string; target: number | null; invalidation: number | null; description: string; confidence: string } | null
    gapPattern: { type: string; size: number; filled: boolean; gapHigh: number; gapLow: number; bullish: boolean; description: string } | null
    trendLines: { higherHighs: boolean; lowerLows: boolean; higherLows: boolean; lowerHighs: boolean; trend: string; dynamicSupport: number | null; dynamicResistance: number | null }
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
      <span className="text-xs font-mono" style={{ color: 'var(--text3)' }}>{label} is thinkingâ€¦</span>
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
  // Stable id per instance for aria-controls
  const idRef = useRef<string>(`collapsible-${Math.random().toString(36).slice(2, 9)}`)
  const panelId = idRef.current
  return (
    <div className="rounded-xl border overflow-hidden"
      style={{ borderColor: open ? `${color}30` : 'var(--border)', background: 'var(--surface)' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left transition-all focus:outline focus:outline-2 focus:outline-offset-[-2px]"
        style={{ ['--tw-bg-opacity' as string]: '1', outlineColor: color }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface2)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
        <span style={{ color }} aria-hidden="true">{icon}</span>
        <span className="text-sm font-semibold flex-1" style={{ color: 'var(--text)' }}>{title}</span>
        {badge}
        <span className="text-xs ml-auto" style={{ color: 'var(--text3)' }} aria-hidden="true">{open ? 'â–²' : 'â–¼'}</span>
      </button>
      {open && (
        <div id={panelId} className="px-4 pb-4 pt-1 border-t" style={{ borderColor: 'var(--border)' }}>
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
  const [preMarketBrief, setPreMarketBrief] = useState<{headline?:string;one_line?:string;risk_of_day?:string;watchlist?:string[];portfolio_alerts?:string[]} | null>(null)
  const [showBrief, setShowBrief] = useState(false)
  const [whyMoving, setWhyMoving] = useState<{catalyst?:string;verdict?:{verdict:string;confidence:number;reason:string;action:string;risk:string};loading:boolean;open:boolean}>({ loading: false, open: false })
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
        // Reset progress so tutorial can replay, then remount
        fetch('/api/tutorial', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tutorialId: 'main', step: 0, completed: false, skipped: false }),
        }).catch(() => null)
        setShowTutorial(false)
        setTimeout(() => setShowTutorial(true), 50)
      }
    }
    window.addEventListener('wali_os:launch_tutorial', handler)
    return () => window.removeEventListener('wali_os:launch_tutorial', handler)
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
        sessionStorage.setItem('wali_os_last', JSON.stringify({
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
        const saved = sessionStorage.getItem('wali_os_last')
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
    { label: 'Today', icon: 'âš¡', path: '/news',        color: '#fbbf24' },
    { label: 'Tomorrow', icon: 'ðŸ“…', path: '/tomorrow', color: '#a78bfa' },
    { label: 'Invest', icon: 'ðŸ”¥', path: '/invest',     color: '#f97316' },
    { label: 'Portfolio', icon: 'ðŸ’¼', path: '/portfolio', color: '#34d399' },
    { label: 'Macro',    icon: 'ðŸŒ', path: '/macro',       color: '#60a5fa' },
    { label: 'Screener', icon: 'ðŸ”', path: '/screener',    color: '#a78bfa' },
    { label: 'Compare', icon: 'âš¡', path: '/compare',   color: '#f87171' },
    { label: 'Track Record', icon: 'ðŸ†', path: '/track-record', color: '#fbbf24' },
    { label: 'Guide', icon: 'ðŸ“–', path: '/guide',       color: txt3 },
  ]

  return (
    <>
    <div className="flex flex-col min-h-screen md:h-screen md:overflow-hidden" style={{ background: bg, color: txt }}>

      {/* â”€â”€ Skip-to-content link for keyboard users â”€â”€ */}
      <a href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:rounded-lg focus:outline focus:outline-2 focus:outline-offset-2"
        style={{ background: '#7c3aed', color: 'white', outlineColor: '#a78bfa' }}>
        Skip to main content
      </a>

      {/* â”€â”€ Top nav bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {/* Pre-market Brief Banner */}
      {preMarketBrief?.headline && (
        <div className="shrink-0" style={{ background: isDark ? 'rgba(251,191,36,0.07)' : 'rgba(251,191,36,0.12)', borderBottom: '1px solid rgba(251,191,36,0.15)' }}>
          <button
            type="button"
            onClick={() => setShowBrief(b => !b)}
            aria-expanded={showBrief}
            aria-controls="premarket-details"
            className="w-full px-3 py-2 flex items-center gap-2 transition-all hover:opacity-90 text-left focus:outline focus:outline-2 focus:outline-offset-[-2px]"
            style={{ outlineColor: '#fbbf24' }}>
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded font-mono shrink-0"
              style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>PRE-MARKET</span>
            <span className="text-xs flex-1 truncate" style={{ color: txt2 }}>{preMarketBrief.headline}</span>
            <span className="text-[10px] shrink-0" style={{ color: txt3 }} aria-hidden="true">{showBrief ? 'â–²' : 'â–¼'}</span>
          </button>
          {showBrief && (
            <div id="premarket-details" className="px-3 pb-2 space-y-1.5 text-xs">
              {preMarketBrief.one_line && <p style={{ color: txt2 }} className="leading-relaxed">{preMarketBrief.one_line}</p>}
              {preMarketBrief.risk_of_day && (
                <div className="flex items-start gap-1.5">
                  <span style={{ color: '#f87171' }} aria-hidden="true">âš </span>
                  <span style={{ color: txt2 }}><strong className="font-semibold">Risk:</strong> {preMarketBrief.risk_of_day}</span>
                </div>
              )}
              {preMarketBrief.watchlist && preMarketBrief.watchlist.length > 0 && (
                <div><span style={{ color: txt3 }}>Watch: </span><span style={{ color: txt2 }}>{preMarketBrief.watchlist.join(' Â· ')}</span></div>
              )}
            </div>
          )}
        </div>
      )}

      {/* â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
           TOP NAV â€” two rows on mobile/tablet, single row on xl+

           Row 1 (always visible):  Logo Â· analysis controls Â· Analyze button Â· user cluster
           Row 2 (xl+ inline, smaller breakpoints separate):  nav links

           The user cluster (theme Â· status Â· email Â· LOGOUT Â· mobile menu)
           is locked to the right edge and can never be pushed off-screen.
         â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <nav className="border-b shrink-0" style={{ background: surf, borderColor: brd }} aria-label="Primary navigation">

        {/* â”€â”€ Row 1: brand + analysis + user cluster â”€â”€ */}
        <div className="flex items-center gap-2 px-3 py-2 flex-wrap">

          {/* Logo â€” home link */}
          <button
            type="button"
            onClick={() => router.push('/')}
            className="flex items-center gap-2 shrink-0 mr-1 rounded-lg focus:outline focus:outline-2 focus:outline-offset-2"
            style={{ outlineColor: '#a78bfa' }}
            aria-label="Wali-OS home">
            <WaliLogo size="xs" noLink />
            <span className="text-sm font-bold tracking-tight hidden sm:block" style={{ color: txt }}>WALI-OS</span>
          </button>

          {/* â”€â”€ Analysis controls â”€â”€ */}
          <div className="flex items-center gap-1.5 flex-1 min-w-0 flex-wrap" role="group" aria-label="Analysis controls">

            {/* Ticker with proper label */}
            <div className="flex flex-col">
              <label htmlFor="ticker-input" className="sr-only">Stock or crypto ticker symbol</label>
              <input
                id="ticker-input"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                value={ticker}
                onChange={e => setTicker(e.target.value.toUpperCase().replace(/[^A-Z/]/g, ''))}
                onKeyDown={e => { if (e.key === 'Enter' && !running) { setTicker(t => t.replace(/\//g, '')); setTimeout(run, 0) } }}
                placeholder="AAPL Â· BTC Â· EUR/USD"
                maxLength={7}
                data-tutorial="ticker-input"
                aria-label="Ticker symbol (e.g. AAPL, BTC, or EUR/USD)"
                className="w-24 sm:w-32 rounded-lg px-2.5 py-1.5 text-sm font-mono font-bold tracking-widest border transition-colors focus:outline focus:outline-2 focus:outline-offset-1"
                style={{ background: inputBg, borderColor: brd2, color: txt, outlineColor: '#a78bfa' }} />
            </div>

            {/* Timeframe */}
            <div className="flex gap-0.5" role="radiogroup" aria-label="Timeframe" data-tutorial="timeframe-selector">
              {([
                { tf: '1D', label: '1D', title: 'Intraday â€” 15-min bars, same-day to next session targets' },
                { tf: '1W', label: '1W', title: 'Swing trade â€” hourly bars, 3-10 day targets' },
                { tf: '1M', label: '1M', title: 'Position trade â€” daily bars, 3-6 week targets' },
                { tf: '3M', label: '3M', title: 'Investment â€” daily bars, 6-13 week targets' },
              ] as { tf: TF; label: string; title: string }[]).map(({ tf: t, label, title }) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={tf === t}
                  aria-label={`${label} timeframe â€” ${title}`}
                  onClick={() => setTf(t)}
                  title={title}
                  className="px-2 py-1.5 rounded-md text-xs font-mono border transition-all focus:outline focus:outline-2 focus:outline-offset-1"
                  style={{
                    background: tf === t ? 'rgba(167,139,250,0.15)' : inputBg,
                    borderColor: tf === t ? '#a78bfa' : brd,
                    color: tf === t ? '#a78bfa' : txt2,
                    outlineColor: '#a78bfa',
                  }}>{label}</button>
              ))}
            </div>

            {/* Persona */}
            <div className="flex items-center gap-0.5 rounded-lg p-0.5" role="radiogroup" aria-label="Analyst persona" data-tutorial="persona-selector" style={{ background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)', border: `1px solid ${brd}` }}>
              {(Object.entries(PERSONAS) as [Persona, typeof PERSONAS[Persona]][]).map(([key, p]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={persona === key}
                  aria-label={`${p.label} analyst â€” ${p.desc}`}
                  onClick={() => setPersona(key)}
                  title={p.desc}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-mono transition-all focus:outline focus:outline-2 focus:outline-offset-1"
                  style={{
                    background: persona === key ? `${p.color}18` : 'transparent',
                    color: persona === key ? p.color : txt2,
                    border: persona === key ? `1px solid ${p.color}35` : '1px solid transparent',
                    outlineColor: p.color,
                  }}>
                  <span aria-hidden="true">{p.icon}</span>
                  <span className="hidden lg:inline">{p.label}</span>
                </button>
              ))}
            </div>

            {/* Why is this moving? â€” shows when price has moved >2% */}
            {md?.currentPrice && md?.technicals?.priceChange1D && Math.abs(md.technicals.priceChange1D) >= 2 && (
              <button
                type="button"
                onClick={async () => {
                  const pct = md.technicals?.priceChange1D || 0
                  setWhyMoving({ loading: true, open: true })
                  const res = await fetch('/api/why-moving', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ticker, currentPrice: md?.currentPrice, changePercent: pct }),
                  })
                  if (!res.body) return
                  const reader = res.body.getReader()
                  const decoder = new TextDecoder()
                  while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    const text = decoder.decode(value)
                    for (const line of text.split('\n')) {
                      if (!line.startsWith('data: ')) continue
                      try {
                        const evt = JSON.parse(line.slice(6))
                        if (evt.catalyst) setWhyMoving(p => ({ ...p, catalyst: evt.catalyst }))
                        if (evt.verdict) setWhyMoving(p => ({ ...p, verdict: evt.verdict, loading: false }))
                      } catch { /* skip */ }
                    }
                  }
                }}
                disabled={whyMoving.loading}
                aria-label={whyMoving.loading ? 'Analyzing price movement' : `Explain why ${ticker} is moving`}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-40 focus:outline focus:outline-2 focus:outline-offset-1"
                style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.25)', color: '#fbbf24', outlineColor: '#fbbf24' }}>
                <span aria-hidden="true">{whyMoving.loading ? 'â³' : 'âš¡'}</span>
                <span>{whyMoving.loading ? 'Analyzingâ€¦' : `Why is ${ticker} moving?`}</span>
              </button>
            )}

            <button
              type="button"
              onClick={run}
              disabled={running}
              data-tutorial="analyze-btn"
              aria-label={running ? 'Analyzing â€” please wait' : `Analyze ${ticker}`}
              className="px-3 sm:px-4 py-1.5 rounded-lg text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-95 disabled:opacity-40 shrink-0 focus:outline focus:outline-2 focus:outline-offset-2"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)', outlineColor: '#a78bfa' }}>
              {running ? <span aria-hidden="true">â€¦</span> : 'Analyze'}
            </button>
          </div>

          {/* â”€â”€ User cluster â€” locked to right, always visible â”€â”€ */}
          <div className="flex items-center gap-1.5 ml-auto shrink-0" role="group" aria-label="Account and settings">

            {/* Portfolio Alerts â€” mounted globally so polling runs everywhere */}
            <PortfolioAlerts isDark={isDark} />

            {/* Theme toggle */}
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="p-1.5 rounded-lg transition-all hover:opacity-80 focus:outline focus:outline-2 focus:outline-offset-1"
              style={{ background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)', color: txt2, border: `1px solid ${brd}`, outlineColor: '#a78bfa' }}>
              {isDark ? <Sun size={13} aria-hidden="true" /> : <Moon size={13} aria-hidden="true" />}
            </button>

            {/* Status dot */}
            <span
              role="status"
              aria-live="polite"
              aria-label={
                stage === 'done' ? 'Analysis complete' :
                stage === 'error' ? 'Analysis failed' :
                running ? 'Analysis in progress' : 'Idle'
              }
              className="w-1.5 h-1.5 rounded-full animate-pulse-dot shrink-0"
              style={{ background: stage === 'done' ? '#34d399' : stage === 'error' ? '#f87171' : running ? '#fbbf24' : brd2 }} />

            {/* User area â€” trial badge + email + LOGOUT */}
            {userEmail && (
              <div className="flex items-center gap-1.5 pl-1.5 border-l" style={{ borderColor: brd }}>
                {subStatus?.status !== 'exempt' && subStatus?.status === 'trialing' && subStatus.daysLeft !== null && (
                  <button
                    type="button"
                    onClick={async () => { const r = await fetch('/api/stripe/checkout',{method:'POST'}); const d=await r.json(); if(d.url) window.location.href=d.url }}
                    aria-label={`Free trial ends in ${subStatus.daysLeft} days. Click to subscribe now.`}
                    className="text-[10px] font-mono px-2 py-1 rounded-full focus:outline focus:outline-2 focus:outline-offset-1"
                    style={{
                      background: subStatus.daysLeft <= 2 ? 'rgba(248,113,113,0.15)' : 'rgba(251,191,36,0.15)',
                      color: subStatus.daysLeft <= 2 ? '#fca5a5' : '#fcd34d',
                      border: `1px solid ${subStatus.daysLeft <= 2 ? 'rgba(248,113,113,0.4)' : 'rgba(251,191,36,0.35)'}`,
                      outlineColor: subStatus.daysLeft <= 2 ? '#f87171' : '#fbbf24',
                    }}>
                    <span aria-hidden="true">â³ </span>{subStatus.daysLeft}d
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => router.push('/settings')}
                  aria-label={`Account settings for ${userEmail}`}
                  title="Account settings"
                  className="text-[10px] font-mono hidden sm:block max-w-[100px] truncate hover:opacity-70 transition-opacity rounded focus:outline focus:outline-2 focus:outline-offset-1"
                  style={{ color: txt2, outlineColor: '#a78bfa' }}>
                  {userEmail}
                </button>
                <button
                  type="button"
                  onClick={handleSignOut}
                  aria-label="Sign out"
                  title="Sign out"
                  className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded-md transition-all hover:opacity-80 focus:outline focus:outline-2 focus:outline-offset-1"
                  style={{ background: 'rgba(248,113,113,0.1)', color: '#fca5a5', border: '1px solid rgba(248,113,113,0.3)', outlineColor: '#f87171' }}>
                  <LogOut size={10} aria-hidden="true" />
                  <span className="hidden sm:inline">Sign out</span>
                </button>
              </div>
            )}

            {/* Mobile menu toggle */}
            <button
              type="button"
              onClick={() => setNavOpen(!navOpen)}
              aria-label={navOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={navOpen}
              aria-controls="mobile-nav-drawer"
              className="flex xl:hidden p-1.5 rounded-lg transition-all focus:outline focus:outline-2 focus:outline-offset-1"
              style={{ background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)', color: txt2, border: `1px solid ${brd}`, outlineColor: '#a78bfa' }}>
              {navOpen ? <X size={14} aria-hidden="true" /> : <Menu size={14} aria-hidden="true" />}
            </button>
          </div>
        </div>

        {/* â”€â”€ Row 2 (xl+): desktop nav links inline â”€â”€ */}
        <div className="hidden xl:flex items-center gap-1 px-3 pb-2 pt-0">
          {NAV_ITEMS.map(n => (
            <button
              key={n.path}
              type="button"
              onClick={() => router.push(n.path)}
              aria-label={`Go to ${n.label}`}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80 focus:outline focus:outline-2 focus:outline-offset-1"
              style={{ color: n.color, background: `${n.color}10`, border: `1px solid ${n.color}20`, outlineColor: n.color }}>
              <span className="text-[11px]" aria-hidden="true">{n.icon}</span>
              <span>{n.label}</span>
            </button>
          ))}
          <TutorialLauncher tutorialId="main" />
        </div>
      </nav>

      {/* â”€â”€ Mobile / tablet nav drawer â”€â”€ */}
      {navOpen && (
        <div
          id="mobile-nav-drawer"
          className="xl:hidden border-b px-3 py-2 flex flex-wrap gap-2"
          style={{ background: surf, borderColor: brd }}
          role="menu"
          aria-label="Main navigation">
          {NAV_ITEMS.map(n => (
            <button
              key={n.path}
              type="button"
              role="menuitem"
              onClick={() => { router.push(n.path); setNavOpen(false) }}
              aria-label={`Go to ${n.label}`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all focus:outline focus:outline-2 focus:outline-offset-1"
              style={{ color: n.color, background: `${n.color}12`, border: `1px solid ${n.color}25`, outlineColor: n.color }}>
              <span aria-hidden="true">{n.icon}</span>
              <span>{n.label}</span>
            </button>
          ))}
          <div className="w-full" role="none">
            <TutorialLauncher tutorialId="main" />
          </div>
        </div>
      )}

      {/* â”€â”€ Stage progress bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
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

      {/* â”€â”€ Cached / stale banner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {cached && stage === 'done' && (
        <div className="px-3 py-2 flex items-center justify-between border-b shrink-0"
          style={{
            background: cached.ageMinutes > 60 ? 'rgba(248,113,113,0.07)' : isDark ? 'rgba(251,191,36,0.06)' : 'rgba(251,191,36,0.08)',
            borderColor: cached.ageMinutes > 60 ? 'rgba(248,113,113,0.25)' : 'rgba(251,191,36,0.2)',
          }}>
          <span className="text-xs" style={{ color: txt2 }}>
            {cached.ageMinutes > 60
              ? <><strong style={{ color: '#f87171' }}>âš  Stale â€” {cached.ageMinutes}m old.</strong> Price may have moved.</>
              : <>â± Cached analysis Â· {cached.ageMinutes}m ago</>
            }
          </span>
          <button onClick={forceRun}
            className="text-[10px] font-mono px-2.5 py-1 rounded-full transition-all hover:opacity-80"
            style={{ background: cached.ageMinutes > 60 ? 'rgba(248,113,113,0.15)' : 'rgba(251,191,36,0.15)', color: cached.ageMinutes > 60 ? '#f87171' : '#fbbf24', border: `1px solid ${cached.ageMinutes > 60 ? 'rgba(248,113,113,0.3)' : 'rgba(251,191,36,0.3)'}` }}>
            â†» Refresh
          </button>
        </div>
      )}

      {/* â”€â”€ Main layout: sidebar + debate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <main id="main-content" role="main" aria-label="Analysis dashboard" className="flex flex-col md:flex-row flex-1 md:overflow-hidden">

        {/* Left sidebar â€” only show when there's data */}
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
                ['MACD', <span style={{ color: md!.technicals?.macdHistogram >= 0 ? '#34d399' : '#f87171' }}>{md!.technicals?.macdHistogram >= 0 ? 'â–² pos' : 'â–¼ neg'}</span>],
                ['MA cross', (() => {
                    const t = md!.technicals
                    // Only show cross if we have real SMA200 data (not fallback)
                    if (!t?.sma200 || !t?.sma50 || t.sma200 <= 0) {
                      return <span style={{ color: txt3 }}>N/A</span>
                    }
                    if (!t.goldenCross && !t.deathCross) {
                      // Not enough bars for a valid cross signal
                      return <span style={{ color: txt3 }}>N/A</span>
                    }
                    return <span style={{ color: t.goldenCross ? '#34d399' : '#f87171' }}>{t.goldenCross ? 'Golden âœ“' : 'Death âœ—'}</span>
                  })()],
                ['vs SMA200', (() => {
                    const t = md!.technicals
                    const sma200 = t?.sma200
                    // Only show if we have a real SMA200 (goldenCross or deathCross means we have 200 bars)
                    if (!sma200 || sma200 <= 0 || (!t?.goldenCross && !t?.deathCross)) return <span style={{ color: txt3 }}>N/A</span>
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
                    {md!.fundamentals?.daysToEarnings}d â€” {md!.fundamentals?.earningsRisk}
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
                <div className="text-[9px] leading-relaxed" style={{ color: txt3 }}>{md!.smartMoney?.notableHolders.join(' Â· ')}</div>
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
                    {md!.options?.putCallRatio.toFixed(2)} â€” {md!.options?.putCallSignal}
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

          {/* Patterns */}
          {md?.technicals && (md.technicals.candlePattern || md.technicals.chartPattern || md.technicals.gapPattern || md.technicals.trendLines?.trend !== 'sideways') && (
            <Card title="Patterns" icon={<Activity size={11}/>} color="#e879f9" surf={surf} brd={brd} txt3={txt3}>
              {/* Trend structure */}
              {md.technicals.trendLines && (
                <div className="flex justify-between text-xs mb-1">
                  <span style={{ color: txt3 }}>Trend</span>
                  <span className="font-mono text-[10px] capitalize" style={{ color: md.technicals.trendLines.trend === 'uptrend' ? '#34d399' : md.technicals.trendLines.trend === 'downtrend' ? '#f87171' : txt }}>
                    {md.technicals.trendLines.trend}
                    {md.technicals.trendLines.higherHighs && md.technicals.trendLines.higherLows ? ' â†‘â†‘' : md.technicals.trendLines.lowerHighs && md.technicals.trendLines.lowerLows ? ' â†“â†“' : ''}
                  </span>
                </div>
              )}
              {md.technicals.trendLines?.dynamicSupport && (
                <div className="flex justify-between text-xs">
                  <span style={{ color: txt3 }}>Dyn. support</span>
                  <span className="font-mono text-[10px]" style={{ color: '#34d399' }}>${md.technicals.trendLines.dynamicSupport.toFixed(2)}</span>
                </div>
              )}
              {md.technicals.trendLines?.dynamicResistance && (
                <div className="flex justify-between text-xs mb-1">
                  <span style={{ color: txt3 }}>Dyn. resist.</span>
                  <span className="font-mono text-[10px]" style={{ color: '#f87171' }}>${md.technicals.trendLines.dynamicResistance.toFixed(2)}</span>
                </div>
              )}
              {/* Candle pattern */}
              {md.technicals.candlePattern && (
                <div className="mt-1 px-2 py-1.5 rounded-lg" style={{ background: md.technicals.candlePattern.type === 'bullish' ? 'rgba(52,211,153,0.08)' : md.technicals.candlePattern.type === 'bearish' ? 'rgba(248,113,113,0.08)' : 'rgba(255,255,255,0.04)', border: `1px solid ${md.technicals.candlePattern.type === 'bullish' ? 'rgba(52,211,153,0.2)' : md.technicals.candlePattern.type === 'bearish' ? 'rgba(248,113,113,0.2)' : 'rgba(255,255,255,0.08)'}` }}>
                  <div className="text-[10px] font-semibold mb-0.5" style={{ color: md.technicals.candlePattern.type === 'bullish' ? '#34d399' : md.technicals.candlePattern.type === 'bearish' ? '#f87171' : txt }}>
                    ðŸ•¯ {md.technicals.candlePattern.name}
                    <span className="ml-1 font-normal opacity-60">({md.technicals.candlePattern.strength})</span>
                  </div>
                  <div className="text-[10px] leading-relaxed" style={{ color: txt3 }}>{md.technicals.candlePattern.description}</div>
                </div>
              )}
              {/* Chart pattern */}
              {md.technicals.chartPattern && (
                <div className="mt-1 px-2 py-1.5 rounded-lg" style={{ background: md.technicals.chartPattern.type === 'bullish' ? 'rgba(52,211,153,0.08)' : md.technicals.chartPattern.type === 'bearish' ? 'rgba(248,113,113,0.08)' : 'rgba(255,255,255,0.04)', border: `1px solid ${md.technicals.chartPattern.type === 'bullish' ? 'rgba(52,211,153,0.2)' : md.technicals.chartPattern.type === 'bearish' ? 'rgba(248,113,113,0.2)' : 'rgba(255,255,255,0.08)'}` }}>
                  <div className="text-[10px] font-semibold mb-0.5 flex items-center justify-between" style={{ color: md.technicals.chartPattern.type === 'bullish' ? '#34d399' : md.technicals.chartPattern.type === 'bearish' ? '#f87171' : txt }}>
                    <span>ðŸ“Š {md.technicals.chartPattern.name}</span>
                    <span className="font-normal opacity-60 text-[9px]">{md.technicals.chartPattern.confidence}</span>
                  </div>
                  <div className="text-[10px] leading-relaxed" style={{ color: txt3 }}>{md.technicals.chartPattern.description}</div>
                  {md.technicals.chartPattern.target && (
                    <div className="text-[10px] mt-1 font-mono" style={{ color: md.technicals.chartPattern.type === 'bullish' ? '#34d399' : '#f87171' }}>
                      Target: ${md.technicals.chartPattern.target.toFixed(2)}
                      {md.technicals.chartPattern.invalidation && ` Â· Invalidation: $${md.technicals.chartPattern.invalidation.toFixed(2)}`}
                    </div>
                  )}
                </div>
              )}
              {/* Gap */}
              {md.technicals.gapPattern && (
                <div className="mt-1 px-2 py-1.5 rounded-lg" style={{ background: md.technicals.gapPattern.bullish ? 'rgba(52,211,153,0.06)' : 'rgba(248,113,113,0.06)', border: `1px solid ${md.technicals.gapPattern.bullish ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)'}` }}>
                  <div className="text-[10px] font-semibold mb-0.5" style={{ color: md.technicals.gapPattern.bullish ? '#34d399' : '#f87171' }}>
                    â¬† {md.technicals.gapPattern.type === 'gap_up' ? 'Gap Up' : 'Gap Down'} {md.technicals.gapPattern.size.toFixed(1)}%
                    {md.technicals.gapPattern.filled && <span className="ml-1 opacity-60">(filled)</span>}
                  </div>
                  <div className="text-[10px] leading-relaxed" style={{ color: txt3 }}>{md.technicals.gapPattern.description}</div>
                </div>
              )}
            </Card>
          )}


          {/* Golden Zone Fibonacci */}
          {md?.technicals?.goldenZone && (
            <Card title="Golden Zone" icon={<span style={{ fontSize: 10 }}>â¬¡</span>} color="#fbbf24" surf={surf} brd={brd} txt3={txt3}>
              {(() => {
                const gz = md!.technicals!.goldenZone!
                return (
                  <>
                    {/* In zone banner */}
                    {gz.inGoldenZone && (
                      <div className="text-[10px] font-bold text-center py-1 rounded-lg mb-2 animate-pulse"
                        style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}>
                        â­ Price is in the Golden Zone
                      </div>
                    )}
                    {!gz.inGoldenZone && (
                      <div className="text-[10px] text-center mb-1.5" style={{ color: txt3 }}>
                        {gz.distToZone.toFixed(1)}% from zone Â· {gz.trending === 'up' ? 'â†—' : 'â†˜'} {gz.trending}trend
                      </div>
                    )}
                    {/* Golden pocket highlight */}
                    <div className="rounded-lg px-2 py-1.5 mb-1.5" style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)' }}>
                      <div className="text-[9px] font-mono uppercase text-center mb-1" style={{ color: 'rgba(251,191,36,0.6)' }}>Golden Pocket (optimal entry)</div>
                      <div className="flex justify-between text-[10px] font-mono">
                        <span style={{ color: '#34d399' }}>${gz.goldenPocketLow.toFixed(2)}</span>
                        <span style={{ color: txt3 }}>â€”</span>
                        <span style={{ color: '#f87171' }}>${gz.goldenPocketHigh.toFixed(2)}</span>
                      </div>
                    </div>
                    {/* All golden levels */}
                    {gz.levels.map(l => {
                      const isInPocket = l.level === 0.618 || l.level === 0.786
                      const isPocket = l.level === 0.705
                      return (
                        <div key={l.level} className="flex justify-between text-xs"
                          style={{ opacity: isPocket ? 1 : isInPocket ? 0.9 : 0.65 }}>
                          <span style={{ color: isPocket ? '#fbbf24' : txt3 }}>
                            {isPocket ? 'â˜… ' : ''}{(l.level * 100).toFixed(1)}%
                          </span>
                          <span className="font-mono text-[11px]" style={{ color: l.type === 'support' ? '#34d399' : '#f87171' }}>
                            ${l.price.toFixed(2)}
                          </span>
                        </div>
                      )
                    })}
                    <div className="text-[9px] mt-1.5 text-center" style={{ color: txt3 }}>
                      Swing: ${gz.swingLow.toFixed(2)} â€“ ${gz.swingHigh.toFixed(2)}
                    </div>
                  </>
                )
              })()}
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
        <section aria-label="Council debate" className="flex-1 flex flex-col md:overflow-hidden" style={{ background: 'var(--bg)' }}>

          <div ref={debateRef} className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-4">

            {cached && stage === 'done' && (
              <div className="flex items-center justify-between px-4 py-2.5 rounded-xl mb-1"
                style={{
                  background: cached.ageMinutes > 60 ? 'rgba(248,113,113,0.07)' : 'rgba(251,191,36,0.07)',
                  border: `1px solid ${cached.ageMinutes > 60 ? 'rgba(248,113,113,0.3)' : 'rgba(251,191,36,0.18)'}`,
                }}>
                <div className="flex items-center gap-2">
                  <span>{cached.ageMinutes > 60 ? 'âš ' : 'â±'}</span>
                  <span className="text-xs" style={{ color: 'var(--text2)' }}>
                    {cached.ageMinutes > 60
                      ? <><strong style={{ color: '#f87171' }}>Stale analysis â€” {cached.ageMinutes} minutes old.</strong> Price may have moved significantly. Run a fresh analysis.</>
                      : <>Cached analysis from <strong style={{ color: '#fbbf24' }}>{cached.ageMinutes} minute{cached.ageMinutes === 1 ? '' : 's'} ago</strong> â€” no AI credits used</>
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
                  â†» Run fresh analysis
                </button>
              </div>
            )}

            {stage === 'idle' && (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                <div className="text-4xl opacity-60">ðŸ“Š</div>
                <div className="text-base font-semibold" style={{ color: 'var(--text2)' }}>Enter a ticker and click Analyze</div>
                <div className="text-xs font-mono" style={{ color: 'var(--text3)' }}>Stocks Â· Crypto Â· Forex (EUR/USD, GBP/JPY...)</div>
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
                      <span className="text-[8px] mt-0.5 shrink-0" style={{ color: '#60a5fa60' }}>â—</span>{h}
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
                <div className="flex flex-wrap gap-1.5">{cla.keyRisks.map((r, i) => <Chip key={i} label={`âš  ${r}`} color="#f87171" />)}</div>
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
                    {gpt.agrees ? 'âœ“ agrees' : 'âš¡ challenges'}
                  </span>
                  <span className="text-[10px] font-mono ml-1" style={{ color: 'var(--text3)' }}>Stage 3</span>
                </>}
                defaultOpen={false}>
              <div className="pt-2 space-y-3">
                <p className="text-sm leading-relaxed" style={{ color: 'var(--text2)' }}>{gpt.reasoning}</p>
                {gpt.challenges.length > 0 && (
                  <div className="space-y-1">
                    {gpt.challenges.map((c, i) => (
                      <div key={i} className="text-xs flex gap-1.5" style={{ color: 'var(--text2)' }}><span style={{ color: '#fbbf24' }}>âš </span>{c}</div>
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
            {(stage as string) === 'rebuttal' && !reb && <Think label="Lead Analyst rebuttingâ€¦" color="#a78bfa" />}
            {reb && (
              <Collapsible
                title="Lead Analyst â€” Rebuttal"
                icon={<span className="text-xs font-bold">L</span>}
                color="#a78bfa"
                badge={<><SBadge s={reb.signal} sm /><span className="text-[10px] font-mono ml-1" style={{ color: 'var(--text3)' }}>Round 2</span></>}
                defaultOpen={true}>
              <div className="pt-2 space-y-3">
                {reb.researchQuestion && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: '#60a5fa' }}>ðŸ” News Scout consulted</div>
                    <div className="text-xs mb-1.5 italic" style={{ color: 'var(--text2)' }}>Q: {reb.researchQuestion}</div>
                    <div className="text-xs leading-relaxed" style={{ color: 'var(--text)' }}>{reb.researchAnswer}</div>
                  </div>
                )}
                <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{reb.rebuttal}</p>
                {reb.concedes.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#f87171' }}>Concedes</div>
                    {reb.concedes.map((c, i) => <div key={i} className="text-xs flex gap-1.5 mb-1" style={{ color: 'var(--text2)' }}><span style={{ color: '#f87171' }}>âœ“</span>{c}</div>)}
                  </div>
                )}
                {reb.maintains.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#a78bfa' }}>Stands firm on</div>
                    {reb.maintains.map((m, i) => <div key={i} className="text-xs flex gap-1.5 mb-1" style={{ color: 'var(--text2)' }}><span style={{ color: '#a78bfa' }}>â–¶</span>{m}</div>)}
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
            {(stage as string) === 'counter' && !ctr && <Think label="Devil's Advocate counteringâ€¦" color="#f87171" />}
            {ctr && (
              <Collapsible
                title="Devil's Advocate â€” Final Counter"
                icon={<span className="text-xs font-bold">D</span>}
                color="#f87171"
                badge={<span className="text-[10px] font-mono ml-1" style={{ color: 'var(--text3)' }}>Round 2</span>}
                defaultOpen={true}>
              <div className="pt-2 space-y-3">
                {ctr.researchQuestion && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: '#f87171' }}>ðŸ” News Scout consulted</div>
                    <div className="text-xs mb-1.5 italic" style={{ color: 'var(--text2)' }}>Q: {ctr.researchQuestion}</div>
                    <div className="text-xs leading-relaxed" style={{ color: 'var(--text)' }}>{ctr.researchAnswer}</div>
                  </div>
                )}
                <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{ctr.finalChallenge}</p>
                {ctr.yieldsOn.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#34d399' }}>Now agrees on</div>
                    {ctr.yieldsOn.map((y, i) => <div key={i} className="text-xs flex gap-1.5 mb-1" style={{ color: 'var(--text2)' }}><span style={{ color: '#34d399' }}>âœ“</span>{y}</div>)}
                  </div>
                )}
                {ctr.pressesOn.length > 0 && (
                  <div className="rounded-lg p-3" style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#f87171' }}>Still pressing</div>
                    {ctr.pressesOn.map((p, i) => <div key={i} className="text-xs flex gap-1.5 mb-1" style={{ color: 'var(--text2)' }}><span style={{ color: '#fbbf24' }}>âš </span>{p}</div>)}
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
                  <span style={{ color: '#fbbf24', fontSize: 15 }}>âš–</span>
                  <span className="text-sm font-bold" style={{ color: '#fbbf24' }}>Council Verdict</span>
                  <SBadge s={jud.signal} />
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                    style={{ background: `${PERSONAS[persona].color}12`, color: PERSONAS[persona].color, border: `1px solid ${PERSONAS[persona].color}25` }}>
                    {PERSONAS[persona].icon} {PERSONAS[persona].label}
                  </span>
                  <span className="ml-auto text-[10px] font-mono" style={{ color: 'var(--text3)' }}>Final</span>
                </div>

                <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{jud.summary}</p>

                {/* â”€â”€ TRADE PLAN â€” prominent, right under verdict â”€â”€ */}
                {jud.entryPrice && (
                  <div className="rounded-2xl p-4 mt-1"
                    style={{ background: 'rgba(251,191,36,0.08)', border: '2px solid rgba(251,191,36,0.3)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-3" style={{ color: '#fbbf24' }}>
                      âš¡ Trade Plan
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {(() => {
                        const isBearish = jud.signal === 'BEARISH'
                        const currentP = md?.currentPrice ?? 0
                        const atr = md?.technicals?.atr14 ?? 0

                        // Extract first $ price from AI string
                        const extractP = (s: string) => { const m = s?.match(/\$(\d{1,6}(?:\.\d{1,2})?)/) ; return m ? parseFloat(m[1]) : null }
                        const entryP = extractP(jud.entryPrice) ?? currentP
                        const stopP  = extractP(jud.stopLoss)
                        const tpP    = extractP(jud.takeProfit)

                        // Validate and auto-correct inverted values
                        let stopVal  = jud.stopLoss
                        let tpVal    = jud.takeProfit
                        let stopFixed = false, tpFixed = false

                        if (!isBearish) {
                          // BULLISH: stop must be < entry, target must be > entry
                          if (stopP !== null && stopP >= entryP) {
                            const c = (atr > 0 ? entryP - atr * 2 : entryP * 0.93).toFixed(2)
                            stopVal = `$${c} â€” 2Ã— ATR below entry`
                            stopFixed = true
                          }
                          if (tpP !== null && tpP <= entryP) {
                            const c = (atr > 0 ? entryP + atr * 3 : entryP * 1.08).toFixed(2)
                            tpVal = `$${c} first target (3Ã— ATR above entry)`
                            tpFixed = true
                          }
                        } else {
                          // BEARISH: stop must be > entry, target must be < entry
                          if (stopP !== null && stopP <= entryP) {
                            const c = (atr > 0 ? entryP + atr * 2 : entryP * 1.07).toFixed(2)
                            stopVal = `$${c} â€” 2Ã— ATR above entry`
                            stopFixed = true
                          }
                          if (tpP !== null && tpP >= entryP) {
                            const c = (atr > 0 ? entryP - atr * 3 : entryP * 0.92).toFixed(2)
                            tpVal = `$${c} first target (3Ã— ATR below entry)`
                            tpFixed = true
                          }
                        }

                        return ([
                          {
                            label: 'Entry',
                            val: jud.entryPrice,
                            color: isBearish ? '#f87171' : '#34d399',
                            icon: isBearish ? 'â–¼' : 'â–¶',
                            bg: isBearish ? 'rgba(248,113,113,0.1)' : 'rgba(52,211,153,0.1)',
                            border: isBearish ? 'rgba(248,113,113,0.25)' : 'rgba(52,211,153,0.25)',
                            hint: isBearish ? 'short / wait for drop' : 'buy zone',
                            fixed: false,
                          },
                          {
                            label: 'Stop Loss',
                            val: stopVal,
                            color: '#f87171',
                            icon: 'âœ•',
                            bg: 'rgba(248,113,113,0.1)',
                            border: 'rgba(248,113,113,0.25)',
                            hint: isBearish ? 'exit if price rises here' : 'exit if price falls here',
                            fixed: stopFixed,
                          },
                          {
                            label: 'Take Profit',
                            val: tpVal,
                            color: '#34d399',
                            icon: 'â˜…',
                            bg: 'rgba(52,211,153,0.1)',
                            border: 'rgba(52,211,153,0.25)',
                            hint: isBearish ? 'target below entry' : 'target above entry',
                            fixed: tpFixed,
                          },
                          {
                            label: 'Time Horizon',
                            val: jud.timeHorizon,
                            color: '#a78bfa',
                            icon: 'â—·',
                            bg: 'rgba(167,139,250,0.1)',
                            border: 'rgba(167,139,250,0.25)',
                            hint: '',
                            fixed: false,
                          },
                        ] as Array<{label:string;val:string;color:string;icon:string;bg:string;border:string;hint:string;fixed:boolean}>)
                      })().map(({ label, val, color, icon, bg, border, hint, fixed }) => (
                        <div key={label} className="rounded-xl p-3 flex flex-col gap-1"
                          style={{ background: bg, border: `1px solid ${border}` }}>
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm" style={{ color }}>{icon}</span>
                            <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: `${color}99` }}>{label}</span>
                            {fixed && <span className="text-[9px] px-1 rounded" style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>corrected</span>}
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

                {/* Plain English â€” always visible */}
                {jud.plainEnglish && (
                  <div className="rounded-xl p-4 space-y-2" style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: 'var(--text3)' }}>Plain English</div>
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{jud.plainEnglish}</p>
                  </div>
                )}

                {/* Log to Journal */}
                {jud?.signal && jud.signal !== 'NEUTRAL' && (
                  <button
                    onClick={async () => {
                      const ep = jud?.entryPrice ? parseFloat(jud.entryPrice.replace(/[^0-9.]/g,'')) : (md?.currentPrice || 0)
                      const sl = jud?.stopLoss ? parseFloat(jud.stopLoss.replace(/[^0-9.]/g,'')) : null
                      const tp = jud?.takeProfit ? parseFloat(jud.takeProfit.replace(/[^0-9.]/g,'')) : null
                      await fetch('/api/trade-journal', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          action: 'add',
                          ticker,
                          signal: jud?.signal,
                          entry_price: isNaN(ep) ? md?.currentPrice : ep,
                          stop_loss: sl && !isNaN(sl) ? sl : null,
                          take_profit: tp && !isNaN(tp) ? tp : null,
                          timeframe: tf,
                          confidence: jud?.confidence,
                        }),
                      })
                      router.push('/portfolio?tab=journal')
                    }}
                    className="w-full py-2 rounded-xl text-xs font-semibold transition-all hover:opacity-80 flex items-center justify-center gap-1.5 mb-3"
                    style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', color: '#34d399' }}>
                    ðŸ“’ Log this trade to Journal
                  </button>
                )}

                {/* Action plan â€” always visible */}
                {jud.actionPlan && (() => {
                  const isBearish2 = jud.signal === 'BEARISH'
                  const currentP2 = md?.currentPrice ?? 0
                  const atr2 = md?.technicals?.atr14 ?? 0
                  const xP = (s: string) => { const m = s?.match(/\$(\d{1,6}(?:\.\d{1,2})?)/) ; return m ? parseFloat(m[1]) : null }
                  const entryP2 = xP(jud.entryPrice) ?? currentP2
                  const stopWrong2 = (() => { const p = xP(jud.stopLoss); return p !== null && (!isBearish2 ? p >= entryP2 : p <= entryP2) })()
                  const tpWrong2   = (() => { const p = xP(jud.takeProfit); return p !== null && (!isBearish2 ? p <= entryP2 : p >= entryP2) })()
                  const cStop = stopWrong2 ? `$${(atr2 > 0 ? (isBearish2 ? entryP2 + atr2 * 2 : entryP2 - atr2 * 2) : entryP2 * (isBearish2 ? 1.07 : 0.93)).toFixed(2)}` : null
                  const cTp   = tpWrong2   ? `$${(atr2 > 0 ? (isBearish2 ? entryP2 - atr2 * 3 : entryP2 + atr2 * 3) : entryP2 * (isBearish2 ? 0.92 : 1.08)).toFixed(2)}` : null
                  return (
                    <div className="rounded-xl p-4" style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)' }}>
                      <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: '#fbbf24' }}>Action plan</div>
                      <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{jud.actionPlan}</p>
                      {(cStop || cTp) && (
                        <div className="mt-2 text-[11px] leading-relaxed px-3 py-2 rounded-lg" style={{ background: 'rgba(251,191,36,0.08)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.25)' }}>
                          âš  Note: price levels in the text above were recalculated â€” {cStop ? `stop corrected to ${cStop}` : ''}{cStop && cTp ? ', ' : ''}{cTp ? `target corrected to ${cTp}` : ''} (ATR-derived, direction-validated). Use the Trade Plan boxes above.
                        </div>
                      )}
                    </div>
                  )
                })()}

                {/* Log Trade CTA â€” multi-destination */}
                {jud.signal && jud.signal !== 'NEUTRAL' && (() => {
                  const entryPrice = md?.currentPrice ?? 0
                  const params = new URLSearchParams({
                    ticker, price: entryPrice.toFixed(2),
                    signal: jud.signal, confidence: String(jud.confidence),
                  })
                  const logToJournal = async () => {
                    const ep = jud.entryPrice ? parseFloat(jud.entryPrice.replace(/[^0-9.]/g,'')) : entryPrice
                    const sl = jud.stopLoss ? parseFloat(jud.stopLoss.replace(/[^0-9.]/g,'')) : null
                    const tp = jud.takeProfit ? parseFloat(jud.takeProfit.replace(/[^0-9.]/g,'')) : null
                    await fetch('/api/trade-journal', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'add', ticker, signal: jud.signal,
                        entry_price: isNaN(ep) ? entryPrice : ep,
                        stop_loss: sl && !isNaN(sl) ? sl : null,
                        take_profit: tp && !isNaN(tp) ? tp : null,
                        timeframe: tf, confidence: jud.confidence }),
                    })
                    router.push('/portfolio?tab=journal')
                  }
                  const destinations = [
                    { icon: 'ðŸ“’', label: 'Trade Journal', desc: 'Track outcome + AI post-mortem', color: '#34d399', onClick: logToJournal },
                    { icon: 'ðŸ’°', label: 'Reinvestment Tracker', desc: 'Deploy gains with AI strategies', color: '#a78bfa', onClick: () => router.push(`/reinvestment?${params}`) },
                    { icon: 'ðŸ’¼', label: 'Portfolio', desc: 'Add position to your portfolio', color: '#60a5fa', onClick: () => router.push(`/portfolio?add=${ticker}&price=${entryPrice.toFixed(2)}`) },
                    { icon: 'ðŸ”¥', label: 'Invest Journey', desc: 'Track as part of your journey', color: '#fbbf24', onClick: () => router.push(`/invest?ticker=${ticker}&signal=${jud.signal}`) },
                  ]
                  return <LogTradeMenu destinations={destinations} />
                })()}

                {/* Collapsible deep-dive sections â€” inside the verdict card */}
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

                {/* Council options view â€” collapsible */}
                {jud.optionsStrategy && (
                  <Collapsible title="Council Options View" icon={<span>âš–</span>} color="#a78bfa">
                    <p className="text-sm leading-relaxed pt-2" style={{ color: 'var(--text2)' }}>{jud.optionsStrategy}</p>
                  </Collapsible>
                )}
              </div>
            )}

            {/* Technical Charts â€” collapsible */}
            {stage === 'done' && md && (
              <Collapsible title="Technical Charts" icon={<BarChart2 size={14}/>} color="#a78bfa">
                <div className="pt-2">
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  <TechnicalCharts ticker={ticker} technicals={md.technicals as any} />
                </div>
              </Collapsible>
            )}

            {/* Options Recommendations â€” collapsible */}
            {stage === 'done' && jud && md && (
              <Collapsible title="Options Strategy" icon={<span>ðŸ“Š</span>} color="#34d399"
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
                <div className="text-[10px] font-mono uppercase tracking-widest mb-3" style={{ color: 'var(--text3)' }}>Signal matrix â€” {md!.conviction?.signals?.length ?? 0} signals analyzed</div>
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
              <div role="alert" aria-live="assertive" className="rounded-xl p-4 text-sm font-mono"
                style={{ background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.22)', color: '#fca5a5' }}>
                <span aria-hidden="true">âš  </span>{err}
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
        </section>
      </main>
    </div>
    {/* Why Is This Moving modal */}
    {whyMoving.open && (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="why-moving-title"
        onKeyDown={e => { if (e.key === 'Escape') setWhyMoving(p => ({ ...p, open: false })) }}
        className="fixed inset-0 z-[9990] flex items-end sm:items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,0.7)' }}
        onClick={() => setWhyMoving(p => ({ ...p, open: false }))}>
        <div className="w-full max-w-md rounded-2xl overflow-hidden shadow-2xl"
          style={{ background: surf, border: '1px solid rgba(251,191,36,0.3)' }}
          onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: brd }}>
            <span style={{ color: '#fbbf24' }} aria-hidden="true">âš¡</span>
            <span id="why-moving-title" className="text-sm font-bold" style={{ color: txt }}>Why is {ticker} moving?</span>
            <button
              type="button"
              onClick={() => setWhyMoving(p => ({ ...p, open: false }))}
              aria-label="Close dialog"
              className="ml-auto text-lg leading-none rounded hover:opacity-70 focus:outline focus:outline-2 focus:outline-offset-1"
              style={{ color: txt3, outlineColor: '#fbbf24' }}>
              <span aria-hidden="true">Ã—</span>
            </button>
          </div>
          <div className="px-4 py-4 space-y-4">
            {whyMoving.loading && !whyMoving.catalyst && (
              <div className="text-sm animate-pulse" style={{ color: txt3 }} role="status" aria-live="polite">
                Scanning headlines and analyzing catalystâ€¦
              </div>
            )}
            {whyMoving.catalyst && (
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: txt3 }}>Catalyst</div>
                <p className="text-sm leading-relaxed" style={{ color: txt }}>{whyMoving.catalyst}</p>
              </div>
            )}
            {whyMoving.verdict && (() => {
              const v = whyMoving.verdict
              const vColor = v.verdict === 'CHASE' ? '#34d399' : v.verdict === 'AVOID' ? '#f87171' : '#fbbf24'
              return (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 rounded-xl p-3" style={{ background: `${vColor}12`, border: `1px solid ${vColor}30` }}>
                    <span className="text-2xl font-black" style={{ color: vColor }}>{v.verdict}</span>
                    <div>
                      <div className="text-xs font-semibold" style={{ color: vColor }}>{v.confidence}% confidence</div>
                      <div className="text-xs" style={{ color: txt2 }}>{v.reason}</div>
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-mono uppercase mb-1" style={{ color: txt3 }}>What to do</div>
                    <p className="text-xs leading-relaxed" style={{ color: txt2 }}>{v.action}</p>
                  </div>
                  <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)' }}>
                    <span className="text-[10px] font-mono" style={{ color: '#fca5a5' }}><span aria-hidden="true">âš  </span>Risk: </span>
                    <span className="text-xs" style={{ color: txt2 }}>{v.risk}</span>
                  </div>
                </div>
              )
            })()}
          </div>
        </div>
      </div>
    )}

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
