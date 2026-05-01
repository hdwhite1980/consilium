// ═════════════════════════════════════════════════════════════
// app/lib/invest-skill-gates.ts
//
// Skill-based progression gates for the Invest tier system.
//
// The current tier system promotes purely on account value (Buyer→Builder
// at $50, etc). This module adds skill criteria on top: a user with $1,500
// in their account doesn't auto-graduate to Operator — they have to
// demonstrate the discipline that tier requires.
//
// USAGE
//   import { evaluateSkillGate } from '@/app/lib/invest-skill-gates'
//   const gate = evaluateSkillGate({ tierName, closedTrades, postmortems })
//   // gate.nextTierName, gate.skillReady, gate.requirements
//
// The displayed tier is still capital-based for now. The `skillGate` field
// tells the UI what skill bar blocks the next promotion. A future flip can
// switch to using the lower of (capital tier, skill tier).
// ═════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type TierName = 'Buyer' | 'Builder' | 'Operator' | 'Principal' | 'Sovereign'

/** Subset of fields we read from invest_trades. */
export interface SkillTrade {
  id: string
  entry_price: number
  exit_price: number | null
  shares: number
  stop_price: number | null
  target_price: number | null
  position_type?: 'stock' | 'option' | null
  exit_date?: string | null
  opened_at?: string | null
}

/** Subset of fields we read from invest_trade_postmortems. */
export interface SkillPostmortem {
  trade_id: string
  process_score: number  // 0-100
  grade: string          // 'A+'...'F'
  outcome: 'win' | 'loss' | 'breakeven'
  generated_at?: string
}

export interface SkillGateRequirement {
  /** Stable id for UI keying */
  id: string
  /** Human-readable label like "Close 8 trades" */
  label: string
  /** What they have right now (number, percent, or letter grade) */
  current: number | string
  /** What's needed */
  target: number | string
  /** Whether this requirement is satisfied */
  met: boolean
  /** 0-100 how far along they are (for progress bars) */
  progressPct: number
}

export interface SkillGateResult {
  /** The tier they're currently displayed as (capital-based for now). */
  currentTierName: TierName
  /** The next tier in line. Null at Sovereign. */
  nextTierName: TierName | null
  /** Did they hit the dollar threshold for nextTier? */
  capitalReady: boolean
  /** Are ALL skill requirements met? */
  skillReady: boolean
  /** The skill bars to clear to reach nextTier. */
  requirements: SkillGateRequirement[]
  /** Once they cross BOTH bars, the higher tier opens. Null until then. */
  readyToPromote: boolean
}

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────
//
// Each tier has a set of requirements to UNLOCK it. A user is "skill-ready"
// for tier X when they meet X's requirements while currently sitting at
// tier (X-1).
//
// Buyer is the entry tier — no skill gate. Everyone starts here.

interface TierGateConfig {
  /** Min closed trades. */
  minClosed: number
  /** Min average process score (0-100). 70 = B-, 75 = B, 80 = B+. */
  minAvgProcessScore: number
  /** Stop-discipline window: last N closed trades to look at. */
  stopWindowSize: number
  /** Of the last N, how many must have honored the stop. */
  stopWindowMin: number
  /** True if at least one closed-at-target win is required. */
  requireOneTargetHit?: boolean
}

const TIER_GATES: Record<TierName, TierGateConfig | null> = {
  Buyer: null,  // entry tier
  Builder: {
    minClosed: 3,
    minAvgProcessScore: 60,    // C+ — generous, just learning
    stopWindowSize: 3,
    stopWindowMin: 2,
  },
  Operator: {
    minClosed: 8,
    minAvgProcessScore: 70,    // B-
    stopWindowSize: 5,
    stopWindowMin: 4,
  },
  Principal: {
    minClosed: 15,
    minAvgProcessScore: 75,    // B
    stopWindowSize: 5,
    stopWindowMin: 5,           // perfect stop discipline in last 5
    requireOneTargetHit: true,
  },
  Sovereign: {
    minClosed: 30,
    minAvgProcessScore: 80,    // B+
    stopWindowSize: 10,
    stopWindowMin: 9,
    requireOneTargetHit: true,
  },
}

