'use client'

import { useState } from 'react'

interface FibLevel { level: number; price: number; label: string; type: string }

// Safe number formatter — never crashes on undefined/null
const sf = (n: unknown, decimals = 2, fallback = '—'): string => {
  const num = Number(n)
  return isNaN(num) ? fallback : num.toFixed(decimals)
}
const spct = (n: unknown, fallback = '—'): string => {
  const num = Number(n)
  return isNaN(num) ? fallback : `${num >= 0 ? '+' : ''}${num.toFixed(1)}%`
}

interface TechnicalChartsProps {
  ticker: string
  technicals: {
    rsi: number; stochK: number; stochD: number; stochSignal: string; stochCrossover: string
    goldenCross: boolean; sma50: number; sma200: number; ema9: number; ema20: number
    ema9CrossEma20: string; macdLine: number; macdSignal: number
    macdHistogram: number; macdCrossover: string
    bbPosition: number; bbSignal: string; bbUpper: number; bbMiddle: number; bbLower: number
    vwap: number; priceVsVwap: number; vwapSignal: string
    obv: number; obvTrend: string; obvDivergence: string
    volumeRatio: number; support: number; support2: number
    resistance: number; resistance2: number
    fibLevels: FibLevel[]; nearestFibLevel: FibLevel | null
    currentPrice: number; technicalScore: number; technicalBias: string
  } | null
}

// ── RSI Gauge ─────────────────────────────────────────────────
function RSIGauge({ rsi }: { rsi: number }) {
  const angle = -90 + (rsi / 100) * 180
  const rad = (angle * Math.PI) / 180
  const cx = 80, cy = 70, r = 55
  const nx = cx + r * Math.cos(rad), ny = cy + r * Math.sin(rad)
  const color = rsi >= 70 ? '#f87171' : rsi <= 30 ? '#34d399' : '#fbbf24'
  const label = rsi >= 70 ? 'Overbought' : rsi <= 30 ? 'Oversold' : 'Neutral'
  return (
    <div className="flex flex-col items-center">
      <svg width="160" height="85" viewBox="0 0 160 85">
        <path d="M 25 70 A 55 55 0 0 1 135 70" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="10" strokeLinecap="round" />
        <path d="M 25 70 A 55 55 0 0 1 52 26" fill="none" stroke="rgba(52,211,153,0.25)" strokeWidth="10" strokeLinecap="round" />
        <path d="M 108 26 A 55 55 0 0 1 135 70" fill="none" stroke="rgba(248,113,113,0.25)" strokeWidth="10" strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={color} strokeWidth="2.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="4" fill={color} />
        <text x="18" y="84" fontSize="9" fill="rgba(52,211,153,0.6)" textAnchor="middle">30</text>
        <text x="80" y="16" fontSize="9" fill="rgba(255,255,255,0.25)" textAnchor="middle">50</text>
        <text x="142" y="84" fontSize="9" fill="rgba(248,113,113,0.6)" textAnchor="middle">70</text>
      </svg>
      <div className="text-center -mt-1">
        <div className="text-lg font-bold font-mono" style={{ color }}>{sf(rsi, 1)}</div>
        <div className="text-[10px] font-mono text-white/35">{label}</div>
      </div>
    </div>
  )
}

// ── Stochastic Oscillator ─────────────────────────────────────
function StochasticGauge({ k, d, signal, crossover }: { k: number; d: number; signal: string; crossover: string }) {
  const color = k >= 80 ? '#f87171' : k <= 20 ? '#34d399' : '#fbbf24'
  const kX = (k / 100) * 140 + 10
  const dX = (d / 100) * 140 + 10
  return (
    <div className="flex flex-col items-center">
      <svg width="160" height="60" viewBox="0 0 160 60">
        <rect x="10" y="20" width="140" height="20" rx="4" fill="rgba(255,255,255,0.04)" />
        <rect x="10" y="20" width="28" height="20" rx="4" fill="rgba(52,211,153,0.15)" />
        <rect x="122" y="20" width="28" height="20" rx="4" fill="rgba(248,113,113,0.15)" />
        <text x="24" y="35" fontSize="8" fill="rgba(52,211,153,0.5)" textAnchor="middle">OS</text>
        <text x="136" y="35" fontSize="8" fill="rgba(248,113,113,0.5)" textAnchor="middle">OB</text>
        <line x1={dX} y1="16" x2={dX} y2="44" stroke="rgba(251,191,36,0.5)" strokeWidth="1.5" strokeDasharray="2,2" />
        <circle cx={kX} cy="30" r="6" fill={color} />
        <text x="10" y="56" fontSize="8" fill="rgba(255,255,255,0.2)">0</text>
        <text x="150" y="56" fontSize="8" fill="rgba(255,255,255,0.2)" textAnchor="end">100</text>
      </svg>
      <div className="text-center">
        <div className="text-sm font-bold font-mono" style={{ color }}>%K {sf(k, 1)} / %D {sf(d, 1)}</div>
        <div className="text-[10px] text-white/35">
          {signal} {crossover !== 'none' ? `· ${crossover} crossover` : ''}
        </div>
      </div>
    </div>
  )
}

