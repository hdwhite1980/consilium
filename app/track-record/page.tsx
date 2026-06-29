'use client'

// =============================================================
// app/track-record/page.tsx
//
// Track Record page — version timeline + improvements log +
// per-version hit-rate / direction-accuracy breakdown.
//
// This is the "we work on this every week" surface. It's the
// honest version of the dashboard — shows the system getting
// better over time, with each version's improvements documented
// in user-facing language.
// =============================================================

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, LogOut, RefreshCw, Trophy, Sparkles, Target, TrendingUp,
  CheckCircle2, AlertCircle, Clock,
} from 'lucide-react'
import {
  SYSTEM_VERSIONS, getCurrentVersion, getVersionsNewestFirst,
  type SystemVersion,
} from '@/app/lib/system-versions'
import { VerdictList } from '@/app/components/VerdictList'

interface VersionStats {
  hitRate1w: number | null
  directionAcc1w: number | null
  totalVerdicts: number
  gradedVerdicts: number
  sampleNote: string | null
  expectancyR?: number | null
  profitFactor?: number | null
  payoffRatio?: number | null
  avgWinR?: number | null
  totalR?: number | null
  avgReturnPct?: number | null
  medianReturnPct?: number | null
  byAsset?: { stock: AssetBucket; crypto: AssetBucket; forex: AssetBucket }
  versionLabel: string
}

interface AssetBucket {
  gradedVerdicts: number
  hitRate1w: number | null
  expectancyR: number | null
  profitFactor: number | null
  medianReturnPct: number | null
}