const TIER_ORDER: TierName[] = ['Buyer', 'Builder', 'Operator', 'Principal', 'Sovereign']

// ─────────────────────────────────────────────────────────────
// Helper: did the trade honor its stop?
// ─────────────────────────────────────────────────────────────
//
// "Honored the stop" means: if the user set a stop at entry, and the trade
// closed below it, they EXITED at or near the stop (within 5% slippage).
// If they let it run further than 5% below the stop, that's a violation.
//
// Special cases:
//   - No stop set → null (don't count this trade)
//   - Trade closed for a profit (exit > stop for long) → null (irrelevant)
//   - Option trades → null for now (premium dynamics differ; future work)

export function tradeHonoredStop(trade: SkillTrade): boolean | null {
  if (trade.exit_price == null) return null  // still open
  if (!trade.stop_price || trade.stop_price <= 0) return null  // no stop set
  if (trade.position_type === 'option') return null  // option logic deferred

  // For longs, stop is below entry. If exit > stop, the trade didn't hit
  // the stop — it was closed for some other reason (profit-take, target,
  // discretionary exit). Doesn't tell us anything about stop discipline.
  if (trade.exit_price > trade.stop_price) return null

  // Trade closed at or below stop. Did they honor it (close within 5% of
  // the stop) or let it run?
  const slippagePct = ((trade.stop_price - trade.exit_price) / trade.stop_price) * 100
  return slippagePct <= 5
}

// ─────────────────────────────────────────────────────────────
// Helper: did the trade hit its target?
// ─────────────────────────────────────────────────────────────

export function tradeHitTarget(trade: SkillTrade): boolean | null {
  if (trade.exit_price == null) return null
  if (!trade.target_price || trade.target_price <= 0) return null
  if (trade.position_type === 'option') return null

  // Target reached if exit met or exceeded target (within 2% slippage on
  // the gentle side).
  return trade.exit_price >= trade.target_price * 0.98
}

// ─────────────────────────────────────────────────────────────
// Helper: convert a 0-100 process score back to a letter grade
// ─────────────────────────────────────────────────────────────

export function scoreToLetter(score: number): string {
  if (score >= 95) return 'A+'
  if (score >= 90) return 'A'
  if (score >= 85) return 'A-'
  if (score >= 80) return 'B+'
  if (score >= 75) return 'B'
  if (score >= 70) return 'B-'
  if (score >= 65) return 'C+'
  if (score >= 60) return 'C'
  if (score >= 55) return 'C-'
  if (score >= 40) return 'D'
  return 'F'
}

// ─────────────────────────────────────────────────────────────
// Main entrypoint
// ─────────────────────────────────────────────────────────────

