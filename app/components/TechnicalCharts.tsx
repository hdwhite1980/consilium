'use client'

import { useState } from 'react'

interface TechnicalChartsProps {
  ticker: string
  technicals: {
    rsi: number
    technicalBias: string
    technicalScore: number
    sma50: number
    sma200: number
    goldenCross: boolean
    macdHistogram: number
    bbPosition: number
    bbSignal: string
    volumeRatio: number
    support: number
    resistance: number
    currentPrice: number
  } | null
}

// ── RSI Gauge SVG ─────────────────────────────────────────────
function RSIGauge({ rsi }: { rsi: number }) {
  const angle = -90 + (rsi / 100) * 180
  const rad = (angle * Math.PI) / 180
  const cx = 80, cy = 70, r = 55
  const nx = cx + r * Math.cos(rad)
  const ny = cy + r * Math.sin(rad)
  const color = rsi >= 70 ? '#f87171' : rsi <= 30 ? '#34d399' : '#fbbf24'
  const label = rsi >= 70 ? 'Overbought' : rsi <= 30 ? 'Oversold' : 'Neutral'

  return (
    <div className="flex flex-col items-center">
      <svg width="160" height="90" viewBox="0 0 160 90">
        {/* Background arc */}
        <path d="M 25 70 A 55 55 0 0 1 135 70" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="10" strokeLinecap="round" />
        {/* Oversold zone (green) */}
        <path d="M 25 70 A 55 55 0 0 1 52 26" fill="none" stroke="rgba(52,211,153,0.3)" strokeWidth="10" strokeLinecap="round" />
        {/* Overbought zone (red) */}
        <path d="M 108 26 A 55 55 0 0 1 135 70" fill="none" stroke="rgba(248,113,113,0.3)" strokeWidth="10" strokeLinecap="round" />
        {/* Needle */}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={color} strokeWidth="2.5" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="4" fill={color} />
        {/* Labels */}
        <text x="18" y="84" fontSize="9" fill="rgba(52,211,153,0.7)" textAnchor="middle">30</text>
        <text x="80" y="18" fontSize="9" fill="rgba(255,255,255,0.3)" textAnchor="middle">50</text>
        <text x="142" y="84" fontSize="9" fill="rgba(248,113,113,0.7)" textAnchor="middle">70</text>
      </svg>
      <div className="text-center -mt-2">
        <div className="text-lg font-bold font-mono" style={{ color }}>{rsi.toFixed(1)}</div>
        <div className="text-[10px] font-mono text-white/40">{label}</div>
      </div>
    </div>
  )
}

