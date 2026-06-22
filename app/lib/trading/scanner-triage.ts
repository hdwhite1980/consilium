// =============================================================
// app/lib/trading/scanner-triage.ts
//
// Pure scoring logic for the scanner-triage cron. Takes a scanner
// candidate plus context (recent verdicts, open positions, prior
// triage rows) and returns a decision: fire_now / wait / skip.
//
// No side effects, no DB calls. Caller fetches context and inserts
// the decision. Lets us unit-test this independently of the cron.
//
// Scoring philosophy:
//   - Start with the scanner's own composite score (it already
//     captures a lot of signal — technicals, RS vs SPY, news).
//   - Add bonuses for things that make the candidate more
//     Council-worthy (momentum setup, fresh news catalyst, liquid).
//   - Subtract penalties for things that make it less worthy
//     (illiquid, bearish on stocks — we don't short).
//   - Hard-skip if there's a reason to never fire (recent verdict
//     on same ticker, open position, very low base score).
// =============================================================

import type { EnrichedScore } from '@/app/lib/scanner-engine'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type TriageDecision = 'fire_now' | 'wait' | 'skip'

export interface TriageContext {
  /** Verdict_log rows for this ticker in last N hours (we look at last 12h). */
  recentVerdicts: Array<{
    id: number
    trader_decision: string | null
    created_at: string
  }>
  /** Whether the user has an open trade_attempt (placed/filled/partial) for this ticker. */
  hasOpenPosition: boolean
  /** Whether there's a prior scanner_triage row marked fire_now in the last 60min that isn't fired yet. */
  hasPendingFireNow: boolean
  /** Optional: user's minimum share price floor (if set). */
  minSharePrice?: number | null
}

export interface TriageResult {
  decision: TriageDecision
  score: number | null         // null when hard-skip
  reason: string                 // human-readable summary
  rulesFired: string[]           // tags for debugging
  hardSkip: boolean              // true when one of the hard-skip rules fired
}

// ─────────────────────────────────────────────────────────────
// Thresholds — tunable
// ─────────────────────────────────────────────────────────────

const FIRE_NOW_THRESHOLD = 70
const WAIT_THRESHOLD = 40
// Below WAIT_THRESHOLD → skip

const RECENT_VERDICT_HOURS = 12

// ─────────────────────────────────────────────────────────────
// Main scoring function
// ─────────────────────────────────────────────────────────────