// ── MA Cross Visual ───────────────────────────────────────────
function MACrossVisual({ goldenCross, sma50, sma200, ema9, ema20, ema9Cross }: {
  goldenCross: boolean; sma50: number; sma200: number; ema9: number; ema20: number; ema9Cross: string
}) {
  const color = goldenCross ? '#34d399' : '#f87171'
  const emaColor = ema9 > ema20 ? '#34d399' : '#f87171'
  return (
    <div className="space-y-2 w-full px-1">
      {/* SMA cross */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-white/30">SMA cross</span>
        <span className="text-[10px] font-bold font-mono" style={{ color }}>
          {goldenCross ? '✓ Golden cross' : '✗ Death cross'}
        </span>
      </div>
      <div className="flex gap-2 text-[10px] font-mono text-white/40">
        <span>SMA50 ${sf(sma50)}</span>
        <span>SMA200 ${sf(sma200)}</span>
      </div>
      {/* EMA cross */}
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] text-white/30">EMA cross</span>
        <span className="text-[10px] font-bold font-mono" style={{ color: emaColor }}>
          {ema9 > ema20 ? '▲ EMA9 > EMA20' : '▼ EMA9 < EMA20'}
          {ema9Cross !== 'none' && <span className="ml-1 text-[9px]">⚡ just crossed</span>}
        </span>
      </div>
      <div className="flex gap-2 text-[10px] font-mono text-white/40">
        <span>EMA9 ${sf(ema9)}</span>
        <span>EMA20 ${sf(ema20)}</span>
      </div>
    </div>
  )
}

// ── MACD ──────────────────────────────────────────────────────
function MACDVisual({ histogram, macdLine, signalLine, crossover }: {
  histogram: number; macdLine: number; signalLine: number; crossover: string
}) {
  const color = histogram >= 0 ? '#34d399' : '#f87171'
  const bars = [0.3, 0.5, 0.7, 0.85, 1.0, 0.8,
    histogram >= 0 ? 0.6 : -0.6,
    histogram >= 0 ? 0.8 : -0.8,
    histogram >= 0 ? 0.95 : -0.95,
    histogram >= 0 ? 1.0 : -1.0]
  const H = 60, barW = 12, gap = 3

  return (
    <div className="flex flex-col items-center w-full">
      <svg width="160" height={H} viewBox={`0 0 160 ${H}`}>
        <line x1="0" y1={H/2} x2="160" y2={H/2} stroke="rgba(255,255,255,0.12)" strokeWidth="0.5" />
        {bars.map((v, i) => {
          const bh = Math.abs(v) * (H/2 - 4)
          const positive = v >= 0
          const x = i * (barW + gap) + 5
          const y = positive ? H/2 - bh : H/2
          const isLast = i === bars.length - 1
          return <rect key={i} x={x} y={y} width={barW} height={bh}
            fill={positive ? 'rgba(52,211,153,0.6)' : 'rgba(248,113,113,0.6)'}
            opacity={isLast ? 1 : 0.6}
            style={{ fill: isLast ? color : undefined }}
            rx="1.5" />
        })}
      </svg>
      <div className="text-center">
        <div className="text-xs font-bold" style={{ color }}>
          {histogram >= 0 ? 'Bullish momentum' : 'Bearish momentum'}
          {crossover !== 'none' && <span className="ml-1 text-[10px]">⚡ {crossover} cross</span>}
        </div>
        <div className="text-[10px] font-mono text-white/30">
          MACD {sf(macdLine, 3)} / Signal {sf(signalLine, 3)}
        </div>
      </div>
    </div>
  )
}

