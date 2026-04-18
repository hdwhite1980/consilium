'use client'

import { useEffect, useState } from 'react'
import { getAvailableLessons, INVEST_LESSONS } from '@/app/lib/invest-lessons'

interface Props {
  currentStage: string
  totalTrades: number
  closedTrades: number
  balance: number
  onOpenLesson: (lessonId: string) => void
  pulseLessonId?: string | null  // a contextual trigger is wanting this one
}

interface ProgressEntry {
  lesson_id: string
  correct: boolean
  quiz_answer: number
}

export function ForgeEmbers({ currentStage, totalTrades, closedTrades, balance, onOpenLesson, pulseLessonId }: Props) {
  const [progress, setProgress] = useState<ProgressEntry[]>([])

  useEffect(() => {
    fetch('/api/invest/lessons')
      .then(r => r.json())
      .then(d => setProgress(d.progress ?? []))
      .catch(() => {})
  }, [closedTrades])

  const completedIds = new Set(progress.filter(p => p.correct).map(p => p.lesson_id))
  const hasClosedTrade = closedTrades > 0
  const lessons = getAvailableLessons(currentStage, completedIds, totalTrades, hasClosedTrade)

  const completedCount = completedIds.size
  const totalCount = INVEST_LESSONS.length
  const progressPct = Math.round((completedCount / totalCount) * 100)

  // Next unlocked incomplete lesson (for "current" highlight)
  const nextLesson = lessons.find(l => !l.locked && !completedIds.has(l.id))

  // Show the first 7-8 lessons max; user can scroll if needed. The forge right column is skinny.
  const shown = lessons.slice(0, 10)

  return (
    <div className="embers-panel">
      <div className="embers-progress-row">
        <span className="embers-progress-count mono">
          {completedCount}/{totalCount}
        </span>
        <div className="embers-progress-bar">
          <div className="embers-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      <div className="embers-list">
        {shown.map(lesson => {
          const completed = completedIds.has(lesson.id)
          const isLocked = lesson.locked
          const isNext = nextLesson?.id === lesson.id
          const isPulsing = pulseLessonId === lesson.id

          const state = completed ? 'done' : isLocked ? 'locked' : isNext ? 'next' : 'ready'

          return (
            <button
              key={lesson.id}
              className={`ember-item ember-${state} ${isPulsing ? 'ember-pulsing' : ''}`}
              onClick={() => !isLocked && onOpenLesson(lesson.id)}
              disabled={isLocked}
              title={isLocked ? (lesson.lockReason ?? '') : lesson.subtitle}
            >
              <span className="ember-mote" aria-hidden>
                {completed && <span className="ember-mote-check">✓</span>}
                {isLocked && <span className="ember-mote-lock">·</span>}
              </span>
              <span className="ember-txt">
                <span className="ember-title">{lesson.title}</span>
                {!isLocked && <span className="ember-dur mono">{lesson.duration}</span>}
              </span>
            </button>
          )
        })}
      </div>

      <style jsx>{`
        .embers-panel { margin-top: 4px; }
        .embers-progress-row {
          display: flex; align-items: center; gap: 10px;
          margin-bottom: 14px;
        }
        .embers-progress-count {
          font-size: 10px;
          color: rgba(255,220,180,0.5);
          flex-shrink: 0;
        }
        .embers-progress-bar {
          flex: 1; height: 2px;
          background: rgba(249,115,22,0.08);
          border-radius: 2px;
          overflow: hidden;
        }
        .embers-progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #fbbf24, #f97316);
          transition: width 0.8s cubic-bezier(0.22,1,0.36,1);
          box-shadow: 0 0 8px rgba(251,191,36,0.4);
        }
        .embers-list {
          display: flex; flex-direction: column; gap: 6px;
        }
        .ember-item {
          display: flex; align-items: center; gap: 12px;
          padding: 10px 12px;
          border-radius: 10px;
          background: rgba(255,255,255,0.015);
          border: 1px solid rgba(255,255,255,0.04);
          cursor: pointer;
          transition: all 0.3s ease;
          text-align: left;
          width: 100%;
        }
        .ember-item:not(:disabled):hover {
          background: rgba(251,191,36,0.05);
          border-color: rgba(251,191,36,0.2);
        }
        .ember-item:disabled { cursor: not-allowed; opacity: 0.6; }

        .ember-mote {
          width: 10px; height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
          position: relative;
          display: flex; align-items: center; justify-content: center;
        }
        .ember-mote-check {
          font-size: 8px;
          color: #052e1c;
          font-family: 'JetBrains Mono', monospace;
          font-weight: 700;
        }
        .ember-mote-lock {
          font-size: 14px;
          color: rgba(255,220,180,0.3);
          line-height: 0;
        }

        .ember-done .ember-mote {
          background: radial-gradient(circle, #fff4d6 0%, #fbbf24 50%, #f97316 100%);
          box-shadow: 0 0 8px rgba(251,191,36,0.6);
        }
        .ember-ready .ember-mote {
          background: rgba(251,191,36,0.3);
          border: 1px solid rgba(251,191,36,0.5);
        }
        .ember-next .ember-mote {
          background: radial-gradient(circle, #fbbf24 0%, #f97316 100%);
          box-shadow: 0 0 14px rgba(251,191,36,0.8);
          animation: moteBreathe 2s ease-in-out infinite;
        }
        .ember-locked .ember-mote {
          background: rgba(255,220,180,0.05);
          border: 1px solid rgba(255,220,180,0.12);
        }
        @keyframes moteBreathe {
          0%,100% { transform: scale(1); opacity: 0.9; }
          50% { transform: scale(1.35); opacity: 1; }
        }

        .ember-pulsing {
          background: rgba(249,115,22,0.08) !important;
          border-color: rgba(249,115,22,0.35) !important;
          animation: emberItemPulse 2s ease-in-out infinite;
        }
        .ember-pulsing .ember-mote {
          background: radial-gradient(circle, #fff4d6, #fbbf24 40%, #ef4444) !important;
          box-shadow: 0 0 18px rgba(239,68,68,0.7) !important;
          animation: moteBreathe 1.4s ease-in-out infinite !important;
        }
        @keyframes emberItemPulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(249,115,22,0.3); }
          50% { box-shadow: 0 0 0 6px rgba(249,115,22,0); }
        }

        .ember-txt {
          flex: 1; min-width: 0;
          display: flex; flex-direction: column; gap: 2px;
        }
        .ember-title {
          font-family: 'Fraunces', Georgia, serif;
          font-size: 13px; line-height: 1.3;
          color: rgba(255,220,180,0.85);
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .ember-locked .ember-title { color: rgba(255,220,180,0.35); }
        .ember-done .ember-title { color: rgba(255,220,180,0.6); }
        .ember-next .ember-title, .ember-pulsing .ember-title {
          color: rgba(255,244,214,0.95);
          font-style: italic;
        }
        .ember-dur {
          font-size: 9px;
          letter-spacing: 0.08em;
          color: rgba(255,180,100,0.5);
        }
      `}</style>
    </div>
  )
}
