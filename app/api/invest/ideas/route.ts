// ═════════════════════════════════════════════════════════════
// app/api/invest/ideas/route.ts
//
// Tier-aware idea generation backed by the scanner engine.
//
// FLOW:
//   1. Determine user's tier from totalValue
//   2. Look up tier-specific scanner config (price band, scan type, etc)
//   3. Call runScan() → get scored picks with full criteria data
//   4. For each pick, format a `criteriaReasons` array — the WHY this
//      passed at this tier (used by UI to "show the why")
//   5. Send picks to Claude for SETUP SYNTHESIS only (entry, stop, target,
//      shares, rationale) — NOT for ticker selection
//   6. For Operator+: generate options for top 3 bullish ideas
//
// KEY DIFFERENCE from previous version:
//   Previously Claude picked tickers from a curated list + sector context
//   plus volume movers. Now the scanner picks the tickers using the same
//   scoring as /scanner, filtered to the tier's price band. Claude is no
//   longer responsible for which ticker — only for the trade plan.
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import Anthropic from '@anthropic-ai/sdk'
import { runScan, type EnrichedScore } from '@/app/lib/scanner-engine'
import type { ScannerFilter } from '@/app/lib/scanner-universe'
import { enrichOptionIdea, isTradierConfigured, getTradierMode } from '@/app/lib/tradier'

// ─────────────────────────────────────────────────────────────
// Tier configuration
// ─────────────────────────────────────────────────────────────
//
// The displayed tier name uses Buyer/Builder/Operator/Principal/Sovereign
// (matching /api/invest/floor). Scanner config maps to these tiers.

interface TierConfig {
  name: string
  min: number
  max: number
  maxPositions: number
  stopPct: string
  targetPct: string
  strategy: string

  // Scanner config
  priceMin: number
  priceMax: number
  scanType: 'directional' | 'fast_movers'
  universe: string
  newsBoost: boolean
  scanLimit: number
}

const TIER_CONFIG: TierConfig[] = [
  {
    name: 'Buyer',
    min: 0, max: 50,
    maxPositions: 2,
    stopPct: '20–30%', targetPct: '40–80%',
    strategy: 'small-cap momentum at the price level you can afford',
    priceMin: 1, priceMax: 5,
    scanType: 'fast_movers',
    universe: 'screener-actives',
    newsBoost: false,
    scanLimit: 5,
  },
  {
    name: 'Builder',
    min: 50, max: 200,
    maxPositions: 2,
    stopPct: '18–25%', targetPct: '35–70%',
    strategy: 'momentum with early technical confirmation',
    priceMin: 1, priceMax: 15,
    scanType: 'fast_movers',
    universe: 'screener-actives',
    newsBoost: false,
    scanLimit: 6,
  },
  {
    name: 'Operator',
    min: 200, max: 1000,
    maxPositions: 3,
    stopPct: '15–20%', targetPct: '30–60%',
    strategy: 'directional setups with news + sector confirmation',
    priceMin: 5, priceMax: 50,
    scanType: 'directional',
    universe: 'screener-all',
    newsBoost: true,
    scanLimit: 7,
  },
  {
    name: 'Principal',
    min: 1000, max: 10000,
    maxPositions: 4,
    stopPct: '10–15%', targetPct: '20–40%',
    strategy: 'liquid blue-chip directional setups with news edge',
    priceMin: 20, priceMax: 200,
    scanType: 'directional',
    universe: 'screener-all',
    newsBoost: true,
    scanLimit: 8,
  },
  {
    name: 'Sovereign',
    min: 10000, max: Infinity,
    maxPositions: 10,
    stopPct: '5–10%', targetPct: '10–25%',
    strategy: 'diversified conviction-weighted portfolio',
    priceMin: 20, priceMax: 0,  // 0 = no upper bound
    scanType: 'directional',
    universe: 'screener-all',
    newsBoost: true,
    scanLimit: 10,
  },
]

function getTier(totalValue: number): TierConfig {
  return TIER_CONFIG.find(t => totalValue >= t.min && totalValue < t.max) ?? TIER_CONFIG[0]
}