// ── Bollinger Bands ───────────────────────────────────────────
function BollingerVisual({ position, signal, upper, middle, lower, current }: {
  position: number; signal: string; upper: number; middle: number; lower: number; current: number
}) {
  const color = position > 0.8 ? '#f87171' : position < 0.2 ? '#34d399' : '#fbbf24'
  const W = 160, H = 60
  const priceX = Math.max(10, Math.min(position * (W - 20) + 10, W - 10))
  return (
    <div className="flex flex-col items-center w-full">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <path d="M 10 10 Q 80 8 150 10" fill="none" stroke="rgba(248,113,113,0.35)" strokeWidth="1.5" />
        <path d="M 10 50 Q 80 52 150 50" fill="none" stroke="rgba(52,211,153,0.35)" strokeWidth="1.5" />
        <path d="M 10 30 Q 80 30 150 30" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1" strokeDasharray="3,2" />
        <path d="M 10 10 Q 80 8 150 10 L 150 50 Q 80 52 10 50 Z" fill="rgba(255,255,255,0.025)" />
        <circle cx={priceX} cy={10 + position * 40} r="5" fill={color} />
        <text x="5"   y="13" fontSize="8" fill="rgba(248,113,113,0.55)">U</text>
        <text x="5"   y="32" fontSize="8" fill="rgba(255,255,255,0.2)">M</text>
        <text x="5"   y="53" fontSize="8" fill="rgba(52,211,153,0.55)">L</text>
        <text x="155" y="13" fontSize="7" fill="rgba(255,255,255,0.2)" textAnchor="end">{sf(upper, 0)}</text>
        <text x="155" y="32" fontSize="7" fill="rgba(255,255,255,0.2)" textAnchor="end">{sf(middle, 0)}</text>
        <text x="155" y="53" fontSize="7" fill="rgba(255,255,255,0.2)" textAnchor="end">{sf(lower, 0)}</text>
      </svg>
      <div className="text-center">
        <div className="text-xs font-bold" style={{ color }}>
          {position > 0.8 ? 'Near upper band' : position < 0.2 ? 'Near lower band' : 'Mid-band'}
        </div>
        <div className="text-[10px] font-mono text-white/30">
          {signal} · {sf(position * 100, 0)}% · ${sf(current)}
        </div>
      </div>
    </div>
  )
}

// ── VWAP Visual ───────────────────────────────────────────────
function VWAPVisual({ vwap, current, priceVsVwap, signal }: {
  vwap: number; current: number; priceVsVwap: number; signal: string
}) {
  const color = signal === 'above' ? '#34d399' : '#f87171'
  const diff = Math.abs(priceVsVwap)
  const barPct = Math.min(diff / 5 * 100, 100)
  return (
    <div className="space-y-2 w-full px-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-white/30">VWAP</span>
        <span className="text-sm font-bold font-mono" style={{ color }}>${sf(vwap)}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
          <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: color }} />
        </div>
        <span className="text-[10px] font-mono shrink-0" style={{ color }}>
          {sf(priceVsVwap, 2, '0.00').startsWith('-') ? '' : '+'}{sf(priceVsVwap, 2)}%
        </span>
      </div>
      <div className="text-[10px] text-white/35">
        Price is <span style={{ color }}>{signal}</span> VWAP — {signal === 'above'
          ? 'bullish intraday bias, buyers in control'
          : 'bearish intraday bias, sellers in control'}
      </div>
    </div>
  )
}

// ── OBV Visual ────────────────────────────────────────────────
function OBVVisual({ trend, divergence }: { trend: string; divergence: string }) {
  const color = trend === 'rising' ? '#34d399' : trend === 'falling' ? '#f87171' : '#fbbf24'
  const divColor = divergence === 'bullish' ? '#34d399' : divergence === 'bearish' ? '#f87171' : 'transparent'
  const bars = trend === 'rising'
    ? [0.5, 0.55, 0.6, 0.65, 0.7, 0.72, 0.78, 0.82, 0.88, 0.95]
    : trend === 'falling'
    ? [0.95, 0.88, 0.82, 0.78, 0.72, 0.68, 0.62, 0.56, 0.5, 0.44]
    : [0.6, 0.65, 0.62, 0.67, 0.64, 0.68, 0.65, 0.7, 0.67, 0.65]
  const H = 50, W = 160, bW = 12, gap = 3
  return (
    <div className="flex flex-col items-center w-full">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <polyline
          points={bars.map((v, i) => `${i * (bW + gap) + 5 + bW/2},${H - v * (H - 4) - 2}`).join(' ')}
          fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {bars.map((v, i) => (
          <circle key={i} cx={i * (bW + gap) + 5 + bW/2} cy={H - v * (H - 4) - 2}
            r="2" fill={i === bars.length - 1 ? color : 'transparent'} />
        ))}
      </svg>
      <div className="text-center">
        <div className="text-xs font-bold" style={{ color }}>OBV {trend}</div>
        {divergence !== 'none' && (
          <div className="text-[10px] font-bold mt-0.5" style={{ color: divColor }}>
            ⚡ {divergence} divergence detected
          </div>
        )}
        <div className="text-[10px] text-white/30 mt-0.5">
          {trend === 'rising' ? 'Buying pressure accumulating' :
           trend === 'falling' ? 'Selling pressure increasing' : 'Volume balanced'}
        </div>
      </div>
    </div>
  )
}

