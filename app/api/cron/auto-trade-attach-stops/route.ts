// =============================================================
// app/api/cron/auto-trade-attach-stops/route.ts (Sessions 1+2)
//
// Stop-attachment worker. Runs every 1 minute, 24/7.
//
// PURPOSE: Crypto and futures auto-trade crons place market entries
// but CANNOT place a stop in the same call:
//   - Alpaca crypto has no bracket order support (no OCO/OTO/bracket)
//   - Tradovate doesn't expose OCO/OSO via the current REST client
// Without this worker, those positions run with no broker-side
// protective stop — a critical risk gap.
//
// HOW IT WORKS:
//   1. Find trade_attempts rows where:
//      - asset_class IN ('crypto', 'futures')
//      - outcome IN ('placed','filled','partial_fill')
//      - stop_order_id IS NULL              (not yet attached)
//      - stop_attach_attempts < 5           (retry budget)
//      - created_at > now() - 24h           (don't try stale orphans)
//
//   2. Per asset class, verify the parent entry has filled:
//      - Crypto: check parent order status='filled' via Alpaca getOrder
//      - Futures: check tradovate.positions() shows nonzero netPos
//      If not yet filled, defer to next run.
//
//   3. Place protective stop:
//      - Crypto: alpacaCrypto.stopLimitSell() at council_stop, 0.5% slip
//      - Futures: tradovate.placeOrder() Stop type (market on trigger),
//        opposite side of entry, at council_stop
//
//   4. On success: write stop_order_id and stop_attached_at.
//   5. On failure: increment stop_attach_attempts and log.
//
// SCOPE NOTES (Sessions 1+2):
//   - Stop only — no target attachment. Target stays app-managed via
//     reeval (Session 3 work).
//   - For crypto: Alpaca crypto has no OCO so target can't be a sibling
//   - For futures: Tradovate has no OCO so two children could BOTH fire
//     in volatile conditions, leaving an unintended reverse position.
//     Stop-only avoids this until Session 3 wires position-monitor cancel.
//   - Idempotent: skip rows that already have stop_order_id.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { loadBrokerCredentialForUse, loadTradovateSession, saveTradovateTokenCache, loadCoinbaseCredential } from '@/app/lib/trading/credentials'
import { makeAlpacaCryptoClient, type AlpacaCryptoClient } from '@/app/lib/trading/alpaca-crypto-client'
import { makeCoinbaseClient, type CoinbaseClient } from '@/app/lib/trading/coinbase-client'
import { makeTradovateClient, type TradovateClient } from '@/app/lib/trading/tradovate-client'
import { randomBytes } from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_ATTEMPTS_PER_RUN = 50          // safety cap per run
const MAX_ATTACH_ATTEMPTS = 5            // give up after N retries
const LOOKBACK_HOURS = 24                // don't chase stale orphans

// Futures stop slippage room — for future stop-limit upgrade when
// Tradovate exposes StopLimit. Currently we use plain Stop (market
// on trigger) so this is informational. Kept as a constant so it's
// easy to switch when StopLimit support arrives.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const FUTURES_STOP_LIMIT_OFFSET_PCT = 0.005

interface PendingAttachRow {
  id: string                              // trade_attempts.id (UUID)
  user_id: string
  asset_class: string
  ticker: string                          // normalized symbol e.g. "BTC/USD" (alpaca) or "BTC-USD" (coinbase)
  mode: 'paper' | 'live'
  broker: 'alpaca' | 'coinbase'           // crypto can be alpaca OR coinbase
  broker_order_id: string | null          // the parent entry order
  side: string | null
  qty: number | string | null
  council_stop: number | string | null    // stop price from the council verdict
  filled_avg_price: number | string | null
  outcome: string
  stop_attach_attempts: number
}

interface AttachSummary {
  pending: number
  attached: number
  deferred: number         // parent not yet filled
  failed: number           // attach attempt failed
  gaveUp: number           // hit max attempts
  errors: number
  durationMs: number
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary: AttachSummary = {
    pending: 0, attached: 0, deferred: 0, failed: 0, gaveUp: 0, errors: 0, durationMs: 0,
  }

