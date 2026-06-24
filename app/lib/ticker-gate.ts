// =============================================================
// app/lib/ticker-gate.ts (Layer 5)
//
// CHANGE FROM BUG 29 BEHAVIOR:
//   - Previously, all CME futures roots (ES, NQ, CL, GC, etc.)
//     were REFUSED with a suggested ETF equivalent.
//   - Layer 5: futures roots now RECOGNIZED and routed to the
//     futures bundle / futures pipeline path. The gate exposes
//     a new `assetClass` field on GateOk so callers can dispatch.
//
// Spot metals (XAUUSD/XAGUSD) still route to spot-metals.
// Crypto pairs (BTCUSD/ETHUSD) still route to crypto path.
// Forex pairs (USDCAD etc.) still route to forex path.
// Equities (default): existing path unchanged.
// =============================================================

import type { SignalBundle } from './aggregator'
import { isFuturesRootSupported } from './trading/futures-sizing'

export type GateAssetClass = 'equity' | 'futures' | 'forex' | 'crypto' | 'spot_metal'

interface CommodityRedirect {
  suggested: string
  description: string
  rationale: string
}

// Most CME contract redirects are now REMOVED from this map —
// futures roots route through to the futures pipeline.
// We keep redirects ONLY for things we still want to suggest the
// ETF equivalent of (e.g. spot metals, when a user types XAU but
// we don't have spot-metals wired for that asset).
const COMMODITY_REDIRECTS: Record<string, CommodityRedirect> = {
  // Kept empty — futures roots are now first-class. Add entries
  // here only when we need to refuse a class of input.
}

const AMBIGUOUS_SYMBOLS = new Set(['ZS', 'BTC', 'ETH', 'CL', 'NG'])

// Forex pairs — same set as asset-router.ts
const FOREX_PAIRS = new Set([
  'EURUSD','GBPUSD','AUDUSD','NZDUSD','USDJPY','USDCAD','USDCHF',
  'EURGBP','EURJPY','EURAUD','EURCHF','EURCAD','EURNZD',
  'GBPJPY','GBPAUD','GBPCHF','GBPCAD','GBPNZD',
  'AUDJPY','AUDCHF','AUDCAD','AUDNZD','CADJPY','CADCHF',
  'CHFJPY','NZDJPY','NZDCHF','NZDCAD',
  'USDMXN','USDZAR','USDTRY','USDBRL','USDINR','USDCNH','USDKRW',
  'USDSGD','USDHKD','USDPLN','USDSEK','USDNOK','USDDKK',
])

const CRYPTO_BASES = new Set([
  'BTC','ETH','LTC','BCH','XRP','DOGE','ADA','SOL','MATIC',
  'DOT','LINK','AVAX','UNI','AAVE','SHIB','TRX','XLM','NEAR',
])

const SPOT_METALS = new Set(['XAUUSD','XAGUSD','XPTUSD','XPDUSD'])

export interface GateBlock {
  ok: false
  title: string
  detail: string
  suggested?: string
  suggestedRationale?: string
  stage: 'pre_bundle' | 'post_bundle'
}

export interface GateOk {
  ok: true
  assetClass: GateAssetClass
  // For futures, the root the gate recognized (e.g. "ES" from input "ESH26")
  futuresRoot?: string
}

export type GateResult = GateBlock | GateOk

export function evaluateTickerGate(rawTicker: string): GateResult {
  const ticker = (rawTicker ?? '').trim().toUpperCase()

  if (!ticker) {
    return {
      ok: false, stage: 'pre_bundle',
      title: 'No ticker provided',
      detail: 'Please enter a ticker symbol to analyze.',
    }
  }

  // Allow digits-prefix for CME FX futures (6E, 6B, etc.) and pair separators
  // (- or /) for crypto/forex pairs like BTC-USD, BTC/USD.
  if (!/^[A-Z0-9./-]{1,12}$/.test(ticker)) {
    return {
      ok: false, stage: 'pre_bundle',
      title: `"${rawTicker}" doesn't look like a valid ticker`,
      detail: 'Tickers should be 1-12 letters/digits. Examples: MSFT, AAPL, EURUSD, ES, BTCUSD.',
    }
  }

  // Check explicit redirects (currently empty post-Layer-5)
  const redirect = COMMODITY_REDIRECTS[ticker]
  if (redirect && !AMBIGUOUS_SYMBOLS.has(ticker)) {
    return {
      ok: false, stage: 'pre_bundle',
      title: `${redirect.description} isn't currently supported`,
      detail: `Try ${redirect.suggested} — ${redirect.rationale}.`,
      suggested: redirect.suggested,
      suggestedRationale: redirect.rationale,
    }
  }

  // ── Futures contract route ──────────────────────────────
  // Recognize CME contracts: bare root (ES, NQ, CL) or with
  // month/year suffix (ESH26, CLZ5). Layer 5: route to futures
  // pipeline rather than refusing.
  //
  // Order matters: futures check BEFORE forex (USDCAD also
  // matches loose patterns) and BEFORE stock fallthrough.
  const withoutSlash = ticker.startsWith('/') ? ticker.slice(1) : ticker
  // Specific contract form
  const monthMatch = withoutSlash.match(/^([A-Z0-9]{1,4})([FGHJKMNQUVXZ])(\d{1,2})$/)
  if (monthMatch && isFuturesRootSupported(monthMatch[1])) {
    return { ok: true, assetClass: 'futures', futuresRoot: monthMatch[1] }
  }
  // Bare root form
  if (isFuturesRootSupported(withoutSlash)) {
    // Disambiguate against equities for AMBIGUOUS_SYMBOLS. CL and NG
    // are commonly typed for equities too. Default to allowing the
    // futures interpretation; post-bundle check will catch wrong call.
    return { ok: true, assetClass: 'futures', futuresRoot: withoutSlash }
  }

  // Crypto — accept concatenated (BTCUSD), hyphen (BTC-USD), or slash (BTC/USD).
  const cryptoNorm = ticker.replace(/[-/]/g, '')
  for (const base of CRYPTO_BASES) {
    if (cryptoNorm === `${base}USD` || cryptoNorm === `${base}USDT` || cryptoNorm === `${base}USDC`) {
      return { ok: true, assetClass: 'crypto' }
    }
  }

  // Forex
  if (FOREX_PAIRS.has(ticker)) {
    return { ok: true, assetClass: 'forex' }
  }

  // Spot metals (existing path)
  if (SPOT_METALS.has(ticker)) {
    return { ok: true, assetClass: 'spot_metal' }
  }

  // Default: equity
  return { ok: true, assetClass: 'equity' }
}

// Post-bundle integrity check unchanged from Bug 29 behavior
export function evaluateBundleIntegrity(bundle: SignalBundle): GateResult {
  const ticker = bundle.ticker?.toUpperCase() ?? ''
  const price = Number(bundle.currentPrice) || 0
  const bars = Array.isArray(bundle.bars) ? bundle.bars : []
  if (price === 0 && bars.length === 0) {
    return {
      ok: false, stage: 'post_bundle',
      title: `No data available for ${ticker}`,
      detail: 'Our data providers returned empty results for this ticker. This usually means the symbol is delisted, a typo, or not covered by our free-tier providers.',
    }
  }
  return { ok: true, assetClass: 'equity' }
}
