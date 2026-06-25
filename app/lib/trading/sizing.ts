// =============================================================
// app/lib/trading/sizing.ts
//
// Risk-parity position sizing.
//
// Formula:
//   dollarRisk        = accountEquity * riskPerTradePct
//   perShareRisk      = abs(entryPrice - stopPrice)
//   qty               = floor(dollarRisk / perShareRisk)
//   positionDollar    = qty * entryPrice
//   maxPositionDollar = accountEquity * maxPositionPct
//
// If positionDollar > maxPositionDollar, qty is capped to max position
// size and dollarRisk recomputed.
//
// Trader's positionSizePct (0..1) scales the final qty — e.g. if
// trader says "half size" we multiply by 0.5.
// =============================================================

export interface SizingInput {
  accountEquity: number
  riskPerTradePct: number       // e.g. 0.01 for 1%
  maxPositionPct: number        // e.g. 0.15 for 15%
  entryPrice: number
  stopPrice: number
  traderPositionSizePct?: number  // 0..1, defaults to 1
  minSharePrice?: number          // skip penny stocks; default $5
  allowFractionalShares?: boolean  // sub-1-share setups buy a fraction instead of skipping
  minDollarRisk?: number          // skip if computed risk < this; default $1

  // Per-trade dollar bounds (Audit Phase 2). All optional; null = unbounded.
  //   minDollarRiskPerTrade   floor on dollarRisk (skip below)
  //   maxDollarRiskPerTrade   ceiling on dollarRisk (scale qty down)
  //   minTradeNotional        floor on qty*entryPrice (skip below)
  //   maxTradeNotional        ceiling on qty*entryPrice (scale qty down)
  // Applied AFTER risk-parity sizing and maxPositionPct cap.
  minDollarRiskPerTrade?: number | null
  maxDollarRiskPerTrade?: number | null
  minTradeNotional?: number | null
  maxTradeNotional?: number | null

  // Quality-based sizing inputs (June 23, 2026).
  // Stronger setups get bigger size; weaker setups get smaller size.
  // Inputs come from the Trader's verdict (grade, confidence, R:R).
  //
  // If qualityGrade/qualityConfidence/qualityRiskReward are provided, the
  // computed multiplier scales dollarRisk between [0.25, 1.5] of base.
  //
  // PASS bypass interaction: when traderPositionSizePct is already <1.0
  // (e.g. 0.5 for PASS bypass), the quality multiplier is SKIPPED so the
  // bypass's reduced size doesn't get compounded into near-zero.
  qualityGrade?: 'A' | 'B' | 'C' | null
  qualityConfidence?: number | null
  qualityRiskReward?: number | null
}

export type SizingOutcome =
  | { ok: true; qty: number; dollarRisk: number; positionDollar: number; rationale: string; qualityMultiplier?: number; fractional?: boolean }
  | { ok: false; reason: string }

/**
 * Quality-based sizing multiplier. Stronger setups get bigger size.
 *
 * Inputs:
 *   grade        — Trader's quality grade (A best, C worst)
 *   confidence   — Council confidence percent (0-100)
 *   riskReward   — Council's R:R (e.g. 2.5 for 2.5:1)
 *
 * Returns a multiplier in [0.25, 1.5] applied to base dollarRisk.
 *
 * Calibration target (June 2026):
 *   A-grade × high-conf × high-RR → ~1.2 (120% normal size)
 *   B-grade × mid-conf × decent-RR → ~0.85
 *   C-grade × marginal-conf × marginal-RR → ~0.25 (floor)
 *
 * Returns null if any input is missing — caller treats as 1.0 (no scaling).
 */
