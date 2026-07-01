'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Home, ChevronDown, ChevronUp, TrendingUp, TrendingDown, Minus } from 'lucide-react'

type TF = '1D' | '1W' | '1M'

interface PublicVerdict {
  id: number
  ticker: string
  signal: string
  confidence: number | null
  entryPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  sourceLabel: string
  isAuto: boolean
  verdictDate: string | null
  createdAt: string | null
  outcome: string
  outcomeStrict: string | null
}
interface CompanyGroup { ticker: string; verdicts: PublicVerdict[]; wins: number; losses: number; graded: number }
interface TimeframeGroup {
  timeframe: TF; label: string; companies: CompanyGroup[]
  totalVerdicts: number; wins: number; losses: number; graded: number
}
interface VersionTab {
  number: number | null
  label: string
  subtitle: string
  maturity: string
  count: number
  isCurrent: boolean
}
interface SelectedVersion {
  number: number
  label: string
  subtitle: string
  summary: string
  maturity: string
}
interface Feed {
  ok: boolean
  groups: TimeframeGroup[]
  stats: { totalVerdicts: number; totalGraded: number; hitRate: number | null; directionAcc: number | null; expectancyR: number | null; profitFactor: number | null }
  versions: VersionTab[]
  selectedVersion: SelectedVersion | null
}

const fmtPrice = (n: number | null) =>
  n != null ? `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 4 : 2 })}` : '—'

function SignalBadge({ signal }: { signal: string }) {
  const s = signal.toUpperCase()
  const bull = s === 'BULLISH'
  const bear = s === 'BEARISH'
  const color = bull ? '#34d399' : bear ? '#f87171' : '#9ca3af'
  const Icon = bull ? TrendingUp : bear ? TrendingDown : Minus
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color }}>
      <Icon size={12} /> {s}
    </span>
  )
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const o = (outcome || 'pending').toLowerCase()
  const map: Record<string, { c: string; bg: string; t: string }> = {
    win:     { c: '#34d399', bg: 'rgba(52,211,153,0.12)', t: 'WIN' },
    loss:    { c: '#f87171', bg: 'rgba(248,113,113,0.12)', t: 'LOSS' },
    pending: { c: '#9ca3af', bg: 'rgba(156,163,175,0.10)', t: 'PENDING' },
    expired: { c: '#6b7280', bg: 'rgba(107,114,128,0.10)', t: 'EXPIRED' },
  }
  const m = map[o] ?? map.pending
  return (
    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ color: m.c, background: m.bg }}>
      {m.t}
    </span>
  )
}

