// =============================================================
// app/lib/trading/coinbase-futures-sizing.ts
//
// Position sizing for Coinbase Financial Markets (CFM) futures.
//
// PROTECTION SPINE — this file is the reason a leveraged, real-money
// futures position can't quietly blow through the account. It mirrors the
// stock/crypto risk model (risk-% of equity, quality multiplier, dollar
// bounds) and ADDS the three protections that only matter for leveraged
// derivatives:
//
//   1. LEVERAGE CAP  — contracts are reduced until notional / equity stays
//      under maxLeverage (default conservative, NOT the 10x the exchange
//      allows). Leverage is expressed through SIZE because CFM sets the
//      account leverage from margin-window settings, not per order.
//   2. MARGIN GATE   — estimated initial margin for the position must fit
//      inside available CFM margin (with a safety haircut). Prevents the
//      auto-sweep from pulling more spot cash than intended / rejection.
//   3. LIQUIDATION BUFFER — the protective stop must sit comfortably INSIDE
//      the liquidation price, so the stop closes the trade before the
//      exchange force-liquidates. If the stop is wider than the liquidation
//      distance (minus a safety cushion), the setup is REJECTED.
//
// Contracts are integers (futures are not fractional). If the risk budget
// can't afford even one contract within all guards, we SKIP — never
// over-risk to "make it fit."
// =============================================================

export interface FuturesSizingInput {
  /** Total CFM futures-account equity used as the risk base. */
  accountEquity: number
  /** Available CFM margin for the margin gate (≤ accountEquity). */
  availableMargin: number
  /** Fraction of equity risked per trade, e.g. 0.01. Hard-capped at 5%. */
  riskPerTradePct: number

  entryPrice: number
  stopPrice: number
  side: 'long' | 'short'

  /** Base units controlled by ONE contract (e.g. 0.01 BTC, 5 SOL, 1 troy oz). */
  contractSize: number
  /** Exchange initial margin required per contract, if known (USD). When
   *  null we fall back to a conservative notional margin rate. */
  initialMarginPerContract?: number | null

  /** Hard leverage ceiling enforced via size. Default 2x (conservative). */
  maxLeverage?: number

  /** Trader sizing fraction (PASS/WAIT bypass < 1). Default 1. */
  traderPositionSizePct?: number

  // Per-trade dollar bounds (parity with stock/crypto). NULL = unbounded.
  minDollarRiskPerTrade?: number | null
  maxDollarRiskPerTrade?: number | null
  minTradeNotional?: number | null
  maxTradeNotional?: number | null

  // Quality-based sizing (parity with stock/crypto). Skipped when
  // traderPositionSizePct < 0.99 (bypass exemption).
  qualityGrade?: 'A' | 'B' | 'C' | null
  qualityConfidence?: number | null
  qualityRiskReward?: number | null
}

export type FuturesSizingOutcome =
  | {
      ok: true
      contracts: number
      notionalUsd: number
      marginUsd: number
      dollarRisk: number
      effectiveLeverage: number
      liquidationPrice: number
      rationale: string
      qualityMultiplier?: number
    }
  | { ok: false; reason: string }

// Conservative defaults — chosen to protect a small account, not to maximize
// exposure. All overridable per call / per user settings later.
const DEFAULT_MAX_LEVERAGE = 2
// When the exchange's per-contract initial margin isn't supplied, assume this
// fraction of notional is reserved. Deliberately high so we never UNDER-reserve.
const FALLBACK_MARGIN_RATE = 0.20
// Available-margin safety haircut for the gate.
const MARGIN_SAFETY = 0.90
// The stop must sit within this fraction of the liquidation distance. 0.70 ⇒
// the stop fires with a 30% cushion before liquidation.
const LIQ_SAFETY_FRACTION = 0.70
// Maintenance-margin estimate used only to report a liquidation price for logs.
const MAINTENANCE_MARGIN_RATE = 0.05

