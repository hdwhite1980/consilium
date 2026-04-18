'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, CheckCircle, BookOpen, Zap, Target, ChevronRight, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react'
import { TRAINING_TRACKS, GLOSSARY, type Lesson, type Track, type QuizQuestion } from '@/app/lib/training-content'

// ── Types ──────────────────────────────────────────────────────
interface Progress {
  lessonProgress: Record<string, { completed: boolean; step: number }>
  quizResults: Record<string, boolean>
  totalCompleted: number
  accuracy: number
}

// ── Helpers ────────────────────────────────────────────────────
const TOTAL_LESSONS = TRAINING_TRACKS.reduce((s, t) => s + t.lessons.length, 0)

function useDarkMode() {
  const [isDark, setIsDark] = useState(true)
  useEffect(() => {
    const check = () => setIsDark(document.documentElement.getAttribute('data-theme') !== 'light')
    check()
    const obs = new MutationObserver(check)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return isDark
}

// ── Quiz Component ─────────────────────────────────────────────
function Quiz({
  questions, lessonId, onComplete, savedResults
}: {
  questions: QuizQuestion[]
  lessonId: string
  onComplete: () => void
  savedResults: Record<string, boolean>
}) {
  const [answers, setAnswers] = useState<Record<string, number | null>>({})
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})

  const isDark = useDarkMode()
  const txt = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)'
  const txt2 = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)'
  const surf2 = isDark ? 'var(--surface2)' : '#f5f7fb'
  const brd = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'

  const handleAnswer = async (q: QuizQuestion, idx: number) => {
    if (answers[q.id] != null) return
    const correct = idx === q.correctIndex
    setAnswers(prev => ({ ...prev, [q.id]: idx }))
    setRevealed(prev => ({ ...prev, [q.id]: true }))

    try {
      await fetch('/api/training', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'quiz_answer', lessonId, questionId: q.id, correct }),
      })
    } catch { /* non-critical */ }
  }

  const allAnswered = questions.every(q => answers[q.id] != null)
  const score = questions.filter(q => answers[q.id] === q.correctIndex).length

  return (
    <div className="space-y-6 pt-2">
      <div className="text-xs font-bold uppercase tracking-widest" style={{ color: '#a78bfa' }}>
        Knowledge check
      </div>

      {questions.map((q, qi) => {
        const chosen = answers[q.id]
        const isRevealed = revealed[q.id]

        return (
          <div key={q.id}>
            <p className="text-sm font-semibold mb-3 leading-relaxed" style={{ color: txt }}>
              {qi + 1}. {q.question}
            </p>
            <div className="space-y-2">
              {q.options.map((opt, i) => {
                let bg = surf2
                let border = brd
                let color = txt2
                let prefix = String.fromCharCode(65 + i) + '·'

                if (isRevealed) {
                  if (i === q.correctIndex) {
                    bg = 'rgba(52,211,153,0.1)'; border = 'rgba(52,211,153,0.3)'; color = '#34d399'; prefix = '✓'
                  } else if (i === chosen && i !== q.correctIndex) {
                    bg = 'rgba(248,113,113,0.1)'; border = 'rgba(248,113,113,0.3)'; color = '#f87171'; prefix = '✗'
                  }
                }

                return (
                  <button key={i} onClick={() => handleAnswer(q, i)} disabled={isRevealed}
                    className="w-full text-left flex items-start gap-3 px-4 py-3 rounded-xl text-xs leading-relaxed transition-all"
                    style={{ background: bg, border: `1px solid ${border}`, color, cursor: isRevealed ? 'default' : 'pointer' }}>
                    <span className="font-mono font-bold shrink-0 mt-0.5">{prefix}</span>
                    <span>{opt}</span>
                  </button>
                )
              })}
            </div>

            {isRevealed && (
              <div className="mt-3 px-4 py-3 rounded-xl text-xs leading-relaxed"
                style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)', color: txt2 }}>
                <span className="font-semibold" style={{ color: '#a78bfa' }}>Explanation: </span>
                {q.explanation}
              </div>
            )}
          </div>
        )
      })}

      {allAnswered && (
        <div className="flex items-center justify-between px-4 py-3 rounded-xl"
          style={{ background: score === questions.length ? 'rgba(52,211,153,0.08)' : 'rgba(251,191,36,0.08)', border: `1px solid ${score === questions.length ? 'rgba(52,211,153,0.2)' : 'rgba(251,191,36,0.2)'}` }}>
          <div>
            <p className="text-sm font-bold" style={{ color: score === questions.length ? '#34d399' : '#fbbf24' }}>
              {score}/{questions.length} correct
            </p>
            <p className="text-xs mt-0.5" style={{ color: txt2 }}>
              {score === questions.length ? 'Perfect — lesson complete!' : 'Good effort — review the explanations above'}
            </p>
          </div>
          <button onClick={onComplete}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
            <CheckCircle size={13} /> Mark complete
          </button>
        </div>
      )}
    </div>
  )
}