// ── Moving Average Cross Visual ───────────────────────────────
function MACrossVisual({ goldenCross, sma50, sma200, currentPrice }: {
  goldenCross: boolean; sma50: number; sma200: number; currentPrice: number
}) {
  const color = goldenCross ? '#34d399' : '#f87171'
  const label = goldenCross ? 'Golden Cross' : 'Death Cross'
  const desc = goldenCross
    ? 'SMA50 is above SMA200 — bullish trend'
    : 'SMA50 crossed below SMA200 — bearish signal'

  // Simple line chart showing the cross
  const W = 160, H = 70
  // Simulate two converging/diverging lines
  const points50  = goldenCross
    ? [[0,55],[40,45],[80,35],[120,25],[160,18]]
    : [[0,20],[40,28],[80,38],[120,48],[160,55]]
  const points200 = goldenCross
    ? [[0,45],[40,42],[80,40],[120,42],[160,45]]
    : [[0,35],[40,38],[80,40],[120,38],[160,35]]

  const toPath = (pts: number[][]) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]} ${p[1]}`).join(' ')

  return (
    <div className="flex flex-col items-center">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* Intersection marker */}
        <circle cx="80" cy="40" r="3" fill={color} opacity="0.5" />
        {/* SMA200 line */}
        <path d={toPath(points200)} fill="none" stroke="rgba(251,191,36,0.5)" strokeWidth="1.5" strokeDasharray="4,2" />
        {/* SMA50 line */}
        <path d={toPath(points50)} fill="none" stroke={color} strokeWidth="2" />
        {/* Labels */}
        <text x="4" y="12" fontSize="8" fill={color}>SMA50</text>
        <text x="4" y="H" fontSize="8" fill="rgba(251,191,36,0.6)">
          <tspan x="4" dy={goldenCross ? "62" : "28"}>SMA200</tspan>
        </text>
      </svg>
      <div className="text-center mt-1">
        <div className="text-xs font-bold" style={{ color }}>{label}</div>
        <div className="text-[10px] text-white/35 mt-0.5 max-w-[140px] text-center leading-tight">{desc}</div>
        <div className="flex gap-2 justify-center mt-1 text-[9px] font-mono text-white/30">
          <span>50: ${sma50.toFixed(0)}</span>
          <span>200: ${sma200.toFixed(0)}</span>
        </div>
      </div>
    </div>
  )
}

// ── MACD Histogram ────────────────────────────────────────────
function MACDHistogram({ histogram }: { histogram: number }) {
  const color = histogram >= 0 ? '#34d399' : '#f87171'
  const label = histogram >= 0 ? 'Bullish momentum' : 'Bearish momentum'
  const bars = [0.3, 0.5, 0.7, 0.9, 1.0, 0.8, histogram >= 0 ? 0.6 : -0.6, histogram >= 0 ? 0.8 : -0.8, 1.0, histogram >= 0 ? 1.0 : -1.0]
  const H = 60, W = 160, barW = 13, gap = 3

  return (
    <div className="flex flex-col items-center">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* Zero line */}
        <line x1="0" y1={H/2} x2={W} y2={H/2} stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />
        {bars.map((v, i) => {
          const barH = Math.abs(v) * (H/2 - 4)
          const positive = v >= 0
          const x = i * (barW + gap) + 5
          const y = positive ? H/2 - barH : H/2
          const c = positive ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.7)'
          const isLast = i === bars.length - 1
          return <rect key={i} x={x} y={y} width={barW} height={barH}
            fill={isLast ? color : c} rx="1.5" opacity={isLast ? 1 : 0.6} />
        })}
      </svg>
      <div className="text-center mt-1">
        <div className="text-xs font-bold" style={{ color }}>{label}</div>
        <div className="text-[10px] text-white/35">histogram {histogram >= 0 ? 'positive' : 'negative'}</div>
      </div>
    </div>
  )
}

// ── Bollinger Band Position ───────────────────────────────────
function BollingerVisual({ position, signal }: { position: number; signal: string }) {
  const W = 160, H = 60
  const priceX = position * (W - 20) + 10
  const color = position > 0.8 ? '#f87171' : position < 0.2 ? '#34d399' : '#fbbf24'
  const label = position > 0.8 ? 'Near upper band' : position < 0.2 ? 'Near lower band' : 'Mid-band'

  return (
    <div className="flex flex-col items-center">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* Upper band */}
        <path d="M 10 10 Q 80 8 150 10" fill="none" stroke="rgba(248,113,113,0.4)" strokeWidth="1.5" />
        {/* Lower band */}
        <path d="M 10 50 Q 80 52 150 50" fill="none" stroke="rgba(52,211,153,0.4)" strokeWidth="1.5" />
        {/* Middle band */}
        <path d="M 10 30 Q 80 30 150 30" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeDasharray="3,2" />
        {/* Shaded area */}
        <path d="M 10 10 Q 80 8 150 10 L 150 50 Q 80 52 10 50 Z" fill="rgba(255,255,255,0.03)" />
        {/* Price dot */}
        <circle cx={priceX} cy={10 + position * 40} r="5" fill={color} />
        <line x1={priceX} y1={10 + position * 40} x2={priceX} y2={H} stroke={color} strokeWidth="1" strokeDasharray="2,2" opacity="0.4" />
        {/* Labels */}
        <text x="155" y="13" fontSize="8" fill="rgba(248,113,113,0.6)" textAnchor="start">U</text>
        <text x="155" y="53" fontSize="8" fill="rgba(52,211,153,0.6)" textAnchor="start">L</text>
      </svg>
      <div className="text-center mt-1">
        <div className="text-xs font-bold" style={{ color }}>{label}</div>
        <div className="text-[10px] text-white/35">{signal} · {(position * 100).toFixed(0)}% of band</div>
      </div>
    </div>
  )
}

// ── Volume Bar ────────────────────────────────────────────────
function VolumeBar({ ratio }: { ratio: number }) {
  const color = ratio > 1.5 ? '#fbbf24' : ratio < 0.5 ? '#94a3b8' : '#60a5fa'
  const label = ratio > 1.5 ? 'High volume' : ratio < 0.5 ? 'Low volume' : 'Average volume'
  const pct = Math.min(ratio / 3 * 100, 100)

  return (
    <div className="flex flex-col items-center w-full">
      <div className="w-full flex items-center gap-2 px-2">
        <span className="text-[10px] font-mono text-white/30 w-12 shrink-0">volume</span>
        <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
          <div className="h-full rounded-full transition-all duration-1000"
            style={{ width: `${pct}%`, background: color }} />
        </div>
        <span className="text-[10px] font-mono w-12 text-right" style={{ color }}>{ratio.toFixed(1)}x avg</span>
      </div>
      <div className="text-[10px] text-white/35 mt-1">{label}</div>
    </div>
  )
}

// ── Support / Resistance Levels ───────────────────────────────
function SupportResistance({ support, resistance, current }: { support: number; resistance: number; current: number }) {
  const W = 220, H = 60
  const range = resistance - support
  const priceX = range > 0 ? ((current - support) / range) * (W - 40) + 20 : W / 2
  const supportX = 20
  const resistX = W - 20

  return (
    <div className="flex flex-col items-center w-full">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* Track */}
        <line x1={supportX} y1={H/2} x2={resistX} y2={H/2} stroke="rgba(255,255,255,0.1)" strokeWidth="3" strokeLinecap="round" />
        {/* Support zone */}
        <circle cx={supportX} cy={H/2} r="5" fill="rgba(52,211,153,0.6)" />
        {/* Resistance zone */}
        <circle cx={resistX} cy={H/2} r="5" fill="rgba(248,113,113,0.6)" />
        {/* Current price */}
        <circle cx={Math.max(25, Math.min(priceX, W-25))} cy={H/2} r="6" fill="#fbbf24" />
        {/* Labels */}
        <text x={supportX} y={H/2 - 10} fontSize="9" fill="rgba(52,211,153,0.7)" textAnchor="middle">Support</text>
        <text x={supportX} y={H/2 + 18} fontSize="9" fill="rgba(52,211,153,0.7)" textAnchor="middle">${support.toFixed(0)}</text>
        <text x={resistX} y={H/2 - 10} fontSize="9" fill="rgba(248,113,113,0.7)" textAnchor="middle">Resistance</text>
        <text x={resistX} y={H/2 + 18} fontSize="9" fill="rgba(248,113,113,0.7)" textAnchor="middle">${resistance.toFixed(0)}</text>
        <text x={Math.max(25, Math.min(priceX, W-25))} y={H/2 - 12} fontSize="9" fill="#fbbf24" textAnchor="middle">Price</text>
      </svg>
    </div>
  )
}

// ── Finviz Chart ──────────────────────────────────────────────
function FinvizChart({ ticker }: { ticker: string }) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  // Finviz chart with technical overlays (SMA50, SMA200, volume)
  const url = `https://finviz.com/chart.ashx?t=${ticker}&ty=c&ta=1&p=d&s=l`

  if (error) {
    return (
      <div className="flex items-center justify-center h-32 rounded-lg text-xs text-white/30"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
        Chart unavailable for {ticker}
      </div>
    )
  }

  return (
    <div className="relative rounded-lg overflow-hidden" style={{ background: '#0a0d12' }}>
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center"
          style={{ background: '#0a0d12' }}>
          <div className="flex gap-1">
            {[0,1,2].map(i => (
              <span key={i} className="w-1.5 h-1.5 rounded-full thinking-dot"
                style={{ background: '#fbbf24', animationDelay: `${i * 0.15}s` }} />
            ))}
          </div>
        </div>
      )}
      <img
        src={url}
        alt={`${ticker} technical chart`}
        className="w-full rounded-lg"
        style={{ display: loaded ? 'block' : 'block', opacity: loaded ? 1 : 0, transition: 'opacity 0.3s' }}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
        referrerPolicy="no-referrer"
      />
      <div className="absolute bottom-1 right-2 text-[9px] font-mono text-white/20">
        via Finviz
      </div>
    </div>
  )
}

