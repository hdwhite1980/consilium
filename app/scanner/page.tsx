'use client'

// ═════════════════════════════════════════════════════════════
// app/scanner/page.tsx
//
// Stock scanner — pick a universe + mode + optional filters,
// get a ranked leaderboard of the top 15 tickers by composite score.
//
// Composite combines:
//   - Directional setup (60% weight) — multiple indicators agreeing
//   - Relative strength vs SPY (40% weight) — 10d + 30d outperformance
//
// Each row click expands to show all reasons + allows click-through
// to /analyze for full Council treatment or add-to-watchlist.
// ═════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'
import {
  ArrowLeft, Search, Zap, TrendingUp, TrendingDown, Minus,
  Filter, X, LogOut, ChevronDown, BarChart3,
  Activity, Target, Eye, Play, Clock, Globe,
  Star, StarOff, Save, Download, Check,
} from 'lucide-react'
import { AddToWatchlistButton } from '@/app/components/AddToWatchlistButton'

// ─────────────────────────────────────────────────────────────
// Types (must match /api/scanner response)
// ─────────────────────────────────────────────────────────────
interface ScanPick {
  ticker: string
  compositeScore: number
  directionalScore: number
  relStrengthScore: number
  direction: 'bullish' | 'bearish' | 'mixed'
  keySetup: string
  reasons: string[]
  rsi: number
  priceVsSma20: number
  priceVsSma50: number
  macdTrend: 'bullish' | 'bearish' | 'neutral'
  volumeRatio: number
  technicalBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  currentPrice: number
  priceChange1d: number
  priceChange10d: number
  priceChange30d: number
  spyChange10d: number
  spyChange30d: number
  relStrength10d: number
  relStrength30d: number
  sector: string
  cap: string
  priceTier: string
  tags: string[]
}

interface ScanResult {
  universe: string
  mode: 'bullish' | 'bearish' | 'both'
  scannedCount: number
  withTechnicalsCount: number
  picks: ScanPick[]
  spyChange10d: number
  spyChange30d: number
  generatedAt: string
  elapsedMs: number
  cached: boolean
  ageMinutes?: number
  error?: string
}

interface UniverseOption {
  id: string
  label: string
  description: string
}

interface FilterSchema {
  sectors: string[]
  caps: string[]
  priceTiers: string[]
  commonTags: string[]
}

interface ScannerConfig {
  universes: UniverseOption[]
  filterSchema: FilterSchema
}

interface CustomFilter {
  sectors: string[]
  caps: string[]
  priceTiers: string[]
  tagsIncludeAny: string[]
  tagsExcludeAny: string[]
}

interface PresetRow {
  id: number
  name: string
  universe: string
  mode: 'bullish' | 'bearish' | 'both'
  filter: Partial<CustomFilter>
  isFavorite: boolean
  createdAt: string
  lastUsedAt: string | null
}

