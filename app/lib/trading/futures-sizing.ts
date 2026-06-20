// =============================================================
// app/lib/trading/futures-sizing.ts
//
// Futures sizing: contract count based on tick value.
//
// Each futures contract has a tick value (dollar P&L per minimum
// price movement). Examples:
//   ES (E-mini S&P 500):  $50 per 1.00 index point = $12.50 per 0.25 tick
//   NQ (E-mini Nasdaq):   $20 per 1.00 = $5.00 per 0.25 tick
//   RTY (E-mini Russell): $50 per 1.00 = $5.00 per 0.10 tick
//   YM (E-mini Dow):      $5 per 1.00 = $5.00 per 1.00 tick
//   MES (Micro E-mini SP): $5 per 1.00 = $1.25 per 0.25 tick   (1/10 of ES)
//   MNQ:                  $2 per 1.00 = $0.50 per 0.25 tick   (1/10 of NQ)
//   VX (VIX futures):     $1000 per 1.00 index point
//
// Formula:
//   stopDistanceInTicks = abs(entry - stop) / tick_size
//   riskPerContract     = stopDistanceInTicks * tick_value
//   contracts           = floor(dollarRisk / riskPerContract)
//   minContracts        = 1
//
// We cap by:
//   - Initial margin requirement (each broker provides; we use an
//     approximation: ES ~ $14k init, MES ~ $1.4k init, etc.)
//   - maxPositionPct of equity for the notional value
// =============================================================

export interface FuturesContractSpec {
  root: string
  tickSize: number          // smallest price movement
  tickValueUsd: number      // dollar P&L per tick
  pointMultiplier: number   // dollar P&L per 1.00 index point (= tickValueUsd / tickSize)
  initialMarginEst: number  // rough initial margin per contract
  category: 'equity_index' | 'volatility' | 'energy' | 'metals' | 'grains' | 'rates' | 'fx' | 'other'
  micro: boolean
}

// Specifications for futures we currently support (equity index + VIX only for v1)
// Other futures families (energy/grains/metals/rates) will be added when Council
// data sources for them are wired (Phase 5+).
export const FUTURES_SPECS: Record<string, FuturesContractSpec> = {
  ES:   { root: 'ES',  tickSize: 0.25, tickValueUsd: 12.50, pointMultiplier: 50,   initialMarginEst: 14000, category: 'equity_index', micro: false },
  MES:  { root: 'MES', tickSize: 0.25, tickValueUsd: 1.25,  pointMultiplier: 5,    initialMarginEst: 1400,  category: 'equity_index', micro: true },
  NQ:   { root: 'NQ',  tickSize: 0.25, tickValueUsd: 5.00,  pointMultiplier: 20,   initialMarginEst: 17000, category: 'equity_index', micro: false },
  MNQ:  { root: 'MNQ', tickSize: 0.25, tickValueUsd: 0.50,  pointMultiplier: 2,    initialMarginEst: 1700,  category: 'equity_index', micro: true },
  RTY:  { root: 'RTY', tickSize: 0.10, tickValueUsd: 5.00,  pointMultiplier: 50,   initialMarginEst: 7500,  category: 'equity_index', micro: false },
  M2K:  { root: 'M2K', tickSize: 0.10, tickValueUsd: 0.50,  pointMultiplier: 5,    initialMarginEst: 750,   category: 'equity_index', micro: true },
  YM:   { root: 'YM',  tickSize: 1.00, tickValueUsd: 5.00,  pointMultiplier: 5,    initialMarginEst: 9500,  category: 'equity_index', micro: false },
  MYM:  { root: 'MYM', tickSize: 1.00, tickValueUsd: 0.50,  pointMultiplier: 0.5,  initialMarginEst: 950,   category: 'equity_index', micro: true },
  VX:   { root: 'VX',  tickSize: 0.05, tickValueUsd: 50.00, pointMultiplier: 1000, initialMarginEst: 9000,  category: 'volatility',   micro: false },
}

export function getFuturesSpec(rootOrSymbol: string): FuturesContractSpec | null {
  // Strip month/year suffix if present (e.g. "ESH26" → "ES", "MNQM6" → "MNQ")
  const cleaned = rootOrSymbol.replace(/[FGHJKMNQUVXZ][0-9]{1,2}$/, '')
  return FUTURES_SPECS[cleaned] ?? null
}

