// =============================================================
// app/lib/trading/kill-switches.ts
//
// Pre-trade kill switch evaluation. Each check returns either
// { allowed: true } or { allowed: false, reason }. The worker
// runs ALL checks and halts the account on first failure.
//
// Implemented checks:
//   1. Master enabled flag
//   2. Halted flag
//   3. Account-level: equity > 0, account status ACTIVE
//   4. Max concurrent positions (Alpaca-side count)
//   5. Max daily realized loss (sum of today's closed orders)
//   6. Max consecutive losses (today's trade_attempts in order)
//   7. Already have an open position in this ticker (don't pyramid)
//
// "Halt" actions write halted=true + halt_reason to user_trading_settings.
// "Skip" actions just log to trade_attempts and continue.
// =============================================================

import type { UserTradingSettings } from './settings'
import type { AlpacaAccount, AlpacaPosition } from './alpaca-client'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'

export interface KillSwitchContext {
  settings: UserTradingSettings
  account: AlpacaAccount
  positions: AlpacaPosition[]
  ticker: string  // upper-case canonical
  /** Optional override for the max-concurrent check. When set (e.g. a grade A/B
   *  verdict eligible for bounded overflow), this ceiling replaces
   *  settings.maxConcurrentPos for check #4 only. The auto-trade route still
   *  enforces the cash-only funding gate on any slot past maxConcurrentPos. */
  concurrentCapOverride?: number
}

export type KillSwitchResult =
  | { allowed: true }
  | { allowed: false; reason: string; shouldHalt: boolean }

/**
 * Pre-trade evaluation. Returns first failure or { allowed: true }.
 * shouldHalt=true means write halted=true to settings; false means
 * just skip this verdict.
 */
export async function evaluateKillSwitches(ctx: KillSwitchContext): Promise<KillSwitchResult> {
  const { settings, account, positions, ticker } = ctx

  // 1. Master switches
  if (!settings.enabled) {
    return { allowed: false, reason: 'auto-trading disabled for user', shouldHalt: false }
  }
  if (settings.halted) {
    return { allowed: false, reason: `account halted: ${settings.haltReason ?? 'unknown'}`, shouldHalt: false }
  }

  // 2. Account health
  if (account.status !== 'ACTIVE') {
    return { allowed: false, reason: `Alpaca account status is ${account.status}, not ACTIVE`, shouldHalt: true }
  }
  if (account.equity <= 0) {
    return { allowed: false, reason: `account equity is ${account.equity}`, shouldHalt: true }
  }

  // 3. Already-open position in this ticker — don't pyramid
  if (positions.some(p => p.symbol.toUpperCase() === ticker.toUpperCase() && p.qty !== 0)) {
    return { allowed: false, reason: `already have an open position in ${ticker}`, shouldHalt: false }
  }

  // 4. Max concurrent positions (honors an optional overflow override — see
  //    KillSwitchContext.concurrentCapOverride. Funding for overflow slots is
  //    separately gated cash-only in the auto-trade route.)
  const concurrentCap = ctx.concurrentCapOverride ?? settings.maxConcurrentPos
  const activeCount = positions.filter(p => p.qty !== 0).length
  if (activeCount >= concurrentCap) {
    return {
      allowed: false,
      reason: `at max concurrent positions (${activeCount}/${concurrentCap})`,
      shouldHalt: false,
    }
  }

  // 5. Max daily realized loss
  const dailyPnl = await getTodayRealizedPnl(settings.userId)
  const dailyLossLimit = -account.equity * settings.maxDailyLossPct
  if (dailyPnl < dailyLossLimit) {
    return {
      allowed: false,
      reason: `daily loss ($${dailyPnl.toFixed(2)}) exceeds limit ($${dailyLossLimit.toFixed(2)})`,
      shouldHalt: true,
    }
  }

  // 6. Max consecutive losses
  const consecutiveLosses = await getConsecutiveLossesToday(settings.userId)
  if (consecutiveLosses >= settings.maxConsecLosses) {
    return {
      allowed: false,
      reason: `${consecutiveLosses} consecutive losses today (limit: ${settings.maxConsecLosses})`,
      shouldHalt: true,
    }
  }

  return { allowed: true }
}

// ─────────────────────────────────────────────────────────────
// Helpers — read trade_attempts for today's P&L state
// ─────────────────────────────────────────────────────────────

async function getTodayRealizedPnl(userId: string): Promise<number> {
  const admin = await getSupabaseAdmin()
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const { data, error } = await admin
    .from('trade_attempts')
    .select('realized_pnl, outcome')
    .eq('user_id', userId)
    .gte('created_at', today.toISOString())
    .in('outcome', ['closed_win', 'closed_loss', 'closed_be'])
  if (error || !data) return 0
  let sum = 0
  for (const r of data as Array<{ realized_pnl: number | string | null }>) {
    if (r.realized_pnl !== null && r.realized_pnl !== undefined) {
      sum += Number(r.realized_pnl)
    }
  }
  return sum
}

async function getConsecutiveLossesToday(userId: string): Promise<number> {
  const admin = await getSupabaseAdmin()
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const { data, error } = await admin
    .from('trade_attempts')
    .select('outcome, closed_at')
    .eq('user_id', userId)
    .gte('created_at', today.toISOString())
    .in('outcome', ['closed_win', 'closed_loss', 'closed_be'])
    .order('closed_at', { ascending: false })
    .limit(20)
  if (error || !data) return 0

  let streak = 0
  for (const row of data as Array<{ outcome: string }>) {
    if (row.outcome === 'closed_loss') streak++
    else if (row.outcome === 'closed_win') break
    // 'closed_be' (break-even) doesn't reset, doesn't extend
  }
  return streak
}

/**
 * Mark a user's account as halted with a reason. Used by the worker
 * after a kill switch fires with shouldHalt=true.
 */
export async function haltUserAccount(userId: string, reason: string): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin
    .from('user_trading_settings')
    .update({
      halted: true,
      halt_reason: reason.slice(0, 500),
      halted_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
  console.log(`[kill-switches] HALTED user=${userId} reason="${reason.slice(0, 100)}"`)
}