// ── Fibonacci Levels ──────────────────────────────────────────
function FibTable({ levels, current, nearest }: { levels: FibLevel[]; current: number; nearest: FibLevel | null }) {
  const keyLevels = levels.filter(f => [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].includes(f.level))
  return (
    <div className="w-full space-y-1">
      {keyLevels.map((f) => {
        const isNearest = nearest?.level === f.level
        const pctFromCurrent = ((f.price - current) / current) * 100
        const color = f.type === 'support' ? '#34d399' : '#f87171'
        return (
          <div key={f.level}
            className="flex items-center gap-2 px-2 py-1 rounded-md"
            style={{ background: isNearest ? 'rgba(251,191,36,0.08)' : 'transparent', border: isNearest ? '1px solid rgba(251,191,36,0.2)' : '1px solid transparent' }}>
            <span className="text-[10px] font-mono text-white/30 w-10 shrink-0">{sf(f.level * 100, 1)}%</span>
            <span className="text-[10px] font-mono font-bold flex-1" style={{ color }}>${sf(f.price)}</span>
            <span className="text-[10px] font-mono text-white/25">
              {spct(pctFromCurrent)}
            </span>
            <span className="text-[9px] font-mono" style={{ color }}>{f.type}</span>
            {isNearest && <span className="text-[9px] text-yellow-400">★ nearest</span>}
          </div>
        )
      })}
    </div>
  )
}

// ── Key Levels Bar ────────────────────────────────────────────
function KeyLevels({ s1, s2, r1, r2, current }: { s1: number; s2: number; r1: number; r2: number; current: number }) {
  const min = Math.min(s2, current) * 0.995
  const max = Math.max(r2, current) * 1.005
  const range = max - min
  const toX = (p: number) => ((p - min) / range) * 220 + 10
  const cX = toX(current)
  return (
    <svg width="240" height="50" viewBox="0 0 240 50">
      <line x1="10" y1="25" x2="230" y2="25" stroke="rgba(255,255,255,0.08)" strokeWidth="2" />
      {/* S2 */}
      <line x1={toX(s2)} y1="15" x2={toX(s2)} y2="35" stroke="rgba(52,211,153,0.4)" strokeWidth="1.5" />
      <text x={toX(s2)} y="12" fontSize="7" fill="rgba(52,211,153,0.5)" textAnchor="middle">S2</text>
      <text x={toX(s2)} y="44" fontSize="7" fill="rgba(52,211,153,0.4)" textAnchor="middle">${sf(s2, 0)}</text>
      {/* S1 */}
      <line x1={toX(s1)} y1="15" x2={toX(s1)} y2="35" stroke="rgba(52,211,153,0.7)" strokeWidth="2" />
      <text x={toX(s1)} y="12" fontSize="7" fill="rgba(52,211,153,0.7)" textAnchor="middle">S1</text>
      <text x={toX(s1)} y="44" fontSize="7" fill="rgba(52,211,153,0.6)" textAnchor="middle">${sf(s1, 0)}</text>
      {/* Current */}
      <circle cx={cX} cy="25" r="6" fill="#fbbf24" />
      <text x={cX} y="12" fontSize="7" fill="#fbbf24" textAnchor="middle">NOW</text>
      {/* R1 */}
      <line x1={toX(r1)} y1="15" x2={toX(r1)} y2="35" stroke="rgba(248,113,113,0.7)" strokeWidth="2" />
      <text x={toX(r1)} y="12" fontSize="7" fill="rgba(248,113,113,0.7)" textAnchor="middle">R1</text>
      <text x={toX(r1)} y="44" fontSize="7" fill="rgba(248,113,113,0.6)" textAnchor="middle">${sf(r1, 0)}</text>
      {/* R2 */}
      <line x1={toX(r2)} y1="15" x2={toX(r2)} y2="35" stroke="rgba(248,113,113,0.4)" strokeWidth="1.5" />
      <text x={toX(r2)} y="12" fontSize="7" fill="rgba(248,113,113,0.5)" textAnchor="middle">R2</text>
      <text x={toX(r2)} y="44" fontSize="7" fill="rgba(248,113,113,0.4)" textAnchor="middle">${sf(r2, 0)}</text>
    </svg>
  )
}