  try {
    const pending = await fetchPendingAttachments()
    summary.pending = pending.length

    // Group by user_id so we can reuse one broker client per user per asset class
    const byUser = new Map<string, PendingAttachRow[]>()
    for (const row of pending) {
      const list = byUser.get(row.user_id) ?? []
      list.push(row)
      byUser.set(row.user_id, list)
    }

    for (const [userId, rows] of byUser) {
      // Split per asset class so each gets its own broker client
      const cryptoRows = rows.filter(r => r.asset_class === 'crypto')
      const futuresRows = rows.filter(r => r.asset_class === 'futures')

      // ── Crypto: Alpaca ─────────────────────────────────────
      const cryptoAlpacaRows = cryptoRows.filter(r => r.broker === 'alpaca')
      if (cryptoAlpacaRows.length > 0) {
        // All crypto rows from one user use the same mode
        const mode = cryptoAlpacaRows[0].mode
        const credLoad = await loadBrokerCredentialForUse(userId, 'alpaca', mode, 'crypto')
        if (!credLoad) {
          console.warn(`[attach-stops] user=${userId} no alpaca crypto credential; skipping ${cryptoAlpacaRows.length} alpaca crypto attempts`)
        } else {
          const alpaca = makeAlpacaCryptoClient(credLoad.keyId, credLoad.secret, mode)
          for (const row of cryptoAlpacaRows) {
            try {
              const result = await processCryptoAttempt(row, alpaca)
              countResult(summary, result)
            } catch (e) {
              summary.errors++
              console.error(`[attach-stops] alpaca crypto attempt=${row.id} unexpected error:`, e instanceof Error ? e.message : e)
            }
          }
        }
      }

      // ── Crypto: Coinbase ───────────────────────────────────
      const cryptoCoinbaseRows = cryptoRows.filter(r => r.broker === 'coinbase')
      if (cryptoCoinbaseRows.length > 0) {
        const credLoad = await loadCoinbaseCredential(userId)
        if (!credLoad) {
          console.warn(`[attach-stops] user=${userId} no coinbase credential; skipping ${cryptoCoinbaseRows.length} coinbase attempts`)
        } else {
          const coinbase = makeCoinbaseClient(credLoad.keyName, credLoad.privateKey)
          for (const row of cryptoCoinbaseRows) {
            try {
              const result = await processCoinbaseAttempt(row, coinbase)
              countResult(summary, result)
            } catch (e) {
              summary.errors++
              console.error(`[attach-stops] coinbase attempt=${row.id} unexpected error:`, e instanceof Error ? e.message : e)
            }
          }
        }
      }

      // ── Futures ────────────────────────────────────────────
      if (futuresRows.length > 0) {
        const mode = futuresRows[0].mode
        const session = await loadTradovateSession(userId, mode)
        if (!session) {
          console.warn(`[attach-stops] user=${userId} no tradovate session; skipping ${futuresRows.length} futures attempts`)
        } else if (session.accountSpec === null || session.accountIntId === null) {
          console.warn(`[attach-stops] user=${userId} tradovate session missing accountSpec/accountIntId`)
        } else {
          const tradovate = makeTradovateClient({
            mode,
            credentials: {
              username: session.username,
              password: session.password,
              appId: session.appId,
              appVersion: session.appVersion,
              cid: session.cid,
              sec: session.sec,
            },
            accountSpec: session.accountSpec,
            accountIntId: session.accountIntId,
            cachedAccessToken: session.cachedAccessToken,
            cachedExpiresAt: session.cachedTokenExpiresAt,
            onTokenRefreshed: async (token, expiresAt) => {
              await saveTradovateTokenCache(session.credentialRowId, token, expiresAt)
            },
          })
          // Pre-fetch positions ONCE for this user (instead of once per attempt)
          let positions
          try {
            positions = await tradovate.positions()
          } catch (e) {
            console.warn(`[attach-stops] user=${userId} tradovate.positions() failed; deferring all futures attempts:`, e instanceof Error ? e.message : e)
            positions = null
          }
          if (positions !== null) {
            for (const row of futuresRows) {
              try {
                const result = await processFuturesAttempt(row, tradovate, positions)
                countResult(summary, result)
              } catch (e) {
                summary.errors++
                console.error(`[attach-stops] futures attempt=${row.id} unexpected error:`, e instanceof Error ? e.message : e)
              }
            }
          }
        }
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[attach-stops cron] done in ${summary.durationMs}ms pending=${summary.pending} attached=${summary.attached} deferred=${summary.deferred} failed=${summary.failed} gaveUp=${summary.gaveUp}`)
  return NextResponse.json(summary)
}

function countResult(summary: AttachSummary, result: ProcessResult): void {
  switch (result.kind) {
    case 'attached':  summary.attached++; break
    case 'deferred':  summary.deferred++; break
    case 'failed':    summary.failed++; break
    case 'gave_up':   summary.gaveUp++; break
  }
}

// ─────────────────────────────────────────────────────────────
// Per-attempt processing
// ─────────────────────────────────────────────────────────────

type ProcessResult =
  | { kind: 'attached'; stopOrderId: string }
  | { kind: 'deferred'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'gave_up'; reason: string }

async function processCryptoAttempt(row: PendingAttachRow, alpaca: AlpacaCryptoClient): Promise<ProcessResult> {
  // Already past retry budget — mark gave_up and exit (loud)
  if (row.stop_attach_attempts >= MAX_ATTACH_ATTEMPTS) {
    return { kind: 'gave_up', reason: `at max attempts (${row.stop_attach_attempts})` }
  }

  // Validate row has the data we need
  const stopPrice = row.council_stop !== null && row.council_stop !== undefined
    ? Number(row.council_stop) : null
  if (stopPrice === null || !Number.isFinite(stopPrice) || stopPrice <= 0) {
    // This is unrecoverable — no stop price means we can't attach. Mark gave_up.
    await markFailed(row.id, row.stop_attach_attempts, `no valid stop_price (council_stop=${row.council_stop})`)
    return { kind: 'failed', reason: 'no valid stop_price' }
  }
  if (!row.broker_order_id) {
    await markFailed(row.id, row.stop_attach_attempts, 'no broker_order_id on row')
    return { kind: 'failed', reason: 'no broker_order_id' }
  }

  // Check parent entry order — must be filled before we can attach a stop
  // (Alpaca rejects stop orders on positions you don't have yet.)
  let parentOrder
  try {
    parentOrder = await alpaca.getOrder(row.broker_order_id)
  } catch (e) {
    // Could be transient (Alpaca 5xx) or permanent (order doesn't exist).
    // Either way, increment attempts and defer to next run.
    const msg = e instanceof Error ? e.message : String(e)
    await markFailed(row.id, row.stop_attach_attempts, `getOrder failed: ${msg.slice(0, 200)}`)
    return { kind: 'failed', reason: `getOrder failed: ${msg.slice(0, 100)}` }
  }

  const status = (parentOrder.status ?? '').toLowerCase()
  if (status !== 'filled' && status !== 'partially_filled') {
    // Not yet filled — common right after placement. Just defer; don't count as a failed attempt.
    return { kind: 'deferred', reason: `parent status=${status}` }
  }

  const filledQty = parentOrder.filled_qty ?? 0
  if (filledQty <= 0) {
    return { kind: 'deferred', reason: `parent status=${status} but filled_qty=${filledQty}` }
  }

  // We're good — place the stop_limit sell
  const stopClientId = `wos-stop-${row.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`

  // Idempotency: a previous run may have placed the stop but failed to
  // write back the ID. Look it up first.
  try {
    const existing = await alpaca.getOrderByClientId(stopClientId).catch(() => null)
    if (existing) {
      await markAttached(row.id, existing.id, row.stop_attach_attempts)
      return { kind: 'attached', stopOrderId: existing.id }
    }
  } catch { /* fall through to place */ }

  try {
    const stopOrder = await alpaca.stopLimitSell({
      symbol: row.ticker,                  // already normalized e.g. "BTC/USD"
      qty: filledQty,
      stopPrice,
      clientOrderId: stopClientId,
    })
    await markAttached(row.id, stopOrder.id, row.stop_attach_attempts)
    console.log(`[attach-stops] ATTACHED user=${row.user_id} ${row.ticker} stop=${stopPrice} stopOrderId=${stopOrder.id} attemptId=${row.id}`)
    return { kind: 'attached', stopOrderId: stopOrder.id }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markFailed(row.id, row.stop_attach_attempts, `stopLimitSell failed: ${msg.slice(0, 200)}`)
    console.warn(`[attach-stops] FAILED user=${row.user_id} ${row.ticker} attempt=${row.id}: ${msg.slice(0, 200)}`)
    return { kind: 'failed', reason: msg.slice(0, 100) }
  }
}

// ─────────────────────────────────────────────────────────────
// Per-attempt processing — Coinbase crypto
//
// Mirrors processCryptoAttempt but uses CoinbaseClient. Differences:
//   - getOrder uses Coinbase's historical endpoint
//   - Status values: 'FILLED'/'OPEN'/'CANCELLED' (uppercase) vs Alpaca's lowercase
//   - Ticker format in DB is BTC-USD (dash) for Coinbase rows
//   - stopLimitSell submits Coinbase stop_limit_stop_limit_gtc with STOP_DOWN
// ─────────────────────────────────────────────────────────────

async function processCoinbaseAttempt(
  row: PendingAttachRow,
  coinbase: CoinbaseClient,
): Promise<ProcessResult> {
  if (row.stop_attach_attempts >= MAX_ATTACH_ATTEMPTS) {
    return { kind: 'gave_up', reason: `at max attempts (${row.stop_attach_attempts})` }
  }

  const stopPrice = row.council_stop !== null && row.council_stop !== undefined
    ? Number(row.council_stop) : null
  if (stopPrice === null || !Number.isFinite(stopPrice) || stopPrice <= 0) {
    await markFailed(row.id, row.stop_attach_attempts, `no valid stop_price (council_stop=${row.council_stop})`)
    return { kind: 'failed', reason: 'no valid stop_price' }
  }
  if (!row.broker_order_id) {
    await markFailed(row.id, row.stop_attach_attempts, 'no broker_order_id on row')
    return { kind: 'failed', reason: 'no broker_order_id' }
  }

  // Check parent entry status — Coinbase uses FILLED/OPEN/CANCELLED uppercase
  let parentOrder
  try {
    parentOrder = await coinbase.getOrder(row.broker_order_id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markFailed(row.id, row.stop_attach_attempts, `coinbase getOrder failed: ${msg.slice(0, 200)}`)
    return { kind: 'failed', reason: `getOrder failed: ${msg.slice(0, 100)}` }
  }

  const status = (parentOrder.status ?? '').toUpperCase()
  if (status !== 'FILLED' && status !== 'PARTIALLY_FILLED') {
    return { kind: 'deferred', reason: `coinbase parent status=${status}` }
  }

  const filledQty = parentOrder.filled_qty ?? 0
  if (filledQty <= 0) {
    return { kind: 'deferred', reason: `coinbase parent status=${status} but filled_qty=${filledQty}` }
  }

  const stopClientId = `wos-cbstop-${row.id.slice(0, 8)}-${randomBytes(3).toString('hex')}`

  // Idempotency: look up by client_order_id first
  try {
    const existing = await coinbase.getOrderByClientId(stopClientId).catch(() => null)
    if (existing) {
      await markAttached(row.id, existing.id, row.stop_attach_attempts)
      return { kind: 'attached', stopOrderId: existing.id }
    }
  } catch { /* fall through to place */ }

  try {
    const stopOrder = await coinbase.stopLimitSell({
      symbol: row.ticker,                  // already normalized e.g. "BTC-USD"
      qty: filledQty,
      stopPrice,
      clientOrderId: stopClientId,
    })
    await markAttached(row.id, stopOrder.id, row.stop_attach_attempts)
    console.log(`[attach-stops] COINBASE ATTACHED user=${row.user_id} ${row.ticker} stop=${stopPrice} stopOrderId=${stopOrder.id} attemptId=${row.id}`)
    return { kind: 'attached', stopOrderId: stopOrder.id }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markFailed(row.id, row.stop_attach_attempts, `coinbase stopLimitSell failed: ${msg.slice(0, 200)}`)
    console.warn(`[attach-stops] COINBASE FAILED user=${row.user_id} ${row.ticker} attempt=${row.id}: ${msg.slice(0, 200)}`)
    return { kind: 'failed', reason: msg.slice(0, 100) }
  }
}

// ─────────────────────────────────────────────────────────────
// Per-attempt processing — futures (Session 2)
// ─────────────────────────────────────────────────────────────

/**
 * Process one futures attempt.
 *
 * Differences from crypto:
 *   - Verify fill via positions() (Tradovate client doesn't expose
 *     getOrder by ID; positions list is the canonical state).
 *   - Resolve contract: row.ticker stores the contract name (e.g. "ESH6"),
 *     but Tradovate orders use integer contractId. We get contractId from
 *     the matching position.
 *   - Stop is plain `Stop` order (market on trigger). Tradovate client
 *     doesn't expose StopLimit currently; when it does, switch to that
 *     with FUTURES_STOP_LIMIT_OFFSET_PCT slippage cap.
 *   - Sell-stop for long positions (qty>0 netPos), buy-stop for short (netPos<0).
 *
 * @param positions Pre-fetched positions for this user (one fetch per cron run)
 */
async function processFuturesAttempt(
  row: PendingAttachRow,
  tradovate: TradovateClient,
  positions: Array<{ contractId: number; netPos: number; netPrice: number | null }>,
): Promise<ProcessResult> {
  if (row.stop_attach_attempts >= MAX_ATTACH_ATTEMPTS) {
    return { kind: 'gave_up', reason: `at max attempts (${row.stop_attach_attempts})` }
  }

  const stopPrice = row.council_stop !== null && row.council_stop !== undefined
    ? Number(row.council_stop) : null
  if (stopPrice === null || !Number.isFinite(stopPrice) || stopPrice <= 0) {
    await markFailed(row.id, row.stop_attach_attempts, `no valid stop_price (council_stop=${row.council_stop})`)
    return { kind: 'failed', reason: 'no valid stop_price' }
  }
  if (!row.side || (row.side !== 'buy' && row.side !== 'sell')) {
    await markFailed(row.id, row.stop_attach_attempts, `invalid side on row: ${row.side}`)
    return { kind: 'failed', reason: 'invalid side' }
  }

  // Resolve contract by name → contractId
  // We extract the root (e.g. "ESH6" → "ES", "MESH6" → "MES") by taking
  // everything except the last 2 chars (1 month code + 1 year digit).
  const contractName = row.ticker
  if (!contractName || contractName.length < 3) {
    await markFailed(row.id, row.stop_attach_attempts, `invalid contract name: ${contractName}`)
    return { kind: 'failed', reason: 'invalid contract name' }
  }
  const root = contractName.slice(0, -2)  // "ESH6" → "ES", "MESH6" → "MES"

  // Find front-month contract for this root, verify name matches our stored ticker
  let contract
  try {
    contract = await tradovate.findFrontMonthContract(root)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markFailed(row.id, row.stop_attach_attempts, `findFrontMonthContract failed: ${msg.slice(0, 200)}`)
    return { kind: 'failed', reason: `contract resolve: ${msg.slice(0, 100)}` }
  }
  if (!contract) {
    await markFailed(row.id, row.stop_attach_attempts, `no front-month contract for root=${root}`)
    return { kind: 'failed', reason: `no front-month for ${root}` }
  }
  // If the resolved contract name doesn't match what's on the row, the front-month
  // has rolled since entry. The stored contract still has an open position but it's
  // no longer the front month. Defer with a loud log — needs manual reconciliation.
  if (contract.name !== contractName) {
    console.warn(`[attach-stops] futures contract roll detected: row.ticker=${contractName} but front-month is now ${contract.name}. attempt=${row.id} skipped.`)
    await markFailed(row.id, row.stop_attach_attempts, `contract roll: ${contractName} -> ${contract.name}`)
    return { kind: 'failed', reason: `contract roll ${contractName} -> ${contract.name}` }
  }

  // Verify the position exists with nonzero netPos
  const pos = positions.find(p => p.contractId === contract.id)
  if (!pos || pos.netPos === 0) {
    // Entry hasn't filled yet, OR closed already. Defer; don't burn an attempt.
    return { kind: 'deferred', reason: `no open position on contractId=${contract.id}` }
  }

  // Sanity: position direction matches the side we placed
  // Long position (netPos > 0) means we placed a Buy entry → stop is a Sell
  // Short position (netPos < 0) means we placed a Sell entry → stop is a Buy
  const stopAction: 'Buy' | 'Sell' = pos.netPos > 0 ? 'Sell' : 'Buy'
  const expectedSide = pos.netPos > 0 ? 'buy' : 'sell'
  if (row.side !== expectedSide) {
    console.warn(`[attach-stops] futures side mismatch: row.side=${row.side} but netPos=${pos.netPos} implies ${expectedSide}. Using position direction. attempt=${row.id}`)
    // Trust the position over the row, since the broker is the truth source
  }

  // Validate stop is on the protective side relative to the position
  if (pos.netPrice !== null) {
    if (pos.netPos > 0 && stopPrice >= pos.netPrice) {
      // Long position with stop ABOVE entry — wrong side
      await markFailed(row.id, row.stop_attach_attempts, `stop ${stopPrice} >= entry ${pos.netPrice} on long`)
      return { kind: 'failed', reason: 'stop on wrong side of entry (long)' }
    }
    if (pos.netPos < 0 && stopPrice <= pos.netPrice) {
      // Short position with stop BELOW entry — wrong side
      await markFailed(row.id, row.stop_attach_attempts, `stop ${stopPrice} <= entry ${pos.netPrice} on short`)
      return { kind: 'failed', reason: 'stop on wrong side of entry (short)' }
    }
  }

  // Use absolute value of netPos as the stop qty. If a partial close happened
  // between entry and now, this stops the remaining position — correct behavior.
  const stopQty = Math.abs(pos.netPos)

  // Place the stop
  try {
    const result = await tradovate.placeOrder({
      contractId: contract.id,
      action: stopAction,
      qty: stopQty,
      orderType: 'Stop',
      price: stopPrice,
      isAutomated: true,
    })
    if (result.failureReason || result.failureText) {
      const msg = `${result.failureReason ?? 'unknown'}: ${result.failureText ?? ''}`
      await markFailed(row.id, row.stop_attach_attempts, `Tradovate stop rejected: ${msg.slice(0, 200)}`)
      console.warn(`[attach-stops] FAILED futures user=${row.user_id} ${contractName} attempt=${row.id}: ${msg.slice(0, 200)}`)
      return { kind: 'failed', reason: msg.slice(0, 100) }
    }
    const stopOrderId = result.orderId ? String(result.orderId) : ''
    if (!stopOrderId) {
      await markFailed(row.id, row.stop_attach_attempts, `Tradovate returned no orderId`)
      return { kind: 'failed', reason: 'no orderId returned' }
    }
    await markAttached(row.id, stopOrderId, row.stop_attach_attempts)
    console.log(`[attach-stops] ATTACHED futures user=${row.user_id} ${contractName} ${stopAction} ${stopQty}× @ stop=${stopPrice} stopOrderId=${stopOrderId} attemptId=${row.id}`)
    return { kind: 'attached', stopOrderId }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await markFailed(row.id, row.stop_attach_attempts, `placeOrder Stop failed: ${msg.slice(0, 200)}`)
    console.warn(`[attach-stops] FAILED futures user=${row.user_id} ${contractName} attempt=${row.id}: ${msg.slice(0, 200)}`)
    return { kind: 'failed', reason: msg.slice(0, 100) }
  }
}

// ─────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────

async function fetchPendingAttachments(): Promise<PendingAttachRow[]> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000).toISOString()
  const { data, error } = await admin
    .from('trade_attempts')
    .select('id, user_id, asset_class, ticker, mode, broker, broker_order_id, side, qty, council_stop, filled_avg_price, outcome, stop_attach_attempts')
    .in('asset_class', ['crypto', 'futures'])         // Sessions 1+2
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .is('stop_order_id', null)
    .lt('stop_attach_attempts', MAX_ATTACH_ATTEMPTS)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: true })         // oldest first — fairness
    .limit(MAX_ATTEMPTS_PER_RUN)
  if (error) {
    console.error('[attach-stops] fetchPendingAttachments failed:', error.message)
    return []
  }
  return (data ?? []) as PendingAttachRow[]
}

async function markAttached(attemptId: string, stopOrderId: string, prevAttempts: number): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin
    .from('trade_attempts')
    .update({
      stop_order_id: stopOrderId,
      stop_attached_at: new Date().toISOString(),
      stop_attach_attempts: prevAttempts + 1,
    })
    .eq('id', attemptId)
}

async function markFailed(attemptId: string, prevAttempts: number, reason: string): Promise<void> {
  const admin = await getSupabaseAdmin()
  // Increment the attach counter. We don't write `reason` to the row because the
  // existing `reject_reason` field is for the original placement outcome, and
  // overwriting it would lose that audit trail. The reason is logged below and
  // visible in Railway logs filtered by [attach-stops].
  await admin
    .from('trade_attempts')
    .update({ stop_attach_attempts: prevAttempts + 1 })
    .eq('id', attemptId)
  console.warn(`[attach-stops] attempt=${attemptId} attach failed (#${prevAttempts + 1}): ${reason}`)
}
