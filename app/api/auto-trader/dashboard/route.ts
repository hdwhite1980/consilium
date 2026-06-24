// =============================================================
// app/api/auto-trader/dashboard/route.ts
//
// Composite endpoint for the auto-trader dashboard. Returns:
//   - settings (enabled/mode/halted/kill switches)
//   - today's KPIs (attempts, placed, skipped, errors, P&L, win rate)
//   - recent attempts (last 50)
//   - skipped reason breakdown
//   - closed trades summary (last 30 days)
//
// User-scoped: returns ONLY the requesting user's data.
//
// Auth: session required.
// =============================================================

import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/app/lib/auth/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { loadUserTradingSettings } from '@/app/lib/trading/settings'
import { listBrokerCredentials } from '@/app/lib/trading/credentials'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  // Auth
  const supa = await createAuthClient()
  const { data: { user } } = await supa.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const userId = user.id
    const admin = await getSupabaseAdmin()

    const [settings, credentialMeta] = await Promise.all([
      loadUserTradingSettings(userId),
      loadBrokerCredentialMetaSafe(userId),
    ])

    // If no settings row, return a minimal payload
    if (!settings) {
      return NextResponse.json({
        ok: true,
        notSetup: true,
        message: 'Auto-trader not configured yet. Connect a broker on the settings page.',
      })
    }

    const todayCutoff = new Date()
    todayCutoff.setUTCHours(0, 0, 0, 0)
    const todayIso = todayCutoff.toISOString()
    const last30Iso = new Date(Date.now() - 30 * 86_400_000).toISOString()

    // Today's attempts
    const { data: todayAttempts } = await admin
      .from('trade_attempts')
      .select('outcome, signal_source, realized_pnl, council_signal')
      .eq('user_id', userId)
      .gte('created_at', todayIso)

    const todayRows = (todayAttempts ?? []) as Array<{
      outcome: string
      signal_source: string | null
      realized_pnl: number | string | null
      council_signal: string | null
    }>

    const todayKpis = {
      total: todayRows.length,
      placed: todayRows.filter(r => r.outcome === 'placed' || r.outcome === 'filled' || r.outcome === 'partial_fill').length,
      skipped: todayRows.filter(r => r.outcome === 'skipped').length,
      rejected: todayRows.filter(r => r.outcome === 'rejected').length,
      errors: todayRows.filter(r => r.outcome === 'error').length,
      closedWin: todayRows.filter(r => r.outcome === 'closed_win').length,
      closedLoss: todayRows.filter(r => r.outcome === 'closed_loss').length,
      closedBe: todayRows.filter(r => r.outcome === 'closed_be').length,
      realizedPnl: todayRows.reduce((s, r) => {
        if (r.outcome?.startsWith('closed_') && r.realized_pnl !== null) {
          return s + Number(r.realized_pnl)
        }
        return s
      }, 0),
      bySignalSource: {
        council: todayRows.filter(r => r.signal_source === 'council').length,
        scanner: todayRows.filter(r => r.signal_source === 'scanner').length,
        reeval: todayRows.filter(r => r.signal_source === 'reeval_add').length,
      },
    }

    // Win rate today
    const closedToday = todayKpis.closedWin + todayKpis.closedLoss + todayKpis.closedBe
    const winRateToday = closedToday > 0 ? (todayKpis.closedWin / closedToday) * 100 : null

    // Recent attempts (last 50)
    const { data: recent } = await admin
      .from('trade_attempts')
      .select('id, created_at, ticker, signal_source, council_signal, outcome, side, qty, entry_price_est, stop_price, target_price, filled_avg_price, realized_pnl, reject_reason, mode, broker_order_id, reeval_count, last_reeval_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50)

    // Skipped reason breakdown (last 7 days)
    const last7Iso = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const { data: skippedRows } = await admin
      .from('trade_attempts')
      .select('reject_reason')
      .eq('user_id', userId)
      .eq('outcome', 'skipped')
      .gte('created_at', last7Iso)
      .limit(200)

    const skipBreakdown = buildSkipBreakdown((skippedRows ?? []) as Array<{ reject_reason: string | null }>)

    // 30-day closed trades summary
    const { data: closedRows } = await admin
      .from('trade_attempts')
      .select('outcome, signal_source, realized_pnl')
      .eq('user_id', userId)
      .in('outcome', ['closed_win', 'closed_loss', 'closed_be'])
      .gte('created_at', last30Iso)

    const closed = (closedRows ?? []) as Array<{ outcome: string; signal_source: string | null; realized_pnl: number | string | null }>
    const totalClosed = closed.length
    const wins = closed.filter(r => r.outcome === 'closed_win').length
    const losses = closed.filter(r => r.outcome === 'closed_loss').length
    const breakEvens = closed.filter(r => r.outcome === 'closed_be').length
    const totalPnl = closed.reduce((s, r) => s + (r.realized_pnl !== null ? Number(r.realized_pnl) : 0), 0)
    const winPnl = closed
      .filter(r => r.outcome === 'closed_win' && r.realized_pnl !== null)
      .reduce((s, r) => s + Number(r.realized_pnl), 0)
    const lossPnl = closed
      .filter(r => r.outcome === 'closed_loss' && r.realized_pnl !== null)
      .reduce((s, r) => s + Number(r.realized_pnl), 0)

    const summary30d = {
      totalClosed,
      wins,
      losses,
      breakEvens,
      winRate: totalClosed > 0 ? (wins / totalClosed) * 100 : null,
      totalPnl,
      avgWin: wins > 0 ? winPnl / wins : null,
      avgLoss: losses > 0 ? lossPnl / losses : null,
      bySignalSource: {
        council: closed.filter(r => r.signal_source === 'council').length,
        scanner: closed.filter(r => r.signal_source === 'scanner').length,
      },
    }

    return NextResponse.json({
      ok: true,
      settings: {
        enabled: settings.enabled,
        mode: settings.mode,
        halted: settings.halted,
        haltReason: settings.haltReason,
        haltedAt: settings.haltedAt,
        riskPerTradePct: settings.riskPerTradePct,
        maxPositionPct: settings.maxPositionPct,
        maxDailyLossPct: settings.maxDailyLossPct,
        maxConcurrentPos: settings.maxConcurrentPos,
        maxConsecLosses: settings.maxConsecLosses,
        minGrade: settings.minGrade,
        scannerEnabled: settings.scannerEnabled,
        scannerMaxConcurrent: settings.scannerMaxConcurrent,
        scannerMinComposite: settings.scannerMinComposite,
        activeMgmtEnabled: settings.activeMgmtEnabled,
        reevalDrawdownPct: settings.reevalDrawdownPct,
        allowTightenStop: settings.allowTightenStop,
        allowEarlyExit: settings.allowEarlyExit,
        allowAddPosition: settings.allowAddPosition,
        allowShorts: settings.allowShorts,
        tradeStocks: settings.tradeStocks,
        tradeCrypto: settings.tradeCrypto,
        tradeForex: settings.tradeForex,
        tradeFutures: settings.tradeFutures,
        tradeOptions: settings.tradeOptions,
      },
      broker: credentialMeta,
      todayKpis: {
        ...todayKpis,
        winRate: winRateToday,
      },
      summary30d,
      recent: recent ?? [],
      skipBreakdown,
    })
  } catch (e) {
    console.error('[dashboard] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────

async function loadBrokerCredentialMetaSafe(userId: string): Promise<{
  connected: boolean
  broker?: string
  mode?: string
  keyIdMasked?: string
  accountStatus?: string | null
  accountEquity?: number | null
  accountCash?: number | null
  lastValidatedAt?: string | null
}> {
  try {
    const creds = await listBrokerCredentials(userId)
    const alpaca = creds.find(c => c.broker === 'alpaca')
    if (!alpaca) return { connected: false }
    return {
      connected: true,
      broker: alpaca.broker,
      mode: alpaca.mode,
      keyIdMasked: alpaca.keyIdMasked,
      accountStatus: alpaca.accountStatus,
      accountEquity: alpaca.accountEquity,
      accountCash: alpaca.accountCash,
      lastValidatedAt: alpaca.lastValidatedAt,
    }
  } catch {
    return { connected: false }
  }
}

function buildSkipBreakdown(rows: Array<{ reject_reason: string | null }>): Array<{ category: string; count: number; sample: string }> {
  const buckets = new Map<string, { count: number; sample: string }>()
  for (const r of rows) {
    if (!r.reject_reason) continue
    const cat = categorizeSkipReason(r.reject_reason)
    const existing = buckets.get(cat)
    if (existing) {
      existing.count++
    } else {
      buckets.set(cat, { count: 1, sample: r.reject_reason.slice(0, 200) })
    }
  }
  return [...buckets.entries()]
    .map(([category, { count, sample }]) => ({ category, count, sample }))
    .sort((a, b) => b.count - a.count)
}

function categorizeSkipReason(reason: string): string {
  const r = reason.toLowerCase()
  if (r.includes('trader_decision')) return 'Not a TAKE'
  if (r.includes('grade')) return 'Grade below floor'
  if (r.includes('age') || r.includes('stale')) return 'Verdict too old'
  if (r.includes('short-sell') || r.includes('bearish')) return 'BEARISH skipped (no shorts)'
  if (r.includes('forex') || r.includes('crypto') || r.includes('asset class')) return 'Wrong asset class'
  if (r.includes('size') || r.includes('sizing')) return 'Sizing failed'
  if (r.includes('halt')) return 'Account halted'
  if (r.includes('concurrent')) return 'At max concurrent'
  if (r.includes('daily loss')) return 'Daily loss limit'
  if (r.includes('consecutive losses')) return 'Consecutive losses'
  if (r.includes('already')) return 'Already in position'
  if (r.includes('not tradable') || r.includes('alpaca:')) return 'Alpaca rejected ticker'
  return 'Other'
}
