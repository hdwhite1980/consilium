// =============================================================
// app/lib/ticker-gate.ts
//
// Pre- and post-bundle gates that refuse to run the Council on
// unsupported tickers. Prevents the "garbage in, fictional out"
// failure mode observed with:
//
//   • Futures symbols (GC, SI, CL, ES, NQ, ZB, NG) — Tradier/
//     Alpaca/Finnhub free tiers don't include futures, so the
//     bundle came back with $0 price + zero technicals and the
//     pipeline ran anyway, producing fictional analyses
//     (e.g. Lead citing a fake "Vanguard 40M share GC position").
//   • Spot metals in forex notation (XAUUSD, XAGUSD) — ECB
//     doesn't track metals, so Frankfurter returns nothing and
//     same garbage-bundle failure.
//   • Unsupported forex pairs not in FOREX_PAIRS — fell through
//     to stock routing → same failure mode.
//   • Typos / delisted / illiquid penny stocks where data
//     providers silently return empty.
//
// Two-layer defense:
//   (1) Pre-bundle redirect — recognize common futures/metals
//       symbols and refuse with a suggested equity equivalent
//       BEFORE wasting compute on bundle building.
//   (2) Post-bundle integrity — for anything that passed (1),
//       if the bundle came back empty (price = 0 AND no bars),
//       refuse with a clear supported-tickers message.
//
// Why suggest rather than auto-redirect: silently analyzing GLD
// when the user typed XAUUSD breaks trust. Better UX is to tell
// them "XAUUSD isn't supported, try GLD" and let them choose.
// =============================================================

import type { SignalBundle } from './aggregator'

// ─────────────────────────────────────────────────────────────
// Commodity / futures / metals symbol redirects.
//
// When a user types one of these, we refuse with a suggested
// equity equivalent that actually works in our system.
//
// Categories:
//   • Spot metals in forex notation (XAU/XAG/XPT/XPD + USD)
//   • CME futures contract codes (1- or 2-letter root, with
//     or without =F / continuous-month suffix)
//   • Crypto futures codes (BTC/ETH)
//
// ETF mappings chosen to most closely track the underlying:
//   GLD: SPDR Gold Trust (tracks spot gold)
//   IAU: iShares Gold Trust (cheaper alt to GLD)
//   SLV: iShares Silver Trust
//   USO: United States Oil Fund (tracks WTI)
//   UNG: United States Natural Gas Fund
//   SPY/QQQ/IWM: equity index ETFs
//   TLT: 20+ year Treasury (proxy for /ZB bond futures)
//   IBIT: iShares Bitcoin ETF
// ─────────────────────────────────────────────────────────────

interface CommodityRedirect {
  /** ETF/stock ticker to use instead */
  suggested: string
  /** Brief human-readable description of what was typed */
  description: string
  /** Why the redirect ETF is a reasonable substitute */
  rationale: string
}

