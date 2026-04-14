'use client'

import { useState } from 'react'

interface OptionsContract {
  symbol: string
  type: 'call' | 'put'
  strike: number
  expiry: string
  last: number | null
  bid: number | null
  ask: number | null
  volume: number
  openInterest: number
  iv: number | null
  delta: number | null
  theta: number | null
  daysToExpiry: number
  moneyness: 'ITM' | 'ATM' | 'OTM'
}

interface OptionsRec {
  strategy: string
  strategyType: string
  rationale: string
  riskLevel: 'high' | 'medium' | 'low'
  maxLoss: string
  maxGain: string
  idealFor: string
  timeHorizon: string
  alternativeStrategy: string
  beginnerWarning: string
  greeksExplained: string
}

interface OptionsRecommendationsProps {
  ticker: string
  currentPrice: number
  signal: string
  timeHorizon: string
  target: string
  technicals: { technicalScore: number; goldenCross: boolean; rsi: number } | null
  verdict: string
}

const RISK_COLOR = { high: '#f87171', medium: '#fbbf24', low: '#34d399' }
const sf = (n: unknown, d = 2) => { const v = Number(n); return isNaN(v) ? '—' : v.toFixed(d) }

function ContractCard({ c }: { c: OptionsContract }) {
  const isBull = c.type === 'call'
  const color = isBull ? '#34d399' : '#f87171'
  const mid = c.bid !== null && c.ask !== null ? ((c.bid + c.ask) / 2) : null
  const cost = mid !== null ? (mid * 100).toFixed(0) : '—'

  return (
    <div className="rounded-xl border p-3 space-y-2"
      style={{ background: `${color}05`, borderColor: `${color}20` }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold font-mono px-2 py-0.5 rounded"
            style={{ background: `${color}15`, color }}>
            {c.type.toUpperCase()} ${c.strike}
          </span>
          <span className="text-[10px] font-mono text-white/40">{c.expiry}</span>
        </div>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded"
          style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)' }}>
          {c.moneyness} · {c.daysToExpiry}d
        </span>
      </div>

      <div className="grid grid-cols-3 gap-1.5 text-[10px] font-mono">
        <div className="rounded-md p-1.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
          <div className="text-white/25 mb-0.5">Bid / Ask</div>
          <div className="text-white/70">${sf(c.bid)} / ${sf(c.ask)}</div>
        </div>
        <div className="rounded-md p-1.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
          <div className="text-white/25 mb-0.5">Cost / contract</div>
          <div style={{ color }}>${cost}</div>
        </div>
        <div className="rounded-md p-1.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
          <div className="text-white/25 mb-0.5">Volume / OI</div>
          <div className="text-white/70">{c.volume} / {c.openInterest}</div>
        </div>
        <div className="rounded-md p-1.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
          <div className="text-white/25 mb-0.5">Delta</div>
          <div className="text-white/70">{sf(c.delta, 3)}</div>
        </div>
        <div className="rounded-md p-1.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
          <div className="text-white/25 mb-0.5">Theta / day</div>
          <div style={{ color: '#f87171' }}>{sf(c.theta, 3)}</div>
        </div>
        <div className="rounded-md p-1.5" style={{ background: 'rgba(255,255,255,0.04)' }}>
          <div className="text-white/25 mb-0.5">IV</div>
          <div className="text-white/70">{c.iv !== null ? `${sf(c.iv, 0)}%` : '—'}</div>
        </div>
      </div>
    </div>
  )
}