function computeQualityMultiplier(args: {
  grade: 'A' | 'B' | 'C' | null | undefined
  confidence: number | null | undefined
  riskReward: number | null | undefined
}): { multiplier: number; rationale: string } | null {
  const { grade, confidence, riskReward } = args
  if (!grade || confidence === null || confidence === undefined ||
      riskReward === null || riskReward === undefined) return null
  if (!Number.isFinite(confidence) || !Number.isFinite(riskReward)) return null
  const gradeMult = grade === 'A' ? 1.0 : grade === 'B' ? 0.75 : 0.5
  const confMult = confidence >= 80 ? 1.0
                 : confidence >= 70 ? 0.85
                 : confidence >= 60 ? 0.70
                 : 0.55
  const rrMult = riskReward >= 3.0 ? 1.2
               : riskReward >= 2.0 ? 1.0
               : riskReward >= 1.5 ? 0.75
               : 0.5
  const multiplier = Math.max(0.25, Math.min(1.5, gradeMult * confMult * rrMult))
  return {
    multiplier,
    rationale: `quality ${multiplier.toFixed(2)}x (grade=${grade}, conf=${confidence}%, R:R=${riskReward.toFixed(1)})`,
  }
}

/**
 * Liquidation price estimate for a leveraged position.
 *   long:  entry * (1 - 1/L + mmr)
 *   short: entry * (1 + 1/L - mmr)
 * Used for logging + the buffer guard (which itself uses the distance form,
 * independent of mmr, so it stays conservative regardless of this estimate).
 */
function liquidationPrice(entry: number, leverage: number, side: 'long' | 'short'): number {
  const inv = leverage > 0 ? 1 / leverage : 1
  return side === 'long'
    ? entry * (1 - inv + MAINTENANCE_MARGIN_RATE)
    : entry * (1 + inv - MAINTENANCE_MARGIN_RATE)
}

