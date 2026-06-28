// =============================================================
// app/lib/trading/small-account-sizing.ts
//
// Small-account mode: lets a few-hundred-dollar account PARTICIPATE in the
// slow accumulation strategy instead of having every risk-sized position
// rejected for being below exchange/notional floors.
//
// How it differs from funded sizing:
//   - Funded: size = risk-based (risk% of equity); positions below a floor are
//     REJECTED to protect the risk budget.
//   - Small:  size = conviction-scaled allocation WITHIN [floor, cap], where
//     cap = SMALL_ACCOUNT_MAX_POSITION_PCT of equity. Sub-floor positions are
//     BUMPED UP to a viable size instead of skipped.
//
// Conviction comes from the SAME quality multiplier the funded sizers use
// (grade x confidence x R:R, i.e. the council's synthesis of the indicators
// and patterns). Strong setups size toward the cap; weak ones toward the floor.
//
// The tradeoff is explicit: on small capital you cannot both risk ~1% AND hold
// an exchange-viable position, so per-trade risk is necessarily higher. This
// helper computes and surfaces the IMPLIED risk% so it is never hidden.
// =============================================================

import { computeQualityMultiplier } from './quality-multiplier'

// Tunable policy (Hugh, 2026-06-28): 30% cap per position, take down to grade C.
export const SMALL_ACCOUNT_MAX_POSITION_PCT = 0.30
export const SMALL_ACCOUNT_MIN_GRADE: 'A' | 'B' | 'C' = 'C'
export const SMALL_ACCOUNT_DEFAULT_THRESHOLD = 1000   // equity below this → small mode active

const GRADE_RANK: Record<'A' | 'B' | 'C', number> = { A: 3, B: 2, C: 1 }

export interface SmallAccountInput {
  accountEquity: number
  entryPrice: number
  stopPrice: number
  minViableNotional: number          // max(exchange floor, user's min_trade_notional)
  maxPositionPct?: number             // default SMALL_ACCOUNT_MAX_POSITION_PCT
  qualityGrade?: 'A' | 'B' | 'C' | null
  qualityConfidence?: number | null
  qualityRiskReward?: number | null
}

export interface SmallAccountResult {
  ok: boolean
  reason?: string
  notionalUsd?: number
  dollarRisk?: number
  impliedRiskPct?: number
  conviction?: number                 // 0..1
  rationale?: string
}

/** True when small-account sizing should be used for this account right now. */
export function isSmallAccount(
  smallAccountMode: boolean | undefined,
  accountEquity: number,
  threshold: number | undefined,
): boolean {
  if (!smallAccountMode) return false
  const t = (threshold ?? SMALL_ACCOUNT_DEFAULT_THRESHOLD)
  return Number.isFinite(accountEquity) && accountEquity > 0 && accountEquity < t
}

export function computeSmallAccountNotional(input: SmallAccountInput): SmallAccountResult {
  const { accountEquity, entryPrice, stopPrice, minViableNotional } = input
  const capPct = input.maxPositionPct ?? SMALL_ACCOUNT_MAX_POSITION_PCT

  if (!Number.isFinite(accountEquity) || accountEquity <= 0) return { ok: false, reason: `invalid equity ${accountEquity}` }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: false, reason: `invalid entry ${entryPrice}` }
  const perUnitRisk = Math.abs(entryPrice - stopPrice)
  if (!(perUnitRisk > 0)) return { ok: false, reason: 'stop equals entry — per-unit risk is zero' }

  // Grade gate: skip setups weaker than the minimum (default C = take all).
  if (input.qualityGrade && GRADE_RANK[input.qualityGrade] < GRADE_RANK[SMALL_ACCOUNT_MIN_GRADE]) {
    return { ok: false, reason: `grade ${input.qualityGrade} below small-account minimum ${SMALL_ACCOUNT_MIN_GRADE}` }
  }

  const cap = accountEquity * capPct
  const floor = Math.max(0, minViableNotional)
  if (floor > cap) {
    return {
      ok: false,
      reason: `account too small: floor $${floor.toFixed(2)} exceeds ${(capPct * 100).toFixed(0)}% cap $${cap.toFixed(2)} (equity $${accountEquity.toFixed(2)})`,
    }
  }

  // Conviction 0..1 from the quality multiplier (0.25..1.5 → 0..1).
  const qm = computeQualityMultiplier({
    grade: input.qualityGrade ?? null,
    confidence: input.qualityConfidence ?? null,
    riskReward: input.qualityRiskReward ?? null,
  })
  const mult = qm?.multiplier ?? 0.75   // neutral when quality data is missing
  const conviction = Math.max(0, Math.min(1, (mult - 0.25) / 1.25))

  // Scale within [floor, cap] by conviction.
  const notionalUsd = floor + (cap - floor) * conviction
  const units = notionalUsd / entryPrice
  const dollarRisk = units * perUnitRisk
  const impliedRiskPct = (dollarRisk / accountEquity) * 100

  return {
    ok: true,
    notionalUsd,
    dollarRisk,
    impliedRiskPct,
    conviction,
    rationale: `small-acct $${notionalUsd.toFixed(2)} (conviction ${(conviction * 100).toFixed(0)}% in $${floor.toFixed(2)}-$${cap.toFixed(2)} band, ~${impliedRiskPct.toFixed(1)}% acct risk)`,
  }
}
