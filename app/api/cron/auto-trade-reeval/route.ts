// =============================================================
// app/api/cron/auto-trade-reeval/route.ts (Session 3b)
//
// Active position re-evaluation using THESIS-CHECK pattern.
// Every 15 min during market hours (cron schedule unchanged from
// existing setup), for each user with activeMgmtEnabled=true:
//
//   1. Fetch open positions across stocks/crypto/futures
//   2. For each position, evaluate materiality triggers (drawdown,
//      news, technical regime, daily close)
//   3. If ANY trigger fires AND cooldown elapsed → call thesis-check
//   4. Execute returned action with asset-class-appropriate path:
//        HOLD          — log only
//        TIGHTEN_STOP  — cancel old stop, place new stop (cancel-and-replace)
//        EARLY_EXIT    — close position at market, cancel stop
//        ADD           — place additional sized order (no stop attached
//                        here — auto-trade-attach-stops worker handles)
//
// SESSION 3B CHANGES from previous reeval:
//   - Handles crypto + futures positions (was equity-only)
//   - TIGHTEN_STOP now ACTUALLY EXECUTES across all three asset classes
//     (previous code logged only for stocks)
//   - EARLY_EXIT cancels the protective stop to avoid orphan orders
//   - ADD supports crypto (notional sizing) and futures (contract sizing)
//   - Futures triggers use underlying ETF proxy ticker for technicals
//     (CL→USO, ES→SPY, etc.) since contract names don't match scanner data
//
// CRON_SECRET gated.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers, type UserTradingSettings, getRiskPerTradePctForAsset } from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse, loadTradovateSession, saveTradovateTokenCache } from '@/app/lib/trading/credentials'
import { makeAlpacaClient, type AlpacaClient, type AlpacaPosition } from '@/app/lib/trading/alpaca-client'
import { makeAlpacaCryptoClient, type AlpacaCryptoClient, type AlpacaCryptoPosition } from '@/app/lib/trading/alpaca-crypto-client'
import { makeTradovateClient, type TradovateClient, type TradovatePosition } from '@/app/lib/trading/tradovate-client'
import { computePositionSize } from '@/app/lib/trading/sizing'
import { computeCryptoSize } from '@/app/lib/trading/crypto-sizing'
import { computeFuturesSize } from '@/app/lib/trading/futures-sizing'
import { getFuturesSpec } from '@/app/lib/trading/futures-sizing'
import { randomBytes } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const REEVAL_COOLDOWN_MIN = 30
const NEWS_LOOKBACK_MIN = 30

interface ReevalSummary {
  users: number
  positionsChecked: number
  triggersFired: number
  holds: number
  tightens: number
  exits: number
  adds: number
  errors: number
  byClass: { stocks: number; crypto: number; futures: number }
  durationMs: number
}

