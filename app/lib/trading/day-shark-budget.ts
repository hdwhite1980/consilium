// =============================================================
// app/lib/trading/day-shark-budget.ts
//
// Max's LIVE budget per asset class — the virtual partition made real.
//
// Brokers expose one cash pool, so Max's "sleeve" is enforced here: his deployed
// capital = the sum of his OPEN day_shark trade_attempts (qty × entry estimate).
// His available budget = sleeve − deployed. The executor refuses any new entry
// that would push him over, so Max can never spend the slow lane's cash.
//
// Lowering a slider therefore FREEZES Max (option A): existing positions stand,
// but available goes to ~0 until they close — no forced sells.
// =============================================================

import { createClient } from '@supabase/supabase-js'
import { computeSharkBudget, type SharkAsset, type SharkBudget } from './day-shark'
import type { UserTradingSettings } from './settings'

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// Outcomes that mean capital is currently committed to the market.
const OPEN_OUTCOMES = ['placed', 'filled', 'partial_fill']

/** Sum of Max's deployed capital (qty × entry estimate) for an asset class. */
export async function computeSharkDeployed(userId: string, asset: SharkAsset): Promise<number> {
  const db = admin()
  const { data, error } = await db
    .from('trade_attempts')
    .select('qty, entry_price_est')
    .eq('user_id', userId)
    .eq('asset_class', asset)
    .eq('signal_source', 'day_shark')
    .in('outcome', OPEN_OUTCOMES)
  if (error || !data) return 0
  return data.reduce(
    (sum, r) => sum + (Number(r.qty) || 0) * (Number(r.entry_price_est) || 0),
    0,
  )
}

/** Max's allocation slider (0..1) for a given asset class. */
export function allocationPctFor(settings: UserTradingSettings, asset: SharkAsset): number {
  const pct = asset === 'stock' ? settings.maxAllocStockPct
            : asset === 'crypto' ? settings.maxAllocCryptoPct
            : settings.maxAllocForexPct
  return Math.max(0, Math.min(1, pct || 0))
}

/** Max's live budget for an asset: sleeve = alloc% × equity, minus deployed. */
export async function getSharkBudget(
  settings: UserTradingSettings, asset: SharkAsset, accountEquity: number,
): Promise<SharkBudget> {
  const pct = allocationPctFor(settings, asset)
  const deployed = await computeSharkDeployed(settings.userId, asset)
  return computeSharkBudget(pct, accountEquity, deployed)
}

/** Convenience: is Max active at all for this asset (slider > 0)? */
export function sharkEnabledFor(settings: UserTradingSettings, asset: SharkAsset): boolean {
  return allocationPctFor(settings, asset) > 0
}