const OPTIONS_MIN_VALUE = 200  // Operator+ unlocks options

function getOptionBudget(deployable: number, maxPositions: number): { maxPremiumPerContract: number; capPct: number } {
  const perPosition = deployable / Math.max(1, maxPositions)
  const capPct = deployable < 5000 ? 0.40 : 0.20
  const cap = perPosition * capPct
  return { maxPremiumPerContract: cap, capPct }
}

// ─────────────────────────────────────────────────────────────
// Build criteriaReasons — the "show the WHY" surface
// ─────────────────────────────────────────────────────────────
//
// Each scanner pick carries rich scoring data. We translate that into
// short, human-readable bullets the UI can show next to each idea.
// Beginners can scan the list and see what makes each idea pass.

function buildCriteriaReasons(pick: EnrichedScore, scanType: string): string[] {
  const reasons: string[] = []

  // ── Direction + composite ──
  if (pick.direction === 'bullish') {
    reasons.push(`Bullish setup (composite ${Math.round(pick.compositeScore)})`)
  } else if (pick.direction === 'bearish') {
    reasons.push(`Bearish setup (composite ${Math.round(pick.compositeScore)})`)
  }

  // ── Rel-strength signal ──
  if (pick.relStrengthScore >= 75) {
    reasons.push(`Strong relative strength vs SPY (${Math.round(pick.relStrengthScore)})`)
  } else if (pick.relStrengthScore >= 60) {
    reasons.push(`Outperforming SPY (rel-strength ${Math.round(pick.relStrengthScore)})`)
  } else if (pick.relStrengthScore <= 25) {
    reasons.push(`Significantly weaker than SPY (rel-strength ${Math.round(pick.relStrengthScore)})`)
  }

  // ── Fast-mover specifics ──
  if (scanType === 'fast_movers' && pick.momentumScore !== undefined) {
    const setup = pick.setupType ? ` · ${pick.setupType}` : ''
    reasons.push(`Momentum score ${Math.round(pick.momentumScore)}${setup}`)

    // Top 1-2 momentum reasons (avoid swamping the UI)
    const momReasons = (pick.momentumReasons ?? []).slice(0, 2)
    for (const r of momReasons) {
      reasons.push(r)
    }
  }

  // ── News boost ──
  if (pick.newsExposureScore !== undefined && pick.newsExposureScore > 0) {
    const matchType = pick.newsMatchType === 'direct' ? 'direct' :
                      pick.newsMatchType === 'sector' ? 'sector' : 'news'
    if (pick.newsAlignedBoost && pick.newsAlignedBoost > 5) {
      reasons.push(`News exposure aligned with direction (+${Math.round(pick.newsAlignedBoost)} boost, ${matchType})`)
    } else if (pick.newsExposureScore > 30) {
      reasons.push(`News attention (${matchType}, exposure ${Math.round(pick.newsExposureScore)})`)
    }
  }

  // ── Liquidity tier ──
  if (pick.liquidityLabel) {
    reasons.push(`Liquidity: ${pick.liquidityLabel}`)
  }

  // ── Tags ──
  if (pick.tags.length > 0 && pick.tags.length <= 3) {
    reasons.push(`Tags: ${pick.tags.join(', ')}`)
  }

  return reasons
}

// ═════════════════════════════════════════════════════════════
// Options idea generator (preserved from previous version)
//
// Called after stock ideas are generated. Asks Claude to propose 2-3 option
// plays based on the top bullish stock ideas. Phase 2 enriches with Tradier.
// ═════════════════════════════════════════════════════════════

interface StockIdea {
  ticker: string
  companyName?: string
  price: number
  livePrice?: number | null
  signal: string
  confidence: number
  catalyst?: string
  rationale?: string
  entry?: string
  stop?: string
  target?: string
  stopPct?: number
  targetPct?: number
  suggestedShares?: number
  suggestedAmount?: number
  criteriaReasons?: string[]
  sector?: string
  tags?: string[]
  timeframe?: string
}

