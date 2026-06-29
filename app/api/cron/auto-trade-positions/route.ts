// =============================================================
// app/api/cron/auto-trade-positions/route.ts (Session 3a)
//
// Position update worker. Runs every 5 min via GitHub Actions cron
// (was 15 min — tightened for target-hit responsiveness).
//
// FOR EACH ENABLED USER, FOR EACH ASSET CLASS:
//
//   1. STOCKS (equity Alpaca, bracket orders):
//      - For trade_attempts with outcome IN (placed, partial_fill, filled),
//        query Alpaca for the parent order's current state
//      - Transition placed → filled when parent fills
//      - Transition filled → closed_win/loss/be when a bracket child fills
//      - Compute realized P&L
//
//   2. CRYPTO (Alpaca crypto, separate stop order):
//      - Verify parent entry fill (placed → filled)
//      - Check stop_order_id status — if filled, position closed via stop
//      - Check current price vs council_target — if hit, market close + cancel stop
//      - Transition to closed_win/loss/be or closed_target_hit
//
//   3. FUTURES (Tradovate, separate stop order):
//      - Verify parent fill via positions() (netPos != 0)
//      - Check stop_order_id status via getOrder — if filled, position closed via stop
//      - Detect "netPos went to 0" as closure path (handles stop fired + missed our poll
//        or hand close from external action)
//      - Target-hit detection for futures DEFERRED to Session 3b (no live quote
//        in current Tradovate client; reeval can drive it)
//
// CRON_SECRET gated.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import {
  listEnabledTradingUsers,
  type UserTradingSettings,
} from '@/app/lib/trading/settings'
import {
  loadBrokerCredentialForUse,
  loadTradovateSession,
  saveTradovateTokenCache,
} from '@/app/lib/trading/credentials'
import { makeAlpacaClient } from '@/app/lib/trading/alpaca-client'
import { makeAlpacaCryptoClient, type AlpacaCryptoClient } from '@/app/lib/trading/alpaca-crypto-client'
import { makeTradovateClient, type TradovateClient } from '@/app/lib/trading/tradovate-client'
import { randomBytes } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface PositionsSummary {
  users: number
  // equity
  equityChecked: number
  equityFillsUpdated: number
  equityClosesRecorded: number
  // crypto
  cryptoChecked: number
  cryptoFillsUpdated: number
  cryptoStopFired: number
  cryptoTargetHit: number
  // futures
  futuresChecked: number
  futuresFillsUpdated: number
  futuresStopFired: number
  futuresPositionClosed: number
  errors: number
  durationMs: number
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary: PositionsSummary = {
    users: 0,
    equityChecked: 0, equityFillsUpdated: 0, equityClosesRecorded: 0,
    cryptoChecked: 0, cryptoFillsUpdated: 0, cryptoStopFired: 0, cryptoTargetHit: 0,
    futuresChecked: 0, futuresFillsUpdated: 0, futuresStopFired: 0, futuresPositionClosed: 0,
    errors: 0, durationMs: 0,
  }

  try {
    const users = await listEnabledTradingUsers()
    summary.users = users.length

    for (const settings of users) {
      try {
        // Fetch open attempts per asset class — separate queries keep things simple
        const [equityAttempts, cryptoAttempts, futuresAttempts] = await Promise.all([
          fetchOpenAttempts(settings.userId, 'stocks'),
          fetchOpenAttempts(settings.userId, 'crypto'),
          fetchOpenAttempts(settings.userId, 'futures'),
        ])

        // ── EQUITY (existing logic preserved) ──────────────
        if (equityAttempts.length > 0) {
          summary.equityChecked += equityAttempts.length
          await processEquityAttempts(settings, equityAttempts, summary)
        }

        // ── CRYPTO ─────────────────────────────────────────
        if (cryptoAttempts.length > 0) {
          summary.cryptoChecked += cryptoAttempts.length
          await processCryptoAttempts(settings, cryptoAttempts, summary)
        }

        // ── FUTURES ────────────────────────────────────────
        if (futuresAttempts.length > 0) {
          summary.futuresChecked += futuresAttempts.length
          await processFuturesAttempts(settings, futuresAttempts, summary)
        }
      } catch (e) {
        summary.errors++
        console.error(`[auto-trade-positions] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[auto-trade-positions cron] done in ${summary.durationMs}ms equity=${summary.equityChecked}(${summary.equityFillsUpdated}+${summary.equityClosesRecorded}) crypto=${summary.cryptoChecked}(stop:${summary.cryptoStopFired}+tgt:${summary.cryptoTargetHit}) futures=${summary.futuresChecked}(stop:${summary.futuresStopFired}+closed:${summary.futuresPositionClosed})`)
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────
// Asset-class-aware DB fetch
// ─────────────────────────────────────────────────────────────

interface AttemptRow {
  id: string
  user_id: string
  asset_class: string | null
  ticker: string
  broker: string | null
  broker_order_id: string | null
  stop_order_id: string | null
  side: string | null
  qty: number | string | null
  entry_price_est: number | string | null
  filled_avg_price: number | string | null
  outcome: string
  council_entry: number | string | null
  council_stop: number | string | null
  council_target: number | string | null
  mode: 'paper' | 'live'
  created_at: string
}

async function fetchOpenAttempts(userId: string, assetClass: 'stocks' | 'crypto' | 'futures'): Promise<AttemptRow[]> {
  const admin = await getSupabaseAdmin()
  // Look back 30 days for open orders
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  // For stocks, we don't always have asset_class populated (legacy rows). Treat NULL as stocks.
  let q = admin
    .from('trade_attempts')
    .select('id, user_id, asset_class, ticker, broker, broker_order_id, stop_order_id, side, qty, entry_price_est, filled_avg_price, outcome, council_entry, council_stop, council_target, mode, created_at')
    .eq('user_id', userId)
    .in('outcome', ['placed', 'partial_fill', 'filled'])
    .gte('created_at', cutoff)
    .not('broker_order_id', 'is', null)
    // Max (day_shark) positions are owned exclusively by day-shark-monitor.
    .or('signal_source.is.null,signal_source.neq.day_shark')

  if (assetClass === 'stocks') {
    // trade_attempts stores asset_class='stock' (singular, matches the
    // broker_credentials convention). Legacy rows may have NULL.
    // We must accept both NULL and 'stock' singular; we leave the legacy
    // 'stocks' plural in the OR list for any historical rows that may
    // exist from before the convention was unified.
    q = q.or('asset_class.is.null,asset_class.eq.stock,asset_class.eq.stocks')
  } else {
    q = q.eq('asset_class', assetClass)
  }

  const { data, error } = await q
  if (error) {
    console.warn(`[auto-trade-positions] fetchOpenAttempts(${assetClass}) failed:`, error.message)
    return []
  }
  return (data ?? []) as AttemptRow[]
}

// ─────────────────────────────────────────────────────────────
// EQUITY processing (existing logic, factored out)
// ─────────────────────────────────────────────────────────────

interface EquityOrderShape {
  status: string
  filled_qty: number
  filled_avg_price: number | null
  filled_at: string | null
  cancelled_at: string | null
  rejected_at: string | null
  failed_at: string | null
  legs: EquityOrderShape[] | null
}

async function processEquityAttempts(
  settings: UserTradingSettings,
  attempts: AttemptRow[],
  summary: PositionsSummary,
): Promise<void> {
  const credLoad = await loadBrokerCredentialForUse(settings.userId, settings.broker, settings.mode)
  if (!credLoad) return
  const alpaca = makeAlpacaClient(credLoad.keyId, credLoad.secret, settings.mode)

  // Reconciliation snapshot: read the broker's open positions ONCE so we can
  // verify a position is actually flat before recording any closed_* outcome.
  // This is the guard the lifecycle was missing — a bracket leg showing
  // 'filled' was previously enough to mark closed_win/loss even when the
  // broker still reported the position open (KLAC / APGE / LRCX recurrences).
  // null = positions read failed → skip close detection this run (still do
  // fill transitions), so a transient API blip can never cause a false close.
  let openSymbols: Set<string> | null = null
  try {
    const positions = await alpaca.positions()
    openSymbols = new Set(positions.filter(p => Number(p.qty) !== 0).map(p => p.symbol.toUpperCase()))
  } catch (e) {
    console.warn('[auto-trade-positions] equity positions() read failed; updating fills but skipping close reconciliation this run:', e instanceof Error ? e.message : e)
    openSymbols = null
  }

  for (const att of attempts) {
    if (!att.broker_order_id) continue
    try {
      const order = await alpaca.getOrder(att.broker_order_id)
      const update = await deriveEquityUpdate(att, order as unknown as EquityOrderShape, openSymbols)
      if (update) {
        await applyUpdate(att.id, update)
        if (update.outcome === 'filled' || update.outcome === 'partial_fill') summary.equityFillsUpdated++
        if (update.outcome?.startsWith('closed_')) summary.equityClosesRecorded++
      }
    } catch (e) {
      summary.errors++
      console.warn(`[auto-trade-positions] equity order=${att.broker_order_id} update failed:`, e instanceof Error ? e.message : e)
    }
  }
}

async function deriveEquityUpdate(att: AttemptRow, order: EquityOrderShape, openSymbols: Set<string> | null): Promise<UpdatePayload | null> {
  const s = (order.status ?? '').toLowerCase()

  if ((s === 'filled' || s === 'partially_filled') && att.outcome === 'placed') {
    const update: UpdatePayload = {
      outcome: s === 'filled' ? 'filled' : 'partial_fill',
      filled_qty: order.filled_qty,
    }
    if (order.filled_avg_price !== null) update.filled_avg_price = order.filled_avg_price
    if (order.filled_at) update.filled_at = order.filled_at
    return update
  }
  if (s === 'canceled' || s === 'cancelled') {
    return { outcome: 'cancelled', closed_at: order.cancelled_at ?? new Date().toISOString() }
  }
  if (s === 'rejected') {
    return { outcome: 'rejected', closed_at: order.rejected_at ?? new Date().toISOString() }
  }

  // Bracket child fill closure detection
  const legs = order.legs ?? []
  const filledLeg = legs.find(l => (l.status ?? '').toLowerCase() === 'filled' && l.filled_avg_price !== null)
  if (filledLeg && (att.outcome === 'filled' || att.outcome === 'partial_fill')) {
    const symbolUpper = att.ticker.toUpperCase()

    // RECONCILIATION GUARD: never record a close while the broker still shows
    // the position open. A null snapshot means we couldn't read positions this
    // run, so we also refuse to close (we can't verify) and retry next run.
    if (openSymbols === null) {
      return null
    }
    if (openSymbols.has(symbolUpper)) {
      console.warn(`[auto-trade-positions] DISCREPANCY ${att.ticker} attempt=${att.id}: bracket leg reports filled but broker still shows an OPEN position — NOT recording close this run`)
      return null
    }

    // Entry fill: prefer the stored fill, fall back to the parent order's
    // filled_avg_price. Fixes positions that got stuck in 'filled' forever
    // when the entry fill price wasn't captured at placed→filled time.
    const entryFill = (att.filled_avg_price !== null && att.filled_avg_price !== undefined)
      ? Number(att.filled_avg_price)
      : (order.filled_avg_price !== null && order.filled_avg_price !== undefined ? Number(order.filled_avg_price) : null)
    const exitFill = filledLeg.filled_avg_price
    const qty = att.qty !== null && att.qty !== undefined ? Number(att.qty) : 0
    if (entryFill !== null && exitFill !== null && qty > 0) {
      const sign = att.side === 'buy' ? 1 : -1
      const pnl = (exitFill - entryFill) * qty * sign
      const eps = 0.005
      let outcome: 'closed_win' | 'closed_loss' | 'closed_be'
      if (pnl > eps) outcome = 'closed_win'
      else if (pnl < -eps) outcome = 'closed_loss'
      else outcome = 'closed_be'

      // closure_kind: which bracket leg filled — the one nearer the council
      // target is a target hit, nearer the stop is a stop. Falls back to P&L
      // sign when council levels aren't available.
      const stopLvl = att.council_stop !== null && att.council_stop !== undefined ? Number(att.council_stop) : null
      const tgtLvl = att.council_target !== null && att.council_target !== undefined ? Number(att.council_target) : null
      let closureKind: 'stop_fired' | 'target_hit'
      if (stopLvl !== null && tgtLvl !== null && Number.isFinite(stopLvl) && Number.isFinite(tgtLvl)) {
        closureKind = Math.abs(exitFill - tgtLvl) <= Math.abs(exitFill - stopLvl) ? 'target_hit' : 'stop_fired'
      } else {
        closureKind = pnl > eps ? 'target_hit' : 'stop_fired'
      }

      return {
        outcome,
        realized_pnl: Number(pnl.toFixed(2)),
        closed_at: filledLeg.filled_at ?? new Date().toISOString(),
        closure_kind: closureKind,
      }
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────
// CRYPTO processing (Session 3a)
// ─────────────────────────────────────────────────────────────

async function processCryptoAttempts(
  settings: UserTradingSettings,
  attempts: AttemptRow[],
  summary: PositionsSummary,
): Promise<void> {
  const credLoad = await loadBrokerCredentialForUse(settings.userId, 'alpaca', settings.mode, 'crypto')
  if (!credLoad) return
  const alpaca = makeAlpacaCryptoClient(credLoad.keyId, credLoad.secret, settings.mode)

  // Pre-fetch positions ONCE for target-hit price comparison
  let positions: Awaited<ReturnType<typeof alpaca.positions>> = []
  try {
    positions = await alpaca.positions()
  } catch (e) {
    console.warn(`[auto-trade-positions] crypto positions() failed for user=${settings.userId}:`, e instanceof Error ? e.message : e)
  }
  const positionsBySymbol = new Map<string, CryptoPosForLookup>(
    positions.map(p => [normalizeCryptoSymbol(p.symbol), {
      symbol: p.symbol,
      qty: p.qty,
      current_price: p.current_price,
      avg_entry_price: p.avg_entry_price,
    }])
  )

  for (const att of attempts) {
    if (!att.broker_order_id) continue
    try {
      const result = await processCryptoAttempt(att, alpaca, positionsBySymbol)
      if (result.kind === 'fill_update') summary.cryptoFillsUpdated++
      if (result.kind === 'stop_fired') summary.cryptoStopFired++
      if (result.kind === 'target_hit') summary.cryptoTargetHit++
    } catch (e) {
      summary.errors++
      console.warn(`[auto-trade-positions] crypto attempt=${att.id} failed:`, e instanceof Error ? e.message : e)
    }
  }
}

type CryptoProcessResult =
  | { kind: 'nothing' }
  | { kind: 'fill_update' }
  | { kind: 'stop_fired' }
  | { kind: 'target_hit' }

interface CryptoPosForLookup {
  symbol: string
  qty: number
  current_price: number
  avg_entry_price: number
}

async function processCryptoAttempt(
  att: AttemptRow,
  alpaca: AlpacaCryptoClient,
  positionsBySymbol: Map<string, CryptoPosForLookup>,
): Promise<CryptoProcessResult> {
  // STEP 1: Update fill status if still 'placed'
  if (att.outcome === 'placed' && att.broker_order_id) {
    const order = await alpaca.getOrder(att.broker_order_id)
    const s = (order.status ?? '').toLowerCase()
    if (s === 'filled' || s === 'partially_filled') {
      await applyUpdate(att.id, {
        outcome: s === 'filled' ? 'filled' : 'partial_fill',
        filled_qty: order.filled_qty,
        filled_avg_price: order.filled_avg_price ?? undefined,
        filled_at: order.filled_at ?? undefined,
      })
      return { kind: 'fill_update' }
    }
    if (s === 'canceled' || s === 'cancelled') {
      await applyUpdate(att.id, { outcome: 'cancelled', closed_at: order.cancelled_at ?? new Date().toISOString() })
      return { kind: 'nothing' }
    }
    if (s === 'rejected') {
      await applyUpdate(att.id, { outcome: 'rejected', closed_at: new Date().toISOString() })
      return { kind: 'nothing' }
    }
    return { kind: 'nothing' }  // still working
  }

  // STEP 2: For filled positions, check stop fired + target hit
  if (att.outcome !== 'filled' && att.outcome !== 'partial_fill') return { kind: 'nothing' }

  // 2a: Check stop_order_id status
  if (att.stop_order_id) {
    try {
      const stopOrder = await alpaca.getOrder(att.stop_order_id)
      const ss = (stopOrder.status ?? '').toLowerCase()
      if (ss === 'filled') {
        // Stop fired — compute P&L and close
        const entryFill = att.filled_avg_price !== null && att.filled_avg_price !== undefined
          ? Number(att.filled_avg_price) : null
        const exitFill = stopOrder.filled_avg_price
        const qty = att.qty !== null && att.qty !== undefined ? Number(att.qty) : 0
        if (entryFill !== null && exitFill !== null && qty > 0) {
          const pnl = (exitFill - entryFill) * qty  // crypto is long only
          const eps = 0.01
          let outcome: 'closed_win' | 'closed_loss' | 'closed_be'
          if (pnl > eps) outcome = 'closed_win'
          else if (pnl < -eps) outcome = 'closed_loss'
          else outcome = 'closed_be'
          await applyUpdate(att.id, {
            outcome,
            realized_pnl: Number(pnl.toFixed(2)),
            closed_at: stopOrder.filled_at ?? new Date().toISOString(),
            closure_kind: 'stop_fired',
          })
          return { kind: 'stop_fired' }
        }
      }
    } catch (e) {
      console.warn(`[auto-trade-positions] crypto stop order ${att.stop_order_id} check failed:`, e instanceof Error ? e.message : e)
    }
  }

  // 2b: Check target hit — current price vs council_target
  const target = att.council_target !== null && att.council_target !== undefined ? Number(att.council_target) : null
  if (target !== null && target > 0) {
    const normTicker = normalizeCryptoSymbol(att.ticker)
    const pos = positionsBySymbol.get(normTicker)
    if (pos && pos.current_price > 0) {
      // Crypto positions are always long: target hit when current >= target
      if (pos.current_price >= target) {
        await closeCryptoOnTargetHit(att, alpaca, pos)
        return { kind: 'target_hit' }
      }
    }
  }

  return { kind: 'nothing' }
}

/**
 * Close a crypto position at market because price reached the target.
 * Pattern: place market sell first, then cancel the stop (in that order).
 * If the stop fired between our price check and our close attempt, the
 * market sell will fail with "no position" — handle gracefully.
 */
async function closeCryptoOnTargetHit(
  att: AttemptRow,
  alpaca: AlpacaCryptoClient,
  pos: CryptoPosForLookup,
): Promise<void> {
  const closeClientId = `wos-tgt-${att.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`
  let closeOrderId: string | null = null
  let closeFillPrice: number | null = null
  let closeFilledAt: string | null = null

  try {
    // Use marketEntry with side='sell' to close — same endpoint
    const order = await alpaca.marketEntry({
      symbol: pos.symbol.includes('/') ? pos.symbol : att.ticker,  // use canonical form
      qty: pos.qty,
      side: 'sell',
      clientOrderId: closeClientId,
    })
    closeOrderId = order.id
    closeFillPrice = order.filled_avg_price
    closeFilledAt = order.filled_at
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // If the position is gone (stop fired in the meantime), this errors. Next run will catch.
    if (/no position|insufficient/i.test(msg)) {
      console.log(`[auto-trade-positions] crypto close on target rejected (position already closed): ${att.ticker}`)
      return
    }
    console.warn(`[auto-trade-positions] crypto close on target failed: ${att.ticker} ${msg.slice(0, 200)}`)
    return
  }

  // Cancel the stop now that we've issued the close
  let stopCancelledAt: string | null = null
  if (att.stop_order_id) {
    const cancelResult = await alpaca.cancelOrder(att.stop_order_id)
    if (cancelResult.ok) {
      stopCancelledAt = new Date().toISOString()
    } else {
      console.warn(`[auto-trade-positions] crypto stop cancel failed for ${att.stop_order_id}: ${cancelResult.reason}`)
    }
  }

  // Compute P&L using the actual close fill if available, else current price as estimate
  const entryFill = att.filled_avg_price !== null && att.filled_avg_price !== undefined
    ? Number(att.filled_avg_price) : null
  const exitPrice = closeFillPrice ?? pos.current_price
  const qty = att.qty !== null && att.qty !== undefined ? Number(att.qty) : pos.qty
  let realizedPnl: number | null = null
  if (entryFill !== null && qty > 0) {
    realizedPnl = Number(((exitPrice - entryFill) * qty).toFixed(2))
  }

  await applyUpdate(att.id, {
    outcome: realizedPnl !== null && realizedPnl > 0 ? 'closed_win' : 'closed_be',
    realized_pnl: realizedPnl ?? undefined,
    closed_at: closeFilledAt ?? new Date().toISOString(),
    closure_kind: 'target_hit',
    target_reached_at: new Date().toISOString(),
    close_order_id: closeOrderId ?? undefined,
    stop_cancelled_at: stopCancelledAt ?? undefined,
  })
  console.log(`[auto-trade-positions] crypto TARGET HIT ${att.ticker} qty=${qty} target=${att.council_target} exit=${exitPrice} pnl=${realizedPnl}`)
}

/**
 * Normalize crypto symbols: Alpaca returns "BTCUSD" in positions but
 * stored ticker is "BTC/USD". Match either form.
 */
function normalizeCryptoSymbol(sym: string): string {
  return sym.replace('/', '').toUpperCase()
}

// ─────────────────────────────────────────────────────────────
// FUTURES processing (Session 3a)
// ─────────────────────────────────────────────────────────────

async function processFuturesAttempts(
  settings: UserTradingSettings,
  attempts: AttemptRow[],
  summary: PositionsSummary,
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
    accountSpec: session.accountSpec,
    accountIntId: session.accountIntId,
    cachedAccessToken: session.cachedAccessToken,
    cachedExpiresAt: session.cachedTokenExpiresAt,
    onTokenRefreshed: async (token, expiresAt) => {
      await saveTradovateTokenCache(session.credentialRowId, token, expiresAt)
    },
  })

  // Pre-fetch positions ONCE
  let positions
  try {
    positions = await tradovate.positions()
  } catch (e) {
    console.warn(`[auto-trade-positions] tradovate positions() failed for user=${settings.userId}:`, e instanceof Error ? e.message : e)
    return
  }
  // For futures, we match by contract NAME (stored on att.ticker as e.g. "ESH6").
  // We need to resolve contract names. Cache by contractId.
  const positionsByContractId = new Map<number, { contractId: number; netPos: number; netPrice: number | null }>(
    positions.map(p => [p.contractId, { contractId: p.contractId, netPos: p.netPos, netPrice: p.netPrice }])
  )

  // Cache contract resolution by root to avoid re-fetching the same front-month
  // multiple times per cron run.
  const contractCache = new Map<string, { id: number; name: string } | null>()

  for (const att of attempts) {
    try {
      const result = await processFuturesAttempt(att, tradovate, positionsByContractId, contractCache)
      if (result.kind === 'fill_update') summary.futuresFillsUpdated++
      if (result.kind === 'stop_fired') summary.futuresStopFired++
      if (result.kind === 'position_closed') summary.futuresPositionClosed++
    } catch (e) {
      summary.errors++
      console.warn(`[auto-trade-positions] futures attempt=${att.id} failed:`, e instanceof Error ? e.message : e)
    }
  }
}

type FuturesProcessResult =
  | { kind: 'nothing' }
  | { kind: 'fill_update' }
  | { kind: 'stop_fired' }
  | { kind: 'position_closed' }

async function processFuturesAttempt(
  att: AttemptRow,
  tradovate: TradovateClient,
  positionsByContractId: Map<number, { contractId: number; netPos: number; netPrice: number | null }>,
  contractCache: Map<string, { id: number; name: string } | null>,
): Promise<FuturesProcessResult> {
  // Resolve contract by name. Same logic as attach-stops.
  const contractName = att.ticker
  if (!contractName || contractName.length < 3) return { kind: 'nothing' }
  const root = contractName.slice(0, -2)

  // Check cache first
  let contract = contractCache.get(root)
  if (contract === undefined) {
    const resolved = await tradovate.findFrontMonthContract(root)
    contract = resolved ? { id: resolved.id, name: resolved.name } : null
    contractCache.set(root, contract)
  }
  if (!contract || contract.name !== contractName) return { kind: 'nothing' }  // rolled or not found

  const pos = positionsByContractId.get(contract.id)

  // CASE A: attempt is 'placed' — verify fill via positions
  if (att.outcome === 'placed') {
    if (pos && pos.netPos !== 0) {
      await applyUpdate(att.id, {
        outcome: 'filled',
        filled_qty: Math.abs(pos.netPos),
        filled_avg_price: pos.netPrice ?? undefined,
        filled_at: new Date().toISOString(),
      })
      return { kind: 'fill_update' }
    }
    return { kind: 'nothing' }  // still waiting for fill
  }

  if (att.outcome !== 'filled' && att.outcome !== 'partial_fill') return { kind: 'nothing' }

  // CASE B: position is gone (netPos === 0 or missing) — closure detected
  if (!pos || pos.netPos === 0) {
    // Was the stop responsible? Check stop_order_id status to disambiguate.
    let exitPrice: number | null = null
    let closureKind: 'stop_fired' | 'closed_external' = 'closed_external'
    let exitAt: string = new Date().toISOString()

    if (att.stop_order_id) {
      const stopId = Number(att.stop_order_id)
      if (Number.isFinite(stopId)) {
        try {
          const stopOrder = await tradovate.getOrder(stopId)
          if (stopOrder && (stopOrder.ordStatus.toLowerCase() === 'filled' || stopOrder.cumQty > 0)) {
            closureKind = 'stop_fired'
            exitPrice = stopOrder.avgPrice
            exitAt = stopOrder.timestamp ?? exitAt
          }
        } catch { /* fall through */ }
      }
    }

    // P&L: use stored entry vs exit. If exit unknown, log as closed without P&L.
    const entryFill = att.filled_avg_price !== null && att.filled_avg_price !== undefined
      ? Number(att.filled_avg_price) : null
    const qty = att.qty !== null && att.qty !== undefined ? Number(att.qty) : 0
    let realizedPnl: number | null = null
    if (entryFill !== null && exitPrice !== null && qty > 0) {
      const sign = att.side === 'buy' ? 1 : -1
      realizedPnl = Number(((exitPrice - entryFill) * qty * sign).toFixed(2))
    }

    let outcome: 'closed_win' | 'closed_loss' | 'closed_be'
    if (realizedPnl === null) outcome = 'closed_be'
    else if (realizedPnl > 0.005) outcome = 'closed_win'
    else if (realizedPnl < -0.005) outcome = 'closed_loss'
    else outcome = 'closed_be'

    await applyUpdate(att.id, {
      outcome,
      realized_pnl: realizedPnl ?? undefined,
      closed_at: exitAt,
      closure_kind: closureKind,
    })
    return closureKind === 'stop_fired' ? { kind: 'stop_fired' } : { kind: 'position_closed' }
  }

  // CASE C: position still open. Target-hit detection requires live quote which
  // current Tradovate client doesn't expose. Defer to Session 3b reeval.
  return { kind: 'nothing' }
}

// ─────────────────────────────────────────────────────────────
// Shared update helper
// ─────────────────────────────────────────────────────────────

interface UpdatePayload {
  outcome?: 'placed' | 'partial_fill' | 'filled' | 'cancelled' | 'rejected'
                 | 'closed_win' | 'closed_loss' | 'closed_be' | 'closed_target_hit'
  filled_qty?: number
  filled_avg_price?: number
  filled_at?: string
  closed_at?: string
  realized_pnl?: number
  closure_kind?: 'stop_fired' | 'target_hit' | 'closed_external' | 'reeval_exit'
  target_reached_at?: string
  stop_cancelled_at?: string
  close_order_id?: string
}

async function applyUpdate(attemptId: string, update: UpdatePayload): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin
    .from('trade_attempts')
    .update(update)
    .eq('id', attemptId)
}
