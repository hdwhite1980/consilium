'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Search, TrendingUp, Zap } from 'lucide-react'

interface Suggestion {
  ticker: string
  price: number
  change1D: number
  shares?: number
  option_type?: string
  suggested_strike?: string
  suggested_expiry?: string
  est_premium_per_share?: number
  est_total_cost?: number
  reason: string
  risk: 'low' | 'medium' | 'high'
  catalyst: string
  rsi?: number | null
  volumeRatio?: number | null
  signal_strength?: 'strong' | 'moderate' | 'weak'
}

interface ScreenerResult {
  sector: string
  sectorEtf: string
  sectorChange?: number
  budget: number
  type: string
  suggestions: Suggestion[]
  summary: string
  message?: string
}

const SECTORS = [
  { etf: '',     name: '🔥 Hottest sector (auto)' },
  { etf: 'XLK',  name: '💻 Technology' },
  { etf: 'XLV',  name: '🏥 Healthcare' },
  { etf: 'XLF',  name: '🏦 Financials' },
  { etf: 'XLE',  name: '⚡ Energy' },
  { etf: 'XLY',  name: '🛍 Consumer Disc.' },
  { etf: 'XLP',  name: '🛒 Consumer Staples' },
  { etf: 'XLI',  name: '🏭 Industrials' },
  { etf: 'XLB',  name: '⛏ Materials' },
  { etf: 'XLRE', name: '🏠 Real Estate' },
  { etf: 'XLU',  name: '💡 Utilities' },
  { etf: 'XLC',  name: '📡 Comm. Services' },
]

const RISK_COLOR = { low: '#34d399', medium: '#fbbf24', high: '#f87171' }
const CATALYST_COLOR: Record<string, string> = {
  earnings: '#a78bfa', momentum: '#60a5fa', breakout: '#34d399',
  news: '#fbbf24', reversal: '#f87171', default: '#94a3b8',
}

