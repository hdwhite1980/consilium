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
    // New indicators
    atr14?: number; atrPct?: number; atrSignal?: string
    stopLossATR?: number; takeProfitATR?: number
    roc10?: number; roc20?: number; rocSignal?: string; momentum?: number
    williamsR?: number; williamsSignal?: string
    cci?: number; cciSignal?: string
    ichimokuTenkan?: number; ichimokuKijun?: number
    ichimokuSignal?: string; ichimokuCross?: string
    relStrengthVsSector?: number | null; relStrengthSignal?: string
    goldenZone?: { swingHigh: number; swingLow: number; trending: string; levels: Array<{ level: number; price: number; label: string; type: string }>; goldenPocketHigh: number; goldenPocketLow: number; inGoldenZone: boolean; distToZone: number } | null
    // Pattern detection
    candlePattern?: { name: string; type: string; strength: string; description: string } | null
    chartPattern?: { name: string; type: string; target: number | null; invalidation: number | null; description: string; confidence: string } | null
    gapPattern?: { type: string; size: number; filled: boolean; gapHigh: number; gapLow: number; bullish: boolean; description: string } | null
    trendLines?: { higherHighs: boolean; lowerLows: boolean; higherLows: boolean; lowerHighs: boolean; trend: string; dynamicSupport: number | null; dynamicResistance: number | null } | null
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
    <div className="rounded-xl p-2.5 sm:p-3 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.07)' }}>
      <div className="text-[10px] font-mono uppercase tracking-widest text-white/20 mb-2">{title}</div>
      {children}
    </div>
  )
}

