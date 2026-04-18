'use client'

import { useEffect, useState, useRef, useMemo } from 'react'
import { X, ChevronDown, Check } from 'lucide-react'
import type { InvestLesson, LessonBlock } from '@/app/lib/invest-lessons'
import { LessonDemo } from './LessonDemos'

interface Props {
  lesson: InvestLesson
  balance?: number
  onClose: () => void
  onComplete: (lessonId: string, correct: boolean, answer: number) => void
  alreadyCompleted?: boolean
}

// Convert legacy content[] + callout + tip into blocks if blocks[] absent
function normalizeBlocks(lesson: InvestLesson): LessonBlock[] {
  if (lesson.blocks && lesson.blocks.length) return lesson.blocks

  const blocks: LessonBlock[] = []
  for (const p of lesson.content) blocks.push({ type: 'prose', text: p })
  if (lesson.callout) blocks.push({ type: 'callout', label: lesson.callout.label, text: lesson.callout.text, tone: 'gold' })
  if (lesson.tip) blocks.push({ type: 'tip', text: lesson.tip })
  return blocks
}

export function FiresideLesson({ lesson, balance, onClose, onComplete, alreadyCompleted }: Props) {
  const blocks = useMemo(() => normalizeBlocks(lesson), [lesson])
  const [quizAnswer, setQuizAnswer] = useState<number | null>(null)
  const [quizSubmitted, setQuizSubmitted] = useState(false)
  const [scrollPct, setScrollPct] = useState(0)
  const [showFloatingQuizBtn, setShowFloatingQuizBtn] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const quizRef = useRef<HTMLDivElement>(null)

  // Lock body scroll while open
  useEffect(() => {
    const orig = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = orig }
  }, [])

  // Escape key closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Scroll progress indicator
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const handler = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      const pct = Math.min(100, (scrollTop / Math.max(1, scrollHeight - clientHeight)) * 100)
      setScrollPct(pct)
      // Show floating quiz button when user has scrolled past ~80% and hasn't started quiz yet
      setShowFloatingQuizBtn(pct > 70 && pct < 98 && !quizSubmitted && quizAnswer === null)
    }
    el.addEventListener('scroll', handler, { passive: true })
    handler()
    return () => el.removeEventListener('scroll', handler)
  }, [quizSubmitted, quizAnswer])

  const scrollToQuiz = () => {
    quizRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const submitQuiz = () => {
    if (quizAnswer == null) return
    const correct = quizAnswer === lesson.quiz.correctIndex
    setQuizSubmitted(true)
    onComplete(lesson.id, correct, quizAnswer)
  }

  const stageColor: Record<string, string> = {
    Spark: '#fbbf24', Ember: '#f97316', Flame: '#ef4444',
    Blaze: '#a78bfa', Inferno: '#60a5fa', Free: '#34d399',
  }
  const accent = stageColor[lesson.stage] ?? '#f97316'

  return (
    <div className="fs-overlay" role="dialog" aria-modal="true" aria-labelledby="fs-title">
      {/* Scrim that lets the forge breathe through */}
      <div className="fs-scrim" />

      {/* Vertical reading column */}
      <div className="fs-column">

        {/* Top bar */}
        <header className="fs-top">
          <button className="fs-close-btn" onClick={onClose} aria-label="Close lesson">
            <X size={16} />
          </button>
          <div className="fs-top-center">
            <div className="fs-eyebrow" style={{ color: accent }}>
              {lesson.icon} · {lesson.stage} · {lesson.duration}
            </div>
          </div>
          <div style={{ width: 28 }} />
        </header>

        {/* Scroll progress */}
        <div className="fs-progress">
          <div className="fs-progress-fill" style={{ width: `${scrollPct}%`, background: `linear-gradient(90deg, ${accent}, #ef4444)` }} />
        </div>

        {/* Scrollable content */}
        <div className="fs-content" ref={contentRef}>

          {/* Hero */}
          <div className="fs-hero">
            <div className="fs-hero-icon" style={{ color: accent }}>{lesson.icon}</div>
            <h1 id="fs-title" className="fs-title">{lesson.title}</h1>
            <p className="fs-subtitle">{lesson.subtitle}</p>
          </div>

          {/* Blocks */}
          <div className="fs-blocks">
            {blocks.map((block, i) => <Block key={i} block={block} balance={balance} />)}
          </div>

          {/* Quiz section */}
          <div ref={quizRef} className="fs-quiz-wrap">
            <div className="fs-quiz-divider" />
            <div className="fs-quiz-eyebrow">Knowledge check</div>
            <h2 className="fs-quiz-question">{lesson.quiz.question}</h2>

            <div className="fs-quiz-options">
              {lesson.quiz.options.map((opt, idx) => {
                const isSelected = quizAnswer === idx
                const isCorrect = quizSubmitted && idx === lesson.quiz.correctIndex
                const isWrong = quizSubmitted && isSelected && idx !== lesson.quiz.correctIndex
                return (
                  <button
                    key={idx}
                    onClick={() => { if (!quizSubmitted) setQuizAnswer(idx) }}
                    disabled={quizSubmitted}
                    className={`fs-quiz-option ${isSelected ? 'selected' : ''} ${isCorrect ? 'correct' : ''} ${isWrong ? 'wrong' : ''}`}
                  >
                    <span className="fs-quiz-letter">{String.fromCharCode(65 + idx)}</span>
                    <span className="fs-quiz-text">{opt}</span>
                    {isCorrect && <Check size={16} style={{ color: '#34d399', flexShrink: 0 }} />}
                    {isWrong && <X size={16} style={{ color: '#f87171', flexShrink: 0 }} />}
                  </button>
                )
              })}
            </div>

            {!quizSubmitted && (
              <button
                className="fs-quiz-submit"
                onClick={submitQuiz}
                disabled={quizAnswer == null}
              >
                {quizAnswer == null ? 'Choose an answer' : 'Submit →'}
              </button>
            )}

            {quizSubmitted && (
              <div className={`fs-quiz-explanation ${quizAnswer === lesson.quiz.correctIndex ? 'right' : 'wrong'}`}>
                <div className="fs-quiz-explanation-label">
                  {quizAnswer === lesson.quiz.correctIndex ? '✓ Correct' : '✗ Not quite'}
                </div>
                <p>{lesson.quiz.explanation}</p>
              </div>
            )}

            {(quizSubmitted || alreadyCompleted) && (
              <button className="fs-done-btn" onClick={onClose}>
                {quizAnswer === lesson.quiz.correctIndex ? 'Back to the forge 🔥' : 'Back to the forge'}
              </button>
            )}
          </div>

          <div className="fs-bottom-spacer" />
        </div>

        {/* Floating "jump to quiz" pill */}
        {showFloatingQuizBtn && (
          <button className="fs-jump-quiz" onClick={scrollToQuiz} style={{ borderColor: accent, color: accent }}>
            <ChevronDown size={12} /> Knowledge check
          </button>
        )}
      </div>

      <FiresideStyles accent={accent} />
    </div>
  )
}

