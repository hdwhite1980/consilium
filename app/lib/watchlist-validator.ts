// =============================================================
// app/lib/watchlist-validator.ts
//
// Layer 2 of the price-grounding fix: post-validation.
//
// After Claude generates the watchlist, this module parses each
// item's catalyst sentence for:
//   1. Explicit percentage claims (e.g. "+5.78%", "down 3%")
//   2. Implied direction language (e.g. "surge", "rally", "drop")
//   3. Asset/ticker mentions ("oil", "bitcoin", "$XLE")
//
// It then cross-references with ground truth prices to detect:
//   - MAJOR mismatch: claimed direction is OPPOSITE of actual,
//     OR claimed magnitude is more than 2x off in opposite sign
//   - MEDIUM mismatch: implied direction wrong (catalyst says
//     "surge" but ticker is down >0.5%)
//   - MINOR mismatch: direction matches but magnitude is 2x+ off
//
// Returns enriched watchlist items with priceCheck field that the
// page can render. Major mismatches drop the item entirely.
// Medium mismatches drop confidence by 25pp and add badge.
// Minor mismatches drop confidence by 10pp and add subtle warning.
// =============================================================

import type { GroundTruthQuote } from './ground-truth-prices'

export interface PriceCheckResult {
  status: 'ok' | 'warn' | 'flag'   // ok = passed/skipped, warn = minor/medium issue, flag = major
  severity: 'none' | 'minor' | 'medium' | 'major'
  reason?: string
  claimedTicker?: string
  claimedPct?: number
  actualPct?: number
  actualPrice?: number
}

// Generic interface so this works for any item with a ticker + catalyst + confidence
interface ValidatableItem {
  ticker: string
  catalyst: string
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence?: number
  // arbitrary extra fields are preserved
  [k: string]: unknown
}

// -----------------------------------------------------------------
// Parse a catalyst sentence
// -----------------------------------------------------------------
interface ParsedCatalyst {
  pctClaim?: { sign: 1 | -1; magnitude: number; rawAsset?: string }  // e.g. "+5.78% on oil"
  impliedDirection?: 'bullish' | 'bearish'
  mentionedAssets: string[]  // uppercased ticker-like tokens
}

const BULLISH_VERBS = ['surge', 'surged', 'surges', 'rally', 'rallied', 'rallies', 'soar', 'soared', 'jump', 'jumped',
                       'spike', 'spiked', 'climb', 'climbed', 'gain', 'gained', 'rise', 'rose', 'risen',
                       'breakout', 'gap up', 'momentum', 'tailwind']
const BEARISH_VERBS = ['drop', 'dropped', 'plunge', 'plunged', 'plummet', 'plummeted', 'crash', 'crashed',
                       'fall', 'fell', 'fallen', 'slide', 'slid', 'slump', 'slumped', 'tumble', 'tumbled',
                       'breakdown', 'gap down', 'selloff', 'sell-off', 'pullback', 'headwind', 'pressure']

