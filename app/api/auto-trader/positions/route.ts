// =============================================================
// app/api/auto-trader/positions/route.ts
//
// Live Alpaca positions for the requesting user, joined with our
// trade_attempts overlay (so we know our stop/target/reeval count
// alongside Alpaca's current price/unrealized P&L).
//
// Auth: session required.
// =============================================================

import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/app/lib/auth/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { loadUserTradingSettings } from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import { makeAlpacaClient } from '@/app/lib/trading/alpaca-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PositionRow {
  ticker: string
  side: 'long' | 'short'
  qty: number
  avgEntry: number
  currentPrice: number
  marketValue: number
  unrealizedPl: number
  unrealizedPlPct: number
  // From trade_attempts overlay
  attemptId?: string
  ourStop?: number
  ourTarget?: number
  signalSource?: string
  councilSignal?: string
  reevalCount?: number
  lastReevalAt?: string
  filledAt?: string
}

export async function GET(): Promise<NextResponse> {
  const supa = await createAuthClient()
  const { data: { user } } = await supa.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const userId = user.id
    const settings = await loadUserTradingSettings(userId)
    if (!settings) {
      return NextResponse.json({ ok: true, positions: [], message: 'Auto-trader not configured' })
    }

    const credLoad = await loadBrokerCredentialForUse(userId, settings.broker, settings.mode)
    if (!credLoad) {
      return NextResponse.json({ ok: true, positions: [], message: 'Broker not connected' })
    }
    const alpaca = makeAlpacaClient(credLoad.keyId, credLoad.secret, settings.mode)

    const [alpacaPositions, account] = await Promise.all([
      alpaca.positions().catch(e => {
        console.warn('[positions] Alpaca fetch failed:', e instanceof Error ? e.message : e)
        return []
      }),
      alpaca.account().catch(() => null),
    ])

    // Join with our trade_attempts
    const admin = await getSupabaseAdmin()
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const { data: attempts } = await admin
      .from('trade_attempts')
      .select('id, ticker, signal_source, council_signal, side, stop_price, target_price, filled_avg_price, filled_at, reeval_count, last_reeval_at')
      .eq('user_id', userId)
      .in('outcome', ['placed', 'filled', 'partial_fill'])
      .gte('created_at', cutoff)

    const attemptByTicker = new Map<string, Record<string, unknown>>()
    for (const a of (attempts ?? []) as Array<Record<string, unknown>>) {
      const ticker = String(a.ticker).toUpperCase()
      if (!attemptByTicker.has(ticker)) attemptByTicker.set(ticker, a)
    }

    const positions: PositionRow[] = alpacaPositions.map(p => {
      const ticker = p.symbol.toUpperCase()
      const att = attemptByTicker.get(ticker)
      const unrealPct = p.avg_entry_price > 0
        ? ((p.current_price - p.avg_entry_price) / p.avg_entry_price) * 100 * (p.side === 'long' ? 1 : -1)
        : 0
      return {
        ticker,
        side: p.side,
        qty: p.qty,
        avgEntry: p.avg_entry_price,
        currentPrice: p.current_price,
        marketValue: p.market_value,
        unrealizedPl: p.unrealized_pl,
        unrealizedPlPct: unrealPct,
        attemptId: att ? String(att.id) : undefined,
        ourStop: att?.stop_price !== undefined && att.stop_price !== null ? Number(att.stop_price) : undefined,
        ourTarget: att?.target_price !== undefined && att.target_price !== null ? Number(att.target_price) : undefined,
        signalSource: att?.signal_source ? String(att.signal_source) : undefined,
        councilSignal: att?.council_signal ? String(att.council_signal) : undefined,
        reevalCount: att?.reeval_count !== undefined && att.reeval_count !== null ? Number(att.reeval_count) : undefined,
        lastReevalAt: att?.last_reeval_at ? String(att.last_reeval_at) : undefined,
        filledAt: att?.filled_at ? String(att.filled_at) : undefined,
      }
    })

    return NextResponse.json({
      ok: true,
      positions,
      account: account ? {
        status: account.status,
        equity: account.equity,
        cash: account.cash,
        buyingPower: account.buying_power,
      } : null,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }
}
