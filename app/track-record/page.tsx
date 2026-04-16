'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, TrendingUp, TrendingDown, Minus, RefreshCw, Trophy, Target, Activity } from 'lucide-react'

interface VerdictRecord {
  id: string
  ticker: string
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number | null
  entry_price: number | null
  stop_loss: number | null
  take_profit: number | null
  time_horizon: string | null
  persona: string | null
  timeframe: string | null
  outcome_1w: 'correct' | 'incorrect' | 'neutral' | 'pending' | null
  outcome_1m: 'correct' | 'incorrect' | 'neutral' | 'pending' | null
  pct_change_1w: number | null
  pct_change_1m: number | null
  price_at_1w: number | null
  price_at_1m: number | null
  verdict_date: string
  check_1w_after: string
  check_1m_after: string
}

interface Stats {
  total: number
  resolved1w: number
  resolved1m: number
  winRate1w: number | null
  winRate1m: number | null
  avgGain1w: number | null
  bySignal: Array<{ signal: string; total: number; correct: number; winRate: number | null }>
}

const SIG_COLOR: Record<string, string> = { BULLISH: '#34d399', BEARISH: '#f87171', NEUTRAL: '#fbbf24' }
const SIG_ICON = { BULLISH: TrendingUp, BEARISH: TrendingDown, NEUTRAL: Minus }

