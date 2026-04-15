'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { X, ChevronRight, ChevronLeft, CheckCircle, BookOpen } from 'lucide-react'

export interface TutorialStep {
  id: string
  title: string
  content: string
  target?: string        // CSS selector to highlight — if omitted, shows as centered modal
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center'
  action?: string        // e.g. "Enter AAPL and click Analyze"
  tip?: string           // extra pro tip in green
  spotlight?: boolean    // whether to dim the rest of the screen
}

export interface TutorialConfig {
  id: string
  title: string
  description: string
  steps: TutorialStep[]
}

interface TutorialProps {
  config: TutorialConfig
  onComplete?: () => void
  onSkip?: () => void
  autoStart?: boolean
}

interface TooltipPos {
  top: number
  left: number
  width: number
  arrowSide: 'top' | 'bottom' | 'left' | 'right' | 'none'
}

function getTargetRect(selector: string): DOMRect | null {
  const el = document.querySelector(selector)
  if (!el) return null
  return el.getBoundingClientRect()
}

function calcTooltipPos(
  rect: DOMRect,
  position: TutorialStep['position'],
  tooltipW: number,
  tooltipH: number,
  margin = 16
): TooltipPos {
  const vw = window.innerWidth
  const vh = window.innerHeight

  let top = 0, left = 0
  let arrowSide: TooltipPos['arrowSide'] = 'top'

  switch (position) {
    case 'bottom':
      top = rect.bottom + margin
      left = rect.left + rect.width / 2 - tooltipW / 2
      arrowSide = 'top'
      break
    case 'top':
      top = rect.top - tooltipH - margin
      left = rect.left + rect.width / 2 - tooltipW / 2
      arrowSide = 'bottom'
      break
    case 'right':
      top = rect.top + rect.height / 2 - tooltipH / 2
      left = rect.right + margin
      arrowSide = 'left'
      break
    case 'left':
      top = rect.top + rect.height / 2 - tooltipH / 2
      left = rect.left - tooltipW - margin
      arrowSide = 'right'
      break
    default:
      // auto — prefer bottom, fallback to top
      if (rect.bottom + tooltipH + margin < vh) {
        top = rect.bottom + margin
        left = rect.left + rect.width / 2 - tooltipW / 2
        arrowSide = 'top'
      } else {
        top = rect.top - tooltipH - margin
        left = rect.left + rect.width / 2 - tooltipW / 2
        arrowSide = 'bottom'
      }
  }

  // Clamp to viewport
  left = Math.max(margin, Math.min(vw - tooltipW - margin, left))
  top = Math.max(margin, Math.min(vh - tooltipH - margin, top))

  return { top, left, width: tooltipW, arrowSide }
}

