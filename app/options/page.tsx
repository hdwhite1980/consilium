'use client'

// ═════════════════════════════════════════════════════════════
// app/options/page.tsx — Options allocation scanner UI
//
// User enters a budget + horizon, clicks scan, gets 5-8 option
// picks that fit. Each pick shows source badge (council / macro /
// universe), confidence, thesis, greeks, budget fit.
//
// Clicking a pick routes to /invest with ticker pre-filled so user
// can open the trade with stop/target/rationale.
// ═════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'
import {
  ArrowLeft, DollarSign, Zap, Search, Clock, TrendingUp, TrendingDown,
  AlertTriangle, Target, Scale, LogOut, ShieldCheck, Gauge, Globe
} from 'lucide-react'
import { MoversHitRateWidget } from '@/app/components/MoversHitRateWidget'

// ─────────────────────────────────────────────────────────────
// Types (must match /api/invest/options-scanner response)
// ─────────────────────────────────────────────────────────────
interface ScannerPick {
  ticker: string
  companyName?: string
  optionType: 'call' | 'put'
  strike: number
  expiration: string
  dte: number
  premium: number
  contractCost: number
  delta: number | null
  iv: number | null
  breakeven: number
  maxLoss: number
  confidence: number
  thesis: string
  horizon: 'short' | 'swing' | 'monthly'
  riskLevel: 'high' | 'medium' | 'low'
  catalyst: string
  sourceBadge: 'council' | 'macro' | 'universe'
  optionSymbol: string
  dataSource: 'tradier'
}

interface ScannerResult {
  budget: number
  horizon: string
  scannedTickers: number
  chainsRetrieved: number
  candidatesAfterFilter: number
  picks: ScannerPick[]
  regime: {
    label: 'risk-on' | 'risk-off' | 'mixed'
    spyChangePct: number | null
    vixLevel: number | null
    context: string
  }
  councilCandidateCount: number
  generatedAt: string
  elapsedMs: number
  cached: boolean
  ageMinutes?: number
  tradierMode: 'sandbox' | 'production'
  message?: string
  error?: string
}

// ─────────────────────────────────────────────────────────────
// Format helpers
// ─────────────────────────────────────────────────────────────
const fmt$ = (n: number) => `$${n.toFixed(2)}`
const fmtDate = (iso: string) => {
  try {
    const d = new Date(iso + 'T00:00:00Z')
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  } catch { return iso }
}