export default function ScreenerPage() {
  const router = useRouter()
  const [budget, setBudget] = useState('')
  const [type, setType] = useState<'stock' | 'option'>('stock')
  const [sector, setSector] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ScreenerResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    const b = parseFloat(budget)
    if (isNaN(b) || b <= 0) { setError('Enter a valid budget amount'); return }
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const res = await fetch('/api/budget-screener', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budget: b, type, sector: sector || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      setResult(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b sticky top-0 z-10"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70">
          <ArrowLeft size={13} /> Back
        </button>
        <Search size={14} style={{ color: '#a78bfa' }} />
        <span className="text-sm font-bold">Budget Screener</span>
        <span className="text-xs text-white/30 ml-1">— find picks within your budget</span>
      </div>

      <div className="max-w-xl mx-auto px-4 py-6 space-y-5">

        {/* Input form */}
        <div className="rounded-2xl p-5 space-y-4"
          style={{ background: 'var(--surface)', border: '1px solid rgba(255,255,255,0.08)' }}>

          {/* Budget input */}
          <div>
            <label className="block text-xs font-mono text-white/40 uppercase tracking-wider mb-2">
              {type === 'stock' ? 'Max price per share ($)' : 'Max budget per contract ($)'}
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 font-mono">$</span>
              <input
                type="number" value={budget}
                onChange={e => setBudget(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && run()}
                placeholder={type === 'stock' ? '200' : '500'}
                className="w-full rounded-xl pl-7 pr-4 py-3 text-lg font-bold font-mono outline-none border transition-all"
                style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }}
                onFocus={e => e.target.style.borderColor = '#7c3aed'}
                onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
              />
            </div>
          </div>

          {/* Stock vs Option toggle */}
          <div>
            <label className="block text-xs font-mono text-white/40 uppercase tracking-wider mb-2">Looking for</label>
            <div className="grid grid-cols-2 gap-2">
              {(['stock', 'option'] as const).map(t => (
                <button key={t} onClick={() => setType(t)}
                  className="py-2.5 rounded-xl text-sm font-semibold transition-all"
                  style={{
                    background: type === t ? 'rgba(124,58,237,0.2)' : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${type === t ? 'rgba(124,58,237,0.5)' : 'rgba(255,255,255,0.08)'}`,
                    color: type === t ? '#a78bfa' : 'rgba(255,255,255,0.4)',
                  }}>
                  {t === 'stock' ? '📈 Stocks' : '⚡ Options'}
                </button>
              ))}
            </div>
            {type === 'option' && (
              <p className="text-[10px] text-white/30 mt-1.5 leading-relaxed">
                Budget = total cost per contract (premium × 100 shares)
              </p>
            )}
          </div>

          {/* Sector selector */}
          <div>
            <label className="block text-xs font-mono text-white/40 uppercase tracking-wider mb-2">Sector</label>
            <select value={sector} onChange={e => setSector(e.target.value)}
              className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
              style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text)' }}>
              {SECTORS.map(s => (
                <option key={s.etf} value={s.etf}>{s.name}</option>
              ))}
            </select>
          </div>

          {error && (
            <div className="rounded-xl px-3 py-2 text-xs"
              style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171' }}>
              {error}
            </div>
          )}

          <button onClick={run} disabled={loading || !budget}
            className="w-full py-3 rounded-xl font-bold text-white transition-all hover:opacity-90 disabled:opacity-40 flex items-center justify-center gap-2"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
            {loading ? (
              <>
                <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                Finding picks...
              </>
            ) : (
              <>
                <Search size={15} />
                Find picks under ${budget || '...'}
              </>
            )}
          </button>
        </div>

        {/* Results */}
        {result && (
          <div className="space-y-3">
            {/* Sector header */}
            <div className="rounded-2xl px-4 py-3 flex items-center gap-3"
              style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)' }}>
              <TrendingUp size={16} style={{ color: '#a78bfa' }} />
              <div>
                <div className="text-xs font-bold" style={{ color: '#a78bfa' }}>
                  {result.sector} {result.sectorChange != null && (
                    <span style={{ color: result.sectorChange >= 0 ? '#34d399' : '#f87171' }}>
                      ({result.sectorChange >= 0 ? '+' : ''}{result.sectorChange.toFixed(1)}%)
                    </span>
                  )} — {result.type === 'stock' ? 'Stock' : 'Options'} picks under ${result.budget}{result.type === 'option' ? '/contract' : '/share'}
                </div>
                {result.summary && (
                  <div className="text-[11px] text-white/50 mt-0.5">{result.summary}</div>
                )}
              </div>
            </div>

            {result.message && (
              <div className="rounded-xl px-4 py-3 text-sm text-white/50"
                style={{ background: 'var(--surface2)', border: '1px solid rgba(255,255,255,0.07)' }}>
                {result.message}
              </div>
            )}

            {/* Suggestion cards */}
            {result.suggestions.map((s, i) => (
              <div key={s.ticker} className="rounded-2xl overflow-hidden"
                style={{ background: 'var(--surface)', border: '1px solid rgba(255,255,255,0.08)' }}>

                {/* Top row */}
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="text-[10px] font-mono text-white/25 w-4">{i + 1}</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold font-mono text-base">{s.ticker}</span>
                      <span className="text-xs font-mono" style={{ color: s.change1D >= 0 ? '#34d399' : '#f87171' }}>
                        {s.change1D >= 0 ? '+' : ''}{s.change1D}%
                      </span>
                    </div>
                    <div className="text-xs text-white/40 font-mono">${s.price?.toFixed(2)}</div>
                  </div>

                  <div className="ml-auto flex flex-col items-end gap-1">
                    {/* Stock: shares you can buy */}
                    {result.type === 'stock' && s.shares != null && (
                      <div className="text-[10px] text-white/40">
                        <span className="font-bold text-white/70">{s.shares}</span> shares @ budget
                      </div>
                    )}
                    {/* Option: cost */}
                    {result.type === 'option' && s.est_total_cost != null && (
                      <div className="text-[10px] text-white/40">
                        ~<span className="font-bold text-white/70">${s.est_total_cost}</span>/contract
                      </div>
                    )}
                    {/* Technical badges */}
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full font-mono uppercase"
                        style={{ background: `${RISK_COLOR[s.risk]}15`, color: RISK_COLOR[s.risk] }}>
                        {s.risk} risk
                      </span>
                      <div className="flex gap-1">
                        {s.rsi != null && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded font-mono"
                            style={{
                              background: s.rsi > 70 ? 'rgba(248,113,113,0.15)' : s.rsi < 30 ? 'rgba(52,211,153,0.15)' : 'rgba(96,165,250,0.1)',
                              color: s.rsi > 70 ? '#f87171' : s.rsi < 30 ? '#34d399' : '#60a5fa'
                            }}>
                            RSI {s.rsi}
                          </span>
                        )}
                        {s.volumeRatio != null && s.volumeRatio > 1.2 && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded font-mono"
                            style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24' }}>
                            {s.volumeRatio}x vol
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Option details */}
                {result.type === 'option' && (s.option_type || s.suggested_strike) && (
                  <div className="px-4 pb-2 flex gap-2 flex-wrap">
                    {s.option_type && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-mono font-bold"
                        style={{ background: s.option_type === 'call' ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)', color: s.option_type === 'call' ? '#34d399' : '#f87171' }}>
                        {s.option_type.toUpperCase()}
                      </span>
                    )}
                    {s.suggested_strike && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-mono"
                        style={{ background: 'var(--surface2)', color: 'var(--text3)' }}>
                        {s.suggested_strike}
                      </span>
                    )}
                    {s.suggested_expiry && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-mono"
                        style={{ background: 'var(--surface2)', color: 'var(--text3)' }}>
                        {s.suggested_expiry}
                      </span>
                    )}
                  </div>
                )}

                {/* Reason + catalyst */}
                <div className="px-4 pb-3 flex items-start gap-2">
                  <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold shrink-0 mt-0.5"
                    style={{
                      background: `${CATALYST_COLOR[s.catalyst] || CATALYST_COLOR.default}15`,
                      color: CATALYST_COLOR[s.catalyst] || CATALYST_COLOR.default
                    }}>
                    {s.catalyst}
                  </span>
                  <p className="text-[11px] text-white/55 leading-relaxed">{s.reason}</p>
                </div>

                {/* Analyze button */}
                <div className="px-4 pb-3">
                  <button
                    onClick={() => router.push(`/?ticker=${s.ticker}`)}
                    className="w-full py-1.5 rounded-lg text-[11px] font-semibold transition-all hover:opacity-80 flex items-center justify-center gap-1.5"
                    style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)', color: '#a78bfa' }}>
                    <Zap size={11} />
                    Run full council analysis on {s.ticker}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
