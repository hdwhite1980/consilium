// ═════════════════════════════════════════════════════════════
// app/lib/council-candidates.ts
//
// Helper for inserting non-NEUTRAL verdicts from /api/analyze
// into council_candidates table. Called after verdict_log insert
// inside the analyze route.
//
// Fire-and-forget pattern so analyze response isn't blocked if
// the insert fails.
// ═════════════════════════════════════════════════════════════

import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export interface VerdictToCandidate {
  userId: string
  ticker: string
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: number
  verdictId: number | null
  entryPrice?: number | null
  stopLoss?: number | null
  takeProfit?: number | null
  timeHorizon?: string | null
  timeframe?: string | null
  persona?: string | null
}

/**
 * Auto-promote a verdict into council_candidates if it meets criteria:
 *   - Signal is BULLISH or BEARISH (not NEUTRAL)
 *   - Confidence >= 60%
 *
 * Fire-and-forget: doesn't block the caller or throw on error.
 */
export function promoteVerdictToCandidate(v: VerdictToCandidate): void {
  if (v.signal === 'NEUTRAL') return
  if (typeof v.confidence !== 'number' || v.confidence < 60) return
  if (!v.userId || !v.ticker) return

  void (async () => {
    try {
      const admin = getAdmin()
      const { error } = await admin.from('council_candidates').insert({
        user_id: v.userId,
        ticker: v.ticker.toUpperCase(),
        signal: v.signal,
        confidence: v.confidence,
        verdict_id: v.verdictId,
        entry_price: v.entryPrice ?? null,
        stop_loss: v.stopLoss ?? null,
        take_profit: v.takeProfit ?? null,
        time_horizon: v.timeHorizon ?? null,
        timeframe: v.timeframe ?? null,
        persona: v.persona ?? null,
      })
      if (error) {
        console.warn('[council-candidates] insert failed:', error.message)
      } else {
        console.log(`[council-candidates] promoted ${v.ticker} (${v.signal} ${v.confidence}%)`)
      }
    } catch (e) {
      console.warn('[council-candidates] fire-and-forget error:', (e as Error).message?.slice(0, 100))
    }
  })()
}

/**
 * Fetch active council candidates for a user (non-expired).
 * Used by the options scanner to include these tickers in its universe.
 */
export async function getActiveCouncilCandidates(userId: string, maxAgeDays = 14): Promise<Array<{
  ticker: string
  signal: 'BULLISH' | 'BEARISH'
  confidence: number
  latestVerdictAt: string
  verdictCount: number
}>> {
  try {
    const admin = getAdmin()
    const { data, error } = await admin
      .from('active_council_candidates')
      .select('ticker, signal, confidence, latest_verdict_at, verdict_count')
      .eq('user_id', userId)
      .order('latest_verdict_at', { ascending: false })
      .limit(50)

    if (error || !data) return []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data as any[]).map((r) => ({
      ticker: String(r.ticker ?? '').toUpperCase(),
      signal: r.signal as 'BULLISH' | 'BEARISH',
      confidence: Number(r.confidence ?? 0),
      latestVerdictAt: String(r.latest_verdict_at ?? ''),
      verdictCount: Number(r.verdict_count ?? 1),
    }))
  } catch {
    return []
  }
}