function parseCatalyst(catalyst: string): ParsedCatalyst {
  const result: ParsedCatalyst = { mentionedAssets: [] }
  const text = catalyst.toLowerCase()

  // 1. Look for explicit percentage claim
  // Patterns: "+5.78%", "5.78%", "up 3%", "down 1.5%", "surge of 4%"
  // First, try the most specific signed form: "+X.XX%" or "-X.XX%"
  const signedPctMatch = catalyst.match(/([+-])(\d+(?:\.\d+)?)\s*%/)
  if (signedPctMatch) {
    result.pctClaim = {
      sign: signedPctMatch[1] === '-' ? -1 : 1,
      magnitude: parseFloat(signedPctMatch[2]),
    }
  } else {
    // Try "up X%" / "down X%" / "X%"
    const upMatch  = text.match(/up\s+(\d+(?:\.\d+)?)\s*%/)
    const downMatch = text.match(/down\s+(\d+(?:\.\d+)?)\s*%/)
    if (upMatch) {
      result.pctClaim = { sign: 1, magnitude: parseFloat(upMatch[1]) }
    } else if (downMatch) {
      result.pctClaim = { sign: -1, magnitude: parseFloat(downMatch[1]) }
    } else {
      // Bare number - rare, only use if combined with bullish/bearish verb
      const bareMatch = text.match(/(\d+(?:\.\d+)?)\s*%/)
      if (bareMatch) {
        // We'll resolve sign from implied direction below
        result.pctClaim = { sign: 1, magnitude: parseFloat(bareMatch[1]) }
      }
    }
  }

  // 2. Implied direction from verbs
  let bullishHits = 0
  let bearishHits = 0
  for (const v of BULLISH_VERBS) if (text.includes(v)) bullishHits++
  for (const v of BEARISH_VERBS) if (text.includes(v)) bearishHits++
  if (bullishHits > bearishHits)      result.impliedDirection = 'bullish'
  else if (bearishHits > bullishHits) result.impliedDirection = 'bearish'

  // If we had a bare-number claim and impliedDirection says bearish, flip the sign
  if (result.pctClaim && !signedPctMatch && !text.match(/up\s+\d/) && !text.match(/down\s+\d/)) {
    if (result.impliedDirection === 'bearish') result.pctClaim.sign = -1
  }

  // 3. Asset/ticker mentions
  // Look for $TICKER, ALL-CAPS 3-5 letter words, and asset keywords
  const tickerMatches = catalyst.match(/\$?\b[A-Z]{2,5}\b/g) ?? []
  for (const t of tickerMatches) {
    const clean = t.replace('$', '').toUpperCase()
    // Filter common false positives
    if (['THE', 'AND', 'FOR', 'BUT', 'NOT', 'WITH', 'AT', 'ON', 'IN', 'OF', 'TO', 'IS', 'IT', 'AS', 'BE', 'OR', 'AN', 'IF', 'BY', 'A', 'I'].includes(clean)) continue
    if (clean.length === 1) continue
    if (!result.mentionedAssets.includes(clean)) result.mentionedAssets.push(clean)
  }

  // Asset keywords (lowercased text)
  const assetKeywords: Record<string, string> = {
    'oil': 'OIL', 'crude': 'OIL', 'wti': 'OIL', 'brent': 'OIL',
    'gold': 'GOLD', 'silver': 'SILVER',
    'natural gas': 'NATGAS', 'natgas': 'NATGAS',
    'bitcoin': 'BITCOIN', 'btc': 'BITCOIN',
    'ethereum': 'ETHEREUM', 'eth': 'ETHEREUM',
    'solana': 'SOLANA',
    'energy sector': 'ENERGY', 'energy stocks': 'ENERGY',
    'tech sector': 'TECH', 'technology sector': 'TECH',
    'financials': 'FINANCIALS',
    'healthcare': 'HEALTHCARE',
    's&p': 'S&P', 's&p 500': 'S&P 500',
    'nasdaq': 'NASDAQ', 'russell': 'RUSSELL', 'dow': 'DOW',
    'vix': 'VIX',
  }
  for (const [k, v] of Object.entries(assetKeywords)) {
    if (text.includes(k) && !result.mentionedAssets.includes(v)) {
      result.mentionedAssets.push(v)
    }
  }

  return result
}

// -----------------------------------------------------------------
// Validate one item
// -----------------------------------------------------------------
function validateItem(
  item: ValidatableItem,
  groundTruthMap: Map<string, GroundTruthQuote>,
): PriceCheckResult {
  const parsed = parseCatalyst(item.catalyst)

  // Try to resolve the asset the catalyst is talking about
  // Prefer the item's own ticker, then mentioned assets
  let primaryAsset: GroundTruthQuote | undefined
  let primaryAssetKey: string | undefined

  // First try the item's own ticker
  const ownGt = groundTruthMap.get(item.ticker.toUpperCase())
  if (ownGt) {
    primaryAsset = ownGt
    primaryAssetKey = item.ticker.toUpperCase()
  } else {
    // Try mentioned assets in order
    for (const a of parsed.mentionedAssets) {
      const gt = groundTruthMap.get(a)
      if (gt) {
        primaryAsset = gt
        primaryAssetKey = a
        break
      }
    }
  }

  // No ground truth match - we can't validate, return ok/skipped
  if (!primaryAsset) {
    return { status: 'ok', severity: 'none', reason: 'no ground truth match for ticker or mentioned assets' }
  }

  const actualPct = primaryAsset.changePct

  // Case 1: Explicit percentage claim - check magnitude AND direction
  if (parsed.pctClaim) {
    const claimedPct = parsed.pctClaim.sign * parsed.pctClaim.magnitude
    const actualSign = actualPct >= 0 ? 1 : -1
    const claimedSign = parsed.pctClaim.sign

    // Sign mismatch (catalyst says up, actual is down or vice versa)
    if (actualSign !== claimedSign && Math.abs(actualPct) > 0.5 && parsed.pctClaim.magnitude > 0.5) {
      // Major - opposite direction with meaningful magnitudes
      return {
        status: 'flag',
        severity: 'major',
        reason: `Catalyst claims ${claimedPct >= 0 ? '+' : ''}${claimedPct.toFixed(2)}% on ${primaryAssetKey} but actual is ${actualPct >= 0 ? '+' : ''}${actualPct.toFixed(2)}%`,
        claimedTicker: primaryAssetKey,
        claimedPct,
        actualPct,
        actualPrice: primaryAsset.price,
      }
    }

    // Magnitude wildly off (>2x in same direction)
    const claimedMag = Math.abs(claimedPct)
    const actualMag = Math.abs(actualPct)
    if (actualSign === claimedSign && claimedMag > 2 * actualMag && claimedMag > 1) {
      return {
        status: 'warn',
        severity: 'minor',
        reason: `Catalyst claims ${claimedPct >= 0 ? '+' : ''}${claimedPct.toFixed(2)}% on ${primaryAssetKey} but actual is only ${actualPct >= 0 ? '+' : ''}${actualPct.toFixed(2)}%`,
        claimedTicker: primaryAssetKey,
        claimedPct,
        actualPct,
        actualPrice: primaryAsset.price,
      }
    }

    // Within tolerance - passed
    return {
      status: 'ok',
      severity: 'none',
      claimedTicker: primaryAssetKey,
      claimedPct,
      actualPct,
      actualPrice: primaryAsset.price,
    }
  }

  // Case 2: No explicit %, but implied direction - check direction only
  if (parsed.impliedDirection) {
    const impliedSign = parsed.impliedDirection === 'bullish' ? 1 : -1
    const actualSign = actualPct >= 0 ? 1 : -1
    if (impliedSign !== actualSign && Math.abs(actualPct) > 0.5) {
      return {
        status: 'warn',
        severity: 'medium',
        reason: `Catalyst implies ${parsed.impliedDirection} on ${primaryAssetKey} but actual is ${actualPct >= 0 ? '+' : ''}${actualPct.toFixed(2)}%`,
        claimedTicker: primaryAssetKey,
        actualPct,
        actualPrice: primaryAsset.price,
      }
    }
  }

  return {
    status: 'ok',
    severity: 'none',
    claimedTicker: primaryAssetKey,
    actualPct,
    actualPrice: primaryAsset.price,
  }
}

