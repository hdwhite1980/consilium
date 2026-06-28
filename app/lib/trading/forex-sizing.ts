import { isSmallAccount, computeSmallAccountNotional } from './small-account-sizing'
// =============================================================
// app/lib/trading/forex-sizing.ts
//
// Forex sizing for OANDA. Different from stocks because:
//
//   - Sizes are in UNITS of the base currency, not shares
//   - 1 unit of EURUSD = 1 EUR
//   - Pip value depends on quote currency and account currency
//   - Mini lot = 10k units, micro lot = 1k units
//
// Pip value calculation:
//   For pair X/Y, holding U units:
//     pip_size = 10 ^ pipLocation   (0.0001 for non-JPY, 0.01 for JPY)
//     pip_value_quote_per_unit = pip_size
//     pip_value_in_quote = U * pip_size
//
// If account currency = quote currency (e.g. EURUSD with USD account),
// pip value in account = U * 0.0001
//
// If account currency != quote currency, we'd need a conversion rate.
// For v1 we ASSUME account currency is USD and only trade pairs where
// USD is either base or quote (which covers all major pairs and most
// crosses we care about). For pairs like EURGBP where USD is neither
// base nor quote AND account is USD, we approximate using EURUSD rate.
//
// Formula:
//   dollar_risk    = account_equity * risk_per_trade_pct
//   stop_pips      = abs(entry - stop) / pip_size
//   pip_value_usd  = (per below, depending on pair structure)
//   units          = dollar_risk / (stop_pips * pip_value_usd_per_unit)
// =============================================================

export interface ForexSizingInput {
  accountEquity: number             // in account currency (assumed USD)
  accountCurrency: string           // typically 'USD'
  riskPerTradePct: number
  maxPositionPct: number            // max notional as % of equity
  entryPrice: number
  stopPrice: number
  instrument: string                // canonical "USD_CAD" form
  pipLocation: number               // typically -4 (or -2 for JPY pairs)
  minimumTradeSize: number          // OANDA's reported minimum
  traderPositionSizePct?: number    // 0-1

  // Quality + small-account inputs (June 28, 2026) — parity with stock/crypto.
  qualityGrade?: 'A' | 'B' | 'C' | null
  qualityConfidence?: number | null
  qualityRiskReward?: number | null
  smallAccountMode?: boolean
  smallAccountThreshold?: number
}

export type ForexSizingOutcome =
  | { ok: true; units: number; signedUnits: number; dollarRisk: number; stopPips: number; rationale: string }
  | { ok: false; reason: string }

/**
 * Detect base and quote from canonical instrument name.
 * "USD_CAD" → { base: 'USD', quote: 'CAD' }
 */
function parsePair(instrument: string): { base: string; quote: string } | null {
  const parts = instrument.split('_')
  if (parts.length !== 2 || parts[0].length !== 3 || parts[1].length !== 3) return null
  return { base: parts[0].toUpperCase(), quote: parts[1].toUpperCase() }
}

/**
 * Pip value PER UNIT in the account currency (assumed USD).
 *
 * Cases:
 *  1. Quote = USD (e.g. EURUSD, GBPUSD)
 *     → pip value per unit in USD = pip_size
 *       (1 unit EURUSD with 0.0001 pip = $0.0001 per pip)
 *
 *  2. Base = USD (e.g. USDCAD, USDJPY)
 *     → pip value per unit in USD = pip_size / current_price
 *       (1 unit USDCAD at 1.40, 0.0001 pip → 0.0001 CAD ≈ 0.0001/1.40 USD)
 *
 *  3. Neither base nor quote = USD (cross pair, e.g. EURGBP)
 *     → pip value per unit in USD = pip_size * USD/QUOTE rate
 *       Caller must supply this; we return null and caller decides.
 *
 * Returns null if case 3 with no conversion rate available.
 */
function pipValuePerUnitUsd(
  instrument: string,
  pipSize: number,
  currentPrice: number,
): number | null {
  const p = parsePair(instrument)
  if (!p) return null
  if (p.quote === 'USD') {
    // Case 1: pip value per unit = pip_size USD
    return pipSize
  }
  if (p.base === 'USD') {
    // Case 2: pip value per unit = pip_size / current_price USD
    if (currentPrice <= 0) return null
    return pipSize / currentPrice
  }
  // Case 3 cross pair — approximate by treating pip value as pip_size
  // (this slightly overstates risk for pairs where USD is exotic,
  // but is the conservative direction so won't undersize).
  // A proper implementation would lookup USD/QUOTE rate from OANDA.
  return pipSize
}