// ── TradingView Widget ────────────────────────────────────────
function TradingViewWidget({ ticker }: { ticker: string }) {
  return (
    <div className="rounded-lg overflow-hidden" style={{ height: 300 }}>
      <iframe
        src={`https://s.tradingview.com/widgetembed/?frameElementId=tradingview&symbol=${ticker}&interval=D&hidesidetoolbar=1&hidetoptoolbar=0&symboledit=0&saveimage=0&toolbarbg=0a0d12&theme=dark&style=1&timezone=exchange&studies=MASimple%40tv-basicstudies%2CMASimple%40tv-basicstudies&studies_overrides=%7B%7D&overrides=%7B%7D&enabled_features=%5B%5D&disabled_features=%5B%5D&locale=en`}
        style={{ width: '100%', height: '100%', border: 'none' }}
        allowTransparency={true}
        scrolling="no"
        allowFullScreen={true}
      />
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────
export default function TechnicalCharts({ ticker, technicals }: TechnicalChartsProps) {
  const [showTV, setShowTV] = useState(false)

  if (!technicals) return null

  const {
    rsi, goldenCross, sma50, sma200, macdHistogram,
    bbPosition, bbSignal, volumeRatio, support, resistance, currentPrice
  } = technicals

  return (
    <div className="space-y-4 mt-4">

      {/* Section header */}
      <div className="flex items-center gap-2">
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/25">Technical charts</div>
        <div className="flex-1 h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />
      </div>

      {/* Finviz candlestick chart */}
      <div>
        <div className="text-[10px] font-mono text-white/25 mb-1.5">
          Daily chart with SMA50 / SMA200 overlays
          <span className="ml-2 text-white/15">(shows death cross / golden cross visually)</span>
        </div>
        <FinvizChart ticker={ticker} />
      </div>

      {/* Indicator grid */}
      <div className="grid grid-cols-2 gap-3">

        {/* RSI */}
        <div className="rounded-xl p-3 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.07)' }}>
          <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-2">RSI (14)</div>
          <RSIGauge rsi={rsi} />
          <div className="text-[10px] text-white/30 mt-2 text-center leading-relaxed">
            {rsi >= 70 ? 'Stock may be overbought — could pull back soon' :
             rsi <= 30 ? 'Stock may be oversold — could bounce soon' :
             'Momentum is neutral — no extreme reading'}
          </div>
        </div>

        {/* MA Cross */}
        <div className="rounded-xl p-3 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.07)' }}>
          <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-2">
            {goldenCross ? 'Golden cross' : 'Death cross'}
          </div>
          <MACrossVisual goldenCross={goldenCross} sma50={sma50} sma200={sma200} currentPrice={currentPrice} />
          <div className="text-[10px] text-white/30 mt-2 text-center leading-relaxed">
            {goldenCross
              ? 'Short-term average above long-term — historically bullish'
              : 'Short-term average below long-term — historically bearish'}
          </div>
        </div>

        {/* MACD */}
        <div className="rounded-xl p-3 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.07)' }}>
          <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-2">MACD histogram</div>
          <MACDHistogram histogram={macdHistogram} />
          <div className="text-[10px] text-white/30 mt-2 text-center leading-relaxed">
            {macdHistogram >= 0
              ? 'Momentum trending upward — buyers in control'
              : 'Momentum trending downward — sellers in control'}
          </div>
        </div>

        {/* Bollinger */}
        <div className="rounded-xl p-3 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.07)' }}>
          <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-2">Bollinger bands</div>
          <BollingerVisual position={bbPosition} signal={bbSignal} />
          <div className="text-[10px] text-white/30 mt-2 text-center leading-relaxed">
            {bbPosition > 0.8 ? 'Price near top of range — potential resistance' :
             bbPosition < 0.2 ? 'Price near bottom of range — potential support' :
             bbSignal === 'squeeze' ? 'Bands tightening — big move may be coming' :
             'Price in middle of range — no extreme'}
          </div>
        </div>
      </div>

      {/* Volume */}
      <div className="rounded-xl p-3 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.07)' }}>
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-3">Volume</div>
        <VolumeBar ratio={volumeRatio} />
        <div className="text-[10px] text-white/30 mt-2 text-center leading-relaxed">
          {volumeRatio > 1.5
            ? 'Volume is well above average — strong conviction behind today\'s move'
            : volumeRatio < 0.5
            ? 'Volume is low — move may lack conviction'
            : 'Volume is normal — no unusual activity'}
        </div>
      </div>

      {/* Support / Resistance */}
      <div className="rounded-xl p-3 border" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.07)' }}>
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/25 mb-3">Key price levels</div>
        <SupportResistance support={support} resistance={resistance} current={currentPrice} />
        <div className="text-[10px] text-white/30 mt-2 text-center leading-relaxed">
          Support ${support.toFixed(2)} is where buyers tend to step in. Resistance ${resistance.toFixed(2)} is where sellers tend to push back.
        </div>
      </div>

      {/* TradingView live chart toggle */}
      <div>
        <button onClick={() => setShowTV(!showTV)}
          className="w-full py-2 rounded-lg text-xs font-mono transition-all hover:opacity-80"
          style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}>
          {showTV ? '▲ Hide' : '▼ Show'} TradingView live chart
        </button>
        {showTV && (
          <div className="mt-2">
            <TradingViewWidget ticker={ticker} />
          </div>
        )}
      </div>
    </div>
  )
}