// ─── Block renderer ──────────────────────────────────────────
function Block({ block, balance }: { block: LessonBlock; balance?: number }) {
  switch (block.type) {
    case 'heading':
      return <h2 className="fs-block-heading">{block.text}</h2>
    case 'prose':
      return <p className="fs-block-prose">{block.text}</p>
    case 'pullquote':
      return (
        <blockquote className="fs-block-pullquote">
          <span className="fs-block-quote-mark" aria-hidden>"</span>
          {block.text}
        </blockquote>
      )
    case 'callout':
      return (
        <div className={`fs-block-callout tone-${block.tone ?? 'gold'}`}>
          <div className="fs-block-callout-label">{block.label}</div>
          <pre className="fs-block-callout-text">{block.text}</pre>
        </div>
      )
    case 'tip':
      return (
        <div className="fs-block-tip">
          <span className="fs-block-tip-icon" aria-hidden>✦</span>
          <p>{block.text}</p>
        </div>
      )
    case 'warning':
      return (
        <div className="fs-block-warning">
          <span className="fs-block-warning-icon" aria-hidden>⚠</span>
          <p>{block.text}</p>
        </div>
      )
    case 'demo':
      return (
        <div className="fs-block-demo">
          <LessonDemo demo={block.demo} balance={balance} />
          {block.caption && <p className="fs-block-demo-caption">{block.caption}</p>}
        </div>
      )
  }
}