interface ScannerHitRate {
  total_1d: number | null
  hits_1d: number | null
  total_7d: number | null
  hits_7d: number | null
  total_30d: number | null
  hits_30d: number | null
  hit_rate_1d: number | null
  hit_rate_7d: number | null
  hit_rate_30d: number | null
  avg_return_7d: number | null
  avg_return_30d: number | null
  avg_rel_7d: number | null
  avg_rel_30d: number | null
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${n.toFixed(decimals)}%`
}

function fmt$(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `$${n.toFixed(decimals)}`
}

function scoreColor(score: number): string {
  if (score >= 75) return '#34d399'   // green — strong
  if (score >= 60) return '#a7f3d0'   // light green — good
  if (score >= 45) return '#fbbf24'   // amber — moderate
  if (score >= 30) return '#fb923c'   // orange — weak
  return '#94a3b8'                    // gray — poor
}

function directionColor(d: 'bullish' | 'bearish' | 'mixed'): string {
  if (d === 'bullish') return '#34d399'
  if (d === 'bearish') return '#f87171'
  return '#94a3b8'
}

const SECTOR_LABEL: Record<string, string> = {
  tech: 'Tech',
  healthcare: 'Healthcare',
  financials: 'Financials',
  energy: 'Energy',
  consumer_disc: 'Cons. Disc',
  consumer_staples: 'Staples',
  industrials: 'Industrial',
  materials: 'Materials',
  real_estate: 'REIT',
  utilities: 'Utilities',
  communications: 'Comm',
  crypto_adj: 'Crypto-adj',
  macro_etf: 'Macro ETF',
  sector_etf: 'Sector ETF',
  thematic_etf: 'Thematic',
}

const CAP_LABEL: Record<string, string> = {
  mega: 'Mega',
  large: 'Large',
  mid: 'Mid',
  small: 'Small',
  etf: 'ETF',
}

// ─────────────────────────────────────────────────────────────
// Individual pick row
// ─────────────────────────────────────────────────────────────
function PickRow({
  pick, rank, onAnalyze,
}: {
  pick: ScanPick
  rank: number
  onAnalyze: (ticker: string) => void
}) {
  const [expanded, setExpanded] = useState(false)

  const dirColor = directionColor(pick.direction)
  const compColor = scoreColor(pick.compositeScore)

  return (
    <div className="rounded-xl border transition-all"
      style={{
        background: `${dirColor}06`,
        borderColor: `${dirColor}20`,
      }}>
      <div className="p-3 sm:p-4 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-3">

          {/* Rank */}
          <div className="shrink-0 w-6 text-center">
            <span className="text-[11px] font-mono text-white/40">#{rank}</span>
          </div>

          {/* Ticker + direction */}
          <div className="shrink-0 flex items-center gap-1.5">
            <div className="px-2.5 py-1 rounded-lg font-mono font-bold text-sm"
              style={{ background: `${dirColor}18`, color: dirColor, border: `1px solid ${dirColor}30` }}>
              {pick.ticker}
            </div>
            {pick.direction === 'bullish' && <TrendingUp size={12} style={{ color: '#34d399' }} />}
            {pick.direction === 'bearish' && <TrendingDown size={12} style={{ color: '#f87171' }} />}
            {pick.direction === 'mixed' && <Minus size={12} style={{ color: '#94a3b8' }} />}
          </div>

          {/* Price + setup */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-mono font-semibold text-white/85">
                {fmt$(pick.currentPrice)}
              </span>
              <span className="text-xs font-mono"
                style={{ color: pick.priceChange1d >= 0 ? '#34d399' : '#f87171' }}>
                {fmtPct(pick.priceChange1d, 2)}
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: 'rgba(148,163,184,0.1)', color: '#94a3b8' }}>
                {SECTOR_LABEL[pick.sector] ?? pick.sector} · {CAP_LABEL[pick.cap] ?? pick.cap}
              </span>
            </div>
            <p className="text-xs text-white/55 mt-1 truncate">{pick.keySetup}</p>
          </div>

          {/* Composite score — BIG */}
          <div className="shrink-0 text-right">
            <div className="text-xl font-bold font-mono" style={{ color: compColor }}>
              {pick.compositeScore}
            </div>
            <div className="text-[9px] font-mono text-white/40 uppercase tracking-widest">
              score
            </div>
          </div>

          {/* Sub-scores (hidden on mobile) */}
          <div className="hidden sm:flex shrink-0 flex-col items-end gap-0.5 text-[10px] font-mono"
            style={{ minWidth: '80px' }}>
            <span className="text-white/40">
              dir: <span className="text-white/70">{pick.directionalScore}</span>
            </span>
            <span className="text-white/40">
              rel: <span style={{ color: pick.relStrengthScore >= 50 ? '#34d399' : '#f87171' }}>
                {pick.relStrength30d >= 0 ? '+' : ''}{pick.relStrength30d.toFixed(0)}%
              </span>
            </span>
          </div>

          <span className="text-white/25 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className="px-3 sm:px-4 pb-4 space-y-3 border-t" style={{ borderColor: `${dirColor}15` }}>

          {/* Score breakdown */}
          <div className="pt-3 grid grid-cols-3 gap-2">
            <div className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">Composite</div>
              <div className="text-lg font-bold font-mono mt-0.5" style={{ color: compColor }}>
                {pick.compositeScore}
              </div>
            </div>
            <div className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">Directional</div>
              <div className="text-lg font-bold font-mono mt-0.5" style={{ color: scoreColor(pick.directionalScore) }}>
                {pick.directionalScore}
              </div>
              <div className="text-[9px] font-mono mt-0.5" style={{ color: dirColor }}>
                {pick.direction}
              </div>
            </div>
            <div className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">Rel Strength</div>
              <div className="text-lg font-bold font-mono mt-0.5"
                style={{ color: pick.relStrengthScore >= 60 ? '#34d399' : pick.relStrengthScore >= 40 ? '#fbbf24' : '#f87171' }}>
                {pick.relStrengthScore}
              </div>
              <div className="text-[9px] font-mono mt-0.5 text-white/50">
                {pick.relStrength30d >= 0 ? '+' : ''}{pick.relStrength30d.toFixed(1)}% vs SPY 30d
              </div>
            </div>
          </div>

          {/* Reasons */}
          {pick.reasons.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Activity size={11} style={{ color: dirColor }} />
                <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: dirColor }}>
                  Why this score
                </div>
              </div>
              <ul className="space-y-1">
                {pick.reasons.map((r, i) => (
                  <li key={i} className="text-xs text-white/75 flex items-start gap-2">
                    <span className="mt-1.5 inline-block w-1 h-1 rounded-full shrink-0"
                      style={{ background: dirColor }} />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Quick technicals snapshot */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">RSI</div>
              <div className="text-sm font-mono mt-0.5"
                style={{ color: pick.rsi > 70 ? '#f87171' : pick.rsi < 30 ? '#34d399' : 'white' }}>
                {pick.rsi.toFixed(1)}
              </div>
            </div>
            <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">vs SMA50</div>
              <div className="text-sm font-mono mt-0.5"
                style={{ color: pick.priceVsSma50 >= 0 ? '#34d399' : '#f87171' }}>
                {fmtPct(pick.priceVsSma50)}
              </div>
            </div>
            <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">MACD</div>
              <div className="text-sm font-mono mt-0.5"
                style={{ color: pick.macdTrend === 'bullish' ? '#34d399' : pick.macdTrend === 'bearish' ? '#f87171' : '#94a3b8' }}>
                {pick.macdTrend === 'bullish' ? '▲ pos' : pick.macdTrend === 'bearish' ? '▼ neg' : '— flat'}
              </div>
            </div>
            <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">Volume</div>
              <div className="text-sm font-mono mt-0.5 text-white/80">
                {pick.volumeRatio.toFixed(2)}x
              </div>
            </div>
          </div>

          {/* Price history strip */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">1 day</div>
              <div className="text-sm font-mono mt-0.5"
                style={{ color: pick.priceChange1d >= 0 ? '#34d399' : '#f87171' }}>
                {fmtPct(pick.priceChange1d, 2)}
              </div>
            </div>
            <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">10 day</div>
              <div className="text-sm font-mono mt-0.5"
                style={{ color: pick.priceChange10d >= 0 ? '#34d399' : '#f87171' }}>
                {fmtPct(pick.priceChange10d)}
              </div>
              <div className="text-[9px] font-mono text-white/40 mt-0.5">
                vs SPY {pick.relStrength10d >= 0 ? '+' : ''}{pick.relStrength10d.toFixed(1)}%
              </div>
            </div>
            <div className="rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.03)' }}>
              <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">30 day</div>
              <div className="text-sm font-mono mt-0.5"
                style={{ color: pick.priceChange30d >= 0 ? '#34d399' : '#f87171' }}>
                {fmtPct(pick.priceChange30d)}
              </div>
              <div className="text-[9px] font-mono text-white/40 mt-0.5">
                vs SPY {pick.relStrength30d >= 0 ? '+' : ''}{pick.relStrength30d.toFixed(1)}%
              </div>
            </div>
          </div>

          {/* Tags */}
          {pick.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {pick.tags.slice(0, 6).map(tag => (
                <span key={tag} className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(167,139,250,0.08)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.15)' }}>
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              onClick={(e) => { e.stopPropagation(); onAnalyze(pick.ticker) }}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-90"
              style={{ background: 'rgba(96,165,250,0.15)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)' }}>
              <Play size={11} />
              Run full Council
            </button>
            <AddToWatchlistButton ticker={pick.ticker} source="manual" size="md" variant="filled" />
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Advanced filter panel
// ─────────────────────────────────────────────────────────────
function FilterPanel({
  filter, onChange, schema,
}: {
  filter: CustomFilter
  onChange: (f: CustomFilter) => void
  schema: FilterSchema
}) {
  const toggleItem = (list: string[], item: string): string[] => {
    return list.includes(item) ? list.filter(x => x !== item) : [...list, item]
  }

  const Chip = ({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) => (
    <button onClick={onClick}
      className="px-2 py-1 text-[10px] font-mono rounded transition-all"
      style={{
        background: active ? 'rgba(167,139,250,0.18)' : 'rgba(148,163,184,0.08)',
        color: active ? '#a78bfa' : '#94a3b8',
        border: `1px solid ${active ? 'rgba(167,139,250,0.35)' : 'rgba(148,163,184,0.15)'}`,
      }}>
      {label}
    </button>
  )

  return (
    <div className="space-y-3">
      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">Sectors</div>
        <div className="flex flex-wrap gap-1.5">
          {schema.sectors.map(s => (
            <Chip key={s}
              label={SECTOR_LABEL[s] ?? s}
              active={filter.sectors.includes(s)}
              onClick={() => onChange({ ...filter, sectors: toggleItem(filter.sectors, s) })} />
          ))}
        </div>
      </div>

      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">Cap Tier</div>
        <div className="flex flex-wrap gap-1.5">
          {schema.caps.map(c => (
            <Chip key={c}
              label={CAP_LABEL[c] ?? c}
              active={filter.caps.includes(c)}
              onClick={() => onChange({ ...filter, caps: toggleItem(filter.caps, c) })} />
          ))}
        </div>
      </div>

      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">Price Tier</div>
        <div className="flex flex-wrap gap-1.5">
          {schema.priceTiers.map(p => {
            const label: Record<string, string> = {
              sub10: '< $10', under50: '< $50', under100: '< $100',
              under500: '< $500', over500: '> $500',
            }
            return (
              <Chip key={p}
                label={label[p] ?? p}
                active={filter.priceTiers.includes(p)}
                onClick={() => onChange({ ...filter, priceTiers: toggleItem(filter.priceTiers, p) })} />
            )
          })}
        </div>
      </div>

      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">Include tags (any)</div>
        <div className="flex flex-wrap gap-1.5">
          {schema.commonTags.map(t => (
            <Chip key={t}
              label={t}
              active={filter.tagsIncludeAny.includes(t)}
              onClick={() => onChange({ ...filter, tagsIncludeAny: toggleItem(filter.tagsIncludeAny, t) })} />
          ))}
        </div>
      </div>

      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">Exclude tags</div>
        <div className="flex flex-wrap gap-1.5">
          {schema.commonTags.map(t => (
            <button key={t}
              onClick={() => onChange({ ...filter, tagsExcludeAny: toggleItem(filter.tagsExcludeAny, t) })}
              className="px-2 py-1 text-[10px] font-mono rounded transition-all"
              style={{
                background: filter.tagsExcludeAny.includes(t) ? 'rgba(248,113,113,0.18)' : 'rgba(148,163,184,0.08)',
                color: filter.tagsExcludeAny.includes(t) ? '#f87171' : '#94a3b8',
                border: `1px solid ${filter.tagsExcludeAny.includes(t) ? 'rgba(248,113,113,0.35)' : 'rgba(148,163,184,0.15)'}`,
              }}>
              {filter.tagsExcludeAny.includes(t) ? '✕ ' : ''}{t}
            </button>
          ))}
        </div>
      </div>

      {(filter.sectors.length > 0 || filter.caps.length > 0 || filter.priceTiers.length > 0
        || filter.tagsIncludeAny.length > 0 || filter.tagsExcludeAny.length > 0) && (
        <button
          onClick={() => onChange({ sectors: [], caps: [], priceTiers: [], tagsIncludeAny: [], tagsExcludeAny: [] })}
          className="text-[10px] font-mono text-white/40 hover:text-white/70 transition-all">
          Clear all filters
        </button>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────
export default function ScannerPage() {
  const router = useRouter()
  const supabase = createClient()

  const [authLoaded, setAuthLoaded] = useState(false)
  const [config, setConfig] = useState<ScannerConfig | null>(null)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Scan parameters
  const [universe, setUniverse] = useState<string>('all')
  const [mode, setMode] = useState<'bullish' | 'bearish' | 'both'>('both')
  const [limit, setLimit] = useState<number>(15)
  const [showFilters, setShowFilters] = useState(false)
  const [filter, setFilter] = useState<CustomFilter>({
    sectors: [], caps: [], priceTiers: [], tagsIncludeAny: [], tagsExcludeAny: [],
  })

  // Presets
  const [presets, setPresets] = useState<PresetRow[]>([])
  const [showPresetSave, setShowPresetSave] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [presetSaving, setPresetSaving] = useState(false)

  // Hit rate telemetry
  const [hitRate, setHitRate] = useState<ScannerHitRate | null>(null)

  // Sort state
  const [sortBy, setSortBy] = useState<'composite' | 'directional' | 'rel_strength'>('composite')

  // Auth gate
  useEffect(() => {
    let mounted = true
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!mounted) return
      if (!user) { window.location.replace('/login'); return }
      setAuthLoaded(true)
    })
    return () => { mounted = false }
  }, [supabase])

  // Load scanner config (universes + filter schema)
  useEffect(() => {
    if (!authLoaded) return
    fetch('/api/scanner', { credentials: 'include' })
      .then(r => r.json())
      .then((body: ScannerConfig) => setConfig(body))
      .catch((e) => console.warn('Failed to load scanner config:', e))
  }, [authLoaded])

  // Load presets + hit rate
  const loadPresets = useCallback(async () => {
    try {
      const res = await fetch('/api/scanner/presets', { credentials: 'include' })
      const body = await res.json()
      if (res.ok && Array.isArray(body?.presets)) setPresets(body.presets)
    } catch { /* ignore */ }
  }, [])

  const loadHitRate = useCallback(async () => {
    try {
      const res = await fetch('/api/scanner/outcomes')
      const body = await res.json()
      if (res.ok && body?.overall) setHitRate(body.overall)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (!authLoaded) return
    void loadPresets()
    void loadHitRate()
  }, [authLoaded, loadPresets, loadHitRate])

  // Apply a preset to the scan form
  const applyPreset = useCallback(async (preset: PresetRow) => {
    setUniverse(preset.universe)
    setMode(preset.mode)
    setFilter({
      sectors: preset.filter.sectors ?? [],
      caps: preset.filter.caps ?? [],
      priceTiers: preset.filter.priceTiers ?? [],
      tagsIncludeAny: preset.filter.tagsIncludeAny ?? [],
      tagsExcludeAny: preset.filter.tagsExcludeAny ?? [],
    })
    // Mark as used
    try {
      await fetch('/api/scanner/presets', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: preset.name }),
      })
    } catch { /* ignore */ }
  }, [])

  // Save current config as a preset
  const savePreset = useCallback(async () => {
    const name = presetName.trim()
    if (!name) return
    setPresetSaving(true)
    try {
      await fetch('/api/scanner/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          universe,
          mode,
          filter: {
            sectors: filter.sectors.length > 0 ? filter.sectors : undefined,
            caps: filter.caps.length > 0 ? filter.caps : undefined,
            priceTiers: filter.priceTiers.length > 0 ? filter.priceTiers : undefined,
            tagsIncludeAny: filter.tagsIncludeAny.length > 0 ? filter.tagsIncludeAny : undefined,
            tagsExcludeAny: filter.tagsExcludeAny.length > 0 ? filter.tagsExcludeAny : undefined,
          },
        }),
      })
      setPresetName('')
      setShowPresetSave(false)
      await loadPresets()
    } catch { /* ignore */ } finally {
      setPresetSaving(false)
    }
  }, [presetName, universe, mode, filter, loadPresets])

  // Delete a preset
  const deletePreset = useCallback(async (name: string) => {
    if (!confirm(`Delete preset "${name}"?`)) return
    try {
      await fetch(`/api/scanner/presets?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
      })
      await loadPresets()
    } catch { /* ignore */ }
  }, [loadPresets])

  // Toggle favorite status
  const toggleFavorite = useCallback(async (preset: PresetRow) => {
    try {
      await fetch('/api/scanner/presets', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: preset.name, isFavorite: !preset.isFavorite }),
      })
      await loadPresets()
    } catch { /* ignore */ }
  }, [loadPresets])

  // CSV export
  const exportCsv = useCallback(() => {
    if (!result?.picks || result.picks.length === 0) return
    const headers = [
      'Rank', 'Ticker', 'Direction', 'CompositeScore', 'DirectionalScore', 'RelStrengthScore',
      'Price', 'Change1d', 'Change10d', 'Change30d', 'SPY10d', 'SPY30d', 'RelStrength10d', 'RelStrength30d',
      'RSI', 'VsSMA20', 'VsSMA50', 'MACD', 'VolumeRatio', 'TechBias', 'Sector', 'Cap', 'Tags', 'KeySetup',
    ]
    const rows = result.picks.map((p, i) => [
      i + 1, p.ticker, p.direction, p.compositeScore, p.directionalScore, p.relStrengthScore,
      p.currentPrice.toFixed(2), p.priceChange1d.toFixed(2), p.priceChange10d.toFixed(2), p.priceChange30d.toFixed(2),
      p.spyChange10d.toFixed(2), p.spyChange30d.toFixed(2), p.relStrength10d.toFixed(2), p.relStrength30d.toFixed(2),
      p.rsi.toFixed(1), p.priceVsSma20.toFixed(2), p.priceVsSma50.toFixed(2), p.macdTrend, p.volumeRatio.toFixed(2),
      p.technicalBias, p.sector, p.cap, p.tags.join('|'),
      // Quote keySetup to protect commas
      `"${p.keySetup.replace(/"/g, '""')}"`,
    ])
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `scanner_${result.universe}_${result.mode}_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [result])

  const runScan = useCallback(async () => {
    setErr(null)
    setScanning(true)
    try {
      const body = {
        universe,
        mode,
        limit,
        filter: {
          sectors: filter.sectors.length > 0 ? filter.sectors : undefined,
          caps: filter.caps.length > 0 ? filter.caps : undefined,
          priceTiers: filter.priceTiers.length > 0 ? filter.priceTiers : undefined,
          tagsIncludeAny: filter.tagsIncludeAny.length > 0 ? filter.tagsIncludeAny : undefined,
          tagsExcludeAny: filter.tagsExcludeAny.length > 0 ? filter.tagsExcludeAny : undefined,
        },
      }

      const res = await fetch('/api/scanner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const resBody: ScanResult = await res.json()
      if (!res.ok) {
        throw new Error(resBody?.error ?? 'Scan failed')
      }
      setResult(resBody)
    } catch (e) {
      setErr((e as Error).message?.slice(0, 200) ?? 'Network error')
    } finally {
      setScanning(false)
    }
  }, [universe, mode, limit, filter])

  const handleAnalyze = useCallback((ticker: string) => {
    router.push(`/?ticker=${encodeURIComponent(ticker)}`)
  }, [router])

  const handleSignOut = async () => {
    try { await fetch('/api/auth/session', { method: 'DELETE' }) } catch { /* ignore */ }
    await supabase.auth.signOut()
    window.location.replace('/login')
  }

  // Sort picks by selected column
  const sortedPicks = useMemo(() => {
    if (!result?.picks) return []
    const sorted = [...result.picks]
    if (sortBy === 'directional') {
      sorted.sort((a, b) => b.directionalScore - a.directionalScore)
    } else if (sortBy === 'rel_strength') {
      sorted.sort((a, b) => b.relStrengthScore - a.relStrengthScore)
    } else {
      sorted.sort((a, b) => b.compositeScore - a.compositeScore)
    }
    return sorted
  }, [result, sortBy])

  const filterActive = filter.sectors.length > 0 || filter.caps.length > 0
    || filter.priceTiers.length > 0 || filter.tagsIncludeAny.length > 0 || filter.tagsExcludeAny.length > 0

  const filterChipCount = filter.sectors.length + filter.caps.length + filter.priceTiers.length
    + filter.tagsIncludeAny.length + filter.tagsExcludeAny.length

  if (!authLoaded) {
    return (
      <main className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
        <div className="flex gap-1.5">
          {[0, 1, 2].map(i => (
            <span key={i} className="w-2 h-2 rounded-full thinking-dot"
              style={{ background: '#a78bfa', animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
      </main>
    )
  }

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
            <Search size={14} style={{ color: '#a78bfa' }} />
            <h1 className="text-sm font-bold">Scanner</h1>
            {result && (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                style={{
                  background: result.cached ? 'rgba(251,191,36,0.12)' : 'rgba(52,211,153,0.12)',
                  color: result.cached ? '#fbbf24' : '#34d399',
                  border: `1px solid ${result.cached ? 'rgba(251,191,36,0.25)' : 'rgba(52,211,153,0.25)'}`,
                }}>
                {result.cached ? `Cached ${result.ageMinutes}m` : 'Fresh'}
              </span>
            )}
          </div>
        </div>
        <button onClick={handleSignOut}
          className="p-1.5 rounded-lg transition-all hover:opacity-80"
          style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
          <LogOut size={12} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-3 sm:px-5 py-4 space-y-4">

          {/* Hit rate widget */}
          {hitRate && hitRate.total_7d !== null && hitRate.total_7d > 0 && (
            <section className="rounded-xl border p-3"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2 mb-2">
                <BarChart3 size={11} style={{ color: '#a78bfa' }} />
                <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: '#a78bfa' }}>
                  Scanner accuracy (all picks)
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">1-day</div>
                  <div className="text-base font-bold font-mono"
                    style={{ color: (hitRate.hit_rate_1d ?? 0) >= 55 ? '#34d399' : (hitRate.hit_rate_1d ?? 0) >= 45 ? '#fbbf24' : '#f87171' }}>
                    {hitRate.hit_rate_1d !== null ? `${hitRate.hit_rate_1d}%` : '—'}
                  </div>
                  <div className="text-[9px] font-mono text-white/35">
                    {hitRate.hits_1d ?? 0}/{hitRate.total_1d ?? 0}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">7-day</div>
                  <div className="text-base font-bold font-mono"
                    style={{ color: (hitRate.hit_rate_7d ?? 0) >= 55 ? '#34d399' : (hitRate.hit_rate_7d ?? 0) >= 45 ? '#fbbf24' : '#f87171' }}>
                    {hitRate.hit_rate_7d !== null ? `${hitRate.hit_rate_7d}%` : '—'}
                  </div>
                  <div className="text-[9px] font-mono text-white/35">
                    {hitRate.hits_7d ?? 0}/{hitRate.total_7d ?? 0}
                    {hitRate.avg_rel_7d !== null && (
                      <span className="ml-1.5" style={{ color: hitRate.avg_rel_7d >= 0 ? '#34d399' : '#f87171' }}>
                        · vs SPY {hitRate.avg_rel_7d >= 0 ? '+' : ''}{hitRate.avg_rel_7d}%
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] font-mono uppercase tracking-widest text-white/30">30-day</div>
                  <div className="text-base font-bold font-mono"
                    style={{ color: (hitRate.hit_rate_30d ?? 0) >= 55 ? '#34d399' : (hitRate.hit_rate_30d ?? 0) >= 45 ? '#fbbf24' : '#f87171' }}>
                    {hitRate.hit_rate_30d !== null ? `${hitRate.hit_rate_30d}%` : '—'}
                  </div>
                  <div className="text-[9px] font-mono text-white/35">
                    {hitRate.hits_30d ?? 0}/{hitRate.total_30d ?? 0}
                    {hitRate.avg_rel_30d !== null && (
                      <span className="ml-1.5" style={{ color: hitRate.avg_rel_30d >= 0 ? '#34d399' : '#f87171' }}>
                        · vs SPY {hitRate.avg_rel_30d >= 0 ? '+' : ''}{hitRate.avg_rel_30d}%
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Preset bar */}
          {presets.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-mono uppercase tracking-widest text-white/40">Presets:</span>
              {presets.slice(0, 8).map(p => (
                <div key={p.id} className="flex items-center gap-1 rounded-lg"
                  style={{
                    background: p.isFavorite ? 'rgba(251,191,36,0.08)' : 'rgba(167,139,250,0.06)',
                    border: `1px solid ${p.isFavorite ? 'rgba(251,191,36,0.2)' : 'rgba(167,139,250,0.18)'}`,
                  }}>
                  <button onClick={() => applyPreset(p)}
                    className="px-2 py-1 text-[10px] font-mono hover:opacity-80 transition-all"
                    style={{ color: p.isFavorite ? '#fbbf24' : '#a78bfa' }}>
                    {p.isFavorite && <Star size={9} className="inline mr-0.5" fill="currentColor" />}
                    {p.name}
                  </button>
                  <button onClick={() => toggleFavorite(p)}
                    className="px-1 py-1 hover:opacity-80 transition-all"
                    title={p.isFavorite ? 'Unfavorite' : 'Favorite'}
                    style={{ color: 'var(--text3)' }}>
                    {p.isFavorite ? <StarOff size={9} /> : <Star size={9} />}
                  </button>
                  <button onClick={() => deletePreset(p.name)}
                    className="px-1 py-1 hover:opacity-80 transition-all"
                    title="Delete"
                    style={{ color: '#f87171' }}>
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Control panel */}
          <section className="rounded-2xl border p-4 sm:p-5 space-y-4"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>

            <div className="flex items-center gap-2 mb-1">
              <Zap size={14} style={{ color: '#a78bfa' }} />
              <span className="text-sm font-bold">Scan configuration</span>
            </div>

            <p className="text-xs text-white/50 leading-relaxed">
              Scans ~229 liquid tickers for high-confidence directional setups + relative strength vs SPY.
              Composite score (0-100) combines both. Runs in 10-20 seconds. Cached 5 minutes.
            </p>

            {/* Universe + Mode + Limit grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Universe picker */}
              <div>
                <label className="text-[10px] font-mono uppercase tracking-widest text-white/40 block mb-1">
                  Universe
                </label>
                <div className="relative">
                  <select
                    value={universe}
                    onChange={(e) => setUniverse(e.target.value)}
                    disabled={scanning}
                    className="w-full appearance-none pl-3 pr-8 py-2 rounded-lg text-sm font-mono"
                    style={{ background: 'var(--surface2)', color: 'var(--text1)', border: '1px solid rgba(255,255,255,0.1)' }}>
                    {config?.universes.map(u => (
                      <option key={u.id} value={u.id}>{u.label}</option>
                    )) ?? <option>Loading…</option>}
                  </select>
                  <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text3)' }} />
                </div>
              </div>

              {/* Mode */}
              <div>
                <label className="text-[10px] font-mono uppercase tracking-widest text-white/40 block mb-1">
                  Direction
                </label>
                <div className="flex gap-1">
                  {(['both', 'bullish', 'bearish'] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      disabled={scanning}
                      className="flex-1 px-2 py-2 rounded-lg text-xs font-mono transition-all"
                      style={{
                        background: mode === m
                          ? m === 'bullish' ? 'rgba(52,211,153,0.15)'
                            : m === 'bearish' ? 'rgba(248,113,113,0.15)'
                            : 'rgba(167,139,250,0.15)'
                          : 'var(--surface2)',
                        color: mode === m
                          ? m === 'bullish' ? '#34d399'
                            : m === 'bearish' ? '#f87171'
                            : '#a78bfa'
                          : 'var(--text3)',
                        border: `1px solid ${mode === m
                          ? m === 'bullish' ? 'rgba(52,211,153,0.3)'
                            : m === 'bearish' ? 'rgba(248,113,113,0.3)'
                            : 'rgba(167,139,250,0.3)'
                          : 'rgba(255,255,255,0.1)'}`,
                      }}>
                      {m === 'both' ? 'Both' : m === 'bullish' ? 'Long' : 'Short'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Limit */}
              <div>
                <label className="text-[10px] font-mono uppercase tracking-widest text-white/40 block mb-1">
                  Top N
                </label>
                <div className="flex gap-1">
                  {[10, 15, 25, 50].map(n => (
                    <button
                      key={n}
                      onClick={() => setLimit(n)}
                      disabled={scanning}
                      className="flex-1 py-2 rounded-lg text-xs font-mono transition-all"
                      style={{
                        background: limit === n ? 'rgba(167,139,250,0.15)' : 'var(--surface2)',
                        color: limit === n ? '#a78bfa' : 'var(--text3)',
                        border: `1px solid ${limit === n ? 'rgba(167,139,250,0.3)' : 'rgba(255,255,255,0.1)'}`,
                      }}>
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Filter toggle */}
            <div>
              <button
                onClick={() => setShowFilters(!showFilters)}
                className="flex items-center gap-2 text-xs font-mono transition-all hover:opacity-80"
                style={{ color: filterActive ? '#a78bfa' : 'var(--text3)' }}>
                <Filter size={11} />
                <span>Advanced filters</span>
                {filterChipCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded text-[9px]"
                    style={{ background: 'rgba(167,139,250,0.2)', color: '#a78bfa' }}>
                    {filterChipCount}
                  </span>
                )}
                <ChevronDown size={11} className={`transition-transform ${showFilters ? 'rotate-180' : ''}`} />
              </button>

              {showFilters && config && (
                <div className="mt-3 p-3 rounded-lg"
                  style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <FilterPanel filter={filter} onChange={setFilter} schema={config.filterSchema} />
                </div>
              )}
            </div>

            {/* Run scan button + Save preset */}
            <div className="flex gap-2">
              <button
                onClick={runScan}
                disabled={scanning || !config}
                className="flex-1 py-3 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
                style={{
                  background: scanning ? 'var(--surface2)' : 'rgba(167,139,250,0.18)',
                  color: scanning ? 'var(--text3)' : '#a78bfa',
                  border: '1px solid rgba(167,139,250,0.3)',
                }}>
                {scanning ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="inline-flex gap-1">
                      {[0, 1, 2].map(i => (
                        <span key={i} className="w-1.5 h-1.5 rounded-full thinking-dot"
                          style={{ background: '#a78bfa', animationDelay: `${i * 0.15}s` }} />
                      ))}
                    </span>
                    Scanning universe…
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <Search size={14} />
                    Run scan
                  </span>
                )}
              </button>
              <button onClick={() => setShowPresetSave(!showPresetSave)}
                disabled={scanning}
                title="Save current filter combo as a preset"
                className="px-3 py-3 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
                style={{
                  background: showPresetSave ? 'rgba(251,191,36,0.15)' : 'var(--surface2)',
                  color: showPresetSave ? '#fbbf24' : 'var(--text3)',
                  border: `1px solid ${showPresetSave ? 'rgba(251,191,36,0.3)' : 'rgba(255,255,255,0.1)'}`,
                }}>
                <Save size={14} />
              </button>
            </div>

            {/* Save preset inline form */}
            {showPresetSave && (
              <div className="flex gap-2 items-center">
                <input
                  type="text"
                  autoFocus
                  maxLength={60}
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') savePreset() }}
                  placeholder="Preset name (e.g. 'My AI watchlist')"
                  className="flex-1 px-3 py-2 rounded-lg text-sm font-mono"
                  style={{ background: 'var(--surface2)', color: 'var(--text1)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
                <button onClick={savePreset}
                  disabled={presetSaving || !presetName.trim()}
                  className="px-3 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50"
                  style={{ background: 'rgba(52,211,153,0.15)', color: '#34d399', border: '1px solid rgba(52,211,153,0.3)' }}>
                  {presetSaving ? '...' : <Check size={12} />}
                </button>
                <button onClick={() => { setShowPresetSave(false); setPresetName('') }}
                  className="p-2 rounded-lg transition-all hover:opacity-80"
                  style={{ background: 'var(--surface2)', color: 'var(--text3)' }}>
                  <X size={12} />
                </button>
              </div>
            )}

            {err && (
              <div className="text-xs p-2.5 rounded-lg flex items-start gap-2"
                style={{ background: 'rgba(248,113,113,0.08)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
                <X size={12} className="mt-0.5 shrink-0" />
                <span>{err}</span>
              </div>
            )}
          </section>

          {/* Result summary */}
          {result && (
            <section className="rounded-2xl border p-3 sm:p-4"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono text-white/50">
                <Globe size={11} style={{ color: '#a78bfa' }} />
                <span>Universe: <span className="text-white/80">{result.universe}</span></span>
                <span className="text-white/25">·</span>
                <span>Scanned <span className="text-white/80">{result.scannedCount}</span></span>
                <span className="text-white/25">·</span>
                <span>Returned <span className="text-white/80">{result.picks.length}</span></span>
                <span className="text-white/25">·</span>
                <span>{(result.elapsedMs / 1000).toFixed(1)}s</span>
                <span className="text-white/25">·</span>
                <span>SPY 10d <span style={{ color: result.spyChange10d >= 0 ? '#34d399' : '#f87171' }}>
                  {fmtPct(result.spyChange10d)}
                </span></span>
                <span className="text-white/25">·</span>
                <span>SPY 30d <span style={{ color: result.spyChange30d >= 0 ? '#34d399' : '#f87171' }}>
                  {fmtPct(result.spyChange30d)}
                </span></span>
              </div>
            </section>
          )}

          {/* Sort controls + Export (shown when results present) */}
          {result && result.picks.length > 0 && (
            <div className="flex items-center gap-2 text-xs flex-wrap">
              <span className="text-white/40 font-mono">Sort:</span>
              {[
                { key: 'composite' as const, label: 'Composite' },
                { key: 'directional' as const, label: 'Directional' },
                { key: 'rel_strength' as const, label: 'Rel Strength' },
              ].map(s => (
                <button key={s.key}
                  onClick={() => setSortBy(s.key)}
                  className="px-2 py-1 rounded font-mono text-[10px] transition-all"
                  style={{
                    background: sortBy === s.key ? 'rgba(167,139,250,0.15)' : 'transparent',
                    color: sortBy === s.key ? '#a78bfa' : 'var(--text3)',
                    border: `1px solid ${sortBy === s.key ? 'rgba(167,139,250,0.3)' : 'rgba(255,255,255,0.1)'}`,
                  }}>
                  {s.label}
                </button>
              ))}
              <button onClick={exportCsv}
                className="ml-auto flex items-center gap-1 px-2 py-1 rounded font-mono text-[10px] transition-all hover:opacity-80"
                style={{ background: 'rgba(96,165,250,0.1)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.2)' }}
                title="Download picks as CSV">
                <Download size={10} />
                Export CSV
              </button>
            </div>
          )}

          {/* Results leaderboard */}
          {result && sortedPicks.length > 0 && (
            <section className="space-y-2">
              {sortedPicks.map((pick, i) => (
                <PickRow key={pick.ticker} pick={pick} rank={i + 1} onAnalyze={handleAnalyze} />
              ))}
            </section>
          )}

          {/* Empty state — no results */}
          {result && sortedPicks.length === 0 && (
            <div className="rounded-2xl border p-8 text-center"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <Target size={20} className="mx-auto mb-2 opacity-50" style={{ color: '#94a3b8' }} />
              <p className="text-sm text-white/70 font-semibold mb-1">No tickers match</p>
              <p className="text-xs text-white/50 max-w-md mx-auto">
                Try broadening the universe, switching mode to Both, or removing some filter constraints.
              </p>
            </div>
          )}

          {/* Pre-scan explainer */}
          {!result && !scanning && config && (
            <section className="rounded-2xl border p-5 sm:p-6"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2 mb-3">
                <BarChart3 size={14} style={{ color: '#60a5fa' }} />
                <h3 className="text-sm font-semibold">How the scanner works</h3>
              </div>
              <div className="space-y-3 text-xs text-white/65 leading-relaxed">
                <div className="flex gap-2">
                  <span className="shrink-0 font-mono font-bold" style={{ color: '#60a5fa' }}>1.</span>
                  <span>
                    <span className="font-semibold text-white/80">Universe:</span> pick a predefined universe (All Liquid, Tech, AI theme, etc.) or add custom filters.
                    Default is ~229 liquid tickers across sectors.
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="shrink-0 font-mono font-bold" style={{ color: '#60a5fa' }}>2.</span>
                  <span>
                    <span className="font-semibold text-white/80">Fetch:</span> pulls daily bars for each ticker in parallel (25 at a time).
                    Fetches SPY for relative-strength baseline.
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="shrink-0 font-mono font-bold" style={{ color: '#60a5fa' }}>3.</span>
                  <span>
                    <span className="font-semibold text-white/80">Score:</span> each ticker gets a directional score (trend + momentum + volume + patterns)
                    and a relative-strength score (outperformance vs SPY over 10d/30d).
                    Composite = 60% directional + 40% rel-strength.
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="shrink-0 font-mono font-bold" style={{ color: '#60a5fa' }}>4.</span>
                  <span>
                    <span className="font-semibold text-white/80">Rank:</span> returns the top N by composite score.
                    Each pick shows the specific reasons (MACD cross, golden cross, oversold bounce, etc.).
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="shrink-0 font-mono font-bold" style={{ color: '#60a5fa' }}>5.</span>
                  <span>
                    <span className="font-semibold text-white/80">Drill in:</span> click any pick to see full breakdown.
                    Click "Run full Council" for the expensive but thorough /analyze treatment,
                    or "Add to watchlist" for 15-min exit monitoring.
                  </span>
                </div>
              </div>

              <div className="mt-5 pt-4 border-t text-xs text-white/45 leading-relaxed space-y-1"
                style={{ borderColor: 'var(--border)' }}>
                <p className="flex items-center gap-1.5">
                  <Clock size={11} />
                  <span>
                    First scan takes 10-20 seconds. Repeated scans with same settings are instant (5-min cache).
                  </span>
                </p>
                <p className="flex items-center gap-1.5">
                  <Eye size={11} />
                  <span>
                    No AI calls in the scoring — rule-based, fast, auditable. AI kicks in only when you click through to Council.
                  </span>
                </p>
              </div>
            </section>
          )}

          {/* Footer */}
          <div className="text-center py-4">
            <p className="text-[10px] text-white/30 leading-relaxed max-w-md mx-auto">
              Scanner scores are directional heuristics, not recommendations.
              Rule-based indicators have known failure modes in choppy markets.
              Click through to Council for deeper analysis before acting.
            </p>
          </div>
        </div>
      </div>
    </main>
  )
}