const COMMODITY_REDIRECTS: Record<string, CommodityRedirect> = {
  // Spot metals (forex-notation) — XAU/XAG/XPT/XPD removed in Jun 2026
  // when TwelveData spot-metals integration shipped. These are now
  // analyzed directly via data/spot-metals.ts. Re-add to this table
  // if the integration is ever rolled back.

  // CME metals futures — still redirected (futures contracts ≠ spot)
  GC:   { suggested: 'GLD', description: 'Gold futures (GC)',     rationale: 'GLD tracks gold prices without futures-contract complexity (rolls, contango). Also try XAUUSD for spot gold directly.' },
  SI:   { suggested: 'SLV', description: 'Silver futures (SI)',   rationale: 'SLV tracks silver prices without futures-contract complexity. Also try XAGUSD for spot silver directly.' },
  HG:   { suggested: 'CPER', description: 'Copper futures (HG)',  rationale: 'United States Copper Index Fund tracks copper futures' },

  // CME energy futures
  CL:   { suggested: 'USO', description: 'WTI crude oil futures (CL)', rationale: 'USO tracks WTI crude prices' },
  NG:   { suggested: 'UNG', description: 'Natural gas futures (NG)',   rationale: 'UNG tracks natural gas prices' },
  RB:   { suggested: 'UGA', description: 'Gasoline futures (RB)',      rationale: 'UGA tracks gasoline prices' },

  // CME equity index futures
  ES:   { suggested: 'SPY', description: 'S&P 500 E-mini futures (ES)',    rationale: 'SPY tracks the S&P 500 index' },
  NQ:   { suggested: 'QQQ', description: 'Nasdaq-100 E-mini futures (NQ)', rationale: 'QQQ tracks the Nasdaq-100 index' },
  RTY:  { suggested: 'IWM', description: 'Russell 2000 E-mini futures (RTY)', rationale: 'IWM tracks the Russell 2000 index' },
  YM:   { suggested: 'DIA', description: 'Dow Jones E-mini futures (YM)',  rationale: 'DIA tracks the Dow Jones Industrial Average' },

  // CBOT bond / rate futures
  ZB:   { suggested: 'TLT', description: '30-year T-Bond futures (ZB)', rationale: 'TLT (20+ year Treasury ETF) is the standard proxy' },
  ZN:   { suggested: 'IEF', description: '10-year T-Note futures (ZN)', rationale: 'IEF (7-10 year Treasury ETF) is the standard proxy' },
  ZF:   { suggested: 'IEI', description: '5-year T-Note futures (ZF)',  rationale: 'IEI (3-7 year Treasury ETF) is the closest proxy' },

  // Crypto futures (CME)
  BTC:  { suggested: 'IBIT', description: 'Bitcoin futures (BTC)',  rationale: 'iShares Bitcoin Trust ETF tracks BTC spot price' },
  ETH:  { suggested: 'ETHA', description: 'Ethereum futures (ETH)', rationale: 'iShares Ethereum Trust ETF tracks ETH spot price' },

  // Other common commodity tickers
  ZC:   { suggested: 'CORN', description: 'Corn futures (ZC)',     rationale: 'Teucrium Corn Fund tracks corn futures' },
  ZW:   { suggested: 'WEAT', description: 'Wheat futures (ZW)',    rationale: 'Teucrium Wheat Fund tracks wheat futures' },
  ZS:   { suggested: 'SOYB', description: 'Soybean futures (ZS)',  rationale: 'Teucrium Soybean Fund tracks soybean futures' },
  // Note: ZS conflicts with Zscaler (NASDAQ:ZS). Conflict handled below —
  // we only treat it as a futures redirect if the equity bundle comes back
  // empty. See evaluateBundleIntegrity().
}

// Subset of redirect keys that ALSO have a real equity ticker with the
// same symbol. These should NOT be redirected pre-bundle — instead, we
// let the bundle build and only redirect if it comes back empty.
// (e.g. ZS = Zscaler the cybersecurity stock OR ZS = soybean futures)
const AMBIGUOUS_SYMBOLS = new Set(['ZS', 'BTC', 'ETH', 'CL', 'NG'])

// ─────────────────────────────────────────────────────────────

export interface GateBlock {
  /** Always false here — block the analysis */
  ok: false
  /** Headline shown to the user (1 line, no period) */
  title: string
  /** Longer explanation (1-3 sentences) */
  detail: string
  /** Optional suggested alternative ticker the user can click */
  suggested?: string
  /** Optional rationale for why the suggested ticker is appropriate */
  suggestedRationale?: string
  /** Stage where the gate fired — for logs */
  stage: 'pre_bundle' | 'post_bundle'
}

export interface GateOk {
  ok: true
}

export type GateResult = GateBlock | GateOk

// ─────────────────────────────────────────────────────────────
// PRE-BUNDLE GATE — runs immediately after ticker normalization,
// before any data is fetched. Catches known unsupported symbols
// up-front so we don't waste compute / API budget.
// ─────────────────────────────────────────────────────────────

