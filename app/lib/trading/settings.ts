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
  // Shorting (per-user opt-in). When true, BEARISH verdicts may place short
  // (sell-to-open) bracket orders. Gated again at decide-time on a margin
  // account with shorting enabled and a shortable symbol. Default false.
  allowShorts: boolean
  // Earnings-window trades (per-user opt-in). The Trader PASSes directional
  // trades when earnings are imminent (binary gap risk). When false, such
  // PASSes are still bypassed but taken at HALF size to cap gap-risk damage.
  // When true, earnings-window bypasses are taken at FULL size — the user is
  // explicitly choosing to trade through earnings and rely on the stop/monitor.
  // NOTE: stops do NOT protect against an overnight gap that jumps through the
  // stop price; that's the residual risk this toggle accepts. Default false.
  earningsFullSize: boolean
  // Low-priced shares (per-user opt-in). The sizing floor normally skips
  // entries under minSharePrice ($3 default) to avoid penny/illiquid names.
  // When true that floor drops to $0 so sub-$5 stocks become tradeable —
  // intended for very small accounts. Alpaca still won't trade true OTC /
  // pink-sheet penny stocks regardless of this flag. Default false.
  allowLowPriceShares: boolean
  allowFractionalShares: boolean
  // Council grade floor
  minGrade: 'A' | 'B' | 'C'
  lastProcessedVerdictId: number | null
  // Per-asset verdict watermarks (Migration 004). Each non-stock asset cron
  // tracks its own pointer so the stock cron can't advance past — and starve —
  // crypto/forex/futures verdicts. Stocks still use lastProcessedVerdictId.
  cryptoLastProcessedVerdictId: number | null
  forexLastProcessedVerdictId: number | null
  futuresLastProcessedVerdictId: number | null
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
  futuresMaxLeverage: number          // hard leverage cap for Coinbase CFM sizing
  coinbaseFuturesEnabled: boolean     // master switch for the Coinbase futures venue (off by default)
  totalMaxConcurrent: number        // cross-asset hard cap

  // Per-trade dollar bounds (Sizing Audit Phase 2). All nullable.
  // When set, sizing libs apply these on top of percentage caps.
  // See migration 12 for column comments.
  minDollarRiskPerTrade: number | null
  maxDollarRiskPerTrade: number | null
  minTradeNotional: number | null
  maxTradeNotional: number | null

  // Position-monitor tuning (Migration 14). Defaults conservative.
  // See migration 14 SQL comments for behavioral effect.
  positionMonitorEnabled: boolean
  pmExitThreshold15m: number
  pmExitThreshold5m: number
  pmTightenThreshold15m: number
  pmCooldownMin: number
  pmEscalateOnConflict: boolean

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
  maxConcurrentPos: 10,
  maxConsecLosses: 3,
  tradeStocks: true,
  tradeCrypto: false,
  tradeOptions: false,
  tradeForex: false,
  tradeFutures: false,
  allowShorts: false,
  earningsFullSize: false,
  allowLowPriceShares: false,
  allowFractionalShares: false,
  minGrade: 'B',
  lastProcessedVerdictId: null,
  cryptoLastProcessedVerdictId: null,
  forexLastProcessedVerdictId: null,
  futuresLastProcessedVerdictId: null,
  scannerEnabled: false,
  scannerMaxConcurrent: 8,
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
  futuresMaxLeverage: 2,
  coinbaseFuturesEnabled: false,
  totalMaxConcurrent: 10,
  minDollarRiskPerTrade: null,
  maxDollarRiskPerTrade: null,
  minTradeNotional: null,
  maxTradeNotional: null,
  positionMonitorEnabled: true,
  pmExitThreshold15m: 3,
  pmExitThreshold5m: 4,
  pmTightenThreshold15m: 3,
  pmCooldownMin: 10,
  pmEscalateOnConflict: true,
}

