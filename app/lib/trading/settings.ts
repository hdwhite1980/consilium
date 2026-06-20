// =============================================================
// app/lib/trading/settings.ts
//
// Server-side helpers for reading/writing user_trading_settings.
//
// Updated in Commit 2 to include:
//   - minGrade: per-user grade floor (A/B/C)
//   - lastProcessedVerdictId: worker watermark for idempotency
// =============================================================

import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'

export interface UserTradingSettings {
  id: string
  userId: string

  // Master switches
  enabled: boolean
  mode: 'paper' | 'live'
  halted: boolean
  haltReason: string | null
  haltedAt: string | null

  // Broker
  broker: 'alpaca'

  // Risk sizing
  riskPerTradePct: number
  maxPositionPct: number

  // Kill switches
  maxDailyLossPct: number
  maxConcurrentPos: number
  maxConsecLosses: number

  // Asset filters
  tradeStocks: boolean
  tradeCrypto: boolean
  tradeOptions: boolean
  tradeForex: boolean

  // Commit 2 additions
  minGrade: 'A' | 'B' | 'C'
  lastProcessedVerdictId: number | null

  createdAt: string
  updatedAt: string
}

export const DEFAULT_TRADING_SETTINGS: Omit<UserTradingSettings, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'haltedAt' | 'haltReason'> = {
  enabled: false,
  mode: 'paper',
  halted: false,
  broker: 'alpaca',
  riskPerTradePct: 0.0100,
  maxPositionPct: 0.1500,
  maxDailyLossPct: 0.0300,
  maxConcurrentPos: 5,
  maxConsecLosses: 3,
  tradeStocks: true,
  tradeCrypto: false,
  tradeOptions: false,
  tradeForex: false,
  minGrade: 'B',
  lastProcessedVerdictId: null,
}

interface DbRow {
  id: string
  user_id: string
  enabled: boolean
  mode: string
  halted: boolean
  halt_reason: string | null
  halted_at: string | null
  broker: string
  risk_per_trade_pct: string | number
  max_position_pct: string | number
  max_daily_loss_pct: string | number
  max_concurrent_pos: number
  max_consec_losses: number
  trade_stocks: boolean
  trade_crypto: boolean
  trade_options: boolean
  trade_forex: boolean
  min_grade: string | null
  last_processed_verdict_id: number | string | null
  created_at: string
  updated_at: string
}