export interface FuturesSizingInput {
  accountEquity: number
  riskPerTradePct: number
  maxPositionPct: number             // cap on initial margin total
  entryPrice: number
  stopPrice: number
  rootSymbol: string                 // "ES", "MES", "NQ", etc.
  traderPositionSizePct?: number
}

export type FuturesSizingOutcome =
  | {
      ok: true
      contracts: number
      stopTicks: number
      riskPerContract: number
      totalDollarRisk: number
      estimatedMarginUsd: number
      spec: FuturesContractSpec
      rationale: string
    }
  | { ok: false; reason: string }

export function computeFuturesSize(input: FuturesSizingInput): FuturesSizingOutcome {
  const {
    accountEquity, riskPerTradePct, maxPositionPct,
    entryPrice, stopPrice, rootSymbol,
    traderPositionSizePct = 1,
  } = input

  if (!Number.isFinite(accountEquity) || accountEquity <= 0) return { ok: false, reason: `Invalid accountEquity: ${accountEquity}` }
  if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 0.05) return { ok: false, reason: `Invalid riskPerTradePct: ${riskPerTradePct}` }
  if (!Number.isFinite(maxPositionPct) || maxPositionPct <= 0 || maxPositionPct > 0.50) return { ok: false, reason: `Invalid maxPositionPct: ${maxPositionPct}` }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: false, reason: `Invalid entryPrice: ${entryPrice}` }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return { ok: false, reason: `Invalid stopPrice: ${stopPrice}` }
  if (!Number.isFinite(traderPositionSizePct) || traderPositionSizePct <= 0 || traderPositionSizePct > 1) return { ok: false, reason: `Invalid traderPositionSizePct: ${traderPositionSizePct}` }

  const spec = getFuturesSpec(rootSymbol)
  if (!spec) return { ok: false, reason: `Unknown futures root: ${rootSymbol}` }

  const stopDistance = Math.abs(entryPrice - stopPrice)
  if (stopDistance <= 0) return { ok: false, reason: 'Stop equals entry — distance is zero' }

  const stopTicks = stopDistance / spec.tickSize
  if (stopTicks < 1) return { ok: false, reason: `Stop too tight: ${stopTicks.toFixed(2)} ticks` }
  // No upper-bound check — wide stops are legitimate for futures.

  const riskPerContract = stopTicks * spec.tickValueUsd
  const dollarRisk = accountEquity * riskPerTradePct * traderPositionSizePct
  let contracts = Math.floor(dollarRisk / riskPerContract)

  if (contracts < 1) {
    return {
      ok: false,
      reason: `Risk-per-trade $${dollarRisk.toFixed(2)} is below 1 contract of ${rootSymbol} ($${riskPerContract.toFixed(2)} per contract at ${stopTicks.toFixed(1)}-tick stop)`,
    }
  }

  // Margin cap
  const maxMargin = accountEquity * maxPositionPct
  const marginAllowedContracts = Math.floor(maxMargin / spec.initialMarginEst)
  let capped = false
  if (contracts > marginAllowedContracts) {
    if (marginAllowedContracts < 1) {
      return { ok: false, reason: `Initial margin $${spec.initialMarginEst} for 1 ${rootSymbol} exceeds maxPositionPct ${(maxPositionPct * 100).toFixed(0)}% of $${accountEquity.toFixed(0)} equity` }
    }
    contracts = marginAllowedContracts
    capped = true
  }

  const totalDollarRisk = contracts * riskPerContract
  const estimatedMarginUsd = contracts * spec.initialMarginEst

  return {
    ok: true,
    contracts,
    stopTicks,
    riskPerContract,
    totalDollarRisk,
    estimatedMarginUsd,
    spec,
    rationale: capped
      ? `${contracts}× ${rootSymbol} (capped by margin: $${estimatedMarginUsd.toFixed(0)} of $${maxMargin.toFixed(0)} allowed, $${totalDollarRisk.toFixed(2)} risk)`
      : `${contracts}× ${rootSymbol} ($${totalDollarRisk.toFixed(2)} risk at ${stopTicks.toFixed(1)} ticks, margin ~$${estimatedMarginUsd.toFixed(0)})`,
  }
}

/**
 * Roots eligible for Council futures analysis (Layer 5 will gate on this).
 * Anything not in here, the ticker gate will refuse.
 */
export function isFuturesRootSupported(root: string): boolean {
  const cleaned = root.replace(/[FGHJKMNQUVXZ][0-9]{1,2}$/, '')
  return cleaned in FUTURES_SPECS
}
