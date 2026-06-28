// =============================================================
// app/lib/trading/quality-multiplier.ts
//
// Setup-quality → position-size multiplier, shared by every sizer (stock,
// crypto, forex) and by small-account sizing. Extracted into its own module so
// small-account-sizing.ts and sizing.ts can both use it without an import cycle.
//
// The grade/confidence/R:R come from the Trader's verdict — i.e. the council's
// synthesis of the indicators and patterns — so this is how "strength" scales
// risk: A-grade × high-confidence × high-R:R → 1.5×, marginal C-grade → 0.25×.
// =============================================================

export function computeQualityMultiplier(args: {
  grade: 'A' | 'B' | 'C' | null | undefined
  confidence: number | null | undefined
  riskReward: number | null | undefined
}): { multiplier: number; rationale: string } | null {
  const { grade, confidence, riskReward } = args
  if (!grade || confidence === null || confidence === undefined ||
      riskReward === null || riskReward === undefined) {
    return null
  }
  if (!Number.isFinite(confidence) || !Number.isFinite(riskReward)) {
    return null
  }

  const gradeMult = grade === 'A' ? 1.0
                  : grade === 'B' ? 0.75
                  : 0.5

  const confMult = confidence >= 80 ? 1.0
                 : confidence >= 70 ? 0.85
                 : confidence >= 60 ? 0.70
                 : 0.55

  const rrMult = riskReward >= 3.0 ? 1.2
               : riskReward >= 2.0 ? 1.0
               : riskReward >= 1.5 ? 0.75
               : 0.5

  const raw = gradeMult * confMult * rrMult
  const multiplier = Math.max(0.25, Math.min(1.5, raw))

  return {
    multiplier,
    rationale: `quality ${multiplier.toFixed(2)}x (grade=${grade}:${gradeMult}, conf=${confidence}%:${confMult}, R:R=${riskReward.toFixed(1)}:${rrMult.toFixed(2)})`,
  }
}