// -----------------------------------------------------------------
// Main entry point - validates an array of items.
// Major-severity items are DROPPED from the returned list.
// Medium/minor items are kept but with confidence penalty + badge.
// -----------------------------------------------------------------
export function validateWatchlist<T extends ValidatableItem>(
  items: T[],
  groundTruthMap: Map<string, GroundTruthQuote>,
): { kept: Array<T & { priceCheck: PriceCheckResult }>; dropped: Array<T & { priceCheck: PriceCheckResult }> } {
  const kept: Array<T & { priceCheck: PriceCheckResult }> = []
  const dropped: Array<T & { priceCheck: PriceCheckResult }> = []

  for (const item of items) {
    const check = validateItem(item, groundTruthMap)
    const enriched = { ...item, priceCheck: check }

    if (check.severity === 'major') {
      dropped.push(enriched)
      console.log(`[validator] DROPPED ${item.ticker}: ${check.reason}`)
      continue
    }

    // Apply confidence penalty for non-major mismatches
    if (typeof enriched.confidence === 'number') {
      if (check.severity === 'medium') enriched.confidence = Math.max(0, enriched.confidence - 25)
      else if (check.severity === 'minor') enriched.confidence = Math.max(0, enriched.confidence - 10)
    }

    if (check.severity !== 'none') {
      console.log(`[validator] WARN ${item.ticker} (${check.severity}): ${check.reason}`)
    }

    kept.push(enriched)
  }

  // After penalty, re-filter the >=60 confidence threshold (matches existing logic)
  const finalKept = kept.filter(k => typeof k.confidence !== 'number' || k.confidence >= 60)
  const additionalDropped = kept.filter(k => typeof k.confidence === 'number' && k.confidence < 60)

  return {
    kept: finalKept,
    dropped: [...dropped, ...additionalDropped],
  }
}

// -----------------------------------------------------------------
// Validation summary for response telemetry
// -----------------------------------------------------------------
export function summarizeValidation<T extends { priceCheck?: PriceCheckResult }>(
  kept: T[],
  dropped: T[],
): { totalReviewed: number; passed: number; warned: number; dropped: number; majorIssues: string[] } {
  const totalReviewed = kept.length + dropped.length
  const passed = kept.filter(k => k.priceCheck?.severity === 'none').length
  const warned = kept.filter(k => k.priceCheck && k.priceCheck.severity !== 'none').length
  const majorIssues = dropped
    .filter(d => d.priceCheck?.severity === 'major')
    .map(d => d.priceCheck?.reason ?? '')
    .filter(Boolean)
  return {
    totalReviewed,
    passed,
    warned,
    dropped: dropped.length,
    majorIssues,
  }
}
