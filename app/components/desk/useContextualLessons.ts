'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { LessonTrigger } from '@/app/lib/invest-lessons'

interface FloorSnapshot {
  tier: string
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
  tier: string
  openTrades: Trade[]
  closedTrades: Trade[]
  floorSeen: boolean
}

// Sorts closedTrades internally by exit_date desc, then counts consecutive losses from the top.
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

export function useContextualLessons({ tier, openTrades, closedTrades, floorSeen }: Args) {
  const firedRef = useRef<Set<LessonTrigger>>(new Set())
  const prevRef = useRef<FloorSnapshot | null>(null)
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

    const snapshot: FloorSnapshot = {
      tier,
      openTradesCount: openCount,
      closedTradesCount: closedCount,
      lastCloseWasWin,
      lastCloseId,
      consecutiveLosses,
      seen: floorSeen,
    }

    const prev = prevRef.current

    // First landing — fire once
    if (!prev && !floorSeen && !firedRef.current.has('first_open_page')) {
      firedRef.current.add('first_open_page')
      setPendingTrigger('first_open_page')
      prevRef.current = snapshot
      return
    }

    if (prev) {
      // first_trade_opened
      if (prev.openTradesCount === 0 && openCount === 1 && prev.closedTradesCount === 0 && !firedRef.current.has('first_trade_opened')) {
        firedRef.current.add('first_trade_opened')
        setPendingTrigger('first_trade_opened')
      }

      // first trade closed — prefer win/loss specific trigger
      else if (prev.closedTradesCount === 0 && closedCount === 1 && !firedRef.current.has('first_trade_closed')) {
        firedRef.current.add('first_trade_closed')
        if (lastCloseWasWin === false) setPendingTrigger('first_loss')
        else if (lastCloseWasWin === true) setPendingTrigger('first_win')
        else setPendingTrigger('first_trade_closed')
      }

      // new close after the first close
      else if (lastCloseId && lastCloseId !== prev.lastCloseId) {
        if (lastCloseWasWin === false) {
          const priorLosses = prev.consecutiveLosses
          if (priorLosses === 0 && !firedRef.current.has('first_loss')) {
            const totalLosses = closedTrades.filter(t => t.exit_price != null && t.exit_price < t.entry_price).length
            if (totalLosses === 1) {
              firedRef.current.add('first_loss')
              setPendingTrigger('first_loss')
            }
          }
          if (consecutiveLosses >= 3 && !firedRef.current.has('three_losses_in_row')) {
            firedRef.current.add('three_losses_in_row')
            setPendingTrigger('three_losses_in_row')
          }
        }
      }

      // tier up
      if (prev.tier !== tier) {
        const tierOrder = ['Buyer', 'Builder', 'Operator', 'Principal', 'Sovereign']
        const prevIdx = tierOrder.indexOf(prev.tier)
        const currIdx = tierOrder.indexOf(tier)
        if (currIdx > prevIdx && !firedRef.current.has('tier_up')) {
          setPendingTrigger('tier_up')
          // Re-arm so subsequent tier jumps can trigger too
          setTimeout(() => firedRef.current.delete('tier_up'), 100)
        }
      }
    }

    prevRef.current = snapshot
  }, [tier, openTrades, closedTrades, floorSeen])

  const dismissTrigger = useCallback(() => {
    setPendingTrigger(null)
  }, [])

  return { pendingTrigger, dismissTrigger }
}
