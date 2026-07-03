// Shared price parser — single source of truth for turning Judge/Trader
// free-text price fields ("$1,698.50 — first target", "$0.0345", "184.20")
// into numbers. Replaces two divergent extractPrice() copies (pipeline.ts,
// trader.ts) whose regex \$(\d{1,6}(?:\.\d{1,2})?) had three real bugs:
//
//   1. COMMAS: "$1,698.50" parsed as $1 (matched up to the comma). Any
//      4+-digit price the LLM writes with a thousands separator silently
//      corrupted entry/stop/target math (ETH/BTC verdicts especially).
//   2. SUB-PENNY: max two decimals truncated "$0.0345" to $0.03 (~13% level
//      error) and floored sub-cent coins to $0.00, which downstream guards
//      (stopDistance <= 0) treated as "skip enforcement" — so exactly the
//      microcaps that most need realism-capping bypassed it.
//   3. $-REQUIRED: a bare "1698.50" parsed as null, causing silent
//      currentPrice fallbacks and skipped sanitization.
//
// Matching rules (deliberately conservative):
//   • Prefer a $-prefixed number anywhere in the string (commas allowed,
//     any number of decimals).
//   • Only if NO $-number exists, accept a bare number when the string is
//     essentially just that number (optionally with trailing units/words is
//     NOT allowed — must be numeric-only after trim). This avoids grabbing
//     "2.5" out of "2.5:1 R:R near resistance", which is why the old code
//     required the $ in the first place.
export function parsePrice(s: string | null | undefined): number | null {
  if (!s || typeof s !== 'string') return null

  // 1) $-prefixed number, commas + full decimals allowed
  const dollar = s.match(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/)
  if (dollar) {
    const n = parseFloat(dollar[1].replace(/,/g, ''))
    return Number.isFinite(n) && n > 0 ? n : null
  }

  // 2) Bare numeric-only string (e.g. "1698.50", "1.0850" forex quotes)
  const bare = s.trim().match(/^(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)$/)
  if (bare) {
    const n = parseFloat(bare[1].replace(/,/g, ''))
    return Number.isFinite(n) && n > 0 ? n : null
  }

  return null
}
