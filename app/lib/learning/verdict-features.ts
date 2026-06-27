// =============================================================
// app/lib/learning/verdict-features.ts
//
// Stable, methodology-locked feature snapshot extracted from a SignalBundle.
// Dormant infrastructure — the substrate both calibration and RAG sit on.
// Defensive by design: bundles vary (crypto has no fundamentals/options), so
// every field is optional and extraction NEVER throws.
// =============================================================

export interface VerdictFeatures {
  rsi: number | null
  priceVsSma50: number | null      // % vs 50-day SMA
  macdSign: number | null          // -1 | 0 | 1
  emaCross: number | null          // -1 bearish | 0 none | 1 bullish
  convergenceScore: number | null  // -100..100 (conviction engine)
  convictionPct: number | null     // 0..100
  instOwnershipPct: number | null  // % float held by institutions (13F)
  instNetChange: number | null     // -1 decreasing | 0 stable | 1 increasing
  putCallRatio: number | null
}

const num = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? x : null
const signOf = (x: unknown): number | null => {
  const n = num(x); return n == null ? null : Math.sign(n)
}
const code = (s: unknown, up: string, down: string): number | null =>
  s === up ? 1 : s === down ? -1 : s == null ? null : 0

export function extractVerdictFeatures(bundle: unknown): VerdictFeatures {
  const b = (bundle ?? {}) as Record<string, any>
  const t = b.technicals ?? {}
  const c = b.conviction ?? {}
  const sm = b.smartMoney ?? {}
  const opt = b.optionsFlow ?? b.options ?? {}
  return {
    rsi: num(t.rsi),
    priceVsSma50: num(t.priceVsSma50),
    macdSign: signOf(t.macdLine),
    emaCross: code(t.ema9CrossEma20, 'bullish', 'bearish'),
    convergenceScore: num(c.convergenceScore),
    convictionPct: num(c.confidencePct),
    instOwnershipPct: num(sm.totalInstitutionalPct),
    instNetChange: code(sm.institutionalNetChange, 'increasing', 'decreasing'),
    putCallRatio: num(opt.putCallRatio ?? opt.pcRatio),
  }
}

// Per-feature normalization scales (typical spread) for closeness scoring.
const SCALES: Record<keyof VerdictFeatures, number> = {
  rsi: 40, priceVsSma50: 15, macdSign: 2, emaCross: 2,
  convergenceScore: 120, convictionPct: 50, instOwnershipPct: 40,
  instNetChange: 2, putCallRatio: 1.2,
}

// 0..1 similarity over features present in BOTH snapshots; null if no overlap.
export function featureSimilarity(a: VerdictFeatures | null, b: VerdictFeatures | null): number | null {
  if (!a || !b) return null
  let sum = 0, n = 0
  for (const k of Object.keys(SCALES) as (keyof VerdictFeatures)[]) {
    const av = a[k], bv = b[k]
    if (av == null || bv == null) continue
    sum += Math.max(0, 1 - Math.abs(av - bv) / SCALES[k])
    n++
  }
  return n === 0 ? null : sum / n
}
