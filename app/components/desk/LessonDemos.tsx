'use client'

import { useState, useMemo } from 'react'

const fmt$ = (n: number, d = 2) => {
  if (!isFinite(n)) return '—'
  const v = Math.abs(n)
  if (v < 100) return `${n < 0 ? '-' : ''}$${v.toFixed(d)}`
  return `${n < 0 ? '-' : ''}$${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

// ══════════════════════════════════════════════════════════════
// 1. POSITION SIZER
// ══════════════════════════════════════════════════════════════
export function PositionSizerDemo({ balance = 100, maxPct = 20 }: { balance?: number; maxPct?: number }) {
  const [pct, setPct] = useState(5)
  const dollars = (pct / 100) * balance
  const stopLossPct = 15
  const dollarsAtRisk = dollars * (stopLossPct / 100)
  const totalLossPct = (dollarsAtRisk / balance) * 100

  const tone = pct <= 5 ? 'safe' : pct <= 10 ? 'caution' : 'danger'

  return (
    <div className="fl-demo">
      <div className="fl-demo-label">Account balance · <span className="mono">{fmt$(balance)}</span></div>

      <div className="fl-demo-slider-wrap">
        <input
          type="range"
          min="1"
          max={maxPct}
          step="0.5"
          value={pct}
          onChange={e => setPct(parseFloat(e.target.value))}
          className="fl-slider"
          style={{ ['--fill' as string]: `${(pct / maxPct) * 100}%` }}
        />
        <div className="fl-demo-pct-display">
          <span className="mono big">{pct.toFixed(1)}%</span>
          <span className="fl-dim">of account</span>
        </div>
      </div>

      <div className="fl-demo-grid">
        <div className="fl-demo-stat">
          <div className="fl-demo-stat-label">Position size</div>
          <div className="fl-demo-stat-val mono">{fmt$(dollars)}</div>
        </div>
        <div className="fl-demo-stat">
          <div className="fl-demo-stat-label">At 15% stop</div>
          <div className="fl-demo-stat-val mono">{fmt$(-dollarsAtRisk)}</div>
        </div>
        <div className="fl-demo-stat">
          <div className="fl-demo-stat-label">% of account</div>
          <div className={`fl-demo-stat-val mono tone-${tone}`}>{totalLossPct.toFixed(1)}%</div>
        </div>
      </div>

      <div className={`fl-demo-verdict tone-${tone}`}>
        {tone === 'safe' && "Professional sizing. You can be wrong many times and still recover."}
        {tone === 'caution' && "Aggressive. A few bad trades will compound. Reserve for highest conviction only."}
        {tone === 'danger' && "Gambling territory. A single bad trade could cripple the account."}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 2. LOSS RECOVERY CURVE
// ══════════════════════════════════════════════════════════════
export function LossRecoveryDemo() {
  const [lossPct, setLossPct] = useState(25)
  const recoveryPct = (1 / (1 - lossPct / 100) - 1) * 100

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
    <div className="fl-demo">
      <div className="fl-demo-label">Drag to see the recovery required</div>

      <div className="fl-demo-curve-wrap">
        <svg viewBox={`0 0 ${W} ${H + 20}`} className="fl-demo-svg" preserveAspectRatio="xMidYMid meet">
          {/* grid baseline */}
          <line x1="0" y1={H} x2={W} y2={H} stroke="rgba(148,163,184,0.3)" strokeWidth="0.5" />
          <line x1="0" y1={yScale(100)} x2={W} y2={yScale(100)} stroke="rgba(148,163,184,0.15)" strokeWidth="0.5" strokeDasharray="2 2" />
          <text x="2" y={yScale(100) - 2} fontSize="8" fill="rgba(148,163,184,0.5)" fontFamily="ui-monospace, monospace">100%</text>
          <path d={path} fill="none" stroke="url(#flCurveGrad)" strokeWidth="1.5" />
          <defs>
            <linearGradient id="flCurveGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#14b8a6" />
              <stop offset="50%" stopColor="#d4a857" />
              <stop offset="100%" stopColor="#dc2626" />
            </linearGradient>
          </defs>
          <line x1={markerX} y1={H} x2={markerX} y2={markerY} stroke="#d4a857" strokeWidth="0.5" strokeDasharray="2 2" />
          <circle cx={markerX} cy={markerY} r="4" fill="#f5f5f5" stroke="#d4a857" strokeWidth="1.5" />
          <text x={markerX + 6} y={markerY + 3} fontSize="10" fill="#f5f5f5" fontFamily="ui-monospace, monospace">
            {recoveryPct > maxR ? `${maxR}+%` : `${Math.round(recoveryPct)}%`}
          </text>
        </svg>
      </div>

      <div className="fl-demo-slider-wrap">
        <input
          type="range"
          min="5"
          max="80"
          step="1"
          value={lossPct}
          onChange={e => setLossPct(parseInt(e.target.value))}
          className="fl-slider"
          style={{ ['--fill' as string]: `${((lossPct - 5) / 75) * 100}%` }}
        />
      </div>

      <div className="fl-demo-grid">
        <div className="fl-demo-stat">
          <div className="fl-demo-stat-label">Loss</div>
          <div className="fl-demo-stat-val mono tone-danger">−{lossPct}%</div>
        </div>
        <div className="fl-demo-stat" style={{ gridColumn: 'span 2' }}>
          <div className="fl-demo-stat-label">Recovery required</div>
          <div className={`fl-demo-stat-val mono tone-${tone}`}>
            +{recoveryPct > 9999 ? '∞' : Math.round(recoveryPct)}%
          </div>
        </div>
      </div>

      <div className={`fl-demo-verdict tone-${tone}`}>
        {tone === 'safe' && "Recoverable with a normal winning trade."}
        {tone === 'caution' && "Difficult — would require your best trades just to break even."}
        {tone === 'danger' && "Mathematically near-impossible. This is why professionals cap losses early."}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 3. STOP LADDER
// ══════════════════════════════════════════════════════════════
export function StopLadderDemo({ entry = 5.0, atr = 0.25 }: { entry?: number; atr?: number }) {
  const [multiplier, setMultiplier] = useState(2)
  const stopDistance = atr * multiplier
  const stopPrice = entry - stopDistance
  const stopPct = (stopDistance / entry) * 100
  const targetPrice = entry + (stopDistance * 2)
  const targetPct = ((targetPrice - entry) / entry) * 100

  const rungs = [1, 1.5, 2, 2.5, 3]

  return (
    <div className="fl-demo">
      <div className="fl-demo-label">Entry <span className="mono">{fmt$(entry)}</span> · ATR <span className="mono">{fmt$(atr)}</span></div>

      <div className="fl-ladder">
        {rungs.map(r => {
          const price = entry - (atr * r)
          const active = r === multiplier
          return (
            <button
              key={r}
              className={`fl-ladder-rung ${active ? 'active' : ''}`}
              onClick={() => setMultiplier(r)}
            >
              <span className="fl-ladder-mult mono">{r}× ATR</span>
              <span className="fl-ladder-price mono">{fmt$(price)}</span>
            </button>
          )
        })}
      </div>

      <div className="fl-demo-slider-wrap">
        <input
          type="range"
          min="0.5"
          max="4"
          step="0.25"
          value={multiplier}
          onChange={e => setMultiplier(parseFloat(e.target.value))}
          className="fl-slider"
          style={{ ['--fill' as string]: `${((multiplier - 0.5) / 3.5) * 100}%` }}
        />
      </div>

      <div className="fl-demo-grid">
        <div className="fl-demo-stat">
          <div className="fl-demo-stat-label">Stop price</div>
          <div className="fl-demo-stat-val mono tone-danger">{fmt$(stopPrice)}</div>
          <div className="fl-demo-stat-sub mono">−{stopPct.toFixed(1)}%</div>
        </div>
        <div className="fl-demo-stat">
          <div className="fl-demo-stat-label">2R target</div>
          <div className="fl-demo-stat-val mono tone-safe">{fmt$(targetPrice)}</div>
          <div className="fl-demo-stat-sub mono">+{targetPct.toFixed(1)}%</div>
        </div>
        <div className="fl-demo-stat">
          <div className="fl-demo-stat-label">R:R</div>
          <div className="fl-demo-stat-val mono">2 : 1</div>
        </div>
      </div>

      <div className="fl-demo-verdict tone-safe">
        At {multiplier}× ATR, the stop adapts to this instrument's normal volatility.
        {multiplier < 1.5 && ' Tight — may get stopped on noise.'}
        {multiplier >= 1.5 && multiplier <= 2.5 && ' Professional zone — tight enough to limit risk, loose enough to survive noise.'}
        {multiplier > 2.5 && ' Wide — you can afford fewer losses at this size.'}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// 4. RISK/REWARD TILT
// ══════════════════════════════════════════════════════════════
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
    <div className="fl-demo">
      <div className="fl-demo-two-sliders">
        <div>
          <div className="fl-demo-label">Win rate <span className="mono">{winRate}%</span></div>
          <input
            type="range" min="10" max="90" step="1" value={winRate}
            onChange={e => setWinRate(parseInt(e.target.value))}
            className="fl-slider"
            style={{ ['--fill' as string]: `${((winRate - 10) / 80) * 100}%` }}
          />
        </div>
        <div>
          <div className="fl-demo-label">R:R ratio <span className="mono">{rr}:1</span></div>
          <input
            type="range" min="0.5" max="5" step="0.25" value={rr}
            onChange={e => setRR(parseFloat(e.target.value))}
            className="fl-slider"
            style={{ ['--fill' as string]: `${((rr - 0.5) / 4.5) * 100}%` }}
          />
        </div>
      </div>

      <div className="fl-demo-grid">
        <div className="fl-demo-stat">
          <div className="fl-demo-stat-label">Per trade</div>
          <div className={`fl-demo-stat-val mono tone-${tone}`}>
            {expectancy >= 0 ? '+' : ''}{fmt$(expectancy)}
          </div>
        </div>
        <div className="fl-demo-stat">
          <div className="fl-demo-stat-label">Per 100 trades</div>
          <div className={`fl-demo-stat-val mono tone-${tone}`}>
            {per100 >= 0 ? '+' : ''}{fmt$(per100)}
          </div>
        </div>
        <div className="fl-demo-stat">
          <div className="fl-demo-stat-label">Break-even at</div>
          <div className="fl-demo-stat-val mono">{breakEvenWinRate.toFixed(0)}%</div>
        </div>
      </div>

      <div className={`fl-demo-verdict tone-${tone}`}>
        {tone === 'safe' && `Profitable system. Winners of ${rr}R cover losses even at this hit rate.`}
        {tone === 'caution' && `Break-even. Small shifts in execution determine profit or loss.`}
        {tone === 'danger' && `Losing system. Either tighten stops (higher R:R) or improve setups (higher win rate).`}
      </div>
    </div>
  )
}

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
