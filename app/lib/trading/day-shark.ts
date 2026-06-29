// =============================================================
// app/lib/trading/day-shark.ts
//
// "Max" - the day_shark lane. A SEPARATE, fast, aggressive 1-day mode that runs
// on its own virtual slice of each account's capital (the per-asset allocation
// sliders), alongside the slow accumulation strategy. Max uses the same council/
// signals/patterns but pointed at a 1D horizon, sized hot when conviction is high.
//
// This module is the FOUNDATION (Phase 1): budget math, sizing, persona, and
// milestones. It does not place trades - the Max executor (Phase 2) wires it in.
//
// IMPORTANT - virtual budget: brokers expose ONE pool of cash, not sub-accounts.
// "30% to Max" is a budget this code enforces itself: Max's deployed capital is
// capped at his slice so he can never spend the slow lane's cash, and vice versa.
// =============================================================

import { computeQualityMultiplier } from './quality-multiplier'

export type SharkAsset = 'stock' | 'crypto' | 'forex'

// Aggression band - conviction scales per-trade risk between these (system decides).
export const SHARK_MIN_RISK_PCT = 0.02   // marginal setup
export const SHARK_MAX_RISK_PCT = 0.08   // A+ conviction; hard ceiling, never exceeded
// One trade may use at most this fraction of Max's sleeve (prevents all-in on one bite).
export const SHARK_MAX_POSITION_PCT_OF_SLEEVE = 0.50

// ── Budget ledger ────────────────────────────────────────────

export interface SharkBudget {
  sleeve: number          // allocationPct × accountEquity - Max's total capital for this asset
  deployed: number        // current market value of Max's open positions in this asset
  available: number       // sleeve − deployed (never negative)
  allocationPct: number
}

/** Compute Max's available budget for an asset from his slider and what he's already holding. */
export function computeSharkBudget(
  allocationPct: number, accountEquity: number, deployedByMax: number,
): SharkBudget {
  const pct = Math.max(0, Math.min(1, allocationPct || 0))
  const sleeve = Math.max(0, accountEquity) * pct
  const deployed = Math.max(0, deployedByMax || 0)
  return { sleeve, deployed, available: Math.max(0, sleeve - deployed), allocationPct: pct }
}

// ── Aggressive, conviction-scaled sizing ─────────────────────

export interface SharkSizeInput {
  budget: SharkBudget
  entryPrice: number
  stopPrice: number
  minViableNotional: number     // exchange/user floor
  qualityGrade?: 'A' | 'B' | 'C' | null
  qualityConfidence?: number | null
  qualityRiskReward?: number | null
}

export interface SharkSizeResult {
  ok: boolean
  reason?: string
  notionalUsd?: number
  dollarRisk?: number
  riskPct?: number          // actual % of sleeve risked (surfaced for honesty)
  conviction?: number       // 0..1
  rationale?: string
}

export function computeSharkSize(input: SharkSizeInput): SharkSizeResult {
  const { budget, entryPrice, stopPrice, minViableNotional } = input
  if (budget.available <= 0) return { ok: false, reason: `Max is out of budget (sleeve $${budget.sleeve.toFixed(2)}, deployed $${budget.deployed.toFixed(2)})` }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: false, reason: `invalid entry ${entryPrice}` }
  const perUnitRisk = Math.abs(entryPrice - stopPrice)
  if (!(perUnitRisk > 0)) return { ok: false, reason: 'stop equals entry' }

  // Conviction 0..1 from the council's synthesis (grade × confidence × R:R).
  const qm = computeQualityMultiplier({
    grade: input.qualityGrade ?? null,
    confidence: input.qualityConfidence ?? null,
    riskReward: input.qualityRiskReward ?? null,
  })
  const conviction = qm ? Math.max(0, Math.min(1, (qm.multiplier - 0.25) / 1.25)) : 0.5

  // Hot when the numbers are good: risk% scales with conviction.
  const riskPct = SHARK_MIN_RISK_PCT + (SHARK_MAX_RISK_PCT - SHARK_MIN_RISK_PCT) * conviction
  const dollarRisk = budget.sleeve * riskPct
  const stopWidthPct = perUnitRisk / entryPrice

  // Risk-target notional, then bounded by: per-position cap, and Max's available cash.
  let notional = dollarRisk / stopWidthPct
  const perPositionCap = budget.sleeve * SHARK_MAX_POSITION_PCT_OF_SLEEVE
  notional = Math.min(notional, perPositionCap, budget.available)

  if (notional < minViableNotional) {
    return { ok: false, reason: `Max's slice can't clear floor: $${notional.toFixed(2)} < $${minViableNotional.toFixed(2)} (available $${budget.available.toFixed(2)})` }
  }

  const units = notional / entryPrice
  const actualDollarRisk = units * perUnitRisk
  const actualRiskPct = budget.sleeve > 0 ? (actualDollarRisk / budget.sleeve) * 100 : 0
  return {
    ok: true,
    notionalUsd: notional,
    dollarRisk: actualDollarRisk,
    riskPct: actualRiskPct,
    conviction,
    rationale: `Max: $${notional.toFixed(2)} (conviction ${(conviction * 100).toFixed(0)}%, risking ~${actualRiskPct.toFixed(1)}% of his $${budget.sleeve.toFixed(2)} sleeve)`,
  }
}

