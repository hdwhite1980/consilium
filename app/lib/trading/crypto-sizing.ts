import { isSmallAccount, computeSmallAccountNotional } from './small-account-sizing'
// =============================================================
// app/lib/trading/crypto-sizing.ts
//
// Crypto sizing: notional dollar amount + protective stop.
// Crypto trades fractional so we don't floor to whole units.
//
// Formula:
//   dollarRisk      = accountEquity * cryptoRiskPerTradePct
//   perUnitRisk     = abs(entry - stop)
//   units           = dollarRisk / perUnitRisk     (fractional OK)
//   notionalDollar  = units * entry
//   maxNotional     = accountEquity * maxPositionPct
//   → cap if exceeds
// =============================================================

export interface CryptoSizingInput {
  accountEquity: number
  riskPerTradePct: number
  maxPositionPct: number
  entryPrice: number
  stopPrice: number
  traderPositionSizePct?: number
  minNotional?: number              // skip if computed notional below this

  // Per-trade dollar bounds (Audit Phase 2). NULL = unbounded.
  minDollarRiskPerTrade?: number | null
  maxDollarRiskPerTrade?: number | null
  minTradeNotional?: number | null
  maxTradeNotional?: number | null

  // Quality-based sizing inputs (June 23, 2026) — parallels stock sizing.
  // Skipped when traderPositionSizePct < 0.99 (PASS/WAIT bypass exemption).
  qualityGrade?: 'A' | 'B' | 'C' | null
  qualityConfidence?: number | null
  qualityRiskReward?: number | null

  // Small-account mode (June 28, 2026): when on and equity < threshold, switch
  // to conviction-scaled allocation within [floor, cap] instead of rejecting
  // sub-floor positions. See small-account-sizing.ts.
  smallAccountMode?: boolean
  smallAccountThreshold?: number
}

export type CryptoSizingOutcome =
  | { ok: true; units: number; notionalUsd: number; dollarRisk: number; rationale: string; qualityMultiplier?: number }
  | { ok: false; reason: string }

/**
 * Quality multiplier for crypto sizing — mirrors the stock implementation.
 * Returns null if any input is missing (caller treats as 1.0 = no scaling).
 * Clamped to [0.25, 1.5] like stocks.
 */
function computeQualityMultiplier(args: {
  grade: 'A' | 'B' | 'C' | null | undefined
  confidence: number | null | undefined
  riskReward: number | null | undefined
}): { multiplier: number; rationale: string } | null {
  const { grade, confidence, riskReward } = args
  if (!grade || confidence === null || confidence === undefined ||
      riskReward === null || riskReward === undefined) {
    return null
  }
  if (!Number.isFinite(confidence) || !Number.isFinite(riskReward)) {
    return null
  }
  const gradeMult = grade === 'A' ? 1.0 : grade === 'B' ? 0.75 : 0.5
  const confMult = confidence >= 80 ? 1.0
                 : confidence >= 70 ? 0.85
                 : confidence >= 60 ? 0.70
                 : 0.55
  const rrMult = riskReward >= 3.0 ? 1.2
               : riskReward >= 2.0 ? 1.0
               : riskReward >= 1.5 ? 0.75
               : 0.5
  const raw = gradeMult * confMult * rrMult
  const multiplier = Math.max(0.25, Math.min(1.5, raw))
  return {
    multiplier,
    rationale: `quality ${multiplier.toFixed(2)}x (grade=${grade}:${gradeMult}, conf=${confidence}%:${confMult}, R:R=${riskReward.toFixed(1)}:${rrMult.toFixed(2)})`,
  }
}