async function generateOptionIdeas(params: {
  anthropic: Anthropic
  topStockIdeas: StockIdea[]
  maxPremiumPerContract: number
  perPositionBudget: number
  tierName: string
  marketContext: string
}): Promise<unknown[]> {
  const { anthropic, topStockIdeas, maxPremiumPerContract, perPositionBudget, tierName, marketContext } = params

  // Take top 3 bullish-only ideas
  const bullishIdeas = topStockIdeas.filter(i => i.signal === 'BULLISH').slice(0, 3)
  if (bullishIdeas.length === 0) return []

  const stockContext = bullishIdeas.map(i =>
    `${i.ticker} @ $${i.livePrice ?? i.price} (${i.signal}, conf ${i.confidence}%) — ${i.catalyst ?? ''}`
  ).join('\n')

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: `You are the Wali-OS options desk. Propose 2-3 directional option plays mirroring the top stock ideas. Strict cost cap: each contract premium × 100 ≤ $${(maxPremiumPerContract * 100).toFixed(0)}. Numeric fields plain numbers — no $ signs.`,
    messages: [{
      role: 'user',
      content: `TIER: ${tierName} (per-position budget ~$${perPositionBudget.toFixed(0)})
MAX PREMIUM PER CONTRACT: $${maxPremiumPerContract.toFixed(2)} (so 1 contract ≤ $${(maxPremiumPerContract * 100).toFixed(0)})

TOP STOCK IDEAS:
${stockContext}

MARKET CONTEXT: ${marketContext}

Generate 2-3 option ideas mirroring the strongest stock setups. JSON ONLY:
{
  "options": [
    {
      "ticker": "AAPL",
      "type": "call",
      "strike": 180,
      "expiry": "2025-12-19",
      "dte": 45,
      "premium": 2.50,
      "contracts": 1,
      "totalCost": 250,
      "delta": 0.45,
      "breakeven": 182.50,
      "maxLoss": 250,
      "rationale": "1 sentence — why this option mirrors the bullish stock thesis",
      "underlyingTicker": "AAPL"
    }
  ]
}`
    }]
  })

  try {
    const text = (msg.content[0] as { type: string; text: string }).text
    const clean = text.replace(/```json|```/g, '').trim()
    const result = JSON.parse(clean)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enriched: any[] = []
    for (const opt of (result.options ?? [])) {
      // Cap by budget
      const premium = parseFloat(String(opt.premium ?? 0))
      if (!premium || premium * 100 > maxPremiumPerContract * 100 * 1.05) continue

      // Try Tradier enrichment
      if (isTradierConfigured()) {
        try {
          const enrichedData = await enrichOptionIdea({
            underlying: opt.underlyingTicker || opt.ticker,
            optionType: opt.type,
            targetStrike: parseFloat(String(opt.strike)),
            targetExpiration: opt.expiry,
          })
          if (enrichedData) {
            opt.dataSource = 'tradier'
            opt.premium = enrichedData.premium ?? opt.premium
            opt.delta = enrichedData.delta ?? opt.delta
            opt.iv = enrichedData.iv
            opt.optionSymbol = enrichedData.optionSymbol
          } else {
            opt.dataSource = 'claude-estimate'
          }
        } catch {
          opt.dataSource = 'claude-estimate'
        }
      } else {
        opt.dataSource = 'claude-estimate'
      }

      opt.totalCost = (opt.premium ?? 0) * 100 * (opt.contracts ?? 1)
      enriched.push(opt)
    }

    return enriched
  } catch (e) {
    console.error('Option ideas parse error:', e)
    return []
  }
}

