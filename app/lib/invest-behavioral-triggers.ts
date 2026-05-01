// ═════════════════════════════════════════════════════════════
// app/lib/invest-behavioral-triggers.ts
//
// Detects behavioral patterns from a user's trade history. Used by the
// useContextualLessons hook to surface lessons at the moment they're
// relevant.
//
// Design rules:
//   1. Pure functions, no DB calls, no side effects.
//   2. Returns at most ONE trigger per call (the most relevant fresh event).
//   3. Detection is per-event, not per-state. The hook layer adds cooldowns
//      to prevent the same trigger from re-firing on every render.
//   4. False-positive averse — we'd rather miss a teaching moment than nag
//      the user for something they didn't actually do.
// ═════════════════════════════════════════════════════════════

import type { LessonTrigger } from '@/app/lib/invest-lessons'

// ─────────────────────────────────────────────────────────────
// Input shapes (subset of the real schema)
// ─────────────────────────────────────────────────────────────

export interface BehavioralTrade {
  id: string
  entry_price: number
  exit_price: number | null
  shares: number
  stop_price: number | null
  target_price: number | null
  position_type?: 'stock' | 'option' | null
  opened_at?: string | null
  exit_date?: string | null
}

export interface BehavioralPostmortem {
  trade_id: string
  process_score: number
  generated_at?: string | null
}

export interface BehavioralInput {
  openTrades: BehavioralTrade[]
  closedTrades: BehavioralTrade[]
  postmortems: BehavioralPostmortem[]
  /** Most recent close ID — used to gate event-based triggers. */
  lastCloseId: string | null
  /** Most recent open ID — used to gate event-based triggers. */
  lastOpenId: string | null
  /** "Now" override for testing. Defaults to Date.now(). */
  now?: number
}

// ─────────────────────────────────────────────────────────────
// Trigger result
// ─────────────────────────────────────────────────────────────