export function computeCryptoSize(input: CryptoSizingInput): CryptoSizingOutcome {
  const {
    accountEquity, riskPerTradePct, maxPositionPct,
    entryPrice, stopPrice,
    traderPositionSizePct = 1, minNotional = 10,
    minDollarRiskPerTrade = null,
    maxDollarRiskPerTrade = null,
    minTradeNotional = null,
    maxTradeNotional = null,
    qualityGrade = null,
    qualityConfidence = null,
    qualityRiskReward = null,
    smallAccountMode = false,
    smallAccountThreshold = undefined,
  } = input

  if (!Number.isFinite(accountEquity) || accountEquity <= 0) return { ok: false, reason: `Invalid accountEquity: ${accountEquity}` }
  if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 0.05) return { ok: false, reason: `Invalid riskPerTradePct: ${riskPerTradePct}` }
  if (!Number.isFinite(maxPositionPct) || maxPositionPct <= 0 || maxPositionPct > 0.50) return { ok: false, reason: `Invalid maxPositionPct: ${maxPositionPct}` }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: false, reason: `Invalid entryPrice: ${entryPrice}` }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return { ok: false, reason: `Invalid stopPrice: ${stopPrice}` }
  if (!Number.isFinite(traderPositionSizePct) || traderPositionSizePct <= 0 || traderPositionSizePct > 1) return { ok: false, reason: `Invalid traderPositionSizePct: ${traderPositionSizePct}` }

  const perUnitRisk = Math.abs(entryPrice - stopPrice)
  if (perUnitRisk <= 0) return { ok: false, reason: 'Stop equals entry — per-unit risk is zero' }

  // ── Small-account mode: conviction-scaled allocation instead of risk-parity ──
  if (isSmallAccount(smallAccountMode, accountEquity, smallAccountThreshold)) {
    const floor = Math.max(minTradeNotional ?? 0, minNotional ?? 0, 1)
    const sa = computeSmallAccountNotional({
      accountEquity, entryPrice, stopPrice, minViableNotional: floor,
      qualityGrade, qualityConfidence, qualityRiskReward,
    })
    if (!sa.ok) return { ok: false, reason: sa.reason ?? 'small-account sizing failed' }
    let saUnits = Math.floor((sa.notionalUsd! / entryPrice) * 1_000_000) / 1_000_000
    if (saUnits <= 0) return { ok: false, reason: 'small-account sized to 0 units' }
    return {
      ok: true,
      units: saUnits,
      notionalUsd: saUnits * entryPrice,
      dollarRisk: sa.dollarRisk ?? 0,
      qualityMultiplier: undefined,
      rationale: sa.rationale ?? 'small-account',
    }
  }

  const stopWidthPct = perUnitRisk / entryPrice
  if (stopWidthPct < 0.001) return { ok: false, reason: `Stop too tight: ${(stopWidthPct * 100).toFixed(3)}%` }
  if (stopWidthPct > 0.30) return { ok: false, reason: `Stop too wide: ${(stopWidthPct * 100).toFixed(1)}%` }

  let dollarRisk = accountEquity * riskPerTradePct * traderPositionSizePct

  // Quality multiplier (June 23 2026): scale by setup quality.
  // SKIPPED when traderPositionSizePct < 0.99 (PASS/WAIT bypass exemption).
  let qualityMultiplierApplied: number | undefined = undefined
  let qualityRationale: string | null = null
  if (traderPositionSizePct >= 0.99) {
    const qm = computeQualityMultiplier({
      grade: qualityGrade,
      confidence: qualityConfidence,
      riskReward: qualityRiskReward,
    })
    if (qm !== null) {
      dollarRisk *= qm.multiplier
      qualityMultiplierApplied = qm.multiplier
      qualityRationale = qm.rationale
    }
  }

  let units = dollarRisk / perUnitRisk
  let notionalUsd = units * entryPrice
  const maxNotional = accountEquity * maxPositionPct

  let capped = false
  let cappedReason: string | null = null
  if (notionalUsd > maxNotional) {
    units = maxNotional / entryPrice
    notionalUsd = units * entryPrice
    dollarRisk = units * perUnitRisk
    capped = true
    cappedReason = `${(maxPositionPct * 100).toFixed(0)}% notional`
  }

  // Per-trade dollar ceilings (Audit Phase 2)
  if (maxDollarRiskPerTrade !== null && Number.isFinite(maxDollarRiskPerTrade) && maxDollarRiskPerTrade > 0) {
    if (dollarRisk > maxDollarRiskPerTrade) {
      units = maxDollarRiskPerTrade / perUnitRisk
      notionalUsd = units * entryPrice
      dollarRisk = units * perUnitRisk
      capped = true
      cappedReason = `max_dollar_risk_per_trade $${maxDollarRiskPerTrade.toFixed(2)}`
    }
  }
  if (maxTradeNotional !== null && Number.isFinite(maxTradeNotional) && maxTradeNotional > 0) {
    if (notionalUsd > maxTradeNotional) {
      units = maxTradeNotional / entryPrice
      notionalUsd = units * entryPrice
      dollarRisk = units * perUnitRisk
      capped = true
      cappedReason = `max_trade_notional $${maxTradeNotional.toFixed(2)}`
    }
  }

  if (notionalUsd < minNotional) {
    return { ok: false, reason: `Notional $${notionalUsd.toFixed(2)} below min $${minNotional}` }
  }

  // Per-trade dollar floors
  if (minDollarRiskPerTrade !== null && Number.isFinite(minDollarRiskPerTrade) && minDollarRiskPerTrade > 0) {
    if (dollarRisk < minDollarRiskPerTrade) {
      return { ok: false, reason: `dollarRisk $${dollarRisk.toFixed(2)} below min_dollar_risk_per_trade $${minDollarRiskPerTrade.toFixed(2)}` }
    }
  }
  if (minTradeNotional !== null && Number.isFinite(minTradeNotional) && minTradeNotional > 0) {
    if (notionalUsd < minTradeNotional) {
      return { ok: false, reason: `notional $${notionalUsd.toFixed(2)} below min_trade_notional $${minTradeNotional.toFixed(2)}` }
    }
  }

  // Round units to 6 decimals (Alpaca min step for most coins is finer than this)
  units = Math.floor(units * 1_000_000) / 1_000_000
  notionalUsd = units * entryPrice

  if (units <= 0) return { ok: false, reason: 'Sized to 0 units after rounding' }

  return {
    ok: true,
    units,
    notionalUsd,
    dollarRisk,
    qualityMultiplier: qualityMultiplierApplied,
    rationale: capped
      ? `${units.toFixed(6)} units (capped by ${cappedReason ?? 'cap'}, $${dollarRisk.toFixed(2)} risk${qualityRationale ? `, ${qualityRationale}` : ''})`
      : `${units.toFixed(6)} units ($${dollarRisk.toFixed(2)} risk at ${(stopWidthPct * 100).toFixed(2)}% stop${qualityRationale ? `, ${qualityRationale}` : ''})`,
  }
}
