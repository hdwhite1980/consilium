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
  watching?: Array<{ ticker: string; signal: string | null; decision: string | null; rr: number | null; reason: string | null; at: string; ageHours: number }>
}

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`

export default function DaySharkDashboard() {
  const router = useRouter()
  const [d, setD] = useState<DashData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [alloc, setAlloc] = useState<Record<'stock' | 'crypto' | 'forex', number>>({ stock: 0, crypto: 0, forex: 0 })
  const [savingAlloc, setSavingAlloc] = useState(false)
  const [allocSaved, setAllocSaved] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [dashRes, allocRes] = await Promise.all([
        fetch('/api/auto-trader/day-shark', { cache: 'no-store' }),
        fetch('/api/user/day-shark-settings', { cache: 'no-store' }),
      ])
      if (!dashRes.ok) throw new Error(`load failed (${dashRes.status})`)
      setD(await dashRes.json())
      if (allocRes.ok) {
        const a = await allocRes.json() as Record<'stock' | 'crypto' | 'forex', number>
        setAlloc({ stock: a.stock ?? 0, crypto: a.crypto ?? 0, forex: a.forex ?? 0 })
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'failed to load') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => { void load() }, 30_000)  // keep open positions current
    return () => clearInterval(t)
  }, [load])

  // ── Talk to Max ──
  type MaxAction = { type: 'close_one'; ticker: string } | { type: 'close_all' } | null
  type ChatMsg = { role: 'user' | 'assistant'; content: string; action?: MaxAction; executed?: boolean }
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState('')
  const [maxThinking, setMaxThinking] = useState(false)
  const [executing, setExecuting] = useState(false)

  // Read-only fresh read on a held position. Runs automatically (no money moves).
  const runReeval = useCallback(async (ticker: string) => {
    setMaxThinking(true)
    try {
      const res = await fetch('/api/auto-trader/day-shark/max-reeval', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker }),
      })
      const data = await res.json()
      // The re-eval reply may itself carry a close_one action (broken thesis) → confirm button.
      setChat(c => [...c, { role: 'assistant', content: res.ok ? data.reply : (data.error ?? 'Re-check failed.'), action: res.ok ? data.action : null }])
    } catch {
      setChat(c => [...c, { role: 'assistant', content: 'Re-check failed to run \u2014 try me again.' }])
    } finally { setMaxThinking(false) }
  }, [])

  const askMax = useCallback(async (text: string) => {
    const msg = text.trim()
    if (!msg || maxThinking) return
    const history = chat.slice(-8).map(m => ({ role: m.role, content: m.content }))
    setChat(c => [...c, { role: 'user', content: msg }])
    setChatInput('')
    setMaxThinking(true)
    try {
      const res = await fetch('/api/auto-trader/day-shark/max-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, history }),
      })
      const data = await res.json()
      if (res.ok && data.action?.type === 'reeval' && typeof data.action.ticker === 'string') {
        // "On it" line (no button), then auto-run the real thesis check.
        setChat(c => [...c, { role: 'assistant', content: data.reply }])
        setMaxThinking(false)
        void runReeval(data.action.ticker)
        return
      }
      setChat(c => [...c, { role: 'assistant', content: res.ok ? data.reply : (data.error ?? 'Max went quiet.'), action: res.ok ? data.action : null }])
    } catch {
      setChat(c => [...c, { role: 'assistant', content: 'Lost the connection \u2014 try me again.' }])
    } finally { setMaxThinking(false) }
  }, [chat, maxThinking, runReeval])

  // Explicit-confirm execution. THIS is the only thing that closes real positions.
  const confirmClose = useCallback(async (idx: number, action: MaxAction) => {
    if (!action || executing) return
    setExecuting(true)
    setChat(c => c.map((m, i) => i === idx ? { ...m, executed: true } : m))
    try {
      const res = await fetch('/api/auto-trader/day-shark/max-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action.type, ticker: action.type === 'close_one' ? action.ticker : undefined, confirm: true }),
      })
      const data = await res.json()
      let line: string
      if (!res.ok) {
        line = data.error ?? 'Close failed.'
      } else {
        const closed = (data.closed ?? []) as Array<{ ticker: string; price: number; pnl: number | null }>
        const errs = (data.errors ?? []) as Array<{ ticker: string; error: string }>
        const wins = closed.map(c => `${c.ticker} flat @ ${c.price}${c.pnl != null ? ` (${c.pnl >= 0 ? '+' : ''}$${c.pnl})` : ''}`)
        line = wins.length ? `Done \u2014 ${wins.join('; ')}.` : 'Nothing closed.'
        if (errs.length) line += ` Couldn\u2019t close: ${errs.map(e => `${e.ticker} (${e.error})`).join('; ')}.`
      }
      setChat(c => [...c, { role: 'assistant', content: line }])
    } catch {
      setChat(c => [...c, { role: 'assistant', content: 'Close request failed to send \u2014 check the dashboard before retrying.' }])
    } finally {
      setExecuting(false)
      void load()  // refresh positions after a close
    }
  }, [executing, load])

  async function saveAlloc() {
    setSavingAlloc(true); setAllocSaved(false)
    try {
      const res = await fetch('/api/user/day-shark-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(alloc),
      })
      if (res.ok) setAllocSaved(true)
    } finally { setSavingAlloc(false) }
  }

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

            {/* Allocation sliders */}
            <div className="rounded-xl border p-4" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.08)' }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] font-mono text-white/30">allocation — share of each balance Max may deploy</span>
                <button onClick={() => { void saveAlloc() }} disabled={savingAlloc}
                  className="text-[11px] font-semibold px-3 py-1 rounded-lg disabled:opacity-40"
                  style={{ background: ACCENT, color: '#0a0a0b' }}>
                  {savingAlloc ? 'Saving…' : allocSaved ? 'Saved' : 'Save'}
                </button>
              </div>
              <div className="space-y-3">
                {(['crypto', 'stock', 'forex'] as const).map(a => {
                  const pct = Math.round(alloc[a] * 100)
                  const on = alloc[a] > 0
                  const note = a === 'crypto' ? 'real funds' : a === 'stock' ? 'paper' : 'practice'
                  return (
                    <div key={a}>
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="text-xs text-white/70 capitalize">{a} <span className="text-[10px] font-mono text-white/25">{note}</span></span>
                        <span className="text-xs font-mono font-bold" style={{ color: on ? ACCENT : 'rgba(255,255,255,0.3)' }}>{pct === 0 ? 'OFF' : `${pct}%`}</span>
                      </div>
                      <input type="range" min={0} max={100} step={5} value={pct}
                        onChange={e => { setAllocSaved(false); setAlloc(prev => ({ ...prev, [a]: Number(e.target.value) / 100 })) }}
                        className="w-full cursor-pointer" style={{ accentColor: ACCENT }} />
                    </div>
                  )
                })}
              </div>
              {alloc.crypto >= 1 || alloc.stock >= 1 || alloc.forex >= 1 ? (
                <p className="text-[10px] text-white/40 mt-2">100% lets Max deploy that entire balance — the most concentrated setting.</p>
              ) : null}
            </div>

            {/* ── Talk to Max ── */}
            <div className="rounded-2xl border p-3" style={{ background: 'rgba(245,158,11,0.04)', borderColor: 'rgba(245,158,11,0.2)' }}>
              <div className="flex items-center gap-2 mb-2">
                <Waves size={14} style={{ color: ACCENT }} />
                <span className="text-sm font-bold" style={{ color: ACCENT }}>Talk to Max</span>
                <span className="text-[10px] font-mono text-white/30">he knows his open book</span>
              </div>

              <div className="space-y-2 max-h-72 overflow-y-auto mb-2">
                {chat.length === 0 && (
                  <div className="text-[11px] text-white/40 italic px-1 py-2">
                    Ask Max what he&apos;s holding, why he took a name, or what he&apos;s chasing. Try the chips below.
                  </div>
                )}
                {chat.map((m, i) => (
                  <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex flex-col items-start'}>
                    <div className="max-w-[85%] rounded-xl px-3 py-2 text-[12px] leading-relaxed"
                      style={m.role === 'user'
                        ? { background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.85)' }
                        : { background: 'rgba(245,158,11,0.1)', color: '#fde9c8', border: '1px solid rgba(245,158,11,0.2)' }}>
                      {m.content}
                    </div>
                    {m.role === 'assistant' && m.action && !m.executed && (
                      <div className="flex items-center gap-2 mt-1.5">
                        <button onClick={() => void confirmClose(i, m.action ?? null)} disabled={executing}
                          className="text-[11px] font-bold px-3 py-1.5 rounded-lg disabled:opacity-40"
                          style={{ background: '#f87171', color: '#0a0a0b' }}>
                          {executing ? 'Closing…' : m.action.type === 'close_all' ? 'Confirm: close ALL' : `Confirm: close ${m.action.ticker}`}
                        </button>
                        <button onClick={() => setChat(c => c.map((x, j) => j === i ? { ...x, executed: true } : x))} disabled={executing}
                          className="text-[11px] px-3 py-1.5 rounded-lg border disabled:opacity-40"
                          style={{ borderColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)' }}>
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {maxThinking && (
                  <div className="flex justify-start">
                    <div className="rounded-xl px-3 py-2 text-[12px] italic" style={{ background: 'rgba(245,158,11,0.1)', color: '#fde9c8' }}>
                      Max is reading the tape&hellip;
                    </div>
                  </div>
                )}
              </div>

              {chat.length === 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {["What are you holding?", "What's the plan today?", "How close to the next milestone?", "Why'd you take that one?"].map(q => (
                    <button key={q} onClick={() => void askMax(q)} disabled={maxThinking}
                      className="text-[10px] font-mono px-2 py-1 rounded-full border disabled:opacity-40"
                      style={{ borderColor: 'rgba(245,158,11,0.3)', color: ACCENT }}>{q}</button>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <input
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void askMax(chatInput) }}
                  placeholder="Say something to Max…"
                  className="flex-1 rounded-xl px-3 py-2 text-[12px] outline-none"
                  style={{ background: 'rgba(255,255,255,0.05)', color: 'white', border: '1px solid rgba(255,255,255,0.1)' }}
                />
                <button onClick={() => void askMax(chatInput)} disabled={maxThinking || !chatInput.trim()}
                  className="rounded-xl px-3 py-2 text-[12px] font-bold disabled:opacity-40"
                  style={{ background: ACCENT, color: '#0a0a0b' }}>Send</button>
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

            {/* What Max is watching — proves he's evaluating even when not trading */}
            {d.watching && d.watching.length > 0 && (
              <div>
                <div className="text-[10px] font-mono text-white/30 mb-2 px-1">trader verdicts · max takes any ≥1.2 R:R · last {d.watching.length}</div>
                <div className="space-y-1">
                  {d.watching.map((w, i) => {
                    const took = w.decision === 'TAKE'
                    const wait = w.decision === 'WAIT'
                    const col = took ? '#34d399' : wait ? '#f59e0b' : 'rgba(255,255,255,0.35)'
                    return (
                      <div key={i} className="rounded-lg border p-2.5 flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.06)' }}>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded shrink-0" style={{ background: `${col}1f`, color: col }}>{w.decision ?? '—'}</span>
                          <span className="text-sm font-semibold text-white shrink-0">{w.ticker}</span>
                          {w.reason && <span className="text-[10px] text-white/35 truncate">{w.reason}</span>}
                        </div>
                        <div className="flex items-center gap-2.5 text-[10px] font-mono text-white/30 shrink-0">
                          {w.rr != null && <span>R:R {w.rr}</span>}
                          <span>{w.ageHours < 1 ? `${Math.round(w.ageHours * 60)}m` : `${Math.round(w.ageHours)}h`} ago</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

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
                      {(c.exitPrice != null || c.closedAt) && (
                        <p className="text-[10px] font-mono text-white/30 mt-1">
                          {c.exitPrice != null ? `exit $${c.exitPrice.toLocaleString(undefined, { maximumFractionDigits: c.exitPrice < 10 ? 4 : 2 })}` : ''}
                          {c.exitPrice != null && c.closedAt ? ' · ' : ''}
                          {c.closedAt ? new Date(c.closedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {d.aggregates.totalTrades === 0 && d.open.length === 0 && (
              <div className="text-center text-white/30 text-sm py-12">
                {d.watching && d.watching.length > 0
                  ? 'Max re-decides on the trader\u2019s verdicts above with his own 1.2 R:R bar — he\u2019ll open a day-trade on any that clear it, including ones the trader passed, when budget and sliders allow.'
                  : 'No trader verdicts yet for Max to evaluate.'}
              </div>
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