// ── Volume Bar ────────────────────────────────────────────────
function VolumeBar({ ratio }: { ratio: number }) {
  const color = ratio > 1.5 ? '#fbbf24' : ratio < 0.5 ? '#94a3b8' : '#60a5fa'
  return (
    <div className="w-full space-y-1 px-1">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(ratio / 3 * 100, 100)}%`, background: color }} />
        </div>
        <span className="text-[10px] font-mono shrink-0" style={{ color }}>{sf(ratio, 1)}x avg</span>
      </div>
      <div className="text-[10px] text-white/30">
        {ratio > 1.5 ? 'High volume — strong conviction behind move' :
         ratio < 0.5 ? 'Low volume — move lacks conviction' : 'Average volume — no unusual activity'}
      </div>
    </div>
  )
}

// ── Finviz Chart ──────────────────────────────────────────────
function FinvizChart({ ticker }: { ticker: string }) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const url = `https://finviz.com/chart.ashx?t=${ticker}&ty=c&ta=1&p=d&s=l`
  if (error) return (
    <div className="flex items-center justify-center h-28 rounded-lg text-xs text-white/25"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
      Chart unavailable for {ticker}
    </div>
  )
  return (
    <div className="relative rounded-lg overflow-hidden" style={{ background: '#060810' }}>
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center h-28">
          <div className="flex gap-1">
            {[0,1,2].map(i => <span key={i} className="w-1.5 h-1.5 rounded-full thinking-dot" style={{ background: '#fbbf24', animationDelay: `${i*0.15}s` }} />)}
          </div>
        </div>
      )}
      <img src={url} alt={`${ticker} chart`} className="w-full rounded-lg"
        style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.3s', minHeight: '110px' }}
        onLoad={() => setLoaded(true)} onError={() => setError(true)} referrerPolicy="no-referrer" />
      <div className="absolute bottom-1 right-2 text-[9px] font-mono text-white/15">Finviz</div>
    </div>
  )
}

// ── Score Badge ───────────────────────────────────────────────
function ScoreBadge({ score, bias }: { score: number; bias: string }) {
  const color = bias === 'BULLISH' ? '#34d399' : bias === 'BEARISH' ? '#f87171' : '#fbbf24'
  const pct = ((score + 100) / 200) * 100
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl" style={{ background: `${color}08`, border: `1px solid ${color}20` }}>
      <div>
        <div className="text-[10px] font-mono text-white/25 uppercase tracking-widest">Technical score</div>
        <div className="text-2xl font-bold font-mono" style={{ color }}>{sf(score, 0)}</div>
        <div className="text-xs font-bold" style={{ color }}>{bias}</div>
      </div>
      <div className="flex-1">
        <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
        </div>
        <div className="flex justify-between text-[9px] font-mono text-white/20 mt-0.5">
          <span>-100 Bear</span><span>0</span><span>+100 Bull</span>
        </div>
      </div>
    </div>
  )
}

// ── Indicator Card wrapper ────────────────────────────────────
function ICard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-3 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.07)' }}>
      <div className="text-[10px] font-mono uppercase tracking-widest text-white/20 mb-2">{title}</div>
      {children}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────