export function Tutorial({ config, onComplete, onSkip, autoStart = false }: TutorialProps) {
  const [active, setActive] = useState(autoStart)
  const [step, setStep] = useState(0)
  const [pos, setPos] = useState<TooltipPos | null>(null)
  const [spotlightRect, setSpotlightRect] = useState<DOMRect | null>(null)
  const [saving, setSaving] = useState(false)
  const tooltipRef = useRef<HTMLDivElement>(null)

  const currentStep = config.steps[step]
  const isLast = step === config.steps.length - 1
  const isFirst = step === 0

  const saveProgress = useCallback(async (stepIdx: number, completed = false, skipped = false) => {
    setSaving(true)
    try {
      await fetch('/api/tutorial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tutorialId: config.id, step: stepIdx, completed, skipped }),
      })
    } catch { /* non-critical */ }
    setSaving(false)
  }, [config.id])

  const updatePosition = useCallback(() => {
    if (!active || !currentStep?.target) return
    const rect = getTargetRect(currentStep.target)
    if (!rect) { setPos(null); setSpotlightRect(null); return }

    setSpotlightRect(rect)
    const tooltipW = Math.min(320, window.innerWidth - 32)
    const tooltipH = tooltipRef.current?.offsetHeight ?? 200
    const p = calcTooltipPos(rect, currentStep.position, tooltipW, tooltipH)
    setPos(p)
  }, [active, currentStep])

  // Scroll target into view and recalculate position
  useEffect(() => {
    if (!active || !currentStep?.target) {
      setPos(null)
      setSpotlightRect(null)
      return
    }
    const el = document.querySelector(currentStep.target)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setTimeout(updatePosition, 300)
    }
    updatePosition()
  }, [active, step, currentStep, updatePosition])

  useEffect(() => {
    if (!active) return
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [active, updatePosition])

  const goNext = async () => {
    if (isLast) {
      await saveProgress(step, true, false)
      setActive(false)
      onComplete?.()
    } else {
      const next = step + 1
      setStep(next)
      await saveProgress(next)
    }
  }

  const goPrev = () => {
    if (!isFirst) setStep(step - 1)
  }

  const skip = async () => {
    await saveProgress(step, false, true)
    setActive(false)
    onSkip?.()
  }

  const restart = () => {
    setStep(0)
    setActive(true)
  }

  // Expose restart globally so the "Replay tutorial" button works
  useEffect(() => {
    (window as any)[`tutorial_${config.id}_restart`] = restart
    return () => { delete (window as any)[`tutorial_${config.id}_restart`] }
  }, [config.id])

  if (!active) return null

  const isCentered = !currentStep?.target || currentStep?.position === 'center'

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-[9998] pointer-events-none"
        style={{ background: 'rgba(0,0,0,0.55)' }}
      />

      {/* Spotlight cutout */}
      {spotlightRect && currentStep?.spotlight !== false && (
        <div
          className="fixed z-[9999] pointer-events-none rounded-xl transition-all duration-300"
          style={{
            top: spotlightRect.top - 6,
            left: spotlightRect.left - 6,
            width: spotlightRect.width + 12,
            height: spotlightRect.height + 12,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
            border: '2px solid rgba(167,139,250,0.8)',
          }}
        />
      )}

      {/* Tooltip / card */}
      <div
        ref={tooltipRef}
        className="fixed z-[10000] pointer-events-auto"
        style={
          isCentered
            ? { top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: Math.min(380, window.innerWidth - 32) }
            : pos
              ? { top: pos.top, left: pos.left, width: pos.width }
              : { opacity: 0 }
        }
      >
        <div className="rounded-2xl overflow-hidden shadow-2xl"
          style={{ background: 'var(--surface)', border: '1px solid rgba(167,139,250,0.4)' }}>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b"
            style={{ background: 'linear-gradient(135deg,rgba(124,58,237,0.15),rgba(79,70,229,0.15))', borderColor: 'rgba(167,139,250,0.2)' }}>
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
                style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
                {step + 1}
              </div>
              <span className="text-xs font-bold" style={{ color: '#a78bfa' }}>{currentStep?.title}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>
                {step + 1} / {config.steps.length}
              </span>
              <button onClick={skip} className="p-1 rounded-md hover:opacity-70 transition-opacity" style={{ color: 'var(--text3)' }}>
                <X size={13} />
              </button>
            </div>
          </div>

          {/* Progress bar */}
          <div className="h-1" style={{ background: 'var(--surface2)' }}>
            <div className="h-full transition-all duration-300"
              style={{ width: `${((step + 1) / config.steps.length) * 100}%`, background: 'linear-gradient(90deg,#7c3aed,#4f46e5)' }} />
          </div>

          {/* Content */}
          <div className="px-4 py-4 space-y-3">
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>
              {currentStep?.content}
            </p>

            {currentStep?.action && (
              <div className="flex items-start gap-2 rounded-xl px-3 py-2.5"
                style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)' }}>
                <span style={{ color: '#a78bfa', flexShrink: 0 }}>→</span>
                <span className="text-xs font-semibold" style={{ color: '#a78bfa' }}>{currentStep.action}</span>
              </div>
            )}

            {currentStep?.tip && (
              <div className="flex items-start gap-2 rounded-xl px-3 py-2.5"
                style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)' }}>
                <span style={{ color: '#34d399', flexShrink: 0 }}>💡</span>
                <span className="text-xs" style={{ color: '#34d399' }}>{currentStep.tip}</span>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 pb-4">
            <button onClick={goPrev} disabled={isFirst}
              className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg transition-all disabled:opacity-30 hover:opacity-70"
              style={{ color: 'var(--text2)', background: 'var(--surface2)' }}>
              <ChevronLeft size={13} /> Back
            </button>

            <button onClick={skip}
              className="text-[10px] px-2 py-1 rounded transition-all hover:opacity-70"
              style={{ color: 'var(--text3)' }}>
              Skip tutorial
            </button>

            <button onClick={goNext} disabled={saving}
              className="flex items-center gap-1.5 text-xs font-semibold px-4 py-1.5 rounded-lg text-white transition-all hover:opacity-90 active:scale-95 disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
              {isLast ? (
                <><CheckCircle size={13} /> Done</>
              ) : (
                <>Next <ChevronRight size={13} /></>
              )}
            </button>
          </div>
        </div>

        {/* Arrow pointer */}
        {pos && pos.arrowSide !== 'none' && !isCentered && (
          <div className="absolute w-3 h-3 rotate-45"
            style={{
              background: 'var(--surface)',
              border: '1px solid rgba(167,139,250,0.4)',
              ...(pos.arrowSide === 'top' && { top: -7, left: '50%', transform: 'translateX(-50%) rotate(45deg)', borderBottom: 'none', borderRight: 'none' }),
              ...(pos.arrowSide === 'bottom' && { bottom: -7, left: '50%', transform: 'translateX(-50%) rotate(45deg)', borderTop: 'none', borderLeft: 'none' }),
              ...(pos.arrowSide === 'left' && { left: -7, top: '50%', transform: 'translateY(-50%) rotate(45deg)', borderBottom: 'none', borderRight: 'none' }),
              ...(pos.arrowSide === 'right' && { right: -7, top: '50%', transform: 'translateY(-50%) rotate(45deg)', borderTop: 'none', borderLeft: 'none' }),
            }} />
        )}
      </div>
    </>
  )
}

