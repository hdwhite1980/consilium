// =============================================================
// app/api/cron/pre-market-reeval/route.ts
//
// Runs at 12:30 UTC (8:30 AM ET) Mon-Fri — 1 hour before US market open.
//
// Same logic as after-hours-reeval, BUT:
//   - For HELD ORDERS that get EARLY_EXIT recommendation: CANCEL the order
//   - For OPEN POSITIONS: log only (position-monitor handles at open)
//
// The cancellation flow:
//   1. Material change detected on held order
//   2. Council reeval-thesis-check returns 'early_exit'
//   3. We call DELETE /v2/orders/{id} on the bracket parent
//   4. We update trade_attempts with outcome='cancelled_pre_market',
//      closure_kind='pre_market_cancel'
//
// CRON_SECRET gated.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { listEnabledTradingUsers } from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import { makeAlpacaClient } from '@/app/lib/trading/alpaca-client'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import {
  fetchOpenAttempts,
  fetchHeldOrders,
  fetchLatestQuote,
  checkMaterialChange,
  callReevalThesisCheck,
  cancelOrder,
  type AlpacaPos,
  type AlpacaOrder,
  type OpenAttemptForReeval,
} from '@/app/lib/trading/reeval-helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 180

const TRIGGER_SOURCE = 'pre_market_reeval'

interface CheckResult {
  ticker: string
  kind: 'open_position' | 'held_order'
  verdict_log_id: number | null
  material: boolean
  material_reasons: string[]
  price_gap_pct: number | null
  current_price: number | null
  escalated_to_council: boolean
  council_action: string | null
  council_thesis_status: string | null
  council_rationale: string | null
  action_taken: string | null      // 'cancelled' | 'logged' | null
  cancel_ok: boolean | null
  cancel_reason: string | null
  error_reason: string | null
}