export default function TrackRecordPage() {
  const router = useRouter()
  const [verdicts, setVerdicts] = useState<VerdictRecord[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [filter, setFilter] = useState<'all' | 'BULLISH' | 'BEARISH' | 'NEUTRAL'>('all')

  const load = async (check = false) => {
    if (check) setChecking(true)
    try {
      const r = await fetch(`/api/track-record${check ? '?check=true' : ''}`)
      const d = await r.json()
      setVerdicts(d.verdicts ?? [])
      setStats(d.stats ?? null)
    } catch { /* ignore */ }
    setLoading(false)
    setChecking(false)
  }

  useEffect(() => { load() }, [])

  const filtered = filter === 'all' ? verdicts : verdicts.filter(v => v.signal === filter)
  const pending = verdicts.filter(v => v.outcome_1w === 'pending').length

  const fmt$ = (n: number | null) => n != null ? `$${n.toFixed(2)}` : '—'
  const fmtPct = (n: number | null) => n != null ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : '—'

  const outcomeColor = (o: string | null) =>
    o === 'correct' ? '#34d399' : o === 'incorrect' ? '#f87171' : o === 'neutral' ? '#fbbf24' : 'rgba(255,255,255,0.3)'

  const outcomeLabel = (o: string | null) =>
    o === 'correct' ? '✓' : o === 'incorrect' ? '✗' : o === 'neutral' ? '~' : '…'

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen" style={{ background: '#0a0d12' }}>
      <div className="flex gap-1">
        {[0,1,2].map(i => <span key={i} className="w-2 h-2 rounded-full animate-bounce bg-purple-400" style={{ animationDelay: `${i*0.15}s` }} />)}
      </div>
    </div>
  )

  return (
    <div className="flex flex-col min-h-screen" style={{ background: '#0a0d12', color: 'white' }}>
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b sticky top-0 z-10"
        style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.07)' }}>
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.1)' }} />
        <Trophy size={14} style={{ color: '#a78bfa' }} />
        <span className="text-sm font-bold">Track Record</span>
        <div className="flex-1" />
        {pending > 0 && (
          <span className="text-[10px] text-white/40">{pending} pending outcome{pending > 1 ? 's' : ''}</span>
        )}
        <button onClick={() => load(true)} disabled={checking}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg disabled:opacity-40 hover:opacity-80"
          style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
          <RefreshCw size={11} className={checking ? 'animate-spin' : ''} />
          {checking ? 'Checking...' : 'Check outcomes'}
        </button>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-6 w-full space-y-5">

        {/* Stats row */}
        {stats && stats.total > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Total verdicts', val: stats.total.toString(), icon: Activity, color: '#a78bfa' },
              { label: '1-week accuracy', val: stats.winRate1w != null ? `${stats.winRate1w.toFixed(0)}%` : `${stats.resolved1w} resolved`, icon: Target, color: stats.winRate1w && stats.winRate1w > 55 ? '#34d399' : '#f87171' },
              { label: '1-month accuracy', val: stats.winRate1m != null ? `${stats.winRate1m.toFixed(0)}%` : `${stats.resolved1m} resolved`, icon: Trophy, color: stats.winRate1m && stats.winRate1m > 55 ? '#34d399' : '#f87171' },
              { label: 'Avg 1W gain', val: stats.avgGain1w != null ? fmtPct(stats.avgGain1w) : '—', icon: TrendingUp, color: stats.avgGain1w && stats.avgGain1w > 0 ? '#34d399' : '#f87171' },
            ].map(({ label, val, icon: Icon, color }) => (
              <div key={label} className="rounded-2xl p-4 text-center" style={{ background: '#111620', border: '1px solid rgba(255,255,255,0.07)' }}>
                <Icon size={14} style={{ color, margin: '0 auto 6px' }} />
                <div className="text-xl font-bold font-mono" style={{ color }}>{val}</div>
                <div className="text-[10px] text-white/30 mt-1">{label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Signal breakdown */}
        {stats && stats.resolved1w > 0 && (
          <div className="rounded-2xl overflow-hidden" style={{ background: '#111620', border: '1px solid rgba(255,255,255,0.07)' }}>
            <div className="px-4 py-2.5 border-b text-[10px] font-mono uppercase tracking-widest text-white/30"
              style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
              1-week accuracy by signal
            </div>
            <div className="grid grid-cols-3 divide-x" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
              {stats.bySignal.map(s => (
                <div key={s.signal} className="px-4 py-3 text-center">
                  <div className="text-sm font-bold font-mono" style={{ color: SIG_COLOR[s.signal] }}>
                    {s.winRate != null ? `${s.winRate.toFixed(0)}%` : '—'}
                  </div>
                  <div className="text-[10px] text-white/40 mt-0.5">{s.signal} · {s.total} calls</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Filter tabs */}
        {verdicts.length > 0 && (
          <div className="flex gap-1 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
            {(['all','BULLISH','BEARISH','NEUTRAL'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className="px-3 py-2 text-xs font-semibold border-b-2 transition-all capitalize"
                style={{
                  color: filter === f ? (f === 'all' ? '#a78bfa' : SIG_COLOR[f]) : 'rgba(255,255,255,0.3)',
                  borderColor: filter === f ? (f === 'all' ? '#a78bfa' : SIG_COLOR[f]) : 'transparent'
                }}>
                {f === 'all' ? `All (${verdicts.length})` : `${f.charAt(0) + f.slice(1).toLowerCase()} (${verdicts.filter(v => v.signal === f).length})`}
              </button>
            ))}
          </div>
        )}

        {/* Verdict list */}
        {filtered.length === 0 ? (
          <div className="rounded-2xl p-10 text-center" style={{ background: '#111620', border: '1px solid rgba(255,255,255,0.07)' }}>
            <Trophy size={28} style={{ color: 'rgba(255,255,255,0.15)', margin: '0 auto 12px' }} />
            <p className="text-sm text-white/40">No verdicts logged yet.</p>
            <p className="text-xs text-white/25 mt-1">Run an analysis — verdicts are logged automatically for BULLISH and BEARISH signals.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(v => {
              const SignalIcon = SIG_ICON[v.signal]
              const sigColor = SIG_COLOR[v.signal]
              const today = new Date().toISOString().split('T')[0]
              const w1Due = v.check_1w_after <= today
              const m1Due = v.check_1m_after <= today

              return (
                <div key={v.id} className="rounded-xl overflow-hidden"
                  style={{ background: '#111620', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <div className="flex items-center gap-3 px-4 py-3">
                    {/* Signal icon */}
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                      style={{ background: `${sigColor}12` }}>
                      <SignalIcon size={14} style={{ color: sigColor }} />
                    </div>

                    {/* Core info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-bold text-sm">{v.ticker}</span>
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded font-mono"
                          style={{ background: `${sigColor}15`, color: sigColor }}>
                          {v.signal}
                        </span>
                        {v.confidence && (
                          <span className="text-[10px] text-white/40">{v.confidence}% conf</span>
                        )}
                        <span className="text-[10px] text-white/25">{v.verdict_date}</span>
                        {v.timeframe && <span className="text-[10px] text-white/25">{v.timeframe}</span>}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                        {v.entry_price && <span className="text-[10px] text-white/40">entry {fmt$(v.entry_price)}</span>}
                        {v.stop_loss && <span className="text-[10px]" style={{ color: '#f87171' }}>stop {fmt$(v.stop_loss)}</span>}
                        {v.take_profit && <span className="text-[10px]" style={{ color: '#34d399' }}>target {fmt$(v.take_profit)}</span>}
                      </div>
                    </div>

                    {/* Outcomes */}
                    <div className="flex gap-2 shrink-0">
                      {/* 1W */}
                      <div className="text-center min-w-[52px]">
                        <div className="text-[9px] text-white/25 mb-0.5">1 WEEK</div>
                        {v.outcome_1w === 'pending' ? (
                          <div className="text-[10px] text-white/25">
                            {w1Due ? <span style={{ color: '#fbbf24' }}>due</span> : `${Math.ceil((new Date(v.check_1w_after).getTime() - Date.now()) / 86400000)}d`}
                          </div>
                        ) : (
                          <div>
                            <div className="text-base font-bold" style={{ color: outcomeColor(v.outcome_1w) }}>
                              {outcomeLabel(v.outcome_1w)}
                            </div>
                            {v.pct_change_1w != null && (
                              <div className="text-[10px] font-mono" style={{ color: outcomeColor(v.outcome_1w) }}>
                                {fmtPct(v.pct_change_1w)}
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {/* 1M */}
                      <div className="text-center min-w-[52px]">
                        <div className="text-[9px] text-white/25 mb-0.5">1 MONTH</div>
                        {v.outcome_1m === 'pending' ? (
                          <div className="text-[10px] text-white/25">
                            {m1Due ? <span style={{ color: '#fbbf24' }}>due</span> : `${Math.ceil((new Date(v.check_1m_after).getTime() - Date.now()) / 86400000)}d`}
                          </div>
                        ) : (
                          <div>
                            <div className="text-base font-bold" style={{ color: outcomeColor(v.outcome_1m) }}>
                              {outcomeLabel(v.outcome_1m)}
                            </div>
                            {v.pct_change_1m != null && (
                              <div className="text-[10px] font-mono" style={{ color: outcomeColor(v.outcome_1m) }}>
                                {fmtPct(v.pct_change_1m)}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {verdicts.length > 0 && (
          <p className="text-[10px] text-center text-white/20 pb-4">
            ✓ = moved in predicted direction by &gt;2% · ✗ = moved opposite · ~ = stayed within 3% (neutral) · … = outcome pending
          </p>
        )}
      </div>
    </div>
  )
}
