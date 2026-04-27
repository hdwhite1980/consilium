'use client'

// =============================================================
// app/components/IntradayCharts.tsx
//
// Multi-timeframe SVG candlestick chart for /analyze page.
// Tabs: 5min, 15min, 1H. Renders with no external chart libs.
//
// Overlays:
//   - VWAP (orange dashed)
//   - EMA 9 (cyan)
//   - EMA 20 (purple)
//   - Bollinger Bands (faint upper/lower envelope)
//
// Annotations:
//   - Patterns detected at THIS chart's timeframe (highlighted)
//   - Patterns detected during the original Council analysis (faded reference)
//   - Support/resistance levels as horizontal dashed lines
//
// No AI signals. No buy/sell arrows. Pure visualization to help
// the user read the chart themselves.
// =============================================================

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { TrendingUp, TrendingDown, Activity, Loader2 } from 'lucide-react'

// =============================================================
// Types (mirror the API response)
// =============================================================

interface AlpacaBar {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

interface CandlePattern {
  name: string
  type: 'bullish' | 'bearish' | 'neutral'
  strength: 'strong' | 'moderate' | 'weak'
  description: string
}

interface ChartPattern {
  name: string
  type: 'bullish' | 'bearish' | 'neutral'
  target: number | null
  invalidation: number | null
  description: string
  confidence: 'high' | 'medium' | 'low'
}

interface IntradayChartData {
  ticker: string
  resolution: string
  bars: AlpacaBar[]
  overlays: {
    vwap: number[]
    ema9: number[]
    ema20: number[]
    bbMiddle: (number | null)[]
    bbUpper: (number | null)[]
    bbLower: (number | null)[]
  }
  patterns: {
    candle: CandlePattern | null
    chart: ChartPattern | null
  }
  levels: {
    support: number[]
    resistance: number[]
  }
  meta: {
    barCount: number
    fetchedAt: string
  }
  error?: string
}

interface IntradayChartsProps {
  ticker: string
  // Patterns from the original Council analysis (different timeframe — shown as reference)
  analysisPatterns?: {
    candle?: CandlePattern | null
    chart?: ChartPattern | null
  }
}

type Resolution = '5Min' | '15Min' | '1Hour'

const RESOLUTIONS: { key: Resolution; label: string; description: string }[] = [
  { key: '5Min',  label: '5m',  description: 'Last 2 days, 5-min bars'  },
  { key: '15Min', label: '15m', description: 'Last 5 days, 15-min bars' },
  { key: '1Hour', label: '1H',  description: 'Last 15 days, hourly bars' },
]

// =============================================================
// Color palette (matches existing TechnicalCharts.tsx)
// =============================================================

const COLORS = {
  bullish: '#34d399',
  bearish: '#f87171',
  neutral: '#fbbf24',
  vwap: '#fb923c',     // orange — VWAP
  ema9: '#60a5fa',     // blue
  ema20: '#a78bfa',    // purple
  bbBand: 'rgba(167,139,250,0.15)',
  support: '#34d399',  // greenish
  resistance: '#f87171', // reddish
  axis: 'rgba(255,255,255,0.15)',
  text: 'rgba(255,255,255,0.5)',
}

// =============================================================
// Format helpers
// =============================================================

const fmt = (n: number, decimals = 2): string => {
  if (!Number.isFinite(n)) return '—'
  return n.toFixed(decimals)
}

const fmtPct = (n: number): string => {
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

const fmtTime = (iso: string): string => {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  } catch { return '' }
}

const fmtDate = (iso: string): string => {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}

// =============================================================
// SVG Chart component
// =============================================================

interface ChartProps {
  data: IntradayChartData
  hoveredIndex: number | null
  onHover: (idx: number | null) => void
}

function CandleChart({ data, hoveredIndex, onHover }: ChartProps) {
  const { bars, overlays, levels } = data

  // Layout
  const width = 800
  const priceHeight = 320
  const volumeHeight = 60
  const padding = { top: 10, right: 60, bottom: 20, left: 10 }
  const chartW = width - padding.left - padding.right
  const chartH = priceHeight - padding.top - padding.bottom

  if (bars.length === 0) return null

  // Compute price range (include overlays so they fit)
  let priceMin = Infinity, priceMax = -Infinity
  for (const b of bars) {
    if (b.l < priceMin) priceMin = b.l
    if (b.h > priceMax) priceMax = b.h
  }
  for (const v of overlays.vwap) {
    if (v < priceMin) priceMin = v
    if (v > priceMax) priceMax = v
  }
  for (let i = 0; i < overlays.bbUpper.length; i++) {
    const u = overlays.bbUpper[i]
    const l = overlays.bbLower[i]
    if (u !== null && u > priceMax) priceMax = u
    if (l !== null && l < priceMin) priceMin = l
  }
  // Add 2% padding to price range
  const priceRange = priceMax - priceMin
  priceMin -= priceRange * 0.02
  priceMax += priceRange * 0.02

  // Volume range
  const volumes = bars.map(b => b.v)
  const volMax = Math.max(...volumes, 1)

  // Coordinate helpers
  const xForIndex = (i: number) => padding.left + (i / (bars.length - 1 || 1)) * chartW
  const yForPrice = (p: number) => padding.top + ((priceMax - p) / (priceMax - priceMin)) * chartH

  // Candle width (with small gap between candles)
  const barSpacing = chartW / Math.max(bars.length, 1)
  const candleWidth = Math.max(1, Math.min(barSpacing * 0.7, 12))

  // Gridlines (5 horizontal price levels)
  const gridLines: { y: number; price: number }[] = []
  for (let i = 0; i <= 4; i++) {
    const price = priceMin + (priceMax - priceMin) * (i / 4)
    gridLines.push({ y: yForPrice(price), price })
  }

  // X-axis time labels (4-5 evenly spaced)
  const xLabels: { x: number; label: string }[] = []
  const step = Math.max(1, Math.floor(bars.length / 5))
  for (let i = 0; i < bars.length; i += step) {
    xLabels.push({
      x: xForIndex(i),
      label: data.resolution === '1Hour' ? fmtDate(bars[i].t) : fmtTime(bars[i].t),
    })
  }

  // Helper for line series
  const seriesPath = (values: (number | null)[]): string => {
    let d = ''
    let started = false
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      if (v === null || !Number.isFinite(v)) {
        started = false
        continue
      }
      const x = xForIndex(i)
      const y = yForPrice(v)
      d += started ? ` L ${x.toFixed(1)} ${y.toFixed(1)}` : `M ${x.toFixed(1)} ${y.toFixed(1)}`
      started = true
    }
    return d
  }

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${priceHeight + volumeHeight + 40}`}
         onMouseLeave={() => onHover(null)}>

      {/* Background */}
      <rect x={0} y={0} width={width} height={priceHeight + volumeHeight + 40} fill="transparent" />

      {/* === PRICE PANEL === */}

      {/* Horizontal gridlines */}
      {gridLines.map((g, i) => (
        <g key={i}>
          <line x1={padding.left} y1={g.y} x2={width - padding.right} y2={g.y}
                stroke={COLORS.axis} strokeDasharray="2,3" strokeWidth={0.5} />
          <text x={width - padding.right + 4} y={g.y + 3} fontSize={9} fill={COLORS.text} fontFamily="monospace">
            ${fmt(g.price)}
          </text>
        </g>
      ))}

      {/* Bollinger band envelope */}
      <path d={seriesPath(overlays.bbUpper)} stroke="none" fill="none" />
      <path d={seriesPath(overlays.bbLower)} stroke="none" fill="none" />
      {/* Filled BB area */}
      {overlays.bbUpper.length > 0 && (
        <path
          d={(() => {
            const upper = seriesPath(overlays.bbUpper)
            const lower = overlays.bbLower
              .map((v, i) => v !== null && Number.isFinite(v) ? `L ${xForIndex(i).toFixed(1)} ${yForPrice(v).toFixed(1)}` : null)
              .filter(s => s !== null)
              .reverse()
              .join(' ')
            // Convert to Z-closed shape
            return upper + ' ' + lower.replace(/^L/, 'L') + ' Z'
          })()}
          fill={COLORS.bbBand}
          stroke="none"
        />
      )}

      {/* Support/resistance horizontal dashed lines */}
      {levels.support.slice(0, 2).map((p, i) => (
        <g key={`s-${i}`}>
          <line x1={padding.left} y1={yForPrice(p)} x2={width - padding.right} y2={yForPrice(p)}
                stroke={COLORS.support} strokeDasharray="6,3" strokeWidth={0.8} opacity={0.6} />
          <text x={padding.left + 4} y={yForPrice(p) - 2} fontSize={8} fill={COLORS.support} fontFamily="monospace" opacity={0.8}>
            S ${fmt(p)}
          </text>
        </g>
      ))}
      {levels.resistance.slice(0, 2).map((p, i) => (
        <g key={`r-${i}`}>
          <line x1={padding.left} y1={yForPrice(p)} x2={width - padding.right} y2={yForPrice(p)}
                stroke={COLORS.resistance} strokeDasharray="6,3" strokeWidth={0.8} opacity={0.6} />
          <text x={padding.left + 4} y={yForPrice(p) - 2} fontSize={8} fill={COLORS.resistance} fontFamily="monospace" opacity={0.8}>
            R ${fmt(p)}
          </text>
        </g>
      ))}

      {/* Candles */}
      {bars.map((b, i) => {
        const x = xForIndex(i)
        const isUp = b.c >= b.o
        const color = isUp ? COLORS.bullish : COLORS.bearish
        const yHigh = yForPrice(b.h)
        const yLow = yForPrice(b.l)
        const yOpen = yForPrice(b.o)
        const yClose = yForPrice(b.c)
        const bodyTop = Math.min(yOpen, yClose)
        const bodyHeight = Math.max(1, Math.abs(yClose - yOpen))
        const isHovered = hoveredIndex === i

        return (
          <g key={i}>
            {/* Wick */}
            <line x1={x} y1={yHigh} x2={x} y2={yLow} stroke={color} strokeWidth={1} />
            {/* Body */}
            <rect
              x={x - candleWidth / 2}
              y={bodyTop}
              width={candleWidth}
              height={bodyHeight}
              fill={color}
              opacity={isHovered ? 1 : 0.85}
              stroke={isHovered ? 'white' : 'none'}
              strokeWidth={isHovered ? 0.5 : 0}
            />
          </g>
        )
      })}

      {/* VWAP line */}
      <path d={seriesPath(overlays.vwap)} stroke={COLORS.vwap} strokeWidth={1.5}
            strokeDasharray="3,2" fill="none" />

      {/* EMA 9 */}
      <path d={seriesPath(overlays.ema9)} stroke={COLORS.ema9} strokeWidth={1} fill="none" />

      {/* EMA 20 */}
      <path d={seriesPath(overlays.ema20)} stroke={COLORS.ema20} strokeWidth={1} fill="none" />

      {/* Hover crosshair */}
      {hoveredIndex !== null && hoveredIndex >= 0 && hoveredIndex < bars.length && (
        <line
          x1={xForIndex(hoveredIndex)}
          y1={padding.top}
          x2={xForIndex(hoveredIndex)}
          y2={priceHeight - padding.bottom}
          stroke="rgba(255,255,255,0.3)"
          strokeWidth={0.5}
          strokeDasharray="2,2"
        />
      )}

      {/* Mouse-tracking overlay (transparent rect for hover detection) */}
      <rect
        x={padding.left}
        y={padding.top}
        width={chartW}
        height={chartH}
        fill="transparent"
        onMouseMove={(e) => {
          const svg = (e.target as SVGElement).ownerSVGElement
          if (!svg) return
          const rect = svg.getBoundingClientRect()
          const xRel = ((e.clientX - rect.left) / rect.width) * width
          const idx = Math.round(((xRel - padding.left) / chartW) * (bars.length - 1))
          if (idx >= 0 && idx < bars.length) onHover(idx)
        }}
      />

      {/* X-axis labels (between price and volume panels) */}
      {xLabels.map((l, i) => (
        <text key={i} x={l.x} y={priceHeight - 4} fontSize={9}
              fill={COLORS.text} fontFamily="monospace" textAnchor="middle">
          {l.label}
        </text>
      ))}

      {/* === VOLUME PANEL === */}

      <line x1={padding.left} y1={priceHeight + 5} x2={width - padding.right} y2={priceHeight + 5}
            stroke={COLORS.axis} strokeWidth={0.5} />

      {bars.map((b, i) => {
        const x = xForIndex(i)
        const isUp = b.c >= b.o
        const h = (b.v / volMax) * (volumeHeight - 10)
        return (
          <rect
            key={i}
            x={x - candleWidth / 2}
            y={priceHeight + volumeHeight - h}
            width={candleWidth}
            height={h}
            fill={isUp ? COLORS.bullish : COLORS.bearish}
            opacity={0.5}
          />
        )
      })}

      {/* Volume label */}
      <text x={padding.left + 4} y={priceHeight + 18} fontSize={9}
            fill={COLORS.text} fontFamily="monospace">
        VOL
      </text>

    </svg>
  )
}

// =============================================================
// Hovered candle info display
// =============================================================

function HoverInfo({ data, hoveredIndex }: { data: IntradayChartData; hoveredIndex: number | null }) {
  if (hoveredIndex === null || hoveredIndex < 0 || hoveredIndex >= data.bars.length) {
    // Show last bar info as default
    if (data.bars.length === 0) return null
    hoveredIndex = data.bars.length - 1
  }
  const b = data.bars[hoveredIndex]
  const change = ((b.c - b.o) / b.o) * 100
  const isUp = b.c >= b.o
  const vwap = data.overlays.vwap[hoveredIndex]
  const ema9 = data.overlays.ema9[hoveredIndex]
  const ema20 = data.overlays.ema20[hoveredIndex]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] font-mono px-1">
      <div>
        <span className="t-text3">Time </span>
        <span className="text-white/85">{fmtDate(b.t)} {fmtTime(b.t)}</span>
      </div>
      <div>
        <span className="t-text3">O/H/L/C </span>
        <span className="text-white/85">
          ${fmt(b.o)} / ${fmt(b.h)} / ${fmt(b.l)} / ${fmt(b.c)}
        </span>
      </div>
      <div>
        <span className="t-text3">Change </span>
        <span style={{ color: isUp ? COLORS.bullish : COLORS.bearish }}>
          {fmtPct(change)}
        </span>
      </div>
      <div>
        <span className="t-text3">Vol </span>
        <span className="text-white/85">{(b.v / 1000).toFixed(0)}k</span>
      </div>
      {Number.isFinite(vwap) && (
        <div>
          <span className="t-text3">VWAP </span>
          <span style={{ color: COLORS.vwap }}>${fmt(vwap)}</span>
        </div>
      )}
      {Number.isFinite(ema9) && (
        <div>
          <span className="t-text3">EMA9 </span>
          <span style={{ color: COLORS.ema9 }}>${fmt(ema9)}</span>
        </div>
      )}
      {Number.isFinite(ema20) && (
        <div>
          <span className="t-text3">EMA20 </span>
          <span style={{ color: COLORS.ema20 }}>${fmt(ema20)}</span>
        </div>
      )}
    </div>
  )
}

// =============================================================
// Pattern annotation cards
// =============================================================

function PatternCard({
  candle,
  chart,
  source,
}: {
  candle: CandlePattern | null | undefined
  chart: ChartPattern | null | undefined
  source: 'this' | 'analysis'
}) {
  if (!candle && !chart) {
    return null
  }

  const sourceColor = source === 'this' ? '#a78bfa' : 'rgba(148,163,184,0.6)'
  const sourceLabel = source === 'this' ? 'AT THIS TIMEFRAME' : 'FROM ANALYSIS (different timeframe)'
  const opacity = source === 'this' ? 1 : 0.65

  const typeColor = (t: string) =>
    t === 'bullish' ? COLORS.bullish : t === 'bearish' ? COLORS.bearish : COLORS.neutral

  return (
    <div className="rounded-lg p-2.5 space-y-2"
         style={{
           background: 'var(--surface2)',
           border: `1px solid ${source === 'this' ? 'rgba(167,139,250,0.25)' : 'var(--border)'}`,
           opacity,
         }}>
      <div className="text-[9px] font-mono uppercase tracking-widest" style={{ color: sourceColor }}>
        {sourceLabel}
      </div>
      {candle && (
        <div>
          <div className="flex items-center gap-1.5 mb-0.5">
            {candle.type === 'bullish' && <TrendingUp size={10} style={{ color: typeColor(candle.type) }} />}
            {candle.type === 'bearish' && <TrendingDown size={10} style={{ color: typeColor(candle.type) }} />}
            {candle.type === 'neutral' && <Activity size={10} style={{ color: typeColor(candle.type) }} />}
            <span className="text-[11px] font-semibold" style={{ color: typeColor(candle.type) }}>
              {candle.name}
            </span>
            <span className="text-[9px] t-text3 font-mono">
              ({candle.strength})
            </span>
          </div>
          <p className="text-[10px] t-text3 leading-relaxed">{candle.description}</p>
        </div>
      )}
      {chart && (
        <div>
          <div className="flex items-center gap-1.5 mb-0.5">
            {chart.type === 'bullish' && <TrendingUp size={10} style={{ color: typeColor(chart.type) }} />}
            {chart.type === 'bearish' && <TrendingDown size={10} style={{ color: typeColor(chart.type) }} />}
            {chart.type === 'neutral' && <Activity size={10} style={{ color: typeColor(chart.type) }} />}
            <span className="text-[11px] font-semibold" style={{ color: typeColor(chart.type) }}>
              {chart.name}
            </span>
            <span className="text-[9px] t-text3 font-mono">
              ({chart.confidence} conf)
            </span>
          </div>
          <p className="text-[10px] t-text3 leading-relaxed mb-1">{chart.description}</p>
          {(chart.target !== null || chart.invalidation !== null) && (
            <div className="flex gap-3 text-[9px] font-mono">
              {chart.target !== null && (
                <span><span className="t-text3">Target: </span><span style={{ color: COLORS.bullish }}>${fmt(chart.target)}</span></span>
              )}
              {chart.invalidation !== null && (
                <span><span className="t-text3">Invalidation: </span><span style={{ color: COLORS.bearish }}>${fmt(chart.invalidation)}</span></span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// =============================================================
// Main component
// =============================================================

export default function IntradayCharts({ ticker, analysisPatterns }: IntradayChartsProps) {
  const [resolution, setResolution] = useState<Resolution>('15Min')
  const [data, setData] = useState<IntradayChartData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const cacheRef = useRef<Map<string, IntradayChartData>>(new Map())

  // Fetch data when resolution or ticker changes
  useEffect(() => {
    let abort = false
    const cacheKey = `${ticker}:${resolution}`
    const cached = cacheRef.current.get(cacheKey)
    if (cached) {
      setData(cached)
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    setData(null)

    fetch(`/api/intraday-bars?ticker=${encodeURIComponent(ticker)}&resolution=${resolution}`, {
      credentials: 'include',
    })
      .then(async (res) => {
        const body = await res.json()
        if (abort) return
        if (!res.ok) {
          setError(body?.error || `Request failed (${res.status})`)
          return
        }
        if (body.error) {
          setError(body.error)
          setData(null)
          return
        }
        cacheRef.current.set(cacheKey, body)
        setData(body)
      })
      .catch((e) => {
        if (abort) return
        setError(e instanceof Error ? e.message.slice(0, 200) : 'Network error')
      })
      .finally(() => {
        if (!abort) setLoading(false)
      })

    return () => { abort = true }
  }, [ticker, resolution])

  // Reset cache when ticker changes
  useEffect(() => {
    cacheRef.current.clear()
    setHoveredIndex(null)
  }, [ticker])

  const summary = useMemo(() => {
    if (!data || data.bars.length === 0) return null
    const first = data.bars[0]
    const last = data.bars[data.bars.length - 1]
    const change = ((last.c - first.o) / first.o) * 100
    return {
      first: first.o,
      last: last.c,
      change,
      high: Math.max(...data.bars.map(b => b.h)),
      low: Math.min(...data.bars.map(b => b.l)),
    }
  }, [data])

  return (
    <div className="rounded-2xl border p-4 space-y-3"
         style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>

      {/* Header: tabs + summary */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1">
          <span className="text-xs font-semibold mr-2">Intraday</span>
          {RESOLUTIONS.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setResolution(r.key)}
              title={r.description}
              disabled={loading}
              className="px-2.5 py-1 rounded text-[10px] font-mono transition-all hover:opacity-80 disabled:opacity-50"
              style={{
                background: resolution === r.key ? 'rgba(167,139,250,0.18)' : 'var(--surface2)',
                color: resolution === r.key ? '#a78bfa' : 'var(--text3)',
                border: `1px solid ${resolution === r.key ? 'rgba(167,139,250,0.35)' : 'rgba(255,255,255,0.08)'}`,
              }}>
              {r.label}
            </button>
          ))}
        </div>

        {summary && (
          <div className="text-[10px] font-mono flex items-center gap-3">
            <span><span className="t-text3">Range </span>${fmt(summary.low)}–${fmt(summary.high)}</span>
            <span style={{ color: summary.change >= 0 ? COLORS.bullish : COLORS.bearish }}>
              {fmtPct(summary.change)}
            </span>
          </div>
        )}
      </div>

      {/* Chart canvas */}
      <div className="rounded-lg overflow-hidden"
           style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}>
        {loading && (
          <div className="flex items-center justify-center h-[420px]">
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" style={{ color: '#a78bfa' }} />
              <span className="text-xs t-text3">Loading {resolution} bars...</span>
            </div>
          </div>
        )}
        {!loading && error && (
          <div className="flex items-center justify-center h-[420px] px-4">
            <div className="text-center">
              <div className="text-xs t-text3 mb-1">Could not load chart</div>
              <div className="text-[10px] font-mono" style={{ color: COLORS.bearish }}>{error}</div>
            </div>
          </div>
        )}
        {!loading && !error && data && data.bars.length > 0 && (
          <CandleChart data={data} hoveredIndex={hoveredIndex} onHover={setHoveredIndex} />
        )}
        {!loading && !error && data && data.bars.length === 0 && (
          <div className="flex items-center justify-center h-[420px]">
            <div className="text-xs t-text3">No bars available for {ticker}</div>
          </div>
        )}
      </div>

      {/* Hover info bar */}
      {!loading && !error && data && data.bars.length > 0 && (
        <HoverInfo data={data} hoveredIndex={hoveredIndex} />
      )}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 text-[9px] font-mono t-text3 px-1">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5" style={{ background: COLORS.vwap }} /> VWAP
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5" style={{ background: COLORS.ema9 }} /> EMA 9
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5" style={{ background: COLORS.ema20 }} /> EMA 20
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-2 rounded-sm" style={{ background: COLORS.bbBand }} /> Bollinger ±2σ
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0 border-t border-dashed" style={{ borderColor: COLORS.support }} /> Support
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0 border-t border-dashed" style={{ borderColor: COLORS.resistance }} /> Resistance
        </span>
      </div>

      {/* Pattern annotations */}
      {!loading && !error && data && (data.patterns.candle || data.patterns.chart) && (
        <PatternCard candle={data.patterns.candle} chart={data.patterns.chart} source="this" />
      )}

      {/* Original analysis patterns (faded, for reference) */}
      {!loading && !error && analysisPatterns && (analysisPatterns.candle || analysisPatterns.chart) && (
        <PatternCard
          candle={analysisPatterns.candle ?? null}
          chart={analysisPatterns.chart ?? null}
          source="analysis"
        />
      )}

      {/* Footer disclaimer */}
      <div className="pt-1 border-t text-[9px] font-mono t-text3 leading-relaxed"
           style={{ borderColor: 'var(--border)' }}>
        Pattern detection is descriptive, not a recommendation. Patterns at 5-min vs hourly timeframes
        tell different stories — read both. No buy/sell signals are generated from this view.
      </div>
    </div>
  )
}
