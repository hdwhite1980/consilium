'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { LessonTrigger } from '@/app/lib/invest-lessons'
import {
  detectBehavioralTrigger,
  type BehavioralTrade,
  type BehavioralPostmortem,
} from '@/app/lib/invest-behavioral-triggers'

// ─────────────────────────────────────────────────────────────
// Cooldown helpers — localStorage-backed
// ─────────────────────────────────────────────────────────────
//
// Each behavioral trigger has a 6h global cooldown. Inside that window we
// also track the eventKey (trade ID) so the same event never re-fires.
//
// Storage shape: { lastFiredAt: number, lastEventKey: string }

const COOLDOWN_MS = 6 * 60 * 60 * 1000  // 6 hours
const STORAGE_PREFIX = 'wali:lesson-cooldown:'

interface CooldownState {
  lastFiredAt: number
  lastEventKey: string
}

function readCooldown(trigger: string): CooldownState | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + trigger)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.lastFiredAt !== 'number') return null
    return parsed as CooldownState
  } catch { return null }
}

function writeCooldown(trigger: string, eventKey: string) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(
      STORAGE_PREFIX + trigger,
      JSON.stringify({ lastFiredAt: Date.now(), lastEventKey: eventKey })
    )
  } catch { /* quota exceeded etc — silent fail */ }
}

/** True if this (trigger, eventKey) pair is allowed to fire right now. */
function isCooldownClear(trigger: string, eventKey: string): boolean {
  const state = readCooldown(trigger)
  if (!state) return true
  // Same event already fired — never refire even after cooldown
  if (state.lastEventKey === eventKey) return false
  // Different event but still in 6h window
  if (Date.now() - state.lastFiredAt < COOLDOWN_MS) return false
  return true
}

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
  opened_at?: string | null
  stop_price?: number | null
  target_price?: number | null
  position_type?: 'stock' | 'option' | null
}

interface Postmortem {
  trade_id: string
  process_score: number
  generated_at?: string | null
}

interface Args {
  tier: string
  openTrades: Trade[]
  closedTrades: Trade[]
  postmortems?: Postmortem[]
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

export function useContextualLessons({ tier, openTrades, closedTrades, postmortems, floorSeen }: Args) {
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

    // ── Behavioral pattern detection ──────────────────────────
    // Runs every effect tick, but cooldowns prevent spam. The detector
    // returns at most one trigger; if a "first_*" trigger fired above we
    // skip behavioral so the user gets one note per render at most.
    if (!pendingTrigger) {
      const behavioralTrades: BehavioralTrade[] = [...openTrades, ...closedTrades].map(t => ({
        id: t.id,
        entry_price: t.entry_price,
        exit_price: t.exit_price,
        shares: t.shares,
        stop_price: t.stop_price ?? null,
        target_price: t.target_price ?? null,
        position_type: t.position_type ?? null,
        opened_at: t.opened_at ?? null,
        exit_date: t.exit_date ?? null,
      }))
      const behavioralOpens = behavioralTrades.filter(t => t.exit_price == null)
      const behavioralClosed = behavioralTrades.filter(t => t.exit_price != null)
      const behavioralPMs: BehavioralPostmortem[] = (postmortems ?? []).map(p => ({
        trade_id: p.trade_id,
        process_score: p.process_score,
        generated_at: p.generated_at ?? null,
      }))

      const behavioral = detectBehavioralTrigger({
        openTrades: behavioralOpens,
        closedTrades: behavioralClosed,
        postmortems: behavioralPMs,
        lastCloseId: closedTrades[0]?.id ?? null,
        lastOpenId: openTrades[0]?.id ?? null,
      })

      if (behavioral.trigger && behavioral.eventKey
          && isCooldownClear(behavioral.trigger, behavioral.eventKey)) {
        writeCooldown(behavioral.trigger, behavioral.eventKey)
        setPendingTrigger(behavioral.trigger)
      }
    }

    prevRef.current = snapshot
  }, [tier, openTrades, closedTrades, postmortems, floorSeen, pendingTrigger])

  const dismissTrigger = useCallback(() => {
    setPendingTrigger(null)
  }, [])

  return { pendingTrigger, dismissTrigger }
}