interface UserSummary {
  userId: string
  positionsChecked: number
  heldOrdersChecked: number
  materialChanges: number
  councilEscalations: number
  ordersCancelled: number
  errors: number
  results: CheckResult[]
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const baseUrl = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '')
  if (!baseUrl) {
    return NextResponse.json({ error: 'APP_BASE_URL not configured' }, { status: 500 })
  }

  const summary = {
    users: [] as UserSummary[],
    durationMs: 0,
    totalChecked: 0,
    totalMaterial: 0,
    totalEscalated: 0,
    totalCancelled: 0,
    totalErrors: 0,
  }

  try {
    const users = await listEnabledTradingUsers()
    console.log(`[pre-market-reeval] starting; users=${users.length}`)

    for (const settings of users) {
      const userSummary: UserSummary = {
        userId: settings.userId,
        positionsChecked: 0, heldOrdersChecked: 0,
        materialChanges: 0, councilEscalations: 0,
        ordersCancelled: 0, errors: 0,
        results: [],
      }

      try {
        const credLoad = await loadBrokerCredentialForUse(
          settings.userId, settings.broker, settings.mode, 'stock',
        )
        if (!credLoad) {
          summary.users.push(userSummary)
          continue
        }
        const alpaca = makeAlpacaClient(credLoad.keyId, credLoad.secret, settings.mode)

        const [attempts, alpacaPositions, heldOrders] = await Promise.all([
          fetchOpenAttempts(settings.userId),
          (alpaca.positions() as Promise<AlpacaPos[]>).catch(() => [] as AlpacaPos[]),
          fetchHeldOrders(alpaca),
        ])
        const positionsBySymbol = new Map(alpacaPositions.map(p => [p.symbol.toUpperCase(), p]))
        const attemptByTicker = new Map(attempts.map(a => [a.ticker.toUpperCase(), a]))

        const trulyHeld = heldOrders.filter(o => {
          const fq = Number(o.filled_qty ?? '0')
          return fq === 0 && (o.order_type === 'market' || o.order_type === 'limit')
        })

        // ── Open positions: log only ──
        for (const pos of alpacaPositions) {
          const symbol = pos.symbol.toUpperCase()
          const att = attemptByTicker.get(symbol)
          userSummary.positionsChecked++
          const result = await processPositionLogOnly({
            settings, alpaca, pos, att, baseUrl,
          })
          userSummary.results.push(result)
          if (result.material) userSummary.materialChanges++
          if (result.escalated_to_council) userSummary.councilEscalations++
          if (result.error_reason) userSummary.errors++
        }

        // ── Held orders: act on EARLY_EXIT ──
        for (const order of trulyHeld) {
          const symbol = order.symbol.toUpperCase()
          if (positionsBySymbol.has(symbol)) continue
          const att = attemptByTicker.get(symbol)
          userSummary.heldOrdersChecked++
          const result = await processHeldOrderWithAction({
            settings, alpaca, order, att, baseUrl,
          })
          userSummary.results.push(result)
          if (result.material) userSummary.materialChanges++
          if (result.escalated_to_council) userSummary.councilEscalations++
          if (result.action_taken === 'cancelled') userSummary.ordersCancelled++
          if (result.error_reason) userSummary.errors++
        }

        await persistResults(settings.userId, TRIGGER_SOURCE, userSummary.results)
          .catch(e => console.warn(`[pre-market-reeval] persist failed:`, e instanceof Error ? e.message : e))

      } catch (e) {
        userSummary.errors++
        console.error(`[pre-market-reeval] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }

      summary.users.push(userSummary)
      summary.totalChecked += userSummary.positionsChecked + userSummary.heldOrdersChecked
      summary.totalMaterial += userSummary.materialChanges
      summary.totalEscalated += userSummary.councilEscalations
      summary.totalCancelled += userSummary.ordersCancelled
      summary.totalErrors += userSummary.errors
    }
  } catch (e) {
    console.error('[pre-market-reeval] outer failure:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(
    `[pre-market-reeval] done in ${summary.durationMs}ms; checked=${summary.totalChecked} ` +
    `material=${summary.totalMaterial} escalated=${summary.totalEscalated} ` +
    `cancelled=${summary.totalCancelled} errors=${summary.totalErrors}`,
  )
  return NextResponse.json(summary)
}

async function processPositionLogOnly(args: {
  settings: { userId: string }
  alpaca: unknown
  pos: AlpacaPos
  att: OpenAttemptForReeval | undefined
  baseUrl: string
}): Promise<CheckResult> {
  const { settings, alpaca, pos, att, baseUrl } = args
  const symbol = pos.symbol.toUpperCase()
  const quote = await fetchLatestQuote(alpaca, symbol)
  const currentPrice = quote.price ?? pos.current_price
  const entryPrice = pos.avg_entry_price ?? att?.filled_avg_price ?? att?.entry_price_est ?? null

  const material = await checkMaterialChange({
    ticker: symbol,
    entryPrice,
    currentPrice,
    stopPrice: att?.stop_price ?? null,
    targetPrice: att?.target_price ?? null,
    side: att?.side ?? 'buy',
  })

  const result: CheckResult = {
    ticker: symbol, kind: 'open_position',
    verdict_log_id: att?.verdict_log_id ?? null,
    material: material.isMaterial,
    material_reasons: material.reasons,
    price_gap_pct: material.priceGapPct,
    current_price: currentPrice,
    escalated_to_council: false,
    council_action: null, council_thesis_status: null, council_rationale: null,
    action_taken: 'logged', cancel_ok: null, cancel_reason: null,
    error_reason: null,
  }

  if (!material.isMaterial) return result
  if (att?.verdict_log_id === null || att?.verdict_log_id === undefined) {
    result.error_reason = 'no verdict_log_id; cannot escalate to Council'
    return result
  }

  let unrealizedPnlPct = 0
  if (entryPrice !== null && entryPrice > 0 && currentPrice !== null) {
    const dir = att?.side === 'sell' ? -1 : 1
    unrealizedPnlPct = ((currentPrice - entryPrice) / entryPrice) * 100 * dir
  }

  result.escalated_to_council = true
  const council = await callReevalThesisCheck({
    baseUrl,
    cronSecret: process.env.CRON_SECRET ?? '',
    userId: settings.userId,
    verdictId: att.verdict_log_id,
    currentPrice: currentPrice ?? 0,
    unrealizedPnlPct,
    triggers: [`${TRIGGER_SOURCE}: ${material.reasons.join('; ')}`],
    triggerSource: TRIGGER_SOURCE,
  })
  result.council_action = council.action
  result.council_thesis_status = council.thesisStatus
  result.council_rationale = council.rationale
  if (council.error) result.error_reason = council.error

  console.log(
    `[pre-market-reeval] ${symbol} POSITION: ${material.reasons.join(' | ')} → ` +
    `council=${council.action ?? '?'} (logged — position-monitor acts at open)`,
  )
  return result
}

async function processHeldOrderWithAction(args: {
  settings: { userId: string }
  alpaca: unknown
  order: AlpacaOrder
  att: OpenAttemptForReeval | undefined
  baseUrl: string
}): Promise<CheckResult> {
  const { settings, alpaca, order, att, baseUrl } = args
  const symbol = order.symbol.toUpperCase()
  const quote = await fetchLatestQuote(alpaca, symbol)
  const currentPrice = quote.price
  const entryPrice = att?.entry_price_est ?? Number(order.limit_price ?? '0') ?? null

  const material = await checkMaterialChange({
    ticker: symbol,
    entryPrice: entryPrice && entryPrice > 0 ? entryPrice : null,
    currentPrice,
    stopPrice: att?.stop_price ?? null,
    targetPrice: att?.target_price ?? null,
    side: order.side,
  })

  const result: CheckResult = {
    ticker: symbol, kind: 'held_order',
    verdict_log_id: att?.verdict_log_id ?? null,
    material: material.isMaterial,
    material_reasons: material.reasons,
    price_gap_pct: material.priceGapPct,
    current_price: currentPrice,
    escalated_to_council: false,
    council_action: null, council_thesis_status: null, council_rationale: null,
    action_taken: 'logged', cancel_ok: null, cancel_reason: null,
    error_reason: null,
  }

  if (!material.isMaterial) return result
  if (att?.verdict_log_id === null || att?.verdict_log_id === undefined) {
    result.error_reason = 'no verdict_log_id; cannot escalate to Council'
    return result
  }

  result.escalated_to_council = true
  const council = await callReevalThesisCheck({
    baseUrl,
    cronSecret: process.env.CRON_SECRET ?? '',
    userId: settings.userId,
    verdictId: att.verdict_log_id,
    currentPrice: currentPrice ?? 0,
    unrealizedPnlPct: 0,
    triggers: [`${TRIGGER_SOURCE} HELD: ${material.reasons.join('; ')}`],
    triggerSource: TRIGGER_SOURCE,
  })
  result.council_action = council.action
  result.council_thesis_status = council.thesisStatus
  result.council_rationale = council.rationale
  if (council.error) {
    result.error_reason = council.error
    return result
  }

  // Action: cancel if Council says EARLY_EXIT (or 'exit' depending on format)
  const action = (council.action ?? '').toUpperCase()
  const shouldCancel = action === 'EARLY_EXIT' || action === 'EXIT'

  if (shouldCancel) {
    const cancel = await cancelOrder(alpaca, order.id)
    result.cancel_ok = cancel.ok
    result.cancel_reason = cancel.reason ?? null
    if (cancel.ok) {
      result.action_taken = 'cancelled'
      // Update trade_attempts row
      await markCancelled(att.id).catch(e =>
        console.warn(`[pre-market-reeval] markCancelled ${symbol}: ${e instanceof Error ? e.message : e}`))
      console.log(
        `[pre-market-reeval] ${symbol} HELD CANCELLED: council=${action}, ` +
        `reasons=[${material.reasons.join(' | ')}]`,
      )
    } else {
      result.error_reason = `cancel failed: ${cancel.reason}`
      console.error(`[pre-market-reeval] ${symbol} HELD cancel FAILED:`, cancel.reason)
    }
  } else {
    console.log(
      `[pre-market-reeval] ${symbol} HELD: council=${action} (no action — only EARLY_EXIT triggers cancel)`,
    )
  }
  return result
}

async function markCancelled(tradeAttemptId: string): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin
    .from('trade_attempts')
    .update({
      outcome: 'cancelled',
      closed_at: new Date().toISOString(),
      closure_kind: 'pre_market_cancel',
    })
    .eq('id', tradeAttemptId)
}

async function persistResults(userId: string, triggerSource: string, results: CheckResult[]): Promise<void> {
  if (results.length === 0) return
  const admin = await getSupabaseAdmin()
  const rows = results.map(r => ({
    user_id: userId,
    trigger_source: triggerSource,
    ticker: r.ticker,
    kind: r.kind,
    verdict_log_id: r.verdict_log_id,
    material: r.material,
    material_reasons: r.material_reasons,
    price_gap_pct: r.price_gap_pct,
    current_price: r.current_price,
    escalated_to_council: r.escalated_to_council,
    council_action: r.council_action,
    council_thesis_status: r.council_thesis_status,
    council_rationale: r.council_rationale,
    action_taken: r.action_taken,
    cancel_ok: r.cancel_ok,
    cancel_reason: r.cancel_reason,
    error_reason: r.error_reason,
  }))
  const { error } = await admin.from('reeval_log').insert(rows)
  if (error) {
    console.warn(`[pre-market-reeval] reeval_log insert failed: ${error.message}`)
  }
}
