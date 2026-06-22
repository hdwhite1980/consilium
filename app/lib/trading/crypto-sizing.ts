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
}

export type CryptoSizingOutcome =
  | { ok: true; units: number; notionalUsd: number; dollarRisk: number; rationale: string }
  | { ok: false; reason: string }

export function computeCryptoSize(input: CryptoSizingInput): CryptoSizingOutcome {
  const {
    accountEquity, riskPerTradePct, maxPositionPct,
    entryPrice, stopPrice,
    traderPositionSizePct = 1, minNotional = 10,
    minDollarRiskPerTrade = null,
    maxDollarRiskPerTrade = null,
    minTradeNotional = null,
    maxTradeNotional = null,
  } = input

  if (!Number.isFinite(accountEquity) || accountEquity <= 0) return { ok: false, reason: `Invalid accountEquity: ${accountEquity}` }
  if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 0.05) return { ok: false, reason: `Invalid riskPerTradePct: ${riskPerTradePct}` }
  if (!Number.isFinite(maxPositionPct) || maxPositionPct <= 0 || maxPositionPct > 0.50) return { ok: false, reason: `Invalid maxPositionPct: ${maxPositionPct}` }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: false, reason: `Invalid entryPrice: ${entryPrice}` }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return { ok: false, reason: `Invalid stopPrice: ${stopPrice}` }
  if (!Number.isFinite(traderPositionSizePct) || traderPositionSizePct <= 0 || traderPositionSizePct > 1) return { ok: false, reason: `Invalid traderPositionSizePct: ${traderPositionSizePct}` }

  const perUnitRisk = Math.abs(entryPrice - stopPrice)
  if (perUnitRisk <= 0) return { ok: false, reason: 'Stop equals entry — per-unit risk is zero' }

  const stopWidthPct = perUnitRisk / entryPrice
  if (stopWidthPct < 0.001) return { ok: false, reason: `Stop too tight: ${(stopWidthPct * 100).toFixed(3)}%` }
  if (stopWidthPct > 0.30) return { ok: false, reason: `Stop too wide: ${(stopWidthPct * 100).toFixed(1)}%` }

  let dollarRisk = accountEquity * riskPerTradePct * traderPositionSizePct
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
    rationale: capped
      ? `${units.toFixed(6)} units (capped by ${cappedReason ?? 'cap'}, $${dollarRisk.toFixed(2)} risk)`
      : `${units.toFixed(6)} units ($${dollarRisk.toFixed(2)} risk at ${(stopWidthPct * 100).toFixed(2)}% stop)`,
  }
}