// ─────────────────────────────────────────────────────────────
// Pick card
// ─────────────────────────────────────────────────────────────
function PickCard({ pick, onUse }: { pick: ScannerPick; onUse: (p: ScannerPick) => void }) {
  const [expanded, setExpanded] = useState(false)
  const isCall = pick.optionType === 'call'
  const color = isCall ? '#34d399' : '#f87171'
  const bg = isCall ? 'rgba(52,211,153,0.04)' : 'rgba(248,113,113,0.04)'
  const border = isCall ? 'rgba(52,211,153,0.18)' : 'rgba(248,113,113,0.18)'

  const confColor = pick.confidence >= 80 ? '#34d399'
    : pick.confidence >= 70 ? '#fbbf24'
    : '#94a3b8'

  const sourceBadgeConfig: Record<ScannerPick['sourceBadge'], { label: string; color: string; bg: string }> = {
    council:  { label: 'Council-backed', color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
    macro:    { label: 'Macro setup',    color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
    universe: { label: 'Liquidity play', color: '#94a3b8', bg: 'rgba(148,163,184,0.10)' },
  }
  const srcCfg = sourceBadgeConfig[pick.sourceBadge]

  return (
    <div className="rounded-xl border transition-all" style={{ background: bg, borderColor: border }}>
      <div className="p-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="shrink-0 px-2.5 py-1 rounded-lg font-mono font-bold text-sm"
              style={{ background: `${color}18`, color, border: `1px solid ${color}30` }}>
              {pick.ticker}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold" style={{ color }}>
                  {pick.optionType.toUpperCase()} ${pick.strike}
                </span>
                <span className="text-xs text-white/50">{fmtDate(pick.expiration)}</span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                  style={{
                    background: pick.dte <= 7 ? 'rgba(248,113,113,0.12)' : 'rgba(148,163,184,0.10)',
                    color: pick.dte <= 7 ? '#f87171' : '#94a3b8',
                  }}>
                  {pick.dte}d
                </span>
              </div>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: srcCfg.bg, color: srcCfg.color, border: `1px solid ${srcCfg.color}28` }}
                  title={pick.sourceBadge === 'council' ? 'Ticker had recent non-NEUTRAL Council verdict' : pick.sourceBadge === 'macro' ? 'Picked based on market regime' : 'Picked from liquid universe'}>
                  {srcCfg.label}
                </span>
                <span className="text-[10px] font-mono"
                  style={{ color: pick.riskLevel === 'high' ? '#f87171' : pick.riskLevel === 'medium' ? '#fbbf24' : '#34d399' }}>
                  {pick.riskLevel} risk
                </span>
                <span className="text-[10px] font-mono text-white/40">
                  {pick.horizon}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="text-right">
              <div className="font-mono font-bold text-sm" style={{ color: confColor }}>
                {pick.confidence}%
              </div>
              <div className="text-[10px] text-white/40 font-mono">conf</div>
            </div>
            <span className="text-white/25 text-xs">{expanded ? '▲' : '▼'}</span>
          </div>
        </div>

        {/* Thesis preview (1 line when collapsed) */}
        <p className="text-xs text-white/55 mt-2.5 leading-relaxed line-clamp-2">{pick.thesis}</p>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t" style={{ borderColor: `${color}15` }}>

          {/* Full thesis */}
          <div className="pt-3">
            <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color }}>
              Why this setup
            </div>
            <p className="text-sm text-white/75 leading-relaxed">{pick.thesis}</p>
          </div>

          {/* Catalyst */}
          {pick.catalyst && (
            <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-1">Catalyst</div>
              <p className="text-xs text-white/65 leading-relaxed">{pick.catalyst}</p>
            </div>
          )}

          {/* Risk block */}
          <div className="rounded-lg p-3" style={{ background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.15)' }}>
            <div className="flex items-center gap-1.5 mb-2">
              <AlertTriangle size={10} style={{ color: '#f87171' }} />
              <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: '#f87171' }}>Risk</div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <div className="text-white/40 text-[9px] uppercase tracking-widest">Contract cost</div>
                <div className="font-mono text-white/80">{fmt$(pick.contractCost)}</div>
              </div>
              <div>
                <div className="text-white/40 text-[9px] uppercase tracking-widest">Max loss</div>
                <div className="font-mono text-red-300">{fmt$(pick.maxLoss)}</div>
              </div>
              {pick.delta !== null && (
                <div>
                  <div className="text-white/40 text-[9px] uppercase tracking-widest">Delta</div>
                  <div className="font-mono text-white/80">
                    {pick.delta >= 0 ? '+' : ''}{pick.delta.toFixed(2)}
                  </div>
                </div>
              )}
              {pick.iv !== null && pick.iv > 0 && (
                <div>
                  <div className="text-white/40 text-[9px] uppercase tracking-widest">IV</div>
                  <div className="font-mono text-white/80">{(pick.iv * 100).toFixed(0)}%</div>
                </div>
              )}
              <div>
                <div className="text-white/40 text-[9px] uppercase tracking-widest">Breakeven</div>
                <div className="font-mono text-white/80">{fmt$(pick.breakeven)}</div>
              </div>
              <div>
                <div className="text-white/40 text-[9px] uppercase tracking-widest">DTE</div>
                <div className="font-mono" style={{ color: pick.dte <= 7 ? '#f87171' : 'white' }}>
                  {pick.dte} days
                </div>
              </div>
            </div>
          </div>

          {/* Use in Invest button */}
          <button
            onClick={(e) => { e.stopPropagation(); onUse(pick) }}
            className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 active:scale-98"
            style={{ background: `${color}20`, color, border: `1px solid ${color}35` }}>
            Open this trade in /invest →
          </button>

          <p className="text-[10px] text-white/30 text-center">
            Data: Tradier live chain · Routes to Invest page to open the trade with stop/target
          </p>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────
