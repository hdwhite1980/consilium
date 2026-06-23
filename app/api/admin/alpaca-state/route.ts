// =============================================================
// app/api/admin/alpaca-state/route.ts
//
// Diagnostic endpoint that returns current Alpaca positions and
// open orders for the calling user. Uses the encrypted credentials
// from the database via loadBrokerCredentialForUse — no need to
// expose the secret externally.
//
// AUTH: Bearer ADMIN_SECRET or CRON_SECRET.
//
// USAGE:
//   curl.exe "https://wali-os.com/api/admin/alpaca-state?userId=709312ee-..." `
//     -H "Authorization: Bearer wali-os-cron-2026"
//
// Returns:
//   {
//     positions: [{symbol, qty, avg_entry_price, current_price, unrealized_pl}],
//     openOrders: [{symbol, side, type, qty, stop_price, limit_price, status}],
//     stopCoverage: {
//       APGE: { hasStop: true/false, stopPrice: 123.45 },
//       ...
//     }
//   }
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.ADMIN_SECRET ?? process.env.CRON_SECRET ?? ''
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  return auth === `Bearer ${expected}`
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = req.nextUrl.searchParams.get('userId')
  const mode = (req.nextUrl.searchParams.get('mode') ?? 'paper') as 'paper' | 'live'
  if (!userId) {
    return NextResponse.json({ error: 'Missing userId query param' }, { status: 400 })
  }

  // Load credentials (decrypted in-app, never returned to caller)
  const credLoad = await loadBrokerCredentialForUse(userId, 'alpaca', mode, 'stock')
  if (!credLoad) {
    return NextResponse.json({
      error: `No alpaca/${mode}/stock credential for user ${userId}`,
    }, { status: 404 })
  }

  const baseUrl = mode === 'paper'
    ? 'https://paper-api.alpaca.markets'
    : 'https://api.alpaca.markets'
  const headers = {
    'APCA-API-KEY-ID': credLoad.keyId,
    'APCA-API-SECRET-KEY': credLoad.secret,
  }

  try {
    // Fetch positions and open orders in parallel
    const [posRes, orderRes] = await Promise.all([
      fetch(`${baseUrl}/v2/positions`, { headers }),
      fetch(`${baseUrl}/v2/orders?status=open&limit=200`, { headers }),
    ])

    if (!posRes.ok) {
      const text = await posRes.text()
      return NextResponse.json({
        error: `Alpaca /positions failed: HTTP ${posRes.status}`,
        body: text.slice(0, 300),
      }, { status: 500 })
    }
    if (!orderRes.ok) {
      const text = await orderRes.text()
      return NextResponse.json({
        error: `Alpaca /orders failed: HTTP ${orderRes.status}`,
        body: text.slice(0, 300),
      }, { status: 500 })
    }

    const rawPositions = await posRes.json() as Array<Record<string, unknown>>
    const rawOrders = await orderRes.json() as Array<Record<string, unknown>>

    const positions = rawPositions
      .filter(p => String(p.asset_class ?? 'us_equity') === 'us_equity')
      .map(p => ({
        symbol: String(p.symbol),
        qty: Number(p.qty),
        side: String(p.side),
        avg_entry_price: Number(p.avg_entry_price),
        current_price: Number(p.current_price),
        unrealized_pl: Number(p.unrealized_pl),
        market_value: Number(p.market_value),
      }))

    const openOrders = rawOrders.map(o => ({
      id: String(o.id),
      client_order_id: String(o.client_order_id ?? ''),
      symbol: String(o.symbol),
      side: String(o.side),
      order_type: String(o.order_type ?? o.type ?? ''),
      qty: o.qty !== null && o.qty !== undefined ? Number(o.qty) : null,
      stop_price: o.stop_price !== null && o.stop_price !== undefined ? Number(o.stop_price) : null,
      limit_price: o.limit_price !== null && o.limit_price !== undefined ? Number(o.limit_price) : null,
      status: String(o.status),
      order_class: String(o.order_class ?? ''),
      submitted_at: String(o.submitted_at ?? ''),
    }))

    // Compute stop coverage: for each position, find an open stop order on same symbol
    const stopCoverage: Record<string, {
      qty: number
      hasStop: boolean
      stopPrice: number | null
      stopOrderId: string | null
      hasTarget: boolean
      targetPrice: number | null
    }> = {}
    for (const pos of positions) {
      const stops = openOrders.filter(o =>
        o.symbol === pos.symbol &&
        o.side === 'sell' &&
        (o.order_type === 'stop' || o.order_type === 'stop_limit')
      )
      const targets = openOrders.filter(o =>
        o.symbol === pos.symbol &&
        o.side === 'sell' &&
        o.order_type === 'limit'
      )
      stopCoverage[pos.symbol] = {
        qty: pos.qty,
        hasStop: stops.length > 0,
        stopPrice: stops[0]?.stop_price ?? null,
        stopOrderId: stops[0]?.id ?? null,
        hasTarget: targets.length > 0,
        targetPrice: targets[0]?.limit_price ?? null,
      }
    }

    return NextResponse.json({
      mode,
      positions,
      openOrders,
      stopCoverage,
      summary: {
        positionsCount: positions.length,
        openOrdersCount: openOrders.length,
        protectedCount: Object.values(stopCoverage).filter(s => s.hasStop).length,
        unprotectedCount: Object.values(stopCoverage).filter(s => !s.hasStop).length,
        unprotectedSymbols: Object.entries(stopCoverage)
          .filter(([, s]) => !s.hasStop)
          .map(([sym]) => sym),
      },
    })
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : String(e),
    }, { status: 500 })
  }
}
