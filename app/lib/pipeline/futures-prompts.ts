// =============================================================
// app/lib/pipeline/futures-prompts.ts (Layer 5 — compact rewrite)
//
// Compact futures system prompts. The user prompt sent by the
// existing pipeline drives the JSON output schema; these system
// prompts ONLY inject futures-specific reasoning guidance.
//
// Design philosophy: minimal guidance > comprehensive guidance.
// The Council pipeline already has battle-tested JSON output
// schemas in the user prompts. We only need to tell the model
// 4-5 things about futures, not lecture it.
// =============================================================

import type { FuturesMeta } from '../signals/futures-bundle'
import { formatCotForPrompt } from '../signals/futures-bundle'

// ─────────────────────────────────────────────────────────────
// Compact data-availability block
// ─────────────────────────────────────────────────────────────

function buildCompactDataBlock(meta: FuturesMeta): string {
  const parts: string[] = []
  parts.push(`CONTRACT: ${meta.root} (${categoryLabel(meta.category)}, ${meta.micro ? 'micro' : 'standard'})`)
  parts.push(`Tick: $${meta.spec.tickValueUsd} per ${meta.spec.tickSize}`)
  if (meta.underlyingEtfProxy) {
    parts.push(`Underlying proxy in bundle: ${meta.underlyingEtfProxy}`)
  }
  // Surface the price derivation so the Council reasons in the correct units
  if (meta.priceDerivation) {
    const d = meta.priceDerivation
    if (d.method === 'linear' && d.multiplier && d.proxyTicker && d.proxyPrice !== null && d.futuresPrice !== null) {
      parts.push(`PRICE: ${meta.root} ≈ $${d.futuresPrice.toFixed(2)} (derived from ${d.proxyTicker} $${d.proxyPrice.toFixed(2)} × ${d.multiplier}). Reason in ${meta.root} units, not ${d.proxyTicker} units. ATR/support/resistance levels in this prompt are from ${d.proxyTicker} — translate to ${meta.root} by multiplying by ${d.multiplier} before stating any price levels.`)
    } else if (d.method === 'proxy_only' && d.proxyTicker) {
      parts.push(`PRICE WARNING: Bundle shows ${d.proxyTicker} ETF price as approximation. The actual ${meta.root} contract trades in different units. ${d.note} State entry/stop/target in ${meta.root} units conceptually (e.g., "stop 50 ticks below entry") rather than in dollar amounts, since the proxy price is not the contract price.`)
    } else if (d.method === 'none') {
      parts.push(`PRICE WARNING: No price data wired for ${meta.root} in v1. State entries/stops conceptually (ticks/points) rather than absolute price levels.`)
    }
  }
  parts.push(``)
  parts.push(`DATA WIRED: COT positioning${meta.dataAvailability.cotAvailable ? ' (in prompt below)' : ' (unavailable this run)'}, technical indicators on ${meta.underlyingEtfProxy ?? 'underlying'}, macro/news context.`)
  parts.push(`DATA NOT WIRED: ${notWiredList(meta.category)}. Do NOT cite these data sources — say "${meta.category} fundamentals not in data layer" if pressed.`)
  if (meta.dataAvailability.cotData) {
    parts.push(``)
    parts.push(formatCotForPrompt(meta.dataAvailability.cotData))
  }
  return parts.join('\n')
}

function notWiredList(category: FuturesMeta['category']): string {
  switch (category) {
    case 'energy':     return 'EIA weekly inventory, OPEC production, refinery utilization, SPR levels'
    case 'grains':     return 'USDA WASDE, crop progress, drought monitor, USDA export sales'
    case 'metals':     return 'COMEX warehouse stocks, LBMA fixes, World Gold Council central bank flows'
    case 'rates':      return 'FRED yield curve, Fed funds futures-implied rates, Treasury auction results, breakevens'
    case 'volatility': return 'VIX term structure (VIX9D/VIX3M/VIX6M), VVIX, SKEW'
    case 'fx':         return 'Nothing missing — FX futures use same data as spot forex pairs'
    case 'equity_index': return 'Nothing missing — equity index futures use full underlying ETF data'
    default:           return 'Various commodity-specific data sources'
  }
}