// ═════════════════════════════════════════════════════════════
// Main route
// ═════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { totalValue, openTrades, cashRemaining } = await req.json()
  const tier = getTier(totalValue ?? 0)
  const deployable = cashRemaining ?? Math.max(
    0,
    (totalValue ?? 0) - (openTrades?.reduce(
      (s: number, t: { entry_price: number; shares: number }) => s + t.entry_price * t.shares, 0
    ) ?? 0)
  )

  // ── Step 1: Run scanner with tier-appropriate config ─────────
  // Try the strict tier band first. If zero picks come back, widen to
  // the NEXT tier's band and try again. Up to one widening per call.
  // This protects very-small Buyer accounts from getting "no setups
  // ever" on slow days, without losing the tier identity on busy days.

  // Mode strategy:
  //   Buyer/Builder: scan 'both' then keep bullish + mixed picks. Beginners
  //     are learning to spot setups; "mixed" picks (momentum present but
  //     direction unclear) still teach the discipline of stop+target+
  //     thesis. Pure bearish is dropped because these tiers can't short.
  //   Operator+: strict 'bullish'. These users have stricter execution
  //     and the cleaner signal matters more.
  const isStrictBullish = tier.name === 'Operator' || tier.name === 'Principal' || tier.name === 'Sovereign'

  async function runScanForBand(
    priceMin: number,
    priceMax: number,
  ) {
    const filter: ScannerFilter = {
      priceMin,
      priceMax: priceMax > 0 ? priceMax : undefined,
    }
    const result = await runScan({
      universe: tier.universe,
      filter,
      mode: isStrictBullish ? 'bullish' : 'both',
      limit: tier.scanLimit,
      newsBoost: tier.newsBoost,
      scanType: tier.scanType,
      horizon: 'week',
      priceCeiling: priceMax > 0 ? priceMax : 999,
    })

    // Post-filter for non-strict tiers: keep bullish + mixed, drop bearish
    if (!isStrictBullish) {
      result.picks = result.picks.filter(p =>
        p.direction === 'bullish' || p.direction === 'mixed'
      )
    }

    return result
  }

  let scanResult = await runScanForBand(tier.priceMin, tier.priceMax)
  let widenedFromTier: string | null = null
  let widenedToBand: { priceMin: number; priceMax: number } | null = null

  if (scanResult.picks.length === 0) {
    // Find the next tier up to widen into
    const tierIdx = TIER_CONFIG.findIndex(t => t.name === tier.name)
    const nextTier = TIER_CONFIG[tierIdx + 1]
    if (nextTier) {
      // Widen the band: keep the floor at the user's tier (so we don't
      // recommend things they truly can't afford), but extend the ceiling
      // to the next tier's ceiling.
      const widenedMin = tier.priceMin
      const widenedMax = nextTier.priceMax > 0 ? nextTier.priceMax : tier.priceMax
      const widenedScan = await runScanForBand(widenedMin, widenedMax)
      if (widenedScan.picks.length > 0) {
        scanResult = widenedScan
        widenedFromTier = tier.name
        widenedToBand = { priceMin: widenedMin, priceMax: widenedMax }
      }
    }
  }


  if (scanResult.picks.length === 0) {
    return NextResponse.json({
      ideas: [],
      options: [],
      optionsBudgetWarning: null,
      journeyNote: `No setups passed criteria today. The scanner reviewed ${scanResult.scannedCount} candidates across ${tier.name}-tier and the wider band, but none met the bar right now. This is normal — most days do not have an A+ setup.`,
      stageAdvice: 'Wait for conditions. Most days do not have an A+ setup — patience is a position.',
      marketContext: `SPY: ${scanResult.spyChange10d > 0 ? '+' : ''}${scanResult.spyChange10d}% (10d), ${scanResult.spyChange30d > 0 ? '+' : ''}${scanResult.spyChange30d}% (30d)`,
      topSectors: [],
      stage: tier.name,
      stageConfig: tier,
      scanMeta: {
        scannedCount: scanResult.scannedCount,
        withTechnicalsCount: scanResult.withTechnicalsCount,
        scanType: tier.scanType,
        universe: tier.universe,
        widenedFromTier,
        widenedToBand,
      },
    })
  }

  // ── Step 2: Build criteria reasons for each pick (the "show the WHY") ──
  const picksWithCriteria = scanResult.picks.map(pick => ({
    pick,
    criteriaReasons: buildCriteriaReasons(pick, tier.scanType),
  }))

  // ── Step 3: Send picks to Claude for SETUP SYNTHESIS ONLY ────
  // Claude no longer chooses tickers — the scanner did that. Claude only
  // produces the trade plan: entry, stop, target, shares, rationale.

  const targetShares = Math.max(
    1,
    Math.floor((deployable / tier.maxPositions) / Math.max(1, scanResult.picks[0].currentPrice))
  )

  const picksContext = picksWithCriteria.map(({ pick, criteriaReasons }, i) =>
    `${i + 1}. ${pick.ticker} @ $${pick.currentPrice.toFixed(2)} · ${pick.direction}\n   Why it passed: ${criteriaReasons.join(' / ')}`
  ).join('\n\n')

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: `You are the Wali-OS Council. The scanner has selected the tickers based on technical criteria. Your job is to produce a complete trade plan for each one — entry, stop, target, share count, and a 1-2 sentence rationale.

CRITICAL RULES:
1. Do NOT propose tickers other than the ones provided.
2. Do NOT skip picks because they seem too expensive for the trader's account. Affordability is handled separately by the system. Your job is to produce a setup for EVERY ticker.
3. Use the live price as the entry anchor.
4. Stop must be in the ${tier.stopPct} range below entry.
5. Target must be in the ${tier.targetPct} range above entry.
6. Suggested shares: produce a sensible round number (typically 1-20 shares depending on price) that represents a reasonable starter position. The actual affordability gate is downstream — produce the plan as if the trader can afford it.

All numeric fields plain numbers — no $ signs, no commas.`,
    messages: [{
      role: 'user',
      content: `TRADER PROFILE:
Tier: ${tier.name}
Strategy: ${tier.strategy}
Stop range: ${tier.stopPct} | Target range: ${tier.targetPct}

SPY CONTEXT: ${scanResult.spyChange10d > 0 ? '+' : ''}${scanResult.spyChange10d}% (10d), ${scanResult.spyChange30d > 0 ? '+' : ''}${scanResult.spyChange30d}% (30d)

SCANNER PICKS:
${picksContext}

For each ticker above, produce a setup. Return JSON ONLY:
{
  "ideas": [
    {
      "ticker": "AAPL",
      "companyName": "Apple Inc.",
      "signal": "BULLISH",
      "confidence": 71,
      "catalyst": "1-2 word event tag (earnings, breakout, etc)",
      "rationale": "1-2 sentences — what makes this a tradeable setup RIGHT NOW given the criteria",
      "entry": "180.00–182.50",
      "stop": 175.00,
      "stopPct": 3,
      "target": 195.00,
      "targetPct": 8,
      "suggestedShares": 5,
      "suggestedAmount": 905,
      "risk": "low|medium|high",
      "timeframe": "1-3 weeks",
      "skipReason": null
    }
  ],
  "journeyNote": "1 sentence about today's market and ${tier.name}-tier opportunity",
  "stageAdvice": "1 practical tip for ${tier.name} traders today",
  "marketContext": "1 sentence on overall conditions"
}`
    }]
  })

  try {
    const text = (msg.content[0] as { type: string; text: string }).text
    const clean = text.replace(/```json|```/g, '').trim()
    const result = JSON.parse(clean)

    const finnhubKey = process.env.FINNHUB_API_KEY
    const validIdeas: StockIdea[] = []

    for (const idea of (result.ideas ?? [])) {
      if (!idea.ticker || idea.skipReason) continue

      // Match back to scanner pick for criteria + price
      const matched = picksWithCriteria.find(p => p.pick.ticker === idea.ticker)
      if (!matched) continue

      // Live price refresh (defense in depth)
      let livePrice: number | null = matched.pick.currentPrice
      if (finnhubKey) {
        try {
          const res = await fetch(
            `https://finnhub.io/api/v1/quote?symbol=${idea.ticker}&token=${finnhubKey}`,
            { cache: 'no-store' }
          )
          if (res.ok) {
            const q = await res.json()
            if (q.c > 0) livePrice = q.c
          }
        } catch { /* ignore */ }
      }

      // Hard reject if price moved out of ACTIVE scan band since the scan.
      // (This may be the strict tier band OR the widened band — either way,
      // we honor whatever band the scanner actually used.)
      const activeMin = widenedToBand?.priceMin ?? tier.priceMin
      const activeMax = widenedToBand?.priceMax ?? tier.priceMax
      if (livePrice && (livePrice < activeMin ||
          (activeMax > 0 && livePrice > activeMax))) {
        continue
      }

      // Normalise numeric fields
      idea.suggestedAmount = typeof idea.suggestedAmount === 'string'
        ? parseFloat(String(idea.suggestedAmount).replace(/[^0-9.-]/g, '')) || 0
        : (idea.suggestedAmount ?? 0)
      idea.suggestedShares = typeof idea.suggestedShares === 'string'
        ? parseFloat(String(idea.suggestedShares)) || 1
        : (idea.suggestedShares ?? 1)
      idea.livePrice = livePrice
      idea.price = livePrice ?? idea.price

      // Recalculate based on live price
      if (livePrice && idea.suggestedShares > 0) {
        idea.suggestedAmount = parseFloat((livePrice * idea.suggestedShares).toFixed(2))
      }

      // Attach criteria reasons + scanner data
      idea.criteriaReasons = matched.criteriaReasons
      idea.sector = matched.pick.sector
      idea.tags = matched.pick.tags

      validIdeas.push(idea)
    }

    // ── Step 4: Options for Operator+ ────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let optionIdeas: any[] = []
    let optionsBudgetWarning: string | null = null

    const accountTotalValue = totalValue ?? 0
    if (accountTotalValue >= OPTIONS_MIN_VALUE && validIdeas.length > 0) {
      const optionBudget = getOptionBudget(deployable, tier.maxPositions)
      const perPositionBudget = deployable / Math.max(1, tier.maxPositions)

      optionIdeas = await generateOptionIdeas({
        anthropic,
        topStockIdeas: validIdeas,
        maxPremiumPerContract: optionBudget.maxPremiumPerContract,
        perPositionBudget,
        tierName: tier.name,
        marketContext: result.marketContext ?? '',
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tradierCount = optionIdeas.filter((o: any) => o.dataSource === 'tradier').length
      const allFromTradier = optionIdeas.length > 0 && tradierCount === optionIdeas.length
      const someFromTradier = tradierCount > 0 && tradierCount < optionIdeas.length
      const tradierMode = getTradierMode()
      const delayNote = tradierMode === 'sandbox' ? ' (sandbox data has a 15-minute delay)' : ''

      if (accountTotalValue < 5000 && optionIdeas.length > 0) {
        const dataNote = allFromTradier
          ? `Prices are from Tradier${delayNote}.`
          : someFromTradier
            ? `Some prices are from Tradier${delayNote}; others are AI estimates.`
            : 'All prices shown are AI estimates.'
        optionsBudgetWarning = `Your account is under $5,000 — option premiums will be small and leverage is limited. Consider growing the account before committing real capital to options. ${dataNote}`
      } else if (optionIdeas.length > 0) {
        if (allFromTradier) {
          optionsBudgetWarning = `Prices are from Tradier's live option chain${delayNote}. Tiles labeled "live" show real market data. Verify on your broker before trading real money.`
        } else if (someFromTradier) {
          optionsBudgetWarning = `Some prices are from Tradier's option chain${delayNote} (labeled "live"); others are AI estimates (labeled "est") where the real chain was unavailable. Verify on your broker before trading.`
        } else {
          optionsBudgetWarning = `Strike prices, premiums, deltas and breakevens shown are AI estimates — real market prices will differ. Verify on a real broker before trading.`
        }
      }
    }

    return NextResponse.json({
      ideas: validIdeas,
      options: optionIdeas,
      optionsBudgetWarning,
      journeyNote: result.journeyNote ?? '',
      stageAdvice: result.stageAdvice ?? '',
      marketContext: result.marketContext ?? `SPY: ${scanResult.spyChange10d > 0 ? '+' : ''}${scanResult.spyChange10d}% (10d)`,
      topSectors: [],  // legacy field — not used now that scanner picks
      stage: tier.name,
      stageConfig: tier,
      scanMeta: {
        scannedCount: scanResult.scannedCount,
        withTechnicalsCount: scanResult.withTechnicalsCount,
        scanType: tier.scanType,
        universe: tier.universe,
        widenedFromTier,
        widenedToBand,
      },
    })
  } catch (err) {
    console.error('Invest ideas error:', err)
    return NextResponse.json({ error: 'Failed to generate ideas' }, { status: 500 })
  }
}
