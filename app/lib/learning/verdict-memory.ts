// =============================================================
// app/lib/learning/verdict-memory.ts
//
// The dormant memory/retrieval layer over resolved verdicts. `verdict_log` IS
// the store — resolved rows, enriched with a feature snapshot, are the memory.
//
//   retrieveSimilarVerdicts(query) -> K most-similar resolved verdicts + how they
//                                     resolved. This is what RAG WILL inject into
//                                     the Council prompt later (NOT wired yet).
//   computeCalibration(rows)       -> confidence band vs realized win rate (Phase D).
//
// Similarity is transparent and auditable on purpose — it fits the methodology-
// locked / honesty story. No embeddings; a weighted closeness over named features.
// =============================================================

import { featureSimilarity, type VerdictFeatures } from './verdict-features'

export type Horizon = '1d' | '1w' | '1m'

export interface MemoryRow {
  id: number
  ticker: string
  signal: string
  confidence: number | null
  timeframe: string | null
  source: string | null
  traderGrade: string | null
  riskReward: number | null
  features: VerdictFeatures | null
  outcomeDirectional: string | null    // 'win' | 'loss'
  outcomeStrict: string | null
  verdictDate: string
}

export interface RetrievalQuery {
  signal?: string                // omit for signal-agnostic (Lead-time) retrieval
  confidence?: number | null
  timeframe?: string | null
  source?: string | null
  traderGrade?: string | null
  riskReward?: number | null
  features?: VerdictFeatures | null
}

const DIR_COL: Record<Horizon, string> = { '1d': 'outcome_1d_directional', '1w': 'outcome_1w_directional', '1m': 'outcome_1m_directional' }
const STR_COL: Record<Horizon, string> = { '1d': 'outcome_1d_strict', '1w': 'outcome_1w_strict', '1m': 'outcome_1m_strict' }

/* eslint-disable @typescript-eslint/no-explicit-any */

// Load RESOLVED verdicts (directional outcome decided) for a horizon / direction.
export async function loadResolvedMemory(
  admin: any, horizon: Horizon, signal?: string, limit = 2000,
): Promise<MemoryRow[]> {
  const dir = DIR_COL[horizon], str = STR_COL[horizon]
  let q = admin.from('verdict_log')
    .select(`id, ticker, signal, confidence, timeframe, source, trader_grade, trader_risk_reward, features, verdict_date, ${dir}, ${str}`)
    .in(dir, ['win', 'loss'])
    .order('verdict_date', { ascending: false })
    .limit(limit)
  if (signal) q = q.eq('signal', signal)
  const { data, error } = await q
  if (error || !data) return []
  return (data as any[]).map(r => ({
    id: r.id, ticker: r.ticker, signal: r.signal,
    confidence: r.confidence ?? null, timeframe: r.timeframe ?? null, source: r.source ?? null,
    traderGrade: r.trader_grade ?? null, riskReward: r.trader_risk_reward ?? null,
    features: (r.features ?? null) as VerdictFeatures | null,
    outcomeDirectional: r[dir] ?? null, outcomeStrict: r[str] ?? null,
    verdictDate: r.verdict_date,
  }))
}

// Transparent similarity: categorical agreement + numeric closeness + (when both
// present) bundle feature similarity. Weights are explicit and auditable.
export function scoreSimilarity(query: RetrievalQuery, row: MemoryRow): number {
  let sum = 0, w = 0
  const add = (s: number | null, weight: number) => { if (s != null) { sum += s * weight; w += weight } }
  const eq = (a: unknown, b: unknown): number | null => (a == null || b == null) ? null : (a === b ? 1 : 0)
  const close = (a?: number | null, b?: number | null, scale = 1): number | null =>
    (a == null || b == null) ? null : Math.max(0, 1 - Math.abs(a - b) / scale)

  add(eq(query.timeframe, row.timeframe), 1)
  add(eq(query.source, row.source), 0.5)
  add(eq(query.traderGrade, row.traderGrade), 0.5)
  add(close(query.confidence, row.confidence, 40), 1)
  add(close(query.riskReward, row.riskReward, 2), 0.75)
  add(featureSimilarity(query.features ?? null, row.features ?? null), 2)   // heaviest when available

  return w === 0 ? 0 : sum / w
}

export interface RetrievalResult {
  k: number
  sampleSize: number             // resolved pool considered (same direction)
  favorableRate: number | null   // % of K neighbors whose directional outcome was 'win'
  neighbors: Array<{
    ticker: string; verdictDate: string; similarity: number
    outcomeDirectional: string | null; outcomeStrict: string | null; source: string | null
  }>
}

export async function retrieveSimilarVerdicts(
  admin: any, query: RetrievalQuery, opts?: { k?: number; horizon?: Horizon },
): Promise<RetrievalResult> {
  const k = opts?.k ?? 10
  const horizon = opts?.horizon ?? '1w'
  const pool = await loadResolvedMemory(admin, horizon, query.signal)
  const scored = pool
    .map(row => ({ row, similarity: scoreSimilarity(query, row) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k)
  const wins = scored.filter(s => s.row.outcomeDirectional === 'win').length
  return {
    k: scored.length,
    sampleSize: pool.length,
    favorableRate: scored.length ? Math.round((wins / scored.length) * 1000) / 10 : null,
    neighbors: scored.map(s => ({
      ticker: s.row.ticker, verdictDate: s.row.verdictDate,
      similarity: Math.round(s.similarity * 1000) / 1000,
      outcomeDirectional: s.row.outcomeDirectional, outcomeStrict: s.row.outcomeStrict, source: s.row.source,
    })),
  }
}

// Phase D: confidence band vs realized directional win rate (the calibration curve).
export function computeCalibration(rows: MemoryRow[]): Array<{ band: string; n: number; winRate: number | null }> {
  const bands = [
    { band: '80+', lo: 80, hi: 101 },
    { band: '65-79', lo: 65, hi: 80 },
    { band: '50-64', lo: 50, hi: 65 },
    { band: '<50', lo: -1, hi: 50 },
  ]
  return bands.map(b => {
    const subset = rows.filter(r => r.confidence != null && r.confidence >= b.lo && r.confidence < b.hi)
    const wins = subset.filter(r => r.outcomeDirectional === 'win').length
    return { band: b.band, n: subset.length, winRate: subset.length ? Math.round((wins / subset.length) * 1000) / 10 : null }
  })
}
