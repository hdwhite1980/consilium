// =============================================================
// app/api/cron/after-hours-reeval/route.ts
//
// Runs at 21:30 UTC (4:30 PM ET) Mon-Fri.
//
// 30 minutes after market close, evaluates each open position AND each
// held bracket order for material change. If material change detected
// (price gap, stop/target crossed, catalyst news), escalates to Council
// via /api/reeval-thesis-check.
//
// LOG ONLY: this cron does not cancel or modify orders. Pre-market-reeval
// is the one with the authority to cancel held orders.
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
  type AlpacaPos,
  type AlpacaOrder,
  type OpenAttemptForReeval,
} from '@/app/lib/trading/reeval-helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 180  // 3 minutes — covers multiple Council calls

const TRIGGER_SOURCE = 'after_hours_reeval'

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
  error_reason: string | null
}

interface UserSummary {
  userId: string
  positionsChecked: number
  heldOrdersChecked: number
  materialChanges: number
  councilEscalations: number
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
    totalErrors: 0,
  }

  try {
    const users = await listEnabledTradingUsers()
    console.log(`[after-hours-reeval] starting; users=${users.length}`)

    for (const settings of users) {
      const userSummary: UserSummary = {
        userId: settings.userId,
        positionsChecked: 0, heldOrdersChecked: 0,
        materialChanges: 0, councilEscalations: 0, errors: 0,
        results: [],
      }

      try {
        const credLoad = await loadBrokerCredentialForUse(
          settings.userId, settings.broker, settings.mode, 'stock',
        )
        if (!credLoad) {
          console.warn(`[after-hours-reeval] user=${settings.userId} no broker creds`)
          summary.users.push(userSummary)
          continue
        }
        const alpaca = makeAlpacaClient(credLoad.keyId, credLoad.secret, settings.mode)

        // Fetch our system's tracked attempts + Alpaca's actual state
        const [attempts, alpacaPositions, heldOrders] = await Promise.all([
          fetchOpenAttempts(settings.userId),
          (alpaca.positions() as Promise<AlpacaPos[]>).catch(() => [] as AlpacaPos[]),
          fetchHeldOrders(alpaca),
        ])
        const positionsBySymbol = new Map(alpacaPositions.map(p => [p.symbol.toUpperCase(), p]))
        const attemptByTicker = new Map(attempts.map(a => [a.ticker.toUpperCase(), a]))

        // Identify "held" orders — those whose parent hasn't filled yet.
        // We exclude orders that are children of filled brackets (those are
        // protecting an open position; the open-positions loop handles them).
        const trulyHeld = heldOrders.filter(o => {
          // A "held" parent bracket order has status='accepted'/'held'/'new'
          // and filled_qty=0. Bracket children (status='held' with parent filled)
          // would have a non-zero parent in our system. Heuristic: filter on
          // unfilled qty + parent-shaped order_type.
          const fq = Number(o.filled_qty ?? '0')
          return fq === 0 && (o.order_type === 'market' || o.order_type === 'limit')
        })

        // ── Process open positions ──
        for (const pos of alpacaPositions) {
          const symbol = pos.symbol.toUpperCase()
          const att = attemptByTicker.get(symbol)
          userSummary.positionsChecked++

          const result = await processPosition({
            settings, alpaca, pos, att, baseUrl,
          })
          userSummary.results.push(result)
          if (result.material) userSummary.materialChanges++
          if (result.escalated_to_council) userSummary.councilEscalations++
          if (result.error_reason) userSummary.errors++
        }

        // ── Process held orders ──
        for (const order of trulyHeld) {
          const symbol = order.symbol.toUpperCase()
          // Skip if we already have a live position for the same symbol (the
          // order would be a child, not a parent)
          if (positionsBySymbol.has(symbol)) continue
          const att = attemptByTicker.get(symbol)
          userSummary.heldOrdersChecked++

          const result = await processHeldOrder({
            settings, alpaca, order, att, baseUrl,
          })
          userSummary.results.push(result)
          if (result.material) userSummary.materialChanges++
          if (result.escalated_to_council) userSummary.councilEscalations++
          if (result.error_reason) userSummary.errors++
        }

        // Persist results to a log table (best-effort; non-blocking)
        await persistResults(settings.userId, TRIGGER_SOURCE, userSummary.results)
          .catch(e => console.warn(`[after-hours-reeval] persist failed:`, e instanceof Error ? e.message : e))

      } catch (e) {
        userSummary.errors++
        console.error(`[after-hours-reeval] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }

      summary.users.push(userSummary)
      summary.totalChecked += userSummary.positionsChecked + userSummary.heldOrdersChecked
      summary.totalMaterial += userSummary.materialChanges
      summary.totalEscalated += userSummary.councilEscalations
      summary.totalErrors += userSummary.errors
    }
  } catch (e) {
    console.error('[after-hours-reeval] outer failure:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(
    `[after-hours-reeval] done in ${summary.durationMs}ms; checked=${summary.totalChecked} ` +
    `material=${summary.totalMaterial} escalated=${summary.totalEscalated} errors=${summary.totalErrors}`,
  )
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────
// Per-position / per-order processing
// ─────────────────────────────────────────────────────────────

async function processPosition(args: {
  settings: { userId: string }
  alpaca: unknown
  pos: AlpacaPos
  att: OpenAttemptForReeval | undefined
  baseUrl: string
}): Promise<CheckResult> {
  const { settings, alpaca, pos, att, baseUrl } = args
  const symbol = pos.symbol.toUpperCase()

  // Prefer extended-hours quote if available, else fall back to pos.current_price
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
    error_reason: null,
  }

  if (!material.isMaterial) return result
  if (att?.verdict_log_id === null || att?.verdict_log_id === undefined) {
    result.error_reason = 'no verdict_log_id; cannot escalate to Council'
    return result
  }

  // Compute unrealized P/L %
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
    `[after-hours-reeval] ${symbol} position: ${material.reasons.join(' | ')} → ` +
    `council=${council.action ?? '?'} (${council.thesisStatus ?? '?'})`,
  )
  return result
}

async function processHeldOrder(args: {
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
    error_reason: null,
  }

  if (!material.isMaterial) return result
  if (att?.verdict_log_id === null || att?.verdict_log_id === undefined) {
    result.error_reason = 'no verdict_log_id; cannot escalate to Council'
    return result
  }

  // Held order has no fill yet, so unrealizedPnlPct = 0
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
  if (council.error) result.error_reason = council.error

  console.log(
    `[after-hours-reeval] ${symbol} HELD: ${material.reasons.join(' | ')} → ` +
    `council=${council.action ?? '?'} (LOG ONLY — pre-market cron handles cancellations)`,
  )
  return result
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
    error_reason: r.error_reason,
  }))
  const { error } = await admin.from('reeval_log').insert(rows)
  if (error) {
    console.warn(`[after-hours-reeval] reeval_log insert failed: ${error.message}`)
  }
}
