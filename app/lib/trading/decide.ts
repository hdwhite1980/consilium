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
import { isCryptoPairSymbol } from '@/app/lib/crypto-symbol'

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
      fractional: boolean
      entryPrice: number
      stopPrice: number
      targetPrice: number
      dollarRisk: number
      accountEquity: number
      rationale: string
      // Which monitor owns this position once filled. Earnings-window trades
      // are forced to 'day' so the fast (5m/15m) day-monitor manages them and
      // can exit intraday before the overnight earnings gap. Everything else
      // starts 'swing'. (Requires the day-monitor cron to be scheduled.)
      monitorMode: 'swing' | 'day'
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

function detectAssetClass(ticker: string): 'stock' | 'forex' | 'crypto' | 'unknown' {
  const t = ticker.toUpperCase()
  // Crypto FIRST — the canonical check knows real coin bases (XRP, ADA…) and
  // excludes fiat (EUR, GBP…), so 6-letter coin pairs like XRPUSD aren't mistaken
  // for forex by the naive 6-letter rule below.
  if (isCryptoPairSymbol(t)) return 'crypto'
  if (isForexTicker(t)) return 'forex'
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
 *
 * Bug fix (June 23, 2026 — LRCX case):
 * The previous version checked "any reason matches bypassable" which was wrong.
 * LRCX was PASSed for TWO reasons: marginal R:R 1.04 AND strong insider sell
 * contradicting BULLISH thesis. The bypass took it as marginal_rr and placed
 * the trade, ignoring the insider signal. Fix: bypass ONLY when ALL pass
 * reasons fall into bypassable categories. A single non-bypassable reason
 * (insider contradiction, confidence floor, missing data, etc.) blocks bypass.
 */
function classifyPassBypass(verdict: VerdictForTrade): {
  category: 'marginal_rr' | 'earnings_window'
  rationale: string
} | null {
  const reasons = Array.isArray(verdict.trader_pass_reasons) ? verdict.trader_pass_reasons : []
  if (reasons.length === 0) return null

  // Pre-compute R:R for use in marginal_rr classification
  const rr = verdict.trader_risk_reward !== null && verdict.trader_risk_reward !== undefined
    ? Number(verdict.trader_risk_reward)
    : null

  // Categorize each reason as one of: 'marginal_rr' | 'earnings_window' | null (non-bypassable)
  // A reason is non-bypassable if it can't be safely overridden by downstream
  // management — insider contradictions, confidence floors, missing data,
  // bear-market regime warnings, etc.
  const categorize = (reason: string): 'marginal_rr' | 'earnings_window' | null => {
    if (typeof reason !== 'string') return null
    // marginal R:R reason — only counts as bypassable if RR is in [1.0, 1.5)
    if (/risk-to-reward|r:r|risk\/reward/i.test(reason)) {
      if (rr !== null && Number.isFinite(rr) && rr >= 1.0 && rr < 1.5) {
        return 'marginal_rr'
      }
      // R:R reason but RR is outside bypassable range → non-bypassable
      return null
    }
    // earnings-window reason
    if (/earnings/i.test(reason)) {
      return 'earnings_window'
    }
    // Everything else is non-bypassable:
    //   - insider signals contradicting verdict
    //   - confidence below floor
    //   - no valid entry/stop/target
    //   - bear-market regime / VIX spikes
    //   - news catalyst risk
    //   - liquidity / spread concerns
    return null
  }

  const categorized = reasons.map(categorize)

  // ALL reasons must be bypassable; one non-bypassable reason blocks the entire bypass.
  if (categorized.some(c => c === null)) {
    return null
  }
  if (categorized.length === 0) return null

  // All reasons are bypassable. Pick the dominant category for the rationale.
  // marginal_rr takes precedence over earnings_window when both are present
  // (R:R math is the deeper concern; earnings is just timing).
  if (categorized.includes('marginal_rr')) {
    return {
      category: 'marginal_rr',
      rationale: `marginal-R:R bypass: ${rr?.toFixed(2) ?? '?'}:1 in [1.0, 1.5), all pass reasons bypassable — half size, monitor closely`,
    }
  }
  return {
    category: 'earnings_window',
    rationale: 'earnings-window bypass: all pass reasons bypassable (timing only), take at half size, monitor manages volatility',
  }
}

/**
 * Classify a Trader WAIT verdict into a bypass category, or null if not eligible.
 *
 * Background (June 23, 2026 — user request):
 * The Trader returns WAIT when the setup is reasonable but the system wants
 * confirmation before entering — typically because confidence is moderate or
 * the entry timing is uncertain. Some WAITs represent real opportunity we miss
 * by waiting (e.g., DELL today: WAIT at 38% conf 1.33 R:R closed +3.41%).
 *
 * WAIT bypass takes a WAIT verdict at HALF size if it meets BOTH quality bars:
 *   - confidence >= 65% (Council has moderate-or-better conviction)
 *   - risk-to-reward >= 1.3 (asymmetric math at least slightly favorable)
 *
 * These thresholds are deliberately stricter than the PASS bypass marginal R:R
 * window because WAIT means "Council was leaning yes but held off" — we want
 * higher conviction signals before overriding that hold.
 *
 * Position-monitor (with new trailing stops) manages downside post-entry.
 * Trailing stops compensate for the lower-conviction entry by locking in
 * gains aggressively if the WAIT thesis plays out.
 *
 * Returns null if WAIT doesn't meet both thresholds — caller treats as normal
 * skip (no trade).
 */
function classifyWaitBypass(verdict: VerdictForTrade): {
  category: 'wait_high_quality'
  rationale: string
} | null {
  const conf = verdict.confidence !== null && verdict.confidence !== undefined
    ? Number(verdict.confidence)
    : null
  const rr = verdict.trader_risk_reward !== null && verdict.trader_risk_reward !== undefined
    ? Number(verdict.trader_risk_reward)
    : null

  if (conf === null || !Number.isFinite(conf)) return null
  if (rr === null || !Number.isFinite(rr)) return null

  // Both thresholds must be met
  const MIN_CONFIDENCE = 65
  const MIN_RR = 1.3
  if (conf < MIN_CONFIDENCE) return null
  if (rr < MIN_RR) return null

  return {
    category: 'wait_high_quality',
    rationale: `wait-bypass: conf=${conf}% >= ${MIN_CONFIDENCE}% AND R:R=${rr.toFixed(2)} >= ${MIN_RR} — half size, trailing stops manage downside`,
  }
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

  // 1. Verdict eligibility — TAKE, qualifying PASS bypass, or qualifying WAIT bypass
  //
  // Bypass union type captures all three flavors:
  //   - PASS bypass (marginal R:R or earnings window, all pass-reasons bypassable)
  //   - WAIT bypass (conf >= 65 AND R:R >= 1.3)
  // Both apply half-size sizing (sizeMultiplier = 0.5) and rely on position-monitor
  // (with trailing stops) to manage downside.
  type BypassInfo =
    | { category: 'marginal_rr' | 'earnings_window'; rationale: string }
    | { category: 'wait_high_quality'; rationale: string }
  let bypass: BypassInfo | null = null

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
  } else if (verdict.trader_decision === 'WAIT') {
    bypass = classifyWaitBypass(verdict)
    if (!bypass) {
      return {
        kind: 'skip',
        reason: `trader_decision=WAIT and not bypass-eligible (need conf>=65 AND R:R>=1.3)`,
        shouldHalt: false,
      }
    }
    // Continue with WAIT bypass — will apply half-sizing at step 11
  } else {
    return {
      kind: 'skip',
      reason: `trader_decision=${verdict.trader_decision} (not TAKE, PASS, or WAIT)`,
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

  // 7. Short gating. BEARISH trades are short (sell-to-open) and stay OFF
  // unless the user opted in. Broker-side gates (shortable symbol, margin
  // account) are enforced at steps 8-9 once we have the asset + account.
  if (side === 'sell' && !settings.allowShorts) {
    return { kind: 'skip', reason: 'short trades disabled (set allowShorts=true to enable BEARISH/short entries)', shouldHalt: false }
  }

  // 8. Symbol normalization + Alpaca tradability
  const symbol = normalizeAlpacaSymbol(verdict.ticker)
  const tradable = await alpaca.assetTradable(symbol)
  if (!tradable.tradable) {
    return { kind: 'skip', reason: `Alpaca: ${tradable.reason ?? 'not tradable'}`, shouldHalt: false }
  }
  // Short locate: the broker must flag the symbol shortable. (Hard-to-borrow
  // names — easyToBorrow=false — are still allowed; only non-shortable blocks.)
  if (side === 'sell' && tradable.shortable === false) {
    return { kind: 'skip', reason: `${symbol} is not shortable on Alpaca (no locate available)`, shouldHalt: false }
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

  // Short account capability: cash accounts (multiplier 1) cannot short, and
  // the account must have shorting enabled. Skip (not halt) — it's a per-trade
  // config issue, not an account-wide emergency.
  if (side === 'sell' && (!account.shorting_enabled || account.multiplier <= 1)) {
    return {
      kind: 'skip',
      reason: `account cannot short (shorting_enabled=${account.shorting_enabled}, multiplier=${account.multiplier}); needs a margin account with shorting enabled`,
      shouldHalt: false,
    }
  }

  // 10. Kill switches
  // Grade A/B verdicts are eligible for bounded overflow past the base concurrent
  // cap (up to OVERFLOW_HARD_CAP). The kill-switch concurrent check honors this
  // higher ceiling; the auto-trade route enforces the cash-only funding gate on
  // any slot beyond settings.maxConcurrentPos. Keep these in sync with the route.
  const OVERFLOW_HARD_CAP = 13
  const OVERFLOW_GRADES = new Set(['A', 'B'])
  const vGrade = (verdict.trader_grade ?? '').toUpperCase()
  const concurrentCapOverride = OVERFLOW_GRADES.has(vGrade)
    ? Math.max(settings.maxConcurrentPos, OVERFLOW_HARD_CAP)
    : undefined
  const killCheck = await evaluateKillSwitches({
    settings,
    account,
    positions,
    ticker: symbol,
    concurrentCapOverride,
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

  // PASS/WAIT bypass: halve the position size. The Trader gated for a reason
  // (marginal R:R, earnings timing, or WAIT quality concerns); we override
  // that gate but cap our per-trade exposure at half normal so any single
  // bypass loss has half the impact.
  // Bypass sizing: half size by default. Exception — an EARNINGS-window bypass
  // is taken at FULL size when the user has opted into trading through earnings
  // (earningsFullSize). marginal_rr and wait_high_quality bypasses always stay
  // half size; only the earnings timing decision is user-overridable here.
  const earningsFull = bypass?.category === 'earnings_window' && settings.earningsFullSize
  // Earnings-window bypasses are force-routed to the day monitor (set on the
  // place result below) regardless of size, so they can be exited intraday.
  const isEarningsBypass = bypass?.category === 'earnings_window'
  const sizeMultiplier = bypass ? (earningsFull ? 1.0 : 0.5) : 1.0
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
    // Per-share price floor: normally $3 (skip penny/illiquid names). Small
    // accounts can opt in to sub-$5 stocks via allowLowPriceShares → floor $0.
    minSharePrice: settings.allowLowPriceShares ? 0 : 3,
    allowFractionalShares: settings.allowFractionalShares,
    traderPositionSizePct: effectiveTraderSize > 0 ? effectiveTraderSize : 1,
    minDollarRiskPerTrade: settings.minDollarRiskPerTrade,
    maxDollarRiskPerTrade: settings.maxDollarRiskPerTrade,
    minTradeNotional: settings.minTradeNotional,
    maxTradeNotional: settings.maxTradeNotional,
    qualityGrade: (grade === 'A' || grade === 'B' || grade === 'C') ? grade : null,
    qualityConfidence: verdict.confidence !== null ? Number(verdict.confidence) : null,
    qualityRiskReward: verdict.trader_risk_reward !== null && verdict.trader_risk_reward !== undefined
      ? Number(verdict.trader_risk_reward) : null,
    smallAccountMode: settings.smallAccountMode,
    smallAccountThreshold: settings.smallAccountThreshold,
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
    fractional: sizing.fractional ?? false,
    entryPrice,
    stopPrice,
    targetPrice,
    dollarRisk: sizing.dollarRisk,
    accountEquity: effectiveEquity,
    rationale: bypass
      ? `[${bypass.category === 'wait_high_quality' ? 'WAIT_BYPASS' : 'PASS_BYPASS'}:${bypass.category}] ${bypass.rationale} | ${sizing.rationale}`
      : sizing.rationale,
    monitorMode: isEarningsBypass ? 'day' : 'swing',
  }
}