export default function OptionsRecommendations({
  ticker, currentPrice, signal, timeHorizon, target, technicals, verdict
}: OptionsRecommendationsProps) {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<{ recommendation: OptionsRec; contracts: OptionsContract[]; hasLiveData: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/options-recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, currentPrice, signal, timeHorizon, target, technicals, verdict }),
      })
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      setData(json)
      setExpanded(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const signalColor = signal === 'BULLISH' ? '#34d399' : signal === 'BEARISH' ? '#f87171' : '#fbbf24'

  return (
    <div className="mt-4 rounded-xl border overflow-hidden"
      style={{ borderColor: 'rgba(255,255,255,0.08)', background: '#111620' }}>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">Options Strategy</span>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
            style={{ background: `${signalColor}15`, color: signalColor, border: `1px solid ${signalColor}25` }}>
            {signal} on {ticker}
          </span>
        </div>
        {!data && (
          <button onClick={load} disabled={loading}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80 disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)', color: 'white' }}>
            {loading ? 'Analyzing…' : 'Get options recommendation'}
          </button>
        )}
        {data && (
          <button onClick={() => setExpanded(!expanded)}
            className="text-[11px] font-mono text-white/30 hover:text-white/60 transition-colors">
            {expanded ? '▲ Collapse' : '▼ Expand'}
          </button>
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-3 px-4 py-4">
          <div className="flex gap-1">
            {[0,1,2].map(i => (
              <span key={i} className="w-1.5 h-1.5 rounded-full thinking-dot"
                style={{ background: '#a78bfa', animationDelay: `${i * 0.15}s` }} />
            ))}
          </div>
          <span className="text-xs text-white/40 font-mono">Fetching live options chain and generating strategy…</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-4 py-3 text-xs text-red-400">{error}</div>
      )}

      {/* Results */}
      {data && expanded && (
        <div className="p-4 space-y-4">

          {/* Strategy header */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-base font-bold text-white">{data.recommendation.strategy}</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                  style={{
                    background: `${RISK_COLOR[data.recommendation.riskLevel]}15`,
                    color: RISK_COLOR[data.recommendation.riskLevel],
                    border: `1px solid ${RISK_COLOR[data.recommendation.riskLevel]}25`
                  }}>
                  {data.recommendation.riskLevel} risk
                </span>
                <span className="text-[10px] text-white/30 font-mono">{data.recommendation.timeHorizon}</span>
              </div>
            </div>
          </div>

          {/* Rationale */}
          <div className="rounded-xl p-3.5" style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
            <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#a78bfa' }}>Why this strategy</div>
            <p className="text-sm text-white/75 leading-relaxed">{data.recommendation.rationale}</p>
          </div>

          {/* Max loss / gain */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl p-3.5" style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)' }}>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#f87171' }}>Worst case (max loss)</div>
              <p className="text-xs text-white/65 leading-relaxed">{data.recommendation.maxLoss}</p>
            </div>
            <div className="rounded-xl p-3.5" style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)' }}>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#34d399' }}>Best case (max gain)</div>
              <p className="text-xs text-white/65 leading-relaxed">{data.recommendation.maxGain}</p>
            </div>
          </div>

          {/* Ideal for */}
          <div className="rounded-xl p-3.5" style={{ background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.15)' }}>
            <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#60a5fa' }}>Who this is suitable for</div>
            <p className="text-xs text-white/65 leading-relaxed">{data.recommendation.idealFor}</p>
          </div>

          {/* Greeks explained */}
          {data.recommendation.greeksExplained && (
            <div className="rounded-xl p-3.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5 text-white/25">Understanding the numbers (Greeks)</div>
              <p className="text-xs text-white/60 leading-relaxed">{data.recommendation.greeksExplained}</p>
            </div>
          )}

          {/* Live contracts */}
          {data.hasLiveData && data.contracts.length > 0 && (
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-2">
                Recommended contracts — live data
              </div>
              <div className="space-y-2">
                {data.contracts.map((c, i) => <ContractCard key={i} c={c} />)}
              </div>
              <p className="text-[10px] text-white/20 mt-2 leading-relaxed">
                Prices are live bid/ask from Tradier. One contract = 100 shares. Cost per contract = (ask price × 100).
              </p>
            </div>
          )}

          {!data.hasLiveData && (
            <div className="text-[10px] text-white/25 px-1">
              Live options chain unavailable — add TRADIER_API_KEY to Railway for specific contract data.
            </div>
          )}

          {/* Alternative strategy */}
          <div className="rounded-xl p-3.5" style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.15)' }}>
            <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#fbbf24' }}>Conservative alternative</div>
            <p className="text-xs text-white/65 leading-relaxed">{data.recommendation.alternativeStrategy}</p>
          </div>

          {/* Beginner warning */}
          <div className="rounded-xl p-3.5" style={{ background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.2)' }}>
            <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#f87171' }}>⚠ Important — read before trading</div>
            <p className="text-xs leading-relaxed" style={{ color: 'rgba(248,113,113,0.8)' }}>{data.recommendation.beginnerWarning}</p>
          </div>

          <p className="text-[9px] text-white/15 leading-relaxed">
            Options recommendations are for informational purposes only and do not constitute financial advice.
            Options trading involves substantial risk and is not suitable for all investors. You can lose your entire investment.
          </p>
        </div>
      )}
    </div>
  )
}
