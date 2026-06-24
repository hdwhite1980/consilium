// =============================================================
// app/api/auto-trader/positions/route.ts (v2)
//
// Live positions for the requesting user, joined with trade_attempts
// overlay. Pulls from BOTH Alpaca AND Coinbase when configured.
//
// v2 changes:
//   - Coinbase positions included alongside Alpaca
//   - Account snapshot shows combined cash/equity across brokers
//   - assetClass field on each position row (stock|crypto)
//   - brokerName field on each position row
//
// Auth: session required.
// =============================================================

import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/app/lib/auth/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { loadUserTradingSettings } from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse, loadCoinbaseCredential } from '@/app/lib/trading/credentials'
import { makeAlpacaClient } from '@/app/lib/trading/alpaca-client'
import { makeCoinbaseClient } from '@/app/lib/trading/coinbase-client'

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
  // Discriminators
  assetClass: 'stock' | 'crypto'
  brokerName: 'alpaca' | 'coinbase'
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

interface AccountInfo {
  status: string
  equity: number
  cash: number
  buyingPower: number
}

interface BrokerSnapshot {
  broker: 'alpaca' | 'coinbase'
  account: AccountInfo
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

    const admin = await getSupabaseAdmin()
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const { data: attempts } = await admin
      .from('trade_attempts')
      .select('id, ticker, signal_source, council_signal, side, stop_price, target_price, filled_avg_price, filled_at, reeval_count, last_reeval_at, asset_class, broker')
      .eq('user_id', userId)
      .in('outcome', ['placed', 'filled', 'partial_fill'])
      .gte('created_at', cutoff)

    const attemptByKey = new Map<string, Record<string, unknown>>()
    for (const a of (attempts ?? []) as Array<Record<string, unknown>>) {
      const ticker = String(a.ticker).toUpperCase()
      const key = `${ticker}:${String(a.broker ?? 'alpaca')}`
      if (!attemptByKey.has(key)) attemptByKey.set(key, a)
      // Also index by ticker-only for fallback lookup
      if (!attemptByKey.has(ticker)) attemptByKey.set(ticker, a)
    }

    const positions: PositionRow[] = []
    const brokers: BrokerSnapshot[] = []

    // ── Alpaca (stocks + Alpaca crypto if any) ──────────────
    const alpacaCred = await loadBrokerCredentialForUse(userId, 'alpaca', settings.mode)
    if (alpacaCred) {
      const alpaca = makeAlpacaClient(alpacaCred.keyId, alpacaCred.secret, settings.mode)
      const [alpacaPositions, account] = await Promise.all([
        alpaca.positions().catch(e => {
          console.warn('[positions] Alpaca positions fetch failed:', e instanceof Error ? e.message : e)
          return []
        }),
        alpaca.account().catch(() => null),
      ])

      for (const p of alpacaPositions) {
        const ticker = p.symbol.toUpperCase()
        // Alpaca crypto uses no slash, but our DB has BTC/USD pattern. Try both.
        const att = attemptByKey.get(`${ticker}:alpaca`)
                 ?? attemptByKey.get(ticker)
                 ?? attemptByKey.get(`${ticker.replace(/USD$/, '/USD')}:alpaca`)
        const unrealPct = p.avg_entry_price > 0
          ? ((p.current_price - p.avg_entry_price) / p.avg_entry_price) * 100 * (p.side === 'long' ? 1 : -1)
          : 0

        // Detect crypto by Alpaca's asset_class field if present, else fallback
        const isCrypto = (p as { asset_class?: string }).asset_class === 'crypto'
                      || /^(BTC|ETH|LTC|BCH|DOGE|SOL|MATIC|AVAX|UNI|LINK|AAVE|XRP|DOT|ATOM|ADA)/.test(ticker)

        positions.push({
          ticker,
          side: p.side,
          qty: p.qty,
          avgEntry: p.avg_entry_price,
          currentPrice: p.current_price,
          marketValue: p.market_value,
          unrealizedPl: p.unrealized_pl,
          unrealizedPlPct: unrealPct,
          assetClass: isCrypto ? 'crypto' : 'stock',
          brokerName: 'alpaca',
          attemptId: att ? String(att.id) : undefined,
          ourStop: att?.stop_price !== undefined && att.stop_price !== null ? Number(att.stop_price) : undefined,
          ourTarget: att?.target_price !== undefined && att.target_price !== null ? Number(att.target_price) : undefined,
          signalSource: att?.signal_source ? String(att.signal_source) : undefined,
          councilSignal: att?.council_signal ? String(att.council_signal) : undefined,
          reevalCount: att?.reeval_count !== undefined && att.reeval_count !== null ? Number(att.reeval_count) : undefined,
          lastReevalAt: att?.last_reeval_at ? String(att.last_reeval_at) : undefined,
          filledAt: att?.filled_at ? String(att.filled_at) : undefined,
        })
      }

      if (account) {
        brokers.push({
          broker: 'alpaca',
          account: {
            status: account.status,
            equity: account.equity,
            cash: account.cash,
            buyingPower: account.buying_power,
          },
        })
      }
    }