// ─────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const startedAt = Date.now()
  const summary: ReevalSummary = {
    users: 0, positionsChecked: 0, triggersFired: 0,
    holds: 0, tightens: 0, exits: 0, adds: 0, errors: 0,
    byClass: { stocks: 0, crypto: 0, futures: 0 },
    durationMs: 0,
  }

  try {
    const users = (await listEnabledTradingUsers()).filter(s => s.activeMgmtEnabled)
    summary.users = users.length

    for (const settings of users) {
      try {
        await processUser(settings, summary)
      } catch (e) {
        summary.errors++
        console.error(`[reeval] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[reeval cron] done in ${summary.durationMs}ms users=${summary.users} positions=${summary.positionsChecked} triggers=${summary.triggersFired} HOLD=${summary.holds} TIGHTEN=${summary.tightens} EXIT=${summary.exits} ADD=${summary.adds} byClass=${JSON.stringify(summary.byClass)}`)
  return NextResponse.json(summary)
}

async function processUser(settings: UserTradingSettings, summary: ReevalSummary): Promise<void> {
  // Fetch attempts grouped by asset class so we know which brokers to load
  const [equityAttempts, cryptoAttempts, futuresAttempts] = await Promise.all([
    getOpenAttemptsForUser(settings.userId, 'stocks'),
    getOpenAttemptsForUser(settings.userId, 'crypto'),
    getOpenAttemptsForUser(settings.userId, 'futures'),
  ])

  if (equityAttempts.length > 0) await processEquityReeval(settings, equityAttempts, summary)
  if (cryptoAttempts.length > 0) await processCryptoReeval(settings, cryptoAttempts, summary)
  if (futuresAttempts.length > 0) await processFuturesReeval(settings, futuresAttempts, summary)
}

// ─────────────────────────────────────────────────────────────
// Open-attempts fetch (asset-class-aware)
// ─────────────────────────────────────────────────────────────

interface OpenAttempt {
  id: string
  user_id: string
  asset_class: string | null
  ticker: string
  side: 'buy' | 'sell' | null
  qty: number | null
  filled_avg_price: number | null
  entry_price_est: number | null
  stop_price: number | null
  target_price: number | null
  broker_order_id: string | null
  stop_order_id: string | null
  council_signal: string | null
  verdict_log_id: number | null
  outcome: string
  reeval_count: number
  last_reeval_at: string | null
  reeval_history: unknown[]
  signal_source: string
  created_at: string
}

async function getOpenAttemptsForUser(
  userId: string,
  assetClass: 'stocks' | 'crypto' | 'futures',
): Promise<OpenAttempt[]> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  let q = admin
    .from('trade_attempts')
    .select('id, user_id, asset_class, ticker, side, qty, filled_avg_price, entry_price_est, stop_price, target_price, broker_order_id, stop_order_id, council_signal, verdict_log_id, outcome, reeval_count, last_reeval_at, reeval_history, signal_source, created_at')
    .eq('user_id', userId)
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .gte('created_at', cutoff)

  if (assetClass === 'stocks') q = q.or('asset_class.is.null,asset_class.eq.stocks')
  else q = q.eq('asset_class', assetClass)

  const { data, error } = await q
  if (error || !data) return []
  return (data as Array<Record<string, unknown>>).map(d => ({
    id: String(d.id),
    user_id: String(d.user_id),
    asset_class: d.asset_class !== null && d.asset_class !== undefined ? String(d.asset_class) : null,
    ticker: String(d.ticker),
    side: (d.side as 'buy' | 'sell' | null) ?? null,
    qty: d.qty !== null && d.qty !== undefined ? Number(d.qty) : null,
    filled_avg_price: d.filled_avg_price !== null && d.filled_avg_price !== undefined ? Number(d.filled_avg_price) : null,
    entry_price_est: d.entry_price_est !== null && d.entry_price_est !== undefined ? Number(d.entry_price_est) : null,
    stop_price: d.stop_price !== null && d.stop_price !== undefined ? Number(d.stop_price) : null,
    target_price: d.target_price !== null && d.target_price !== undefined ? Number(d.target_price) : null,
    broker_order_id: d.broker_order_id !== null && d.broker_order_id !== undefined ? String(d.broker_order_id) : null,
    stop_order_id: d.stop_order_id !== null && d.stop_order_id !== undefined ? String(d.stop_order_id) : null,
    council_signal: d.council_signal !== null ? String(d.council_signal) : null,
    verdict_log_id: d.verdict_log_id !== null && d.verdict_log_id !== undefined ? Number(d.verdict_log_id) : null,
    outcome: String(d.outcome),
    reeval_count: Number(d.reeval_count ?? 0),
    last_reeval_at: d.last_reeval_at !== null ? String(d.last_reeval_at) : null,
    reeval_history: Array.isArray(d.reeval_history) ? d.reeval_history : [],
    signal_source: String(d.signal_source ?? 'council'),
    created_at: String(d.created_at),
  }))
}

// ─────────────────────────────────────────────────────────────
// EQUITY reeval (preserves existing behavior + adds real TIGHTEN_STOP)
// ─────────────────────────────────────────────────────────────

async function processEquityReeval(
  settings: UserTradingSettings,
  attempts: OpenAttempt[],
  summary: ReevalSummary,
): Promise<void> {
  const credLoad = await loadBrokerCredentialForUse(settings.userId, settings.broker, settings.mode)
  if (!credLoad) return
  const alpaca = makeAlpacaClient(credLoad.keyId, credLoad.secret, settings.mode)

  const positions = await alpaca.positions().catch(() => [] as AlpacaPosition[])

  for (const pos of positions) {
    summary.positionsChecked++
    summary.byClass.stocks++
    const att = attempts.find(a => a.ticker.toUpperCase() === pos.symbol.toUpperCase())
    if (!att) continue

    if (await isInCooldown(att)) continue

    const triggers = await evaluateTriggers(settings, att, pos.current_price, pos.avg_entry_price, att.ticker)
    if (triggers.length === 0) continue
    summary.triggersFired++

    const decision = await runThesisCheckAndMap(settings, att, pos.current_price, pos.qty, pos.avg_entry_price, triggers)
    await executeEquityDecision(decision, settings, alpaca, pos, att, summary)
    await updateReevalTracking(att.id, triggers, decision.action, decision.rationale)
  }
}

async function executeEquityDecision(
  decision: ExecDecision,
  settings: UserTradingSettings,
  alpaca: AlpacaClient,
  position: AlpacaPosition,
  attempt: OpenAttempt,
  summary: ReevalSummary,
): Promise<void> {
  const { action, rationale, triggers } = decision
  const admin = await getSupabaseAdmin()

  if (action === 'HOLD') {
    await logReevalAction(attempt, settings, 'reeval_hold', `${triggers.join('; ')}. ${rationale.slice(0, 300)}`)
    summary.holds++; return
  }

  if (action === 'TIGHTEN_STOP') {
    const entry = attempt.filled_avg_price ?? attempt.entry_price_est ?? position.avg_entry_price
    const current = position.current_price
    const newStop = attempt.side === 'buy'
      ? Math.max(entry, (entry + current) / 2)
      : Math.min(entry, (entry + current) / 2)
    // Modify the stop_loss leg of the bracket parent. Alpaca supports PATCH on
    // active stop orders. If PATCH fails, fall back to logging.
    if (!attempt.broker_order_id) {
      await logReevalAction(attempt, settings, 'reeval_tighten_stop',
        `proposed newStop=${newStop.toFixed(2)} but no broker_order_id; ${rationale.slice(0, 200)}`)
      summary.tightens++; return
    }
    const tightened = await tightenEquityStop(alpaca, attempt.broker_order_id, newStop)
    const status = tightened.ok ? `tightened to ${newStop.toFixed(2)}` : `tighten failed: ${tightened.reason}`
    await logReevalAction(attempt, settings, 'reeval_tighten_stop',
      `${status}; triggers: ${triggers.join('; ')}. ${rationale.slice(0, 200)}`,
      { stop_price: newStop })
    console.log(`[reeval] equity TIGHTEN_STOP ${attempt.ticker} entry=${entry} current=${current} newStop=${newStop.toFixed(2)} ${tightened.ok ? 'OK' : 'FAIL'}`)
    summary.tightens++; return
  }

  if (action === 'EARLY_EXIT') {
    try {
      // Use raw delete on /v2/positions/{symbol} via the alpaca client's request method
      await (alpaca as unknown as { request: (m: string, p: string) => Promise<unknown> })
        .request('DELETE', `/v2/positions/${encodeURIComponent(position.symbol)}`)
      await logReevalAction(attempt, settings, 'reeval_early_exit',
        `triggers: ${triggers.join('; ')}. ${rationale.slice(0, 300)}`,
        { side: 'sell', qty: Math.abs(position.qty), entry_price_est: position.current_price })
      console.log(`[reeval] equity EARLY_EXIT ${attempt.ticker} closed at ~${position.current_price}`)
      summary.exits++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await admin.from('trade_attempts').insert({
        user_id: settings.userId, ticker: attempt.ticker, outcome: 'error',
        reject_reason: `EARLY_EXIT failed: ${msg.slice(0, 300)}`,
        mode: settings.mode, broker: settings.broker, signal_source: attempt.signal_source,
        original_attempt_id: attempt.id,
      })
      summary.errors++
    }
    return
  }

  if (action === 'ADD') {
    const account = await alpaca.account()
    const entry = position.current_price
    const stop = attempt.stop_price ?? entry * 0.97
    const sizing = computePositionSize({
      accountEquity: account.equity,
      riskPerTradePct: settings.riskPerTradePct * 0.5,
      maxPositionPct: settings.maxPositionPct,
      entryPrice: entry,
      stopPrice: stop,
      traderPositionSizePct: 0.5,
    })
    if (!sizing.ok) {
      await logReevalAction(attempt, settings, 'skipped', `ADD sizing failed: ${sizing.reason}`)
      summary.errors++; return
    }
    const clientOrderId = `reev-${attempt.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`
    try {
      const order = await alpaca.bracketOrder({
        symbol: position.symbol,
        qty: sizing.qty,
        side: (attempt.side ?? 'buy') as 'buy' | 'sell',
        takeProfitPrice: attempt.target_price ?? entry * 1.05,
        stopLossPrice: stop,
        clientOrderId,
      })
      await admin.from('trade_attempts').insert({
        user_id: settings.userId, ticker: attempt.ticker, asset_class: 'stocks',
        outcome: 'reeval_add',
        reject_reason: `ADD on continuation; triggers: ${triggers.join('; ')}. ${rationale.slice(0, 200)}`,
        mode: settings.mode, broker: settings.broker, signal_source: 'reeval_add',
        original_attempt_id: attempt.id,
        broker_order_id: order.id, broker_client_id: clientOrderId,
        side: attempt.side, qty: sizing.qty, entry_price_est: entry,
        stop_price: stop, target_price: attempt.target_price,
        risk_dollar_amount: sizing.dollarRisk, account_equity_at: account.equity,
      })
      console.log(`[reeval] equity ADD ${attempt.ticker} +${sizing.qty} shares risk=$${sizing.dollarRisk.toFixed(2)}`)
      summary.adds++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[reeval] equity ADD failed for ${attempt.ticker}:`, msg.slice(0, 200))
      summary.errors++
    }
    return
  }
}

/**
 * Tighten the stop_loss leg of an Alpaca bracket order via PATCH.
 * Returns ok=true on success. Falls back to log-only on failure.
 */
async function tightenEquityStop(
  alpaca: AlpacaClient,
  parentOrderId: string,
  newStopPrice: number,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const parent = await alpaca.getOrder(parentOrderId) as unknown as { legs?: Array<{ id: string; type?: string; order_type?: string; order_class?: string; status?: string }> }
    const legs = parent.legs ?? []
    // Find stop_loss leg — it's the one with type/order_type 'stop' or 'stop_limit' that's still active
    const stopLeg = legs.find(l => {
      const t = (l.type ?? l.order_type ?? '').toLowerCase()
      const s = (l.status ?? '').toLowerCase()
      return (t === 'stop' || t === 'stop_limit') && (s === 'new' || s === 'accepted' || s === 'held' || s === 'pending_new')
    })
    if (!stopLeg) return { ok: false, reason: 'no active stop leg found on parent' }
    // PATCH the stop leg
    await (alpaca as unknown as { request: (m: string, p: string, body?: unknown) => Promise<unknown> })
      .request('PATCH', `/v2/orders/${encodeURIComponent(stopLeg.id)}`, { stop_price: newStopPrice.toFixed(2) })
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: msg.slice(0, 200) }
  }
}

// ─────────────────────────────────────────────────────────────
// CRYPTO reeval
// ─────────────────────────────────────────────────────────────

async function processCryptoReeval(
  settings: UserTradingSettings,
  attempts: OpenAttempt[],
  summary: ReevalSummary,
): Promise<void> {
  const credLoad = await loadBrokerCredentialForUse(settings.userId, 'alpaca', settings.mode, 'crypto')
  if (!credLoad) return
  const alpaca = makeAlpacaCryptoClient(credLoad.keyId, credLoad.secret, settings.mode)

  const positions = await alpaca.positions().catch(() => [] as AlpacaCryptoPosition[])
  const posBySymbol = new Map<string, AlpacaCryptoPosition>(positions.map(p => [normalizeCryptoSymbol(p.symbol), p]))

  for (const att of attempts) {
    const pos = posBySymbol.get(normalizeCryptoSymbol(att.ticker))
    if (!pos) continue
    summary.positionsChecked++
    summary.byClass.crypto++

    if (await isInCooldown(att)) continue

    const triggers = await evaluateTriggers(settings, att, pos.current_price, pos.avg_entry_price, att.ticker)
    if (triggers.length === 0) continue
    summary.triggersFired++

    const decision = await runThesisCheckAndMap(settings, att, pos.current_price, pos.qty, pos.avg_entry_price, triggers)
    await executeCryptoDecision(decision, settings, alpaca, pos, att, summary)
    await updateReevalTracking(att.id, triggers, decision.action, decision.rationale)
  }
}

async function executeCryptoDecision(
  decision: ExecDecision,
  settings: UserTradingSettings,
  alpaca: AlpacaCryptoClient,
  position: AlpacaCryptoPosition,
  attempt: OpenAttempt,
  summary: ReevalSummary,
): Promise<void> {
  const { action, rationale, triggers } = decision
  const admin = await getSupabaseAdmin()

  if (action === 'HOLD') {
    await logReevalAction(attempt, settings, 'reeval_hold', `${triggers.join('; ')}. ${rationale.slice(0, 300)}`)
    summary.holds++; return
  }

  if (action === 'TIGHTEN_STOP') {
    const entry = attempt.filled_avg_price ?? attempt.entry_price_est ?? position.avg_entry_price
    const current = position.current_price
    // Crypto is long-only: new stop is midpoint between entry and current, floored at entry
    const newStop = Math.max(entry, (entry + current) / 2)
    if (!attempt.stop_order_id) {
      // No existing broker stop — log and let attach-stops pick it up with the new value
      await logReevalAction(attempt, settings, 'reeval_tighten_stop',
        `no stop_order_id to modify; logged newStop=${newStop.toFixed(2)}; ${rationale.slice(0, 200)}`,
        { stop_price: newStop })
      summary.tightens++; return
    }
    // Cancel old, place new — update stop_order_id
    const cancelResult = await alpaca.cancelOrder(attempt.stop_order_id)
    if (!cancelResult.ok) {
      console.warn(`[reeval] crypto TIGHTEN_STOP cancel failed for ${attempt.ticker}: ${cancelResult.reason}`)
    }
    const newClientId = `wos-tstop-${attempt.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`
    try {
      const newStopOrder = await alpaca.stopLimitSell({
        symbol: pickCanonicalCryptoSymbol(position.symbol, attempt.ticker),
        qty: position.qty,
        stopPrice: newStop,
        clientOrderId: newClientId,
      })
      // Update the original attempt's stop_order_id and stop_price
      await admin.from('trade_attempts')
        .update({ stop_order_id: newStopOrder.id, stop_price: newStop, council_stop: newStop })
        .eq('id', attempt.id)
      await logReevalAction(attempt, settings, 'reeval_tighten_stop',
        `tightened to ${newStop.toFixed(2)} (cancel:${cancelResult.ok ? 'ok' : 'fail'}); ${rationale.slice(0, 200)}`,
        { stop_price: newStop })
      console.log(`[reeval] crypto TIGHTEN_STOP ${attempt.ticker} entry=${entry} current=${current} newStop=${newStop.toFixed(2)} OK`)
      summary.tightens++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Position is now stop-less. Mark attempt for attach-stops worker to pick up.
      await admin.from('trade_attempts')
        .update({ stop_order_id: null, stop_attach_attempts: 0, stop_price: newStop, council_stop: newStop })
        .eq('id', attempt.id)
      await logReevalAction(attempt, settings, 'error',
        `crypto TIGHTEN_STOP placement failed: ${msg.slice(0, 300)} — attach-stops will retry`)
      console.warn(`[reeval] crypto TIGHTEN_STOP new stop placement failed for ${attempt.ticker}: ${msg.slice(0, 200)} — flagged for attach-stops retry`)
      summary.errors++
    }
    return
  }

  if (action === 'EARLY_EXIT') {
    // Close position first, then cancel stop to avoid stop firing on no-position
    try {
      await alpaca.closePosition(position.symbol)
      if (attempt.stop_order_id) {
        const cancelResult = await alpaca.cancelOrder(attempt.stop_order_id)
        if (!cancelResult.ok) {
          console.warn(`[reeval] crypto EARLY_EXIT stop cancel warning for ${attempt.ticker}: ${cancelResult.reason}`)
        }
      }
      await logReevalAction(attempt, settings, 'reeval_early_exit',
        `triggers: ${triggers.join('; ')}. ${rationale.slice(0, 300)}`,
        { side: 'sell', qty: position.qty, entry_price_est: position.current_price })
      console.log(`[reeval] crypto EARLY_EXIT ${attempt.ticker} closed at ~${position.current_price}`)
      summary.exits++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await admin.from('trade_attempts').insert({
        user_id: settings.userId, ticker: attempt.ticker, asset_class: 'crypto',
        outcome: 'error',
        reject_reason: `crypto EARLY_EXIT failed: ${msg.slice(0, 300)}`,
        mode: settings.mode, broker: 'alpaca', signal_source: attempt.signal_source,
        original_attempt_id: attempt.id,
      })
      summary.errors++
    }
    return
  }

  if (action === 'ADD') {
    const account = await alpaca.account()
    if (!account || account.equity <= 0) {
      await logReevalAction(attempt, settings, 'skipped', `ADD: account equity <= 0`)
      summary.errors++; return
    }
    const entry = position.current_price
    const stop = attempt.stop_price ?? entry * 0.97
    const sizing = computeCryptoSize({
      accountEquity: account.equity,
      riskPerTradePct: getRiskPerTradePctForAsset(settings, 'crypto') * 0.5,
      maxPositionPct: settings.maxPositionPct,
      entryPrice: entry,
      stopPrice: stop,
      traderPositionSizePct: 0.5,
    })
    if (!sizing.ok) {
      await logReevalAction(attempt, settings, 'skipped', `ADD sizing failed: ${sizing.reason}`)
      summary.errors++; return
    }
    const clientOrderId = `reev-c-${attempt.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`
    try {
      const order = await alpaca.marketEntry({
        symbol: pickCanonicalCryptoSymbol(position.symbol, attempt.ticker),
        notionalUsd: sizing.notionalUsd,
        side: 'buy',
        clientOrderId,
      })
      await admin.from('trade_attempts').insert({
        user_id: settings.userId,
        ticker: pickCanonicalCryptoSymbol(position.symbol, attempt.ticker),
        asset_class: 'crypto',
        council_signal: attempt.council_signal, council_entry: entry,
        council_stop: stop, council_target: attempt.target_price,
        outcome: 'reeval_add',
        reject_reason: `ADD on continuation; triggers: ${triggers.join('; ')}. ${rationale.slice(0, 200)}`,
        mode: settings.mode, broker: 'alpaca', signal_source: 'reeval_add',
        original_attempt_id: attempt.id,
        broker_order_id: order.id, broker_client_id: clientOrderId,
        side: 'buy', qty: sizing.units, entry_price_est: entry,
        stop_price: stop, target_price: attempt.target_price,
        risk_dollar_amount: sizing.dollarRisk, account_equity_at: account.equity,
      })
      // New attempt has no stop_order_id — attach-stops worker will pick it up
      console.log(`[reeval] crypto ADD ${attempt.ticker} +$${sizing.notionalUsd.toFixed(2)} (attach-stops will handle protective stop)`)
      summary.adds++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[reeval] crypto ADD failed for ${attempt.ticker}:`, msg.slice(0, 200))
      summary.errors++
    }
    return
  }
}

function normalizeCryptoSymbol(sym: string): string {
  return sym.replace('/', '').toUpperCase()
}

/**
 * When placing an order, Alpaca crypto expects symbols WITH slash ("BTC/USD").
 * Positions API returns without slash ("BTCUSD"). Prefer the attempt's stored
 * ticker (which is canonical "BTC/USD") if it includes a slash; otherwise
 * derive a slashed form from the position symbol.
 */
function pickCanonicalCryptoSymbol(positionSym: string, attemptTicker: string): string {
  if (attemptTicker.includes('/')) return attemptTicker.toUpperCase()
  // Position symbol is "BTCUSD" — split before "USD" or "USDT"
  const upper = positionSym.toUpperCase()
  for (const quote of ['USDT', 'USDC', 'USD']) {
    if (upper.endsWith(quote)) {
      return `${upper.slice(0, -quote.length)}/${quote}`
    }
  }
  return upper
}

// ─────────────────────────────────────────────────────────────
// FUTURES reeval
// ─────────────────────────────────────────────────────────────

async function processFuturesReeval(
  settings: UserTradingSettings,
  attempts: OpenAttempt[],
  summary: ReevalSummary,
): Promise<void> {
  const session = await loadTradovateSession(settings.userId, settings.mode)
  if (!session || session.accountSpec === null || session.accountIntId === null) return

  const tradovate = makeTradovateClient({
    mode: settings.mode,
    credentials: {
      username: session.username, password: session.password,
      appId: session.appId, appVersion: session.appVersion,
      cid: session.cid, sec: session.sec,
    },
    accountSpec: session.accountSpec, accountIntId: session.accountIntId,
    cachedAccessToken: session.cachedAccessToken,
    cachedExpiresAt: session.cachedTokenExpiresAt,
    onTokenRefreshed: async (token, expiresAt) => {
      await saveTradovateTokenCache(session.credentialRowId, token, expiresAt)
    },
  })

  const positions = await tradovate.positions().catch(() => [] as TradovatePosition[])
  const positionsByContractId = new Map<number, TradovatePosition>(positions.map(p => [p.contractId, p]))
  const contractCache = new Map<string, { id: number; name: string } | null>()

  for (const att of attempts) {
    if (!att.ticker || att.ticker.length < 3) continue
    const root = att.ticker.slice(0, -2)
    let contract = contractCache.get(root)
    if (contract === undefined) {
      const resolved = await tradovate.findFrontMonthContract(root)
      contract = resolved ? { id: resolved.id, name: resolved.name } : null
      contractCache.set(root, contract)
    }
    if (!contract || contract.name !== att.ticker) continue

    const pos = positionsByContractId.get(contract.id)
    if (!pos || pos.netPos === 0) continue
    summary.positionsChecked++
    summary.byClass.futures++

    if (await isInCooldown(att)) continue

    const currentPrice = pos.prevPrice ?? pos.netPrice ?? att.entry_price_est ?? 0
    if (currentPrice <= 0) continue

    // Use proxy ETF ticker for technicals (CL→USO, ES→SPY, etc.)
    const proxyTicker = getFuturesSpec(root)?.dataLayer?.underlyingEtfProxy ?? null
    const triggerTicker = proxyTicker ?? att.ticker
    const triggers = await evaluateTriggers(settings, att, currentPrice, pos.netPrice ?? currentPrice, triggerTicker)
    if (triggers.length === 0) continue
    summary.triggersFired++

    const decision = await runThesisCheckAndMap(settings, att, currentPrice, Math.abs(pos.netPos), pos.netPrice ?? currentPrice, triggers)
    await executeFuturesDecision(decision, settings, tradovate, contract.id, pos, att, summary)
    await updateReevalTracking(att.id, triggers, decision.action, decision.rationale)
  }
}

async function executeFuturesDecision(
  decision: ExecDecision,
  settings: UserTradingSettings,
  tradovate: TradovateClient,
  contractId: number,
  position: TradovatePosition,
  attempt: OpenAttempt,
  summary: ReevalSummary,
): Promise<void> {
  const { action, rationale, triggers } = decision
  const admin = await getSupabaseAdmin()
  const longSide = position.netPos > 0

  if (action === 'HOLD') {
    await logReevalAction(attempt, settings, 'reeval_hold', `${triggers.join('; ')}. ${rationale.slice(0, 300)}`)
    summary.holds++; return
  }

  if (action === 'TIGHTEN_STOP') {
    const entry = attempt.filled_avg_price ?? attempt.entry_price_est ?? position.netPrice ?? 0
    const current = position.prevPrice ?? position.netPrice ?? entry
    if (entry === 0) {
      await logReevalAction(attempt, settings, 'reeval_tighten_stop', `no entry price; cannot compute newStop`)
      summary.errors++; return
    }
    const newStop = longSide
      ? Math.max(entry, (entry + current) / 2)
      : Math.min(entry, (entry + current) / 2)

    if (!attempt.stop_order_id) {
      // No existing broker stop — leave for attach-stops worker
      await admin.from('trade_attempts')
        .update({ stop_price: newStop, council_stop: newStop })
        .eq('id', attempt.id)
      await logReevalAction(attempt, settings, 'reeval_tighten_stop',
        `no stop_order_id; logged newStop=${newStop.toFixed(2)}`,
        { stop_price: newStop })
      summary.tightens++; return
    }
    const stopOrderIdNum = Number(attempt.stop_order_id)
    if (!Number.isFinite(stopOrderIdNum)) {
      await logReevalAction(attempt, settings, 'error', `invalid stop_order_id: ${attempt.stop_order_id}`)
      summary.errors++; return
    }
    // Cancel old stop
    const cancelResult = await tradovate.cancelOrder(stopOrderIdNum)
    if (!cancelResult.ok) {
      console.warn(`[reeval] futures TIGHTEN_STOP cancel failed for ${attempt.ticker}: ${cancelResult.reason}`)
    }
    // Place new stop
    try {
      const stopAction: 'Buy' | 'Sell' = longSide ? 'Sell' : 'Buy'
      const result = await tradovate.placeOrder({
        contractId, action: stopAction, qty: Math.abs(position.netPos),
        orderType: 'Stop', price: newStop, isAutomated: true,
      })
      if (result.failureReason || result.failureText) {
        await admin.from('trade_attempts')
          .update({ stop_order_id: null, stop_attach_attempts: 0, stop_price: newStop, council_stop: newStop })
          .eq('id', attempt.id)
        await logReevalAction(attempt, settings, 'error',
          `futures TIGHTEN_STOP new placement rejected: ${result.failureReason} — attach-stops will retry`)
        summary.errors++; return
      }
      const newStopOrderId = result.orderId ? String(result.orderId) : null
      await admin.from('trade_attempts')
        .update({ stop_order_id: newStopOrderId, stop_price: newStop, council_stop: newStop })
        .eq('id', attempt.id)
      await logReevalAction(attempt, settings, 'reeval_tighten_stop',
        `tightened to ${newStop.toFixed(2)} (cancel:${cancelResult.ok ? 'ok' : 'fail'}); ${rationale.slice(0, 200)}`,
        { stop_price: newStop })
      console.log(`[reeval] futures TIGHTEN_STOP ${attempt.ticker} entry=${entry} newStop=${newStop.toFixed(2)} OK`)
      summary.tightens++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await admin.from('trade_attempts')
        .update({ stop_order_id: null, stop_attach_attempts: 0, stop_price: newStop, council_stop: newStop })
        .eq('id', attempt.id)
      await logReevalAction(attempt, settings, 'error',
        `futures TIGHTEN_STOP placement error: ${msg.slice(0, 300)} — attach-stops will retry`)
      summary.errors++
    }
    return
  }

  if (action === 'EARLY_EXIT') {
    try {
      const closeResult = await tradovate.closePositionMarket(contractId, position.netPos)
      if (closeResult.failureReason || closeResult.failureText) {
        await admin.from('trade_attempts').insert({
          user_id: settings.userId, ticker: attempt.ticker, asset_class: 'futures',
          outcome: 'error',
          reject_reason: `futures EARLY_EXIT rejected: ${closeResult.failureReason}: ${closeResult.failureText}`,
          mode: settings.mode, broker: 'tradovate', signal_source: attempt.signal_source,
          original_attempt_id: attempt.id,
        })
        summary.errors++; return
      }
      if (attempt.stop_order_id) {
        const stopIdNum = Number(attempt.stop_order_id)
        if (Number.isFinite(stopIdNum)) {
          const cancelResult = await tradovate.cancelOrder(stopIdNum)
          if (!cancelResult.ok) {
            console.warn(`[reeval] futures EARLY_EXIT stop cancel warning: ${cancelResult.reason}`)
          }
        }
      }
      await logReevalAction(attempt, settings, 'reeval_early_exit',
        `triggers: ${triggers.join('; ')}. ${rationale.slice(0, 300)}`,
        { side: longSide ? 'sell' : 'buy', qty: Math.abs(position.netPos),
          entry_price_est: position.prevPrice ?? position.netPrice ?? undefined })
      console.log(`[reeval] futures EARLY_EXIT ${attempt.ticker} closed`)
      summary.exits++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await admin.from('trade_attempts').insert({
        user_id: settings.userId, ticker: attempt.ticker, asset_class: 'futures',
        outcome: 'error',
        reject_reason: `futures EARLY_EXIT failed: ${msg.slice(0, 300)}`,
        mode: settings.mode, broker: 'tradovate', signal_source: attempt.signal_source,
        original_attempt_id: attempt.id,
      })
      summary.errors++
    }
    return
  }

  if (action === 'ADD') {
    const cash = await tradovate.cashSummary().catch(() => null)
    if (!cash || cash.totalCashValue <= 0) {
      await logReevalAction(attempt, settings, 'skipped', `ADD: futures cash <= 0`)
      summary.errors++; return
    }
    const entry = position.prevPrice ?? position.netPrice ?? attempt.entry_price_est ?? 0
    const stop = attempt.stop_price ?? (longSide ? entry * 0.97 : entry * 1.03)
    if (entry === 0) {
      await logReevalAction(attempt, settings, 'skipped', `ADD: no entry reference`)
      summary.errors++; return
    }
    const root = attempt.ticker.slice(0, -2)
    const sizing = computeFuturesSize({
      accountEquity: cash.totalCashValue,
      riskPerTradePct: getRiskPerTradePctForAsset(settings, 'futures') * 0.5,
      maxPositionPct: settings.maxPositionPct,
      entryPrice: entry,
      stopPrice: stop,
      rootSymbol: root,
      traderPositionSizePct: 0.5,
    })
    if (!sizing.ok) {
      await logReevalAction(attempt, settings, 'skipped', `futures ADD sizing failed: ${sizing.reason}`)
      summary.errors++; return
    }
    const clientOrderId = `reev-fut-${attempt.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`
    try {
      const result = await tradovate.placeOrder({
        contractId,
        action: longSide ? 'Buy' : 'Sell',
        qty: sizing.contracts,
        orderType: 'Market',
        isAutomated: true,
      })
      if (result.failureReason || result.failureText) {
        await logReevalAction(attempt, settings, 'error',
          `futures ADD rejected: ${result.failureReason}: ${result.failureText}`)
        summary.errors++; return
      }
      await admin.from('trade_attempts').insert({
        user_id: settings.userId, ticker: attempt.ticker, asset_class: 'futures',
        council_signal: attempt.council_signal, council_entry: entry,
        council_stop: stop, council_target: attempt.target_price,
        outcome: 'reeval_add',
        reject_reason: `ADD on continuation; triggers: ${triggers.join('; ')}. ${rationale.slice(0, 200)}`,
        mode: settings.mode, broker: 'tradovate', signal_source: 'reeval_add',
        original_attempt_id: attempt.id,
        broker_order_id: result.orderId ? String(result.orderId) : null, broker_client_id: clientOrderId,
        side: longSide ? 'buy' : 'sell', qty: sizing.contracts, entry_price_est: entry,
        stop_price: stop, target_price: attempt.target_price,
        risk_dollar_amount: sizing.totalDollarRisk, account_equity_at: cash.totalCashValue,
      })
      // New attempt — no stop_order_id; attach-stops will pick it up
      console.log(`[reeval] futures ADD ${attempt.ticker} +${sizing.contracts}× (attach-stops will handle protective stop)`)
      summary.adds++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.warn(`[reeval] futures ADD failed for ${attempt.ticker}:`, msg.slice(0, 200))
      summary.errors++
    }
    return
  }
}

// ─────────────────────────────────────────────────────────────
// Trigger evaluation (asset-class-agnostic, uses passed-in ticker)
// ─────────────────────────────────────────────────────────────

async function evaluateTriggers(
  settings: UserTradingSettings,
  att: OpenAttempt,
  currentPrice: number,
  positionEntryPrice: number,
  triggerTicker: string,  // ticker to use for technicals/news (proxy for futures)
): Promise<string[]> {
  const triggers: string[] = []

  // 1. Drawdown trigger
  const entryPrice = att.filled_avg_price ?? att.entry_price_est ?? positionEntryPrice
  const stopPrice = att.stop_price
  if (entryPrice && stopPrice && currentPrice && entryPrice > 0) {
    const stopDistance = Math.abs(entryPrice - stopPrice)
    if (stopDistance > 0) {
      const adverseMove = att.side === 'buy'
        ? Math.max(0, entryPrice - currentPrice)
        : Math.max(0, currentPrice - entryPrice)
      const drawdownPct = adverseMove / stopDistance
      if (drawdownPct >= settings.reevalDrawdownPct) {
        triggers.push(`drawdown ${(drawdownPct * 100).toFixed(0)}% of stop distance`)
      }
    }
  }

  // 2. News trigger (matches on trigger ticker, which is proxy for futures)
  try {
    const admin = await getSupabaseAdmin()
    const cutoff = new Date(Date.now() - NEWS_LOOKBACK_MIN * 60_000).toISOString()
    const { count } = await admin
      .from('news_cache')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', cutoff)
      .ilike('headline', `%${triggerTicker}%`)
    if ((count ?? 0) > 0) triggers.push(`fresh news mention (last ${NEWS_LOOKBACK_MIN}m)`)
  } catch { /* ignore */ }

  // 3. Technical regime trigger (uses proxy ticker for futures)
  try {
    const { computeTickerTechnicals } = await import('@/app/lib/scanner-engine')
    const tech = await computeTickerTechnicals(triggerTicker)
    if (tech && tech.technicals) {
      const t = tech.technicals
      if (att.side === 'buy' && t.priceVsSma50 < 0 && t.priceChange1D < -1) {
        triggers.push('broke SMA50 with negative day')
      }
      if (att.side === 'buy' && t.macdCrossover === 'bearish') {
        triggers.push('MACD bearish cross')
      }
    }
  } catch { /* best-effort */ }

  // 4. Daily-close trigger (1D timeframe attempts only — futures runs 24/5 so daily-close is meaningful)
  const utcHour = new Date().getUTCHours()
  const utcMin = new Date().getUTCMinutes()
  const isClose = utcHour === 20 && utcMin >= 50
  if (isClose) triggers.push('daily-close re-eval')

  return triggers
}

// ─────────────────────────────────────────────────────────────
// Thesis-check call + action mapping
// ─────────────────────────────────────────────────────────────

interface ThesisCheckResult {
  ok: boolean
  thesisStatus: 'intact' | 'weakened' | 'invalidated'
  action: 'hold' | 'tighten_stop' | 'early_exit' | 'add'
  confidence: number
  rationale: string
}

interface ExecDecision {
  action: 'HOLD' | 'TIGHTEN_STOP' | 'EARLY_EXIT' | 'ADD'
  rationale: string
  triggers: string[]
}

async function runThesisCheckAndMap(
  settings: UserTradingSettings,
  att: OpenAttempt,
  currentPrice: number,
  positionQty: number,
  positionEntryPrice: number,
  triggers: string[],
): Promise<ExecDecision> {
  if (!att.verdict_log_id) {
    return { action: 'HOLD', rationale: 'no verdict_log_id linkage; cannot run thesis-check', triggers }
  }
  let action: 'HOLD' | 'TIGHTEN_STOP' | 'EARLY_EXIT' | 'ADD' = 'HOLD'
  let rationale = ''
  try {
    const tc = await callThesisCheck(settings.userId, att, currentPrice, positionQty, positionEntryPrice, triggers)
    if (tc) {
      action = mapThesisAction(tc.action, settings, tc.thesisStatus)
      rationale = `[thesis-check ${tc.thesisStatus}, conf ${tc.confidence}] ${tc.rationale}`
    } else {
      rationale = 'thesis-check returned null; defaulting HOLD'
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[reeval] thesis-check failed for ${att.ticker}:`, msg.slice(0, 200))
    action = 'HOLD'
    rationale = `thesis-check error: ${msg.slice(0, 200)}`
  }
  return { action, rationale, triggers }
}

async function callThesisCheck(
  userId: string,
  att: OpenAttempt,
  currentPrice: number,
  positionQty: number,
  positionEntryPrice: number,
  triggers: string[],
): Promise<ThesisCheckResult | null> {
  const baseUrl = process.env.APP_BASE_URL ?? ''
  if (!baseUrl) {
    console.warn('[reeval] APP_BASE_URL not set; cannot call thesis-check')
    return null
  }
  const technicals = await fetchFreshTechnicals(att.ticker)
  const headlines = await fetchFreshNewsHeadlines(att.ticker)
  const entryPrice = att.filled_avg_price ?? att.entry_price_est ?? positionEntryPrice
  const unrealizedPnlPct = entryPrice > 0 && positionQty > 0
    ? ((currentPrice - entryPrice) / entryPrice) * 100 * (att.side === 'sell' ? -1 : 1)
    : 0
  const ctrl = new AbortController()
  const hardTimeout = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const res = await fetch(`${baseUrl}/api/reeval-thesis-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
        'x-service-trigger': 'reeval-cron',
        'x-service-user-id': userId,
      },
      body: JSON.stringify({
        verdictId: att.verdict_log_id,
        currentPrice,
        unrealizedPnlPct,
        triggersFired: triggers,
        freshTechnicals: technicals,
        freshNewsHeadlines: headlines,
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      console.warn(`[reeval] thesis-check returned ${res.status} for ${att.ticker}: ${txt.slice(0, 200)}`)
      return null
    }
    const json = await res.json() as ThesisCheckResult & { ok?: boolean }
    if (json.ok === false) return null
    return json
  } finally {
    clearTimeout(hardTimeout)
  }
}

function mapThesisAction(
  thesisAction: 'hold' | 'tighten_stop' | 'early_exit' | 'add',
  settings: UserTradingSettings,
  thesisStatus: 'intact' | 'weakened' | 'invalidated',
): 'HOLD' | 'TIGHTEN_STOP' | 'EARLY_EXIT' | 'ADD' {
  if (thesisAction === 'early_exit') {
    if (settings.allowEarlyExit) return 'EARLY_EXIT'
    if (settings.allowTightenStop) {
      console.log(`[reeval] thesis-check wanted early_exit but allowEarlyExit=false; falling back to tighten_stop (status=${thesisStatus})`)
      return 'TIGHTEN_STOP'
    }
    return 'HOLD'
  }
  if (thesisAction === 'tighten_stop') return settings.allowTightenStop ? 'TIGHTEN_STOP' : 'HOLD'
  if (thesisAction === 'add') return settings.allowAddPosition ? 'ADD' : 'HOLD'
  return 'HOLD'
}

async function fetchFreshTechnicals(ticker: string): Promise<{
  rsi?: number
  macdHistogram?: number
  priceVsSma20?: number
  priceVsSma50?: number
  volumeRatio?: number
  priceChange1d?: number
} | undefined> {
  try {
    const { computeTickerTechnicals } = await import('@/app/lib/scanner-engine')
    const result = await computeTickerTechnicals(ticker)
    if (!result || !result.technicals) return undefined
    const t = result.technicals
    return {
      rsi: t.rsi,
      macdHistogram: t.macdHistogram,
      priceVsSma20: t.priceVsSma20,
      priceVsSma50: t.priceVsSma50,
      volumeRatio: t.volumeRatio,
      priceChange1d: t.priceChange1D,
    }
  } catch { return undefined }
}

async function fetchFreshNewsHeadlines(ticker: string): Promise<string[]> {
  try {
    const admin = await getSupabaseAdmin()
    const cutoff = new Date(Date.now() - NEWS_LOOKBACK_MIN * 60_000).toISOString()
    const { data, error } = await admin
      .from('news_cache')
      .select('headline')
      .gte('created_at', cutoff)
      .ilike('headline', `%${ticker}%`)
      .order('created_at', { ascending: false })
      .limit(5)
    if (error || !data) return []
    return (data as Array<{ headline: string }>).map(r => r.headline).filter(Boolean)
  } catch { return [] }
}

// ─────────────────────────────────────────────────────────────
// Helpers — cooldown, logging
// ─────────────────────────────────────────────────────────────

async function isInCooldown(att: OpenAttempt): Promise<boolean> {
  if (!att.last_reeval_at) return false
  const ageMin = (Date.now() - new Date(att.last_reeval_at).getTime()) / 60_000
  return ageMin < REEVAL_COOLDOWN_MIN
}

async function logReevalAction(
  attempt: OpenAttempt,
  settings: UserTradingSettings,
  outcome: string,
  reason: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const admin = await getSupabaseAdmin()
  const broker = attempt.asset_class === 'crypto'
    ? 'alpaca'
    : attempt.asset_class === 'futures'
    ? 'tradovate'
    : settings.broker
  await admin.from('trade_attempts').insert({
    user_id: settings.userId,
    ticker: attempt.ticker,
    asset_class: attempt.asset_class,
    outcome,
    reject_reason: reason.slice(0, 500),
    mode: settings.mode,
    broker,
    signal_source: attempt.signal_source,
    original_attempt_id: attempt.id,
    ...extra,
  })
}

async function updateReevalTracking(
  attemptId: string,
  triggers: string[],
  decision: string,
  rationale: string,
): Promise<void> {
  const admin = await getSupabaseAdmin()
  const now = new Date().toISOString()
  const { data } = await admin
    .from('trade_attempts')
    .select('reeval_history, reeval_count')
    .eq('id', attemptId)
    .single()
  const hist = Array.isArray((data as { reeval_history?: unknown[] })?.reeval_history)
    ? (data as { reeval_history: unknown[] }).reeval_history : []
  const newEntry = { at: now, triggers, decision, rationale: rationale.slice(0, 500) }
  await admin
    .from('trade_attempts')
    .update({
      reeval_history: [...hist, newEntry].slice(-50),
      reeval_count: Number((data as { reeval_count?: number })?.reeval_count ?? 0) + 1,
      last_reeval_at: now,
    })
    .eq('id', attemptId)
}
