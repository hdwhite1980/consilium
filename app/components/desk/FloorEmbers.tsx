'use client'

import { useEffect, useState } from 'react'
import { getAvailableLessons, INVEST_LESSONS } from '@/app/lib/invest-lessons'

interface Props {
  currentStage: string
  totalTrades: number
  closedTrades: number
  balance: number
  onOpenLesson: (lessonId: string) => void
  pulseLessonId?: string | null
}

interface ProgressEntry {
  lesson_id: string
  correct: boolean
  quiz_answer: number
}

// Map lesson ids to stable note numbers for display
const NOTE_NUMBERS: Record<string, string> = {
  'buyer-1': '001', 'buyer-2': '002', 'buyer-loss': '003', 'buyer-behavior': '004',
  'builder-1': '005', 'builder-behavior': '006',
  'operator-1': '007', 'operator-2': '008', 'operator-tilt': '009',
  'principal-1': '010',
}

export function FloorEmbers({ currentStage, totalTrades, closedTrades, balance, onOpenLesson, pulseLessonId }: Props) {
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
  const nextLesson = lessons.find(l => !l.locked && !completedIds.has(l.id))
  const shown = lessons.slice(0, 10)

  return (
    <div className="fe-panel">
      <div className="fe-progress-row">
        <span className="fe-progress-count mono">{completedCount} / {totalCount}</span>
        <div className="fe-progress-bar">
          <div className="fe-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      <div className="fe-list">
        {shown.map(lesson => {
          const completed = completedIds.has(lesson.id)
          const isLocked = lesson.locked
          const isNext = nextLesson?.id === lesson.id
          const isPulsing = pulseLessonId === lesson.id

          const state = completed ? 'done' : isLocked ? 'locked' : isNext ? 'next' : 'ready'
          const num = NOTE_NUMBERS[lesson.id] ?? '—'

          return (
            <button
              key={lesson.id}
              className={`fe-item fe-${state} ${isPulsing ? 'fe-pulsing' : ''}`}
              onClick={() => !isLocked && onOpenLesson(lesson.id)}
              disabled={isLocked}
              title={isLocked ? (lesson.lockReason ?? '') : lesson.subtitle}
            >
              <span className="fe-num mono">{completed ? '✓' : isLocked ? '—' : num}</span>
              <span className="fe-txt">
                <span className="fe-title">{lesson.title}</span>
                {!isLocked && <span className="fe-dur mono">{lesson.duration}</span>}
              </span>
            </button>
          )
        })}
      </div>

      <style jsx>{`
        .fe-panel { margin-top: 4px; }
        .fe-progress-row {
          display: flex; align-items: center; gap: 10px;
          margin-bottom: 14px;
        }
        .fe-progress-count {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px;
          color: rgba(148, 163, 184, 0.6);
          flex-shrink: 0;
          letter-spacing: 0.08em;
        }
        .fe-progress-bar {
          flex: 1; height: 2px;
          background: rgba(148, 163, 184, 0.1);
          border-radius: 1px;
          overflow: hidden;
        }
        .fe-progress-fill {
          height: 100%;
          background: #d4a857;
          transition: width 0.8s cubic-bezier(0.22, 1, 0.36, 1);
        }

        .fe-list {
          display: flex; flex-direction: column; gap: 4px;
        }

        .fe-item {
          display: flex; align-items: center; gap: 12px;
          padding: 10px 12px;
          border-radius: 6px;
          background: rgba(15, 23, 42, 0.4);
          border: 1px solid rgba(148, 163, 184, 0.08);
          cursor: pointer;
          transition: all 0.2s ease;
          text-align: left;
          width: 100%;
        }
        .fe-item:not(:disabled):hover {
          background: rgba(212, 168, 87, 0.04);
          border-color: rgba(212, 168, 87, 0.2);
        }
        .fe-item:disabled { cursor: not-allowed; opacity: 0.55; }

        .fe-num {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 10px;
          font-weight: 500;
          flex-shrink: 0;
          width: 24px;
          text-align: center;
          letter-spacing: 0.05em;
        }

        .fe-done .fe-num { color: #10b981; }
        .fe-ready .fe-num { color: rgba(212, 168, 87, 0.8); }
        .fe-next .fe-num { color: #d4a857; }
        .fe-locked .fe-num { color: rgba(148, 163, 184, 0.3); }

        .fe-next {
          border-color: rgba(212, 168, 87, 0.3);
          background: rgba(212, 168, 87, 0.04);
        }

        .fe-pulsing {
          background: rgba(212, 168, 87, 0.08) !important;
          border-color: rgba(212, 168, 87, 0.45) !important;
          box-shadow: 0 0 0 0 rgba(212, 168, 87, 0.4);
          animation: fePulse 2.2s ease-in-out infinite;
        }
        .fe-pulsing .fe-num { color: #d4a857 !important; }
        @keyframes fePulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(212, 168, 87, 0.3); }
          50% { box-shadow: 0 0 0 4px rgba(212, 168, 87, 0); }
        }

        .fe-txt {
          flex: 1; min-width: 0;
          display: flex; flex-direction: column; gap: 2px;
        }
        .fe-title {
          font-family: 'Source Serif 4', Georgia, serif;
          font-size: 13px;
          line-height: 1.35;
          color: rgba(226, 232, 240, 0.88);
          font-weight: 400;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .fe-locked .fe-title { color: rgba(148, 163, 184, 0.4); }
        .fe-done .fe-title { color: rgba(148, 163, 184, 0.6); }
        .fe-next .fe-title, .fe-pulsing .fe-title {
          color: #f5f5f5;
          font-weight: 500;
        }
        .fe-dur {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 9px;
          letter-spacing: 0.1em;
          color: rgba(148, 163, 184, 0.5);
        }
      `}</style>
    </div>
  )
}
