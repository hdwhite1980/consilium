// =============================================================
// app/lib/trading/settings.ts
//
// Multi-asset settings: per-class budgets + total cap, plus all
// prior fields from Commits 1-4.
// =============================================================

import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'

export type AssetClass = 'stock' | 'crypto' | 'forex' | 'futures'

export interface UserTradingSettings {
  id: string
  userId: string
  enabled: boolean
  mode: 'paper' | 'live'
  halted: boolean
  haltReason: string | null
  haltedAt: string | null
  broker: 'alpaca'    // legacy default broker for stocks; per-asset brokers via credentials
  // Stock sizing/limits (existing)
  riskPerTradePct: number
  maxPositionPct: number
  maxDailyLossPct: number
  maxConcurrentPos: number          // legacy = stocks-specific concurrent cap
  maxConsecLosses: number
  // Asset enable flags (existing)
  tradeStocks: boolean
  tradeCrypto: boolean
  tradeOptions: boolean
  tradeForex: boolean
  // (futures has no enable flag prior; tradeFutures introduced below)
  tradeFutures: boolean
  // Council grade floor
  minGrade: 'A' | 'B' | 'C'
  lastProcessedVerdictId: number | null
  // Scanner (existing)
  scannerEnabled: boolean
  scannerMaxConcurrent: number
  scannerMinComposite: number
  scannerMaxPositionPct: number
  // Active mgmt (existing)
  activeMgmtEnabled: boolean
  reevalDrawdownPct: number
  allowTightenStop: boolean
  allowEarlyExit: boolean
  allowAddPosition: boolean
  maxAddCount: number
  // Multi-asset additions
  cryptoMaxConcurrent: number
  cryptoRiskPerTradePct: number
  forexMaxConcurrent: number
  forexRiskPerTradePct: number
  futuresMaxConcurrent: number
  futuresRiskPerTradePct: number
  totalMaxConcurrent: number        // cross-asset hard cap

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
  tradeFutures: false,
  minGrade: 'B',
  lastProcessedVerdictId: null,
  scannerEnabled: false,
  scannerMaxConcurrent: 3,
  scannerMinComposite: 70,
  scannerMaxPositionPct: 0.2000,
  activeMgmtEnabled: false,
  reevalDrawdownPct: 0.5,
  allowTightenStop: true,
  allowEarlyExit: true,
  allowAddPosition: false,
  maxAddCount: 1,
  cryptoMaxConcurrent: 3,
  cryptoRiskPerTradePct: 0.0050,
  forexMaxConcurrent: 3,
  forexRiskPerTradePct: 0.0050,
  futuresMaxConcurrent: 2,
  futuresRiskPerTradePct: 0.0050,
  totalMaxConcurrent: 10,
}

interface DbRow {
  id: string; user_id: string; enabled: boolean; mode: string
  halted: boolean; halt_reason: string | null; halted_at: string | null
  broker: string
  risk_per_trade_pct: string | number; max_position_pct: string | number
  max_daily_loss_pct: string | number; max_concurrent_pos: number; max_consec_losses: number
  trade_stocks: boolean; trade_crypto: boolean; trade_options: boolean; trade_forex: boolean
  trade_futures: boolean | null
  min_grade: string | null; last_processed_verdict_id: number | string | null
  scanner_enabled: boolean; scanner_max_concurrent: number; scanner_min_composite: number
  scanner_max_position_pct: string | number | null
  active_mgmt_enabled: boolean; reeval_drawdown_pct: string | number
  allow_tighten_stop: boolean; allow_early_exit: boolean; allow_add_position: boolean
  max_add_count: number
  crypto_max_concurrent: number | null
  crypto_risk_per_trade_pct: string | number | null
  forex_max_concurrent: number | null
  forex_risk_per_trade_pct: string | number | null
  futures_max_concurrent: number | null
  futures_risk_per_trade_pct: string | number | null
  total_max_concurrent: number | null
  created_at: string; updated_at: string
}