// ── Milestone ladder ($50 → $100 → $200 → …) ─────────────────

export function nextMilestone(currentEquity: number, startingEquity: number): number {
  const start = startingEquity > 0 ? startingEquity : 50
  let m = start
  while (m <= currentEquity) m *= 2
  return m
}

export function milestoneProgress(currentEquity: number, startingEquity: number): {
  start: number; next: number; prev: number; pctToNext: number
} {
  const start = startingEquity > 0 ? startingEquity : 50
  const next = nextMilestone(currentEquity, start)
  const prev = next / 2
  const pctToNext = next > prev ? Math.max(0, Math.min(1, (currentEquity - prev) / (next - prev))) : 0
  return { start, next, prev, pctToNext }
}

// ── Max's persona ────────────────────────────────────────────
// Confident, hungry, ruthless on losers - but NO performance promises or
// guarantees (that's both dishonest and legally fraught). Ambition, not a pledge.

export const MAX_PERSONA_SYSTEM = `You are "Max," an aggressive momentum day-trader persona running the day_shark lane.

VOICE: cocky, hungry, fast-talking, a little trash-talk. You live for momentum and clean breakouts. You celebrate every milestone toward doubling the account. You are RUTHLESS on losers - you cut them instantly, no ego, no hoping. That discipline is exactly why you survive to compound.

HARD RULES (never break, even in character):
- You NEVER promise or guarantee returns, profits, or outcomes. You talk about your MISSION to grow the account and your read on a setup - never a promise it will work. No "guaranteed," no "can't lose," no "the best."
- You state your conviction and your plan; you never overstate certainty.
- When you cut a loser, you own it flatly and move on - that's the job.
- You are a persona narrating decisions an automated system already made on a 1-day horizon. You do not invent trades or override the system's risk limits.

STYLE: short, punchy, energetic. One or two lines. You can name the milestone you're chasing.`

/** Build a milestone-aware narration header for Max given the account state. */
export function maxNarrationContext(currentEquity: number, startingEquity: number): string {
  const p = milestoneProgress(currentEquity, startingEquity)
  return `Account: $${currentEquity.toFixed(2)} | chasing $${p.next.toFixed(0)} (${(p.pctToNext * 100).toFixed(0)}% there from $${p.prev.toFixed(0)})`
}

// ── Max's voice ─────────────────────────────────────────────
// Deterministic narration - captures Max's cocky, ruthless-on-losers persona
// with zero LLM cost or latency in the money path. Honors MAX_PERSONA_SYSTEM's
// hard rules: states the plan and the milestone he's chasing, NEVER promises an
// outcome, owns losers flatly. Computed at event time from the trade data.

export type MaxEvent = 'entry' | 'target' | 'stop' | 'max_hold' | 'eod_cut' | 'ride'

export interface MaxNarrationInput {
  event: MaxEvent
  ticker: string
  grade?: string | null
  riskReward?: number | null
  gainPct?: number | null
  equity?: number
}

export function maxNarration(i: MaxNarrationInput): string {
  const chasing = i.equity && i.equity > 0 ? ` Chasing $${nextMilestone(i.equity, 0).toFixed(0)}.` : ''
  const rr = i.riskReward !== null && i.riskReward !== undefined ? `${i.riskReward.toFixed(1)}:1` : '?:1'
  const g = i.grade ? `${i.grade}-grade` : 'setup'
  const up = i.gainPct !== null && i.gainPct !== undefined ? ` (+${(i.gainPct * 100).toFixed(1)}%)` : ''
  switch (i.event) {
    case 'entry':    return `🦈 Biting ${i.ticker} - ${g}, ${rr}. Stop's set; I'm gone the second it cracks.${chasing}`
    case 'target':   return `${i.ticker} tagged target${up} - banked. That's how you compound.${chasing}`
    case 'stop':     return `Cut ${i.ticker} at the stop. No ego, no hoping - next.`
    case 'max_hold': return `${i.ticker} rode its night${up} - off the table. Day trade, not a marriage.${chasing}`
    case 'eod_cut':  return `${i.ticker} went nowhere into the close - cut. Losers don't sleep over.`
    case 'ride':     return `${i.ticker}'s green and strong${up} - it earns a night. Riding it.`
  }
}
