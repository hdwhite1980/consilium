// =============================================================
// app/lib/trading/crypto-product-sizing.ts
//
// Coinbase-product-aware sizing wrapper around computeCryptoSize.
//
// Why a separate module:
//   Each Coinbase product has specific increment constraints that
//   our generic sizing math can't know about:
//     - base_increment: minimum step for the BASE quantity
//                       (e.g. 0.00000001 for BTC, 1 for PEPE)
//     - quote_increment: minimum step for the QUOTE price
//                       (e.g. 0.01 for BTC-USD, 0.0000000001 for PEPE-USD)
//     - base_min_size: minimum order quantity in base units
//     - quote_min_size: minimum order size in USD
//
// Pre-flight:
//   1. Run normal sizing → get a candidate {units, notionalUsd}
//   2. Fetch product info from Coinbase (cached)
//   3. Round units DOWN to nearest base_increment
//   4. Validate against base_min_size and quote_min_size
//   5. Reject if any check fails (with explicit reason)
//   6. Round stop price to nearest quote_increment
//
// All rounding is conservative — we always round AWAY from the limit
// (round units down so we never request more than user wants, round
// stop to nearest valid tick).
// =============================================================

import { computeCryptoSize, type CryptoSizingInput, type CryptoSizingOutcome } from './crypto-sizing'
import type { CoinbaseClient } from './coinbase-client'

export interface ProductAwareSizingInput extends CryptoSizingInput {
  symbol: string                    // e.g. "BTC-USD"
  coinbaseClient: CoinbaseClient
}

export interface ProductInfo {
  productId: string
  baseIncrement: number             // e.g. 0.00000001 for BTC
  quoteIncrement: number            // e.g. 0.01 for BTC-USD
  baseMinSize: number               // minimum quantity in base units
  quoteMinSize: number              // minimum order size in USD
  baseMaxSize: number | null        // max base qty (often null/very large)
  quoteMaxSize: number | null       // max USD size
  status: string                    // 'online', etc.
  tradingDisabled: boolean
  cancelOnly: boolean
  postOnly: boolean
  limitOnly: boolean
}

// 5-min cache for product info (rarely changes)
interface CachedProduct {
  info: ProductInfo
  fetchedAt: number
}
const productCache = new Map<string, CachedProduct>()
const PRODUCT_TTL_MS = 5 * 60 * 1000

/**
 * Fetch product info from Coinbase (cached).
 *
 * Returns null on fetch failure — caller should treat that as "skip this
 * trade" since we can't validate constraints without the product info.
 */
/**
 * Normalize a crypto symbol to a Coinbase product_id ("BASE-QUOTE", dash form).
 * Accepts "AAVEUSD", "AAVE/USD", "AAVE-USD", "BTCUSDC" → "AAVE-USD" / "BTC-USDC".
 * Already-dashed ids pass through untouched.
 */
export function toCoinbaseProductId(symbol: string): string {
  let s = (symbol ?? '').toUpperCase().trim().replace(/\s+/g, '')
  if (s.includes('-')) return s
  if (s.includes('/')) return s.replace('/', '-')
  for (const q of ['USDC', 'USDT', 'USD']) {
    if (s.endsWith(q) && s.length > q.length) return `${s.slice(0, -q.length)}-${q}`
  }
  return s
}