function rowToSettings(row: DbRow): UserTradingSettings {
  return {
    id: row.id, userId: row.user_id, enabled: row.enabled, mode: row.mode as 'paper' | 'live',
    halted: row.halted, haltReason: row.halt_reason, haltedAt: row.halted_at,
    broker: row.broker as 'alpaca',
    riskPerTradePct: Number(row.risk_per_trade_pct),
    maxPositionPct: Number(row.max_position_pct),
    maxDailyLossPct: Number(row.max_daily_loss_pct),
    maxConcurrentPos: row.max_concurrent_pos,
    maxConsecLosses: row.max_consec_losses,
    tradeStocks: row.trade_stocks, tradeCrypto: row.trade_crypto,
    tradeOptions: row.trade_options, tradeForex: row.trade_forex,
    tradeFutures: row.trade_futures ?? false,
    minGrade: (row.min_grade ?? 'B') as 'A' | 'B' | 'C',
    lastProcessedVerdictId: row.last_processed_verdict_id !== null && row.last_processed_verdict_id !== undefined
      ? Number(row.last_processed_verdict_id) : null,
    scannerEnabled: row.scanner_enabled ?? false,
    scannerMaxConcurrent: row.scanner_max_concurrent ?? 3,
    scannerMinComposite: row.scanner_min_composite ?? 70,
    scannerMaxPositionPct: row.scanner_max_position_pct !== null && row.scanner_max_position_pct !== undefined
      ? Number(row.scanner_max_position_pct) : 0.20,
    activeMgmtEnabled: row.active_mgmt_enabled ?? false,
    reevalDrawdownPct: row.reeval_drawdown_pct !== undefined && row.reeval_drawdown_pct !== null
      ? Number(row.reeval_drawdown_pct) : 0.5,
    allowTightenStop: row.allow_tighten_stop ?? true,
    allowEarlyExit: row.allow_early_exit ?? true,
    allowAddPosition: row.allow_add_position ?? false,
    maxAddCount: row.max_add_count ?? 1,
    cryptoMaxConcurrent: row.crypto_max_concurrent ?? 3,
    cryptoRiskPerTradePct: row.crypto_risk_per_trade_pct !== null && row.crypto_risk_per_trade_pct !== undefined
      ? Number(row.crypto_risk_per_trade_pct) : 0.005,
    forexMaxConcurrent: row.forex_max_concurrent ?? 3,
    forexRiskPerTradePct: row.forex_risk_per_trade_pct !== null && row.forex_risk_per_trade_pct !== undefined
      ? Number(row.forex_risk_per_trade_pct) : 0.005,
    futuresMaxConcurrent: row.futures_max_concurrent ?? 2,
    futuresRiskPerTradePct: row.futures_risk_per_trade_pct !== null && row.futures_risk_per_trade_pct !== undefined
      ? Number(row.futures_risk_per_trade_pct) : 0.005,
    totalMaxConcurrent: row.total_max_concurrent ?? 10,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export async function loadUserTradingSettings(userId: string): Promise<UserTradingSettings | null> {
  const admin = await getSupabaseAdmin()
  const { data, error } = await admin.from('user_trading_settings').select('*').eq('user_id', userId).maybeSingle()
  if (error) throw new Error(`loadUserTradingSettings failed: ${error.message}`)
  if (!data) return null
  return rowToSettings(data as DbRow)
}

export async function upsertUserTradingSettings(
  userId: string, patch: Partial<UserTradingSettings>,
): Promise<UserTradingSettings> {
  const admin = await getSupabaseAdmin()
  const existing = await loadUserTradingSettings(userId)

  const map: Record<keyof UserTradingSettings, string> = {
    id: 'id', userId: 'user_id',
    enabled: 'enabled', mode: 'mode', halted: 'halted',
    haltReason: 'halt_reason', haltedAt: 'halted_at',
    broker: 'broker',
    riskPerTradePct: 'risk_per_trade_pct', maxPositionPct: 'max_position_pct',
    maxDailyLossPct: 'max_daily_loss_pct',
    maxConcurrentPos: 'max_concurrent_pos', maxConsecLosses: 'max_consec_losses',
    tradeStocks: 'trade_stocks', tradeCrypto: 'trade_crypto',
    tradeOptions: 'trade_options', tradeForex: 'trade_forex',
    tradeFutures: 'trade_futures',
    minGrade: 'min_grade', lastProcessedVerdictId: 'last_processed_verdict_id',
    scannerEnabled: 'scanner_enabled', scannerMaxConcurrent: 'scanner_max_concurrent',
    scannerMinComposite: 'scanner_min_composite',
    scannerMaxPositionPct: 'scanner_max_position_pct',
    activeMgmtEnabled: 'active_mgmt_enabled', reevalDrawdownPct: 'reeval_drawdown_pct',
    allowTightenStop: 'allow_tighten_stop', allowEarlyExit: 'allow_early_exit',
    allowAddPosition: 'allow_add_position', maxAddCount: 'max_add_count',
    cryptoMaxConcurrent: 'crypto_max_concurrent', cryptoRiskPerTradePct: 'crypto_risk_per_trade_pct',
    forexMaxConcurrent: 'forex_max_concurrent', forexRiskPerTradePct: 'forex_risk_per_trade_pct',
    futuresMaxConcurrent: 'futures_max_concurrent', futuresRiskPerTradePct: 'futures_risk_per_trade_pct',
    totalMaxConcurrent: 'total_max_concurrent',
    createdAt: 'created_at', updatedAt: 'updated_at',
  }
  const dbPatch: Record<string, unknown> = {}
  for (const k of Object.keys(patch) as (keyof UserTradingSettings)[]) {
    if (k === 'id' || k === 'userId' || k === 'createdAt' || k === 'updatedAt') continue
    if (patch[k] !== undefined) dbPatch[map[k]] = patch[k]
  }

  if (existing) {
    if (Object.keys(dbPatch).length === 0) return existing
    const { data, error } = await admin.from('user_trading_settings').update(dbPatch).eq('id', existing.id).select('*').single()
    if (error) throw new Error(`upsertUserTradingSettings update failed: ${error.message}`)
    return rowToSettings(data as DbRow)
  }

  const merged = { ...DEFAULT_TRADING_SETTINGS, ...patch }
  const insertRow: Record<string, unknown> = {
    user_id: userId,
    enabled: merged.enabled, mode: merged.mode, halted: merged.halted,
    halt_reason: merged.haltReason ?? null, halted_at: merged.haltedAt ?? null,
    broker: merged.broker,
    risk_per_trade_pct: merged.riskPerTradePct, max_position_pct: merged.maxPositionPct,
    max_daily_loss_pct: merged.maxDailyLossPct, max_concurrent_pos: merged.maxConcurrentPos,
    max_consec_losses: merged.maxConsecLosses,
    trade_stocks: merged.tradeStocks, trade_crypto: merged.tradeCrypto,
    trade_options: merged.tradeOptions, trade_forex: merged.tradeForex,
    trade_futures: merged.tradeFutures,
    min_grade: merged.minGrade, last_processed_verdict_id: merged.lastProcessedVerdictId,
    scanner_enabled: merged.scannerEnabled, scanner_max_concurrent: merged.scannerMaxConcurrent,
    scanner_min_composite: merged.scannerMinComposite,
    scanner_max_position_pct: merged.scannerMaxPositionPct,
    active_mgmt_enabled: merged.activeMgmtEnabled, reeval_drawdown_pct: merged.reevalDrawdownPct,
    allow_tighten_stop: merged.allowTightenStop, allow_early_exit: merged.allowEarlyExit,
    allow_add_position: merged.allowAddPosition, max_add_count: merged.maxAddCount,
    crypto_max_concurrent: merged.cryptoMaxConcurrent,
    crypto_risk_per_trade_pct: merged.cryptoRiskPerTradePct,
    forex_max_concurrent: merged.forexMaxConcurrent,
    forex_risk_per_trade_pct: merged.forexRiskPerTradePct,
    futures_max_concurrent: merged.futuresMaxConcurrent,
    futures_risk_per_trade_pct: merged.futuresRiskPerTradePct,
    total_max_concurrent: merged.totalMaxConcurrent,
  }
  const { data, error } = await admin.from('user_trading_settings').insert(insertRow).select('*').single()
  if (error) throw new Error(`upsertUserTradingSettings insert failed: ${error.message}`)
  return rowToSettings(data as DbRow)
}

export async function listEnabledTradingUsers(): Promise<UserTradingSettings[]> {
  const admin = await getSupabaseAdmin()
  const { data, error } = await admin.from('user_trading_settings').select('*').eq('enabled', true).eq('halted', false)
  if (error) throw new Error(`listEnabledTradingUsers failed: ${error.message}`)
  return (data ?? []).map(r => rowToSettings(r as DbRow))
}

export async function setWorkerWatermark(userId: string, lastVerdictId: number): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('user_trading_settings').update({ last_processed_verdict_id: lastVerdictId }).eq('user_id', userId)
}

// ─────────────────────────────────────────────────────────────
// Helpers for per-asset class lookups
// ─────────────────────────────────────────────────────────────

export function getRiskPerTradePctForAsset(s: UserTradingSettings, ac: AssetClass): number {
  if (ac === 'stock') return s.riskPerTradePct
  if (ac === 'crypto') return s.cryptoRiskPerTradePct
  if (ac === 'forex') return s.forexRiskPerTradePct
  if (ac === 'futures') return s.futuresRiskPerTradePct
  return s.riskPerTradePct
}

export function getMaxConcurrentForAsset(s: UserTradingSettings, ac: AssetClass): number {
  if (ac === 'stock') return s.maxConcurrentPos
  if (ac === 'crypto') return s.cryptoMaxConcurrent
  if (ac === 'forex') return s.forexMaxConcurrent
  if (ac === 'futures') return s.futuresMaxConcurrent
  return s.maxConcurrentPos
}

export function isAssetClassEnabled(s: UserTradingSettings, ac: AssetClass): boolean {
  if (ac === 'stock') return s.tradeStocks
  if (ac === 'crypto') return s.tradeCrypto
  if (ac === 'forex') return s.tradeForex
  if (ac === 'futures') return s.tradeFutures
  return false
}

/**
 * Compute the scanner price ceiling for a user given their current account equity.
 * Returns a dollar amount used as priceMax in scanner runs.
 *
 * Example:
 *   equity=$100, scannerMaxPositionPct=0.20 → ceiling $20
 *   equity=$10000, scannerMaxPositionPct=0.20 → ceiling $2000
 */
export function computeScannerPriceCeiling(
  equity: number,
  settings: Pick<UserTradingSettings, 'scannerMaxPositionPct'>,
): number {
  if (!Number.isFinite(equity) || equity <= 0) return 0
  const pct = settings.scannerMaxPositionPct > 0 ? settings.scannerMaxPositionPct : 0.20
  return equity * pct
}
