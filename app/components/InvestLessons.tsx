'use client'

import { useState, useEffect } from 'react'
import { Lock, CheckCircle, ChevronRight, ChevronDown, X, BookOpen, Flame } from 'lucide-react'
import { getAvailableLessons, INVEST_LESSONS, type LessonWithStatus } from '@/app/lib/invest-lessons'

interface Props {
  currentStage: string
  totalTrades: number
  closedTrades: number
  isDark: boolean
}

interface ProgressEntry {
  lesson_id: string
  correct: boolean
  quiz_answer: number
}

const STAGE_COLORS: Record<string, string> = {
  Spark: '#fbbf24',
  Ember: '#f97316',
  Flame: '#ef4444',
  Blaze: '#a78bfa',
  Inferno: '#60a5fa',
  Free: '#34d399',
}

export default function InvestLessons({ currentStage, totalTrades, closedTrades, isDark }: Props) {
  const [progress, setProgress] = useState<ProgressEntry[]>([])
  const [openLesson, setOpenLesson] = useState<string | null>(null)
  const [quizAnswer, setQuizAnswer] = useState<number | null>(null)
  const [quizSubmitted, setQuizSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)

  const txt  = isDark ? 'rgba(255,255,255,0.9)'  : 'rgba(0,0,0,0.9)'
  const txt2 = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
  const txt3 = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.35)'
  const surf = isDark ? '#111620' : '#ffffff'
  const surf2 = isDark ? '#181e2a' : '#f5f7fb'
  const brd  = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)'

  useEffect(() => {
    fetch('/api/invest/lessons')
      .then(r => r.json())
      .then(d => setProgress(d.progress ?? []))
      .catch(() => {})
  }, [])

  const completedIds = new Set(progress.filter(p => p.correct).map(p => p.lesson_id))
  const hasClosedTrade = closedTrades > 0
  const lessons = getAvailableLessons(currentStage, completedIds, totalTrades, hasClosedTrade)

  const completedCount = completedIds.size
  const totalCount = INVEST_LESSONS.length
  const progressPct = Math.round((completedCount / totalCount) * 100)

  // Next unlocked incomplete lesson
  const nextLesson = lessons.find(l => !l.locked && !completedIds.has(l.id))

  const openLessonData = openLesson ? lessons.find(l => l.id === openLesson) : null

  const submitQuiz = async () => {
    if (quizAnswer === null || !openLessonData || saving) return
    setSaving(true)
    const correct = quizAnswer === openLessonData.quiz.correctIndex
    await fetch('/api/invest/lessons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId: openLessonData.id, quizAnswer, correct }),
    })
    setProgress(prev => {
      const filtered = prev.filter(p => p.lesson_id !== openLessonData.id)
      return [...filtered, { lesson_id: openLessonData.id, correct, quiz_answer: quizAnswer }]
    })
    setQuizSubmitted(true)
    setSaving(false)
  }

  const closeLesson = () => {
    setOpenLesson(null)
    setQuizAnswer(null)
    setQuizSubmitted(false)
  }

  // Group by stage
  const STAGES = ['Spark', 'Ember', 'Flame', 'Blaze', 'Inferno'] as const
  const STAGE_ORDER = ['Spark', 'Ember', 'Flame', 'Blaze', 'Inferno', 'Free']
  const currentStageIdx = STAGE_ORDER.indexOf(currentStage)

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen size={14} style={{ color: '#a78bfa' }} />
          <span className="text-sm font-bold" style={{ color: txt }}>Trading Skills</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-xs font-mono" style={{ color: txt3 }}>{completedCount}/{totalCount}</div>
          <div className="w-20 h-1.5 rounded-full overflow-hidden" style={{ background: surf2 }}>
            <div className="h-full rounded-full transition-all duration-700"
              style={{ width: `${progressPct}%`, background: 'linear-gradient(90deg,#a78bfa,#7c3aed)' }} />
          </div>
        </div>
      </div>

      {/* Next lesson CTA */}
      {nextLesson && (
        <button onClick={() => { setOpenLesson(nextLesson.id); setQuizAnswer(null); setQuizSubmitted(false) }}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left hover:opacity-90 transition-all"
          style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)' }}>
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-base"
            style={{ background: 'rgba(167,139,250,0.12)' }}>
            {nextLesson.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold truncate" style={{ color: '#a78bfa' }}>Up next</div>
            <div className="text-sm font-bold truncate" style={{ color: txt }}>{nextLesson.title}</div>
          </div>
          <ChevronRight size={14} style={{ color: '#a78bfa', flexShrink: 0 }} />
        </button>
      )}

      {/* Lessons by stage */}
      {STAGES.map(stage => {
        const stageLessons = lessons.filter(l => l.stage === stage)
        if (!stageLessons.length) return null
        const stageIdx = STAGE_ORDER.indexOf(stage)
        const stageUnlocked = stageIdx <= currentStageIdx
        const stageColor = STAGE_COLORS[stage]
        const stageCompleted = stageLessons.every(l => completedIds.has(l.id))

        return (
          <div key={stage}>
            {/* Stage header */}
            <div className="flex items-center gap-2 mb-2">
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: stageUnlocked ? stageColor : txt3 }} />
              <span className="text-[10px] font-bold uppercase tracking-widest"
                style={{ color: stageUnlocked ? stageColor : txt3 }}>
                {stage} stage
              </span>
              {stageCompleted && <CheckCircle size={11} style={{ color: '#34d399' }} />}
              {!stageUnlocked && <Lock size={10} style={{ color: txt3 }} />}
            </div>

            {/* Lesson cards */}
            <div className="space-y-1.5">
              {stageLessons.map(lesson => {
                const isCompleted = completedIds.has(lesson.id)
                const isBehavioral = !!lesson.requiresBehavior
                const isOpen = openLesson === lesson.id

                return (
                  <div key={lesson.id}>
                    <button
                      onClick={() => {
                        if (lesson.locked) return
                        if (isOpen) { closeLesson(); return }
                        setOpenLesson(lesson.id)
                        setQuizAnswer(null)
                        setQuizSubmitted(false)
                      }}
                      disabled={lesson.locked}
                      className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl text-left transition-all"
                      style={{
                        background: isOpen ? (isDark ? '#1a2236' : '#eef2ff') : surf,
                        border: `1px solid ${isOpen ? 'rgba(167,139,250,0.25)' : brd}`,
                        opacity: lesson.locked ? 0.45 : 1,
                        cursor: lesson.locked ? 'not-allowed' : 'pointer',
                      }}>
                      {/* Icon / status */}
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-sm"
                        style={{
                          background: isCompleted ? 'rgba(52,211,153,0.1)' :
                            lesson.locked ? surf2 :
                            isBehavioral ? 'rgba(249,115,22,0.1)' : 'rgba(167,139,250,0.08)',
                        }}>
                        {isCompleted ? <CheckCircle size={14} style={{ color: '#34d399' }} /> :
                         lesson.locked ? <Lock size={12} style={{ color: txt3 }} /> :
                         <span>{lesson.icon}</span>}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate"
                          style={{ color: lesson.locked ? txt3 : txt }}>{lesson.title}</div>
                        <div className="text-xs truncate"
                          style={{ color: lesson.locked ? txt3 : txt3 }}>
                          {lesson.locked ? lesson.lockReason : lesson.subtitle}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {!lesson.locked && !isCompleted && (
                          <span className="text-[10px] font-mono" style={{ color: txt3 }}>{lesson.duration}</span>
                        )}
                        {!lesson.locked && (
                          <ChevronDown size={13} style={{
                            color: txt3,
                            transform: isOpen ? 'rotate(180deg)' : 'none',
                            transition: 'transform 0.2s',
                          }} />
                        )}
                      </div>
                    </button>

                    {/* Expanded lesson content */}
                    {isOpen && openLessonData && (
                      <div className="mx-1 rounded-b-xl border-x border-b overflow-hidden"
                        style={{ borderColor: 'rgba(167,139,250,0.2)', background: surf }}>
                        <div className="px-4 py-5 space-y-4">

                          {/* Content paragraphs */}
                          {openLessonData.content.map((para, i) => (
                            <p key={i} className="text-sm leading-relaxed" style={{ color: txt2 }}>{para}</p>
                          ))}

                          {/* Callout */}
                          {openLessonData.callout && (
                            <div className="px-4 py-3 rounded-xl"
                              style={{ background: 'rgba(167,139,250,0.06)', border: '1px solid rgba(167,139,250,0.15)' }}>
                              <div className="text-[10px] font-bold uppercase tracking-widest mb-2"
                                style={{ color: '#a78bfa' }}>{openLessonData.callout.label}</div>
                              <pre className="text-xs leading-relaxed whitespace-pre-wrap font-mono"
                                style={{ color: txt2 }}>{openLessonData.callout.text}</pre>
                            </div>
                          )}

                          {/* Tip */}
                          {openLessonData.tip && (
                            <div className="flex gap-2 px-3 py-2.5 rounded-lg"
                              style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)' }}>
                              <span className="text-xs" style={{ color: '#34d399', flexShrink: 0 }}>💡</span>
                              <p className="text-xs leading-relaxed" style={{ color: txt2 }}>{openLessonData.tip}</p>
                            </div>
                          )}

                          {/* Quiz */}
                          {!isBehavioral && (
                            <div className="pt-2 border-t space-y-3" style={{ borderColor: brd }}>
                              <div className="text-xs font-bold uppercase tracking-widest" style={{ color: txt3 }}>
                                Knowledge check
                              </div>
                              <p className="text-sm font-semibold" style={{ color: txt }}>
                                {openLessonData.quiz.question}
                              </p>
                              <div className="space-y-2">
                                {openLessonData.quiz.options.map((opt, idx) => {
                                  const isSelected = quizAnswer === idx
                                  const isCorrect = idx === openLessonData.quiz.correctIndex
                                  const showResult = quizSubmitted

                                  let bg = surf2
                                  let border = brd
                                  let color = txt2
                                  if (showResult && isCorrect) { bg = 'rgba(52,211,153,0.08)'; border = 'rgba(52,211,153,0.3)'; color = '#34d399' }
                                  else if (showResult && isSelected && !isCorrect) { bg = 'rgba(248,113,113,0.08)'; border = 'rgba(248,113,113,0.3)'; color = '#f87171' }
                                  else if (!showResult && isSelected) { bg = 'rgba(167,139,250,0.08)'; border = 'rgba(167,139,250,0.3)'; color = '#a78bfa' }

                                  return (
                                    <button key={idx}
                                      onClick={() => { if (!quizSubmitted) setQuizAnswer(idx) }}
                                      disabled={quizSubmitted}
                                      className="w-full text-left px-3.5 py-2.5 rounded-lg text-xs transition-all"
                                      style={{ background: bg, border: `1px solid ${border}`, color }}>
                                      <span className="font-semibold mr-2">{String.fromCharCode(65 + idx)}.</span>
                                      {opt}
                                    </button>
                                  )
                                })}
                              </div>

                              {quizSubmitted ? (
                                <div className="px-3.5 py-3 rounded-lg text-xs leading-relaxed"
                                  style={{
                                    background: quizAnswer === openLessonData.quiz.correctIndex
                                      ? 'rgba(52,211,153,0.06)' : 'rgba(248,113,113,0.06)',
                                    border: `1px solid ${quizAnswer === openLessonData.quiz.correctIndex
                                      ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'}`,
                                    color: txt2,
                                  }}>
                                  <span className="font-semibold mr-1"
                                    style={{ color: quizAnswer === openLessonData.quiz.correctIndex ? '#34d399' : '#f87171' }}>
                                    {quizAnswer === openLessonData.quiz.correctIndex ? '✓ Correct.' : '✗ Not quite.'}
                                  </span>
                                  {openLessonData.quiz.explanation}
                                </div>
                              ) : (
                                <button onClick={submitQuiz}
                                  disabled={quizAnswer === null || saving}
                                  className="w-full py-2.5 rounded-lg text-xs font-bold text-white disabled:opacity-30 transition-all"
                                  style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
                                  {saving ? 'Saving...' : 'Submit answer'}
                                </button>
                              )}

                              {quizSubmitted && (
                                <button onClick={closeLesson}
                                  className="w-full py-2.5 rounded-lg text-xs font-semibold transition-all"
                                  style={{ background: surf2, color: txt2, border: `1px solid ${brd}` }}>
                                  {completedIds.has(openLessonData.id) ? 'Close lesson' : 'Close'}
                                </button>
                              )}
                            </div>
                          )}

                          {/* Behavioral lesson — just acknowledge */}
                          {isBehavioral && (
                            <div className="pt-2 border-t" style={{ borderColor: brd }}>
                              {completedIds.has(openLessonData.id) ? (
                                <div className="flex items-center gap-2 text-xs" style={{ color: '#34d399' }}>
                                  <CheckCircle size={13} />
                                  Completed — you did this
                                </div>
                              ) : (
                                <div className="px-3.5 py-3 rounded-lg text-xs"
                                  style={{ background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.15)', color: '#f97316' }}>
                                  🔥 {openLessonData.lockReason ?? 'Complete the required action to unlock'}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {completedCount === totalCount && (
        <div className="rounded-2xl px-5 py-6 text-center"
          style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)' }}>
          <div className="text-2xl mb-2">🏆</div>
          <div className="text-sm font-bold mb-1" style={{ color: '#34d399' }}>All lessons complete</div>
          <div className="text-xs" style={{ color: txt3 }}>You've built the foundation. Now it compounds.</div>
        </div>
      )}
    </div>
  )
}
