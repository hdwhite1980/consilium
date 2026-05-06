'use client'

// =============================================================
// app/components/MoversHitRateWidget.tsx
//
// Compact tracking-accuracy panel rendered in the Active Stories
// sidebar (and reusable elsewhere). Defaults to the current
// system version. Has a version filter so users can toggle
// between current, prior versions, or all-time.
//
// Backend: GET /api/track-record/stats?version=<n>&source=<src>
//   Returns: { hitRate1w, directionAcc1w, totalVerdicts, sampleNote }
// =============================================================

import { useState, useEffect, useCallback, useMemo } from 'react'
import { ChevronDown, TrendingUp, AlertCircle, RefreshCw } from 'lucide-react'
import { SYSTEM_VERSIONS, getCurrentVersion, type SystemVersion } from '@/app/lib/system-versions'

interface Stats {
  hitRate1w: number | null
  directionAcc1w: number | null
  totalVerdicts: number
  gradedVerdicts: number
  sampleNote: string | null   // e.g. "preview — only 14 verdicts so far"
  versionLabel: string
}

interface Props {
  /** Tag for which dashboard surface this is rendered on. Optional, used for analytics. */
  source?: string
}

export function MoversHitRateWidget({ source = 'sidebar' }: Props) {
  const currentVersion = useMemo(() => getCurrentVersion(), [])
  const [selectedVersion, setSelectedVersion] = useState<number | 'all'>(currentVersion.number)
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const param = selectedVersion === 'all' ? 'all' : String(selectedVersion)
      const res = await fetch(`/api/track-record/stats?version=${param}&source=${source}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setStats(await res.json())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [selectedVersion, source])

  useEffect(() => { load() }, [load])

  const selectedLabel =
    selectedVersion === 'all'
      ? 'All time'
      : SYSTEM_VERSIONS.find(v => v.number === selectedVersion)?.label ?? `Version ${selectedVersion}`

  return (
    <div className="space-y-2.5">
      {/* Version filter dropdown */}
      <div className="relative">
        <button
          onClick={() => setDropdownOpen(v => !v)}
          className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[10px] font-mono"
          style={{
            background: 'rgba(255,255,255,0.04)',
            color: 'rgba(255,255,255,0.7)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <span>{selectedLabel}</span>
          <ChevronDown size={11} style={{ transform: dropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
        </button>

        {dropdownOpen && (
          <div
            className="absolute z-20 mt-1 w-full rounded-lg overflow-hidden"
            style={{
              background: 'var(--surface)',
              border: '1px solid rgba(255,255,255,0.12)',
              boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
            }}
          >
            {SYSTEM_VERSIONS.map(v => (
              <DropdownItem
                key={v.number}
                version={v}
                isSelected={selectedVersion === v.number}
                isCurrent={v.number === currentVersion.number}
                onClick={() => { setSelectedVersion(v.number); setDropdownOpen(false) }}
              />
            ))}
            <button
              onClick={() => { setSelectedVersion('all'); setDropdownOpen(false) }}
              className="w-full px-3 py-2 text-left text-[11px] font-mono hover:opacity-80 transition-opacity"
              style={{
                background: selectedVersion === 'all' ? 'rgba(167,139,250,0.10)' : 'transparent',
                color: selectedVersion === 'all' ? '#a78bfa' : 'rgba(255,255,255,0.55)',
                borderTop: '1px solid rgba(255,255,255,0.05)',
              }}
            >
              All time
            </button>
          </div>
        )}
      </div>

      {/* Stats body */}
      {loading && (
        <div className="flex items-center justify-center py-4">
          <RefreshCw size={14} className="animate-spin text-white/30" />
        </div>
      )}

      {error && (
        <div className="flex items-start gap-1.5 px-2.5 py-2 rounded-lg"
          style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.18)' }}>
          <AlertCircle size={11} style={{ color: '#f87171', marginTop: 1 }} />
          <span className="text-[10px] text-white/60">{error}</span>
        </div>
      )}

      {!loading && !error && stats && (
        <>
          {/* Honest sample-size note when low */}
          {stats.sampleNote && (
            <div
              className="px-2.5 py-1.5 rounded-md text-[10px] font-mono"
              style={{
                background: 'rgba(251,191,36,0.06)',
                color: '#fbbf24',
                border: '1px solid rgba(251,191,36,0.15)',
              }}
            >
              {stats.sampleNote}
            </div>
          )}

          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-1.5">
            <StatCard
              label="Hit rate"
              value={stats.hitRate1w}
              suffix="%"
              accent="#34d399"
              detail={`${stats.gradedVerdicts}/${stats.totalVerdicts} graded`}
            />
            <StatCard
              label="Direction"
              value={stats.directionAcc1w}
              suffix="%"
              accent="#60a5fa"
              detail="1W accuracy"
            />
          </div>

          {/* Footer link to full track-record page */}
          <a
            href="/track-record"
            className="block text-center text-[10px] font-mono py-1.5 rounded-md hover:opacity-80 transition-opacity"
            style={{
              color: 'rgba(255,255,255,0.45)',
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            View full track record →
          </a>
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function DropdownItem({
  version, isSelected, isCurrent, onClick,
}: {
  version: SystemVersion
  isSelected: boolean
  isCurrent: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-full px-3 py-2 text-left hover:opacity-80 transition-opacity"
      style={{
        background: isSelected ? 'rgba(167,139,250,0.10)' : 'transparent',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
      }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="text-[11px] font-mono font-semibold"
          style={{ color: isSelected ? '#a78bfa' : 'rgba(255,255,255,0.7)' }}
        >
          {version.label}
        </span>
        {isCurrent && (
          <span
            className="text-[8px] font-mono px-1 py-px rounded uppercase tracking-widest"
            style={{ background: 'rgba(52,211,153,0.12)', color: '#34d399' }}
          >
            current
          </span>
        )}
      </div>
      {version.subtitle && (
        <div className="text-[10px] text-white/35 mt-0.5">{version.subtitle}</div>
      )}
    </button>
  )
}

function StatCard({
  label, value, suffix, accent, detail,
}: {
  label: string
  value: number | null
  suffix: string
  accent: string
  detail: string
}) {
  const display = value === null ? '—' : `${value.toFixed(1)}${suffix}`
  return (
    <div
      className="rounded-lg px-2.5 py-2"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <div className="text-[9px] font-mono uppercase tracking-widest text-white/35 mb-0.5">
        {label}
      </div>
      <div
        className="text-base font-bold font-mono"
        style={{ color: value === null ? 'rgba(255,255,255,0.3)' : accent }}
      >
        {display}
      </div>
      <div className="text-[9px] font-mono text-white/30 mt-0.5">{detail}</div>
    </div>
  )
}