export async function getProductInfo(
  client: CoinbaseClient,
  symbol: string,
): Promise<ProductInfo | null> {
  // Coinbase product IDs are dash-delimited ("AAVE-USD"). Verdict tickers can
  // arrive dashless ("AAVEUSD") or slash form ("AAVE/USD"), which 404s the
  // /products/{id} lookup. Normalize before fetching and cache by the canonical id.
  const productId = toCoinbaseProductId(symbol)
  const cached = productCache.get(productId)
  if (cached && (Date.now() - cached.fetchedAt) < PRODUCT_TTL_MS) {
    return cached.info
  }

  try {
    const raw = await client.getProduct(productId)
    const info: ProductInfo = {
      productId: String(raw.product_id ?? productId),
      baseIncrement: parseNumber(raw.base_increment) ?? 0.00000001,
      quoteIncrement: parseNumber(raw.quote_increment) ?? 0.01,
      baseMinSize: parseNumber(raw.base_min_size) ?? 0,
      quoteMinSize: parseNumber(raw.quote_min_size) ?? 1,
      baseMaxSize: parseNumber(raw.base_max_size),
      quoteMaxSize: parseNumber(raw.quote_max_size),
      status: String(raw.status ?? 'unknown'),
      tradingDisabled: raw.trading_disabled === true,
      cancelOnly: raw.cancel_only === true,
      postOnly: raw.post_only === true,
      limitOnly: raw.limit_only === true,
    }
    productCache.set(productId, { info, fetchedAt: Date.now() })
    return info
  } catch (e) {
    console.warn(`[crypto-product-sizing] getProduct(${productId}) failed:`, e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Size a crypto trade with Coinbase product-aware validation.
 *
 * Wraps computeCryptoSize and then validates/adjusts against actual
 * Coinbase product constraints. Returns the same outcome shape with
 * additional product info attached when successful.
 */
export async function sizeCryptoTradeForCoinbase(
  input: ProductAwareSizingInput,
): Promise<CryptoSizingOutcome & { productInfo?: ProductInfo; adjustedStop?: number }> {
  // Step 1: Fetch product info FIRST so we can fail fast if symbol is bad
  const product = await getProductInfo(input.coinbaseClient, input.symbol)
  if (!product) {
    return { ok: false, reason: `Could not fetch Coinbase product info for ${input.symbol}` }
  }

  // Step 2: Tradability gates
  if (product.tradingDisabled) {
    return { ok: false, reason: `${input.symbol} trading disabled at Coinbase` }
  }
  if (product.cancelOnly) {
    return { ok: false, reason: `${input.symbol} is cancel-only at Coinbase` }
  }
  if (product.status.toLowerCase() !== 'online') {
    return { ok: false, reason: `${input.symbol} status is ${product.status} (not online)` }
  }

  // Step 3: Run normal sizing
  const baseOutcome = computeCryptoSize({
    accountEquity: input.accountEquity,
    riskPerTradePct: input.riskPerTradePct,
    maxPositionPct: input.maxPositionPct,
    entryPrice: input.entryPrice,
    stopPrice: input.stopPrice,
    traderPositionSizePct: input.traderPositionSizePct,
    // Use Coinbase's quote_min_size as a floor if user setting is lower
    minNotional: Math.max(input.minNotional ?? 0, product.quoteMinSize),
    minDollarRiskPerTrade: input.minDollarRiskPerTrade,
    maxDollarRiskPerTrade: input.maxDollarRiskPerTrade,
    minTradeNotional: input.minTradeNotional,
    maxTradeNotional: input.maxTradeNotional,
    qualityGrade: input.qualityGrade,
    qualityConfidence: input.qualityConfidence,
    qualityRiskReward: input.qualityRiskReward,
  })

  if (!baseOutcome.ok) {
    return baseOutcome
  }

  // Step 4: Round units DOWN to base_increment
  const baseInc = product.baseIncrement
  if (baseInc <= 0) {
    return { ok: false, reason: `Invalid base_increment ${baseInc} for ${input.symbol}` }
  }
  const adjustedUnits = Math.floor(baseOutcome.units / baseInc) * baseInc
  // Floating point: re-round to a sensible precision based on the increment magnitude
  const decimals = decimalsFromIncrement(baseInc)
  const finalUnits = Number(adjustedUnits.toFixed(decimals))

  // Step 5: Validate post-rounding
  if (finalUnits <= 0) {
    return {
      ok: false,
      reason: `Position sized to ${baseOutcome.units} units rounds to 0 at base_increment ${baseInc} (notional too small for ${input.symbol})`,
    }
  }
  if (finalUnits < product.baseMinSize) {
    return {
      ok: false,
      reason: `Units ${finalUnits} below Coinbase base_min_size ${product.baseMinSize} for ${input.symbol}`,
    }
  }

  const finalNotional = finalUnits * input.entryPrice
  if (finalNotional < product.quoteMinSize) {
    return {
      ok: false,
      reason: `Notional $${finalNotional.toFixed(2)} below Coinbase quote_min_size $${product.quoteMinSize} for ${input.symbol}`,
    }
  }
  if (product.quoteMaxSize !== null && finalNotional > product.quoteMaxSize) {
    return {
      ok: false,
      reason: `Notional $${finalNotional.toFixed(2)} exceeds Coinbase quote_max_size $${product.quoteMaxSize} for ${input.symbol}`,
    }
  }

  // Step 6: Round stop price to quote_increment
  const quoteInc = product.quoteIncrement
  let adjustedStop: number | undefined
  if (quoteInc > 0 && Number.isFinite(input.stopPrice)) {
    const stopRounded = Math.round(input.stopPrice / quoteInc) * quoteInc
    const stopDecimals = decimalsFromIncrement(quoteInc)
    adjustedStop = Number(stopRounded.toFixed(stopDecimals))
  }

  // Compute dollar risk against adjusted stop if changed
  const adjustedDollarRisk = adjustedStop !== undefined
    ? finalUnits * Math.abs(input.entryPrice - adjustedStop)
    : baseOutcome.dollarRisk

  return {
    ok: true,
    units: finalUnits,
    notionalUsd: finalNotional,
    dollarRisk: adjustedDollarRisk,
    qualityMultiplier: baseOutcome.qualityMultiplier,
    rationale: `${baseOutcome.rationale} | adjusted to Coinbase: units=${finalUnits} (base_inc=${baseInc}), notional=$${finalNotional.toFixed(2)}${adjustedStop !== undefined && adjustedStop !== input.stopPrice ? `, stop=$${adjustedStop.toFixed(stopDecimalsForLog(quoteInc))}` : ''}`,
    productInfo: product,
    adjustedStop: adjustedStop !== input.stopPrice ? adjustedStop : undefined,
  }
}

/**
 * Parse a Coinbase numeric field. Coinbase returns numbers as strings.
 */
function parseNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Calculate appropriate decimal places from an increment value.
 *
 * 0.01    → 2 decimals
 * 0.00001 → 5 decimals
 * 1       → 0 decimals
 * 100     → 0 decimals (but value is multiple of 100)
 */
function decimalsFromIncrement(inc: number): number {
  if (inc >= 1) return 0
  // For sub-1 increments, count significant decimal places
  const str = inc.toString()
  if (str.includes('e')) {
    // Scientific notation like 1e-8
    const expMatch = str.match(/e-(\d+)/)
    if (expMatch) return parseInt(expMatch[1], 10)
  }
  const decimalPart = str.split('.')[1] ?? ''
  return decimalPart.length
}

function stopDecimalsForLog(inc: number): number {
  return Math.max(2, decimalsFromIncrement(inc))
}