export function computeFuturesSize(input: FuturesSizingInput): FuturesSizingOutcome {
  const {
    accountEquity, availableMargin, riskPerTradePct,
    entryPrice, stopPrice, side,
    contractSize,
    initialMarginPerContract = null,
    maxLeverage = DEFAULT_MAX_LEVERAGE,
    traderPositionSizePct = 1,
    minDollarRiskPerTrade = null,
    maxDollarRiskPerTrade = null,
    minTradeNotional = null,
    maxTradeNotional = null,
    qualityGrade = null,
    qualityConfidence = null,
    qualityRiskReward = null,
  } = input

  // ── Input validation ─────────────────────────────────────
  if (!Number.isFinite(accountEquity) || accountEquity <= 0) return { ok: false, reason: `Invalid accountEquity: ${accountEquity}` }
  if (!Number.isFinite(availableMargin) || availableMargin < 0) return { ok: false, reason: `Invalid availableMargin: ${availableMargin}` }
  if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 0.05) return { ok: false, reason: `Invalid riskPerTradePct: ${riskPerTradePct}` }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: false, reason: `Invalid entryPrice: ${entryPrice}` }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return { ok: false, reason: `Invalid stopPrice: ${stopPrice}` }
  if (!Number.isFinite(contractSize) || contractSize <= 0) return { ok: false, reason: `Invalid contractSize: ${contractSize}` }
  if (!Number.isFinite(maxLeverage) || maxLeverage <= 0 || maxLeverage > 10) return { ok: false, reason: `Invalid maxLeverage: ${maxLeverage}` }
  if (!Number.isFinite(traderPositionSizePct) || traderPositionSizePct <= 0 || traderPositionSizePct > 1) return { ok: false, reason: `Invalid traderPositionSizePct: ${traderPositionSizePct}` }

  // Stop must be on the correct side of entry for the direction.
  if (side === 'long' && stopPrice >= entryPrice) return { ok: false, reason: `Long stop ${stopPrice} must be below entry ${entryPrice}` }
  if (side === 'short' && stopPrice <= entryPrice) return { ok: false, reason: `Short stop ${stopPrice} must be above entry ${entryPrice}` }

  const perUnitRisk = Math.abs(entryPrice - stopPrice)
  if (perUnitRisk <= 0) return { ok: false, reason: 'Stop equals entry — per-unit risk is zero' }

  const stopWidthPct = perUnitRisk / entryPrice
  if (stopWidthPct < 0.001) return { ok: false, reason: `Stop too tight: ${(stopWidthPct * 100).toFixed(3)}%` }
  if (stopWidthPct > 0.30) return { ok: false, reason: `Stop too wide: ${(stopWidthPct * 100).toFixed(1)}%` }

  // ── LIQUIDATION BUFFER (futures-only protection) ─────────
  // The stop must fire before the exchange liquidates. Liquidation distance
  // ≈ 1/leverage; require the stop to sit inside LIQ_SAFETY_FRACTION of it.
  // This binds the MAX leverage allowed for THIS stop width:
  //   stopWidthPct ≤ LIQ_SAFETY_FRACTION / L   ⇒   L ≤ LIQ_SAFETY_FRACTION / stopWidthPct
  const leverageAllowedByStop = LIQ_SAFETY_FRACTION / stopWidthPct
  const effMaxLeverage = Math.min(maxLeverage, leverageAllowedByStop)
  if (effMaxLeverage < 1) {
    return {
      ok: false,
      reason: `Stop too wide for safe leverage: a ${(stopWidthPct * 100).toFixed(1)}% stop allows only ${leverageAllowedByStop.toFixed(2)}x before liquidation risk (need ≥1x)`,
    }
  }

  // ── Risk-based contract count ────────────────────────────
  let dollarRisk = accountEquity * riskPerTradePct * traderPositionSizePct

  let qualityMultiplierApplied: number | undefined
  if (traderPositionSizePct >= 0.99) {
    const qm = computeQualityMultiplier({ grade: qualityGrade, confidence: qualityConfidence, riskReward: qualityRiskReward })
    if (qm !== null) {
      dollarRisk *= qm.multiplier
      qualityMultiplierApplied = qm.multiplier
    }
  }

  const perContractRisk = perUnitRisk * contractSize
  if (perContractRisk <= 0) return { ok: false, reason: 'Per-contract risk is zero' }

  let contracts = Math.floor(dollarRisk / perContractRisk)
  if (contracts < 1) {
    return {
      ok: false,
      reason: `Risk budget $${dollarRisk.toFixed(2)} can't afford 1 contract (risk/contract $${perContractRisk.toFixed(2)}) — too small to size without over-risking`,
    }
  }

  // ── LEVERAGE CAP (futures-only protection) ───────────────
  // Reduce contracts until notional / equity ≤ effMaxLeverage.
  const maxNotional = accountEquity * effMaxLeverage
  const contractNotional = contractSize * entryPrice
  const maxContractsByLeverage = Math.floor(maxNotional / contractNotional)
  if (maxContractsByLeverage < 1) {
    return {
      ok: false,
      reason: `Even 1 contract ($${contractNotional.toFixed(2)} notional) exceeds ${effMaxLeverage.toFixed(2)}x of equity $${accountEquity.toFixed(2)}`,
    }
  }
  let capped: string | null = null
  if (contracts > maxContractsByLeverage) {
    contracts = maxContractsByLeverage
    capped = `${effMaxLeverage.toFixed(2)}x leverage cap`
  }

  // Recompute actuals after any cap.
  let notionalUsd = contracts * contractNotional
  dollarRisk = contracts * perContractRisk
  const effectiveLeverage = notionalUsd / accountEquity

  // ── Notional ceiling (optional, parity with crypto) ──────
  if (maxTradeNotional !== null && Number.isFinite(maxTradeNotional) && maxTradeNotional > 0 && notionalUsd > maxTradeNotional) {
    const allowed = Math.floor(maxTradeNotional / contractNotional)
    if (allowed < 1) return { ok: false, reason: `1 contract notional $${contractNotional.toFixed(2)} exceeds maxTradeNotional $${maxTradeNotional}` }
    contracts = allowed
    notionalUsd = contracts * contractNotional
    dollarRisk = contracts * perContractRisk
    capped = capped ? `${capped} + max notional` : 'max notional'
  }

  // ── Dollar-risk ceiling (parity) ─────────────────────────
  if (maxDollarRiskPerTrade !== null && Number.isFinite(maxDollarRiskPerTrade) && maxDollarRiskPerTrade > 0 && dollarRisk > maxDollarRiskPerTrade) {
    const allowed = Math.floor(maxDollarRiskPerTrade / perContractRisk)
    if (allowed < 1) return { ok: false, reason: `1 contract risk $${perContractRisk.toFixed(2)} exceeds maxDollarRiskPerTrade $${maxDollarRiskPerTrade}` }
    contracts = allowed
    notionalUsd = contracts * contractNotional
    dollarRisk = contracts * perContractRisk
    capped = capped ? `${capped} + max $risk` : 'max $risk'
  }

  // ── Floors ───────────────────────────────────────────────
  if (minDollarRiskPerTrade !== null && Number.isFinite(minDollarRiskPerTrade) && minDollarRiskPerTrade > 0 && dollarRisk < minDollarRiskPerTrade) {
    return { ok: false, reason: `Dollar risk $${dollarRisk.toFixed(2)} below floor $${minDollarRiskPerTrade}` }
  }
  if (minTradeNotional !== null && Number.isFinite(minTradeNotional) && minTradeNotional > 0 && notionalUsd < minTradeNotional) {
    return { ok: false, reason: `Notional $${notionalUsd.toFixed(2)} below floor $${minTradeNotional}` }
  }

  // ── MARGIN GATE (futures-only protection) ────────────────
  const marginPerContract = initialMarginPerContract !== null && Number.isFinite(initialMarginPerContract) && (initialMarginPerContract as number) > 0
    ? (initialMarginPerContract as number)
    : contractNotional * FALLBACK_MARGIN_RATE
  let marginUsd = contracts * marginPerContract
  const safeMargin = availableMargin * MARGIN_SAFETY
  if (marginUsd > safeMargin) {
    // Try to shrink to fit available margin rather than outright reject.
    const allowed = Math.floor(safeMargin / marginPerContract)
    if (allowed < 1) {
      return { ok: false, reason: `Insufficient CFM margin: need $${marginPerContract.toFixed(2)}/contract, have $${safeMargin.toFixed(2)} usable` }
    }
    contracts = allowed
    notionalUsd = contracts * contractNotional
    dollarRisk = contracts * perContractRisk
    marginUsd = contracts * marginPerContract
    capped = capped ? `${capped} + margin fit` : 'margin fit'
  }

  const liqPrice = liquidationPrice(entryPrice, notionalUsd / accountEquity, side)

  const rationaleParts = [
    `${contracts} contract(s) ${side}`,
    `notional $${notionalUsd.toFixed(2)}`,
    `${(notionalUsd / accountEquity).toFixed(2)}x lev (cap ${effMaxLeverage.toFixed(2)}x)`,
    `risk $${dollarRisk.toFixed(2)}`,
    `margin $${marginUsd.toFixed(2)}`,
    `liq≈${liqPrice.toFixed(2)} (stop ${stopPrice.toFixed(2)})`,
  ]
  if (qualityMultiplierApplied !== undefined) rationaleParts.push(`q×${qualityMultiplierApplied.toFixed(2)}`)
  if (capped) rationaleParts.push(`capped:${capped}`)

  return {
    ok: true,
    contracts,
    notionalUsd,
    marginUsd,
    dollarRisk,
    effectiveLeverage: notionalUsd / accountEquity,
    liquidationPrice: liqPrice,
    rationale: rationaleParts.join(' · '),
    qualityMultiplier: qualityMultiplierApplied,
  }
}