export function computeForexSize(input: ForexSizingInput): ForexSizingOutcome {
  const {
    accountEquity, riskPerTradePct, maxPositionPct,
    entryPrice, stopPrice, instrument, pipLocation,
    minimumTradeSize, traderPositionSizePct = 1,
    qualityGrade = null, qualityConfidence = null, qualityRiskReward = null,
    smallAccountMode = false, smallAccountThreshold = undefined,
  } = input

  if (!Number.isFinite(accountEquity) || accountEquity <= 0) return { ok: false, reason: `Invalid accountEquity: ${accountEquity}` }
  if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 0.05) return { ok: false, reason: `Invalid riskPerTradePct: ${riskPerTradePct}` }
  if (!Number.isFinite(maxPositionPct) || maxPositionPct <= 0 || maxPositionPct > 0.50) return { ok: false, reason: `Invalid maxPositionPct: ${maxPositionPct}` }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: false, reason: `Invalid entryPrice: ${entryPrice}` }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return { ok: false, reason: `Invalid stopPrice: ${stopPrice}` }
  if (!Number.isFinite(traderPositionSizePct) || traderPositionSizePct <= 0 || traderPositionSizePct > 1) return { ok: false, reason: `Invalid traderPositionSizePct: ${traderPositionSizePct}` }

  const pair = parsePair(instrument)
  if (!pair) return { ok: false, reason: `Cannot parse pair: ${instrument}` }

  const pipSize = Math.pow(10, pipLocation)
  const stopDistance = Math.abs(entryPrice - stopPrice)
  if (stopDistance <= 0) return { ok: false, reason: 'Stop equals entry — distance is zero' }

  const stopPips = stopDistance / pipSize
  if (stopPips < 1) return { ok: false, reason: `Stop too tight: ${stopPips.toFixed(2)} pips` }
  if (stopPips > 500) return { ok: false, reason: `Stop too wide: ${stopPips.toFixed(0)} pips` }

  const pipValueUsd = pipValuePerUnitUsd(instrument, pipSize, entryPrice)
  if (pipValueUsd === null || pipValueUsd <= 0) {
    return { ok: false, reason: `Cannot compute pip value for ${instrument}` }
  }

  // ── Small-account mode: conviction-scaled allocation ──
  if (isSmallAccount(smallAccountMode, accountEquity, smallAccountThreshold)) {
    const sa = computeSmallAccountNotional({
      accountEquity, entryPrice, stopPrice, minViableNotional: 1,
      qualityGrade, qualityConfidence, qualityRiskReward,
    })
    if (!sa.ok) return { ok: false, reason: sa.reason ?? 'small-account sizing failed' }
    // USD notional → units: quote=USD → /price; base=USD → 1:1; cross → /price.
    const usdPerUnit = pair.quote === 'USD' ? entryPrice : pair.base === 'USD' ? 1 : entryPrice
    let saUnits = sa.notionalUsd! / usdPerUnit
    if (minimumTradeSize > 0) saUnits = Math.floor(saUnits / minimumTradeSize) * minimumTradeSize
    if (saUnits < Math.max(minimumTradeSize, 1)) {
      return { ok: false, reason: `small-account units ${saUnits} below minimum ${minimumTradeSize}` }
    }
    return {
      ok: true,
      units: saUnits,
      signedUnits: saUnits,
      dollarRisk: saUnits * stopPips * pipValueUsd,
      stopPips,
      rationale: sa.rationale ?? 'small-account',
    }
  }

  let dollarRisk = accountEquity * riskPerTradePct * traderPositionSizePct
  let units = dollarRisk / (stopPips * pipValueUsd)

  // Round down to minimum trade size step
  if (minimumTradeSize > 0) {
    units = Math.floor(units / minimumTradeSize) * minimumTradeSize
  } else {
    units = Math.floor(units)
  }

  if (units < minimumTradeSize) {
    return { ok: false, reason: `Sized ${units} units below OANDA minimum ${minimumTradeSize}` }
  }

  // Cap by max notional
  // Notional in USD: for quote=USD, units * entry. For base=USD, just units.
  let notionalUsd: number
  if (pair.quote === 'USD') notionalUsd = units * entryPrice
  else if (pair.base === 'USD') notionalUsd = units
  else notionalUsd = units * entryPrice  // approximation for cross

  const maxNotional = accountEquity * maxPositionPct
  let capped = false
  if (notionalUsd > maxNotional) {
    if (pair.quote === 'USD') units = Math.floor(maxNotional / entryPrice / minimumTradeSize) * minimumTradeSize
    else if (pair.base === 'USD') units = Math.floor(maxNotional / minimumTradeSize) * minimumTradeSize
    else units = Math.floor(maxNotional / entryPrice / minimumTradeSize) * minimumTradeSize
    capped = true
    dollarRisk = units * stopPips * pipValueUsd
  }

  if (units < minimumTradeSize) {
    return { ok: false, reason: `Max position cap sizes below OANDA minimum at ${instrument} entry=${entryPrice}` }
  }

  return {
    ok: true,
    units,
    signedUnits: units,   // sign added by caller based on direction
    dollarRisk,
    stopPips,
    rationale: capped
      ? `${units.toLocaleString()} units (capped at ${(maxPositionPct * 100).toFixed(0)}% notional, $${dollarRisk.toFixed(2)} risk at ${stopPips.toFixed(1)} pips)`
      : `${units.toLocaleString()} units ($${dollarRisk.toFixed(2)} risk at ${stopPips.toFixed(1)} pips)`,
  }
}
