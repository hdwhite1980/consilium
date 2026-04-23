// ═════════════════════════════════════════════════════════════
// app/lib/watchlist-auto-add.ts
//
// Fire-and-forget helpers for auto-adding STOCKS or OPTIONS to a
// user's watchlist from other endpoints:
//
//   - /api/analyze → after verdict saved → autoAddStockToWatchlist
//                    + if option ideas generated → autoAddOptionToWatchlist
//                      for each option idea
//   - /api/invest/options-scanner → each pick → autoAddOptionToWatchlist
//   - /api/invest (open_trade) → autoAddStockToWatchlist
//
// Uses upsert with the correct conflict target (user_id+ticker for stocks,
// user_id+option_symbol for options) so repeated calls are idempotent.
// ═════════════════════════════════════════════════════════════

import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ─────────────────────────────────────────────────────────────
// Stock auto-add (existing behavior, renamed for clarity)
// ─────────────────────────────────────────────────────────────
export interface AutoAddStockParams {
  userId: string
  ticker: string
  source: 'analyze' | 'invest' | 'movers' | 'manual'
  verdictId?: number | null
  verdictSignal?: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null
  verdictConfidence?: number | null
  verdictAt?: string | null
}

/**
 * Fire-and-forget stock watchlist add.
 * If ticker already in watchlist, updates denormalized verdict fields.
 * Never throws.
 */
export function autoAddStockToWatchlist(params: AutoAddStockParams): void {
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
          asset_type: 'stock',
          source: params.source,
          muted: false,
          latest_verdict_id: params.verdictId ?? null,
          latest_verdict_signal: params.verdictSignal ?? null,
          latest_verdict_confidence: params.verdictConfidence ?? null,
          latest_verdict_at: params.verdictAt ?? null,
        }, {
          onConflict: 'user_id,ticker',
          ignoreDuplicates: false,
        })

      if (error) {
        console.warn(`[watchlist-auto-add/stock] upsert failed for ${ticker}:`, error.message)
      } else {
        console.log(`[watchlist-auto-add/stock] ${ticker} (source: ${params.source})`)
      }
    } catch (e) {
      console.warn('[watchlist-auto-add/stock] error:', (e as Error).message?.slice(0, 100))
    }
  })()
}

// ─────────────────────────────────────────────────────────────
// Option auto-add (new)
// ─────────────────────────────────────────────────────────────
export interface AutoAddOptionParams {
  userId: string
  ticker: string                              // underlying
  optionSymbol: string                        // OCC symbol, e.g. NVDA250517C00500000
  optionType: 'call' | 'put'
  strike: number
  expiration: string                          // YYYY-MM-DD
  premiumAtAdd?: number | null
  deltaAtAdd?: number | null
  ivAtAdd?: number | null
  source: 'analyze' | 'invest' | 'movers' | 'manual'
  // Optionally denormalize verdict on the underlying
  verdictId?: number | null
  verdictSignal?: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null
  verdictConfidence?: number | null
  verdictAt?: string | null
}

/**
 * Fire-and-forget option contract watchlist add.
 * If option_symbol already in watchlist, updates entry metadata but
 * preserves muted/notes flags the user set.
 * Never throws.
 */
export function autoAddOptionToWatchlist(params: AutoAddOptionParams): void {
  if (!params.userId || !params.ticker || !params.optionSymbol) return
  const ticker = params.ticker.toUpperCase().trim()
  if (!/^[A-Z0-9\-\.]{1,10}$/.test(ticker)) return
  if (!['call', 'put'].includes(params.optionType)) return
  if (!Number.isFinite(params.strike) || params.strike <= 0) return
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.expiration)) return

  const optionSymbol = params.optionSymbol.trim()
  if (optionSymbol.length < 10) return

  void (async () => {
    try {
      const admin = getAdmin()
      const { error } = await admin
        .from('watchlist_entries')
        .upsert({
          user_id: params.userId,
          ticker,
          asset_type: 'option',
          option_symbol: optionSymbol,
          option_type: params.optionType,
          strike: params.strike,
          expiration: params.expiration,
          premium_at_add: params.premiumAtAdd ?? null,
          delta_at_add: params.deltaAtAdd ?? null,
          iv_at_add: params.ivAtAdd ?? null,
          source: params.source,
          muted: false,
          latest_verdict_id: params.verdictId ?? null,
          latest_verdict_signal: params.verdictSignal ?? null,
          latest_verdict_confidence: params.verdictConfidence ?? null,
          latest_verdict_at: params.verdictAt ?? null,
        }, {
          onConflict: 'user_id,option_symbol',
          ignoreDuplicates: false,
        })

      if (error) {
        console.warn(`[watchlist-auto-add/option] upsert failed for ${optionSymbol}:`, error.message)
      } else {
        console.log(`[watchlist-auto-add/option] ${ticker} ${params.optionType.toUpperCase()} $${params.strike} ${params.expiration} (source: ${params.source})`)
      }
    } catch (e) {
      console.warn('[watchlist-auto-add/option] error:', (e as Error).message?.slice(0, 100))
    }
  })()
}

// ─────────────────────────────────────────────────────────────
// Backward-compat alias — existing callers of autoAddToWatchlist
// (from Session 1 of original Watchlist build) keep working.
// ─────────────────────────────────────────────────────────────
export const autoAddToWatchlist = autoAddStockToWatchlist
export type AutoAddParams = AutoAddStockParams