// ── Tutorial launcher button (shown in header) ─────────────────
export function TutorialLauncher({ tutorialId, label = 'Tutorial' }: { tutorialId: string; label?: string }) {
  const launch = () => {
    const fn = (window as any)[`tutorial_${tutorialId}_restart`]
    if (fn) fn()
  }

  return (
    <button onClick={launch}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80"
      style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}
      title="Replay tutorial">
      <BookOpen size={12} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}

// ── Tutorial step definitions ──────────────────────────────────
export const MAIN_TUTORIAL: TutorialConfig = {
  id: 'main',
  title: 'Welcome to Consilium',
  description: 'Learn how to use the AI stock analysis council',
  steps: [
    {
      id: 'welcome',
      title: 'Welcome to Consilium',
      content: 'Consilium uses three AI models that debate a stock\'s direction and converge on a verdict. Think of it as having a financial council argue both sides before making a recommendation.',
      position: 'center',
      tip: 'The debate approach catches blind spots that a single AI analysis would miss.',
    },
    {
      id: 'ticker',
      title: 'Enter a Ticker',
      content: 'Type any US stock ticker or major crypto here. Try AAPL, MSFT, NVDA, or BTC. Then press Enter or click Analyze.',
      target: 'input[placeholder="AAPL"]',
      position: 'bottom',
      action: 'Type a ticker symbol you want to analyze',
    },
    {
      id: 'timeframe',
      title: 'Choose Your Timeframe',
      content: '1D is for day traders. 1W is the sweet spot for swing traders. 1M and 3M are for investors holding longer. The AI adjusts its analysis — a death cross matters more on 1W than 1D.',
      target: 'button[style*="1D"], button:contains("1D")',
      position: 'bottom',
      tip: '1W is recommended for most users — it balances short-term momentum with medium-term trend.',
    },
    {
      id: 'persona',
      title: 'Pick Your Analyst Lens',
      content: 'Three personalities interpret the same data differently. ⚖ Balanced weighs everything equally. 📈 Technical follows price action. 📊 Fundamental focuses on business quality and valuation.',
      target: '[title="Equal weight to technicals and fundamentals"]',
      position: 'bottom',
      action: 'Click each icon to see the tooltip description',
      tip: 'Run the same stock under all three — you\'ll often get meaningfully different verdicts.',
    },
    {
      id: 'analyze',
      title: 'Run the Analysis',
      content: 'Click Analyze to start the 6-stage debate. It takes 30-60 seconds. You\'ll watch the debate happen in real time: News Scout → Lead Analyst → Devil\'s Advocate → Rebuttal → Counter → Council Verdict.',
      target: 'button:has-text("Analyze"), button[style*="7c3aed"]',
      position: 'bottom',
      action: 'Click the Analyze button now',
    },
    {
      id: 'sidebar',
      title: 'Signal Dashboard',
      content: 'The left sidebar shows live technical indicators, fundamentals, smart money signals, options flow, and market context — all computed before the AI debate even starts. These feed directly into the debate.',
      target: 'aside',
      position: 'right',
      tip: 'The conviction score shows how many signals are pointing the same direction.',
    },
    {
      id: 'debate',
      title: 'The Debate Stages',
      content: 'Each collapsible section is one stage of the debate. The Lead Analyst makes the initial call. The Devil\'s Advocate challenges it. Then they each respond to each other before the Judge rules. Click any section header to expand it.',
      position: 'center',
      tip: 'In Round 2, both sides consult the News Scout for fresh data — so their arguments are backed by live information.',
    },
    {
      id: 'verdict',
      title: 'Council Verdict & Trade Plan',
      content: 'The verdict is always visible at the top of the results. Entry price, stop loss, take profit, and time horizon are the Judge\'s specific recommendations based on the full debate. The persona badge shows which lens was used.',
      position: 'center',
      tip: 'Always check the confidence score — low confidence means the signals genuinely conflict and you should size smaller.',
    },
    {
      id: 'collapsibles',
      title: 'Explore the Deep Dive',
      content: 'Below the verdict, expand Signal Explanations for plain-English breakdowns of what the technicals, fundamentals, and smart money are saying. Technical Charts shows visual indicators. Options Strategy shows the Council\'s derivatives view.',
      position: 'center',
      action: 'Click "Signal Explanations" to expand it',
    },
    {
      id: 'nav',
      title: 'The Full Platform',
      content: 'You\'re not limited to single stock analysis. Today and Tomorrow show market movers. Macro shows sector-by-sector health. Portfolio analyzes your entire holdings holistically. Compare runs two stocks head-to-head.',
      position: 'center',
      tip: 'Check Macro every morning before markets open — it tells you whether to be aggressive or defensive that day.',
    },
    {
      id: 'done',
      title: 'You\'re Ready',
      content: 'That\'s everything. You now have a professional-grade AI council analyzing stocks for you. Run your first analysis, then explore Portfolio and Macro to get the full picture.',
      position: 'center',
      tip: 'Come back to this tutorial anytime by clicking the 📖 icon in the top navigation.',
    },
  ],
}

