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

// Generic interface so this works for any item with a ticker + catalyst + confidence.
// Callers pass their own richer types via the generic T parameter on validateWatchlist.
interface ValidatableItem {
  ticker: string
  catalyst: string
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence?: number
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

  // Find ALL percentage claims with their position in the text.
  // We'll then associate each with a nearby asset keyword so the
  // validator picks the correct one when a catalyst has multiple.
  type PctMatch = { sign: 1 | -1; magnitude: number; index: number; raw: string }
  const allClaims: PctMatch[] = []

  // Pattern A: signed (+X.XX% or -X.XX%)
  for (const m of catalyst.matchAll(/([+\-])(\d+(?:\.\d+)?)\s*%/g)) {
    allClaims.push({
      sign: m[1] === '-' ? -1 : 1,
      magnitude: parseFloat(m[2]),
      index: m.index ?? 0,
      raw: m[0],
    })
  }
  // Pattern B: "up X%" / "down X%"
  for (const m of text.matchAll(/up\s+(\d+(?:\.\d+)?)\s*%/g)) {
    allClaims.push({ sign: 1, magnitude: parseFloat(m[1]), index: m.index ?? 0, raw: m[0] })
  }
  for (const m of text.matchAll(/down\s+(\d+(?:\.\d+)?)\s*%/g)) {
    allClaims.push({ sign: -1, magnitude: parseFloat(m[1]), index: m.index ?? 0, raw: m[0] })
  }
  // Pattern C: "X% higher/above/up" / "X% lower/below/down"
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*%\s+(higher|above|up|gain|gains|rally|rallies|rise|risen|jumped|jump|surge|climbed|climb)/g)) {
    allClaims.push({ sign: 1, magnitude: parseFloat(m[1]), index: m.index ?? 0, raw: m[0] })
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*%\s+(lower|below|down|loss|losses|drop|drops|fall|falls|fell|fallen|plunge|slump|slumped|tumble|crashed|crash)/g)) {
    allClaims.push({ sign: -1, magnitude: parseFloat(m[1]), index: m.index ?? 0, raw: m[0] })
  }
  // Pattern D: "gained/rose/surged X%" verb + %
  for (const m of text.matchAll(/(gained|rose|risen|rallied|surged|jumped|climbed|gapped\s+up)\s+(?:\w+\s+)?(\d+(?:\.\d+)?)\s*%/g)) {
    allClaims.push({ sign: 1, magnitude: parseFloat(m[2]), index: m.index ?? 0, raw: m[0] })
  }
  for (const m of text.matchAll(/(fell|fallen|dropped|plunged|tumbled|slumped|crashed|gapped\s+down)\s+(?:\w+\s+)?(\d+(?:\.\d+)?)\s*%/g)) {
    allClaims.push({ sign: -1, magnitude: parseFloat(m[2]), index: m.index ?? 0, raw: m[0] })
  }

  // Deduplicate claims that overlap (same magnitude at nearby positions)
  // Keep the longest match (most specific pattern)
  const uniqueClaims: PctMatch[] = []
  for (const c of allClaims.sort((a, b) => a.index - b.index)) {
    const overlaps = uniqueClaims.find(u =>
      Math.abs(u.index - c.index) < 10 && Math.abs(u.magnitude - c.magnitude) < 0.01
    )
    if (overlaps) {
      // Prefer the longer/more specific raw match
      if (c.raw.length > overlaps.raw.length) {
        const idx = uniqueClaims.indexOf(overlaps)
        uniqueClaims[idx] = c
      }
    } else {
      uniqueClaims.push(c)
    }
  }

  // 2. Implied direction from verbs
  let bullishHits = 0
  let bearishHits = 0
  for (const v of BULLISH_VERBS) if (text.includes(v)) bullishHits++
  for (const v of BEARISH_VERBS) if (text.includes(v)) bearishHits++
  if (/\b(higher|above|gain|gainer|rallying)\b/.test(text)) bullishHits++
  if (/\b(lower|below|loss|loser|falling)\b/.test(text)) bearishHits++
  if (bullishHits > bearishHits)      result.impliedDirection = 'bullish'
  else if (bearishHits > bullishHits) result.impliedDirection = 'bearish'

  // 3. Asset/ticker mentions with their position in the text
  type AssetMatch = { key: string; index: number }
  const assetMatches: AssetMatch[] = []

  // ALL_CAPS tickers from the original catalyst
  for (const m of catalyst.matchAll(/\$?\b[A-Z]{2,5}\b/g)) {
    const clean = m[0].replace('$', '').toUpperCase()
    if (['THE', 'AND', 'FOR', 'BUT', 'NOT', 'WITH', 'AT', 'ON', 'IN', 'OF', 'TO', 'IS', 'IT', 'AS', 'BE', 'OR', 'AN', 'IF', 'BY'].includes(clean)) continue
    if (clean.length < 2) continue
    assetMatches.push({ key: clean, index: m.index ?? 0 })
  }

  // Asset keywords (lowercased text). Order matters: more specific first
  // so "oil futures" matches before "oil" -> USO.
  const assetKeywords: Array<[string, string]> = [
    ['oil futures',  'WTI_FUTURES'],
    ['wti futures',  'WTI_FUTURES'],
    ['crude futures','WTI_FUTURES'],
    ['brent futures','BRENT_FUTURES'],
    ['gold futures', 'GOLD_FUTURES'],
    ['gas futures',  'NATGAS_FUTURES'],
    ['s&p futures',  'ES_FUTURES'],
    ['nasdaq futures','NQ_FUTURES'],
    ['dow futures',  'YM_FUTURES'],
    ['oil',          'OIL'],
    ['crude',        'OIL'],
    ['wti',          'OIL'],
    ['brent',        'OIL'],
    ['gold',         'GOLD'],
    ['silver',       'SILVER'],
    ['natural gas',  'NATGAS'],
    ['natgas',       'NATGAS'],
    ['bitcoin',      'BITCOIN'],
    ['btc',          'BITCOIN'],
    ['ethereum',     'ETHEREUM'],
    ['eth',          'ETHEREUM'],
    ['solana',       'SOLANA'],
    ['energy sector','ENERGY'],
    ['energy stocks','ENERGY'],
    ['tech sector',  'TECH'],
    ['technology sector','TECH'],
    ['financials',   'FINANCIALS'],
    ['healthcare',   'HEALTHCARE'],
    ['s&p 500',      'S&P 500'],
    ['s&p',          'S&P'],
    ['nasdaq',       'NASDAQ'],
    ['russell',      'RUSSELL'],
    ['dow',          'DOW'],
    ['vix',          'VIX'],
  ]
  // Track which keys we've already added so we don't double-up
  const addedKeys = new Set<string>()
  for (const [kw, mappedKey] of assetKeywords) {
    const idx = text.indexOf(kw)
    if (idx === -1) continue
    if (addedKeys.has(mappedKey)) continue
    addedKeys.add(mappedKey)
    assetMatches.push({ key: mappedKey, index: idx })
    if (!result.mentionedAssets.includes(mappedKey)) result.mentionedAssets.push(mappedKey)
  }

  // 4. Associate the BEST percentage claim with the BEST asset.
  // Heuristic: pair each pct with the nearest preceding asset mention
  // (within 60 chars). If no asset is close, fall back to the first claim.
  if (uniqueClaims.length > 0) {
    // For each claim, find the closest asset mention that PRECEDES it.
    // The "primary" claim is the first one whose nearby asset is a
    // futures-keyword (most specific) or commodity asset.
    let bestClaim: PctMatch | null = null
    let bestAssetKey: string | undefined

    for (const claim of uniqueClaims) {
      // Find asset that precedes this claim within 60 chars (or appears in same clause)
      const candidates = assetMatches.filter(a => {
        const dist = claim.index - a.index
        return dist >= 0 && dist <= 60
      })
      if (candidates.length === 0) continue
      // Prefer the closest preceding asset
      const closest = candidates.reduce((acc, cur) =>
        (claim.index - cur.index) < (claim.index - acc.index) ? cur : acc
      )
      // Prefer claims whose nearby asset is a futures-keyword (more specific)
      if (closest.key.endsWith('_FUTURES')) {
        bestClaim = claim
        bestAssetKey = closest.key
        break  // Best possible match
      }
      // Otherwise hold this as a candidate but keep looking
      if (!bestClaim) {
        bestClaim = claim
        bestAssetKey = closest.key
      }
    }

    // Fallback: if no asset-associated claim, just use the first
    if (!bestClaim) {
      bestClaim = uniqueClaims[0]
    }

    result.pctClaim = {
      sign: bestClaim.sign,
      magnitude: bestClaim.magnitude,
      rawAsset: bestAssetKey,
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

  // Resolve which asset the percentage claim is about. The logic:
  //
  //   - If the catalyst has an explicit pct claim AND mentions a specific
  //     asset (especially futures like "oil futures", "WTI", "brent"), the
  //     pct is almost certainly about THAT asset, not the item's ticker.
  //     Example: item=XLE, catalyst="Oil futures gapped 5.78% higher" -> validate
  //     the 5.78% against OIL/WTI_FUTURES, NOT against XLE.
  //
  //   - If the catalyst has a pct claim but no mentioned asset, validate
  //     against the item's own ticker.
  //
  //   - If no pct claim, fall back to item ticker for direction check.
  let primaryAsset: GroundTruthQuote | undefined
  let primaryAssetKey: string | undefined

  if (parsed.pctClaim && parsed.mentionedAssets.length > 0) {
    // Prefer mentioned assets, especially futures-specific ones
    const futuresAssets = parsed.mentionedAssets.filter(a => a.endsWith('_FUTURES'))
    const orderedAssets = [...futuresAssets, ...parsed.mentionedAssets.filter(a => !a.endsWith('_FUTURES'))]
    for (const a of orderedAssets) {
      const gt = groundTruthMap.get(a)
      if (gt) {
        primaryAsset = gt
        primaryAssetKey = a
        break
      }
    }
    // If still nothing, fall back to item ticker
    if (!primaryAsset) {
      const ownGt = groundTruthMap.get(item.ticker.toUpperCase())
      if (ownGt) {
        primaryAsset = ownGt
        primaryAssetKey = item.ticker.toUpperCase()
      }
    }
  } else if (!parsed.pctClaim && parsed.mentionedAssets.some(a => a.endsWith('_FUTURES'))) {
    // No pct claim but a specific futures asset is mentioned - validate
    // direction against that asset, not the item's ticker.
    // Example: item=XLE, catalyst="Oil futures gapped higher overnight, bullish energy"
    // -> validate "bullish" direction against WTI_FUTURES (which is up), not XLE (down).
    const futuresAssets = parsed.mentionedAssets.filter(a => a.endsWith('_FUTURES'))
    for (const a of futuresAssets) {
      const gt = groundTruthMap.get(a)
      if (gt) {
        primaryAsset = gt
        primaryAssetKey = a
        break
      }
    }
    // Fall back to item ticker
    if (!primaryAsset) {
      const ownGt = groundTruthMap.get(item.ticker.toUpperCase())
      if (ownGt) {
        primaryAsset = ownGt
        primaryAssetKey = item.ticker.toUpperCase()
      }
    }
  } else {
    // No pct claim, or no mentioned assets - prefer item ticker, then mentioned
    const ownGt = groundTruthMap.get(item.ticker.toUpperCase())
    if (ownGt) {
      primaryAsset = ownGt
      primaryAssetKey = item.ticker.toUpperCase()
    } else {
      for (const a of parsed.mentionedAssets) {
        const gt = groundTruthMap.get(a)
        if (gt) {
          primaryAsset = gt
          primaryAssetKey = a
          break
        }
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

    // Magnitude wildly off (>1.5x in same direction triggers minor warning)
    const claimedMag = Math.abs(claimedPct)
    const actualMag = Math.abs(actualPct)
    if (actualSign === claimedSign && claimedMag > 1.5 * actualMag && claimedMag > 1) {
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
