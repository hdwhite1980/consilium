// =============================================================
// app/lib/trading/decide.ts
//
// Per-(verdict, user) decision pipeline. Composes:
//   1. Verdict eligibility filter (TAKE only, grade floor, age limit)
//   2. Asset class supported by user's broker
//   3. Asset class enabled in user settings
//   4. Symbol normalization + Alpaca tradability
//   5. Sizing
//   6. Kill switches
//
// Returns a Decision: place | skip | error. Caller writes a
// trade_attempts row regardless.
// =============================================================

import type { UserTradingSettings } from './settings'
import type { AlpacaClient, AlpacaAccount, AlpacaPosition } from './alpaca-client'
import { evaluateKillSwitches } from './kill-switches'
import { computePositionSize } from './sizing'

export interface VerdictForTrade {
  id: number
  user_id: string
  ticker: string
  signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | string
  confidence: number | null
  entry_price: number | string | null
  stop_loss: number | string | null
  take_profit: number | string | null
  timeframe: string | null
  trader_decision: string | null
  trader_grade: string | null
  trader_position_size: number | string | null
  trader_risk_reward: number | string | null
  created_at: string
}

export type Decision =
  | {
      kind: 'place'
      ticker: string
      side: 'buy' | 'sell'
      qty: number
      entryPrice: number
      stopPrice: number
      targetPrice: number
      dollarRisk: number
      accountEquity: number
      rationale: string
    }
  | { kind: 'skip'; reason: string; shouldHalt: false }
  | { kind: 'halt'; reason: string; shouldHalt: true }

// How old can a verdict be before we refuse to act on it.
const MAX_VERDICT_AGE_HOURS = 4

// Asset class detection — must mirror what's tradable on Alpaca v1.
function isStockTicker(ticker: string): boolean {
  // Stock = 1-5 uppercase letters, with optional .B/.A class suffix
  return /^[A-Z]{1,5}(\.[A-Z])?$/.test(ticker)
}

function isForexTicker(ticker: string): boolean {
  return /^[A-Z]{6}$/.test(ticker) && /USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|MXN/.test(ticker)
}

function isCryptoTicker(ticker: string): boolean {
  // BTC/USD or BTCUSD
  return /^[A-Z]{3,4}\/?USD$/.test(ticker) && !/^[A-Z]{1,5}$/.test(ticker)
}

function detectAssetClass(ticker: string): 'stock' | 'forex' | 'crypto' | 'unknown' {
  const t = ticker.toUpperCase()
  if (isForexTicker(t)) return 'forex'
  if (isCryptoTicker(t)) return 'crypto'
  if (isStockTicker(t)) return 'stock'
  return 'unknown'
}

/**
 * Normalize ticker for Alpaca. e.g., BRK.B → BRK.B (Alpaca accepts dot form).
 * If you see Alpaca rejecting a ticker that's correct everywhere else, this
 * is where to add a translation table.
 */
function normalizeAlpacaSymbol(ticker: string): string {
  return ticker.toUpperCase().trim()
}

/**
 * Per-(verdict, user) decision. Pure function as much as possible —
 * the only side effect is the kill-switch DB reads.
 */