export default function OptionsPage() {
  const router = useRouter()
  const supabase = createClient()

  const [authLoaded, setAuthLoaded] = useState(false)
  const [budgetInput, setBudgetInput] = useState('2000')
  const [horizon, setHorizon] = useState<'short' | 'swing' | 'any'>('any')
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<ScannerResult | null>(null)
  const [errMsg, setErrMsg] = useState<string | null>(null)

  // Auth gate
  useEffect(() => {
    let mounted = true
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!mounted) return
      if (!user) {
        window.location.replace('/login')
        return
      }
      setAuthLoaded(true)
    })
    return () => { mounted = false }
  }, [supabase])

  const runScan = useCallback(async () => {
    setErrMsg(null)
    const budget = parseFloat(budgetInput.replace(/[,$\s]/g, ''))
    if (!Number.isFinite(budget) || budget < 100) {
      setErrMsg('Budget must be at least $100')
      return
    }
    if (budget > 1_000_000) {
      setErrMsg('Budget is too large (max $1M for paper-trading education)')
      return
    }

    setScanning(true)
    try {
      const res = await fetch('/api/invest/options-scanner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budget, horizon }),
      })
      const body = await res.json()
      if (!res.ok) {
        setErrMsg(body?.error ?? 'Scanner failed')
        setScanning(false)
        return
      }
      setResult(body as ScannerResult)
    } catch (e) {
      setErrMsg((e as Error).message?.slice(0, 200) ?? 'Network error')
    } finally {
      setScanning(false)
    }
  }, [budgetInput, horizon])

  const handleUsePick = useCallback((pick: ScannerPick) => {
    // Route to /invest with ticker + option context pre-filled via query
    const params = new URLSearchParams({
      ticker: pick.ticker,
      optionType: pick.optionType,
      strike: String(pick.strike),
      expiration: pick.expiration,
      premium: String(pick.premium),
    })
    router.push(`/invest?${params.toString()}`)
  }, [router])

  const handleSignOut = async () => {
    try { await fetch('/api/auth/session', { method: 'DELETE' }) } catch { /* ignore */ }
    await supabase.auth.signOut()
    window.location.replace('/login')
  }

  if (!authLoaded) {
    return (
      <main className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="flex gap-1.5">
          {[0,1,2].map(i => (
            <span key={i} className="w-2 h-2 rounded-full thinking-dot"
              style={{ background: '#a78bfa', animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
      </main>
    )
  }

  const picks = result?.picks ?? []
  const regime = result?.regime

  return (
    <main className="min-h-screen flex flex-col" style={{ background: 'var(--bg)', color: 'var(--text1)' }}>
      {/* Header */}
      <header className="flex items-center justify-between px-3 sm:px-5 py-3 border-b"
        style={{ background: 'var(--nav-bg)', borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-3">
          <button onClick={() => router.push('/')}
            className="flex items-center gap-1 text-[11px] font-mono px-2.5 py-1.5 rounded-lg transition-all hover:opacity-80"
            style={{ background: 'var(--surface2)', color: 'var(--text3)', border: '1px solid rgba(255,255,255,0.1)' }}>
            <ArrowLeft size={11} />
            <span className="hidden sm:inline">Home</span>
          </button>
          <div className="flex items-center gap-2">
            <Target size={14} style={{ color: '#a78bfa' }} />
            <h1 className="text-sm font-bold">Options Scanner</h1>
            {result && (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                style={{
                  background: result.cached ? 'rgba(251,191,36,0.12)' : 'rgba(52,211,153,0.12)',
                  color: result.cached ? '#fbbf24' : '#34d399',
                  border: `1px solid ${result.cached ? 'rgba(251,191,36,0.25)' : 'rgba(52,211,153,0.25)'}`,
                }}>
                {result.cached ? `Cached ${result.ageMinutes}m ago` : 'Fresh'}
              </span>
            )}
          </div>
        </div>
        <button onClick={handleSignOut}
          className="flex items-center gap-1 text-[10px] font-mono px-2.5 py-1.5 rounded-lg transition-all hover:opacity-80"
          style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
          <LogOut size={10} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-3 sm:px-5 py-5 space-y-5">

          {/* Hit rate widget */}
          <MoversHitRateWidget source="today" />

          {/* Scan form */}
          <section className="rounded-2xl border p-4 sm:p-5"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2 mb-3">
              <Zap size={14} style={{ color: '#a78bfa' }} />
              <span className="text-sm font-bold">Find option plays for your budget</span>
            </div>
            <p className="text-xs text-white/50 leading-relaxed mb-4">
              The scanner checks ~100 liquid optionable stocks + any tickers from recent Council verdicts (non-NEUTRAL).
              It filters for budget fit, picks candidates with real option chain data from Tradier, then selects the 5-8 best plays.
              First scan takes 50-90 seconds. Cached for 15 minutes after.
            </p>

            {/* Inputs */}
            <div className="grid grid-cols-1 sm:grid-cols-[1fr,1fr,auto] gap-3">
              {/* Budget */}
              <div>
                <label className="text-[10px] font-mono uppercase tracking-widest text-white/40 block mb-1">
                  Budget
                </label>
                <div className="relative">
                  <DollarSign size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text3)' }} />
                  <input
                    type="text"
                    inputMode="decimal"
                    value={budgetInput}
                    onChange={(e) => setBudgetInput(e.target.value)}
                    placeholder="2000"
                    disabled={scanning}
                    className="w-full pl-8 pr-3 py-2.5 rounded-lg text-sm font-mono"
                    style={{
                      background: 'var(--surface2)',
                      color: 'var(--text1)',
                      border: '1px solid rgba(255,255,255,0.1)',
                    }}
                  />
                </div>
              </div>

              {/* Horizon */}
              <div>
                <label className="text-[10px] font-mono uppercase tracking-widest text-white/40 block mb-1">
                  Horizon
                </label>
                <div className="flex gap-1">
                  {(['any', 'short', 'swing'] as const).map(h => (
                    <button
                      key={h}
                      onClick={() => setHorizon(h)}
                      disabled={scanning}
                      className="flex-1 px-2 py-2.5 rounded-lg text-xs font-mono transition-all"
                      style={{
                        background: horizon === h ? 'rgba(167,139,250,0.15)' : 'var(--surface2)',
                        color: horizon === h ? '#a78bfa' : 'var(--text3)',
                        border: `1px solid ${horizon === h ? 'rgba(167,139,250,0.3)' : 'rgba(255,255,255,0.1)'}`,
                      }}>
                      {h === 'any' ? 'Any' : h === 'short' ? 'Short (3-10d)' : 'Swing (14-30d)'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Run button */}
              <div className="flex items-end">
                <button
                  onClick={runScan}
                  disabled={scanning}
                  className="px-5 py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 w-full sm:w-auto"
                  style={{
                    background: scanning ? 'var(--surface2)' : 'rgba(167,139,250,0.18)',
                    color: scanning ? 'var(--text3)' : '#a78bfa',
                    border: '1px solid rgba(167,139,250,0.3)',
                  }}>
                  {scanning ? (
                    <span className="flex items-center gap-2">
                      <span className="inline-flex gap-1">
                        {[0,1,2].map(i => (
                          <span key={i} className="w-1.5 h-1.5 rounded-full thinking-dot"
                            style={{ background: '#a78bfa', animationDelay: `${i * 0.15}s` }} />
                        ))}
                      </span>
                      Scanning…
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Search size={12} />
                      Run scan
                    </span>
                  )}
                </button>
              </div>
            </div>

            {errMsg && (
              <div className="mt-3 text-xs p-2.5 rounded-lg flex items-start gap-2"
                style={{ background: 'rgba(248,113,113,0.08)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>{errMsg}</span>
              </div>
            )}

            {scanning && (
              <p className="mt-3 text-[11px] text-white/40 leading-relaxed">
                Scanning ~100 liquid optionable tickers. Fetching Tradier chains, pre-filtering candidates, then Claude picks the best 5-8.
                This takes 50-90 seconds on first run, instant when cached.
              </p>
            )}
          </section>

          {/* Results header — regime + stats */}
          {result && (
            <section className="rounded-2xl border p-4"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2 flex-wrap">
                <Globe size={13} style={{ color: '#a78bfa' }} />
                <span className="text-[10px] font-mono uppercase tracking-widest text-white/40">
                  Market
                </span>
                {regime && (
                  <span
                    className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                    style={{
                      background: regime.label === 'risk-on' ? 'rgba(52,211,153,0.12)'
                        : regime.label === 'risk-off' ? 'rgba(248,113,113,0.12)'
                        : 'rgba(148,163,184,0.10)',
                      color: regime.label === 'risk-on' ? '#34d399'
                        : regime.label === 'risk-off' ? '#f87171'
                        : '#94a3b8',
                      border: `1px solid ${regime.label === 'risk-on' ? 'rgba(52,211,153,0.25)' : regime.label === 'risk-off' ? 'rgba(248,113,113,0.25)' : 'rgba(148,163,184,0.18)'}`,
                    }}
                    title={regime.context}>
                    {regime.label}
                    {regime.vixLevel !== null && ` · VIX ${regime.vixLevel.toFixed(1)}`}
                  </span>
                )}
                <span className="text-white/25 text-xs">·</span>
                <span className="text-[10px] font-mono text-white/50">
                  Budget {fmt$(result.budget)}
                </span>
                <span className="text-white/25 text-xs">·</span>
                <span className="text-[10px] font-mono text-white/50">
                  {result.scannedTickers} scanned
                </span>
                <span className="text-white/25 text-xs">·</span>
                <span className="text-[10px] font-mono text-white/50">
                  {result.chainsRetrieved} chains returned
                </span>
                <span className="text-white/25 text-xs">·</span>
                <span className="text-[10px] font-mono text-white/50">
                  {result.candidatesAfterFilter} candidates
                </span>
                {result.councilCandidateCount > 0 && (
                  <>
                    <span className="text-white/25 text-xs">·</span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(96,165,250,0.12)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.25)' }}>
                      {result.councilCandidateCount} Council verdicts
                    </span>
                  </>
                )}
              </div>
              {regime?.context && (
                <p className="text-xs text-white/60 mt-2">{regime.context}</p>
              )}
              {result.tradierMode === 'sandbox' && (
                <p className="text-[10px] text-white/40 mt-2 italic">
                  Data from Tradier sandbox — 15-minute delay. Paper-trading only. Verify on your broker before trading real money.
                </p>
              )}
            </section>
          )}

          {/* Picks */}
          {result && picks.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Target size={14} style={{ color: '#a78bfa' }} />
                <h2 className="text-sm font-semibold">Best {picks.length} option play{picks.length === 1 ? '' : 's'} for your budget</h2>
              </div>
              {picks.map((p) => (
                <PickCard key={p.optionSymbol || `${p.ticker}-${p.strike}-${p.expiration}-${p.optionType}`}
                  pick={p} onUse={handleUsePick} />
              ))}
            </section>
          )}

          {/* Empty state — result exists but no picks */}
          {result && picks.length === 0 && !result.error && (
            <section className="rounded-2xl border p-6 text-center"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <Scale size={20} className="mx-auto mb-2 opacity-50" style={{ color: '#94a3b8' }} />
              <p className="text-sm text-white/70 font-semibold mb-1">No option plays fit this budget right now</p>
              <p className="text-xs text-white/50 max-w-md mx-auto leading-relaxed">
                {result.message ?? 'The scanner filtered 100 tickers but nothing met all thresholds (budget fit, liquidity, regime alignment). Try a larger budget, different horizon, or wait for market conditions to shift.'}
              </p>
            </section>
          )}

          {/* Pre-scan state — show what the scanner does */}
          {!result && !scanning && (
            <section className="rounded-2xl border p-5 sm:p-6"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2 mb-3">
                <Gauge size={14} style={{ color: '#60a5fa' }} />
                <h3 className="text-sm font-semibold">How the scanner picks</h3>
              </div>
              <div className="space-y-3 text-xs text-white/65 leading-relaxed">
                <div className="flex gap-2">
                  <span className="shrink-0 font-mono font-bold" style={{ color: '#60a5fa' }}>1.</span>
                  <span>
                    <span className="font-semibold text-white/80">Universe:</span> ~100 curated optionable tickers
                    across all sectors, plus any tickers from your recent Council verdicts that came back BULLISH or BEARISH.
                    NEUTRAL verdicts are excluded — only directional convictions feed into options.
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="shrink-0 font-mono font-bold" style={{ color: '#60a5fa' }}>2.</span>
                  <span>
                    <span className="font-semibold text-white/80">Chain fetch:</span> Pulls real option chains from Tradier
                    for each ticker across near-week, two-week, and monthly expirations.
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="shrink-0 font-mono font-bold" style={{ color: '#60a5fa' }}>3.</span>
                  <span>
                    <span className="font-semibold text-white/80">Pre-filter:</span> Drops illiquid contracts (low OI,
                    wide spreads), penny options, and anything outside your budget. Council-backed tickers are restricted
                    to the matching direction (calls for BULLISH, puts for BEARISH).
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="shrink-0 font-mono font-bold" style={{ color: '#60a5fa' }}>4.</span>
                  <span>
                    <span className="font-semibold text-white/80">Claude ranks:</span> Given current market regime
                    (risk-on / risk-off / mixed), Claude picks the 5-8 best plays with confidence scores ≥60%.
                    Each pick gets a plain-English thesis and catalyst.
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="shrink-0 font-mono font-bold" style={{ color: '#60a5fa' }}>5.</span>
                  <span>
                    <span className="font-semibold text-white/80">Track:</span> Every pick is logged so hit rates
                    accumulate in the accuracy widget above. See real performance after 1-2 weeks of use.
                  </span>
                </div>
              </div>

              <div className="mt-5 pt-4 border-t text-xs text-white/45 leading-relaxed space-y-1"
                style={{ borderColor: 'var(--border)' }}>
                <p className="flex items-center gap-1.5">
                  <ShieldCheck size={11} />
                  <span>
                    Option picks are educational/paper-trading only.
                    Verify independently before placing real trades.
                  </span>
                </p>
                <p className="flex items-center gap-1.5">
                  <Clock size={11} />
                  <span>
                    First scan takes 50-90 seconds. Same budget rescans within 15 minutes are cached and instant.
                  </span>
                </p>
              </div>
            </section>
          )}

          {/* Footer */}
          <div className="text-center py-4">
            <p className="text-[10px] text-white/30 leading-relaxed max-w-md mx-auto">
              Short-term options prediction ceiling is ~55-60% even for professionals.
              Picks are starting points for research, not trade commands.
            </p>
          </div>
        </div>
      </div>
    </main>
  )
}
