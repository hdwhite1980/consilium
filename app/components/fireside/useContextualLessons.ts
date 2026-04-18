'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { LessonTrigger } from '@/app/lib/invest-lessons'

// Small state snapshot we compare across renders to detect journey moments.
interface ForgeSnapshot {
  stage: string
  openTradesCount: number
  closedTradesCount: number
  lastCloseWasWin: boolean | null
  lastCloseId: string | null
  consecutiveLosses: number
  seen: boolean
}

interface Trade {
  id: string
  entry_price: number
  exit_price: number | null
  shares: number
  exit_date: string | null
}

interface Args {
  stage: string
  openTrades: Trade[]
  closedTrades: Trade[]
  forgeSeen: boolean  // whether user has seen the forge before (from journey)
}

// Computes consecutive losses from the N most recent closed trades.
// Sorts internally by exit_date desc so callers don't have to.
function computeConsecutiveLosses(closed: Trade[]): number {
  const sorted = [...closed]
    .filter(t => t.exit_price != null && t.exit_date != null)
    .sort((a, b) => (b.exit_date ?? '').localeCompare(a.exit_date ?? ''))
  let count = 0
  for (const t of sorted) {
    if (t.exit_price == null) continue
    const isLoss = t.exit_price < t.entry_price
    if (isLoss) count++
    else break
  }
  return count
}

export function useContextualLessons({ stage, openTrades, closedTrades, forgeSeen }: Args) {
  // Which triggers have fired in this session — prevents re-firing on every render
  const firedRef = useRef<Set<LessonTrigger>>(new Set())
  const prevRef = useRef<ForgeSnapshot | null>(null)
  const [pendingTrigger, setPendingTrigger] = useState<LessonTrigger | null>(null)

  useEffect(() => {
    const openCount = openTrades.length
    const closedCount = closedTrades.length
    const mostRecentClose = closedTrades[0]
    const lastCloseWasWin = mostRecentClose?.exit_price != null
      ? mostRecentClose.exit_price > mostRecentClose.entry_price
      : null
    const lastCloseId = mostRecentClose?.id ?? null
    const consecutiveLosses = computeConsecutiveLosses(closedTrades)

    const snapshot: ForgeSnapshot = {
      stage,
      openTradesCount: openCount,
      closedTradesCount: closedCount,
      lastCloseWasWin,
      lastCloseId,
      consecutiveLosses,
      seen: forgeSeen,
    }

    const prev = prevRef.current

    // First landing — only fire once per session
    if (!prev && !forgeSeen && !firedRef.current.has('first_open_page')) {
      firedRef.current.add('first_open_page')
      setPendingTrigger('first_open_page')
      prevRef.current = snapshot
      return
    }

    if (prev) {
      // first_trade_opened — open count went 0 → 1+
      if (prev.openTradesCount === 0 && openCount === 1 && prev.closedTradesCount === 0 && !firedRef.current.has('first_trade_opened')) {
        firedRef.current.add('first_trade_opened')
        setPendingTrigger('first_trade_opened')
      }

      // first_trade_closed — closed count 0 → 1
      else if (prev.closedTradesCount === 0 && closedCount === 1 && !firedRef.current.has('first_trade_closed')) {
        firedRef.current.add('first_trade_closed')
        // But prefer specific win/loss trigger if possible
        if (lastCloseWasWin === false) setPendingTrigger('first_loss')
        else if (lastCloseWasWin === true) setPendingTrigger('first_win')
        else setPendingTrigger('first_trade_closed')
      }

      // A new close happened after we've already had 1+ closes — check for first_loss / three_losses
      else if (lastCloseId && lastCloseId !== prev.lastCloseId) {
        if (lastCloseWasWin === false) {
          // Check if this was the first loss overall
          const priorLosses = prev.consecutiveLosses
          if (priorLosses === 0 && !firedRef.current.has('first_loss')) {
            // Count total losses across all closed trades
            const totalLosses = closedTrades.filter(t => t.exit_price != null && t.exit_price < t.entry_price).length
            if (totalLosses === 1) {
              firedRef.current.add('first_loss')
              setPendingTrigger('first_loss')
            }
          }
          // Three losses in a row — high priority
          if (consecutiveLosses >= 3 && !firedRef.current.has('three_losses_in_row')) {
            firedRef.current.add('three_losses_in_row')
            setPendingTrigger('three_losses_in_row')
          }
        }
      }

      // Stage jump
      if (prev.stage !== stage) {
        const stageOrder = ['Spark', 'Ember', 'Flame', 'Blaze', 'Inferno', 'Free']
        const prevIdx = stageOrder.indexOf(prev.stage)
        const currIdx = stageOrder.indexOf(stage)
        if (currIdx > prevIdx && !firedRef.current.has('stage_up')) {
          // Allow stage_up to re-fire per stage (we clear it)
          setPendingTrigger('stage_up')
          // Re-allow stage_up for subsequent jumps by clearing from set after queuing
          setTimeout(() => firedRef.current.delete('stage_up'), 100)
        }
      }
    }

    prevRef.current = snapshot
  }, [stage, openTrades, closedTrades, forgeSeen])

  const dismissTrigger = useCallback(() => {
    setPendingTrigger(null)
  }, [])

  return { pendingTrigger, dismissTrigger }
}
