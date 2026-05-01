// ═════════════════════════════════════════════════════════════
// app/components/DeskProgress.tsx
//
// Renders the user's process-grade trend as a small sparkline-style
// line chart. Lives in the TierLadder side rail.
//
// Three states:
//   1. No trades yet → encouragement message
//   2. < 5 trades → individual dots, no trend line
//   3. >= 5 trades → trailing-5 average line + dots + caption
//
// Styles live in FloorStyles in app/invest/page.tsx.
// ═════════════════════════════════════════════════════════════

'use client'

import { useMemo } from 'react'

interface ProcessTrendPoint {
  closedAt: string
  score: number
  grade: string
  tradeId: string
}

interface ProcessTrend {
  recentTrades: ProcessTrendPoint[]
  totalReviewed: number
  trailing5Avg: number | null
  baselineAvg: number | null
  trailing5Letter: string | null
  baselineLetter: string | null
  isImproving: boolean
  isRegressing: boolean
  freshSince: string | null
}

interface Props {
  trend: ProcessTrend
}

// Compute trailing-5 averages at each point so we can draw a smooth line
function trailingAverages(trades: ProcessTrendPoint[]): Array<number | null> {
  return trades.map((_, i) => {
    if (i < 4) return null  // need 5 points for trailing-5
    const slice = trades.slice(i - 4, i + 1)
    return slice.reduce((s, t) => s + t.score, 0) / 5
  })
}

export function DeskProgress({ trend }: Props) {
  const trailing = useMemo(() => trailingAverages(trend.recentTrades), [trend.recentTrades])

  // ── Empty state ──
  if (trend.totalReviewed === 0) {
    return (
      <div className="fl-progress fl-progress-empty">
        <div className="fl-progress-head">
          <span className="fl-sg-eyebrow">desk progress</span>
        </div>
        <p className="fl-progress-empty-msg">
          Close your first trade to start tracking your process grade over time.
        </p>
      </div>
    )
  }

  // ── Few-trades state (1-4) ──
  if (trend.totalReviewed < 5) {
    return (
      <div className="fl-progress">
        <div className="fl-progress-head">
          <span className="fl-sg-eyebrow">desk progress</span>
          {trend.freshSince && <span className="fl-progress-fresh">new</span>}
        </div>
        <SparklineChart trades={trend.recentTrades} trailing={trailing} fresh={!!trend.freshSince} />
        <p className="fl-progress-caption">
          {trend.totalReviewed} of 5 reviews · trend line opens at 5
        </p>
      </div>
    )
  }

  // ── Full state ──
  const trailingLetter = trend.trailing5Letter ?? '—'
  let captionLine: React.ReactNode

  if (trend.isImproving) {
    captionLine = (
      <>
        Last 5 averaged <strong className="fl-progress-grade-good">{trailingLetter}</strong>
        {trend.baselineLetter && <> · up from {trend.baselineLetter}</>}
      </>
    )
  } else if (trend.isRegressing) {
    captionLine = (
      <>
        Last 5 averaged <strong className="fl-progress-grade-warn">{trailingLetter}</strong>
        {trend.baselineLetter && <> · down from {trend.baselineLetter}</>}
      </>
    )
  } else if (trend.baselineLetter) {
    captionLine = (
      <>
        Last 5 averaged <strong>{trailingLetter}</strong> · holding from {trend.baselineLetter}
      </>
    )
  } else {
    captionLine = <>Last 5 averaged <strong>{trailingLetter}</strong></>
  }

  return (
    <div className="fl-progress">
      <div className="fl-progress-head">
        <span className="fl-sg-eyebrow">desk progress</span>
        {trend.freshSince && <span className="fl-progress-fresh">new</span>}
      </div>
      <SparklineChart trades={trend.recentTrades} trailing={trailing} fresh={!!trend.freshSince} />
      <p className="fl-progress-caption">{captionLine}</p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// SparklineChart — pure SVG, no chart library
// ─────────────────────────────────────────────────────────────

interface SparklineProps {
  trades: ProcessTrendPoint[]
  trailing: Array<number | null>
  fresh: boolean
}

function SparklineChart({ trades, trailing, fresh }: SparklineProps) {
  if (trades.length === 0) return null

  const W = 220
  const H = 60
  const PAD_X = 8
  const PAD_Y = 6
  const innerW = W - PAD_X * 2
  const innerH = H - PAD_Y * 2

  // Y scale: 0-100 (process score) inverted (high = top)
  const yFor = (score: number) => PAD_Y + innerH - (score / 100) * innerH

  // X scale: evenly spaced points
  const xFor = (i: number) =>
    trades.length === 1 ? W / 2 : PAD_X + (i / (trades.length - 1)) * innerW

  // Trailing-5 line path (skip nulls)
  const trailingPoints = trailing
    .map((avg, i) => avg !== null ? { x: xFor(i), y: yFor(avg) } : null)
    .filter((p): p is { x: number; y: number } => p !== null)

  const trailingPath = trailingPoints.length > 1
    ? trailingPoints.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(' ')
    : null

  return (
    <svg
      className="fl-progress-svg"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Process grade trend over time"
    >
      {/* Reference lines for B (75) and C (60) — barely visible */}
      <line
        x1={PAD_X} x2={W - PAD_X}
        y1={yFor(75)} y2={yFor(75)}
        stroke="rgba(148, 163, 184, 0.08)"
        strokeWidth="1"
        strokeDasharray="2 3"
      />
      <line
        x1={PAD_X} x2={W - PAD_X}
        y1={yFor(60)} y2={yFor(60)}
        stroke="rgba(148, 163, 184, 0.08)"
        strokeWidth="1"
        strokeDasharray="2 3"
      />

      {/* Trailing-5 average line */}
      {trailingPath && (
        <path
          d={trailingPath}
          stroke="#d4a857"
          strokeWidth="1.5"
          fill="none"
          opacity="0.85"
        />
      )}

      {/* Individual trade dots */}
      {trades.map((t, i) => {
        const isLast = i === trades.length - 1
        const radius = isLast ? 3 : 2
        const fill = t.score >= 75
          ? '#10b981'
          : t.score >= 60
            ? '#d4a857'
            : 'rgba(148, 163, 184, 0.7)'
        return (
          <circle
            key={t.tradeId}
            cx={xFor(i)}
            cy={yFor(t.score)}
            r={radius}
            fill={fill}
            opacity={isLast ? 1 : 0.7}
            className={isLast && fresh ? 'fl-progress-pulse' : undefined}
          >
            <title>
              {t.grade} ({Math.round(t.score)}) · {new Date(t.closedAt).toLocaleDateString()}
            </title>
          </circle>
        )
      })}
    </svg>
  )
}