export function evaluateSkillGate(input: {
  currentTierName: TierName
  capitalReady: boolean       // does total value clear the next tier's dollar threshold
  closedTrades: SkillTrade[]  // all closed trades, any order
  postmortems: SkillPostmortem[]  // all postmortems for this user
}): SkillGateResult {
  const { currentTierName, capitalReady, closedTrades, postmortems } = input

  // Find the next tier
  const currentIdx = TIER_ORDER.indexOf(currentTierName)
  const nextIdx = currentIdx + 1
  const nextTierName: TierName | null = nextIdx < TIER_ORDER.length
    ? TIER_ORDER[nextIdx]
    : null

  // Sovereign or unknown — no further gate
  if (!nextTierName) {
    return {
      currentTierName,
      nextTierName: null,
      capitalReady: true,
      skillReady: true,
      requirements: [],
      readyToPromote: false,
    }
  }

  const gate = TIER_GATES[nextTierName]
  if (!gate) {
    // Shouldn't happen for tiers above Buyer, but be safe
    return {
      currentTierName,
      nextTierName,
      capitalReady,
      skillReady: true,
      requirements: [],
      readyToPromote: capitalReady,
    }
  }

  // Order trades newest-first by exit_date (or fall back to opened_at)
  const sortedClosed = [...closedTrades].sort((a, b) => {
    const ad = a.exit_date ?? a.opened_at ?? ''
    const bd = b.exit_date ?? b.opened_at ?? ''
    return bd.localeCompare(ad)
  })

  // Build a postmortem lookup by trade_id
  const pmByTrade = new Map<string, SkillPostmortem>()
  for (const pm of postmortems) {
    pmByTrade.set(pm.trade_id, pm)
  }

  // ── Requirement 1: minimum closed trades ──
  const closedCount = sortedClosed.length
  const closedReq: SkillGateRequirement = {
    id: 'closed_count',
    label: `Close ${gate.minClosed} trade${gate.minClosed === 1 ? '' : 's'}`,
    current: closedCount,
    target: gate.minClosed,
    met: closedCount >= gate.minClosed,
    progressPct: Math.min(100, Math.round((closedCount / gate.minClosed) * 100)),
  }

  // ── Requirement 2: average process score ──
  // Use the user's full postmortem history (not just last N) — we want to
  // reward sustained discipline, not just a recent hot streak.
  const scores = postmortems
    .map(p => p.process_score)
    .filter(s => typeof s === 'number' && s >= 0 && s <= 100)

  const avgScore = scores.length > 0
    ? scores.reduce((a, b) => a + b, 0) / scores.length
    : 0

  const minLetter = scoreToLetter(gate.minAvgProcessScore)
  const currentLetter = scores.length > 0 ? scoreToLetter(avgScore) : '—'

  const gradeReq: SkillGateRequirement = {
    id: 'avg_grade',
    label: `Maintain ${minLetter} average process grade`,
    current: currentLetter,
    target: minLetter,
    // Met only if we have postmortems AND average is at or above bar
    met: scores.length > 0 && avgScore >= gate.minAvgProcessScore,
    progressPct: scores.length === 0
      ? 0
      : Math.min(100, Math.round((avgScore / gate.minAvgProcessScore) * 100)),
  }

  // ── Requirement 3: stop discipline in window ──
  // Look at the most recent N closed trades that had a stop set, and count
  // how many honored it.
  const relevantForStops = sortedClosed
    .map(t => ({ trade: t, honored: tradeHonoredStop(t) }))
    .filter(x => x.honored !== null)  // only trades where stop discipline applies
    .slice(0, gate.stopWindowSize)

  const honoredCount = relevantForStops.filter(x => x.honored === true).length

  const stopReq: SkillGateRequirement = {
    id: 'stop_discipline',
    label: `Honor your stop in ${gate.stopWindowMin} of last ${gate.stopWindowSize}`,
    current: honoredCount,
    target: gate.stopWindowMin,
    // Need at least stopWindowSize trades that had stops AND honoredCount ≥ stopWindowMin
    met: relevantForStops.length >= gate.stopWindowSize
      && honoredCount >= gate.stopWindowMin,
    progressPct: gate.stopWindowMin === 0
      ? 100
      : Math.min(100, Math.round((honoredCount / gate.stopWindowMin) * 100)),
  }

  const requirements: SkillGateRequirement[] = [closedReq, gradeReq, stopReq]

  // ── Requirement 4: closed at target (Principal+) ──
  if (gate.requireOneTargetHit) {
    const targetHits = sortedClosed.filter(t => tradeHitTarget(t) === true).length
    requirements.push({
      id: 'target_hit',
      label: 'Close at least one trade at your target',
      current: targetHits,
      target: 1,
      met: targetHits >= 1,
      progressPct: targetHits >= 1 ? 100 : 0,
    })
  }

  const skillReady = requirements.every(r => r.met)

  return {
    currentTierName,
    nextTierName,
    capitalReady,
    skillReady,
    requirements,
    readyToPromote: capitalReady && skillReady,
  }
}

// ─────────────────────────────────────────────────────────────
// Test fixtures (exported for unit tests in the future)
// ─────────────────────────────────────────────────────────────

export const __TEST_TIER_GATES = TIER_GATES
export const __TEST_TIER_ORDER = TIER_ORDER