export interface BehavioralResult {
  trigger: LessonTrigger | null
  /** ID of the trade or event that caused this trigger to fire. */
  eventKey: string | null
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000

function isWin(t: BehavioralTrade): boolean {
  return t.exit_price != null && t.exit_price > t.entry_price
}

function isLoss(t: BehavioralTrade): boolean {
  return t.exit_price != null && t.exit_price < t.entry_price
}

function tradeDollarSize(t: BehavioralTrade): number {
  return t.entry_price * t.shares
}

function sortClosedNewestFirst(closed: BehavioralTrade[]): BehavioralTrade[] {
  return [...closed].sort((a, b) => {
    const ad = a.exit_date ?? a.opened_at ?? ''
    const bd = b.exit_date ?? b.opened_at ?? ''
    return bd.localeCompare(ad)
  })
}

function sortOpensNewestFirst(opens: BehavioralTrade[]): BehavioralTrade[] {
  return [...opens].sort((a, b) => {
    const ad = a.opened_at ?? ''
    const bd = b.opened_at ?? ''
    return bd.localeCompare(ad)
  })
}

// ─────────────────────────────────────────────────────────────
// Individual detection functions
// ─────────────────────────────────────────────────────────────

/**
 * cut_winner_short: closed winning trade where exit was < entry + 0.5 of the
 * way to target. They left the bulk of the move on the table.
 *
 * Skipped if no target was set, or if exit was at/above target (no early cut),
 * or for option trades (premium dynamics differ).
 */
export function detectCutWinnerShort(closed: BehavioralTrade[]): string | null {
  const newest = closed[0]
  if (!newest) return null
  if (newest.position_type === 'option') return null
  if (!isWin(newest)) return null
  if (!newest.target_price || newest.target_price <= newest.entry_price) return null
  if (newest.exit_price! >= newest.target_price * 0.95) return null  // close enough to target

  const halfwayToTarget = newest.entry_price + (newest.target_price - newest.entry_price) * 0.5
  if (newest.exit_price! < halfwayToTarget) return newest.id
  return null
}

/**
 * held_past_stop: closed losing trade where exit was significantly past the
 * stop the user set. They watched it bleed instead of taking the cut.
 *
 * Skipped if no stop was set, if it's a profit, or for option trades.
 */
export function detectHeldPastStop(closed: BehavioralTrade[]): string | null {
  const newest = closed[0]
  if (!newest) return null
  if (newest.position_type === 'option') return null
  if (!isLoss(newest)) return null
  if (!newest.stop_price || newest.stop_price <= 0) return null
  if (newest.exit_price! > newest.stop_price) return null  // stopped above stop = honored

  // Exit was 10%+ below stop = let it run
  if (newest.exit_price! <= newest.stop_price * 0.9) return newest.id
  return null
}

/**
 * no_stop_set_pattern: at least 3 closed trades total were opened with no
 * stop_price. We fire AT the third such trade so it lands on a clear event.
 *
 * Returns the third such trade's ID (event boundary), or null if not yet at 3.
 */
export function detectNoStopPattern(closed: BehavioralTrade[]): string | null {
  const newest = closed[0]
  if (!newest) return null
  // Only fire on a fresh close that itself had no stop
  if (newest.stop_price && newest.stop_price > 0) return null
  if (newest.position_type === 'option') return null

  const noStopCount = closed.filter(t =>
    t.position_type !== 'option' && (!t.stop_price || t.stop_price <= 0)
  ).length

  // Fire exactly when the count hits 3 — the hook's cooldown prevents repeats.
  if (noStopCount >= 3) return newest.id
  return null
}

/**
 * sized_up_after_win: most recently OPENED trade is >2× the dollar size of
 * the user's previous trade, AND the previous trade was a win.
 *
 * Catches the euphoria-after-win sizing escalation that wrecks accounts.
 */
export function detectSizedUpAfterWin(
  opens: BehavioralTrade[],
  closed: BehavioralTrade[],
): string | null {
  const newestOpen = opens[0]
  if (!newestOpen) return null
  if (newestOpen.position_type === 'option') return null

  // What was the immediately prior trade (whether closed or still open)?
  // We define "prior" as the most recent trade BEFORE the newest open by
  // opened_at timestamp.
  const newestOpenedAt = newestOpen.opened_at ?? ''
  const candidates = [...opens.slice(1), ...closed]
    .filter(t => (t.opened_at ?? '') < newestOpenedAt)
    .sort((a, b) => (b.opened_at ?? '').localeCompare(a.opened_at ?? ''))

  const prior = candidates[0]
  if (!prior) return null  // no prior trade
  if (!isWin(prior)) return null  // prior wasn't a win — no euphoria signal

  const newSize = tradeDollarSize(newestOpen)
  const priorSize = tradeDollarSize(prior)
  if (priorSize <= 0) return null

  if (newSize >= priorSize * 2) return newestOpen.id
  return null
}

/**
 * overtrading: 4+ trades opened in the last 24 hours. Strong overtrading
 * signal — most setups aren't this frequent.
 */
export function detectOvertrading(
  opens: BehavioralTrade[],
  closed: BehavioralTrade[],
  now: number,
): string | null {
  const all = [...opens, ...closed]
  const cutoff = now - MS_PER_DAY
  const recent = all.filter(t => {
    const ts = t.opened_at ? new Date(t.opened_at).getTime() : 0
    return ts >= cutoff
  })
  if (recent.length < 4) return null

  // Use the newest open as the event key
  const newestOpen = recent
    .sort((a, b) => (b.opened_at ?? '').localeCompare(a.opened_at ?? ''))[0]
  return newestOpen?.id ?? null
}

/**
 * held_too_long_open: an open trade is older than 14 days. Gentle nudge —
 * either it's working and you should book partials, or it's broken and you
 * should cut.
 *
 * Returns the oldest such trade ID.
 */
export function detectHeldTooLong(opens: BehavioralTrade[], now: number): string | null {
  const cutoff = now - 14 * MS_PER_DAY
  const oldOpens = opens
    .filter(t => {
      const ts = t.opened_at ? new Date(t.opened_at).getTime() : Infinity
      return ts <= cutoff
    })
    .sort((a, b) => (a.opened_at ?? '').localeCompare(b.opened_at ?? ''))

  return oldOpens[0]?.id ?? null
}

/**
 * process_grade_dropped: most recent process grade dropped 10+ points below
 * the trailing-3 average (excluding the most recent itself).
 *
 * Needs ≥4 postmortems total to have meaningful comparison.
 */
export function detectProcessGradeDropped(pms: BehavioralPostmortem[]): string | null {
  const sorted = [...pms]
    .filter(p => p.generated_at && typeof p.process_score === 'number')
    .sort((a, b) =>
      (b.generated_at ?? '').localeCompare(a.generated_at ?? '')
    )
  if (sorted.length < 4) return null

  const newest = sorted[0]
  const trailing = sorted.slice(1, 4)
  if (trailing.length < 3) return null

  const trailingAvg = trailing.reduce((s, p) => s + p.process_score, 0) / trailing.length
  if (newest.process_score <= trailingAvg - 10) return newest.trade_id
  return null
}

// ─────────────────────────────────────────────────────────────
// Main entrypoint — runs all detectors and returns at most one trigger.
// ─────────────────────────────────────────────────────────────

/**
 * Priority order matters. The first match wins. We order by:
 *   1. Severity (held_past_stop > cut_winner_short)
 *   2. Recency (events from the latest trade close beat older patterns)
 *   3. Specificity (a single-event trigger beats a pattern trigger)
 */
export function detectBehavioralTrigger(input: BehavioralInput): BehavioralResult {
  const now = input.now ?? Date.now()
  const closedSorted = sortClosedNewestFirst(input.closedTrades)
  const openSorted = sortOpensNewestFirst(input.openTrades)

  // ── Priority 1: Just-closed-trade events ──
  // These are the freshest, most teachable moments.
  const heldPastStop = detectHeldPastStop(closedSorted)
  if (heldPastStop) return { trigger: 'held_past_stop', eventKey: heldPastStop }

  const cutWinner = detectCutWinnerShort(closedSorted)
  if (cutWinner) return { trigger: 'cut_winner_short', eventKey: cutWinner }

  // ── Priority 2: Pattern triggers from latest close ──
  const noStop = detectNoStopPattern(closedSorted)
  if (noStop) return { trigger: 'no_stop_set_pattern', eventKey: noStop }

  // ── Priority 3: Just-opened-trade events ──
  const sizedUp = detectSizedUpAfterWin(openSorted, closedSorted)
  if (sizedUp) return { trigger: 'sized_up_after_win', eventKey: sizedUp }

  // ── Priority 4: Cross-trade patterns ──
  const overtrading = detectOvertrading(openSorted, closedSorted, now)
  if (overtrading) return { trigger: 'overtrading', eventKey: overtrading }

  // ── Priority 5: Postmortem grade drop ──
  const gradeDrop = detectProcessGradeDropped(input.postmortems)
  if (gradeDrop) return { trigger: 'process_grade_dropped', eventKey: gradeDrop }

  // ── Priority 6: Long-open positions (gentle, lowest priority) ──
  const heldLong = detectHeldTooLong(openSorted, now)
  if (heldLong) return { trigger: 'held_too_long_open', eventKey: heldLong }

  return { trigger: null, eventKey: null }
}
