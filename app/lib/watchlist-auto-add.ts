// ═════════════════════════════════════════════════════════════
// app/lib/watchlist-auto-add.ts
//
// Fire-and-forget helper for auto-adding tickers to a user's
// watchlist from OTHER endpoints:
//
//   - /api/analyze → after a verdict is saved, add to watchlist with source='analyze'
//   - /api/invest (open_trade) → add with source='invest'
//
// Uses upsert (ON CONFLICT DO NOTHING-style via onConflict) so
// repeated calls for the same ticker don't error — the user's
// existing entry stays put.
// ═════════════════════════════════════════════════════════════

import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export interface AutoAddParams {
  userId: string
  ticker: string
  source: 'analyze' | 'invest' | 'movers' | 'manual'
  verdictId?: number | null
  verdictSignal?: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null
  verdictConfidence?: number | null
  verdictAt?: string | null
}

/**
 * Fire-and-forget. Adds ticker to user's watchlist if not already there.
 * If already there, updates the denormalized latest_verdict_* fields
 * so the UI shows the most recent Council verdict.
 *
 * Never throws. Any error is logged and swallowed.
 */
export function autoAddToWatchlist(params: AutoAddParams): void {
  if (!params.userId || !params.ticker) return

  const ticker = params.ticker.toUpperCase().trim()
  if (!/^[A-Z0-9\-\.]{1,10}$/.test(ticker)) return

  void (async () => {
    try {
      const admin = getAdmin()
      const { error } = await admin
        .from('watchlist_entries')
        .upsert({
          user_id: params.userId,
          ticker,
          source: params.source,
          muted: false,
          latest_verdict_id: params.verdictId ?? null,
          latest_verdict_signal: params.verdictSignal ?? null,
          latest_verdict_confidence: params.verdictConfidence ?? null,
          latest_verdict_at: params.verdictAt ?? null,
        }, {
          onConflict: 'user_id,ticker',
          // If ticker exists, only update latest_verdict_* fields.
          // Preserve the user's muted flag, notes, and original source.
          ignoreDuplicates: false,
        })

      if (error) {
        console.warn(`[watchlist-auto-add] upsert failed for ${ticker}:`, error.message)
      } else {
        console.log(`[watchlist-auto-add] ${ticker} (source: ${params.source})`)
      }
    } catch (e) {
      console.warn('[watchlist-auto-add] fire-and-forget error:', (e as Error).message?.slice(0, 100))
    }
  })()
}