// ── Explanation Box ───────────────────────────────────────────
function Explain({ color, what, means }: { color: string; what: string; means: string }) {
  return (
    <div className="mt-2 rounded-lg overflow-hidden text-xs"
      style={{ border: `1px solid ${color}18` }}>
      <div className="px-3 py-2" style={{ background: `${color}06` }}>
        <div className="text-[9px] font-mono uppercase tracking-widest mb-1" style={{ color: `${color}90` }}>
          What is this?
        </div>
        <p className="leading-relaxed" style={{ color: 'rgba(255,255,255,0.5)' }}>{what}</p>
      </div>
      <div className="px-3 py-2" style={{ background: `${color}10`, borderTop: `1px solid ${color}15` }}>
        <div className="text-[9px] font-mono uppercase tracking-widest mb-1" style={{ color }}>
          What it means for this stock right now
        </div>
        <p className="leading-relaxed font-medium" style={{ color: 'rgba(255,255,255,0.75)' }}>{means}</p>
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────
export default function TechnicalCharts({ ticker, technicals }: TechnicalChartsProps) {
  const [showTV, setShowTV] = useState(false)
  if (!technicals) return null

  const t = technicals
  const p = t.currentPrice ?? 0

  // Pre-compute contextual explanations — two parts each: WHAT IT IS + WHAT IT MEANS NOW
  const rsiColor = t.rsi >= 70 ? '#f87171' : t.rsi <= 30 ? '#34d399' : '#fbbf24'
  const rsiWhat = `The RSI (Relative Strength Index) measures how fast a stock's price has been moving, on a scale from 0 to 100. Think of it like a speedometer for buying and selling pressure. Below 30 means the stock has been sold so hard it may be oversold — like a rubber band stretched too far down. Above 70 means it has been bought so aggressively it may be overbought — like a rubber band stretched too far up. Around 50 is neutral, with buyers and sellers roughly balanced.`
  const rsiMeans = t.rsi >= 80
    ? `RSI is ${sf(t.rsi,1)} — extremely overbought. The stock has been bought so aggressively that this level is rarely sustained. Think of a runner who has been sprinting — they usually need to slow down or rest. This doesn't mean the stock will drop tomorrow, but buying here carries more risk than usual. Many traders wait for RSI to drop back below 70 before taking a position.`
    : t.rsi >= 70
    ? `RSI is ${sf(t.rsi,1)} — entering overbought territory. Buyers have been in strong control. The risk here is that the stock may have gotten ahead of itself. Watch if RSI starts curling downward — that's often the first sign momentum is fading. Not a reason to panic, but a reason to be careful about buying more right now.`
    : t.rsi <= 20
    ? `RSI is ${sf(t.rsi,1)} — extremely oversold. The stock has been sold relentlessly. At this level, even bad stocks tend to get a bounce because so many sellers have already sold. This is often a good time to watch closely — not necessarily to buy immediately, but to look for any sign of recovery.`
    : t.rsi <= 30
    ? `RSI is ${sf(t.rsi,1)} — oversold. The selling pressure has been significant. Historically, stocks at these RSI levels tend to recover because many sellers have already exited. This can be an early signal of a potential reversal. Look for the price to stop making new lows and for volume to dry up.`
    : t.rsi > 55
    ? `RSI is ${sf(t.rsi,1)} — bullish momentum zone. Buyers currently have the upper hand without the stock being stretched. This is a healthy reading for an uptrend — strong enough to show conviction, not so high it's at risk of reversal. It supports the case for continued upward movement.`
    : t.rsi > 45
    ? `RSI is ${sf(t.rsi,1)} — right in the middle, perfectly neutral. There's no clear edge for buyers or sellers right now. The stock is waiting for a catalyst to push it one way or the other. Watch other indicators for direction.`
    : `RSI is ${sf(t.rsi,1)} — bearish momentum zone. Sellers have slightly more control than buyers. Not extreme, but the path of least resistance appears to be downward. Combined with other bearish signals, this adds weight to the bear case.`

  const stochColor = t.stochK >= 80 ? '#f87171' : t.stochK <= 20 ? '#34d399' : '#fbbf24'
  const stochWhat = `The Stochastic Oscillator compares where a stock closed relative to its price range over the past 14 days. It has two lines: %K (the fast line, currently ${sf(t.stochK,1)}) and %D (the slow line, currently ${sf(t.stochD,1)}). When both lines are above 80, the stock has been closing near its highs — that's overbought. Below 20, it's been closing near its lows — oversold. The key signal is when the fast line (%K) crosses the slow line (%D) — that crossover often marks a turning point.`
  const stochMeans = t.stochCrossover === 'bullish'
    ? `%K just crossed above %D — a bullish crossover just happened. This is one of the clearest momentum signals: the fast line overtook the slow line, suggesting buyers have just taken control from sellers. When this happens in oversold territory (below 20), it's an especially strong buy signal. Many traders use this exact moment as their entry point.`
    : t.stochCrossover === 'bearish'
    ? `%K just crossed below %D — a bearish crossover just happened. The fast line dropped below the slow confirmation line. This tells us the short-term momentum has just flipped from bullish to bearish. When this happens in overbought territory (above 80), it's considered a strong sell signal. Traders often tighten stop-losses when they see this.`
    : t.stochSignal === 'overbought'
    ? `Both lines are above 80 (overbought zone). The stock has been closing near its highest prices for the measured period. This is a warning: the stock is running hot. It doesn't mean a crash is coming, but it does mean a pullback is increasingly likely. The key moment to watch for is %K crossing below %D while still above 80 — that's when many traders start selling.`
    : t.stochSignal === 'oversold'
    ? `Both lines are below 20 (oversold zone). The stock has been closing near its lowest prices. This is a potential setup for a reversal. Savvy traders watch for %K to cross above %D while both are below 20 — that crossover in oversold territory is considered one of the highest-probability buy signals in technical analysis.`
    : `Both lines are in the middle zone — no extreme reading. %K is ${sf(t.stochK,1)} and %D is ${sf(t.stochD,1)}. ${t.stochK > t.stochD ? 'The fast line is above the slow line — mild upward momentum.' : 'The fast line is below the slow line — mild downward pressure.'} Neither bulls nor bears have a strong edge right now based on this indicator alone. Wait for a crossover or for the lines to move toward an extreme zone.`

  const macdColor = t.macdHistogram >= 0 ? '#34d399' : '#f87171'
  const macdWhat = `MACD (Moving Average Convergence Divergence) measures the difference between a 12-day and 26-day moving average of the price. The "histogram" bars you see show how much distance there is between those two averages. When the bars are positive (above zero), it means short-term momentum is stronger than the medium-term trend — bullish. When negative, the opposite. The most important signal is a "crossover" — when the MACD line crosses its signal line, it often marks the beginning of a new trend.`
  const macdMeans = t.macdCrossover === 'bullish'
    ? `A bullish MACD crossover just occurred — this is a major signal. The MACD line crossed above its signal line, meaning short-term momentum has overtaken the medium-term average. This is the kind of signal that many professional traders act on. Historically, bullish MACD crossovers are most reliable when they happen after a prolonged downtrend. The fact that it's happening now adds significant weight to the bullish case.`
    : t.macdCrossover === 'bearish'
    ? `A bearish MACD crossover just occurred — a significant warning signal. The MACD line dropped below its signal line, telling us that short-term momentum has turned negative. This is when many traders start reducing positions or tightening stop losses. The most reliable bearish crossovers happen after a prolonged uptrend — if the stock has been rising, this is a real warning sign.`
    : t.macdHistogram >= 0
    ? `The MACD histogram is positive at ${sf(t.macdHistogram,3)} — buying momentum is stronger than selling momentum right now. Think of the histogram bars like a thermometer for momentum: the higher they are, the more heat there is behind the buying. No crossover has happened yet, but the positive reading tells us buyers are currently in control of the pace.`
    : `The MACD histogram is negative at ${sf(t.macdHistogram,3)} — selling momentum is stronger than buying momentum. The stock is losing steam. The further the histogram goes negative, the stronger the selling pressure. No crossover yet, but momentum is clearly leaning bearish. Watch for the bars to start getting shorter (less negative) — that would be the first sign of momentum shifting.`

  const bbColor = t.bbPosition > 0.8 ? '#f87171' : t.bbPosition < 0.2 ? '#34d399' : '#fbbf24'
  const bbWhat = `Bollinger Bands draw a channel around the stock's price based on how much it normally moves. The middle band is the 20-day average price. The upper band ($${sf(t.bbUpper)}) is where the price would be if it moved unusually high. The lower band ($${sf(t.bbLower)}) is unusually low territory. Most of the time (about 95%), the price stays within these bands. When price touches or breaks a band, it's a signal that something unusual is happening. The width of the bands also tells you about volatility — narrow bands (squeeze) mean a big move is coming.`
  const bbMeans = t.bbSignal === 'squeeze'
    ? `The bands are in a squeeze — they're unusually narrow right now. This is one of the most important setups in technical analysis. A squeeze means the stock has been moving in a very tight range, and that kind of calm almost always precedes a storm. The price is building energy for a big move. We just don't know yet if that move will be up or down. Watch for the price to break out of the current range — whichever direction it breaks with conviction is likely the start of a significant move.`
    : t.bbPosition > 0.9
    ? `Price ($${sf(p)}) is at ${sf(t.bbPosition*100,0)}% of the band — touching the upper band ($${sf(t.bbUpper)}). The stock has moved unusually far above its average. This is like being at the edge of a rubber band — it can stretch a little further, but the tension is high. Statistically, price tends to snap back toward the middle band ($${sf(t.bbMiddle)}) from here. Not a guaranteed reversal, but a sign to be cautious about buying.`
    : t.bbPosition < 0.1
    ? `Price ($${sf(p)}) is at ${sf(t.bbPosition*100,0)}% of the band — touching the lower band ($${sf(t.bbLower)}). The stock has moved unusually far below its average. Like a rubber band stretched down, there's tension for a snap back upward toward the middle ($${sf(t.bbMiddle)}). This is a classic setup that value-oriented traders look for. Combined with other bullish signals, touching the lower band can be a strong buy indicator.`
    : t.bbPosition > 0.6
    ? `Price ($${sf(p)}) is at ${sf(t.bbPosition*100,0)}% of the band — in the upper half, above the 20-day average ($${sf(t.bbMiddle)}). The stock is holding above its average price, which is the definition of an uptrend. There's still room before hitting the upper band ($${sf(t.bbUpper)}), meaning the stock isn't stretched yet. This is a comfortable, healthy bullish position.`
    : t.bbPosition < 0.4
    ? `Price ($${sf(p)}) is at ${sf(t.bbPosition*100,0)}% of the band — in the lower half, below the 20-day average ($${sf(t.bbMiddle)}). The stock has been spending time below its average, which is a bearish characteristic. The lower band is at $${sf(t.bbLower)}. In a strong downtrend, prices can "walk" down the lower band for weeks. Look for other confirming signals before assuming this is a buy.`
    : `Price ($${sf(p)}) is right in the middle of the bands at ${sf(t.bbPosition*100,0)}% — sitting right at the 20-day average ($${sf(t.bbMiddle)}). This is a neutral position, exactly balanced between bulls and bears. The next direction is uncertain. Watch which side the price moves away from this midpoint — with volume — to get the next directional signal.`

  const maColor = t.goldenCross ? '#34d399' : '#f87171'
  const maWhat = `Moving averages smooth out daily price fluctuations to show the overall trend. The SMA50 ($${sf(t.sma50)}) is the average price over the last 50 trading days (about 10 weeks). The SMA200 ($${sf(t.sma200)}) is the average over 200 days (about 10 months). When the 50-day crosses above the 200-day, it's called a "Golden Cross" — widely considered a major bullish signal. When it crosses below, it's a "Death Cross" — a major bearish signal. The short-term EMAs (9 and 20 day) react faster to recent price changes and give earlier signals for shorter-term traders.`
  const maMeans = t.goldenCross
    ? `Golden Cross confirmed — SMA50 ($${sf(t.sma50)}) is above SMA200 ($${sf(t.sma200)}). This is the single most watched long-term technical signal by institutional investors. It means the 10-week trend is stronger than the 10-month trend — a sign that the stock has rebuilt sustained upward momentum. Many large funds have rules that require a Golden Cross before they'll buy. The fact that one is in effect is a significant tailwind.${
        t.ema9CrossEma20 === 'bullish' ? ' On top of that, the short-term EMA9/EMA20 also just crossed bullish — momentum is aligning on multiple timeframes simultaneously. This is a strong setup.' 
        : t.ema9 > t.ema20 ? ' The short-term EMA9 ($' + sf(t.ema9) + ') is above EMA20 ($' + sf(t.ema20) + '), confirming that near-term momentum also supports the bullish picture.' 
        : ' However, the short-term EMA9 ($' + sf(t.ema9) + ') has dipped below EMA20 ($' + sf(t.ema20) + '). This means there may be a temporary pullback happening within the larger uptrend. Not unusual — these short-term dips within a Golden Cross environment can be buying opportunities.'}`
    : `Death Cross confirmed — SMA50 ($${sf(t.sma50)}) is below SMA200 ($${sf(t.sma200)}). This is one of the most bearish long-term signals in investing. It means selling pressure has been strong enough — for long enough — to drag the medium-term trend below the long-term trend. When this happens, many institutional funds sell or reduce positions automatically. It's not a signal to panic, but it is a signal to be very cautious. Recoveries from Death Crosses can take months.${
        t.ema9CrossEma20 === 'bearish' ? ' The short-term EMA9/EMA20 also just crossed bearish — the sell signal is appearing across all timeframes at once. This is a strong confirmation of downward momentum.' 
        : t.ema9 < t.ema20 ? ' The short-term EMA9 ($' + sf(t.ema9) + ') is also below EMA20 ($' + sf(t.ema20) + ') — near-term momentum confirms the bearish picture at every timeframe.' 
        : ' The short-term EMA9 ($' + sf(t.ema9) + ') is above EMA20 ($' + sf(t.ema20) + ') — there may be a short-term bounce happening inside the larger downtrend. Be careful: bounces within Death Cross environments often fail. Many experienced traders use these bounces as selling opportunities rather than buying ones.'}`

  const vwapColor = t.vwapSignal === 'above' ? '#34d399' : '#f87171'
  const vwapWhat = `VWAP (Volume Weighted Average Price) is the average price of every trade made today, weighted by how many shares were traded at each price. It's like asking: "What is the true average price that real money paid today?" It resets to zero every morning. VWAP ($${sf(t.vwap)}) is one of the most important intraday levels used by professional traders and institutions. Staying above VWAP is bullish. Falling below is bearish.`
  const vwapMeans = t.vwapSignal === 'above'
    ? `Price ($${sf(p)}) is ${sf(t.priceVsVwap,2)}% above VWAP ($${sf(t.vwap)}). Being above VWAP means that if you bought right now, you're paying more than the average price paid today — but it also signals that buyers are currently in control of the market. Institutions often only buy stocks that are above VWAP, treating it as a filter for direction. A stock holding above VWAP throughout the day is showing sustained buying interest.`
    : `Price ($${sf(p)}) is ${sf(Math.abs(t.priceVsVwap ?? 0),2)}% below VWAP ($${sf(t.vwap)}). The stock is trading at a discount to today's average — but that's not necessarily a bargain. It means sellers have dominated all day. Professional traders treat VWAP as a key battleground: a stock that can't reclaim VWAP is weak. Many short sellers use a failure to reclaim VWAP as their entry signal. Watch to see if the price can push back above $${sf(t.vwap)} — if it can, that would flip the intraday bias bullish.`

  const obvColor = t.obvTrend === 'rising' ? '#34d399' : t.obvTrend === 'falling' ? '#f87171' : '#fbbf24'
  const obvWhat = `OBV (On-Balance Volume) is a running total that adds volume on days the stock goes up and subtracts volume on days it goes down. The idea is that volume precedes price. If big money is quietly buying a stock, the OBV will start rising even before the price moves much. OBV is one of the best indicators for detecting accumulation (institutions quietly buying) or distribution (institutions quietly selling) before those moves become obvious in the price.`
  const obvMeans = t.obvDivergence === 'bullish'
    ? `Bullish OBV divergence detected — this is a significant hidden signal. The price has been falling, but OBV is rising. Translation: even as the stock looks weak on the surface, more money is coming in on the up-days than leaving on the down-days. This is often what it looks like when smart money quietly accumulates a position — they buy on dips, keeping their buying somewhat hidden. Historically, bullish OBV divergence often precedes a price reversal upward. This is one of the most bullish hidden signals you can find.`
    : t.obvDivergence === 'bearish'
    ? `Bearish OBV divergence detected — a hidden warning sign. The price has been rising, but OBV is falling. Translation: the price rally is happening on weak volume — more money is leaving on down-days than entering on up-days. This often means institutions are quietly selling into the rally while retail investors push the price up. It's a sign the move may not be sustainable. When OBV diverges from price like this, the price usually follows the OBV eventually — which would mean a drop is coming.`
    : t.obvTrend === 'rising'
    ? `OBV is trending upward — volume is confirming the price move. This is healthy. It means that on the days the stock goes up, significantly more shares are traded than on days it goes down. Big money (institutions, funds) is participating in the buying, not just individual retail investors. Volume confirmation like this is what separates a strong, sustainable move from a weak one.`
    : t.obvTrend === 'falling'
    ? `OBV is trending downward — volume is confirming selling pressure. More shares are trading hands on down-days than up-days. Even if the price hasn't dropped dramatically yet, the underlying volume pattern is bearish. OBV often leads price — meaning the price may catch down to where OBV is pointing. This is an early warning to pay attention to.`
    : `OBV is flat — volume is balanced. An equal amount of money is going into up-days and down-days. This often happens during consolidation — when a stock is building energy before its next big move. The direction OBV breaks out of this flat pattern will give the first clue about where price is headed.`

  const volColor = t.volumeRatio > 1.5 ? '#fbbf24' : t.volumeRatio < 0.5 ? '#94a3b8' : '#60a5fa'
  const volWhat = `Volume is simply how many shares were traded. The number itself doesn't mean much — what matters is how it compares to the average. If a stock normally trades 1 million shares a day and today it trades 3 million, something significant is happening. Volume validates price moves: a big price move on huge volume is meaningful. The same price move on tiny volume is suspicious and often reverses.`
  const volMeans = t.volumeRatio > 2
    ? `Volume is ${sf(t.volumeRatio,1)}x the 20-day average — extremely high. Something significant is happening today. This level of activity almost always means institutions (big funds, banks, hedge funds) are actively buying or selling. High volume on an up day is very bullish — it means real money is behind the move. High volume on a down day is very bearish — real money is selling. Check the price direction alongside this volume reading.`
    : t.volumeRatio > 1.5
    ? `Volume is ${sf(t.volumeRatio,1)}x above average — elevated and meaningful. More participants than usual are in this stock today. This gives credibility to today's price move — whatever direction the stock is going, more people agree with it than on a typical day. A breakout on above-average volume is a much more reliable signal than one on thin volume.`
    : t.volumeRatio < 0.3
    ? `Volume is only ${sf(t.volumeRatio,1)}x the average — extremely thin. Barely anyone is trading this stock right now. This is important: price moves on very low volume are unreliable and can be reversed easily. A 2% gain on 0.3x volume means very few people participated in that gain. Don't read too much into today's action until volume returns to normal.`
    : t.volumeRatio < 0.5
    ? `Volume is ${sf(t.volumeRatio,1)}x average — below normal. Thin participation. Today's price action should be taken with a grain of salt. Low-volume moves tend to fade when normal trading activity resumes. No major players are making big moves today based on this reading.`
    : `Volume is ${sf(t.volumeRatio,1)}x the 20-day average — roughly normal. Standard participation today. Nothing unusual in terms of buying or selling pressure from a volume perspective. Today's price move reflects typical market activity.`

  const nearFib = t.nearestFibLevel
  const fibWhat = `Fibonacci retracements are a tool borrowed from mathematics. The key levels — 23.6%, 38.2%, 50%, 61.8%, and 78.6% — are used to identify where a stock tends to pause or reverse after a big move. They work because so many traders use them that they become self-fulfilling: when price approaches a Fibonacci level, traders expect a reaction there and act accordingly. The levels shown are calculated from the most recent significant high to low (or low to high) in the price data.`
  const fibMeans = nearFib
    ? `The nearest Fibonacci level to current price ($${sf(p)}) is the ${nearFib.label} level at $${sf(nearFib.price)} — currently acting as ${nearFib.type}. ${
        nearFib.type === 'support'
          ? `This is a support level — price has already moved down from a peak and this is where technical analysis suggests buyers may step in. If the stock falls to $${sf(nearFib.price)}, watch closely: a bounce from this exact level would confirm it as strong support and could be a buying opportunity. A break below this level with momentum would suggest the stock wants to fall further to the next Fibonacci level.`
          : `This is a resistance level — price is recovering upward and is approaching a zone where sellers have historically appeared. If the stock rises to $${sf(nearFib.price)}, expect some resistance or a temporary slowdown. A clean break above this level on good volume would be a bullish breakout signal. A rejection here would suggest the recovery is stalling.`
      }`
    : `The Fibonacci levels shown are calculated from the measured price range. Look at the nearest starred level (★) to current price — that's your most relevant reference point right now.`

  const s1Dist = p && t.support ? ((p - t.support) / p * 100) : 0
  const r1Dist = p && t.resistance ? ((t.resistance - p) / p * 100) : 0
  const levelsWhat = `Pivot point levels (S1, S2, R1, R2) are calculated from the previous period's high, low, and close prices. They're used by traders worldwide to identify key price zones where the stock is likely to slow down, bounce, or reverse. Support levels (S1 at $${sf(t.support)}, S2 at $${sf(t.support2)}) are floors where buyers tend to step in. Resistance levels (R1 at $${sf(t.resistance)}, R2 at $${sf(t.resistance2)}) are ceilings where sellers tend to appear.`
  const levelsMeans = s1Dist < 1
    ? `⚠ The stock is dangerously close to S1 support at $${sf(t.support)} — only ${sf(s1Dist,1)}% away. This is a critical moment. If the price breaks below $${sf(t.support)} with momentum, it could accelerate downward as stop-loss orders trigger automatically. Watch this level closely. A hold and bounce from here would be bullish. A break below signals further weakness toward S2 at $${sf(t.support2)}.`
    : r1Dist < 1
    ? `⚠ The stock is testing R1 resistance at $${sf(t.resistance)} — only ${sf(r1Dist,1)}% away. This is a key moment. Resistance levels often cause price to stall or pull back. A breakout above $${sf(t.resistance)} on strong volume would be a bullish signal and open the door to R2 at $${sf(t.resistance2)}. A rejection here (price turns back down) would be a bearish sign.`
    : r1Dist < s1Dist
    ? `Price ($${sf(p)}) is closer to resistance ($${sf(t.resistance)}, ${sf(r1Dist,1)}% away) than to support ($${sf(t.support)}, ${sf(s1Dist,1)}% below). The next meaningful test is whether the stock can push through R1. If it does on volume, that's bullish. If it gets rejected, watch for a pullback toward support. S2 deeper support sits at $${sf(t.support2)} if S1 breaks.`
    : `Price ($${sf(p)}) has more room to run before hitting resistance ($${sf(t.resistance)}) at ${sf(r1Dist,1)}% above than it does before hitting support ($${sf(t.support)}) at ${sf(s1Dist,1)}% below. The stock has breathing room on the upside. S2 deeper support at $${sf(t.support2)} provides a secondary safety net if the stock pulls back.`

  return (
    <div className="space-y-4 mt-4">
      <div className="flex items-center gap-2">
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/20">Technical analysis</div>
        <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />
      </div>

      {/* Overall score */}
      <ScoreBadge score={t.technicalScore} bias={t.technicalBias} />

      {/* Pattern Detection Section */}
      {(t.candlePattern || t.chartPattern || t.gapPattern || (t.trendLines && t.trendLines.trend !== 'sideways')) && (
        <div className="space-y-2">
          <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'rgba(255,255,255,0.2)' }}>
            Detected Patterns
          </div>

          {/* Trend Structure */}
          {t.trendLines && t.trendLines.trend !== 'sideways' && (
            <div className="rounded-xl p-3" style={{
              background: t.trendLines.trend === 'uptrend' ? 'rgba(52,211,153,0.06)' : 'rgba(248,113,113,0.06)',
              border: `1px solid ${t.trendLines.trend === 'uptrend' ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'}`
            }}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-bold capitalize" style={{ color: t.trendLines.trend === 'uptrend' ? '#34d399' : '#f87171' }}>
                  {t.trendLines.trend === 'uptrend' ? '↗' : '↘'} {t.trendLines.trend}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full font-mono" style={{ background: t.trendLines.trend === 'uptrend' ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)', color: t.trendLines.trend === 'uptrend' ? '#34d399' : '#f87171' }}>
                  {t.trendLines.higherHighs && t.trendLines.higherLows ? 'HH + HL' : t.trendLines.lowerHighs && t.trendLines.lowerLows ? 'LH + LL' : 'structure'}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.55)' }}>
                {t.trendLines.trend === 'uptrend'
                  ? `The stock is making higher highs and higher lows — the textbook definition of an uptrend. Each rally exceeds the last peak, and each pullback holds above the prior trough. This is price structure buyers want to see.`
                  : `The stock is making lower highs and lower lows — a confirmed downtrend. Each rally fails below the last peak, and each selloff breaks below the prior low. Price structure is bearish until a higher low forms.`}
              </p>
              {(t.trendLines.dynamicSupport || t.trendLines.dynamicResistance) && (
                <div className="flex gap-3 mt-2">
                  {t.trendLines.dynamicSupport && (
                    <div className="text-[10px] font-mono" style={{ color: '#34d399' }}>
                      Trend support: ${t.trendLines.dynamicSupport.toFixed(2)}
                    </div>
                  )}
                  {t.trendLines.dynamicResistance && (
                    <div className="text-[10px] font-mono" style={{ color: '#f87171' }}>
                      Trend resistance: ${t.trendLines.dynamicResistance.toFixed(2)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Chart Pattern */}
          {t.chartPattern && (() => {
            const isBull = t.chartPattern.type === 'bullish'
            const col = isBull ? '#34d399' : t.chartPattern.type === 'bearish' ? '#f87171' : '#fbbf24'
            const confLabel = t.chartPattern.confidence === 'high' ? '⭐ High confidence' : t.chartPattern.confidence === 'medium' ? 'Medium confidence' : 'Low confidence'
            const whatItMeans: Record<string, string> = {
              'Double Top': 'Price tried to break the same resistance level twice and failed both times. This exhaustion pattern typically leads to a meaningful decline as bulls give up.',
              'Double Bottom': 'Price tested the same support level twice and bounced both times. Buyers defended the floor — this pattern typically leads to a sustained rally.',
              'Head & Shoulders': 'Three peaks where the middle is highest — a top reversal pattern. The "neckline" is the critical level — once broken, the pattern is confirmed and the measured target activates.',
              'Inverse Head & Shoulders': 'Three troughs where the middle is lowest — a bottom reversal. Breaking above the neckline confirms buyers have taken control from sellers.',
              'Ascending Triangle': 'Flat resistance with rising lows — buyers are getting more aggressive each dip while sellers hold the same ceiling. A breakout through resistance is the high-probability outcome.',
              'Descending Triangle': 'Flat support with falling highs — sellers are getting more aggressive each rally while buyers hold the same floor. A breakdown through support is the high-probability outcome.',
              'Bull Flag': 'A sharp up-move (the pole) followed by a tight pullback (the flag). The consolidation resets short-term overbought conditions before the trend continues. The target equals the pole length added to the breakout.',
              'Bear Flag': 'A sharp down-move (the pole) followed by a weak bounce (the flag). The bounce fails to recover meaningful ground before selling resumes. The target equals the pole length subtracted from the breakdown.',
            }
            return (
              <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${col}25` }}>
                <div className="px-3 py-2.5 flex items-center justify-between" style={{ background: `${col}10` }}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm">📊</span>
                    <span className="text-sm font-bold" style={{ color: col }}>{t.chartPattern!.name}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-mono capitalize" style={{ background: `${col}18`, color: col }}>{t.chartPattern!.type}</span>
                  </div>
                  <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.3)' }}>{confLabel}</span>
                </div>
                <div className="px-3 py-3 space-y-2.5">
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'rgba(255,255,255,0.25)' }}>What the chart is showing</div>
                    <p className="text-[11px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.7)' }}>{t.chartPattern!.description}</p>
                  </div>
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'rgba(255,255,255,0.25)' }}>What it means for {ticker}</div>
                    <p className="text-[11px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.55)' }}>
                      {whatItMeans[t.chartPattern!.name] ?? `This pattern suggests ${isBull ? 'bullish' : 'bearish'} continuation is the higher-probability outcome.`}
                    </p>
                  </div>
                  {(t.chartPattern.target || t.chartPattern.invalidation) && (
                    <div className="flex gap-4 pt-1 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                      {t.chartPattern.target && (
                        <div>
                          <div className="text-[9px] font-mono uppercase text-white/25 mb-0.5">Measured target</div>
                          <div className="text-sm font-bold font-mono" style={{ color: col }}>${t.chartPattern.target.toFixed(2)}</div>
                        </div>
                      )}
                      {t.chartPattern.invalidation && (
                        <div>
                          <div className="text-[9px] font-mono uppercase text-white/25 mb-0.5">Pattern breaks if</div>
                          <div className="text-sm font-bold font-mono" style={{ color: '#f87171' }}>closes {isBull ? 'below' : 'above'} ${t.chartPattern.invalidation.toFixed(2)}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })()}

          {/* Candle Pattern */}
          {t.candlePattern && (() => {
            const isBull = t.candlePattern.type === 'bullish'
            const col = isBull ? '#34d399' : t.candlePattern.type === 'bearish' ? '#f87171' : '#fbbf24'
            const strengthLabel = t.candlePattern.strength === 'strong' ? '💪 Strong' : t.candlePattern.strength === 'moderate' ? '📌 Moderate' : '💡 Weak'
            const candleMeaning: Record<string, string> = {
              'Bullish Engulfing': `For ${ticker}, this means buyers came in with overwhelming force on the most recent session, completely reversing the prior day's losses. High-volume engulfing patterns at key support levels are among the highest-probability reversal setups.`,
              'Bearish Engulfing': `For ${ticker}, this means sellers came in with force on the most recent session, wiping out the prior day's gains. Watch for follow-through — if the next session confirms with another red candle, the reversal is strengthening.`,
              'Hammer': `For ${ticker}, buyers aggressively defended lower prices during the session, pushing price back up to close near the highs. This is often the first signal of a reversal — especially meaningful when it occurs near a support level.`,
              'Shooting Star': `For ${ticker}, buyers pushed price to new highs during the session but sellers rejected the move hard, closing near the lows. This is often the first signal of exhaustion after a run-up.`,
              'Doji': `For ${ticker}, the market is undecided — open and close are virtually the same despite the session's range. This pause often precedes a directional move. The next candle's direction is the tell.`,
              'Gravestone Doji': `For ${ticker}, buyers pushed to new highs but completely surrendered by the close. This is one of the most bearish doji patterns — especially meaningful at the top of a rally.`,
              'Dragonfly Doji': `For ${ticker}, sellers pushed to new lows but buyers completely recovered by the close. This is one of the most bullish doji patterns — especially meaningful at the bottom of a decline.`,
              'Morning Star': `For ${ticker}, this three-candle sequence shows a clean handoff from sellers to buyers. The gap and small middle candle show indecision, then the strong close confirms buyers have won the session.`,
              'Evening Star': `For ${ticker}, this three-candle sequence shows a clean handoff from buyers to sellers. The gap and small middle candle show indecision at the top, then the strong close lower confirms sellers have taken control.`,
              'Three White Soldiers': `For ${ticker}, three consecutive bullish closes with each opening near the prior close is the definition of sustained buying pressure. It's hard to fake three sessions like this — the trend is real.`,
              'Three Black Crows': `For ${ticker}, three consecutive bearish closes is the definition of sustained selling pressure — no one stepped in to defend any of those sessions.`,
              'Bullish Marubozu': `For ${ticker}, a full bullish body with no wicks means buyers were in control from open to close — no hesitation. The purest form of bullish conviction in a single candle.`,
              'Bearish Marubozu': `For ${ticker}, a full bearish body with no wicks means sellers were in control from open to close — no hesitation. The purest form of bearish conviction.`,
              'Bullish Harami': `For ${ticker}, the smaller bullish candle contained within yesterday's bearish range signals that selling momentum is fading. Not a strong standalone signal — needs confirmation.`,
              'Bearish Harami': `For ${ticker}, the smaller bearish candle contained within yesterday's bullish range signals that buying momentum is fading. Watch for confirmation on the next session.`,
            }
            return (
              <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${col}25` }}>
                <div className="px-3 py-2.5 flex items-center justify-between" style={{ background: `${col}10` }}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm">🕯</span>
                    <span className="text-sm font-bold" style={{ color: col }}>{t.candlePattern!.name}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-mono capitalize" style={{ background: `${col}18`, color: col }}>{t.candlePattern!.type}</span>
                  </div>
                  <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.3)' }}>{strengthLabel}</span>
                </div>
                <div className="px-3 py-3 space-y-2.5">
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'rgba(255,255,255,0.25)' }}>What the candle is showing</div>
                    <p className="text-[11px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.7)' }}>{t.candlePattern!.description}</p>
                  </div>
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'rgba(255,255,255,0.25)' }}>What it means for {ticker}</div>
                    <p className="text-[11px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.55)' }}>
                      {candleMeaning[t.candlePattern!.name] ?? `This ${t.candlePattern!.type} pattern on ${ticker} suggests ${isBull ? 'buying pressure is present — watch for follow-through.' : 'selling pressure is present — watch for confirmation.'}`}
                    </p>
                  </div>
                  <div className="text-[10px] pt-1 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.3)' }}>
                    ⚠ Candle patterns are most reliable when they occur at key support/resistance levels or after extended moves. Always confirm with volume and the next session's price action.
                  </div>
                </div>
              </div>
            )
          })()}

          {/* Gap Pattern */}
          {t.gapPattern && (() => {
            const col = t.gapPattern.bullish ? '#34d399' : '#f87171'
            return (
              <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${col}25` }}>
                <div className="px-3 py-2.5 flex items-center gap-2" style={{ background: `${col}10` }}>
                  <span className="text-sm">{t.gapPattern!.bullish ? '⬆' : '⬇'}</span>
                  <span className="text-sm font-bold" style={{ color: col }}>
                    {t.gapPattern!.type === 'gap_up' ? 'Gap Up' : 'Gap Down'} — {t.gapPattern!.size.toFixed(1)}%
                  </span>
                  {t.gapPattern.filled && <span className="text-[10px] px-2 py-0.5 rounded-full font-mono" style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.4)' }}>filled</span>}
                  {!t.gapPattern.filled && <span className="text-[10px] px-2 py-0.5 rounded-full font-mono" style={{ background: `${col}18`, color: col }}>unfilled</span>}
                </div>
                <div className="px-3 py-3 space-y-2.5">
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'rgba(255,255,255,0.25)' }}>What happened</div>
                    <p className="text-[11px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.7)' }}>{t.gapPattern!.description}</p>
                  </div>
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'rgba(255,255,255,0.25)' }}>What it means for {ticker}</div>
                    <p className="text-[11px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.55)' }}>
                      {t.gapPattern!.filled
                        ? `The gap has been filled — price returned to the pre-gap level, which often acts as a magnet. With the gap filled, price is now free to move in the direction of the original gap with less overhead supply.`
                        : t.gapPattern!.bullish
                          ? `The unfilled gap between $${t.gapPattern!.gapLow.toFixed(2)} and $${t.gapPattern!.gapHigh.toFixed(2)} acts as strong support — most buyers who bought into the gap are still profitable and will defend it. Until the gap fills, it's a floor.`
                          : `The unfilled gap between $${t.gapPattern!.gapLow.toFixed(2)} and $${t.gapPattern!.gapHigh.toFixed(2)} acts as overhead resistance — most sellers who sold into the gap are still profitable and will use any rallies to add. Until the gap fills, it's a ceiling.`
                      }
                    </p>
                  </div>
                  <div className="flex gap-4 pt-1 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                    <div>
                      <div className="text-[9px] font-mono uppercase text-white/25 mb-0.5">Gap zone</div>
                      <div className="text-xs font-mono" style={{ color: col }}>${t.gapPattern.gapLow.toFixed(2)} – ${t.gapPattern.gapHigh.toFixed(2)}</div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* Finviz chart — with pattern annotation overlay */}
      <div>
        <div className="text-[10px] font-mono text-white/20 mb-1.5">
          Daily candlestick chart — SMA50 (blue) and SMA200 (red) overlaid.
          {t.chartPattern && ` ${t.chartPattern.name} pattern detected.`}
          {t.candlePattern && ` ${t.candlePattern.name} candle on most recent bar.`}
          {t.gapPattern && !t.gapPattern.filled && ` Unfilled gap at $${t.gapPattern.gapLow.toFixed(2)}–$${t.gapPattern.gapHigh.toFixed(2)}.`}
        </div>
        {/^(BTC|ETH|SOL|BNB|XRP|ADA|AVAX|DOGE|DOT|LINK|LTC|BCH|XLM|UNI|MATIC|ATOM|ALGO|VET|FIL|THETA)$/.test(ticker.toUpperCase()) ||
         /^[A-Z]{6}$/.test(ticker.toUpperCase()) && ['USD','EUR','GBP','JPY','AUD','CAD','NZD','CHF'].some(c => ticker.toUpperCase().startsWith(c) || ticker.toUpperCase().endsWith(c))
          ? <div className="flex items-center justify-center h-16 rounded-lg text-xs text-white/25"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
              Chart not available for {ticker} — use TradingView for forex/crypto charting
            </div>
          : (
            <div className="relative">
              <FinvizChart ticker={ticker} />
              {/* Pattern annotation overlay */}
              {(t.chartPattern || t.candlePattern || t.gapPattern) && (
                <div className="absolute top-2 left-2 right-2 flex flex-wrap gap-1.5 pointer-events-none">
                  {t.chartPattern && (
                    <div className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold font-mono backdrop-blur-sm"
                      style={{
                        background: t.chartPattern.type === 'bullish' ? 'rgba(52,211,153,0.85)' : t.chartPattern.type === 'bearish' ? 'rgba(248,113,113,0.85)' : 'rgba(251,191,36,0.85)',
                        color: '#000',
                      }}>
                      📊 {t.chartPattern.name}
                      {t.chartPattern.target && <span className="ml-1 opacity-80">→ ${t.chartPattern.target.toFixed(2)}</span>}
                    </div>
                  )}
                  {t.candlePattern && (
                    <div className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold font-mono backdrop-blur-sm"
                      style={{
                        background: t.candlePattern.type === 'bullish' ? 'rgba(52,211,153,0.85)' : t.candlePattern.type === 'bearish' ? 'rgba(248,113,113,0.85)' : 'rgba(251,191,36,0.85)',
                        color: '#000',
                      }}>
                      🕯 {t.candlePattern.name}
                    </div>
                  )}
                  {t.gapPattern && !t.gapPattern.filled && (
                    <div className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold font-mono backdrop-blur-sm"
                      style={{
                        background: t.gapPattern.bullish ? 'rgba(52,211,153,0.85)' : 'rgba(248,113,113,0.85)',
                        color: '#000',
                      }}>
                      {t.gapPattern.bullish ? '⬆' : '⬇'} Gap {t.gapPattern.size.toFixed(1)}%
                    </div>
                  )}
                  {t.trendLines && t.trendLines.trend !== 'sideways' && (
                    <div className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold font-mono backdrop-blur-sm"
                      style={{
                        background: t.trendLines.trend === 'uptrend' ? 'rgba(52,211,153,0.85)' : 'rgba(248,113,113,0.85)',
                        color: '#000',
                      }}>
                      {t.trendLines.trend === 'uptrend' ? '↗ Uptrend' : '↘ Downtrend'}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
      </div>

      {/* Indicator grid 2x2 */}
      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        <ICard title="RSI (14)">
          <RSIGauge rsi={t.rsi} />
          <Explain color={rsiColor} what={rsiWhat} means={rsiMeans} />
        </ICard>

        <ICard title="Stochastic (14,3,3)">
          <StochasticGauge k={t.stochK} d={t.stochD} signal={t.stochSignal} crossover={t.stochCrossover} />
          <Explain color={stochColor} what={stochWhat} means={stochMeans} />
        </ICard>

        <ICard title="MACD (12,26,9)">
          <MACDVisual histogram={t.macdHistogram} macdLine={t.macdLine} signalLine={t.macdSignal} crossover={t.macdCrossover} />
          <Explain color={macdColor} what={macdWhat} means={macdMeans} />
        </ICard>

        <ICard title="Bollinger bands">
          <BollingerVisual position={t.bbPosition} signal={t.bbSignal}
            upper={t.bbUpper} middle={t.bbMiddle} lower={t.bbLower} current={t.currentPrice} />
          <Explain color={bbColor} what={bbWhat} means={bbMeans} />
        </ICard>
      </div>

      {/* Moving averages */}
      <ICard title="Moving average alignment">
        <MACrossVisual goldenCross={t.goldenCross} sma50={t.sma50} sma200={t.sma200}
          ema9={t.ema9} ema20={t.ema20} ema9Cross={t.ema9CrossEma20} />
        <Explain color={maColor} what={maWhat} means={maMeans} />
      </ICard>

      {/* VWAP */}
      <ICard title="VWAP — volume weighted average price">
        <VWAPVisual vwap={t.vwap} current={t.currentPrice} priceVsVwap={t.priceVsVwap} signal={t.vwapSignal} />
        <Explain color={vwapColor} what={vwapWhat} means={vwapMeans} />
      </ICard>

      {/* OBV */}
      <ICard title="OBV — on-balance volume">
        <OBVVisual trend={t.obvTrend} divergence={t.obvDivergence} />
        <Explain color={obvColor} what={obvWhat} means={obvMeans} />
      </ICard>

      {/* Volume */}
      <ICard title="Volume">
        <VolumeBar ratio={t.volumeRatio} />
        <Explain color={volColor} what={volWhat} means={volMeans} />
      </ICard>

      {/* Support / Resistance */}
      <ICard title="Key price levels (pivot points)">
        <div className="flex justify-center mb-2">
          <KeyLevels s1={t.support} s2={t.support2} r1={t.resistance} r2={t.resistance2} current={t.currentPrice} />
        </div>
        <div className="text-[10px] text-white/25 text-center mb-2">
          S2 ${sf(t.support2)} · S1 ${sf(t.support)} · NOW ${sf(p)} · R1 ${sf(t.resistance)} · R2 ${sf(t.resistance2)}
        </div>
        <Explain color="#fbbf24" what={levelsWhat} means={levelsMeans} />
      </ICard>

      {/* Fibonacci */}
      {t.fibLevels && t.fibLevels.length > 0 && (
        <ICard title="Fibonacci retracement levels">
          <FibTable levels={t.fibLevels} current={t.currentPrice} nearest={t.nearestFibLevel} />
          <Explain color="#a78bfa" what={fibWhat} means={fibMeans} />
        </ICard>
      )}

      {/* Golden Zone Fibonacci */}
      {t.goldenZone && (
        <ICard title="Golden Zone — Institutional entry levels">
          <div className="space-y-3">
            {/* In zone alert */}
            {t.goldenZone.inGoldenZone && (
              <div className="rounded-xl px-3 py-2 text-center font-bold text-sm animate-pulse"
                style={{ background: 'rgba(251,191,36,0.12)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.35)' }}>
                ⭐ Price is currently in the Golden Zone
              </div>
            )}
            {/* Golden pocket box */}
            <div className="rounded-xl p-3" style={{ background: 'rgba(251,191,36,0.07)', border: '2px solid rgba(251,191,36,0.3)' }}>
              <div className="text-[10px] font-mono uppercase tracking-widest text-center mb-2" style={{ color: '#fbbf24' }}>
                ★ Golden Pocket (0.618–0.786) — Optimal institutional entry
              </div>
              <div className="flex justify-between items-center">
                <div className="text-center">
                  <div className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>Lower bound</div>
                  <div className="text-lg font-bold font-mono" style={{ color: '#34d399' }}>${t.goldenZone.goldenPocketLow.toFixed(2)}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] font-mono" style={{ color: '#fbbf24' }}>0.705 Golden Pocket</div>
                  <div className="text-sm font-bold font-mono" style={{ color: '#fbbf24' }}>
                    ${((t.goldenZone.goldenPocketLow + t.goldenZone.goldenPocketHigh) / 2).toFixed(2)}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>Upper bound</div>
                  <div className="text-lg font-bold font-mono" style={{ color: '#f87171' }}>${t.goldenZone.goldenPocketHigh.toFixed(2)}</div>
                </div>
              </div>
              {!t.goldenZone.inGoldenZone && (
                <div className="text-[10px] text-center mt-2" style={{ color: 'rgba(255,255,255,0.35)' }}>
                  {t.goldenZone.distToZone.toFixed(1)}% away from zone
                </div>
              )}
            </div>
            {/* All levels */}
            <div className="space-y-1">
              {t.goldenZone.levels.map(l => {
                const isPocket = l.level === 0.705
                const isBoundary = l.level === 0.618 || l.level === 0.786
                return (
                  <div key={l.level} className="flex items-center justify-between px-1 py-1 rounded-lg"
                    style={{ background: isPocket ? 'rgba(251,191,36,0.08)' : isBoundary ? 'rgba(255,255,255,0.03)' : 'transparent' }}>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono w-10 text-right" style={{ color: isPocket ? '#fbbf24' : isBoundary ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.35)' }}>
                        {(l.level * 100).toFixed(1)}%
                      </span>
                      <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.3)' }}>
                        {isPocket ? '← Golden Pocket' : isBoundary ? '← Zone boundary' : ''}
                      </span>
                    </div>
                    <span className="text-xs font-bold font-mono" style={{ color: l.type === 'support' ? '#34d399' : '#f87171' }}>
                      {isPocket ? '★ ' : ''}${l.price.toFixed(2)}
                    </span>
                  </div>
                )
              })}
            </div>
            <Explain color="#fbbf24"
              what={`The Golden Zone is the most watched retracement area in technical analysis — the 61.8% to 78.6% pullback zone where institutional buyers typically enter during uptrends. These levels aren't arbitrary: 61.8% is the golden ratio (derived from the Fibonacci sequence), and 78.6% is its square root. When a stock pulls back to this zone after a strong move, it often finds heavy buying support because so many professional traders are watching the same levels. The "Golden Pocket" specifically refers to the midpoint of this zone — the 70.5% retracement — which is where the highest probability entries tend to cluster. Swing high: $${t.goldenZone.swingHigh.toFixed(2)}. Swing low: $${t.goldenZone.swingLow.toFixed(2)}.`}
              means={t.goldenZone.inGoldenZone
                ? `${ticker} is currently trading inside the Golden Zone ($${t.goldenZone.goldenPocketLow.toFixed(2)}–$${t.goldenZone.goldenPocketHigh.toFixed(2)}). This is where institutional traders look to buy in an uptrend. If the broader trend is bullish, this zone often acts as a strong launching pad. Watch for a bullish candle pattern (engulfing, hammer, morning star) as confirmation. The 70.5% level at $${((t.goldenZone.goldenPocketLow + t.goldenZone.goldenPocketHigh) / 2).toFixed(2)} is the highest-probability entry point within the zone.`
                : `${ticker} is ${t.goldenZone.distToZone.toFixed(1)}% away from the Golden Zone. The zone sits between $${t.goldenZone.goldenPocketLow.toFixed(2)} and $${t.goldenZone.goldenPocketHigh.toFixed(2)}. ${t.goldenZone.trending === 'up' ? 'If price pulls back to this zone from current levels, it would represent the classic institutional buying opportunity. Watch for the stock to hold this zone on any dip.' : 'Price is currently below the zone, which means the zone is now overhead resistance. A rally back into this range would face selling pressure from traders who bought higher.'}`}
            />
          </div>
        </ICard>
      )}

      {/* ATR */}
      {t.atr14 != null && t.atr14 > 0 && (
        <ICard title="ATR — Average True Range (14)">
          <div className="flex items-center justify-between mb-3">
            <div className="text-center">
              <div className="text-2xl font-bold font-mono" style={{ color: t.atrSignal === 'high_volatility' ? '#f87171' : t.atrSignal === 'low_volatility' ? '#34d399' : '#fbbf24' }}>
                ${sf(t.atr14!)}
              </div>
              <div className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>{sf(t.atrPct!, 1)}% of price</div>
            </div>
            <div className="text-right space-y-1">
              <div className="text-[10px] font-mono" style={{ color: 'rgba(248,113,113,0.8)' }}>2× ATR stop: ${sf(t.stopLossATR!)}</div>
              <div className="text-[10px] font-mono" style={{ color: 'rgba(52,211,153,0.8)' }}>3× ATR target: ${sf(t.takeProfitATR!)}</div>
            </div>
          </div>
          <Explain color="#fbbf24"
            what="ATR measures how much a stock moves on a typical day, calculated as the average of the true range (high minus low, accounting for overnight gaps) over 14 periods. It normalizes volatility into a dollar and percentage figure that is directly comparable across stocks."
            means={t.atrSignal === 'high_volatility'
              ? `At ${sf(t.atrPct!, 1)}% of the stock price, this is high volatility. Stops need to be wider to avoid being shaken out by normal price noise. The ATR-derived stop at $${sf(t.stopLossATR!)} gives the trade room to breathe — a tighter stop will likely be triggered by routine daily fluctuation rather than a genuine trend change.`
              : t.atrSignal === 'low_volatility'
              ? `At ${sf(t.atrPct!, 1)}% of the stock price, this is unusually low volatility — a Bollinger squeeze may be forming. Low ATR periods often precede large directional moves. Positions can be sized larger because stops can be set tighter without being prematurely triggered.`
              : `Volatility is at normal levels. The standard 2× ATR stop ($${sf(t.stopLossATR!)}) and 3× ATR target ($${sf(t.takeProfitATR!)}) provide a reasonable 1.5:1 risk/reward framework appropriate for the stock's typical price behavior.`
            }
          />
        </ICard>
      )}

      {/* Williams %R */}
      {t.williamsR != null && (
        <ICard title="Williams %R (14)">
          <div className="flex flex-col items-center mb-3">
            <svg width="200" height="40" viewBox="0 0 200 40">
              <rect x="10" y="14" width="180" height="12" rx="3" fill="rgba(255,255,255,0.05)" />
              <rect x="10" y="14" width="36" height="12" rx="3" fill="rgba(52,211,153,0.15)" />
              <rect x="154" y="14" width="36" height="12" rx="3" fill="rgba(248,113,113,0.15)" />
              <text x="28" y="11" fontSize="8" fill="rgba(52,211,153,0.6)" textAnchor="middle">Oversold</text>
              <text x="172" y="11" fontSize="8" fill="rgba(248,113,113,0.6)" textAnchor="middle">Overbought</text>
              <text x="10" y="36" fontSize="8" fill="rgba(255,255,255,0.25)">-100</text>
              <text x="190" y="36" fontSize="8" fill="rgba(255,255,255,0.25)" textAnchor="end">0</text>
              {/* Position: -100 maps to x=10, 0 maps to x=190 */}
              <circle cx={10 + ((t.williamsR! + 100) / 100) * 180} cy="20" r="6"
                fill={t.williamsSignal === 'overbought' ? '#f87171' : t.williamsSignal === 'oversold' ? '#34d399' : '#fbbf24'} />
            </svg>
            <div className="text-lg font-bold font-mono mt-1" style={{ color: t.williamsSignal === 'overbought' ? '#f87171' : t.williamsSignal === 'oversold' ? '#34d399' : '#fbbf24' }}>
              {sf(t.williamsR!, 1)} — {t.williamsSignal}
            </div>
          </div>
          <Explain color="#60a5fa"
            what="Williams %R is a momentum oscillator ranging from -100 to 0 that measures where the closing price sits relative to the high-low range over 14 periods. Near 0 means the stock closed near its recent high (overbought). Near -100 means it closed near its recent low (oversold)."
            means={t.williamsSignal === 'overbought'
              ? `At ${sf(t.williamsR!, 1)}, Williams %R confirms what RSI may also be showing — the stock has been consistently closing near its recent highs. Combined with a high RSI and CCI, this triple oscillator agreement is a strong overbought signal. Consider tightening stops or reducing position size.`
              : t.williamsSignal === 'oversold'
              ? `At ${sf(t.williamsR!, 1)}, Williams %R shows the stock has been consistently closing near its recent lows. When multiple oscillators (RSI, CCI, Williams %R) all confirm oversold simultaneously, the probability of at least a short-term bounce increases meaningfully.`
              : `Williams %R at ${sf(t.williamsR!, 1)} is in neutral territory — the stock is not at an extreme. This neither confirms nor contradicts the directional thesis.`
            }
          />
        </ICard>
      )}

      {/* CCI */}
      {t.cci != null && (
        <ICard title="CCI — Commodity Channel Index (20)">
          <div className="flex items-center gap-3 mb-3">
            <div className="flex-1 h-3 rounded-full overflow-hidden relative" style={{ background: 'rgba(255,255,255,0.05)' }}>
              <div className="absolute left-1/2 top-0 bottom-0 w-px" style={{ background: 'rgba(255,255,255,0.15)' }} />
              <div className="h-full rounded-full absolute"
                style={{
                  width: `${Math.min(Math.abs(t.cci!) / 200 * 50, 50)}%`,
                  left: t.cci! >= 0 ? '50%' : `${50 - Math.min(Math.abs(t.cci!) / 200 * 50, 50)}%`,
                  background: t.cciSignal === 'overbought' ? '#f87171' : t.cciSignal === 'oversold' ? '#34d399' : '#fbbf24',
                }} />
            </div>
            <div className="text-lg font-bold font-mono w-16 text-right" style={{ color: t.cciSignal === 'overbought' ? '#f87171' : t.cciSignal === 'oversold' ? '#34d399' : '#fbbf24' }}>
              {sf(t.cci!, 0)}
            </div>
          </div>
          <Explain color="#a78bfa"
            what="CCI (Commodity Channel Index) measures how far the current typical price (high+low+close÷3) is from its 20-period average, normalized by mean deviation. Readings above +100 indicate the stock is well above its recent average price. Below -100 indicates it's well below."
            means={t.cciSignal === 'overbought'
              ? `CCI at ${sf(t.cci!, 0)} is firmly in overbought territory (above +100). This is a third oscillator confirming what RSI and Williams %R may also be showing. Institutions use CCI to time exits from extended rallies. A CCI reversal from these levels has historically preceded mean reversion moves.`
              : t.cciSignal === 'oversold'
              ? `CCI at ${sf(t.cci!, 0)} is in oversold territory (below -100). The stock's typical price has deviated significantly below its recent average. When fundamental signals remain intact and CCI reaches these extremes, it often signals a price that has overshot to the downside.`
              : `CCI at ${sf(t.cci!, 0)} shows the stock trading close to its recent price average. No extremes detected.`
            }
          />
        </ICard>
      )}

      {/* Ichimoku Cloud */}
      {t.ichimokuSignal && t.ichimokuSignal !== 'unknown' && (
        <ICard title="Ichimoku Cloud">
          <div className="flex items-center gap-4 mb-3">
            <div className="flex-1">
              <div className="text-base font-bold font-mono mb-1" style={{ color: t.ichimokuSignal === 'above_cloud' ? '#34d399' : t.ichimokuSignal === 'below_cloud' ? '#f87171' : '#fbbf24' }}>
                {(t.ichimokuSignal ?? '').replace(/_/g, ' ').toUpperCase()}
              </div>
              {t.ichimokuCross && t.ichimokuCross !== 'none' && (
                <div className="text-[10px] font-mono" style={{ color: t.ichimokuCross === 'bullish' ? '#34d399' : '#f87171' }}>
                  ⚡ TK {t.ichimokuCross} cross detected
                </div>
              )}
            </div>
            <div className="text-right text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>
              <div>Tenkan: ${sf(t.ichimokuTenkan!)}</div>
              <div>Kijun: ${sf(t.ichimokuKijun!)}</div>
            </div>
          </div>
          <Explain color="#34d399"
            what="Ichimoku Cloud (Ichimoku Kinko Hyo) is one of the most comprehensive single indicators in technical analysis. It shows trend direction, momentum, and support/resistance simultaneously. The 'cloud' (Kumo) is built from two span lines; when price is above the cloud the trend is bullish, below it is bearish, inside is neutral/indecisive. The Tenkan-sen (9-period) and Kijun-sen (26-period) midpoints act as moving averages."
            means={t.ichimokuSignal === 'above_cloud'
              ? `The stock is trading above the Ichimoku Cloud — this is structurally bullish on this timeframe. Cloud position is the most reliable single piece of information from this indicator because it requires sustained price action over 26+ periods to establish. A TK cross (Tenkan crossing above Kijun) while above the cloud is a high-conviction buy signal used by institutional traders.${t.ichimokuCross === 'bullish' ? ' A bullish TK cross is currently present — this combination is one of the strongest technical buy signals available.' : ''}`
              : t.ichimokuSignal === 'below_cloud'
              ? `The stock is trading below the Ichimoku Cloud — this is structurally bearish. The cloud now acts as overhead resistance. Price needs to break through and close above the cloud on high volume to invalidate the bearish structure. Until then, rallies to the cloud bottom are selling opportunities for technical traders.${t.ichimokuCross === 'bearish' ? ' A bearish TK cross is present, adding further confirmation to the bearish stance.' : ''}`
              : `Price is inside the Ichimoku Cloud — this is a neutral, indecisive zone. The stock is in transition between a bullish and bearish regime. Wait for a decisive close outside the cloud before committing to a directional trade.`
            }
          />
        </ICard>
      )}

      {/* ROC / Momentum */}
      {t.roc10 != null && (
        <ICard title="ROC — Rate of Change / Momentum">
          <div className="grid grid-cols-2 gap-3 mb-3">
            {[
              { label: 'ROC 10-period', val: t.roc10!, color: t.roc10! >= 0 ? '#34d399' : '#f87171' },
              { label: 'ROC 20-period', val: t.roc20!, color: t.roc20! >= 0 ? '#34d399' : '#f87171' },
            ].map(({ label, val, color }) => (
              <div key={label} className="text-center p-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)' }}>
                <div className="text-xl font-bold font-mono" style={{ color }}>{val >= 0 ? '+' : ''}{sf(val, 1)}%</div>
                <div className="text-[9px] font-mono" style={{ color: 'rgba(255,255,255,0.3)' }}>{label}</div>
              </div>
            ))}
          </div>
          <div className="text-[10px] font-mono mb-2 text-center" style={{ color: t.rocSignal === 'accelerating' ? '#34d399' : t.rocSignal === 'decelerating' ? '#f87171' : '#fbbf24' }}>
            Momentum: {(t.rocSignal ?? 'neutral').toUpperCase()}
          </div>
          <Explain color="#60a5fa"
            what="Rate of Change (ROC) measures the percentage change in price over a set number of periods. Unlike RSI which measures relative strength, ROC measures the raw speed of price change. Momentum is the actual dollar difference between the current price and the price 10 periods ago."
            means={t.rocSignal === 'accelerating'
              ? `10-period ROC (${sf(t.roc10!, 1)}%) is stronger than 20-period ROC (${sf(t.roc20!, 1)}%) — momentum is accelerating. The stock is moving faster in the recent period than the medium-term period. Accelerating momentum into an oversold zone is often the strongest buy signal combination: the selling is slowing while the potential energy for a bounce is building.`
              : t.rocSignal === 'decelerating'
              ? `10-period ROC (${sf(t.roc10!, 1)}%) is weaker than 20-period ROC (${sf(t.roc20!, 1)}%) — momentum is decelerating. The stock may be running out of steam. Even if RSI is not yet in overbought territory, decelerating momentum warns that the move may be exhausting. This is a signal to tighten stops on long positions.`
              : `ROC shows consistent momentum across both timeframes. No significant acceleration or deceleration detected.`
            }
          />
        </ICard>
      )}

      {/* Relative Strength vs Sector */}
      {t.relStrengthVsSector != null && t.relStrengthSignal !== 'unknown' && (
        <ICard title="Relative Strength vs Sector">
          <div className="flex items-center justify-center gap-4 mb-3">
            <div className="text-center">
              <div className="text-2xl font-bold font-mono" style={{ color: t.relStrengthVsSector! > 0 ? '#34d399' : t.relStrengthVsSector! < 0 ? '#f87171' : '#fbbf24' }}>
                {t.relStrengthVsSector! >= 0 ? '+' : ''}{sf(t.relStrengthVsSector!, 1)}%
              </div>
              <div className="text-[10px] font-mono" style={{ color: 'rgba(255,255,255,0.35)' }}>vs sector this period</div>
            </div>
            <div className="text-base font-bold font-mono" style={{ color: t.relStrengthSignal === 'outperforming' ? '#34d399' : t.relStrengthSignal === 'underperforming' ? '#f87171' : '#fbbf24' }}>
              {(t.relStrengthSignal ?? '').toUpperCase()}
            </div>
          </div>
          <Explain color="#34d399"
            what="Relative strength compares this stock's price performance to its sector ETF over the same period. A stock that's up 2% when its sector is up 8% is actually underperforming despite the positive return — it's losing ground to its peers. Conversely, a stock down 2% when its sector is down 10% is showing relative strength despite the loss."
            means={t.relStrengthSignal === 'outperforming'
              ? `This stock is outperforming its sector by ${sf(t.relStrengthVsSector!, 1)}% this period. Relative outperformance is often a precursor to continued leadership — institutional money tends to rotate toward sector leaders. A bullish thesis here is strengthened by this data because the stock is not just riding sector momentum, it's beating it.`
              : t.relStrengthSignal === 'underperforming'
              ? `This stock is underperforming its sector by ${Math.abs(t.relStrengthVsSector!).toFixed(1)}% this period — this is a red flag even if the absolute return appears positive. Consistent underperformance relative to sector peers suggests institutional rotation away from this name. The Devil's Advocate would correctly cite this as evidence of hidden weakness.`
              : `Relative performance is inline with the sector — the stock is moving with its peers rather than diverging. No signal either way.`
            }
          />
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

      {/* Data transparency note */}
      <p className="text-[10px] font-mono leading-relaxed px-1"
        style={{ color: 'rgba(255,255,255,0.2)' }}>
        Moving average values (SMA50, SMA200) may differ slightly from other platforms such as TradingView.
        This is due to differences in how historical prices are adjusted for splits and dividends — not a calculation error.
        RSI, MACD, and signal direction are unaffected and remain accurate.
      </p>
    </div>
  )
}