function rowToSettings(row: DbRow): UserTradingSettings {
  return {
    id: row.id,
    userId: row.user_id,
    enabled: row.enabled,
    mode: row.mode as 'paper' | 'live',
    halted: row.halted,
    haltReason: row.halt_reason,
    haltedAt: row.halted_at,
    broker: row.broker as 'alpaca',
    riskPerTradePct: Number(row.risk_per_trade_pct),
    maxPositionPct: Number(row.max_position_pct),
    maxDailyLossPct: Number(row.max_daily_loss_pct),
    maxConcurrentPos: row.max_concurrent_pos,
    maxConsecLosses: row.max_consec_losses,
    tradeStocks: row.trade_stocks,
    tradeCrypto: row.trade_crypto,
    tradeOptions: row.trade_options,
    tradeForex: row.trade_forex,
    minGrade: (row.min_grade ?? 'B') as 'A' | 'B' | 'C',
    lastProcessedVerdictId: row.last_processed_verdict_id !== null && row.last_processed_verdict_id !== undefined
      ? Number(row.last_processed_verdict_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function loadUserTradingSettings(userId: string): Promise<UserTradingSettings | null> {
  const admin = await getSupabaseAdmin()
  const { data, error } = await admin
    .from('user_trading_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`loadUserTradingSettings failed: ${error.message}`)
  if (!data) return null
  return rowToSettings(data as DbRow)
}

export async function upsertUserTradingSettings(
  userId: string,
  patch: Partial<UserTradingSettings>,
): Promise<UserTradingSettings> {
  const admin = await getSupabaseAdmin()
  const existing = await loadUserTradingSettings(userId)

  if (existing) {
    const dbPatch: Record<string, unknown> = {}
    if (patch.enabled !== undefined)               dbPatch.enabled = patch.enabled
    if (patch.mode !== undefined)                  dbPatch.mode = patch.mode
    if (patch.halted !== undefined)                dbPatch.halted = patch.halted
    if (patch.haltReason !== undefined)            dbPatch.halt_reason = patch.haltReason
    if (patch.haltedAt !== undefined)              dbPatch.halted_at = patch.haltedAt
    if (patch.broker !== undefined)                dbPatch.broker = patch.broker
    if (patch.riskPerTradePct !== undefined)       dbPatch.risk_per_trade_pct = patch.riskPerTradePct
    if (patch.maxPositionPct !== undefined)        dbPatch.max_position_pct = patch.maxPositionPct
    if (patch.maxDailyLossPct !== undefined)       dbPatch.max_daily_loss_pct = patch.maxDailyLossPct
    if (patch.maxConcurrentPos !== undefined)      dbPatch.max_concurrent_pos = patch.maxConcurrentPos
    if (patch.maxConsecLosses !== undefined)       dbPatch.max_consec_losses = patch.maxConsecLosses
    if (patch.tradeStocks !== undefined)           dbPatch.trade_stocks = patch.tradeStocks
    if (patch.tradeCrypto !== undefined)           dbPatch.trade_crypto = patch.tradeCrypto
    if (patch.tradeOptions !== undefined)          dbPatch.trade_options = patch.tradeOptions
    if (patch.tradeForex !== undefined)            dbPatch.trade_forex = patch.tradeForex
    if (patch.minGrade !== undefined)              dbPatch.min_grade = patch.minGrade
    if (patch.lastProcessedVerdictId !== undefined) dbPatch.last_processed_verdict_id = patch.lastProcessedVerdictId

    if (Object.keys(dbPatch).length === 0) return existing
    const { data, error } = await admin
      .from('user_trading_settings')
      .update(dbPatch)
      .eq('id', existing.id)
      .select('*')
      .single()
    if (error) throw new Error(`upsertUserTradingSettings update failed: ${error.message}`)
    return rowToSettings(data as DbRow)
  }

  const merged = { ...DEFAULT_TRADING_SETTINGS, ...patch }
  const { data, error } = await admin
    .from('user_trading_settings')
    .insert({
      user_id: userId,
      enabled: merged.enabled,
      mode: merged.mode,
      halted: merged.halted,
      halt_reason: merged.haltReason ?? null,
      halted_at: merged.haltedAt ?? null,
      broker: merged.broker,
      risk_per_trade_pct: merged.riskPerTradePct,
      max_position_pct: merged.maxPositionPct,
      max_daily_loss_pct: merged.maxDailyLossPct,
      max_concurrent_pos: merged.maxConcurrentPos,
      max_consec_losses: merged.maxConsecLosses,
      trade_stocks: merged.tradeStocks,
      trade_crypto: merged.tradeCrypto,
      trade_options: merged.tradeOptions,
      trade_forex: merged.tradeForex,
      min_grade: merged.minGrade,
      last_processed_verdict_id: merged.lastProcessedVerdictId,
    })
    .select('*')
    .single()
  if (error) throw new Error(`upsertUserTradingSettings insert failed: ${error.message}`)
  return rowToSettings(data as DbRow)
}

export async function listEnabledTradingUsers(): Promise<UserTradingSettings[]> {
  const admin = await getSupabaseAdmin()
  const { data, error } = await admin
    .from('user_trading_settings')
    .select('*')
    .eq('enabled', true)
    .eq('halted', false)
  if (error) throw new Error(`listEnabledTradingUsers failed: ${error.message}`)
  return (data ?? []).map(r => rowToSettings(r as DbRow))
}

/**
 * Update the worker watermark for a user (called after processing).
 */
export async function setWorkerWatermark(userId: string, lastVerdictId: number): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin
    .from('user_trading_settings')
    .update({ last_processed_verdict_id: lastVerdictId })
    .eq('user_id', userId)
}
