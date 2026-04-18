'use client'

import { useState, useMemo } from 'react'

// ─────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────
const fmt$ = (n: number, d = 2) => {
  if (!isFinite(n)) return '—'
  const v = Math.abs(n)
  if (v < 100) return `${n < 0 ? '-' : ''}$${v.toFixed(d)}`
  return `${n < 0 ? '-' : ''}$${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`

// ═════════════════════════════════════════════════════════════
// 1. POSITION SIZER
// Drag the % slider, see how much of your actual balance that is.
// ═════════════════════════════════════════════════════════════
export function PositionSizerDemo({ balance = 100, maxPct = 20 }: { balance?: number; maxPct?: number }) {
  const [pct, setPct] = useState(5)
  const dollars = (pct / 100) * balance
  const stopLossPct = 15 // typical
  const dollarsAtRisk = dollars * (stopLossPct / 100)
  const totalLossPct = (dollarsAtRisk / balance) * 100

  const tone = pct <= 5 ? 'safe' : pct <= 10 ? 'caution' : 'danger'

  return (
    <div className="fs-demo">
      <div className="fs-demo-label">Your balance · <span className="mono">{fmt$(balance)}</span></div>

      <div className="fs-demo-slider-wrap">
        <input
          type="range"
          min="1"
          max={maxPct}
          step="0.5"
          value={pct}
          onChange={e => setPct(parseFloat(e.target.value))}
          className="fs-slider"
          style={{ ['--fill' as string]: `${(pct / maxPct) * 100}%` }}
        />
        <div className="fs-demo-pct-display">
          <span className="mono big">{pct.toFixed(1)}%</span>
          <span className="fs-dim">of account</span>
        </div>
      </div>

      <div className="fs-demo-grid">
        <div className="fs-demo-stat">
          <div className="fs-demo-stat-label">Position size</div>
          <div className="fs-demo-stat-val mono">{fmt$(dollars)}</div>
        </div>
        <div className="fs-demo-stat">
          <div className="fs-demo-stat-label">At 15% stop</div>
          <div className="fs-demo-stat-val mono">{fmt$(-dollarsAtRisk)}</div>
        </div>
        <div className="fs-demo-stat">
          <div className="fs-demo-stat-label">% of account</div>
          <div className={`fs-demo-stat-val mono tone-${tone}`}>{totalLossPct.toFixed(1)}%</div>
        </div>
      </div>

      <div className={`fs-demo-verdict tone-${tone}`}>
        {tone === 'safe' && "✓ Professional sizing — you can be wrong many times and still recover."}
        {tone === 'caution' && "⚠ Aggressive — a few bad trades will hurt. Only at highest conviction."}
        {tone === 'danger' && "✗ Gambling territory — a single bad trade could crater the account."}
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════
// 2. LOSS RECOVERY CURVE
// Drag the loss slider, see the recovery required.
// ═════════════════════════════════════════════════════════════
export function LossRecoveryDemo() {
  const [lossPct, setLossPct] = useState(25)
  const recoveryPct = (1 / (1 - lossPct / 100) - 1) * 100

  // Build the curve
  const points = useMemo(() => {
    const arr: Array<{ x: number; y: number }> = []
    for (let l = 0; l <= 90; l += 2) {
      const r = (1 / (1 - l / 100) - 1) * 100
      arr.push({ x: l, y: r })
    }
    return arr
  }, [])

  const W = 280
  const H = 140
  const maxR = 900
  const xScale = (v: number) => (v / 90) * W
  const yScale = (v: number) => H - Math.min(H, (v / maxR) * H)
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.x).toFixed(1)} ${yScale(p.y).toFixed(1)}`).join(' ')

  const markerX = xScale(lossPct)
  const markerY = yScale(Math.min(maxR, recoveryPct))

  const tone = lossPct < 20 ? 'safe' : lossPct < 50 ? 'caution' : 'danger'

  return (
    <div className="fs-demo">
      <div className="fs-demo-label">Drag to see the recovery curve</div>

      <div className="fs-demo-curve-wrap">
        <svg viewBox={`0 0 ${W} ${H + 20}`} className="fs-demo-svg" preserveAspectRatio="xMidYMid meet">
          {/* grid */}
          <line x1="0" y1={H} x2={W} y2={H} stroke="rgba(249,115,22,0.2)" strokeWidth="0.5" />
          <line x1="0" y1={yScale(100)} x2={W} y2={yScale(100)} stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" strokeDasharray="2 2" />
          <text x="2" y={yScale(100) - 2} fontSize="8" fill="rgba(255,255,255,0.3)" fontFamily="monospace">100%</text>
          {/* curve */}
          <path d={path} fill="none" stroke="url(#fsCurveGrad)" strokeWidth="1.5" />
          <defs>
            <linearGradient id="fsCurveGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#fbbf24" />
              <stop offset="50%" stopColor="#f97316" />
              <stop offset="100%" stopColor="#ef4444" />
            </linearGradient>
          </defs>
          {/* marker */}
          <line x1={markerX} y1={H} x2={markerX} y2={markerY} stroke="#fbbf24" strokeWidth="0.5" strokeDasharray="2 2" />
          <circle cx={markerX} cy={markerY} r="4" fill="#fff4d6" stroke="#f97316" strokeWidth="1.5" />
          <text x={markerX + 6} y={markerY + 3} fontSize="10" fill="#fff4d6" fontFamily="monospace">
            {recoveryPct > maxR ? `${maxR}+%` : `${Math.round(recoveryPct)}%`}
          </text>
        </svg>
      </div>

      <div className="fs-demo-slider-wrap">
        <input
          type="range"
          min="5"
          max="80"
          step="1"
          value={lossPct}
          onChange={e => setLossPct(parseInt(e.target.value))}
          className="fs-slider"
          style={{ ['--fill' as string]: `${((lossPct - 5) / 75) * 100}%` }}
        />
      </div>

      <div className="fs-demo-grid">
        <div className="fs-demo-stat">
          <div className="fs-demo-stat-label">You lose</div>
          <div className="fs-demo-stat-val mono tone-danger">−{lossPct}%</div>
        </div>
        <div className="fs-demo-stat" style={{ gridColumn: 'span 2' }}>
          <div className="fs-demo-stat-label">You need to recover</div>
          <div className={`fs-demo-stat-val mono tone-${tone}`}>
            +{recoveryPct > 9999 ? '∞' : Math.round(recoveryPct)}%
          </div>
        </div>
      </div>

      <div className={`fs-demo-verdict tone-${tone}`}>
        {tone === 'safe' && "✓ Fully recoverable with a normal winning trade."}
        {tone === 'caution' && "⚠ Hard to recover — would need your best trades just to break even."}
        {tone === 'danger' && "✗ Almost impossible to recover. This is why professionals cap losses early."}
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════
// 3. STOP LADDER (ATR-based)
// Visualize how ATR scales a stop.
// ═════════════════════════════════════════════════════════════
export function StopLadderDemo({ entry = 5.0, atr = 0.25 }: { entry?: number; atr?: number }) {
  const [multiplier, setMultiplier] = useState(2)
  const stopDistance = atr * multiplier
  const stopPrice = entry - stopDistance
  const stopPct = (stopDistance / entry) * 100
  const targetPrice = entry + (stopDistance * 2) // always 2R
  const targetPct = ((targetPrice - entry) / entry) * 100

  // ladder rungs at 1x, 1.5x, 2x, 2.5x, 3x ATR
  const rungs = [1, 1.5, 2, 2.5, 3]

  return (
    <div className="fs-demo">
      <div className="fs-demo-label">Entry <span className="mono">{fmt$(entry)}</span> · ATR <span className="mono">{fmt$(atr)}</span></div>

      <div className="fs-ladder">
        {rungs.map(r => {
          const price = entry - (atr * r)
          const active = r === multiplier
          return (
            <button
              key={r}
              className={`fs-ladder-rung ${active ? 'active' : ''}`}
              onClick={() => setMultiplier(r)}
            >
              <span className="fs-ladder-mult mono">{r}× ATR</span>
              <span className="fs-ladder-price mono">{fmt$(price)}</span>
            </button>
          )
        })}
      </div>

      <div className="fs-demo-slider-wrap">
        <input
          type="range"
          min="0.5"
          max="4"
          step="0.25"
          value={multiplier}
          onChange={e => setMultiplier(parseFloat(e.target.value))}
          className="fs-slider"
          style={{ ['--fill' as string]: `${((multiplier - 0.5) / 3.5) * 100}%` }}
        />
      </div>

      <div className="fs-demo-grid">
        <div className="fs-demo-stat">
          <div className="fs-demo-stat-label">Stop price</div>
          <div className="fs-demo-stat-val mono tone-danger">{fmt$(stopPrice)}</div>
          <div className="fs-demo-stat-sub mono">−{stopPct.toFixed(1)}%</div>
        </div>
        <div className="fs-demo-stat">
          <div className="fs-demo-stat-label">At 2R target</div>
          <div className="fs-demo-stat-val mono tone-safe">{fmt$(targetPrice)}</div>
          <div className="fs-demo-stat-sub mono">+{targetPct.toFixed(1)}%</div>
        </div>
        <div className="fs-demo-stat">
          <div className="fs-demo-stat-label">R:R ratio</div>
          <div className="fs-demo-stat-val mono">2 : 1</div>
        </div>
      </div>

      <div className="fs-demo-verdict tone-safe">
        At {multiplier}× ATR, your stop adapts to this stock's normal volatility.
        {multiplier < 1.5 && ' Tight — may get stopped on noise.'}
        {multiplier >= 1.5 && multiplier <= 2.5 && ' Professional zone — tight enough to limit risk, loose enough to survive noise.'}
        {multiplier > 2.5 && ' Wide — you can afford fewer losses at this size.'}
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════
// 4. RISK/REWARD TILT
// See how win-rate and R:R combine to determine profitability.
// ═════════════════════════════════════════════════════════════
export function RiskRewardTiltDemo() {
  const [winRate, setWinRate] = useState(45)
  const [rr, setRR] = useState(2)

  const riskPerTrade = 100
  const avgWin = riskPerTrade * rr
  const avgLoss = riskPerTrade
  const expectancy = (winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss
  const breakEvenWinRate = 100 / (1 + rr)

  const per100 = expectancy * 100
  const tone = expectancy > 0 ? 'safe' : expectancy < 0 ? 'danger' : 'caution'

  return (
    <div className="fs-demo">
      <div className="fs-demo-two-sliders">
        <div>
          <div className="fs-demo-label">Win rate <span className="mono">{winRate}%</span></div>
          <input
            type="range" min="10" max="90" step="1" value={winRate}
            onChange={e => setWinRate(parseInt(e.target.value))}
            className="fs-slider"
            style={{ ['--fill' as string]: `${((winRate - 10) / 80) * 100}%` }}
          />
        </div>
        <div>
          <div className="fs-demo-label">R:R ratio <span className="mono">{rr}:1</span></div>
          <input
            type="range" min="0.5" max="5" step="0.25" value={rr}
            onChange={e => setRR(parseFloat(e.target.value))}
            className="fs-slider"
            style={{ ['--fill' as string]: `${((rr - 0.5) / 4.5) * 100}%` }}
          />
        </div>
      </div>

      <div className="fs-demo-grid">
        <div className="fs-demo-stat">
          <div className="fs-demo-stat-label">Per trade</div>
          <div className={`fs-demo-stat-val mono tone-${tone}`}>
            {expectancy >= 0 ? '+' : ''}{fmt$(expectancy)}
          </div>
        </div>
        <div className="fs-demo-stat">
          <div className="fs-demo-stat-label">Per 100 trades</div>
          <div className={`fs-demo-stat-val mono tone-${tone}`}>
            {per100 >= 0 ? '+' : ''}{fmt$(per100)}
          </div>
        </div>
        <div className="fs-demo-stat">
          <div className="fs-demo-stat-label">Break-even at</div>
          <div className="fs-demo-stat-val mono">{breakEvenWinRate.toFixed(0)}%</div>
        </div>
      </div>

      <div className={`fs-demo-verdict tone-${tone}`}>
        {tone === 'safe' && `✓ Profitable system. Winners of ${rr}R cover losses even with this hit rate.`}
        {tone === 'caution' && `≈ Break-even. Small shifts in execution determine profit or loss.`}
        {tone === 'danger' && `✗ Losing system. Either find tighter stops (higher R:R) or better setups (higher win rate).`}
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════
// Router — pick the right demo for a lesson block
// ═════════════════════════════════════════════════════════════
import type { DemoKind } from '@/app/lib/invest-lessons'

export function LessonDemo({ demo, balance }: { demo: DemoKind; balance?: number }) {
  switch (demo.kind) {
    case 'position-sizer':
      return <PositionSizerDemo balance={demo.balance ?? balance ?? 100} maxPct={demo.maxPct} />
    case 'loss-recovery':
      return <LossRecoveryDemo />
    case 'stop-ladder':
      return <StopLadderDemo entry={demo.entry} atr={demo.atr} />
    case 'risk-reward-tilt':
      return <RiskRewardTiltDemo />
  }
}