function categoryLabel(cat: FuturesMeta['category']): string {
  const labels: Record<FuturesMeta['category'], string> = {
    equity_index: 'equity index',
    volatility: 'volatility',
    energy: 'energy',
    metals: 'metals',
    grains: 'grains',
    rates: 'interest rate',
    fx: 'FX',
    other: 'other',
  }
  return labels[cat]
}

// ─────────────────────────────────────────────────────────────
// Lead — futures variant
// ─────────────────────────────────────────────────────────────

export function buildFuturesLeadSystemPrompt(meta: FuturesMeta): string {
  return `You are the Lead Analyst in an elite AI council analyzing a FUTURES CONTRACT: ${meta.root}. This is a derivative, NOT a stock or ETF.

${buildCompactDataBlock(meta)}

ANALYSIS RULES:
- Frame the thesis on ${meta.root} (the futures contract), not on ${meta.underlyingEtfProxy ?? 'the proxy'}.
- COT positioning is a primary input. Extreme >30% net-of-OI is reversal risk; building positioning is momentum confirmation.
- Do not cite data sources listed as "DATA NOT WIRED" above. If you would normally cite them, instead state "data layer doesn't include X" and reason from what IS available.
- Futures have no earnings, no insider trades, no analyst ratings, no P/E. Don't use those frames.
- For non-equity-index families, the underlying proxy can diverge from the contract via contango/basis — acknowledge if proxy data is your main evidence.

Be decisive. Cite specific evidence. Use the same JSON output schema the user prompt requests below.`
}

// ─────────────────────────────────────────────────────────────
// Devil — futures variant
// ─────────────────────────────────────────────────────────────

export function buildFuturesDevilSystemPrompt(meta: FuturesMeta): string {
  return `You are the Devil's Advocate in an elite AI council challenging the Lead's thesis on FUTURES CONTRACT ${meta.root}.

${buildCompactDataBlock(meta)}

ATTACK SURFACES:
- POSITIONING REVERSAL: extreme COT (>30% net of OI) sets up sharp mean reversion. Hammer if Lead is going with the crowd at an extreme.
- DATA HOLES: if Lead cited data sources listed as "DATA NOT WIRED" above, that citation is ungrounded — call it out.
- CATALYST GAPS: futures move on scheduled catalysts (FOMC, CPI, EIA Wed, USDA WASDE). Lead silent on an imminent catalyst = major hole.
- PROXY BASIS: if Lead leaned on ${meta.underlyingEtfProxy ?? 'a proxy'} without acknowledging divergence from ${meta.root} contract, challenge whether the futures will track.
- EXECUTION RISK: futures gap on Sunday open. Stops at obvious technical levels get hunted.

Do NOT yield unless factually refuted by data in this prompt OR by real-time news research. Use the same JSON output schema the user prompt requests below.`
}

// ─────────────────────────────────────────────────────────────
// Judge — futures variant
// ─────────────────────────────────────────────────────────────

export function buildFuturesJudgeSystemPrompt(meta: FuturesMeta): string {
  const fundamentalsCap = meta.dataAvailability.fundamentalsWired
    ? 'Standard confidence ranges apply.'
    : 'Cap confidence at 65 even for technically sound theses — the data layer for this family does not justify higher conviction.'

  return `You are the Judge issuing the final verdict on FUTURES CONTRACT ${meta.root}.

${buildCompactDataBlock(meta)}

JUDGE RULES:
- Weigh both sides on the evidence presented. Discount any claim that cited data not in the prompt.
- Extreme COT positioning (>30% net of OI) against the verdict direction is a confidence dampener.
- ${fundamentalsCap}
- For non-equity-index families, note proxy-basis-risk if either side relied heavily on the underlying ETF.
- Never recommend taking the trade (BULLISH/BEARISH at confidence ≥ 60) if a major scheduled catalyst falls within the timeframe AND the verdict ignored it.

Use the same JSON output schema the user prompt requests below.`
}

export function shouldUseFuturesPipeline(bundle: { instrumentType?: string }): boolean {
  return bundle.instrumentType === 'futures'
}