    // ── Coinbase (crypto) ────────────────────────────────────
    const coinbaseCred = await loadCoinbaseCredential(userId)
    if (coinbaseCred) {
      const coinbase = makeCoinbaseClient(coinbaseCred.keyName, coinbaseCred.privateKey)
      const [coinbasePositions, coinbaseAccount] = await Promise.all([
        coinbase.positions().catch(e => {
          console.warn('[positions] Coinbase positions fetch failed:', e instanceof Error ? e.message : e)
          return []
        }),
        coinbase.account().catch(() => null),
      ])

      for (const p of coinbasePositions) {
        const ticker = p.symbol.toUpperCase()
        const att = attemptByKey.get(`${ticker}:coinbase`)
                 ?? attemptByKey.get(ticker)

        // Get current price for this position. Coinbase positions don't always
        // include current price — fetch spot if needed.
        let currentPrice = (p as { current_price?: number }).current_price ?? 0
        if (!currentPrice || !Number.isFinite(currentPrice) || currentPrice <= 0) {
          currentPrice = await coinbase.getSpotPrice(ticker).catch(() => 0)
        }

        const avgEntry = (p as { avg_entry_price?: number }).avg_entry_price ?? 0
        const qty = p.qty
        const marketValue = currentPrice * qty
        const unrealPl = avgEntry > 0 ? (currentPrice - avgEntry) * qty : 0
        const unrealPct = avgEntry > 0 ? ((currentPrice - avgEntry) / avgEntry) * 100 : 0

        positions.push({
          ticker,
          side: 'long',  // Coinbase spot is long-only
          qty,
          avgEntry,
          currentPrice,
          marketValue,
          unrealizedPl: unrealPl,
          unrealizedPlPct: unrealPct,
          assetClass: 'crypto',
          brokerName: 'coinbase',
          attemptId: att ? String(att.id) : undefined,
          ourStop: att?.stop_price !== undefined && att.stop_price !== null ? Number(att.stop_price) : undefined,
          ourTarget: att?.target_price !== undefined && att.target_price !== null ? Number(att.target_price) : undefined,
          signalSource: att?.signal_source ? String(att.signal_source) : undefined,
          councilSignal: att?.council_signal ? String(att.council_signal) : undefined,
          reevalCount: att?.reeval_count !== undefined && att.reeval_count !== null ? Number(att.reeval_count) : undefined,
          lastReevalAt: att?.last_reeval_at ? String(att.last_reeval_at) : undefined,
          filledAt: att?.filled_at ? String(att.filled_at) : undefined,
        })
      }

      if (coinbaseAccount) {
        brokers.push({
          broker: 'coinbase',
          account: {
            status: coinbaseAccount.status,
            equity: coinbaseAccount.equity,
            cash: coinbaseAccount.cash,
            buyingPower: coinbaseAccount.cash,  // Coinbase doesn't have buying power concept
          },
        })
      }
    }

    // Combined account snapshot (back-compat with existing dashboard component)
    const combined: AccountInfo | null = brokers.length > 0
      ? {
          status: brokers.every(b => b.account.status === 'ACTIVE') ? 'ACTIVE' : brokers[0].account.status,
          equity: brokers.reduce((s, b) => s + b.account.equity, 0),
          cash: brokers.reduce((s, b) => s + b.account.cash, 0),
          buyingPower: brokers.reduce((s, b) => s + b.account.buyingPower, 0),
        }
      : null

    return NextResponse.json({
      ok: true,
      positions,
      account: combined,
      brokers,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }
}