interface DbRow {
  id: string; user_id: string; enabled: boolean; mode: string
  halted: boolean; halt_reason: string | null; halted_at: string | null
  broker: string
  risk_per_trade_pct: string | number; max_position_pct: string | number
  max_daily_loss_pct: string | number; max_concurrent_pos: number; max_consec_losses: number
  trade_stocks: boolean; trade_crypto: boolean; trade_options: boolean; trade_forex: boolean
  trade_futures: boolean | null
  futures_max_leverage: string | number | null
  coinbase_futures_enabled: boolean | null
  allow_shorts: boolean | null
  earnings_full_size: boolean | null
  allow_low_price_shares: boolean | null
  allow_fractional_shares: boolean | null
  min_grade: string | null; last_processed_verdict_id: number | string | null
  crypto_last_processed_verdict_id: number | string | null
  forex_last_processed_verdict_id: number | string | null
  futures_last_processed_verdict_id: number | string | null
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
  min_dollar_risk_per_trade: string | number | null
  max_dollar_risk_per_trade: string | number | null
  min_trade_notional: string | number | null
  max_trade_notional: string | number | null
  position_monitor_enabled: boolean | null
  pm_exit_threshold_15m: number | null
  pm_exit_threshold_5m: number | null
  pm_tighten_threshold_15m: number | null
  pm_cooldown_min: number | null
  pm_escalate_on_conflict: boolean | null
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
    allowShorts: row.allow_shorts ?? false,
    earningsFullSize: row.earnings_full_size ?? false,
    allowLowPriceShares: row.allow_low_price_shares ?? false,
    allowFractionalShares: row.allow_fractional_shares ?? false,
    minGrade: (row.min_grade ?? 'B') as 'A' | 'B' | 'C',
    lastProcessedVerdictId: row.last_processed_verdict_id !== null && row.last_processed_verdict_id !== undefined
      ? Number(row.last_processed_verdict_id) : null,
    cryptoLastProcessedVerdictId: row.crypto_last_processed_verdict_id !== null && row.crypto_last_processed_verdict_id !== undefined
      ? Number(row.crypto_last_processed_verdict_id) : null,
    forexLastProcessedVerdictId: row.forex_last_processed_verdict_id !== null && row.forex_last_processed_verdict_id !== undefined
      ? Number(row.forex_last_processed_verdict_id) : null,
    futuresLastProcessedVerdictId: row.futures_last_processed_verdict_id !== null && row.futures_last_processed_verdict_id !== undefined
      ? Number(row.futures_last_processed_verdict_id) : null,
    scannerEnabled: row.scanner_enabled ?? false,
    scannerMaxConcurrent: row.scanner_max_concurrent ?? 8,
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
    futuresMaxLeverage: row.futures_max_leverage !== null && row.futures_max_leverage !== undefined
      ? Number(row.futures_max_leverage) : 2,
    coinbaseFuturesEnabled: row.coinbase_futures_enabled ?? false,
    totalMaxConcurrent: row.total_max_concurrent ?? 10,
    minDollarRiskPerTrade: row.min_dollar_risk_per_trade !== null && row.min_dollar_risk_per_trade !== undefined
      ? Number(row.min_dollar_risk_per_trade) : null,
    maxDollarRiskPerTrade: row.max_dollar_risk_per_trade !== null && row.max_dollar_risk_per_trade !== undefined
      ? Number(row.max_dollar_risk_per_trade) : null,
    minTradeNotional: row.min_trade_notional !== null && row.min_trade_notional !== undefined
      ? Number(row.min_trade_notional) : null,
    maxTradeNotional: row.max_trade_notional !== null && row.max_trade_notional !== undefined
      ? Number(row.max_trade_notional) : null,
    positionMonitorEnabled: row.position_monitor_enabled ?? true,
    pmExitThreshold15m: row.pm_exit_threshold_15m ?? 3,
    pmExitThreshold5m: row.pm_exit_threshold_5m ?? 4,
    pmTightenThreshold15m: row.pm_tighten_threshold_15m ?? 3,
    pmCooldownMin: row.pm_cooldown_min ?? 10,
    pmEscalateOnConflict: row.pm_escalate_on_conflict ?? true,
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
    allowShorts: 'allow_shorts',
    earningsFullSize: 'earnings_full_size',
    allowLowPriceShares: 'allow_low_price_shares',
    allowFractionalShares: 'allow_fractional_shares',
    minGrade: 'min_grade', lastProcessedVerdictId: 'last_processed_verdict_id',
    cryptoLastProcessedVerdictId: 'crypto_last_processed_verdict_id',
    forexLastProcessedVerdictId: 'forex_last_processed_verdict_id',
    futuresLastProcessedVerdictId: 'futures_last_processed_verdict_id',
    scannerEnabled: 'scanner_enabled', scannerMaxConcurrent: 'scanner_max_concurrent',
    scannerMinComposite: 'scanner_min_composite',
    scannerMaxPositionPct: 'scanner_max_position_pct',
    activeMgmtEnabled: 'active_mgmt_enabled', reevalDrawdownPct: 'reeval_drawdown_pct',
    allowTightenStop: 'allow_tighten_stop', allowEarlyExit: 'allow_early_exit',
    allowAddPosition: 'allow_add_position', maxAddCount: 'max_add_count',
    cryptoMaxConcurrent: 'crypto_max_concurrent', cryptoRiskPerTradePct: 'crypto_risk_per_trade_pct',
    forexMaxConcurrent: 'forex_max_concurrent', forexRiskPerTradePct: 'forex_risk_per_trade_pct',
    futuresMaxConcurrent: 'futures_max_concurrent', futuresRiskPerTradePct: 'futures_risk_per_trade_pct',
    futuresMaxLeverage: 'futures_max_leverage', coinbaseFuturesEnabled: 'coinbase_futures_enabled',
    totalMaxConcurrent: 'total_max_concurrent',
    minDollarRiskPerTrade: 'min_dollar_risk_per_trade',
    maxDollarRiskPerTrade: 'max_dollar_risk_per_trade',
    minTradeNotional: 'min_trade_notional',
    maxTradeNotional: 'max_trade_notional',
    positionMonitorEnabled: 'position_monitor_enabled',
    pmExitThreshold15m: 'pm_exit_threshold_15m',
    pmExitThreshold5m: 'pm_exit_threshold_5m',
    pmTightenThreshold15m: 'pm_tighten_threshold_15m',
    pmCooldownMin: 'pm_cooldown_min',
    pmEscalateOnConflict: 'pm_escalate_on_conflict',
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
    futures_max_leverage: merged.futuresMaxLeverage,
    coinbase_futures_enabled: merged.coinbaseFuturesEnabled,
    total_max_concurrent: merged.totalMaxConcurrent,
    min_dollar_risk_per_trade: merged.minDollarRiskPerTrade,
    max_dollar_risk_per_trade: merged.maxDollarRiskPerTrade,
    min_trade_notional: merged.minTradeNotional,
    max_trade_notional: merged.maxTradeNotional,
    position_monitor_enabled: merged.positionMonitorEnabled,
    pm_exit_threshold_15m: merged.pmExitThreshold15m,
    pm_exit_threshold_5m: merged.pmExitThreshold5m,
    pm_tighten_threshold_15m: merged.pmTightenThreshold15m,
    pm_cooldown_min: merged.pmCooldownMin,
    pm_escalate_on_conflict: merged.pmEscalateOnConflict,
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

// Per-asset watermark setter (Migration 004). Each non-stock asset cron
// persists its own pointer so the stock cron can't advance past — and starve —
// crypto/forex/futures verdicts. 'stock' maps to the legacy shared column.
export async function setVerdictWatermark(
  userId: string,
  assetClass: 'stock' | 'crypto' | 'forex' | 'futures',
  lastVerdictId: number,
): Promise<void> {
  const col =
    assetClass === 'crypto'  ? 'crypto_last_processed_verdict_id'  :
    assetClass === 'forex'   ? 'forex_last_processed_verdict_id'   :
    assetClass === 'futures' ? 'futures_last_processed_verdict_id' :
                               'last_processed_verdict_id'
  const admin = await getSupabaseAdmin()
  await admin.from('user_trading_settings').update({ [col]: lastVerdictId }).eq('user_id', userId)
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

/** Hard leverage ceiling for Coinbase CFM sizing. Defaults to 2x. */
export function getMaxLeverageForFutures(s: UserTradingSettings): number {
  return Number.isFinite(s.futuresMaxLeverage) && s.futuresMaxLeverage > 0 ? s.futuresMaxLeverage : 2
}

/**
 * Master switch for the Coinbase CFM futures venue. Independent of the shared
 * `tradeFutures` flag (which also covers the Tradovate/CME path), so leveraged
 * Coinbase futures stay OFF until explicitly enabled — a deliberate
 * real-money safety default.
 */
export function isCoinbaseFuturesEnabled(s: UserTradingSettings): boolean {
  return s.coinbaseFuturesEnabled === true && s.tradeFutures === true
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
