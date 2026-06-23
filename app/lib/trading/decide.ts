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
  trader_pass_reasons: string[] | null
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
 * Classify a Trader PASS verdict into a bypass category, or null if not eligible.
 *
 * Background (June 22, 2026 — user request):
 * The Trader gates trades on R:R floors and timing constraints. Some PASSes are
 * fundamentally bad math (R:R below 1.0; confidence floors); those stay PASS.
 * But TWO categories are timing/management decisions where downstream systems
 * (position-monitor, reeval, morning-reeval) can handle the risk:
 *
 *   - 'marginal_rr': R:R between 1.0 and 1.5. Math is positive but tight.
 *     Position-monitor's bearish signal detection can EXIT early if it doesn't
 *     work out, limiting damage. Take at HALF size to limit per-trade impact.
 *
 *   - 'earnings_window': Trader passed because earnings are within the block
 *     window. The TRADE itself is solid; the timing is the issue. Position-
 *     monitor manages overnight earnings volatility via EXIT on adverse move.
 *     Take at HALF size to limit gap-risk impact.
 *
 * Returns null when the PASS doesn't fit either category — caller treats as
 * normal skip.
 */
function classifyPassBypass(verdict: VerdictForTrade): {
  category: 'marginal_rr' | 'earnings_window'
  rationale: string
} | null {
  const reasons = Array.isArray(verdict.trader_pass_reasons) ? verdict.trader_pass_reasons : []
  if (reasons.length === 0) return null

  // ── marginal R:R ──
  // Read the structured column rather than parsing the text — it's the
  // numeric value the Trader computed. Range [1.0, 1.5).
  const rr = verdict.trader_risk_reward !== null && verdict.trader_risk_reward !== undefined
    ? Number(verdict.trader_risk_reward)
    : null
  const hasRrPass = reasons.some(r =>
    typeof r === 'string' && /risk-to-reward|r:r|risk\/reward/i.test(r),
  )
  if (hasRrPass && rr !== null && Number.isFinite(rr) && rr >= 1.0 && rr < 1.5) {
    return {
      category: 'marginal_rr',
      rationale: `marginal-R:R bypass: ${rr.toFixed(2)}:1 in [1.0, 1.5) — half size, monitor closely`,
    }
  }

  // ── earnings window ──
  // Pattern-match the reason text for 'earnings' keyword. The Trader's
  // earnings rules block trades within an earnings proximity window.
  const hasEarningsPass = reasons.some(r =>
    typeof r === 'string' && /earnings/i.test(r),
  )
  if (hasEarningsPass) {
    return {
      category: 'earnings_window',
      rationale: 'earnings-window bypass: timing block only, take at half size, monitor manages volatility',
    }
  }

  return null
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

  // 1. Verdict eligibility — TAKE, or qualifying PASS bypass
  let bypass: ReturnType<typeof classifyPassBypass> = null
  if (verdict.trader_decision === 'TAKE') {
    // Normal path
  } else if (verdict.trader_decision === 'PASS') {
    bypass = classifyPassBypass(verdict)
    if (!bypass) {
      return {
        kind: 'skip',
        reason: `trader_decision=PASS and not bypass-eligible`,
        shouldHalt: false,
      }
    }
    // Continue with bypass — will apply half-sizing at step 11
  } else {
    return {
      kind: 'skip',
      reason: `trader_decision=${verdict.trader_decision} (not TAKE or PASS)`,
      shouldHalt: false,
    }
  }

  // 2. Grade floor
  // For TAKE verdicts the grade is required. For PASS bypass verdicts the
  // Trader doesn't grade (since it didn't approve), so we treat them as if
  // they were grade C (minimum) — the bypass itself is the qualification.
  const grade = verdict.trader_grade ?? (bypass ? 'C' : null)
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
  //
  // Use the CONSERVATIVE equity number — min(equity, buying_power).
  // Audit Finding 1: Alpaca's `equity` includes unrealized P&L on open
  // positions, which over-counts available capital. `buying_power` is
  // what we can actually deploy. Taking the min defends against:
  //   - Margin account in winning streak (equity > buying_power)
  //   - Cash account near-empty (buying_power ≈ cash; equity may also
  //     equal cash so min just returns the real number)
  //   - Pattern Day Trader limits constraining buying_power < equity
  const effectiveEquity = Math.min(account.equity, account.buying_power)
  const traderSize = verdict.trader_position_size !== null && verdict.trader_position_size !== undefined
    ? Number(verdict.trader_position_size)
    : 1

  // PASS bypass: halve the position size. The Trader gated for a reason
  // (marginal R:R or earnings timing); we override that gate but cap our
  // per-trade exposure at half normal so any single bypass loss has half
  // the impact.
  const sizeMultiplier = bypass ? 0.5 : 1.0
  const effectiveTraderSize = Math.min(1, Math.max(0, traderSize * sizeMultiplier))

  // Per-trade bounds from user_trading_settings (Audit Phase 2).
  // Quality-based sizing (June 23 2026): pass grade, confidence, R:R so
  // sizing can scale dollarRisk by setup quality. Skipped automatically
  // for PASS bypass (traderPositionSizePct < 1) — the bypass's reduced
  // size shouldn't be compounded with quality math.
  const sizing = computePositionSize({
    accountEquity: effectiveEquity,
    riskPerTradePct: settings.riskPerTradePct,
    maxPositionPct: settings.maxPositionPct,
    entryPrice,
    stopPrice,
    traderPositionSizePct: effectiveTraderSize > 0 ? effectiveTraderSize : 1,
    minDollarRiskPerTrade: settings.minDollarRiskPerTrade,
    maxDollarRiskPerTrade: settings.maxDollarRiskPerTrade,
    minTradeNotional: settings.minTradeNotional,
    maxTradeNotional: settings.maxTradeNotional,
    qualityGrade: (grade === 'A' || grade === 'B' || grade === 'C') ? grade : null,
    qualityConfidence: verdict.confidence !== null ? Number(verdict.confidence) : null,
    qualityRiskReward: verdict.trader_risk_reward !== null && verdict.trader_risk_reward !== undefined
      ? Number(verdict.trader_risk_reward) : null,
  })
  if (!sizing.ok) {
    return { kind: 'skip', reason: `sizing: ${sizing.reason}`, shouldHalt: false }
  }

  // Pre-place buying-power gate (Audit Phase 3).
  //
  // Defensive check: verify the computed position notional fits within current
  // buying_power with safety headroom. With Phase 1 (using min(equity,
  // buying_power) as the sizing input), broker rejection is unlikely, but this
  // catches edge cases:
  //   - Capital committed outside this system (user manually placed an order
  //     on the broker site between cron runs)
  //   - account.buying_power < account.equity due to PDT or margin call
  //   - Phase 2 bounds pushed sizing to its limit and a stale buying_power
  //     reading could now exceed actual
  //
  // 5% safety margin covers slippage between current bid and the market fill
  // (Alpaca uses the asking price, not the entry estimate, for margin calc).
  const BUYING_POWER_SAFETY_MARGIN = 0.95
  const safeBuyingPower = account.buying_power * BUYING_POWER_SAFETY_MARGIN
  if (sizing.positionDollar > safeBuyingPower) {
    return {
      kind: 'skip',
      reason: `pre-place gate: position $${sizing.positionDollar.toFixed(2)} > safe buying_power $${safeBuyingPower.toFixed(2)} (raw: $${account.buying_power.toFixed(2)})`,
      shouldHalt: false,
    }
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
    accountEquity: effectiveEquity,
    rationale: bypass
      ? `[PASS_BYPASS:${bypass.category}] ${bypass.rationale} | ${sizing.rationale}`
      : sizing.rationale,
  }
}