export const PORTFOLIO_TUTORIAL: TutorialConfig = {
  id: 'portfolio',
  title: 'Portfolio Analysis',
  description: 'Learn how to add positions and get a holistic portfolio analysis',
  steps: [
    {
      id: 'intro',
      title: 'Your Personal Portfolio',
      content: 'Add the stocks you actually own. Consilium will analyze your entire portfolio holistically — concentration risk, upcoming earnings events, and specific rebalancing recommendations.',
      position: 'center',
    },
    {
      id: 'add',
      title: 'Add a Position',
      content: 'Click "Add position" and enter a ticker, share count, and optional average cost. The cost basis is optional but enables P&L tracking. You can add as many positions as you own.',
      target: 'button:has-text("Add position")',
      position: 'bottom',
      action: 'Click "Add position" and enter your first holding',
    },
    {
      id: 'analyze',
      title: 'Run the Analysis',
      content: 'Once you\'ve added your positions, click "Analyze portfolio". The AI fetches live prices, computes technicals for every holding, and then Claude produces a holistic view of your entire portfolio.',
      position: 'center',
      tip: 'The analysis considers sector concentration, correlated risk, and earnings timing across all your holdings simultaneously.',
    },
    {
      id: 'score',
      title: 'Portfolio Score',
      content: 'The overall score (0-100) reflects the combined health of your positions. The overall signal (BULLISH/BEARISH/NEUTRAL) tells you whether the council recommends being fully invested, reducing risk, or hedging.',
      position: 'center',
    },
    {
      id: 'risks',
      title: 'Top Risks & Opportunities',
      content: 'Each risk has a severity rating (high/medium/low) and is linked to specific tickers. Opportunities highlight positions showing unusual strength or upcoming catalysts. Act on high-severity risks first.',
      position: 'center',
      tip: 'Click "Analyze" next to any position to jump directly to the full 6-stage debate for that stock.',
    },
  ],
}

export const COMPARE_TUTORIAL: TutorialConfig = {
  id: 'compare',
  title: 'Head-to-Head Comparison',
  description: 'Learn how to compare two stocks directly',
  steps: [
    {
      id: 'intro',
      title: 'Head-to-Head Analysis',
      content: 'Compare two stocks directly — the full 6-stage debate runs on both simultaneously, then a third AI call makes the definitive recommendation on which has better risk/reward right now.',
      position: 'center',
    },
    {
      id: 'tickers',
      title: 'Enter Two Tickers',
      content: 'Enter the first ticker in the left box and the second in the right box. Common comparisons: NVDA vs AMD, AAPL vs MSFT, BTC vs ETH, growth vs value in the same sector.',
      target: 'input[placeholder="NVDA"]',
      position: 'bottom',
      action: 'Enter two tickers you want to compare',
    },
    {
      id: 'result',
      title: 'Reading the Results',
      content: 'The side-by-side verdicts show entry/stop/target for each. The risk/reward bars show which has better positioning. The "if you can only pick one" section gives the definitive recommendation.',
      position: 'center',
      tip: 'Use comparison mode when you\'re deciding between two stocks in the same sector — the relative value analysis is particularly useful.',
    },
  ],
}