export function scoreCandidate(
  pick: EnrichedScore,
  context: TriageContext,
): TriageResult {
  const rules: string[] = []

  // ────────────────────────────────────────────────────────────
  // Hard skips — these short-circuit before any scoring
  // ────────────────────────────────────────────────────────────

  if (context.hasOpenPosition) {
    return {
      decision: 'skip',
      score: null,
      reason: `Already have open position in ${pick.ticker}`,
      rulesFired: ['hard_skip_open_position'],
      hardSkip: true,
    }
  }

  if (context.hasPendingFireNow) {
    return {
      decision: 'skip',
      score: null,
      reason: `Already triaged ${pick.ticker} as fire_now in last 60min, not yet fired`,
      rulesFired: ['hard_skip_pending_fire_now'],
      hardSkip: true,
    }
  }

  // Look for recent verdict — only short-circuit if it was actionable
  // (TAKE/WAIT). PASS verdicts mean Council saw it and rejected, so
  // re-firing soon would just produce another PASS. Same with TAKE
  // (already in the pipeline). WAIT means we explicitly said "revisit
  // later" — but more than 12h later, not 1h later.
  const recentBlockingVerdict = context.recentVerdicts.find(v => {
    const ageH = (Date.now() - new Date(v.created_at).getTime()) / 3_600_000
    return ageH < RECENT_VERDICT_HOURS && v.trader_decision !== null
  })
  if (recentBlockingVerdict) {
    return {
      decision: 'skip',
      score: null,
      reason: `Recent verdict ${recentBlockingVerdict.id} (${recentBlockingVerdict.trader_decision}) for ${pick.ticker} within ${RECENT_VERDICT_HOURS}h`,
      rulesFired: ['hard_skip_recent_verdict'],
      hardSkip: true,
    }
  }

  // ────────────────────────────────────────────────────────────
  // Base score = scanner's composite (with news if available)
  // ────────────────────────────────────────────────────────────

  // Prefer compositeWithNews when present (it's compositeScore with the
  // news exposure overlay already applied). Fall back to compositeScore.
  const baseScore = pick.compositeWithNews ?? pick.compositeScore ?? 0
  if (!Number.isFinite(baseScore) || baseScore <= 0) {
    return {
      decision: 'skip',
      score: 0,
      reason: `${pick.ticker}: scanner produced no usable composite score`,
      rulesFired: ['no_base_score'],
      hardSkip: false,
    }
  }

  let score = baseScore
  rules.push(`base_composite:${baseScore.toFixed(1)}`)

  // ────────────────────────────────────────────────────────────
  // Bonuses
  // ────────────────────────────────────────────────────────────

  // Strong momentum setup — the fast-mover scanner identified this as
  // a high-quality active mover or coiled spring.
  if (typeof pick.momentumScore === 'number' && pick.momentumScore >= 70) {
    score += 10
    rules.push('bonus_momentum_strong:+10')
  } else if (typeof pick.momentumScore === 'number' && pick.momentumScore >= 50) {
    score += 5
    rules.push('bonus_momentum_decent:+5')
  }

  // News catalyst — direct news on this ticker is the strongest signal
  if (pick.newsMatchType === 'direct') {
    score += 10
    rules.push('bonus_news_direct:+10')
  } else if (pick.newsMatchType === 'sector') {
    score += 5
    rules.push('bonus_news_sector:+5')
  } else if (pick.newsMatchType === 'digest') {
    score += 3
    rules.push('bonus_news_digest:+3')
  }

  // Liquidity — these stack. Very-liquid stocks (200M+/day) get +10 total.
  const dv = pick.dollarVolumeAvg ?? 0
  if (dv >= 50_000_000) {
    score += 5
    rules.push('bonus_liquid_50m:+5')
  }
  if (dv >= 200_000_000) {
    score += 5
    rules.push('bonus_liquid_200m:+5')
  }

  // ────────────────────────────────────────────────────────────
  // Penalties
  // ────────────────────────────────────────────────────────────

  // Illiquid — too thin to trade reliably
  if (dv > 0 && dv < 5_000_000) {
    score -= 15
    rules.push('penalty_illiquid:-15')
  }

  // Bearish on stocks — we don't short in v1 (no margin/locate flow).
  // A bearish stock pick will result in a Council verdict that we
  // skip at the auto-trader level. Defer it for now to save Council cost.
  if (pick.direction === 'bearish') {
    score -= 20
    rules.push('penalty_bearish_stock:-20')
  }

  // NOTE: TickerScore.direction is typed 'bullish' | 'bearish' only —
  // no 'unclear' state exists at this layer. Momentum scoring has its
  // own 'unclear' state but it gets resolved to one of bullish/bearish
  // (or left at the scoreTicker default) before reaching EnrichedScore.

  // ────────────────────────────────────────────────────────────
  // Final decision
  // ────────────────────────────────────────────────────────────

  // Clamp to a reasonable range for display
  const finalScore = Math.round(score * 10) / 10

  let decision: TriageDecision
  let summary: string
  if (finalScore >= FIRE_NOW_THRESHOLD) {
    decision = 'fire_now'
    summary = `Score ${finalScore} ≥ ${FIRE_NOW_THRESHOLD} → fire_now`
  } else if (finalScore >= WAIT_THRESHOLD) {
    decision = 'wait'
    summary = `Score ${finalScore} in [${WAIT_THRESHOLD}, ${FIRE_NOW_THRESHOLD}) → wait`
  } else {
    decision = 'skip'
    summary = `Score ${finalScore} < ${WAIT_THRESHOLD} → skip`
  }

  return {
    decision,
    score: finalScore,
    reason: `${pick.ticker}: ${summary} (${rules.length} rules)`,
    rulesFired: rules,
    hardSkip: false,
  }
}

// ─────────────────────────────────────────────────────────────
// Helper: rank fire_now decisions and cap to top N
// ─────────────────────────────────────────────────────────────
//
// When many candidates score above FIRE_NOW_THRESHOLD, we still don't
// want to fire all of them — Council cost adds up. Cap at top N by
// score, downgrade the rest to 'wait'.

export interface CappedResult {
  ticker: string
  result: TriageResult
}

export function capFireNow(
  results: Array<{ ticker: string; pick: EnrichedScore; result: TriageResult }>,
  maxFireNow: number,
): CappedResult[] {
  const fireNows = results
    .filter(r => r.result.decision === 'fire_now')
    .sort((a, b) => (b.result.score ?? 0) - (a.result.score ?? 0))

  // Mark anything past the cap as 'wait' (downgrade, not skip — we
  // might fire it next run if it stays elevated)
  const keptFireNow = new Set(fireNows.slice(0, maxFireNow).map(r => r.ticker))

  return results.map(r => {
    if (r.result.decision !== 'fire_now' || keptFireNow.has(r.ticker)) {
      return { ticker: r.ticker, result: r.result }
    }
    // Downgrade
    return {
      ticker: r.ticker,
      result: {
        ...r.result,
        decision: 'wait' as const,
        reason: `${r.result.reason} [downgraded: capped at top ${maxFireNow} fire_now]`,
        rulesFired: [...r.result.rulesFired, 'downgraded_fire_now_cap'],
      },
    }
  })
}