// ── Lesson View ────────────────────────────────────────────────
function LessonView({
  lesson, onComplete, onBack, progress
}: {
  lesson: Lesson
  onComplete: (id: string) => void
  onBack: () => void
  progress: Progress
}) {
  const [showQuiz, setShowQuiz] = useState(false)
  const isDark = useDarkMode()
  const txt = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)'
  const txt2 = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)'
  const txt3 = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'
  const surf = isDark ? 'var(--surface)' : '#ffffff'
  const surf2 = isDark ? 'var(--surface2)' : '#f5f7fb'
  const brd = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)'
  const isComplete = progress.lessonProgress[lesson.id]?.completed

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs mb-6 hover:opacity-70 transition-opacity" style={{ color: txt3 }}>
        <ArrowLeft size={13} /> Back to lessons
      </button>

      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-mono uppercase tracking-widest" style={{ color: '#a78bfa' }}>{lesson.duration}</span>
          {isComplete && <span className="text-[10px] font-mono px-2 py-0.5 rounded-full" style={{ background: 'rgba(52,211,153,0.1)', color: '#34d399' }}>Completed</span>}
        </div>
        <h1 className="text-xl font-bold mb-1" style={{ color: txt }}>{lesson.title}</h1>
        <p className="text-sm" style={{ color: txt2 }}>{lesson.subtitle}</p>
      </div>

      <div className="space-y-5">
        {lesson.content.map((section, i) => {
          if (section.type === 'text') return (
            <p key={i} className="text-sm leading-relaxed" style={{ color: txt2 }}>{section.text}</p>
          )

          if (section.type === 'callout') return (
            <div key={i} className="rounded-xl p-4" style={{ background: `${section.color}0d`, border: `1px solid ${section.color}25` }}>
              {section.label && <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: section.color }}>{section.label}</div>}
              <div className="text-xs leading-relaxed whitespace-pre-line" style={{ color: txt }}>{section.text}</div>
            </div>
          )

          if (section.type === 'tip') return (
            <div key={i} className="flex gap-3 p-4 rounded-xl" style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)' }}>
              <span style={{ color: '#34d399', flexShrink: 0, marginTop: 1 }}>💡</span>
              <p className="text-xs leading-relaxed" style={{ color: '#34d399' }}>{section.text}</p>
            </div>
          )

          if (section.type === 'warning') return (
            <div key={i} className="flex gap-3 p-4 rounded-xl" style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.15)' }}>
              <span style={{ color: '#fbbf24', flexShrink: 0, marginTop: 1 }}>⚠</span>
              <p className="text-xs leading-relaxed" style={{ color: '#fbbf24' }}>{section.text}</p>
            </div>
          )

          if (section.type === 'debate_block') return (
            <div key={i} className="rounded-r-xl pl-4 py-3 pr-4"
              style={{ borderLeft: `3px solid ${section.color}`, background: `${section.color}08` }}>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: section.color }}>{section.label}</div>
              <p className="text-xs italic leading-relaxed mb-3" style={{ color: txt2 }}>"{section.text}"</p>
              {section.annotation && (
                <div className="flex gap-2 pt-2 border-t" style={{ borderColor: `${section.color}20` }}>
                  <span className="text-xs" style={{ color: section.color }}>→</span>
                  <p className="text-xs leading-relaxed font-medium" style={{ color: txt }}>{section.annotation}</p>
                </div>
              )}
            </div>
          )

          return null
        })}

        {/* Quiz section */}
        <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${brd}` }}>
          <button
            onClick={() => setShowQuiz(!showQuiz)}
            className="w-full flex items-center justify-between px-5 py-4"
            style={{ background: surf2 }}>
            <div className="flex items-center gap-2">
              <Target size={14} style={{ color: '#a78bfa' }} />
              <span className="text-sm font-semibold" style={{ color: txt }}>Knowledge check — {lesson.quiz.length} questions</span>
            </div>
            {showQuiz ? <ChevronUp size={14} style={{ color: txt3 }} /> : <ChevronDown size={14} style={{ color: txt3 }} />}
          </button>
          {showQuiz && (
            <div className="px-5 pb-5 pt-2" style={{ background: surf }}>
              <Quiz
                questions={lesson.quiz}
                lessonId={lesson.id}
                onComplete={() => onComplete(lesson.id)}
                savedResults={progress.quizResults}
              />
            </div>
          )}
        </div>

        {!isComplete && !showQuiz && (
          <div className="flex justify-end">
            <button onClick={() => onComplete(lesson.id)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
              <CheckCircle size={13} /> Mark as read
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────
export default function TrainingPage() {
  const router = useRouter()
  const [tab, setTab] = useState<'lessons' | 'glossary' | 'progress'>('lessons')
  const [activeLesson, setActiveLesson] = useState<Lesson | null>(null)
  const [expandedTrack, setExpandedTrack] = useState<string | null>('track1')
  const [expandedGlossary, setExpandedGlossary] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress>({ lessonProgress: {}, quizResults: {}, totalCompleted: 0, accuracy: 0 })
  const [loading, setLoading] = useState(true)

  const isDark = useDarkMode()
  const txt = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)'
  const txt2 = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
  const txt3 = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.35)'
  const surf = isDark ? 'var(--surface)' : '#ffffff'
  const surf2 = isDark ? 'var(--surface2)' : '#f5f7fb'
  const brd = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)'

  const loadProgress = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/training')
      const data = await res.json()
      setProgress(data)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadProgress() }, [loadProgress])

  const markComplete = async (lessonId: string) => {
    try {
      await fetch('/api/training', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'lesson_complete', lessonId }),
      })
      await loadProgress()
    } catch { /* ignore */ }
  }

  if (activeLesson) {
    return (
      <div className="min-h-screen" style={{ background: 'var(--bg)', color: txt }}>
        <header className="flex items-center gap-3 px-4 py-3 border-b sticky top-0 z-10"
          style={{ background: surf, borderColor: brd }}>
          <button onClick={() => router.push('/')}
            className="text-xs flex items-center gap-1 hover:opacity-70" style={{ color: txt3 }}>
            <ArrowLeft size={12} /> Home
          </button>
          <div className="w-px h-4" style={{ background: brd }} />
          <button onClick={() => setActiveLesson(null)}
            className="text-xs flex items-center gap-1 hover:opacity-70" style={{ color: txt3 }}>
            Training
          </button>
          <div className="w-px h-4" style={{ background: brd }} />
          <span className="text-xs font-semibold truncate" style={{ color: txt }}>{activeLesson.title}</span>
        </header>
        <LessonView
          lesson={activeLesson}
          onComplete={async (id) => { await markComplete(id); setActiveLesson(null) }}
          onBack={() => setActiveLesson(null)}
          progress={progress}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: txt }}>
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b sticky top-0 z-10 shrink-0"
        style={{ background: surf, borderColor: brd }}>
        <button onClick={() => router.push('/')}
          className="flex items-center gap-1.5 text-xs hover:opacity-70" style={{ color: txt3 }}>
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: brd }} />
        <div className="flex items-center gap-2">
          <BookOpen size={14} style={{ color: '#a78bfa' }} />
          <span className="text-sm font-bold" style={{ color: txt }}>Trading Academy</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-3 text-xs" style={{ color: txt3 }}>
          <span>{progress.totalCompleted}/{TOTAL_LESSONS} lessons</span>
          {progress.accuracy > 0 && <span>{progress.accuracy}% quiz accuracy</span>}
        </div>
      </header>

      {/* Tabs */}
      <div className="flex border-b px-4 shrink-0" style={{ borderColor: brd, background: surf }}>
        {(['lessons', 'glossary', 'progress'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className="px-4 py-2.5 text-xs font-semibold capitalize border-b-2 transition-all"
            style={{ color: tab === t ? '#a78bfa' : txt3, borderColor: tab === t ? '#a78bfa' : 'transparent' }}>
            {t === 'lessons' ? '📚 Lessons' : t === 'glossary' ? '📖 Signal Glossary' : '📊 My Progress'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">

          {/* ── LESSONS TAB ─────────────────────────────────────── */}
          {tab === 'lessons' && (
            <>
              {/* Summary metrics */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Completed', value: `${progress.totalCompleted}/${TOTAL_LESSONS}`, color: '#34d399' },
                  { label: 'Quiz accuracy', value: progress.accuracy > 0 ? `${progress.accuracy}%` : '—', color: progress.accuracy >= 70 ? '#34d399' : '#fbbf24' },
                  { label: 'Tracks', value: `${TRAINING_TRACKS.length} tracks`, color: txt },
                ].map(({ label, value, color }) => (
                  <div key={label} className="rounded-xl p-3" style={{ background: surf2, border: `1px solid ${brd}` }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: txt3 }}>{label}</div>
                    <div className="text-lg font-bold font-mono" style={{ color }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Tracks */}
              {TRAINING_TRACKS.map(track => {
                const trackComplete = track.lessons.filter(l => progress.lessonProgress[l.id]?.completed).length
                const isExpanded = expandedTrack === track.id

                return (
                  <div key={track.id} className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${brd}` }}>
                    <button
                      onClick={() => setExpandedTrack(isExpanded ? null : track.id)}
                      className="w-full flex items-center gap-3 px-5 py-4 text-left"
                      style={{ background: surf2 }}>
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: track.color }} />
                      <div className="flex-1">
                        <div className="text-sm font-bold" style={{ color: txt }}>{track.title}</div>
                        <div className="text-xs mt-0.5" style={{ color: txt3 }}>{track.description}</div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-xs font-mono" style={{ color: txt3 }}>{trackComplete}/{track.lessons.length}</span>
                        {isExpanded ? <ChevronUp size={14} style={{ color: txt3 }} /> : <ChevronDown size={14} style={{ color: txt3 }} />}
                      </div>
                    </button>

                    {isExpanded && (
                      <div style={{ background: surf }}>
                        {track.lessons.map((lesson, i) => {
                          const lessonDone = progress.lessonProgress[lesson.id]?.completed
                          const isLocked = i > 0 && !progress.lessonProgress[track.lessons[i - 1].id]?.completed

                          return (
                            <button
                              key={lesson.id}
                              onClick={() => !isLocked && setActiveLesson(lesson)}
                              disabled={isLocked}
                              className="w-full flex items-center gap-4 px-5 py-4 text-left transition-all border-t"
                              style={{ borderColor: brd, opacity: isLocked ? 0.4 : 1, cursor: isLocked ? 'not-allowed' : 'pointer' }}
                              onMouseEnter={e => !isLocked && (e.currentTarget.style.background = surf2)}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>

                              <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                                style={{ background: lessonDone ? 'rgba(52,211,153,0.15)' : surf2, border: `1px solid ${lessonDone ? 'rgba(52,211,153,0.3)' : brd}` }}>
                                {lessonDone
                                  ? <CheckCircle size={13} style={{ color: '#34d399' }} />
                                  : <span className="text-[11px] font-mono" style={{ color: txt3 }}>{i + 1}</span>}
                              </div>

                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-semibold truncate" style={{ color: txt }}>{lesson.title}</div>
                                <div className="text-xs mt-0.5" style={{ color: txt3 }}>{lesson.subtitle} · {lesson.duration}</div>
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                {lesson.quiz.length > 0 && (
                                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                                    style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa' }}>
                                    {lesson.quiz.length}Q
                                  </span>
                                )}
                                <ChevronRight size={13} style={{ color: txt3 }} />
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}

          {/* ── GLOSSARY TAB ─────────────────────────────────────── */}
          {tab === 'glossary' && (
            <div className="space-y-3">
              <p className="text-xs" style={{ color: txt3 }}>
                {GLOSSARY.length} signals explained — how each one is used in real debates and why it matters for verdicts.
              </p>
              {GLOSSARY.map(entry => {
                const isOpen = expandedGlossary === entry.term
                return (
                  <div key={entry.term} className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${brd}` }}>
                    <button
                      onClick={() => setExpandedGlossary(isOpen ? null : entry.term)}
                      className="w-full flex items-start gap-4 px-5 py-4 text-left"
                      style={{ background: surf2 }}>
                      <div className="flex-1">
                        <div className="text-sm font-bold mb-0.5" style={{ color: txt }}>{entry.term}</div>
                        <div className="text-xs" style={{ color: txt3 }}>{entry.oneLiner}</div>
                      </div>
                      {isOpen ? <ChevronUp size={14} style={{ color: txt3, marginTop: 3, flexShrink: 0 }} /> : <ChevronDown size={14} style={{ color: txt3, marginTop: 3, flexShrink: 0 }} />}
                    </button>

                    {isOpen && (
                      <div className="px-5 pb-5 pt-2 space-y-4" style={{ background: surf }}>
                        <p className="text-xs leading-relaxed" style={{ color: txt2 }}>{entry.explanation}</p>

                        <div className="rounded-xl p-3" style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
                          <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#a78bfa' }}>How it shifts the debate</div>
                          <p className="text-xs leading-relaxed" style={{ color: txt2 }}>{entry.debateImpact}</p>
                        </div>

                        <div className="rounded-xl p-3" style={{ background: surf2, border: `1px solid ${brd}` }}>
                          <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: txt3 }}>Real example</div>
                          <p className="text-xs leading-relaxed italic" style={{ color: txt2 }}>{entry.example}</p>
                        </div>

                        <button onClick={() => router.push(`/?ticker=${entry.term.split(' ')[0]}`)}
                          className="text-xs px-3 py-1.5 rounded-lg font-semibold transition-all hover:opacity-80"
                          style={{ background: 'rgba(167,139,250,0.08)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.15)' }}>
                          Run an analysis to see {entry.term.split('—')[0].trim()} in action →
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* ── PROGRESS TAB ─────────────────────────────────────── */}
          {tab === 'progress' && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Lessons done', value: `${progress.totalCompleted}`, sub: `of ${TOTAL_LESSONS} total` },
                  { label: 'Quiz accuracy', value: progress.accuracy > 0 ? `${progress.accuracy}%` : '—', sub: 'correct answers', color: progress.accuracy >= 70 ? '#34d399' : '#fbbf24' },
                  { label: 'Tracks started', value: String(TRAINING_TRACKS.filter(t => t.lessons.some(l => progress.lessonProgress[l.id]?.completed)).length), sub: `of ${TRAINING_TRACKS.length} tracks` },
                  { label: 'Completion', value: `${Math.round((progress.totalCompleted / TOTAL_LESSONS) * 100)}%`, sub: 'of curriculum', color: '#a78bfa' },
                ].map(({ label, value, sub, color }) => (
                  <div key={label} className="rounded-xl p-3" style={{ background: surf2, border: `1px solid ${brd}` }}>
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: txt3 }}>{label}</div>
                    <div className="text-xl font-bold font-mono" style={{ color: color ?? txt }}>{value}</div>
                    <div className="text-[10px] mt-0.5" style={{ color: txt3 }}>{sub}</div>
                  </div>
                ))}
              </div>

              {/* Track-by-track breakdown */}
              {TRAINING_TRACKS.map(track => {
                const done = track.lessons.filter(l => progress.lessonProgress[l.id]?.completed).length
                const pct = Math.round((done / track.lessons.length) * 100)
                return (
                  <div key={track.id} className="rounded-2xl p-4" style={{ background: surf, border: `1px solid ${brd}` }}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold" style={{ color: txt }}>{track.title}</span>
                      <span className="text-xs font-mono" style={{ color: txt3 }}>{done}/{track.lessons.length}</span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: surf2 }}>
                      <div className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${pct}%`, background: track.color }} />
                    </div>
                    <div className="mt-3 space-y-1.5">
                      {track.lessons.map(l => (
                        <div key={l.id} className="flex items-center justify-between text-xs">
                          <span style={{ color: progress.lessonProgress[l.id]?.completed ? txt2 : txt3 }}>{l.title}</span>
                          {progress.lessonProgress[l.id]?.completed
                            ? <CheckCircle size={11} style={{ color: '#34d399' }} />
                            : <span style={{ color: txt3 }}>—</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}

              <button onClick={loadProgress}
                className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg transition-all hover:opacity-70"
                style={{ color: txt3, border: `1px solid ${brd}` }}>
                <RotateCcw size={11} /> Refresh progress
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
