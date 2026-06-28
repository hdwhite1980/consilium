// =============================================================
// app/lib/learning/council-rag.ts
//
// C-engine: the ACTIVATION layer. Turns the dormant verdict-memory store into a
// historical base-rate block injected into the Lead Analyst's evidence.
//
// THREE-MODE master switch (system_flags.council_rag_mode):
//   'off'  (default) — never inject. Council behaves exactly as before.
//   'auto'           — inject only once the resolved pool clears MIN_RESOLVED.
//   'on'              — inject whenever enough similar neighbors exist (manual override).
//
// SAFETY FLOORS (apply in EVERY mode, so a premature flip can't inject noise):
//   - need >= MIN_NEIGHBORS resolved neighbors above SIM_FLOOR similarity, else ''.
//   - signal-agnostic + advisory wording so the Lead can't blindly anchor.
//   - NEVER throws — any failure returns '' and the Council runs untouched.
// =============================================================

import { createClient } from '@supabase/supabase-js'
import { getFlag } from './flags'
import { extractVerdictFeatures } from './verdict-features'
import { loadResolvedMemory, scoreSimilarity, type Horizon, type MemoryRow, type RetrievalQuery } from './verdict-memory'

const FLAG_KEY = 'council_rag_mode'
const MIN_RESOLVED_FOR_AUTO = Number(process.env.COUNCIL_RAG_MIN_RESOLVED ?? '120')
const MIN_NEIGHBORS = Number(process.env.COUNCIL_RAG_MIN_NEIGHBORS ?? '5')
const SIM_FLOOR = Number(process.env.COUNCIL_RAG_SIM_FLOOR ?? '0.5')
const K = 8

/* eslint-disable @typescript-eslint/no-explicit-any */
function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// Did price actually rise after this verdict? Derived from (signal, directional outcome):
// a BULLISH 'win' = up, a BEARISH 'win' = down, etc.
function priceRose(row: MemoryRow): boolean | null {
  if (row.outcomeDirectional !== 'win' && row.outcomeDirectional !== 'loss') return null
  const up = row.signal === 'BULLISH'
  return row.outcomeDirectional === 'win' ? up : !up
}

export interface RagReadiness {
  mode: string
  resolvedCount: number
  minResolvedForAuto: number
  active: boolean        // would the gate allow injection right now?
  reason: string
}

export async function ragReadiness(horizon: Horizon = '1m'): Promise<RagReadiness> {
  const mode = (await getFlag(FLAG_KEY, 'off')).toLowerCase()
  const pool = await loadResolvedMemory(admin(), horizon)
  const resolvedCount = pool.length
  let active = false, reason = ''
  if (mode === 'off') reason = 'mode=off — dormant'
  else if (mode === 'on') { active = true; reason = 'mode=on (forced; per-query neighbor floor still applies)' }
  else if (mode === 'auto') {
    active = resolvedCount >= MIN_RESOLVED_FOR_AUTO
    reason = `mode=auto — ${active ? 'threshold met' : 'below threshold'} (${resolvedCount}/${MIN_RESOLVED_FOR_AUTO} resolved)`
  } else reason = `unknown mode '${mode}' — treated as off`
  return { mode, resolvedCount, minResolvedForAuto: MIN_RESOLVED_FOR_AUTO, active, reason }
}

// Build the Lead-evidence RAG block, or '' when dormant / not ready / too few neighbors.
export async function buildRagContext(
  bundle: unknown, opts?: { horizon?: Horizon; timeframe?: string | null },
): Promise<string> {
  try {
    const horizon = opts?.horizon ?? '1m'
    const mode = (await getFlag(FLAG_KEY, 'off')).toLowerCase()
    if (mode !== 'auto' && mode !== 'on') return ''     // off / unknown → dormant

    const db = admin()
    const pool = await loadResolvedMemory(db, horizon)   // signal-agnostic (Lead hasn't called direction yet)
    if (mode === 'auto' && pool.length < MIN_RESOLVED_FOR_AUTO) return ''

    const query: RetrievalQuery = {
      timeframe: opts?.timeframe ?? null,
      features: extractVerdictFeatures(bundle),
    }
    const neighbors = pool
      .map(row => ({ row, similarity: scoreSimilarity(query, row) }))
      .filter(s => s.similarity >= SIM_FLOOR)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, K)
    if (neighbors.length < MIN_NEIGHBORS) return ''

    const rose = neighbors.map(s => priceRose(s.row)).filter((v): v is boolean => v != null)
    if (rose.length < MIN_NEIGHBORS) return ''
    const upPct = Math.round((rose.filter(Boolean).length / rose.length) * 100)

    return [
      'HISTORICAL BASE RATE (advisory, not directive):',
      `Across the ${rose.length} most structurally-similar PAST setups that have since resolved, price rose over the following ${horizon} in ${upPct}% of them.`,
      'This is a base rate from resolved track-record data, NOT a prediction for this ticker. Weigh it against the live evidence above; do not let it override your own read.',
    ].join('\n')
  } catch {
    return ''   // any failure → Council runs exactly as before
  }
}
