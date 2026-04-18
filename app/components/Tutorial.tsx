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
  const tooltipRef = useRef<HTMLDivElement>(null)

  const currentStep = config.steps[step]
  const isLast = step === config.steps.length - 1
  const isFirst = step === 0

  const saveProgress = useCallback((stepIdx: number, completed = false, skipped = false) => {
    // Fire and forget — never block navigation on API call
    fetch('/api/tutorial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tutorialId: config.id, step: stepIdx, completed, skipped }),
    }).catch(() => { /* non-critical */ })
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

  const goNext = () => {
    if (isLast) {
      saveProgress(step, true, false)
      setActive(false)
      // Small delay ensures React removes the overlay DOM before onComplete fires
      // preventing the dark spotlight shadow from persisting on screen
      setTimeout(() => onComplete?.(), 50)
    } else {
      const next = step + 1
      setStep(next)
      saveProgress(next)
    }
  }

  const goPrev = () => {
    if (!isFirst) setStep(step - 1)
  }

  const skip = () => {
    saveProgress(step, false, true)
    setActive(false)
    setTimeout(() => onSkip?.(), 50)
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
              <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold t-text"
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

            <button onClick={goNext}
              className="flex items-center gap-1.5 text-xs font-semibold px-4 py-1.5 rounded-lg t-text transition-all hover:opacity-90 active:scale-95 disabled:opacity-50"
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
    // First try the direct function (if Tutorial is already mounted)
    const fn = (window as any)[`tutorial_${tutorialId}_restart`]
    if (fn) {
      fn()
      return
    }
    // Otherwise dispatch a custom event — the page listens and remounts the Tutorial
    window.dispatchEvent(new CustomEvent('wali_os:launch_tutorial', { detail: { tutorialId } }))
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
  title: 'Welcome to Wali-OS',
  description: 'Learn how to use the AI stock analysis council',
  steps: [
    {
      id: 'welcome',
      title: 'Welcome to Wali-OS',
      content: 'Wali-OS runs multiple AI models against each other in a structured debate before giving you a recommendation. Not one AI\'s opinion — a council that argues both sides before reaching a verdict.',
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
      content: 'The left panel shows 24+ live signals feeding the debate: RSI, MACD, Ichimoku cloud, ATR, Williams %R, CCI, momentum, relative strength vs sector, P/E, analyst consensus, insider activity, options flow, GEX, and market regime — all computed before the debate starts.',
      target: '[data-tutorial="sidebar"]',
      position: 'right',
      tip: 'The conviction score aggregates all signals. Low conviction means genuine conflict — expect a lower confidence score and size your position accordingly.',
    },
    {
      id: 'debate-sections',
      title: 'Read the debate',
      content: 'Each collapsible section is one debate stage. Expand Lead Analyst to see the initial thesis. Expand Devil\'s Advocate to see the challenges. The Rebuttal and Counter sections show Round 2 — where both sides fetch live data mid-debate to press their case.',
      position: 'center',
      tip: 'What the Lead Analyst concedes in the Rebuttal matters most. If they give up their strongest point, the confidence score drops and the Judge notes it explicitly.',
    },
    {
      id: 'verdict',
      title: 'The Council Verdict',
      content: 'The Judge has read every argument from both rounds before ruling. You get a signal, entry price, stop loss (ATR-derived), take profit, and time horizon. After an analysis, click "💰 Log trade" to track your P&L and get reinvestment ideas.',
      position: 'center',
      tip: 'A 45% confidence NEUTRAL verdict means signals genuinely conflict — size smaller or wait. That\'s the AI being honest, not a failure.',
    },
    {
      id: 'nav',
      title: 'The full platform',
      content: '🔥 Invest tracks your journey from any starting balance — $5 to $1M — with fire milestones and stage-matched stock picks. 🌍 Macro ranks all 11 sectors daily. 💼 Portfolio gives a holistic view of your holdings. 💰 Reinvest tracks trades and deploys gains. ⚡ Compare runs the full debate on two stocks.',
      position: 'center',
      tip: 'Start your day on Macro, identify the strongest sector, use Compare on the top two names, then log your trade in Reinvest.',
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
      content: 'Add the stocks you actually own. Wali-OS analyzes your entire portfolio holistically — sector concentration, correlated risk, earnings timing, and specific rebalancing recommendations for your actual holdings.',
      position: 'center',
    },
    {
      id: 'add',
      title: 'Add a Position',
      content: 'Click "Add position" and enter a ticker, share count, and optional average cost. Cost basis enables P&L tracking. Each position gets live price, RSI, signal, and an earnings warning if earnings are within 14 days.',
      target: '[data-tutorial="add-position-btn"]',
      position: 'bottom',
      action: 'Click "Add position" and enter your first holding',
    },
    {
      id: 'analyze',
      title: 'Run the Analysis',
      content: 'Click "Analyze portfolio" to get the holistic view. The council fetches live prices, computes 24+ technical indicators for every holding, and produces a portfolio score (0-100), overall signal, top risks with severity, and a specific action plan.',
      position: 'center',
      tip: 'The analysis weighs sector concentration, correlated risk, and earnings timing across all holdings simultaneously — not just individual stock signals.',
    },
    {
      id: 'score',
      title: 'Portfolio Score & Risks',
      content: 'The score (0-100) reflects combined portfolio health. Each risk has a severity (high/medium/low) linked to specific tickers. High-severity risks should be addressed before adding new positions.',
      position: 'center',
      tip: 'Click "Analyze" next to any position to run the full 6-stage debate on that specific stock.',
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
      content: 'The full 6-stage debate runs on both stocks simultaneously. A third AI call then compares conviction scores, risk/reward, strengths and weaknesses, and gives a definitive "if you can only pick one" recommendation.',
      position: 'center',
    },
    {
      id: 'tickers',
      title: 'Enter Two Tickers',
      content: 'Enter the first ticker in the left box and the second in the right. Best used for stocks in the same sector: NVDA vs AMD, AAPL vs MSFT, JPM vs BAC, BTC vs ETH.',
      target: '[data-tutorial="compare-ticker-a"]',
      position: 'bottom',
      action: 'Enter two tickers you want to compare',
    },
    {
      id: 'result',
      title: 'Reading the Results',
      content: 'Side-by-side verdicts show entry, stop (ATR-derived), and target for each. The conviction bars show signal strength. The "if you can only pick one" section gives the council\'s definitive recommendation with a specific reason.',
      position: 'center',
      tip: 'Use Compare when you\'re choosing between two names in the same sector — relative strength vs sector is particularly useful here since both use the same sector ETF baseline.',
    },
  ],
}

export const INVEST_TUTORIAL: TutorialConfig = {
  id: 'invest',
  title: 'Your Investment Journey',
  description: 'Learn how the Invest page grows your portfolio from any starting amount',
  steps: [
    {
      id: 'welcome',
      title: 'Your journey starts here',
      content: 'The Invest page is built for every starting balance — $5 or $5,000. You set how much you have, the council finds stocks sized to that exact amount, and your milestone tracks progress toward the next level.',
      position: 'center',
      tip: 'This is separate from the Reinvestment Tracker — Invest is for building from scratch, Reinvest is for deploying existing gains.',
    },
    {
      id: 'milestone',
      title: 'Your fire milestone',
      content: 'Six stages: Spark ($0–$10) → Ember ($10–$50) → Flame ($50–$200) → Blaze ($200–$1K) → Inferno ($1K–$10K) → Free ($10K+). Each stage unlocks better stocks and tighter strategies. The progress bar shows exactly how far you are from the next milestone.',
      position: 'center',
      tip: 'The stage you\'re in determines what price range the council searches — at Spark it finds $1–$5 stocks, at Blaze it finds $10–$50 stocks, always sized so you can buy a meaningful number of shares.',
    },
    {
      id: 'ideas',
      title: 'Stage-matched picks',
      content: 'The council reads today\'s macro sector performance and finds 5 stocks from the strongest sectors — priced and sized for your exact balance. At $5 it finds $1–3 stocks (2 shares). At $500 it finds $20–40 stocks (15 shares). Every pick has a specific catalyst, entry zone, stop loss, and target.',
      position: 'center',
      tip: 'The sector strip at the top of Ideas shows which sectors are BULLISH today. All 5 picks come from those sectors — you\'re always trading with the market, not against it.',
    },
    {
      id: 'log',
      title: 'Log a trade',
      content: 'Click "Log this trade" on any idea to record it. Enter shares and entry price — the page will track live P&L automatically. When you close a trade, the council updates your milestone progress, win streak, and adjusts future picks to your new balance.',
      position: 'center',
      tip: 'Your first profitable close triggers a special moment. Every journey has a first win.',
    },
    {
      id: 'streak',
      title: 'Win streak and stats',
      content: 'Your win streak, win rate, and "in play" P&L all update in real time. During market hours prices refresh every 5 minutes automatically. After market close you see the official closing prices. The total portfolio value always reflects your true position.',
      position: 'center',
      tip: 'Even if you lose a trade, your total trades count and win rate don\'t reset. Consistency over time is what builds the streak.',
    },
    {
      id: 'done',
      title: 'The journey is the point',
      content: 'Most people never invest because they think they need more money first. The Invest page proves you don\'t. Start with what you have. The council finds appropriate stocks. Your milestone tracks your progress. Spark to Free is the journey — start yours.',
      position: 'center',
    },
  ],
}
