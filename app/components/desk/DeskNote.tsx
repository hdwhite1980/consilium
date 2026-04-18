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

function normalizeBlocks(lesson: InvestLesson): LessonBlock[] {
  if (lesson.blocks && lesson.blocks.length) return lesson.blocks
  const blocks: LessonBlock[] = []
  for (const p of lesson.content) blocks.push({ type: 'prose', text: p })
  if (lesson.callout) blocks.push({ type: 'callout', label: lesson.callout.label, text: lesson.callout.text, tone: 'gold' })
  if (lesson.tip) blocks.push({ type: 'tip', text: lesson.tip })
  return blocks
}

export function DeskNote({ lesson, balance, onClose, onComplete, alreadyCompleted }: Props) {
  const blocks = useMemo(() => normalizeBlocks(lesson), [lesson])
  const [quizAnswer, setQuizAnswer] = useState<number | null>(null)
  const [quizSubmitted, setQuizSubmitted] = useState(false)
  const [scrollPct, setScrollPct] = useState(0)
  const [showFloatingQuizBtn, setShowFloatingQuizBtn] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const quizRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const orig = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = orig }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const handler = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      const pct = Math.min(100, (scrollTop / Math.max(1, scrollHeight - clientHeight)) * 100)
      setScrollPct(pct)
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

  const tierColor: Record<string, string> = {
    Buyer: '#14b8a6',
    Builder: '#3b82f6',
    Operator: '#6366f1',
    Principal: '#d4a857',
    Sovereign: '#f5f5f5',
  }
  const accent = tierColor[lesson.stage] ?? '#d4a857'

  // Desk note number — generate a stable display number from the lesson id
  const noteNumber = useMemo(() => {
    const map: Record<string, string> = {
      'buyer-1': '001', 'buyer-2': '002', 'buyer-loss': '003', 'buyer-behavior': '004',
      'builder-1': '005', 'builder-behavior': '006',
      'operator-1': '007', 'operator-2': '008', 'operator-tilt': '009',
      'principal-1': '010',
    }
    return map[lesson.id] ?? '—'
  }, [lesson.id])

  return (
    <div className="dn-overlay" role="dialog" aria-modal="true" aria-labelledby="dn-title">
      <div className="dn-scrim" />
      <div className="dn-column">

        <header className="dn-top">
          <button className="dn-close-btn" onClick={onClose} aria-label="Close note">
            <X size={16} />
          </button>
          <div className="dn-top-center">
            <div className="dn-dateline" style={{ color: accent }}>
              Desk note {noteNumber} · {lesson.stage} · {lesson.duration}
            </div>
          </div>
          <div style={{ width: 28 }} />
        </header>

        <div className="dn-progress">
          <div className="dn-progress-fill" style={{ width: `${scrollPct}%`, background: accent }} />
        </div>

        <div className="dn-content" ref={contentRef}>

          <div className="dn-hero">
            <div className="dn-hero-glyph" style={{ color: accent, borderColor: accent }} aria-hidden>
              {lesson.icon}
            </div>
            <h1 id="dn-title" className="dn-title">{lesson.title}</h1>
            <p className="dn-subtitle">{lesson.subtitle}</p>
          </div>

          <div className="dn-blocks">
            {blocks.map((block, i) => <Block key={i} block={block} balance={balance} />)}
          </div>

          <div ref={quizRef} className="dn-quiz-wrap">
            <div className="dn-quiz-divider" />
            <div className="dn-quiz-eyebrow">Comprehension check</div>
            <h2 className="dn-quiz-question">{lesson.quiz.question}</h2>

            <div className="dn-quiz-options">
              {lesson.quiz.options.map((opt, idx) => {
                const isSelected = quizAnswer === idx
                const isCorrect = quizSubmitted && idx === lesson.quiz.correctIndex
                const isWrong = quizSubmitted && isSelected && idx !== lesson.quiz.correctIndex
                return (
                  <button
                    key={idx}
                    onClick={() => { if (!quizSubmitted) setQuizAnswer(idx) }}
                    disabled={quizSubmitted}
                    className={`dn-quiz-option ${isSelected ? 'selected' : ''} ${isCorrect ? 'correct' : ''} ${isWrong ? 'wrong' : ''}`}
                  >
                    <span className="dn-quiz-letter">{String.fromCharCode(65 + idx)}</span>
                    <span className="dn-quiz-text">{opt}</span>
                    {isCorrect && <Check size={16} style={{ color: '#10b981', flexShrink: 0 }} />}
                    {isWrong && <X size={16} style={{ color: '#dc2626', flexShrink: 0 }} />}
                  </button>
                )
              })}
            </div>

            {!quizSubmitted && (
              <button
                className="dn-quiz-submit"
                onClick={submitQuiz}
                disabled={quizAnswer == null}
              >
                {quizAnswer == null ? 'Choose an answer' : 'Submit →'}
              </button>
            )}

            {quizSubmitted && (
              <div className={`dn-quiz-explanation ${quizAnswer === lesson.quiz.correctIndex ? 'right' : 'wrong'}`}>
                <div className="dn-quiz-explanation-label">
                  {quizAnswer === lesson.quiz.correctIndex ? 'Correct' : 'Not quite'}
                </div>
                <p>{lesson.quiz.explanation}</p>
              </div>
            )}

            {(quizSubmitted || alreadyCompleted) && (
              <button className="dn-done-btn" onClick={onClose}>
                Return to the floor
              </button>
            )}
          </div>

          <div className="dn-bottom-spacer" />
        </div>

        {showFloatingQuizBtn && (
          <button className="dn-jump-quiz" onClick={scrollToQuiz} style={{ borderColor: accent, color: accent }}>
            <ChevronDown size={12} /> Comprehension check
          </button>
        )}
      </div>

      <DeskNoteStyles accent={accent} />
    </div>
  )
}