export async function decideForUser(args: {
  verdict: VerdictForTrade
  settings: UserTradingSettings
  alpaca: AlpacaClient
}): Promise<Decision> {
  const { verdict, settings, alpaca } = args

  // 1. Verdict eligibility — TAKE only
  if (verdict.trader_decision !== 'TAKE') {
    return { kind: 'skip', reason: `trader_decision=${verdict.trader_decision} (not TAKE)`, shouldHalt: false }
  }

  // 2. Grade floor
  const grade = verdict.trader_grade
  if (!grade || !['A', 'B', 'C'].includes(grade)) {
    return { kind: 'skip', reason: `no grade set`, shouldHalt: false }
  }
  const gradeRank = (g: string) => g === 'A' ? 3 : g === 'B' ? 2 : 1
  if (gradeRank(grade) < gradeRank(settings.minGrade)) {
    return { kind: 'skip', reason: `grade ${grade} below floor ${settings.minGrade}`, shouldHalt: false }
  }

  // 3. Trade plan present
  const entryRaw = verdict.entry_price
  const stopRaw = verdict.stop_loss
  const targetRaw = verdict.take_profit
  if (entryRaw === null || stopRaw === null || targetRaw === null) {
    return { kind: 'skip', reason: 'missing entry/stop/target', shouldHalt: false }
  }
  const entryPrice = Number(entryRaw)
  const stopPrice = Number(stopRaw)
  const targetPrice = Number(targetRaw)
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopPrice) || !Number.isFinite(targetPrice)) {
    return { kind: 'skip', reason: 'invalid entry/stop/target values', shouldHalt: false }
  }

  // 4. Direction
  let side: 'buy' | 'sell'
  if (verdict.signal === 'BULLISH') side = 'buy'
  else if (verdict.signal === 'BEARISH') side = 'sell'
  else return { kind: 'skip', reason: `signal=${verdict.signal} not actionable`, shouldHalt: false }

  // Direction sanity: stop should be on the right side of entry
  if (side === 'buy' && stopPrice >= entryPrice) {
    return { kind: 'skip', reason: `buy with stop (${stopPrice}) >= entry (${entryPrice})`, shouldHalt: false }
  }
  if (side === 'sell' && stopPrice <= entryPrice) {
    return { kind: 'skip', reason: `sell with stop (${stopPrice}) <= entry (${entryPrice})`, shouldHalt: false }
  }
  if (side === 'buy' && targetPrice <= entryPrice) {
    return { kind: 'skip', reason: `buy with target (${targetPrice}) <= entry (${entryPrice})`, shouldHalt: false }
  }
  if (side === 'sell' && targetPrice >= entryPrice) {
    return { kind: 'skip', reason: `sell with target (${targetPrice}) >= entry (${entryPrice})`, shouldHalt: false }
  }

  // 5. Age limit
  const ageHours = (Date.now() - new Date(verdict.created_at).getTime()) / 3_600_000
  if (ageHours > MAX_VERDICT_AGE_HOURS) {
    return { kind: 'skip', reason: `verdict ${ageHours.toFixed(1)}h old (limit ${MAX_VERDICT_AGE_HOURS}h)`, shouldHalt: false }
  }

  // 6. Asset class supported
  const assetClass = detectAssetClass(verdict.ticker)
  if (assetClass === 'unknown') {
    return { kind: 'skip', reason: `unrecognized ticker shape: ${verdict.ticker}`, shouldHalt: false }
  }
  if (assetClass !== 'stock') {
    return { kind: 'skip', reason: `Alpaca v1 only trades stocks; ${verdict.ticker} is ${assetClass}`, shouldHalt: false }
  }
  if (!settings.tradeStocks) {
    return { kind: 'skip', reason: 'user has tradeStocks=false', shouldHalt: false }
  }

  // 7. Sell-short check (we don't short in v1 — user would need margin + locate)
  if (side === 'sell') {
    return { kind: 'skip', reason: 'short-sell BEARISH trades not supported in v1 (no margin/locate flow)', shouldHalt: false }
  }

  // 8. Symbol normalization + Alpaca tradability
  const symbol = normalizeAlpacaSymbol(verdict.ticker)
  const tradable = await alpaca.assetTradable(symbol)
  if (!tradable.tradable) {
    return { kind: 'skip', reason: `Alpaca: ${tradable.reason ?? 'not tradable'}`, shouldHalt: false }
  }

  // 9. Sizing
  let account: AlpacaAccount
  let positions: AlpacaPosition[]
  try {
    account = await alpaca.account()
    positions = await alpaca.positions()
  } catch (e) {
    return { kind: 'halt', reason: `Alpaca account fetch failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`, shouldHalt: true }
  }

  // 10. Kill switches
  const killCheck = await evaluateKillSwitches({
    settings,
    account,
    positions,
    ticker: symbol,
  })
  if (!killCheck.allowed) {
    return killCheck.shouldHalt
      ? { kind: 'halt', reason: killCheck.reason, shouldHalt: true }
      : { kind: 'skip', reason: killCheck.reason, shouldHalt: false }
  }

  // 11. Compute size
  const traderSize = verdict.trader_position_size !== null && verdict.trader_position_size !== undefined
    ? Number(verdict.trader_position_size)
    : 1
  const sizing = computePositionSize({
    accountEquity: account.equity,
    riskPerTradePct: settings.riskPerTradePct,
    maxPositionPct: settings.maxPositionPct,
    entryPrice,
    stopPrice,
    traderPositionSizePct: traderSize > 0 ? Math.min(1, traderSize) : 1,
  })
  if (!sizing.ok) {
    return { kind: 'skip', reason: `sizing: ${sizing.reason}`, shouldHalt: false }
  }

  return {
    kind: 'place',
    ticker: symbol,
    side,
    qty: sizing.qty,
    entryPrice,
    stopPrice,
    targetPrice,
    dollarRisk: sizing.dollarRisk,
    accountEquity: account.equity,
    rationale: sizing.rationale,
  }
}