export default function TrackRecordPage() {
  const router = useRouter()
  // Memoized so identity is stable across renders (otherwise loadAll → useEffect → re-render loop)
  const versions = useMemo(() => getVersionsNewestFirst(), [])
  const currentVersion = useMemo(() => getCurrentVersion(), [])

  const [statsByVersion, setStatsByVersion] = useState<Map<number, VersionStats>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Verdict-list filter wiring: when user clicks a version card, lock the list filter
  // to that version and scroll the list into view.
  const [filteredVersion, setFilteredVersion] = useState<number | null>(null)
  const verdictListRef = useRef<HTMLDivElement | null>(null)

  const handleVersionClick = useCallback((versionNumber: number) => {
    setFilteredVersion(versionNumber)
    // Defer scroll so React commits the state change first
    setTimeout(() => {
      verdictListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }, [])

  const handleClearFilter = useCallback(() => {
    setFilteredVersion(null)
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const results = await Promise.all(
        versions.map(async v => {
          const res = await fetch(`/api/track-record/stats?version=${v.number}&source=track-record`)
          if (!res.ok) throw new Error(`Failed to load ${v.label}`)
          return [v.number, await res.json()] as [number, VersionStats]
        }),
      )
      setStatsByVersion(new Map(results))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [versions])

  useEffect(() => { loadAll() }, [loadAll])

  const handleSignOut = async () => {
    try { await fetch('/api/auth/session', { method: 'DELETE' }) } catch { /* ignore */ }
    try {
      Object.keys(localStorage).filter(k => k.startsWith('sb-')).forEach(k => localStorage.removeItem(k))
      document.cookie.split(';').forEach(c => {
        const name = c.split('=')[0].trim()
        if (name.startsWith('sb-')) {
          document.cookie = name + '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
        }
      })
    } catch { /* ignore */ }
    window.location.replace('/login')
  }

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>

      {/* Header */}
      <header
        className="flex flex-wrap items-center gap-2 px-3 py-3 border-b sticky top-0 z-10"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70">
          <ArrowLeft size={13} />
          Back
        </button>
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        <div className="flex items-center gap-2">
          <Trophy size={14} style={{ color: '#fbbf24' }} />
          <span className="text-sm font-bold">Track Record</span>
        </div>
        <span className="text-[10px] font-mono text-white/25">how the system is improving</span>

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={handleSignOut}
            className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70"
          >
            <LogOut size={13} />
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-3 py-5 space-y-6">

        {/* Intro */}
        <section
          className="rounded-xl p-5 border"
          style={{
            background: 'linear-gradient(135deg, rgba(251,191,36,0.04) 0%, rgba(167,139,250,0.04) 100%)',
            borderColor: 'rgba(251,191,36,0.18)',
          }}
        >
          <div className="flex items-start gap-3">
            <Sparkles size={20} style={{ color: '#fbbf24' }} className="mt-0.5 shrink-0" />
            <div>
              <h1 className="text-lg font-bold mb-1.5">A system that gets better with each version</h1>
              <p className="text-sm text-white/65 leading-relaxed">
                Wali-OS is actively developed. Each version brings refinements to how evidence is gathered,
                how risk is evaluated, and how trade plans are constructed. This page tracks every release
                with its measured outcomes — including the periods where the numbers were worse, because
                that's how progress actually looks.
              </p>
            </div>
          </div>
        </section>

        {/* Loading / error */}
        {loading && (
          <div className="flex items-center justify-center py-10">
            <RefreshCw size={18} className="animate-spin text-white/30" />
            <span className="ml-2 text-xs text-white/40">Loading versions…</span>
          </div>
        )}
        {error && (
          <div className="rounded-xl border p-4 flex items-start gap-2"
            style={{ background: 'rgba(248,113,113,0.05)', borderColor: 'rgba(248,113,113,0.2)' }}>
            <AlertCircle size={14} style={{ color: '#f87171' }} className="shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-semibold" style={{ color: '#f87171' }}>Failed to load</div>
              <p className="text-[11px] text-white/55 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* Version timeline */}
        {!loading && !error && versions.map((version, idx) => (
          <VersionCard
            key={version.number}
            version={version}
            stats={statsByVersion.get(version.number) ?? null}
            isCurrent={version.number === currentVersion.number}
            isLast={idx === versions.length - 1}
            onClick={() => handleVersionClick(version.number)}
          />
        ))}

        {/* Recent verdicts — the receipts */}
        <div ref={verdictListRef} className="pt-2">
          <VerdictList
            externalVersion={filteredVersion}
            onClearExternalVersion={handleClearFilter}
          />
        </div>

        {/* Footer note */}
        <div className="pt-4 pb-8 text-center">
          <p className="text-[10px] text-white/25 font-mono leading-relaxed">
            Outcomes are computed from real market data once 5 trading days have elapsed since a verdict.
            <br />
            New versions need ~30 graded outcomes before their hit rate is statistically meaningful.
          </p>
        </div>
      </main>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function VersionCard({
  version, stats, isCurrent, isLast, onClick,
}: {
  version: SystemVersion
  stats: VersionStats | null
  isCurrent: boolean
  isLast: boolean
  onClick: () => void
}) {
  const dateLabel = formatVersionDate(version.releasedAt)

  // Color theme by maturity
  const maturityColor =
    version.maturity === 'preview' ? '#fbbf24' :
    version.maturity === 'mature'  ? '#34d399' :
    /* historical */                 '#94a3b8'

  return (
    <section className="relative">

      {/* Vertical timeline line (continues to next version) */}
      {!isLast && (
        <div
          className="absolute left-3 top-12 bottom-[-1.5rem] w-px"
          style={{ background: 'rgba(255,255,255,0.08)' }}
        />
      )}

      <div className="flex gap-4">
        {/* Timeline dot */}
        <div className="shrink-0 mt-3">
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center"
            style={{
              background: isCurrent ? 'rgba(52,211,153,0.18)' : 'rgba(255,255,255,0.05)',
              border: `2px solid ${isCurrent ? '#34d399' : 'rgba(255,255,255,0.15)'}`,
            }}
          >
            {isCurrent && <CheckCircle2 size={12} style={{ color: '#34d399' }} />}
          </div>
        </div>

        {/* Card — clickable to filter verdict list */}
        <button
          type="button"
          onClick={onClick}
          className="flex-1 rounded-xl border p-5 text-left hover:border-white/20 transition-colors group cursor-pointer"
          style={{
            background: 'var(--surface)',
            borderColor: isCurrent ? 'rgba(52,211,153,0.25)' : 'var(--border)',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold">{version.label}</h2>
              {isCurrent && (
                <span
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-widest"
                  style={{ background: 'rgba(52,211,153,0.12)', color: '#34d399', border: '1px solid rgba(52,211,153,0.25)' }}
                >
                  current
                </span>
              )}
              <span
                className="text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-widest"
                style={{ background: `${maturityColor}10`, color: maturityColor, border: `1px solid ${maturityColor}25` }}
              >
                {version.maturity}
              </span>
            </div>
            <span className="text-[11px] font-mono text-white/35">{dateLabel}</span>
          </div>
          {version.subtitle && (
            <p className="text-xs text-white/55 italic mb-3">{version.subtitle}</p>
          )}

          {/* Summary */}
          <p className="text-sm text-white/75 leading-relaxed mb-4">{version.summary}</p>

          {/* Stats strip */}
          {stats && (
            <div
              className="rounded-lg p-3 mb-4"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}
            >
              {stats.sampleNote && (
                <div
                  className="px-2.5 py-1.5 rounded-md text-[10px] font-mono mb-2"
                  style={{
                    background: 'rgba(251,191,36,0.06)',
                    color: '#fbbf24',
                    border: '1px solid rgba(251,191,36,0.15)',
                  }}
                >
                  <Clock size={10} className="inline mr-1" style={{ verticalAlign: 'middle' }} />
                  {stats.sampleNote}
                </div>
              )}
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Hit rate" value={stats.hitRate1w} suffix="%" accent="#34d399" icon={<Target size={11} />} />
                <Stat label="Direction" value={stats.directionAcc1w} suffix="%" accent="#60a5fa" icon={<TrendingUp size={11} />} />
                <Stat label="Verdicts" value={stats.totalVerdicts} suffix="" accent="rgba(255,255,255,0.65)" detail={`${stats.gradedVerdicts} graded`} />
              </div>
              {(stats.expectancyR != null || stats.profitFactor != null) && (
                <>
                  <div className="grid grid-cols-3 gap-3 mt-3">
                    <Stat label="Expectancy" value={stats.expectancyR ?? null} suffix="R" accent={(stats.expectancyR ?? 0) > 0 ? '#34d399' : '#f87171'} detail="per trade" />
                    <Stat label="Profit factor" value={stats.profitFactor ?? null} suffix="" accent={(stats.profitFactor ?? 0) >= 1 ? '#34d399' : '#f87171'} detail={(stats.profitFactor ?? 0) >= 1 ? 'profitable' : 'unprofitable'} />
                    <Stat label="Avg return" value={stats.avgReturnPct ?? null} suffix="%" accent={(stats.avgReturnPct ?? 0) > 0 ? '#34d399' : '#f87171'} detail="per verdict, 1W" />
                  </div>
                  <p className="text-[9px] font-mono text-white/30 mt-2 leading-relaxed">
                    Expectancy = average R won per trade (target = +R, stop = −1R). Above 0 means a real edge;
                    profit factor above 1 means winners outweigh losers. These — not hit rate — decide whether the edge makes money.
                  </p>
                  {stats.byAsset && (
                    <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                      <div className="text-[9px] font-mono uppercase tracking-widest text-white/30 mb-1.5">by asset class</div>
                      <div className="space-y-1">
                        {(['stock', 'crypto', 'forex'] as const).map(a => {
                          const b = stats.byAsset![a]
                          if (!b || b.gradedVerdicts === 0) return null
                          return (
                            <div key={a} className="flex items-center justify-between text-[10px] font-mono">
                              <span className="text-white/55 capitalize w-14">{a}</span>
                              <span className="text-white/30 w-16">{b.gradedVerdicts} graded</span>
                              <span className="w-20" style={{ color: (b.expectancyR ?? 0) > 0 ? '#34d399' : '#f87171' }}>
                                {b.expectancyR === null ? '—' : `${b.expectancyR > 0 ? '+' : ''}${b.expectancyR}R`}
                              </span>
                              <span className="w-16" style={{ color: (b.profitFactor ?? 0) >= 1 ? '#34d399' : '#f87171' }}>
                                {b.profitFactor === null ? '—' : `${b.profitFactor}×`}
                              </span>
                              <span className="text-white/40 w-16 text-right">
                                {b.medianReturnPct === null ? '—' : `${b.medianReturnPct > 0 ? '+' : ''}${b.medianReturnPct}%`}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                      <p className="text-[9px] font-mono text-white/25 mt-1.5">cols: graded · expectancy · profit factor · median 1W return</p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Improvements list */}
          {version.improvements.length > 0 && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-white/35 mb-2">
                What improved
              </div>
              <ul className="space-y-1.5">
                {version.improvements.map((imp, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-white/70 leading-relaxed">
                    <CheckCircle2 size={11} style={{ color: '#34d399', marginTop: 4, flexShrink: 0 }} />
                    <span>{imp}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Click affordance */}
          <div
            className="mt-4 pt-3 text-[10px] font-mono text-white/30 group-hover:text-white/55 transition-colors flex items-center gap-1"
            style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
          >
            See verdicts from this version →
          </div>
        </button>
      </div>
    </section>
  )
}

function Stat({
  label, value, suffix, accent, icon, detail,
}: {
  label: string
  value: number | null
  suffix: string
  accent: string
  icon?: React.ReactNode
  detail?: string
}) {
  const display = value === null ? '—'
    : suffix === '%' ? `${value.toFixed(1)}${suffix}`
    : `${value}${suffix}`
  return (
    <div>
      <div className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-widest text-white/35 mb-0.5">
        {icon}
        {label}
      </div>
      <div className="text-lg font-bold font-mono" style={{ color: value === null ? 'rgba(255,255,255,0.3)' : accent }}>
        {display}
      </div>
      {detail && (
        <div className="text-[9px] font-mono text-white/30 mt-0.5">{detail}</div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function formatVersionDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