export function evaluateTickerGate(rawTicker: string): GateResult {
  const ticker = (rawTicker ?? '').trim().toUpperCase()

  if (!ticker) {
    return {
      ok: false,
      stage: 'pre_bundle',
      title: 'No ticker provided',
      detail: 'Please enter a ticker symbol to analyze.',
    }
  }

  // Block obviously malformed input — anything with non-alphanumeric
  // characters other than dot (for class-of-stock like BRK.B). This
  // also catches accidental URLs, command injection attempts, etc.
  if (!/^[A-Z0-9.]{1,12}$/.test(ticker)) {
    return {
      ok: false,
      stage: 'pre_bundle',
      title: `"${rawTicker}" doesn't look like a valid ticker`,
      detail: 'Tickers should be 1-12 letters (e.g. MSFT, AAPL, GOOGL). For forex use the 6-letter code (e.g. EURUSD).',
    }
  }

  // Check commodity / futures / metals redirect table.
  // Skip if the symbol is also a real equity (ambiguous list).
  const redirect = COMMODITY_REDIRECTS[ticker]
  if (redirect && !AMBIGUOUS_SYMBOLS.has(ticker)) {
    return {
      ok: false,
      stage: 'pre_bundle',
      title: `${redirect.description} isn't currently supported`,
      detail: `Wali-OS analyzes US equities, options on equities, and major forex pairs. For exposure to this market, try ${redirect.suggested} — ${redirect.rationale}.`,
      suggested: redirect.suggested,
      suggestedRationale: redirect.rationale,
    }
  }

  return { ok: true }
}

// ─────────────────────────────────────────────────────────────
// POST-BUNDLE GATE — runs after the bundle is built. Catches
// the "data sources returned empty" failure mode: typos, delisted
// tickers, foreign listings, illiquid penny stocks, unsupported
// forex pairs not caught by the pre-bundle gate, and ambiguous
// symbols (ZS, BTC, ETH, CL, NG) that turned out to be the
// commodity rather than the equity.
//
// The heuristic: if BOTH currentPrice is zero/null AND bars are
// empty, the data layer found nothing. Refuse to run the pipeline.
// We don't fail on one alone — some valid tickers might have a
// stale quote but valid bars (or vice versa).
// ─────────────────────────────────────────────────────────────

export function evaluateBundleIntegrity(bundle: SignalBundle): GateResult {
  const ticker = bundle.ticker?.toUpperCase() ?? ''
  const price = Number(bundle.currentPrice) || 0
  const barsCount = Array.isArray(bundle.bars) ? bundle.bars.length : 0

  // Both must fail for the gate to trip. A non-zero price OR non-empty
  // bars indicates the data layer found *something* — the Council can
  // do honest work even with partial data.
  const priceMissing = price <= 0
  const barsMissing = barsCount === 0

  if (!priceMissing && !barsMissing) {
    return { ok: true }
  }

  // Both missing → garbage bundle. Check ambiguous-symbol redirects
  // first — if it turned out to be the commodity rather than the equity,
  // suggest the ETF equivalent.
  const ambiguousRedirect =
    AMBIGUOUS_SYMBOLS.has(ticker) ? COMMODITY_REDIRECTS[ticker] : null
  if (ambiguousRedirect) {
    return {
      ok: false,
      stage: 'post_bundle',
      title: `Couldn't find equity data for ${ticker}`,
      detail: `If you meant the futures contract: ${ambiguousRedirect.description} isn't currently supported. Try ${ambiguousRedirect.suggested} instead — ${ambiguousRedirect.rationale}.`,
      suggested: ambiguousRedirect.suggested,
      suggestedRationale: ambiguousRedirect.rationale,
    }
  }

  // Generic "no data" block. Different framings depending on which
  // checks failed — helps the user understand what's wrong.
  if (priceMissing && barsMissing) {
    return {
      ok: false,
      stage: 'post_bundle',
      title: `Couldn't load data for ${ticker}`,
      detail:
        `Wali-OS couldn't find a current price or historical bars for "${ticker}". ` +
        `This usually means the ticker is delisted, a foreign listing not covered by our data sources, ` +
        `a futures or spot commodity contract (try GLD for gold, SLV for silver, USO for oil), ` +
        `or a typo. Supported markets: US equities, options on US equities, and 20 major forex pairs (EURUSD, GBPUSD, USDJPY, etc.).`,
    }
  }

  // One of the two passed — barely. We let it through but log a warning
  // so partial-bundle issues show up in Railway logs.
  console.warn(
    `[ticker-gate] ${ticker}: partial bundle (price=${price}, bars=${barsCount}). ` +
    `Allowing through but Council may produce low-quality analysis.`,
  )
  return { ok: true }
}
