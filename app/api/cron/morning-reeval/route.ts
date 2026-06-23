// =============================================================
// app/api/cron/morning-reeval/route.ts
//
// Runs ONCE per market open (13:35 UTC = 5 min after the 9:30 ET bell).
// For every open position with a linked verdict_log_id:
//   1. Fetch current price from Alpaca
//   2. Compute unrealized P&L % vs entry
//   3. Call /api/reeval-thesis-check with trigger="morning_reeval"
//   4. Apply the Council's action (HOLD / TIGHTEN / EXIT)
//
// Why this cron exists:
// Overnight news, gaps, and market regime shifts can invalidate a
// thesis that was sound at yesterday's close. The intraday position-
// monitor cron uses 5m + 15m bars and isn't equipped for "overnight
// thesis intact?" reasoning. This cron asks the Council that question
// once each morning so we don't carry stale theses into the new session.
//
// This cron piggybacks on the existing position-monitor's action
// helpers (applyTighten, applyExit, recordExitClosure) by calling
// the reeval-thesis-check route, which itself can return a directive.
// Future enhancement: factor those helpers out of position-monitor so
// we can use them directly here. For now this cron only LOGS the
// reeval result; actual tighten/exit happens on the next position-
// monitor run (within 3 min of this cron).
//
// CRON_SECRET gated. Returns a structured summary.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers } from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import { makeAlpacaClient } from '@/app/lib/trading/alpaca-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120  // up to 2 minutes — Council reeval can take 30-60s each

interface OpenAttempt {
  id: string
  user_id: string
  ticker: string
  side: 'buy' | 'sell' | null
  qty: number | null
  filled_avg_price: number | null
  entry_price_est: number | null
  verdict_log_id: number | null
  outcome: string
}

interface ReevalLog {
  ticker: string
  verdict_log_id: number | null
  action: string                  // HOLD | EARLY_EXIT | TIGHTEN_STOP | UNKNOWN | error
  thesis_status: string | null    // intact | weakened | invalidated | null
  current_price: number | null
  unrealized_pnl_pct: number | null
  rationale: string | null
  error_reason: string | null
}

interface UserSummary {
  userId: string
  positionsChecked: number
  reevalsCompleted: number
  errors: number
  results: ReevalLog[]
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Auth
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary = {
    users: [] as UserSummary[],
    durationMs: 0,
    totalChecked: 0,
    totalReeval: 0,
    totalErrors: 0,
  }

  try {
    const users = await listEnabledTradingUsers()
    console.log(`[morning-reeval cron] starting; users=${users.length}`)

    const rawBase = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '')
    if (!rawBase) {
      return NextResponse.json({ error: 'APP_BASE_URL not configured' }, { status: 500 })
    }
    // Prepend https:// if scheme missing (see pre-market-reeval URL bug, 2026-06-23)
    const baseUrl = /^https?:\/\//.test(rawBase) ? rawBase : `https://${rawBase}`