export function computeQualityMultiplier(args: {
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

  // Grade factor — A is canonical 1.0, B and C step down
  const gradeMult = grade === 'A' ? 1.0
                  : grade === 'B' ? 0.75
                  : 0.5

  // Confidence factor — high conviction gets full size
  const confMult = confidence >= 80 ? 1.0
                 : confidence >= 70 ? 0.85
                 : confidence >= 60 ? 0.70
                 : 0.55

  // R:R factor — better risk/reward earns size, marginal R:R shrinks size
  const rrMult = riskReward >= 3.0 ? 1.2
               : riskReward >= 2.0 ? 1.0
               : riskReward >= 1.5 ? 0.75
               : 0.5

  const raw = gradeMult * confMult * rrMult
  // Clamp to defensible bounds — keeps a Grade-C trade from going below 25%
  // of normal (still meaningful) and an A-grade from going above 150%
  // (avoid overconcentration when stars align).
  const multiplier = Math.max(0.25, Math.min(1.5, raw))

  return {
    multiplier,
    rationale: `quality ${multiplier.toFixed(2)}x (grade=${grade}:${gradeMult}, conf=${confidence}%:${confMult}, R:R=${riskReward.toFixed(1)}:${rrMult.toFixed(2)})`,
  }
}

export function computePositionSize(input: SizingInput): SizingOutcome {
  const {
    accountEquity,
    riskPerTradePct,
    maxPositionPct,
    entryPrice,
    stopPrice,
    traderPositionSizePct = 1,
    minSharePrice = 3,
    allowFractionalShares = false,
    minDollarRisk = 1,
    minDollarRiskPerTrade = null,
    maxDollarRiskPerTrade = null,
    minTradeNotional = null,
    maxTradeNotional = null,
    qualityGrade = null,
    qualityConfidence = null,
    qualityRiskReward = null,
  } = input

  // Defensive validation — these should be caught upstream but we double-check
  // because sizing bugs cost real money.
  if (!Number.isFinite(accountEquity) || accountEquity <= 0) {
    return { ok: false, reason: `Invalid accountEquity: ${accountEquity}` }
  }
  if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 0.05) {
    return { ok: false, reason: `Invalid riskPerTradePct: ${riskPerTradePct}` }
  }
  if (!Number.isFinite(maxPositionPct) || maxPositionPct <= 0 || maxPositionPct > 0.50) {
    return { ok: false, reason: `Invalid maxPositionPct: ${maxPositionPct}` }
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { ok: false, reason: `Invalid entryPrice: ${entryPrice}` }
  }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    return { ok: false, reason: `Invalid stopPrice: ${stopPrice}` }
  }
  if (entryPrice < minSharePrice) {
    return { ok: false, reason: `Share price ${entryPrice.toFixed(2)} below min ${minSharePrice}` }
  }
  if (!Number.isFinite(traderPositionSizePct) || traderPositionSizePct <= 0 || traderPositionSizePct > 1) {
    return { ok: false, reason: `Invalid traderPositionSizePct: ${traderPositionSizePct}` }
  }

  const perShareRisk = Math.abs(entryPrice - stopPrice)
  if (perShareRisk <= 0) {
    return { ok: false, reason: 'Stop equals entry — per-share risk is zero' }
  }

  // Reject absurdly tight stops (would create infinite leverage). If stop is
  // less than 0.1% of entry, something is wrong with the verdict's stop.
  const stopWidthPct = perShareRisk / entryPrice
  if (stopWidthPct < 0.001) {
    return { ok: false, reason: `Stop too tight: ${(stopWidthPct * 100).toFixed(3)}% below 0.1% minimum` }
  }
  if (stopWidthPct > 0.30) {
    return { ok: false, reason: `Stop too wide: ${(stopWidthPct * 100).toFixed(1)}% above 30% maximum` }
  }

  // Base dollar risk
  let dollarRisk = accountEquity * riskPerTradePct
  if (dollarRisk < minDollarRisk) {
    return { ok: false, reason: `Account too small: $${dollarRisk.toFixed(2)} risk below $${minDollarRisk}` }
  }

  // Apply Trader's positionSizePct scaling (e.g. PASS bypass uses 0.5)
  dollarRisk *= traderPositionSizePct

  // Quality multiplier (June 23 2026): scale by setup quality.
  // SKIPPED when traderPositionSizePct < 1 — that's a PASS bypass case and
  // the bypass's reduced size shouldn't be compounded with quality math.
  // PASS bypass trades are weak by definition; the 0.5x is the cap.
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

  // Risk-parity qty (whole shares)
  let qty = Math.floor(dollarRisk / perShareRisk)
  if (qty < 1) {
    if (!allowFractionalShares) {
      return { ok: false, reason: `Sized to 0 shares (dollarRisk=${dollarRisk.toFixed(2)}, perShareRisk=${perShareRisk.toFixed(2)})` }
    }
    // Fractional path: a sub-1-share position is the smallest possible, so the
    // upper-bound caps (max position %, max notional) can't bind. Use the
    // unfloored risk-based size and validate only the lower bounds + Alpaca's
    // $1 fractional-notional minimum. The stop is monitor-owned (no bracket).
    const fracQty = Math.round((dollarRisk / perShareRisk) * 1e6) / 1e6
    const fracNotional = fracQty * entryPrice
    const ALPACA_FRACTIONAL_MIN_NOTIONAL = 1
    if (!Number.isFinite(fracQty) || fracQty <= 0) {
      return { ok: false, reason: `fractional sizing produced ${fracQty} shares` }
    }
    if (fracNotional < ALPACA_FRACTIONAL_MIN_NOTIONAL) {
      return { ok: false, reason: `fractional notional $${fracNotional.toFixed(2)} below $1 Alpaca minimum` }
    }
    if (minDollarRiskPerTrade !== null && Number.isFinite(minDollarRiskPerTrade) && minDollarRiskPerTrade > 0 && dollarRisk < minDollarRiskPerTrade) {
      return { ok: false, reason: `fractional dollarRisk $${dollarRisk.toFixed(2)} below min_dollar_risk_per_trade $${minDollarRiskPerTrade.toFixed(2)}` }
    }
    return {
      ok: true,
      qty: fracQty,
      dollarRisk,
      positionDollar: fracNotional,
      fractional: true,
      qualityMultiplier: qualityMultiplierApplied,
      rationale: `${fracQty} fractional shares ($${fracNotional.toFixed(2)} notional, $${dollarRisk.toFixed(2)} risk at ${(stopWidthPct * 100).toFixed(2)}% stop — monitor-owned stop)`,
    }
  }

  let positionDollar = qty * entryPrice
  const maxPositionDollar = accountEquity * maxPositionPct

  let capped = false
  let cappedReason: string | null = null
  if (positionDollar > maxPositionDollar) {
    qty = Math.floor(maxPositionDollar / entryPrice)
    if (qty < 1) {
      return { ok: false, reason: `Max position cap (${(maxPositionPct * 100).toFixed(0)}%) sizes to 0 shares at $${entryPrice}` }
    }
    positionDollar = qty * entryPrice
    dollarRisk = qty * perShareRisk
    capped = true
    cappedReason = `${(maxPositionPct * 100).toFixed(0)}% max position`
  }

  // Per-trade dollar ceilings (Audit Phase 2) — scale qty down to honor these
  if (maxDollarRiskPerTrade !== null && Number.isFinite(maxDollarRiskPerTrade) && maxDollarRiskPerTrade > 0) {
    if (dollarRisk > maxDollarRiskPerTrade) {
      qty = Math.floor(maxDollarRiskPerTrade / perShareRisk)
      if (qty < 1) {
        return { ok: false, reason: `max_dollar_risk_per_trade $${maxDollarRiskPerTrade.toFixed(2)} sizes to 0 shares (perShareRisk=$${perShareRisk.toFixed(2)})` }
      }
      positionDollar = qty * entryPrice
      dollarRisk = qty * perShareRisk
      capped = true
      cappedReason = `max_dollar_risk_per_trade $${maxDollarRiskPerTrade.toFixed(2)}`
    }
  }
  if (maxTradeNotional !== null && Number.isFinite(maxTradeNotional) && maxTradeNotional > 0) {
    if (positionDollar > maxTradeNotional) {
      qty = Math.floor(maxTradeNotional / entryPrice)
      if (qty < 1) {
        return { ok: false, reason: `max_trade_notional $${maxTradeNotional.toFixed(2)} sizes to 0 shares at $${entryPrice}` }
      }
      positionDollar = qty * entryPrice
      dollarRisk = qty * perShareRisk
      capped = true
      cappedReason = `max_trade_notional $${maxTradeNotional.toFixed(2)}`
    }
  }

  // Per-trade dollar floors — skip if below
  if (minDollarRiskPerTrade !== null && Number.isFinite(minDollarRiskPerTrade) && minDollarRiskPerTrade > 0) {
    if (dollarRisk < minDollarRiskPerTrade) {
      return { ok: false, reason: `dollarRisk $${dollarRisk.toFixed(2)} below min_dollar_risk_per_trade $${minDollarRiskPerTrade.toFixed(2)}` }
    }
  }
  if (minTradeNotional !== null && Number.isFinite(minTradeNotional) && minTradeNotional > 0) {
    if (positionDollar < minTradeNotional) {
      return { ok: false, reason: `positionDollar $${positionDollar.toFixed(2)} below min_trade_notional $${minTradeNotional.toFixed(2)}` }
    }
  }

  return {
    ok: true,
    qty,
    dollarRisk,
    positionDollar,
    qualityMultiplier: qualityMultiplierApplied,
    rationale: capped
      ? `${qty} shares (capped by ${cappedReason ?? 'cap'}, $${dollarRisk.toFixed(2)} risk${qualityRationale ? `, ${qualityRationale}` : ''})`
      : `${qty} shares ($${dollarRisk.toFixed(2)} risk at ${(stopWidthPct * 100).toFixed(2)}% stop${qualityRationale ? `, ${qualityRationale}` : ''})`,
  }
}