function CompanyRow({ c }: { c: CompanyGroup }) {
  const [open, setOpen] = useState(false)
  const latest = c.verdicts[0]
  const rate = c.graded > 0 ? Math.round((c.wins / c.graded) * 100) : null
  return (
    <div className="rounded-xl border border-white/10 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-white/[0.03] transition-colors">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-bold text-sm text-white">{c.ticker}</span>
          {latest && <SignalBadge signal={latest.signal} />}
          <span className="text-[10px] text-white/35">{c.verdicts.length} call{c.verdicts.length > 1 ? 's' : ''}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {rate !== null && (
            <span className="text-[11px] font-mono" style={{ color: rate >= 50 ? '#34d399' : '#f87171' }}>
              {rate}% · {c.wins}/{c.graded}
            </span>
          )}
          {open ? <ChevronUp size={15} className="text-white/40" /> : <ChevronDown size={15} className="text-white/40" />}
        </div>
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 flex flex-col gap-2 border-t border-white/5">
          {c.verdicts.map(v => (
            <div key={v.id} className="flex items-center justify-between gap-3 py-2 border-b border-white/5 last:border-0">
              <div className="flex flex-col gap-1 min-w-0">
                <div className="flex items-center gap-2">
                  <SignalBadge signal={v.signal} />
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full"
                    style={{ background: v.isAuto ? 'rgba(96,165,250,0.12)' : 'rgba(255,255,255,0.06)', color: v.isAuto ? '#60a5fa' : 'rgba(255,255,255,0.5)' }}>
                    {v.sourceLabel}
                  </span>
                  {v.confidence != null && (
                    <span className="text-[10px] text-white/35 font-mono">{v.confidence}%</span>
                  )}
                </div>
                <div className="text-[11px] font-mono text-white/45">
                  entry {fmtPrice(v.entryPrice)} · stop {fmtPrice(v.stopLoss)} · target {fmtPrice(v.takeProfit)}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <OutcomeBadge outcome={v.outcome} />
                <span className="text-[10px] text-white/30">{v.verdictDate ?? ''}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TimeframeSection({ g }: { g: TimeframeGroup }) {
  const [open, setOpen] = useState(true)
  const rate = g.graded > 0 ? Math.round((g.wins / g.graded) * 100) : null
  return (
    <section className="mb-6">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between gap-3 mb-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-bold text-white">{g.label}</h2>
          <span className="text-[11px] text-white/40">{g.companies.length} companies · {g.totalVerdicts} verdicts</span>
        </div>
        <div className="flex items-center gap-3">
          {rate !== null && (
            <span className="text-sm font-mono" style={{ color: rate >= 50 ? '#34d399' : '#f87171' }}>
              {rate}% hit · {g.wins}/{g.graded} graded
            </span>
          )}
          {open ? <ChevronUp size={16} className="text-white/40" /> : <ChevronDown size={16} className="text-white/40" />}
        </div>
      </button>
      {open && (
        <div className="flex flex-col gap-2">
          {g.companies.length === 0
            ? <p className="text-[12px] text-white/30 px-1 py-4">No verdicts in this timeframe yet.</p>
            : g.companies.map(c => <CompanyRow key={c.ticker} c={c} />)}
        </div>
      )}
    </section>
  )
}

export default function VerdictsPage() {
  const router = useRouter()
  const [feed, setFeed] = useState<Feed | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  // null = All-time; a number selects a specific system version
  const [version, setVersion] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    ;(async () => {
      try {
        const qs = version != null ? `?version=${version}` : ''
        const res = await fetch(`/api/verdicts/feed${qs}`, { cache: 'no-store' })
        const json = await res.json()
        if (!alive) return
        if (!json.ok) { setErr('Could not load verdicts.'); setLoading(false); return }
        setErr(null); setFeed(json); setLoading(false)
      } catch {
        if (alive) { setErr('Could not load verdicts.'); setLoading(false) }
      }
    })()
    return () => { alive = false }
  }, [version])

  return (
    <div className="min-h-screen" style={{ background: '#0a0a0f', color: '#fff' }}>
      <div className="max-w-3xl mx-auto px-4 py-6">
        {/* Nav */}
        <div className="flex items-center gap-2 mb-6">
          <button onClick={() => router.back()} title="Back"
            className="flex items-center px-2.5 py-2 rounded-lg text-xs hover:bg-white/5"
            style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
            <ArrowLeft size={14} />
          </button>
          <button onClick={() => router.push('/')} title="Home"
            className="flex items-center px-2.5 py-2 rounded-lg text-xs hover:bg-white/5"
            style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
            <Home size={14} />
          </button>
        </div>

        {/* Hero: the scoreboard */}
        <header className="mb-8">
          <h1 className="text-2xl font-bold mb-1">Council Verdicts</h1>
          <p className="text-[13px] text-white/50">
            Every call Max and Wali make — auto-traded and manual — with the entry, stop, target, and how it resolved.
          </p>

          {/* Version tabs */}
          {feed?.versions && feed.versions.length > 1 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {feed.versions.map(v => {
                const active = v.number === version
                return (
                  <button
                    key={v.number ?? 'all'}
                    onClick={() => setVersion(v.number)}
                    className="px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
                    style={{
                      background: active ? '#3b82f6' : 'rgba(255,255,255,0.04)',
                      color: active ? '#fff' : 'rgba(255,255,255,0.6)',
                      border: active ? '1px solid #3b82f6' : '1px solid rgba(255,255,255,0.1)',
                    }}>
                    {v.label}
                    <span className="ml-1.5 opacity-60">{v.count}</span>
                    {v.isCurrent && (
                      <span className="ml-1.5 text-[9px] uppercase tracking-wide" style={{ color: active ? 'rgba(255,255,255,0.8)' : '#34d399' }}>
                        current
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {/* Selected version subtitle */}
          {feed?.selectedVersion && (
            <div className="mt-3">
              <p className="text-[13px] text-white/70 font-medium">{feed.selectedVersion.subtitle}</p>
              <p className="text-[12px] text-white/40 mt-0.5">{feed.selectedVersion.summary}</p>
              {feed.selectedVersion.maturity === 'preview' && (
                <span className="inline-block mt-1.5 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full text-amber-300/90"
                  style={{ background: 'rgba(252,211,77,0.08)', border: '1px solid rgba(252,211,77,0.2)' }}>
                  preview — small sample
                </span>
              )}
            </div>
          )}

          {feed?.stats && (
            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
              <div>
                <div className="text-2xl font-bold">{feed.stats.hitRate != null ? `${feed.stats.hitRate}%` : '—'}</div>
                <div className="text-[10px] uppercase tracking-wide text-white/40">hit rate (1W target)</div>
              </div>
              <div>
                <div className="text-2xl font-bold">{feed.stats.directionAcc != null ? `${feed.stats.directionAcc}%` : '—'}</div>
                <div className="text-[10px] uppercase tracking-wide text-white/40">direction</div>
              </div>
              <div>
                <div className="text-2xl font-bold">{feed.stats.totalGraded}</div>
                <div className="text-[10px] uppercase tracking-wide text-white/40">graded</div>
              </div>
              <div>
                <div className="text-2xl font-bold">{feed.stats.totalVerdicts}</div>
                <div className="text-[10px] uppercase tracking-wide text-white/40">total verdicts</div>
              </div>
            </div>
          )}
          {/* Honesty banner — keep it loud until the sample is real */}
          {feed?.stats && feed.stats.totalGraded < 200 && (
            <p className="mt-3 text-[11px] text-amber-300/80 border border-amber-300/20 rounded-lg px-3 py-2 bg-amber-300/[0.04]">
              Preview — only {feed.stats.totalGraded} graded outcomes. Too small to draw conclusions yet; numbers will move as the record grows.
            </p>
          )}
        </header>

        {loading && <p className="text-white/40 text-sm">Loading verdicts…</p>}
        {err && <p className="text-red-400/80 text-sm">{err}</p>}

        {feed?.groups.map(g => <TimeframeSection key={g.timeframe} g={g} />)}

        {/* Subscribe CTA */}
        <div className="mt-10 rounded-2xl border border-white/10 p-6 text-center" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <h3 className="text-lg font-bold mb-1">Get the calls by email</h3>
          <p className="text-[13px] text-white/50 mb-4">
            New verdicts and trade changes — tightened stops, exits — sent as they happen.
          </p>
          <button onClick={() => router.push('/subscribe')}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold"
            style={{ background: '#3b82f6', color: '#fff' }}>
            Subscribe
          </button>
        </div>

        <p className="mt-8 text-[10px] text-white/25 text-center">
          Informational only, not financial advice. Outcomes are directional (was the call&apos;s direction right) unless a stop/target resolved it strictly.
        </p>
      </div>
    </div>
  )
}
