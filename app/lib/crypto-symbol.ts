// =============================================================
// app/lib/crypto-symbol.ts
//
// Shared crypto-pair symbol recognition — ONE source of truth so the
// data layer (Council), the ticker-gate, and the trade router all agree
// on what counts as a crypto pair, instead of three divergent hardcoded
// coin lists that silently disagreed (a coin recognized by one but not
// the others would get analyzed-but-not-traded, or vice versa).
//
// A symbol is a crypto pair if, after stripping separators, it is
//   BASE + (USD | USDT | USDC)
// where BASE is 2-10 alphanumerics and is NOT a fiat currency (forex)
// or a spot metal. This recognizes the full Coinbase universe — any
// listed coin — without enumerating coins.
// =============================================================

// Bases that look like crypto (END in USD) but are NOT: fiat currencies
// (forex pairs) and spot metals. Everything else ending in USD/USDT/USDC
// is treated as crypto.
const NON_CRYPTO_BASES = new Set<string>([
  // spot metals
  'XAU', 'XAG', 'XPT', 'XPD',
  // fiat — BASE+USD here is a forex pair
  'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'MXN', 'ZAR', 'TRY',
  'BRL', 'INR', 'CNH', 'CNY', 'KRW', 'SGD', 'HKD', 'PLN', 'SEK', 'NOK',
  'DKK',
  // quote currencies themselves
  'USD', 'USDT', 'USDC',
])

/**
 * Return the base coin (e.g. "BTC" from "BTCUSD" / "BTC-USD" / "BTC/USD")
 * if `ticker` is a crypto pair, else null.
 */
export function cryptoBaseOf(ticker: string): string | null {
  const t = (ticker ?? '').toUpperCase().replace(/[-/]/g, '')
  const m = t.match(/^([A-Z0-9]{2,10})(USDT|USDC|USD)$/)
  if (!m) return null
  if (NON_CRYPTO_BASES.has(m[1])) return null
  return m[1]
}

/** True if `ticker` is a crypto pair (any Coinbase-listed coin). */
export function isCryptoPairSymbol(ticker: string): boolean {
  return cryptoBaseOf(ticker) !== null
}

/**
 * Canonical Coinbase spot product id for the candle/market endpoints,
 * e.g. "BTCUSD" / "BTC/USD" → "BTC-USD". Quote normalized to USD; callers
 * that need the USDC product can swap the suffix.
 */
export function toCoinbaseProduct(ticker: string): string {
  const base =
    cryptoBaseOf(ticker) ??
    (ticker ?? '').toUpperCase().replace(/[-/]/g, '').replace(/(USDT|USDC|USD)$/, '')
  return `${base}-USD`
}