function Block({ block, balance }: { block: LessonBlock; balance?: number }) {
  switch (block.type) {
    case 'heading':
      return <h2 className="dn-block-heading">{block.text}</h2>
    case 'prose':
      return <p className="dn-block-prose">{block.text}</p>
    case 'pullquote':
      return (
        <blockquote className="dn-block-pullquote">
          {block.text}
        </blockquote>
      )
    case 'callout':
      return (
        <div className={`dn-block-callout tone-${block.tone ?? 'gold'}`}>
          <div className="dn-block-callout-label">{block.label}</div>
          <pre className="dn-block-callout-text">{block.text}</pre>
        </div>
      )
    case 'tip':
      return (
        <div className="dn-block-tip">
          <span className="dn-block-tip-icon" aria-hidden>→</span>
          <p>{block.text}</p>
        </div>
      )
    case 'warning':
      return (
        <div className="dn-block-warning">
          <span className="dn-block-warning-icon" aria-hidden>!</span>
          <p>{block.text}</p>
        </div>
      )
    case 'demo':
      return (
        <div className="dn-block-demo">
          <LessonDemo demo={block.demo} balance={balance} />
          {block.caption && <p className="dn-block-demo-caption">{block.caption}</p>}
        </div>
      )
  }
}

function DeskNoteStyles({ accent }: { accent: string }) {
  return (
    <style jsx global>{`
      @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,500;8..60,600&family=Inter:wght@300;400;500;600&family=IBM+Plex+Mono:wght@300;400;500&display=swap');

      .dn-overlay {
        position: fixed; inset: 0; z-index: 80;
        display: flex; justify-content: center;
        animation: dnFadeIn 0.3s ease;
      }
      @keyframes dnFadeIn { from { opacity: 0; } to { opacity: 1; } }

      .dn-scrim {
        position: absolute; inset: 0;
        background: rgba(6, 10, 18, 0.94);
        backdrop-filter: blur(14px);
      }

      .dn-column {
        position: relative;
        width: 100%; max-width: 720px;
        display: flex; flex-direction: column;
        animation: dnRise 0.4s cubic-bezier(0.22, 1, 0.36, 1);
        font-family: 'Source Serif 4', Georgia, serif;
        color: rgba(241, 245, 249, 0.92);
      }
      @keyframes dnRise {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .dn-top {
        display: flex; align-items: center; justify-content: space-between;
        padding: 18px 24px 14px;
      }
      .dn-close-btn {
        width: 28px; height: 28px; border-radius: 6px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(148, 163, 184, 0.2);
        color: rgba(148, 163, 184, 0.8);
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; transition: all 0.2s ease;
      }
      .dn-close-btn:hover { color: #f5f5f5; border-color: rgba(212, 168, 87, 0.5); }
      .dn-top-center { flex: 1; text-align: center; }
      .dn-dateline {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        font-weight: 500;
      }

      .dn-progress {
        height: 1px;
        background: rgba(148, 163, 184, 0.1);
        margin: 0 24px;
      }
      .dn-progress-fill {
        height: 100%;
        transition: width 0.2s ease;
      }

      .dn-content {
        flex: 1; overflow-y: auto;
        padding: 32px 32px 40px;
        scroll-behavior: smooth;
        scrollbar-width: thin;
        scrollbar-color: rgba(148, 163, 184, 0.2) transparent;
      }
      .dn-content::-webkit-scrollbar { width: 6px; }
      .dn-content::-webkit-scrollbar-track { background: transparent; }
      .dn-content::-webkit-scrollbar-thumb {
        background: rgba(148, 163, 184, 0.15); border-radius: 3px;
      }

      .dn-hero {
        text-align: center;
        padding: 24px 0 40px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.1);
        margin-bottom: 40px;
      }
      .dn-hero-glyph {
        display: inline-flex; align-items: center; justify-content: center;
        width: 48px; height: 48px;
        border: 1.5px solid;
        border-radius: 4px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 20px;
        font-weight: 300;
        margin-bottom: 18px;
      }
      .dn-title {
        font-family: 'Source Serif 4', Georgia, serif;
        font-size: 32px;
        font-weight: 500;
        letter-spacing: -0.02em;
        line-height: 1.15;
        margin: 0 0 12px;
        color: #f5f5f5;
      }
      @media (min-width: 640px) { .dn-title { font-size: 40px; } }
      .dn-subtitle {
        font-family: 'Source Serif 4', Georgia, serif;
        font-size: 17px;
        color: rgba(148, 163, 184, 0.85);
        margin: 0;
        line-height: 1.5;
        font-weight: 400;
        font-style: italic;
      }

      .dn-blocks { max-width: 600px; margin: 0 auto; }

      .dn-block-heading {
        font-family: 'Source Serif 4', serif;
        font-size: 22px;
        font-weight: 600;
        color: #f5f5f5;
        margin: 36px 0 14px;
        letter-spacing: -0.01em;
      }
      .dn-block-prose {
        font-family: 'Source Serif 4', Georgia, serif;
        font-size: 17px;
        line-height: 1.75;
        color: rgba(226, 232, 240, 0.88);
        margin: 0 0 22px;
      }
      .dn-block-pullquote {
        font-family: 'Source Serif 4', Georgia, serif;
        font-size: 24px;
        font-weight: 400;
        line-height: 1.4;
        color: #f5f5f5;
        margin: 40px 0;
        padding: 24px 0 24px 28px;
        border-left: 3px solid ${accent};
        font-style: italic;
      }
      @media (min-width: 640px) { .dn-block-pullquote { font-size: 28px; } }

      .dn-block-callout {
        padding: 20px 22px;
        border-radius: 8px;
        margin: 28px 0;
        border: 1px solid;
        border-left-width: 3px;
      }
      .dn-block-callout.tone-gold {
        background: rgba(212, 168, 87, 0.06);
        border-color: rgba(212, 168, 87, 0.25);
        border-left-color: #d4a857;
      }
      .dn-block-callout.tone-red {
        background: rgba(220, 38, 38, 0.06);
        border-color: rgba(220, 38, 38, 0.25);
        border-left-color: #dc2626;
      }
      .dn-block-callout.tone-green {
        background: rgba(16, 185, 129, 0.06);
        border-color: rgba(16, 185, 129, 0.25);
        border-left-color: #10b981;
      }
      .dn-block-callout-label {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase;
        margin-bottom: 12px; color: #d4a857; font-weight: 500;
      }
      .dn-block-callout.tone-red .dn-block-callout-label { color: #dc2626; }
      .dn-block-callout.tone-green .dn-block-callout-label { color: #10b981; }
      .dn-block-callout-text {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 13px; line-height: 1.8;
        color: rgba(226, 232, 240, 0.85);
        white-space: pre-wrap; margin: 0;
      }

      .dn-block-tip {
        display: flex; gap: 14px;
        padding: 16px 18px;
        border-radius: 6px;
        background: rgba(16, 185, 129, 0.05);
        border: 1px solid rgba(16, 185, 129, 0.18);
        border-left: 3px solid #10b981;
        margin: 22px 0;
      }
      .dn-block-tip-icon {
        color: #10b981;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 18px; line-height: 1.2; font-weight: 500;
      }
      .dn-block-tip p {
        font-family: 'Source Serif 4', Georgia, serif;
        font-size: 15px; line-height: 1.6;
        color: rgba(226, 232, 240, 0.85);
        margin: 0;
        font-style: italic;
      }

      .dn-block-warning {
        display: flex; gap: 14px;
        padding: 16px 18px;
        border-radius: 6px;
        background: rgba(220, 38, 38, 0.06);
        border: 1px solid rgba(220, 38, 38, 0.2);
        border-left: 3px solid #dc2626;
        margin: 22px 0;
      }
      .dn-block-warning-icon {
        color: #dc2626;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 18px; line-height: 1.2; font-weight: 500;
      }
      .dn-block-warning p {
        font-family: 'Source Serif 4', Georgia, serif;
        font-size: 15px; line-height: 1.6;
        color: rgba(226, 232, 240, 0.88);
        margin: 0;
      }

      .dn-block-demo { margin: 36px 0; }
      .dn-block-demo-caption {
        text-align: center;
        font-family: 'Source Serif 4', Georgia, serif;
        font-size: 12px; font-style: italic;
        color: rgba(148, 163, 184, 0.5);
        margin: 12px 0 0;
      }

      /* ═══ DEMO INTERNALS (fl-*) ═══════════════════════════ */
      .fl-demo {
        padding: 22px 24px;
        border-radius: 8px;
        background: rgba(15, 23, 42, 0.7);
        border: 1px solid rgba(148, 163, 184, 0.15);
      }
      .fl-demo .mono { font-family: 'IBM Plex Mono', monospace; }
      .fl-demo .big { font-size: 22px; font-weight: 500; letter-spacing: -0.01em; }
      .fl-dim { color: rgba(148, 163, 184, 0.5); margin-left: 6px; font-size: 12px; }
      .fl-demo-label {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
        color: rgba(148, 163, 184, 0.6);
        margin-bottom: 14px;
      }
      .fl-demo-slider-wrap { margin: 12px 0 18px; }
      .fl-slider {
        width: 100%; height: 3px;
        -webkit-appearance: none; appearance: none;
        background: linear-gradient(90deg, #d4a857 0%, #d4a857 var(--fill, 50%), rgba(148, 163, 184, 0.15) var(--fill, 50%), rgba(148, 163, 184, 0.15) 100%);
        border-radius: 2px; outline: 0;
      }
      .fl-slider::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none;
        width: 16px; height: 16px; border-radius: 50%;
        background: #f5f5f5;
        cursor: pointer; border: 2px solid #d4a857;
      }
      .fl-slider::-moz-range-thumb {
        width: 16px; height: 16px; border-radius: 50%;
        background: #f5f5f5;
        cursor: pointer; border: 2px solid #d4a857;
      }
      .fl-demo-pct-display {
        display: flex; align-items: baseline; gap: 4px;
        margin-top: 10px;
        color: #f5f5f5;
      }
      .fl-demo-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 10px;
        margin: 16px 0 12px;
      }
      .fl-demo-stat {
        padding: 10px 12px;
        border-radius: 6px;
        background: rgba(15, 23, 42, 0.5);
        border: 1px solid rgba(148, 163, 184, 0.1);
      }
      .fl-demo-stat-label {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 8px; letter-spacing: 0.18em; text-transform: uppercase;
        color: rgba(148, 163, 184, 0.6);
        margin-bottom: 6px;
      }
      .fl-demo-stat-val {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 16px; font-weight: 500;
        color: #f5f5f5;
      }
      .fl-demo-stat-sub {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; color: rgba(148, 163, 184, 0.5);
        margin-top: 2px;
      }
      .tone-safe { color: #10b981 !important; }
      .tone-caution { color: #d4a857 !important; }
      .tone-danger { color: #dc2626 !important; }

      .fl-demo-verdict {
        margin-top: 14px;
        padding: 10px 14px;
        border-radius: 6px;
        font-family: 'Source Serif 4', Georgia, serif;
        font-size: 13px; line-height: 1.5;
        font-style: italic;
      }
      .fl-demo-verdict.tone-safe {
        background: rgba(16, 185, 129, 0.06);
        border: 1px solid rgba(16, 185, 129, 0.2);
        color: #86efac;
      }
      .fl-demo-verdict.tone-caution {
        background: rgba(212, 168, 87, 0.06);
        border: 1px solid rgba(212, 168, 87, 0.2);
        color: #eab308;
      }
      .fl-demo-verdict.tone-danger {
        background: rgba(220, 38, 38, 0.06);
        border: 1px solid rgba(220, 38, 38, 0.2);
        color: #fca5a5;
      }

      .fl-demo-curve-wrap { margin: 8px 0 18px; }
      .fl-demo-svg { width: 100%; height: auto; max-height: 180px; }

      .fl-ladder {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 4px; margin-bottom: 14px;
      }
      .fl-ladder-rung {
        padding: 10px 6px;
        border-radius: 4px;
        background: rgba(15, 23, 42, 0.5);
        border: 1px solid rgba(148, 163, 184, 0.1);
        cursor: pointer;
        display: flex; flex-direction: column; align-items: center; gap: 4px;
        transition: all 0.2s ease;
      }
      .fl-ladder-rung:hover { border-color: rgba(212, 168, 87, 0.4); }
      .fl-ladder-rung.active {
        background: rgba(212, 168, 87, 0.1);
        border-color: #d4a857;
      }
      .fl-ladder-mult {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; color: rgba(148, 163, 184, 0.7);
        letter-spacing: 0.05em;
      }
      .fl-ladder-rung.active .fl-ladder-mult { color: #d4a857; }
      .fl-ladder-price {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px; font-weight: 500;
        color: #f5f5f5;
      }

      .fl-demo-two-sliders {
        display: flex; flex-direction: column; gap: 18px;
        margin-bottom: 16px;
      }

      /* ═══ QUIZ ═══════════════════════════════════════════════ */
      .dn-quiz-wrap { max-width: 600px; margin: 48px auto 0; }
      .dn-quiz-divider {
        width: 48px; height: 1px;
        background: ${accent};
        margin: 0 auto 24px;
      }
      .dn-quiz-eyebrow {
        text-align: center;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: 0.28em; text-transform: uppercase;
        color: ${accent};
        margin-bottom: 14px;
        font-weight: 500;
      }
      .dn-quiz-question {
        font-family: 'Source Serif 4', Georgia, serif;
        font-size: 22px;
        font-weight: 500;
        line-height: 1.4;
        color: #f5f5f5;
        margin: 0 0 24px;
        text-align: center;
        letter-spacing: -0.01em;
      }
      .dn-quiz-options { display: flex; flex-direction: column; gap: 10px; }
      .dn-quiz-option {
        display: flex; align-items: flex-start; gap: 14px;
        padding: 16px 18px;
        border-radius: 6px;
        background: rgba(15, 23, 42, 0.5);
        border: 1px solid rgba(148, 163, 184, 0.12);
        text-align: left;
        cursor: pointer;
        transition: all 0.2s ease;
        color: rgba(226, 232, 240, 0.88);
        font-family: 'Source Serif 4', Georgia, serif;
        font-size: 14px; line-height: 1.5;
      }
      .dn-quiz-option:not(:disabled):hover {
        border-color: rgba(212, 168, 87, 0.3);
        background: rgba(212, 168, 87, 0.04);
      }
      .dn-quiz-option.selected {
        border-color: ${accent};
        background: rgba(212, 168, 87, 0.06);
      }
      .dn-quiz-option.correct {
        border-color: rgba(16, 185, 129, 0.5);
        background: rgba(16, 185, 129, 0.06);
      }
      .dn-quiz-option.wrong {
        border-color: rgba(220, 38, 38, 0.4);
        background: rgba(220, 38, 38, 0.04);
      }
      .dn-quiz-option:disabled { cursor: default; }
      .dn-quiz-letter {
        flex-shrink: 0;
        width: 24px; height: 24px; border-radius: 4px;
        background: rgba(148, 163, 184, 0.1);
        display: flex; align-items: center; justify-content: center;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px; font-weight: 500;
        color: rgba(148, 163, 184, 0.8);
      }
      .dn-quiz-option.selected .dn-quiz-letter { background: ${accent}; color: #0a0e17; }
      .dn-quiz-option.correct .dn-quiz-letter { background: #10b981; color: #064e3b; }
      .dn-quiz-option.wrong .dn-quiz-letter { background: #dc2626; color: #450a0a; }

      .dn-quiz-submit {
        display: block; width: 100%;
        margin-top: 22px;
        padding: 14px;
        border-radius: 6px;
        background: ${accent};
        border: 0; color: #0a0e17;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase;
        font-weight: 600; cursor: pointer;
        transition: all 0.2s ease;
      }
      .dn-quiz-submit:disabled {
        opacity: 0.3; cursor: not-allowed;
        background: rgba(148, 163, 184, 0.15);
        color: rgba(148, 163, 184, 0.5);
      }
      .dn-quiz-submit:not(:disabled):hover { filter: brightness(1.1); }

      .dn-quiz-explanation {
        margin-top: 22px;
        padding: 18px 20px;
        border-radius: 6px;
        border-left: 3px solid;
      }
      .dn-quiz-explanation.right {
        background: rgba(16, 185, 129, 0.05);
        border: 1px solid rgba(16, 185, 129, 0.2);
        border-left-color: #10b981;
      }
      .dn-quiz-explanation.wrong {
        background: rgba(220, 38, 38, 0.05);
        border: 1px solid rgba(220, 38, 38, 0.2);
        border-left-color: #dc2626;
      }
      .dn-quiz-explanation-label {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase;
        margin-bottom: 8px; font-weight: 500;
      }
      .dn-quiz-explanation.right .dn-quiz-explanation-label { color: #10b981; }
      .dn-quiz-explanation.wrong .dn-quiz-explanation-label { color: #dc2626; }
      .dn-quiz-explanation p {
        font-family: 'Source Serif 4', Georgia, serif;
        font-size: 14px; line-height: 1.65;
        color: rgba(226, 232, 240, 0.85);
        margin: 0;
      }

      .dn-done-btn {
        display: block; width: 100%;
        margin-top: 22px;
        padding: 14px;
        border-radius: 6px;
        background: transparent;
        border: 1px solid rgba(148, 163, 184, 0.2);
        color: rgba(148, 163, 184, 0.8);
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase;
        cursor: pointer; font-weight: 500;
        transition: all 0.2s ease;
      }
      .dn-done-btn:hover { border-color: ${accent}; color: ${accent}; }

      .dn-bottom-spacer { height: 60px; }

      .dn-jump-quiz {
        position: absolute; bottom: 24px; left: 50%;
        transform: translateX(-50%);
        padding: 10px 18px;
        border-radius: 999px;
        background: rgba(6, 10, 18, 0.92);
        border: 1px solid;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
        cursor: pointer; font-weight: 500;
        display: flex; align-items: center; gap: 6px;
        backdrop-filter: blur(8px);
      }
    `}</style>
  )
}
