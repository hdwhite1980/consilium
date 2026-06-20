// =============================================================
// app/lib/verification/futures-verification.ts (Layer 5)
//
// Verifies Council claims about futures-specific data points.
// Strips claims that are clearly hallucinated (e.g. citing EIA
// data when EIA isn't wired).
//
// Categories of verification:
//   1. COT claims: check against the bundle's cotData
//   2. Fundamentals claims for non-equity-index families:
//      if the family doesn't have fundamentals wired, ANY citation
//      of EIA/USDA/FRED data is flagged as ungrounded
//   3. ETF proxy claims: ensure proxy citations note divergence risk
// =============================================================

import type { FuturesMeta, CotSnapshot } from '../signals/futures-bundle'

export interface VerificationFlag {
  severity: 'strip' | 'discount' | 'note'
  category: 'cot' | 'fundamentals_hallucinated' | 'proxy_basis' | 'data_layer'
  claim: string
  rationale: string
}

export interface VerificationResult {
  flags: VerificationFlag[]
  // Whether ANY strip-level flags fired
  hasStripFlags: boolean
}

// Patterns that indicate the agent is citing ungrounded fundamentals
// for families where those data sources aren't wired.
const UNGROUNDED_PATTERNS: Record<string, RegExp[]> = {
  energy: [
    /\bEIA\b/i,
    /weekly petroleum status/i,
    /crude oil stocks?\s+(rose|fell|up|down|grew|dropped)/i,
    /refinery utilization/i,
    /strategic petroleum reserve/i,
    /OPEC\+? (cut|raised|production)/i,
  ],
  grains: [
    /\bUSDA\b/i,
    /WASDE/i,
    /crop progress/i,
    /\bdrought monitor\b/i,
    /yield estimate.{0,40}(raised|cut|reduced|increased)/i,
  ],
  metals: [
    /COMEX warehouse/i,
    /central bank gold (purchase|buy|sale)/i,
    /\bLBMA\b/i,
    /Shanghai Gold/i,
  ],
  rates: [
    /\bFRED\b/i,
    /Fed funds futures.{0,30}(implied|priced)/i,
    /Treasury auction.{0,30}(bid-to-cover|indirect bid)/i,
    /\bDGS10\b/i,
    /DGS2/i,
    /T10YIE/i,
    /\bbreakeven\b/i,
  ],
  volatility: [
    /VIX9D/i,
    /VIX3M/i,
    /VIX6M/i,
    /\bVVIX\b/i,
    /SKEW index/i,
  ],
}

/**
 * Scan a Council response for ungrounded data citations.
 * Returns flags noting any patterns matched.
 */
export function verifyFuturesResponse(
  responseText: string,
  meta: FuturesMeta,
): VerificationResult {
  const flags: VerificationFlag[] = []

  // 1. Check for hallucinated fundamentals (only for families where they're not wired)
  if (!meta.dataAvailability.fundamentalsWired) {
    const patterns = UNGROUNDED_PATTERNS[meta.category] ?? []
    for (const pat of patterns) {
      const match = responseText.match(pat)
      if (match) {
        flags.push({
          severity: 'strip',
          category: 'fundamentals_hallucinated',
          claim: match[0],
          rationale: `${meta.category} fundamentals (${pat.source}) are NOT wired in v1; this citation is unsupported.`,
        })
      }
    }
  }

  // 2. Verify any COT claims against the bundle's cotData
  if (meta.dataAvailability.cotData) {
    const cot = meta.dataAvailability.cotData
    // Look for numeric COT claims and cross-check
    flags.push(...verifyCotClaims(responseText, cot))
  } else {
    // No COT data; any citation of COT is ungrounded
    if (/CFTC|commitments? of traders|\bCOT\b/i.test(responseText)) {
      flags.push({
        severity: 'discount',
        category: 'cot',
        claim: 'COT citation',
        rationale: 'No COT data was provided to this Council run; citation is ungrounded.',
      })
    }
  }

  // 3. ETF proxy basis-risk reminder for non-equity-index families
  if (meta.underlyingEtfProxy && meta.category !== 'equity_index' && meta.category !== 'fx') {
    const proxyMentioned = new RegExp(`\\b${meta.underlyingEtfProxy}\\b`, 'i').test(responseText)
    const basisAddressed = /(contango|backwardation|basis|tracking error|divergen|decay)/i.test(responseText)
    if (proxyMentioned && !basisAddressed) {
      flags.push({
        severity: 'note',
        category: 'proxy_basis',
        claim: `Cites ${meta.underlyingEtfProxy} without addressing basis risk`,
        rationale: `${meta.underlyingEtfProxy} can diverge from ${meta.root} due to contango/decay; Council should acknowledge.`,
      })
    }
  }

  const hasStripFlags = flags.some(f => f.severity === 'strip')
  return { flags, hasStripFlags }
}

/**
 * Cross-check specific numeric COT claims against the bundle snapshot.
 * Detects "speculators are net long 150,000 contracts" style claims
 * and flags if the actual number is materially different.
 */
function verifyCotClaims(text: string, cot: CotSnapshot): VerificationFlag[] {
  const flags: VerificationFlag[] = []

  // Look for "net long/short X contracts" patterns
  const netMatch = text.match(/net (long|short)\s+(?:of\s+)?(?:approximately\s+)?([\d,]+)/i)
  if (netMatch) {
    const direction = netMatch[1].toLowerCase()
    const cited = Number(netMatch[2].replace(/,/g, ''))
    if (Number.isFinite(cited) && cited > 0) {
      const actualMagnitude = Math.abs(cot.nonCommercialNet)
      const actualDirection = cot.nonCommercialNet > 0 ? 'long' : 'short'
      const pctDeviation = Math.abs(cited - actualMagnitude) / actualMagnitude
      if (direction !== actualDirection) {
        flags.push({
          severity: 'strip',
          category: 'cot',
          claim: `net ${direction} ${cited.toLocaleString()}`,
          rationale: `Actual COT shows net ${actualDirection} ${actualMagnitude.toLocaleString()} — direction wrong.`,
        })
      } else if (pctDeviation > 0.20) {
        flags.push({
          severity: 'discount',
          category: 'cot',
          claim: `net ${direction} ${cited.toLocaleString()}`,
          rationale: `Actual is ${actualMagnitude.toLocaleString()} (${(pctDeviation * 100).toFixed(0)}% deviation).`,
        })
      }
    }
  }

  // Look for "% of open interest" claims
  const pctMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*of\s*(?:open interest|OI)/i)
  if (pctMatch) {
    const cited = Number(pctMatch[1])
    const actual = Math.abs(cot.nonCommercialNetPctOI * 100)
    if (Number.isFinite(cited) && Math.abs(cited - actual) > 5) {
      flags.push({
        severity: 'discount',
        category: 'cot',
        claim: `${cited}% of OI`,
        rationale: `Actual is ${actual.toFixed(1)}% of OI.`,
      })
    }
  }

  return flags
}

/**
 * Render flags as a Council-readable verification report that the
 * Judge can use to discount claims.
 */
export function formatVerificationFlags(flags: VerificationFlag[]): string {
  if (flags.length === 0) return 'Verification: no flags.'
  const lines = ['Verification report:']
  for (const f of flags) {
    lines.push(`  [${f.severity.toUpperCase()}] (${f.category}) "${f.claim}": ${f.rationale}`)
  }
  return lines.join('\n')
}
