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
}

export type SizingOutcome =
  | { ok: true; qty: number; dollarRisk: number; positionDollar: number; rationale: string }
  | { ok: false; reason: string }

export function computePositionSize(input: SizingInput): SizingOutcome {
  const {
    accountEquity,
    riskPerTradePct,
    maxPositionPct,
    entryPrice,
    stopPrice,
    traderPositionSizePct = 1,
    minSharePrice = 5,
    minDollarRisk = 1,
    minDollarRiskPerTrade = null,
    maxDollarRiskPerTrade = null,
    minTradeNotional = null,
    maxTradeNotional = null,
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

  // Apply Trader's positionSizePct scaling
  dollarRisk *= traderPositionSizePct

  // Risk-parity qty (whole shares)
  let qty = Math.floor(dollarRisk / perShareRisk)
  if (qty < 1) {
    return { ok: false, reason: `Sized to 0 shares (dollarRisk=${dollarRisk.toFixed(2)}, perShareRisk=${perShareRisk.toFixed(2)})` }
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
    rationale: capped
      ? `${qty} shares (capped by ${cappedReason ?? 'cap'}, $${dollarRisk.toFixed(2)} risk)`
      : `${qty} shares ($${dollarRisk.toFixed(2)} risk at ${(stopWidthPct * 100).toFixed(2)}% stop)`,
  }
}
