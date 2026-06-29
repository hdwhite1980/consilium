'use client'

// =============================================================
// app/settings/day-shark/page.tsx
//
// Max's control panel. Per-asset allocation sliders that set how much of each
// broker balance the aggressive 1-day lane may deploy. 0% = Max is off for that
// asset. 100% trips a soft confirm. Persists via /api/user/day-shark-settings.
// =============================================================

import { useState, useEffect, useCallback } from 'react'
import { Waves, AlertTriangle, RefreshCw, Check, Loader2 } from 'lucide-react'

const ACCENT = '#f59e0b'
type Asset = 'stock' | 'crypto' | 'forex'
const ASSETS: Array<{ key: Asset; label: string; note: string }> = [
  { key: 'stock', label: 'Stocks', note: 'Alpaca' },
  { key: 'crypto', label: 'Crypto', note: 'Coinbase — real funds' },
  { key: 'forex', label: 'Forex', note: 'OANDA' },
]

export default function DaySharkSettingsPage() {
  const [alloc, setAlloc] = useState<Record<Asset, number>>({ stock: 0, crypto: 0, forex: 0 })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/user/day-shark-settings')
      if (!res.ok) throw new Error(`load failed (${res.status})`)
      const j = await res.json() as Record<Asset, number>
      setAlloc({ stock: j.stock ?? 0, crypto: j.crypto ?? 0, forex: j.forex ?? 0 })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  function setPct(asset: Asset, pct: number) {
    setSaved(false)
    setAlloc(prev => ({ ...prev, [asset]: Math.max(0, Math.min(1, pct)) }))
  }

  async function save() {
    setSaving(true); setError(null); setSaved(false)
    try {
      const res = await fetch('/api/user/day-shark-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alloc),
      })
      if (!res.ok) throw new Error(`save failed (${res.status})`)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to save')
    } finally { setSaving(false) }
  }

  const anyMaxed = Object.values(alloc).some(v => v >= 1)
  const anyOn = Object.values(alloc).some(v => v > 0)

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#0a0a0b' }}>
      <header className="flex items-center gap-2 px-3 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <Waves size={14} style={{ color: ACCENT }} />
        <span className="text-sm font-bold text-white">Day Shark</span>
        <span className="text-[10px] font-mono text-white/25">max — aggressive 1-day lane</span>
        <button onClick={() => { void load() }} disabled={loading}
          className="ml-auto flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      <main className="flex-1 max-w-2xl mx-auto w-full px-3 py-5 space-y-4">

        {/* What Max is */}
        <div className="rounded-xl border p-4" style={{ background: 'rgba(245,158,11,0.05)', borderColor: 'rgba(245,158,11,0.25)' }}>
          <div className="flex items-start gap-2">
            <Waves size={14} style={{ color: ACCENT }} className="shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-semibold" style={{ color: ACCENT }}>How Max works</div>
              <p className="text-[11px] text-white/55 mt-1 leading-relaxed">
                Max runs a separate, aggressive 1-day lane on top of your normal trading. Each slider is the
                share of that broker&apos;s balance Max may deploy — his own sleeve, walled off from the rest of
                your trading. He sizes by conviction (risking ~2–8% per trade), cuts losers by end of day, and
                lets confirmed winners ride one night.
              </p>
              <p className="text-[11px] text-white/40 mt-2 leading-relaxed">
                <strong>0% = off</strong> for that asset. Lowering a slider freezes Max — open positions stand,
                but he opens nothing new until they close. He never spends past his sleeve.
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border p-3 flex items-start gap-2"
            style={{ background: 'rgba(248,113,113,0.05)', borderColor: 'rgba(248,113,113,0.2)' }}>
            <AlertTriangle size={14} style={{ color: '#f87171' }} className="shrink-0 mt-0.5" />
            <p className="text-[11px] text-white/55">{error}</p>
          </div>
        )}

        {/* Sliders */}
        <div className="space-y-2">
          {ASSETS.map(({ key, label, note }) => {
            const pct = Math.round(alloc[key] * 100)
            const on = alloc[key] > 0
            return (
              <div key={key} className="rounded-xl border p-4"
                style={{ background: on ? 'rgba(245,158,11,0.04)' : 'rgba(255,255,255,0.02)', borderColor: on ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.08)' }}>
                <div className="flex items-baseline justify-between mb-3">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold text-white">{label}</span>
                    <span className="text-[10px] font-mono text-white/30">{note}</span>
                  </div>
                  <span className="text-sm font-mono font-bold" style={{ color: on ? ACCENT : 'rgba(255,255,255,0.3)' }}>
                    {pct === 0 ? 'OFF' : `${pct}%`}
                  </span>
                </div>
                <input
                  type="range" min={0} max={100} step={5} value={pct}
                  onChange={e => setPct(key, Number(e.target.value) / 100)}
                  className="w-full cursor-pointer"
                  style={{ accentColor: ACCENT }}
                />
              </div>
            )
          })}
        </div>

        {/* 100% soft confirm */}
        {anyMaxed && (
          <div className="rounded-xl border p-3 flex items-start gap-2"
            style={{ background: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.4)' }}>
            <AlertTriangle size={14} style={{ color: ACCENT }} className="shrink-0 mt-0.5" />
            <p className="text-[11px] text-white/70 leading-relaxed">
              <strong style={{ color: ACCENT }}>100% allocation.</strong> Max may deploy the entire balance of
              that broker into his aggressive day lane. That is the most concentrated setting there is — make
              sure that&apos;s really what you want before saving.
            </p>
          </div>
        )}

        {/* Save */}
        <div className="flex items-center gap-3 pt-1">
          <button onClick={() => { void save() }} disabled={saving || loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40"
            style={{ background: ACCENT, color: '#0a0a0b' }}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : null}
            {saving ? 'Saving…' : saved ? 'Saved' : 'Save allocations'}
          </button>
          {!anyOn && !loading && (
            <span className="text-[11px] text-white/30">All sliders at 0 — Max is fully off.</span>
          )}
        </div>

      </main>
    </div>
  )
}
