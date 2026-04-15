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
      content: 'Consilium runs multiple AI models against each other in a structured debate before giving you a recommendation. Not one AI\'s opinion — a council that argues both sides before reaching a verdict.',
      position: 'center',
      tip: 'The debate approach catches blind spots that a single AI analysis would miss.',
    },
    {
      id: 'how-it-works',
      title: 'How the debate works',
      content: 'The News Scout scans headlines and macro conditions. The Lead Analyst makes the initial call with a price target. The Devil\'s Advocate attacks the thesis with data. They each rebut each other in Round 2. Then the Judge — having read every argument — delivers the final verdict.',
      position: 'center',
      tip: 'In Round 2, both sides can pull fresh live data mid-debate to back their arguments — earnings estimates, options flow, analyst targets.',
    },
    {
      id: 'ticker',
      title: 'Enter a Ticker',
      content: 'Type any US stock ticker or major crypto. AAPL, MSFT, NVDA, BTC, ETH — all supported. Press Enter or click Analyze to convene the council.',
      target: '[data-tutorial="ticker-input"]',
      position: 'bottom',
      action: 'Type a ticker symbol you want to analyze',
    },
    {
      id: 'timeframe',
      title: 'Choose Your Timeframe',
      content: 'The timeframe changes how the council interprets signals. 1D for day traders. 1W for swing traders. 1M and 3M for longer-term investors. A death cross on 1W carries more weight than on 1D.',
      target: '[data-tutorial="timeframe-selector"]',
      position: 'bottom',
      tip: '1W is the recommended default — it gives the debate enough context to be meaningful without getting lost in intraday noise.',
    },
    {
      id: 'persona',
      title: 'Three analyst personalities',
      content: '⚖ Balanced weights technicals and fundamentals equally. 📈 Technical follows price action — a death cross is bearish regardless of P/E. 📊 Fundamental prioritizes business quality — a 30% pullback in a great company is a buying opportunity.',
      target: '[data-tutorial="persona-selector"]',
      position: 'bottom',
      action: 'Try the same stock under Technical and Fundamental — you\'ll often get different verdicts',
      tip: 'Both verdicts can be right for different timeframes. A stock can be technically BEARISH and fundamentally BULLISH at the same time.',
    },
    {
      id: 'analyze',
      title: 'Convene the Council',
      content: 'Click Analyze and watch the debate stream in real time. Each stage appears as it completes — Lead Analyst → Devil\'s Advocate → Rebuttal → Counter → Verdict. The full debate takes 30-60 seconds.',
      target: '[data-tutorial="analyze-btn"]',
      position: 'bottom',
      action: 'Click Analyze now',
    },
    {
      id: 'sidebar',
      title: 'Live signal dashboard',
      content: 'The left panel shows the raw data feeding the debate: RSI, MACD, moving averages, P/E, analyst consensus, insider activity, options flow, and market regime — all computed before the AIs start arguing.',
      target: '[data-tutorial="sidebar"]',
      position: 'right',
      tip: 'The conviction score shows how many signals agree. Low conviction means genuine conflict — the debate will reflect that uncertainty and the confidence score will be lower.',
    },
    {
      id: 'debate-sections',
      title: 'Read the debate',
      content: 'Each collapsible section is one debate stage. Expand Lead Analyst to see the initial thesis. Expand Devil\'s Advocate to see the challenges. The Rebuttal and Counter sections show Round 2 — where both sides use live data from Gemini to press their case.',
      position: 'center',
      tip: 'What the Lead Analyst concedes in the Rebuttal matters — if they give up their strongest point, the Judge will notice.',
    },
    {
      id: 'verdict',
      title: 'The Council Verdict',
      content: 'The Judge has read every argument from both rounds before ruling. You get a signal, entry price, stop loss, take profit, and time horizon. The persona badge shows which analytical lens was applied.',
      position: 'center',
      tip: 'A 45% confidence NEUTRAL verdict means signals genuinely conflict — size smaller or wait. That\'s the AI being honest, not a failure.',
    },
    {
      id: 'nav',
      title: 'Beyond single stocks',
      content: '🌍 Macro ranks all 11 sectors by signal — check it every morning. 💼 Portfolio analyzes your actual holdings holistically. 💰 Reinvest tracks your trades and gets the council to recommend where to deploy gains. ⚡ Compare runs the full debate on two stocks simultaneously.',
      position: 'center',
      tip: 'Start your day on Macro, identify the strongest sector, then use Compare on the top two names in that sector.',
    },
    {
      id: 'done',
      title: 'The council is yours',
      content: 'You have a professional AI council arguing on your behalf before every trade. Run your first analysis — the debate speaks for itself.',
      position: 'center',
      tip: 'Replay this tutorial anytime using the 📖 button in the navigation bar.',
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
      target: '[data-tutorial="add-position-btn"]',
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
      target: '[data-tutorial="compare-ticker-a"]',
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