export default function TechnicalCharts({ ticker, technicals }: TechnicalChartsProps) {
  const [showTV, setShowTV] = useState(false)
  if (!technicals) return null

  const t = technicals

  return (
    <div className="space-y-4 mt-4">
      <div className="flex items-center gap-2">
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/20">Technical analysis</div>
        <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />
      </div>

      {/* Overall score */}
      <ScoreBadge score={t.technicalScore} bias={t.technicalBias} />

      {/* Finviz chart */}
      <div>
        <div className="text-[10px] font-mono text-white/20 mb-1.5">Daily candlestick chart (SMA50 / SMA200)</div>
        <FinvizChart ticker={ticker} />
      </div>

      {/* Indicator grid 2x2 */}
      <div className="grid grid-cols-2 gap-3">
        <ICard title="RSI (14)">
          <RSIGauge rsi={t.rsi} />
          <p className="text-[10px] text-white/30 mt-1 text-center leading-tight">
            {t.rsi >= 70 ? 'Overbought — may pull back' : t.rsi <= 30 ? 'Oversold — may bounce' : 'No extreme reading'}
          </p>
        </ICard>

        <ICard title="Stochastic (14,3,3)">
          <StochasticGauge k={t.stochK} d={t.stochD} signal={t.stochSignal} crossover={t.stochCrossover} />
          <p className="text-[10px] text-white/30 mt-1 text-center leading-tight">
            {t.stochSignal === 'overbought' ? 'Momentum stretched high' :
             t.stochSignal === 'oversold' ? 'Momentum stretched low' : 'Momentum in neutral zone'}
          </p>
        </ICard>

        <ICard title="MACD (12,26,9)">
          <MACDVisual histogram={t.macdHistogram} macdLine={t.macdLine} signalLine={t.macdSignal} crossover={t.macdCrossover} />
        </ICard>

        <ICard title="Bollinger bands">
          <BollingerVisual position={t.bbPosition} signal={t.bbSignal}
            upper={t.bbUpper} middle={t.bbMiddle} lower={t.bbLower} current={t.currentPrice} />
        </ICard>
      </div>

      {/* Moving averages */}
      <ICard title="Moving average alignment">
        <MACrossVisual goldenCross={t.goldenCross} sma50={t.sma50} sma200={t.sma200}
          ema9={t.ema9} ema20={t.ema20} ema9Cross={t.ema9CrossEma20} />
      </ICard>

      {/* VWAP */}
      <ICard title="VWAP — volume weighted average price">
        <VWAPVisual vwap={t.vwap} current={t.currentPrice} priceVsVwap={t.priceVsVwap} signal={t.vwapSignal} />
      </ICard>

      {/* OBV */}
      <ICard title="OBV — on-balance volume">
        <OBVVisual trend={t.obvTrend} divergence={t.obvDivergence} />
      </ICard>

      {/* Volume */}
      <ICard title="Volume">
        <VolumeBar ratio={t.volumeRatio} />
      </ICard>

      {/* Support / Resistance */}
      <ICard title="Key price levels (pivot points)">
        <div className="flex justify-center mb-2">
          <KeyLevels s1={t.support} s2={t.support2} r1={t.resistance} r2={t.resistance2} current={t.currentPrice} />
        </div>
        <div className="text-[10px] text-white/25 text-center">
          S1 ${sf(t.support)} · S2 ${sf(t.support2)} · R1 ${sf(t.resistance)} · R2 ${sf(t.resistance2)}
        </div>
      </ICard>

      {/* Fibonacci */}
      {t.fibLevels.length > 0 && (
        <ICard title="Fibonacci retracement levels">
          <FibTable levels={t.fibLevels} current={t.currentPrice} nearest={t.nearestFibLevel} />
          <p className="text-[10px] text-white/25 mt-2 leading-relaxed">
            Fibonacci levels show where price tends to pause or reverse. The nearest level to current price is the most relevant for short-term trades.
          </p>
        </ICard>
      )}

      {/* TradingView */}
      <button onClick={() => setShowTV(!showTV)}
        className="w-full py-2 rounded-lg text-xs font-mono transition-all hover:opacity-80"
        style={{ background: 'rgba(255,255,255,0.03)', color: 'rgba(255,255,255,0.35)', border: '1px solid rgba(255,255,255,0.07)' }}>
        {showTV ? '▲ Hide' : '▼ Show'} TradingView live chart
      </button>
      {showTV && (
        <div className="rounded-lg overflow-hidden" style={{ height: 300 }}>
          <iframe
            src={`https://s.tradingview.com/widgetembed/?frameElementId=tv&symbol=${ticker}&interval=D&hidesidetoolbar=1&theme=dark&style=1&locale=en`}
            style={{ width: '100%', height: '100%', border: 'none' }}
            allowFullScreen />
        </div>
      )}
    </div>
  )
}
