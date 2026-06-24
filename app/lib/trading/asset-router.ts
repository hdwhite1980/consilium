// =============================================================
// app/lib/trading/asset-router.ts
//
// Routes a verdict ticker to its asset class + appropriate broker.
//
// Stock      → Alpaca stocks   (BRK.B, AAPL, ZS, XLE, BRKB, etc)
// Crypto     → Alpaca crypto   (BTC/USD, ETHUSD, BTCUSD)
// Forex      → OANDA           (USDCAD, EURUSD, GBPJPY)
// Futures    → Tradovate       (ES, NQ, CL, GC, ZB, etc — gated)
//
// Returns 'unknown' if the ticker can't be classified — caller
// should skip the verdict rather than guess.
// =============================================================

import type { AssetClass } from './settings'
import { cryptoBaseOf } from '@/app/lib/crypto-symbol'

export interface AssetRoute {
  assetClass: AssetClass | 'unknown'
  broker: 'alpaca' | 'oanda' | 'tradovate' | null
  normalizedSymbol: string         // canonical form for the broker
}

// G10 + EM forex pairs we explicitly recognize
const FOREX_PAIRS = new Set([
  // G10 majors / crosses
  'EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDJPY', 'USDCAD', 'USDCHF',
  'EURGBP', 'EURJPY', 'EURAUD', 'EURCHF', 'EURCAD', 'EURNZD',
  'GBPJPY', 'GBPAUD', 'GBPCHF', 'GBPCAD', 'GBPNZD',
  'AUDJPY', 'AUDCHF', 'AUDCAD', 'AUDNZD',
  'CADJPY', 'CADCHF',
  'CHFJPY', 'NZDJPY', 'NZDCHF', 'NZDCAD',
  // EM majors
  'USDMXN', 'USDZAR', 'USDTRY', 'USDBRL', 'USDINR', 'USDCNH', 'USDKRW',
  'USDSGD', 'USDHKD', 'USDPLN', 'USDSEK', 'USDNOK', 'USDDKK',
])

// Crypto recognition lives in app/lib/crypto-symbol.ts (structural, full universe).

// CME futures contract roots
const FUTURES_ROOTS = new Set([
  // Equity index
  'ES', 'NQ', 'RTY', 'YM',
  'MES', 'MNQ', 'M2K', 'MYM',     // micros
  // Energy
  'CL', 'NG', 'HO', 'RB', 'BZ',
  'MCL', 'QM', 'QG',
  // Metals
  'GC', 'SI', 'HG', 'PL', 'PA',
  'MGC', 'SIL', 'MHG',
  // Grains
  'ZC', 'ZW', 'ZS', 'ZM', 'ZL', 'KE', 'XC', 'XW', 'XK',
  // Rates / bonds
  'ZB', 'ZN', 'ZF', 'ZT', 'UB', 'TN',
  // Currency futures (CME)
  '6E', '6B', '6J', '6A', '6C', '6S', '6N', '6M',
  // VIX
  'VX', 'VIX',
])

function normalize(symbol: string): string {
  return symbol.toUpperCase().trim().replace(/\s+/g, '')
}

/**
 * Detect crypto pair. Accepts BTC/USD, BTCUSD, BTC-USD for ANY listed coin
 * (structural recognition via the shared crypto-symbol module), not just a
 * hardcoded shortlist. Normalizes to Alpaca canonical "BASE/USD".
 */
function tryCrypto(symbol: string): AssetRoute | null {
  const base = cryptoBaseOf(symbol)
  if (!base) return null
  return {
    assetClass: 'crypto',
    broker: 'alpaca',
    normalizedSymbol: `${base}/USD`,
  }
}

/**
 * Detect forex. 6 uppercase letters, both halves are major currency codes.
 */
function tryForex(symbol: string): AssetRoute | null {
  const norm = symbol.replace(/[\/\-]/g, '')
  if (FOREX_PAIRS.has(norm)) {
    // OANDA canonical form is "USD_CAD"
    const base = norm.slice(0, 3)
    const quote = norm.slice(3, 6)
    return {
      assetClass: 'forex',
      broker: 'oanda',
      normalizedSymbol: `${base}_${quote}`,
    }
  }
  return null
}

/**
 * Detect futures contract.
 *   Root form: "ES", "NQ", "CL"           → front-month
 *   Specific contract: "ESH26", "CLM26"   → explicit month/year
 *   CME-prefix: "/ES", "/CL"              → front-month, leading slash
 */
function tryFutures(symbol: string): AssetRoute | null {
  // Strip leading slash if present
  const cleaned = symbol.startsWith('/') ? symbol.slice(1) : symbol
  // Specific contract: ROOT + MONTH_CODE + 1-2 digit year
  // Month codes: F=Jan, G=Feb, H=Mar, J=Apr, K=May, M=Jun, N=Jul, Q=Aug, U=Sep, V=Oct, X=Nov, Z=Dec
  const m = cleaned.match(/^([A-Z]{1,4})([FGHJKMNQUVXZ])(\d{1,2})$/)
  if (m) {
    const root = m[1]
    if (FUTURES_ROOTS.has(root)) {
      return {
        assetClass: 'futures',
        broker: 'tradovate',
        normalizedSymbol: cleaned,
      }
    }
  }
  // Bare root → resolve to front-month at execution time
  if (FUTURES_ROOTS.has(cleaned)) {
    return {
      assetClass: 'futures',
      broker: 'tradovate',
      normalizedSymbol: cleaned,
    }
  }
  return null
}

/**
 * Detect stock. 1-5 uppercase letters, optional .B/.A class suffix.
 * Conservative: only after crypto/forex/futures have been ruled out.
 */
function tryStock(symbol: string): AssetRoute | null {
  if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(symbol)) {
    return {
      assetClass: 'stock',
      broker: 'alpaca',
      normalizedSymbol: symbol,
    }
  }
  return null
}

/**
 * Route a verdict's ticker to its asset class and broker.
 *
 * IMPORTANT: order matters. Crypto/forex/futures patterns are checked
 * BEFORE stock pattern because some symbols overlap (e.g. "ES" matches
 * both stock regex and futures root).
 */
export function routeTicker(ticker: string): AssetRoute {
  const symbol = normalize(ticker)
  if (!symbol) return { assetClass: 'unknown', broker: null, normalizedSymbol: ticker }

  return tryCrypto(symbol)
      ?? tryForex(symbol)
      ?? tryFutures(symbol)
      ?? tryStock(symbol)
      ?? { assetClass: 'unknown', broker: null, normalizedSymbol: symbol }
}

/**
 * Convenience: returns just the asset class.
 */
export function detectAssetClass(ticker: string): AssetClass | 'unknown' {
  return routeTicker(ticker).assetClass
}
