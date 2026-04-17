'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'
import { TrendingUp, TrendingDown, Minus, BookOpen, ArrowLeft, Check, X, Clock, Star } from 'lucide-react'

interface JournalEntry {
  id: string
  ticker: string
  signal: string
  entry_price: number | null
  stop_loss: number | null
  take_profit: number | null
  timeframe: string | null
  confidence: number | null
  exit_price: number | null
  outcome: string
  pnl_percent: number | null
  postmortem: {
    what_worked: string
    what_missed: string
    key_lesson: string
    signal_quality: string
    council_grade: string
    improve_next_time: string
    pattern_note?: string
  } | null
  notes: string | null
  tags: string[] | null
  created_at: string
}

interface Stats {
  winRate: number | null
  avgPnl: number | null
  totalTrades: number
}

export default function JournalPage() {
  const router = useRouter()
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [stats, setStats] = useState<Stats>({ winRate: null, avgPnl: null, totalTrades: 0 })
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [resolving, setResolving] = useState<string | null>(null)
  const [resolveData, setResolveData] = useState<{ exit_price: string; outcome: string; notes: string }>({ exit_price: '', outcome: 'win', notes: '' })

  const load = useCallback(async () => {
    const res = await fetch('/api/trade-journal')
    const d = await res.json()
    setEntries(d.entries || [])
    setStats(d.stats || { winRate: null, avgPnl: null, totalTrades: 0 })
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleResolve = async (id: string) => {
    const ep = parseFloat(resolveData.exit_price)
    if (isNaN(ep)) return

    const res = await fetch('/api/trade-journal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resolve', id, exit_price: ep, outcome: resolveData.outcome, notes: resolveData.notes }),
    })
    if (res.ok) {
      setResolving(null)
      await load()
    }
  }

  const signalColor = (s: string) => s === 'BULLISH' ? '#34d399' : s === 'BEARISH' ? '#f87171' : '#fbbf24'
  const outcomeIcon = (o: string) => o === 'win' ? <Check size={12} style={{ color: '#34d399' }} /> : o === 'loss' ? <X size={12} style={{ color: '#f87171' }} /> : <Clock size={12} style={{ color: '#fbbf24' }} />
  const gradeColor = (g: string) => ({ A: '#34d399', B: '#60a5fa', C: '#fbbf24', D: '#f87171' }[g] || '#ffffff')

  return (
    <div className="min-h-screen" style={{ background: '#0a0d12', color: 'white' }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b sticky top-0 z-10"
        style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.07)' }}>
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70">
          <ArrowLeft size={13} /> Back
        </button>
        <BookOpen size={14} style={{ color: '#a78bfa' }} />
        <span className="text-sm font-bold">Trade Journal</span>
        <span className="text-xs text-white/30 ml-1">— AI post-mortems on every trade</span>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        {/* Stats row */}
        {stats.totalTrades > 0 && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Win Rate', value: stats.winRate != null ? `${stats.winRate}%` : '—', color: stats.winRate != null && stats.winRate >= 55 ? '#34d399' : '#f87171' },
              { label: 'Avg P&L', value: stats.avgPnl != null ? `${stats.avgPnl > 0 ? '+' : ''}${stats.avgPnl}%` : '—', color: stats.avgPnl != null && stats.avgPnl > 0 ? '#34d399' : '#f87171' },
              { label: 'Total Trades', value: stats.totalTrades.toString(), color: '#a78bfa' },
            ].map(s => (
              <div key={s.label} className="rounded-xl p-4 text-center"
                style={{ background: '#111620', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="text-2xl font-bold font-mono" style={{ color: s.color }}>{s.value}</div>
                <div className="text-[10px] text-white/40 mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {loading && (
          <div className="text-center py-12 text-white/30 text-sm">Loading journal...</div>
        )}

        {!loading && entries.length === 0 && (
          <div className="text-center py-16 space-y-3">
            <BookOpen size={32} style={{ color: 'rgba(255,255,255,0.15)', margin: '0 auto' }} />
            <p className="text-white/40 text-sm">No trades logged yet.</p>
            <p className="text-white/25 text-xs">When you analyze a stock and want to track the trade, it will appear here with an AI post-mortem once resolved.</p>
          </div>
        )}

        {/* Entries */}
        {entries.map(entry => (
          <div key={entry.id} className="rounded-2xl overflow-hidden"
            style={{ background: '#111620', border: '1px solid rgba(255,255,255,0.08)' }}>

            {/* Entry header */}
            <div className="flex items-center gap-3 px-4 py-3 cursor-pointer"
              onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}>
              <div className="flex items-center gap-1.5">
                {outcomeIcon(entry.outcome)}
                <span className="font-bold font-mono text-sm">{entry.ticker}</span>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full font-mono"
                style={{ background: `${signalColor(entry.signal)}15`, color: signalColor(entry.signal) }}>
                {entry.signal}
              </span>
              {entry.pnl_percent != null && (
                <span className="text-xs font-bold font-mono ml-auto"
                  style={{ color: entry.pnl_percent >= 0 ? '#34d399' : '#f87171' }}>
                  {entry.pnl_percent >= 0 ? '+' : ''}{entry.pnl_percent}%
                </span>
              )}
              {entry.outcome === 'pending' && (
                <span className="text-[10px] text-white/30 ml-auto">Pending</span>
              )}
              {entry.postmortem?.council_grade && (
                <span className="text-xs font-bold w-6 h-6 rounded-full flex items-center justify-center text-[10px]"
                  style={{ background: `${gradeColor(entry.postmortem.council_grade)}20`, color: gradeColor(entry.postmortem.council_grade) }}>
                  {entry.postmortem.council_grade}
                </span>
              )}
              <div className="text-[10px] text-white/25 font-mono">{entry.timeframe}</div>
            </div>

            {/* Expanded detail */}
            {expanded === entry.id && (
              <div className="border-t px-4 py-4 space-y-4" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>

                {/* Price levels */}
                <div className="grid grid-cols-3 gap-2 text-xs">
                  {[
                    { label: 'Entry', value: entry.entry_price, color: '#a78bfa' },
                    { label: 'Stop', value: entry.stop_loss, color: '#f87171' },
                    { label: 'Target', value: entry.take_profit, color: '#34d399' },
                  ].map(p => (
                    <div key={p.label} className="rounded-lg p-2 text-center"
                      style={{ background: `${p.color}08`, border: `1px solid ${p.color}20` }}>
                      <div className="font-bold font-mono text-sm" style={{ color: p.color }}>
                        {p.value ? `$${p.value}` : '—'}
                      </div>
                      <div className="text-[9px] text-white/30 mt-0.5">{p.label}</div>
                    </div>
                  ))}
                </div>

                {/* Post-mortem */}
                {entry.postmortem && (
                  <div className="space-y-3 rounded-xl p-4"
                    style={{ background: 'rgba(167,139,250,0.05)', border: '1px solid rgba(167,139,250,0.15)' }}>
                    <div className="flex items-center gap-2 mb-2">
                      <Star size={12} style={{ color: '#a78bfa' }} />
                      <span className="text-xs font-bold" style={{ color: '#a78bfa' }}>AI Post-Mortem</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full ml-auto"
                        style={{ background: `${gradeColor(entry.postmortem.council_grade)}15`, color: gradeColor(entry.postmortem.council_grade) }}>
                        Council Grade: {entry.postmortem.council_grade}
                      </span>
                    </div>
                    {[
                      { label: '✓ What worked', text: entry.postmortem.what_worked, color: '#34d399' },
                      { label: '✗ What missed', text: entry.postmortem.what_missed, color: '#f87171' },
                      { label: '→ Key lesson', text: entry.postmortem.key_lesson, color: '#fbbf24' },
                      { label: '↻ Next time', text: entry.postmortem.improve_next_time, color: '#60a5fa' },
                    ].map(item => (
                      <div key={item.label}>
                        <div className="text-[10px] font-mono mb-0.5" style={{ color: item.color }}>{item.label}</div>
                        <div className="text-xs text-white/60 leading-relaxed">{item.text}</div>
                      </div>
                    ))}
                    {entry.postmortem.pattern_note && (
                      <div className="text-[10px] text-white/30 italic border-t pt-2" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                        {entry.postmortem.pattern_note}
                      </div>
                    )}
                  </div>
                )}

                {/* Resolve trade */}
                {entry.outcome === 'pending' && (
                  <div>
                    {resolving === entry.id ? (
                      <div className="space-y-3 rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                        <div className="text-xs font-semibold text-white/60">Resolve Trade</div>
                        <div className="grid grid-cols-2 gap-2">
                          <input type="number" placeholder="Exit price" value={resolveData.exit_price}
                            onChange={e => setResolveData(p => ({ ...p, exit_price: e.target.value }))}
                            className="rounded-lg px-3 py-2 text-sm outline-none border"
                            style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                          <select value={resolveData.outcome}
                            onChange={e => setResolveData(p => ({ ...p, outcome: e.target.value }))}
                            className="rounded-lg px-3 py-2 text-sm outline-none border"
                            style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }}>
                            <option value="win">Win</option>
                            <option value="loss">Loss</option>
                            <option value="breakeven">Breakeven</option>
                          </select>
                        </div>
                        <input type="text" placeholder="Notes (optional)"
                          value={resolveData.notes}
                          onChange={e => setResolveData(p => ({ ...p, notes: e.target.value }))}
                          className="w-full rounded-lg px-3 py-2 text-sm outline-none border"
                          style={{ background: '#181e2a', borderColor: 'rgba(255,255,255,0.1)', color: 'white' }} />
                        <div className="flex gap-2">
                          <button onClick={() => handleResolve(entry.id)}
                            className="flex-1 py-2 rounded-lg text-sm font-semibold text-white"
                            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
                            Resolve + Get Post-Mortem
                          </button>
                          <button onClick={() => setResolving(null)}
                            className="px-3 py-2 rounded-lg text-xs text-white/40 hover:text-white/70">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => setResolving(entry.id)}
                        className="w-full py-2 rounded-lg text-xs text-white/50 hover:text-white/80 transition-colors"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                        Resolve trade + generate post-mortem
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
