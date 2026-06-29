'use client'

// =============================================================
// app/auto-trader/day-shark/page.tsx
//
// Max's dashboard. His story, his numbers — day_shark only. Milestone bar,
// P&L, win rate, per-asset breakdown, open positions, and his exit voice.
// =============================================================

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Waves, RefreshCw, ArrowLeft, Settings, TrendingUp, TrendingDown } from 'lucide-react'

const ACCENT = '#f59e0b'

interface DashData {
  aggregates: { totalPnl: number; wins: number; losses: number; winRate: number | null; openCount: number; totalTrades: number }
  perAsset: Record<string, { open: number; closed: number; pnl: number; wins: number; losses: number }>
  milestone: { cryptoStake: number; next: number; pct: number }
  open: Array<{ ticker: string; asset: string | null; side: string; entry: number | null; stop: number | null; target: number | null; qty: number; ageHours: number }>
  closed: Array<{ ticker: string; asset: string | null; outcome: string; pnl: number; exitPrice: number | null; win: boolean; closedAt: string | null; voice: string }>
}

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`

export default function DaySharkDashboard() {
  const router = useRouter()
  const [d, setD] = useState<DashData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/auto-trader/day-shark')
      if (!res.ok) throw new Error(`load failed (${res.status})`)
      setD(await res.json())
    } catch (e) { setError(e instanceof Error ? e.message : 'failed to load') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const pnlColor = (n: number) => (n > 0 ? '#34d399' : n < 0 ? '#f87171' : 'rgba(255,255,255,0.4)')

  return (
    <div className="min-h-screen" style={{ background: '#0a0a0b' }}>
      <header className="flex items-center gap-2 px-3 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        <button onClick={() => router.push('/auto-trader/dashboard')} className="text-white/40 hover:text-white/70"><ArrowLeft size={16} /></button>
        <Waves size={15} style={{ color: ACCENT }} />
        <span className="text-sm font-bold text-white">Day Shark</span>
        <span className="text-[10px] font-mono text-white/25">max&apos;s record</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => router.push('/settings/day-shark')} className="text-white/40 hover:text-white/70"><Settings size={14} /></button>
          <button onClick={() => { void load() }} disabled={loading} className="text-white/40 hover:text-white/70"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto w-full px-3 py-5 space-y-4">
        {error && (
          <div className="rounded-xl border p-3 text-[11px] text-white/55" style={{ background: 'rgba(248,113,113,0.05)', borderColor: 'rgba(248,113,113,0.2)' }}>{error}</div>
        )}
        {!d && loading && <div className="text-white/40 text-sm py-12 text-center">Loading Max&apos;s record…</div>}

        {d && (
          <>
            {/* Milestone story */}
            <div className="rounded-xl border p-4" style={{ background: 'rgba(245,158,11,0.05)', borderColor: 'rgba(245,158,11,0.25)' }}>
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-xs font-mono text-white/40">crypto stake</span>
                <span className="text-xs font-mono text-white/40">next: ${d.milestone.next}</span>
              </div>
              <div className="flex items-baseline gap-2 mb-3">
                <span className="text-2xl font-bold" style={{ color: ACCENT }}>{money(d.milestone.cryptoStake)}</span>
                <span className="text-xs text-white/40">chasing ${d.milestone.next}</span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                <div className="h-full rounded-full transition-all" style={{ width: `${d.milestone.pct}%`, background: ACCENT }} />
              </div>
            </div>

            {/* Top stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="Realized P&L" value={money(d.aggregates.totalPnl)} color={pnlColor(d.aggregates.totalPnl)} />
              <Stat label="Win rate" value={d.aggregates.winRate === null ? '—' : `${d.aggregates.winRate.toFixed(0)}%`} />
              <Stat label="Open" value={String(d.aggregates.openCount)} color={ACCENT} />
              <Stat label="Closed trades" value={String(d.aggregates.totalTrades)} />
            </div>

            {/* Per-asset */}
            <div className="rounded-xl border p-3" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="text-[10px] font-mono text-white/30 mb-2">by asset</div>
              <div className="space-y-1.5">
                {['crypto', 'stock', 'forex'].map(a => {
                  const x = d.perAsset[a]
                  return (
                    <div key={a} className="flex items-center justify-between text-xs">
                      <span className="text-white/60 capitalize">{a}</span>
                      <div className="flex items-center gap-3 font-mono">
                        <span className="text-white/30">{x.open} open</span>
                        <span className="text-white/30">{x.wins}W/{x.losses}L</span>
                        <span style={{ color: pnlColor(x.pnl), minWidth: 64, textAlign: 'right' }}>{money(x.pnl)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Open positions */}
            {d.open.length > 0 && (
              <div>
                <div className="text-[10px] font-mono text-white/30 mb-2 px-1">open positions</div>
                <div className="space-y-1.5">
                  {d.open.map((p, i) => (
                    <div key={i} className="rounded-xl border p-3 flex items-center justify-between" style={{ background: 'rgba(245,158,11,0.04)', borderColor: 'rgba(245,158,11,0.2)' }}>
                      <div className="flex items-center gap-2">
                        {p.side === 'sell' ? <TrendingDown size={13} style={{ color: '#f87171' }} /> : <TrendingUp size={13} style={{ color: '#34d399' }} />}
                        <span className="text-sm font-semibold text-white">{p.ticker}</span>
                        <span className="text-[10px] font-mono text-white/30 capitalize">{p.asset}</span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] font-mono text-white/40">
                        <span>entry {p.entry?.toFixed(p.asset === 'forex' ? 5 : 2) ?? '—'}</span>
                        <span>stop {p.stop?.toFixed(p.asset === 'forex' ? 5 : 2) ?? '—'}</span>
                        <span>{p.ageHours}h</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Closed — Max's voice */}
            {d.closed.length > 0 && (
              <div>
                <div className="text-[10px] font-mono text-white/30 mb-2 px-1">recent exits</div>
                <div className="space-y-1.5">
                  {d.closed.map((c, i) => (
                    <div key={i} className="rounded-xl border p-3" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.07)' }}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-white">{c.ticker}</span>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: c.win ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)', color: c.win ? '#34d399' : '#f87171' }}>{c.win ? 'WIN' : 'LOSS'}</span>
                        </div>
                        <span className="text-sm font-mono font-bold" style={{ color: pnlColor(c.pnl) }}>{money(c.pnl)}</span>
                      </div>
                      <p className="text-[11px] text-white/45 italic">{c.voice}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {d.aggregates.totalTrades === 0 && d.open.length === 0 && (
              <div className="text-center text-white/30 text-sm py-12">Max hasn&apos;t taken a trade yet. Set a slider and let him hunt.</div>
            )}
          </>
        )}
      </main>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl border p-3" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.08)' }}>
      <div className="text-[10px] font-mono text-white/30 mb-1">{label}</div>
      <div className="text-lg font-bold font-mono" style={{ color: color ?? '#fff' }}>{value}</div>
    </div>
  )
}