// ─── Styles (scoped to .fs-*) ─────────────────────────────────
function FiresideStyles({ accent }: { accent: string }) {
  return (
    <style jsx global>{`
      /* Overlay — sits above everything */
      .fs-overlay {
        position: fixed; inset: 0; z-index: 80;
        display: flex; justify-content: center;
        animation: fsFadeIn 0.5s ease;
      }
      @keyframes fsFadeIn { from { opacity: 0; } to { opacity: 1; } }

      /* Scrim — lets the flame breathe through just a little */
      .fs-scrim {
        position: absolute; inset: 0;
        background:
          radial-gradient(ellipse 600px 400px at 50% 110%, rgba(249,115,22,0.25), transparent 60%),
          rgba(5, 2, 1, 0.88);
        backdrop-filter: blur(12px);
      }

      /* Reading column — parchment of the night */
      .fs-column {
        position: relative;
        width: 100%; max-width: 640px;
        display: flex; flex-direction: column;
        animation: fsRise 0.6s cubic-bezier(0.22, 1, 0.36, 1);
      }
      @keyframes fsRise {
        from { opacity: 0; transform: translateY(30px); }
        to { opacity: 1; transform: translateY(0); }
      }

      /* Top bar */
      .fs-top {
        display: flex; align-items: center; justify-content: space-between;
        padding: 16px 20px 12px;
      }
      .fs-close-btn {
        width: 28px; height: 28px; border-radius: 8px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,220,180,0.12);
        color: rgba(255,220,180,0.7);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; transition: all 0.2s ease;
      }
      .fs-close-btn:hover { color: #fbbf24; border-color: rgba(249,115,22,0.4); }
      .fs-top-center { flex: 1; text-align: center; }
      .fs-eyebrow {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.24em;
        text-transform: uppercase;
      }

      /* Scroll progress */
      .fs-progress {
        height: 2px;
        background: rgba(249,115,22,0.08);
        margin: 0 20px;
        border-radius: 2px; overflow: hidden;
      }
      .fs-progress-fill {
        height: 100%;
        transition: width 0.2s ease;
      }

      /* Content */
      .fs-content {
        flex: 1; overflow-y: auto;
        padding: 24px 28px 40px;
        scroll-behavior: smooth;
        scrollbar-width: thin;
        scrollbar-color: rgba(249,115,22,0.3) transparent;
      }
      .fs-content::-webkit-scrollbar { width: 6px; }
      .fs-content::-webkit-scrollbar-track { background: transparent; }
      .fs-content::-webkit-scrollbar-thumb {
        background: rgba(249,115,22,0.2); border-radius: 3px;
      }
      .fs-content::-webkit-scrollbar-thumb:hover { background: rgba(249,115,22,0.4); }

      /* Hero */
      .fs-hero {
        text-align: center;
        padding: 32px 0 40px;
        border-bottom: 1px solid rgba(249,115,22,0.08);
        margin-bottom: 32px;
      }
      .fs-hero-icon {
        font-size: 40px;
        display: inline-block;
        margin-bottom: 12px;
        filter: drop-shadow(0 0 16px currentColor);
        animation: fsIconBreathe 3s ease-in-out infinite;
      }
      @keyframes fsIconBreathe {
        0%,100% { transform: scale(1); opacity: 0.95; }
        50% { transform: scale(1.05); opacity: 1; }
      }
      .fs-title {
        font-family: 'Fraunces', Georgia, serif;
        font-size: 32px; font-weight: 400;
        font-style: italic;
        letter-spacing: -0.015em;
        line-height: 1.1;
        margin: 0 0 10px;
        background: linear-gradient(180deg, #fff4d6 0%, ${accent} 100%);
        -webkit-background-clip: text; background-clip: text; color: transparent;
      }
      @media (min-width: 640px) { .fs-title { font-size: 42px; } }
      .fs-subtitle {
        font-family: 'Fraunces', Georgia, serif;
        font-size: 16px; font-style: italic;
        color: rgba(255, 220, 180, 0.55);
        margin: 0; line-height: 1.5;
      }

      /* Content blocks — column of editorial reading */
      .fs-blocks { max-width: 540px; margin: 0 auto; }

      .fs-block-heading {
        font-family: 'Fraunces', Georgia, serif;
        font-size: 22px; font-weight: 500;
        color: rgba(255, 244, 214, 0.95);
        margin: 32px 0 14px;
        letter-spacing: -0.01em;
      }
      .fs-block-prose {
        font-family: 'Fraunces', Georgia, serif;
        font-size: 17px; line-height: 1.7;
        color: rgba(255, 230, 200, 0.82);
        margin: 0 0 20px;
      }
      .fs-block-pullquote {
        font-family: 'Fraunces', Georgia, serif;
        font-size: 24px; font-style: italic; font-weight: 400;
        line-height: 1.35; text-align: center;
        color: rgba(255, 244, 214, 0.92);
        margin: 36px 0;
        padding: 18px 24px;
        border-top: 1px solid rgba(249,115,22,0.15);
        border-bottom: 1px solid rgba(249,115,22,0.15);
        position: relative;
      }
      .fs-block-quote-mark {
        display: block;
        font-size: 48px; line-height: 0.5;
        color: ${accent};
        opacity: 0.5;
        margin-bottom: 8px;
      }

      /* Callout — firelight card */
      .fs-block-callout {
        padding: 18px 20px;
        border-radius: 14px;
        margin: 24px 0;
        border: 1px solid;
      }
      .fs-block-callout.tone-gold {
        background: linear-gradient(180deg, rgba(251,191,36,0.08), rgba(249,115,22,0.04));
        border-color: rgba(251,191,36,0.2);
      }
      .fs-block-callout.tone-red {
        background: linear-gradient(180deg, rgba(248,113,113,0.08), rgba(239,68,68,0.04));
        border-color: rgba(248,113,113,0.25);
      }
      .fs-block-callout.tone-green {
        background: linear-gradient(180deg, rgba(52,211,153,0.08), rgba(5,150,105,0.04));
        border-color: rgba(52,211,153,0.25);
      }
      .fs-block-callout-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase;
        margin-bottom: 10px; color: #fbbf24;
      }
      .fs-block-callout.tone-red .fs-block-callout-label { color: #f87171; }
      .fs-block-callout.tone-green .fs-block-callout-label { color: #34d399; }
      .fs-block-callout-text {
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px; line-height: 1.7;
        color: rgba(255, 230, 200, 0.85);
        white-space: pre-wrap; margin: 0;
      }

      /* Tip */
      .fs-block-tip {
        display: flex; gap: 12px;
        padding: 14px 16px;
        border-radius: 12px;
        background: rgba(52,211,153,0.06);
        border: 1px solid rgba(52,211,153,0.15);
        margin: 20px 0;
      }
      .fs-block-tip-icon { color: #34d399; font-size: 18px; line-height: 1.4; }
      .fs-block-tip p {
        font-family: 'Fraunces', Georgia, serif;
        font-size: 15px; line-height: 1.6; font-style: italic;
        color: rgba(255, 230, 200, 0.8);
        margin: 0;
      }

      /* Warning */
      .fs-block-warning {
        display: flex; gap: 12px;
        padding: 14px 16px;
        border-radius: 12px;
        background: rgba(248,113,113,0.08);
        border: 1px solid rgba(248,113,113,0.2);
        margin: 20px 0;
      }
      .fs-block-warning-icon { color: #f87171; font-size: 18px; line-height: 1.4; }
      .fs-block-warning p {
        font-family: 'Fraunces', Georgia, serif;
        font-size: 15px; line-height: 1.6;
        color: rgba(255, 230, 200, 0.85);
        margin: 0;
      }

      /* Demo block */
      .fs-block-demo { margin: 32px 0; }
      .fs-block-demo-caption {
        text-align: center;
        font-family: 'Fraunces', Georgia, serif;
        font-size: 13px; font-style: italic;
        color: rgba(255, 220, 180, 0.45);
        margin: 12px 0 0;
      }

      /* ═══ DEMO INTERNALS (fs-demo-*) ═══════════════════════ */
      .fs-demo {
        padding: 20px 22px;
        border-radius: 16px;
        background:
          radial-gradient(ellipse 300px 200px at 50% 100%, rgba(249,115,22,0.08), transparent 70%),
          rgba(255,255,255,0.02);
        border: 1px solid rgba(249,115,22,0.2);
      }
      .fs-demo .mono { font-family: 'JetBrains Mono', monospace; }
      .fs-demo .big { font-size: 22px; font-weight: 500; letter-spacing: -0.01em; }
      .fs-demo .fs-dim { color: rgba(255,220,180,0.4); margin-left: 6px; font-size: 12px; }
      .fs-demo-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
        color: rgba(255,180,100,0.5);
        margin-bottom: 14px;
      }
      .fs-demo-slider-wrap { margin: 12px 0 18px; }
      .fs-slider {
        width: 100%; height: 4px;
        -webkit-appearance: none; appearance: none;
        background: linear-gradient(90deg, #fbbf24 0%, #f97316 var(--fill, 50%), rgba(255,255,255,0.08) var(--fill, 50%), rgba(255,255,255,0.08) 100%);
        border-radius: 3px; outline: 0;
      }
      .fs-slider::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 18px; height: 18px; border-radius: 50%;
        background: radial-gradient(circle, #fff4d6 0%, #fbbf24 60%, #f97316 100%);
        cursor: pointer; border: 0;
        box-shadow: 0 0 12px rgba(251,191,36,0.6);
      }
      .fs-slider::-moz-range-thumb {
        width: 18px; height: 18px; border-radius: 50%;
        background: radial-gradient(circle, #fff4d6 0%, #fbbf24 60%, #f97316 100%);
        cursor: pointer; border: 0;
        box-shadow: 0 0 12px rgba(251,191,36,0.6);
      }
      .fs-demo-pct-display {
        display: flex; align-items: baseline; gap: 4px;
        margin-top: 10px;
        color: rgba(255,244,214,0.95);
      }
      .fs-demo-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 10px;
        margin: 16px 0 12px;
      }
      .fs-demo-stat {
        padding: 10px 12px;
        border-radius: 10px;
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(255,255,255,0.05);
      }
      .fs-demo-stat-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 8px; letter-spacing: 0.16em; text-transform: uppercase;
        color: rgba(255,180,100,0.5);
        margin-bottom: 6px;
      }
      .fs-demo-stat-val {
        font-family: 'JetBrains Mono', monospace;
        font-size: 16px; font-weight: 500;
        color: rgba(255,244,214,0.95);
      }
      .fs-demo-stat-sub {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px; color: rgba(255,220,180,0.45);
        margin-top: 2px;
      }
      .tone-safe { color: #34d399 !important; }
      .tone-caution { color: #fbbf24 !important; }
      .tone-danger { color: #f87171 !important; }

      .fs-demo-verdict {
        margin-top: 12px;
        padding: 10px 14px;
        border-radius: 10px;
        font-family: 'Fraunces', Georgia, serif;
        font-size: 13px; font-style: italic; line-height: 1.5;
      }
      .fs-demo-verdict.tone-safe { background: rgba(52,211,153,0.08); border: 1px solid rgba(52,211,153,0.2); color: rgba(167,243,208,0.95); }
      .fs-demo-verdict.tone-caution { background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.2); color: rgba(253,224,71,0.95); }
      .fs-demo-verdict.tone-danger { background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.2); color: rgba(252,165,165,0.95); }

      .fs-demo-curve-wrap { margin: 8px 0 18px; }
      .fs-demo-svg { width: 100%; height: auto; max-height: 180px; }

      .fs-ladder {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 4px; margin-bottom: 14px;
      }
      .fs-ladder-rung {
        padding: 10px 6px;
        border-radius: 8px;
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(255,255,255,0.06);
        cursor: pointer;
        display: flex; flex-direction: column; align-items: center; gap: 4px;
        transition: all 0.2s ease;
      }
      .fs-ladder-rung:hover { border-color: rgba(249,115,22,0.4); }
      .fs-ladder-rung.active {
        background: rgba(249,115,22,0.15);
        border-color: #f97316;
        box-shadow: 0 0 12px rgba(249,115,22,0.2);
      }
      .fs-ladder-mult {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px; color: rgba(255,220,180,0.6);
        letter-spacing: 0.05em;
      }
      .fs-ladder-rung.active .fs-ladder-mult { color: #fbbf24; }
      .fs-ladder-price {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; font-weight: 500;
        color: rgba(255,244,214,0.9);
      }

      .fs-demo-two-sliders {
        display: flex; flex-direction: column; gap: 16px;
        margin-bottom: 16px;
      }

      /* ═══ QUIZ ═══════════════════════════════════════════════ */
      .fs-quiz-wrap {
        max-width: 540px; margin: 48px auto 0;
      }
      .fs-quiz-divider {
        width: 60px; height: 1px;
        background: linear-gradient(90deg, transparent, ${accent}, transparent);
        margin: 0 auto 24px;
      }
      .fs-quiz-eyebrow {
        text-align: center;
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px; letter-spacing: 0.26em; text-transform: uppercase;
        color: ${accent};
        margin-bottom: 14px;
      }
      .fs-quiz-question {
        font-family: 'Fraunces', Georgia, serif;
        font-size: 22px; font-weight: 400;
        line-height: 1.4;
        color: rgba(255, 244, 214, 0.95);
        margin: 0 0 24px;
        text-align: center;
      }
      .fs-quiz-options { display: flex; flex-direction: column; gap: 10px; }
      .fs-quiz-option {
        display: flex; align-items: flex-start; gap: 12px;
        padding: 14px 16px;
        border-radius: 12px;
        background: rgba(255,255,255,0.02);
        border: 1px solid rgba(255,255,255,0.06);
        text-align: left;
        cursor: pointer;
        transition: all 0.2s ease;
        color: rgba(255,230,200,0.82);
        font-family: 'Fraunces', Georgia, serif;
        font-size: 14px; line-height: 1.5;
      }
      .fs-quiz-option:not(:disabled):hover { border-color: rgba(249,115,22,0.3); background: rgba(249,115,22,0.04); }
      .fs-quiz-option.selected {
        border-color: ${accent};
        background: rgba(249,115,22,0.08);
      }
      .fs-quiz-option.correct {
        border-color: rgba(52,211,153,0.5);
        background: rgba(52,211,153,0.08);
        color: rgba(167,243,208,0.95);
      }
      .fs-quiz-option.wrong {
        border-color: rgba(248,113,113,0.4);
        background: rgba(248,113,113,0.06);
        color: rgba(252,165,165,0.9);
      }
      .fs-quiz-option:disabled { cursor: default; }
      .fs-quiz-letter {
        flex-shrink: 0;
        width: 24px; height: 24px; border-radius: 50%;
        background: rgba(255,255,255,0.04);
        display: flex; align-items: center; justify-content: center;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; font-weight: 500;
        color: rgba(255,220,180,0.6);
      }
      .fs-quiz-option.selected .fs-quiz-letter { background: ${accent}; color: #0a0503; }
      .fs-quiz-option.correct .fs-quiz-letter { background: #34d399; color: #052e1c; }
      .fs-quiz-option.wrong .fs-quiz-letter { background: #f87171; color: #450a0a; }
      .fs-quiz-text { flex: 1; }

      .fs-quiz-submit {
        display: block; width: 100%;
        margin-top: 20px;
        padding: 14px;
        border-radius: 12px;
        background: linear-gradient(135deg, #f97316, #ef4444);
        border: 0; color: #fff4d6;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase;
        font-weight: 500; cursor: pointer;
        box-shadow: 0 0 20px rgba(249,115,22,0.3);
        transition: all 0.3s ease;
      }
      .fs-quiz-submit:disabled {
        opacity: 0.4; cursor: not-allowed;
        background: rgba(255,255,255,0.05);
        box-shadow: none;
      }
      .fs-quiz-submit:not(:disabled):hover {
        box-shadow: 0 0 28px rgba(249,115,22,0.5);
        transform: translateY(-1px);
      }

      .fs-quiz-explanation {
        margin-top: 20px;
        padding: 16px 18px;
        border-radius: 12px;
      }
      .fs-quiz-explanation.right {
        background: rgba(52,211,153,0.06);
        border: 1px solid rgba(52,211,153,0.2);
      }
      .fs-quiz-explanation.wrong {
        background: rgba(248,113,113,0.06);
        border: 1px solid rgba(248,113,113,0.2);
      }
      .fs-quiz-explanation-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase;
        margin-bottom: 8px;
      }
      .fs-quiz-explanation.right .fs-quiz-explanation-label { color: #34d399; }
      .fs-quiz-explanation.wrong .fs-quiz-explanation-label { color: #f87171; }
      .fs-quiz-explanation p {
        font-family: 'Fraunces', Georgia, serif;
        font-size: 14px; line-height: 1.6;
        color: rgba(255,230,200,0.82);
        margin: 0;
      }

      .fs-done-btn {
        display: block; width: 100%;
        margin-top: 20px;
        padding: 14px;
        border-radius: 12px;
        background: transparent;
        border: 1px solid rgba(255,220,180,0.15);
        color: rgba(255,220,180,0.75);
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase;
        cursor: pointer;
        transition: all 0.3s ease;
      }
      .fs-done-btn:hover { border-color: rgba(249,115,22,0.4); color: #fbbf24; }

      .fs-bottom-spacer { height: 60px; }

      /* Floating jump-to-quiz */
      .fs-jump-quiz {
        position: absolute; bottom: 24px; left: 50%;
        transform: translateX(-50%);
        padding: 10px 18px;
        border-radius: 999px;
        background: rgba(10, 5, 3, 0.9);
        border: 1px solid;
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
        cursor: pointer;
        display: flex; align-items: center; gap: 6px;
        backdrop-filter: blur(8px);
        animation: fsJumpPulse 2s ease-in-out infinite;
      }
      @keyframes fsJumpPulse {
        0%,100% { box-shadow: 0 0 16px rgba(249,115,22,0.2); }
        50% { box-shadow: 0 0 24px rgba(249,115,22,0.45); }
      }
    `}</style>
  )
}