    for (const settings of users) {
      const userSummary: UserSummary = {
        userId: settings.userId,
        positionsChecked: 0,
        reevalsCompleted: 0,
        errors: 0,
        results: [],
      }

      try {
        // Load Alpaca for this user (need it for current prices)
        const credLoad = await loadBrokerCredentialForUse(
          settings.userId,
          settings.broker,
          settings.mode,
          'stock',
        )
        if (!credLoad) {
          console.warn(`[morning-reeval] user=${settings.userId} no broker creds`)
          summary.users.push(userSummary)
          continue
        }
        const alpaca = makeAlpacaClient(credLoad.keyId, credLoad.secret, settings.mode)

        // Fetch open trade_attempts for this user
        const attempts = await fetchOpenAttempts(settings.userId)
        if (attempts.length === 0) {
          summary.users.push(userSummary)
          continue
        }
        userSummary.positionsChecked = attempts.length

        // Fetch current prices in one Alpaca call
        let alpacaPositions: Array<{ symbol: string; avg_entry_price: number; current_price: number; qty: number }>
        try {
          alpacaPositions = await alpaca.positions() as Array<{
            symbol: string; avg_entry_price: number; current_price: number; qty: number;
          }>
        } catch (e) {
          console.error(`[morning-reeval] user=${settings.userId} alpaca.positions() failed:`,
            e instanceof Error ? e.message : e)
          userSummary.errors++
          summary.users.push(userSummary)
          continue
        }
        const positionsBySymbol = new Map(
          alpacaPositions.map(p => [p.symbol.toUpperCase(), p]),
        )

        // For each open attempt with a verdict_log_id, reeval
        for (const att of attempts) {
          const symbol = att.ticker.toUpperCase()
          const pos = positionsBySymbol.get(symbol)
          if (!pos) {
            // trade_attempts says open but broker has no position — skip
            userSummary.results.push({
              ticker: symbol, verdict_log_id: att.verdict_log_id,
              action: 'skipped', thesis_status: null,
              current_price: null, unrealized_pnl_pct: null,
              rationale: 'broker has no matching position', error_reason: null,
            })
            continue
          }
          if (att.verdict_log_id === null) {
            userSummary.results.push({
              ticker: symbol, verdict_log_id: null,
              action: 'skipped', thesis_status: null,
              current_price: pos.current_price, unrealized_pnl_pct: null,
              rationale: 'no verdict_log_id; cannot reeval', error_reason: null,
            })
            continue
          }

          // Compute unrealized P/L %
          const entry = pos.avg_entry_price ?? att.filled_avg_price ?? att.entry_price_est ?? 0
          let unrealizedPnlPct = 0
          if (entry > 0) {
            const dir = att.side === 'sell' ? -1 : 1
            unrealizedPnlPct = ((pos.current_price - entry) / entry) * 100 * dir
          }

          // Call reeval-thesis-check
          try {
            const res = await fetch(`${baseUrl}/api/reeval-thesis-check`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
                'x-service-trigger': 'morning-reeval',
                'x-service-user-id': settings.userId,
              },
              body: JSON.stringify({
                verdictId: att.verdict_log_id,
                currentPrice: pos.current_price,
                unrealizedPnlPct,
                triggersFired: ['morning_reeval: post-overnight thesis check'],
              }),
              signal: AbortSignal.timeout(90_000),
            })
            if (!res.ok) {
              const errBody = await res.text().catch(() => '')
              userSummary.errors++
              userSummary.results.push({
                ticker: symbol, verdict_log_id: att.verdict_log_id,
                action: 'error', thesis_status: null,
                current_price: pos.current_price, unrealized_pnl_pct: unrealizedPnlPct,
                rationale: null,
                error_reason: `thesis-check returned ${res.status}: ${errBody.slice(0, 150)}`,
              })
              continue
            }
            const data = await res.json() as {
              action?: string
              thesisStatus?: string
              rationale?: string
              confidence?: number
            }
            userSummary.reevalsCompleted++
            userSummary.results.push({
              ticker: symbol, verdict_log_id: att.verdict_log_id,
              action: (data.action ?? 'unknown').toUpperCase(),
              thesis_status: data.thesisStatus ?? null,
              current_price: pos.current_price, unrealized_pnl_pct: unrealizedPnlPct,
              rationale: (data.rationale ?? '').slice(0, 300),
              error_reason: null,
            })
            console.log(`[morning-reeval] ${symbol} → ${data.action ?? '?'} (${data.thesisStatus ?? '?'}, conf ${data.confidence ?? '?'}%)`)
          } catch (e) {
            userSummary.errors++
            userSummary.results.push({
              ticker: symbol, verdict_log_id: att.verdict_log_id,
              action: 'error', thesis_status: null,
              current_price: pos.current_price, unrealized_pnl_pct: unrealizedPnlPct,
              rationale: null,
              error_reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
            })
          }
        }
      } catch (e) {
        userSummary.errors++
        console.error(`[morning-reeval] user=${settings.userId} failed:`,
          e instanceof Error ? e.message : e)
      }
      summary.users.push(userSummary)
      summary.totalChecked += userSummary.positionsChecked
      summary.totalReeval += userSummary.reevalsCompleted
      summary.totalErrors += userSummary.errors
    }
  } catch (e) {
    console.error('[morning-reeval cron] outer failure:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(
    `[morning-reeval cron] done in ${summary.durationMs}ms; ` +
    `checked=${summary.totalChecked} reeval=${summary.totalReeval} errors=${summary.totalErrors}`,
  )
  return NextResponse.json(summary)
}

async function fetchOpenAttempts(userId: string): Promise<OpenAttempt[]> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString()  // 30 days
  const { data, error } = await admin
    .from('trade_attempts')
    .select('id, user_id, ticker, side, qty, filled_avg_price, entry_price_est, verdict_log_id, outcome')
    .eq('user_id', userId)
    .or('asset_class.is.null,asset_class.eq.stock,asset_class.eq.stocks')
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .gte('created_at', cutoff)

  if (error) {
    console.warn(`[morning-reeval] fetchOpenAttempts user=${userId} failed: ${error.message}`)
    return []
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>
  return rows.map(row => ({
    id: String(row.id),
    user_id: String(row.user_id),
    ticker: String(row.ticker),
    side: (row.side as 'buy' | 'sell' | null) ?? null,
    qty: row.qty !== null && row.qty !== undefined ? Number(row.qty) : null,
    filled_avg_price: row.filled_avg_price !== null && row.filled_avg_price !== undefined ? Number(row.filled_avg_price) : null,
    entry_price_est: row.entry_price_est !== null && row.entry_price_est !== undefined ? Number(row.entry_price_est) : null,
    verdict_log_id: row.verdict_log_id !== null && row.verdict_log_id !== undefined ? Number(row.verdict_log_id) : null,
    outcome: String(row.outcome),
  }))
}
