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
    // Fetch positions, open orders, AND closed orders from today
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const todayMidnight = today.toISOString()
    // Also look back 7 days for context
    const weekAgo = new Date()
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7)
    const weekAgoIso = weekAgo.toISOString()

    const [posRes, openRes, closedRes] = await Promise.all([
      fetch(`${baseUrl}/v2/positions`, { headers }),
      fetch(`${baseUrl}/v2/orders?status=open&limit=200&nested=true`, { headers }),
      fetch(`${baseUrl}/v2/orders?status=closed&after=${encodeURIComponent(weekAgoIso)}&limit=500&nested=true`, { headers }),
    ])

    if (!posRes.ok) {
      const text = await posRes.text()
      return NextResponse.json({
        error: `Alpaca /positions failed: HTTP ${posRes.status}`,
        body: text.slice(0, 300),
      }, { status: 500 })
    }
    if (!openRes.ok) {
      const text = await openRes.text()
      return NextResponse.json({
        error: `Alpaca /orders (open) failed: HTTP ${openRes.status}`,
        body: text.slice(0, 300),
      }, { status: 500 })
    }
    if (!closedRes.ok) {
      const text = await closedRes.text()
      return NextResponse.json({
        error: `Alpaca /orders (closed) failed: HTTP ${closedRes.status}`,
        body: text.slice(0, 300),
      }, { status: 500 })
    }

    const rawPositions = await posRes.json() as Array<Record<string, unknown>>
    const rawOpenOrders = await openRes.json() as Array<Record<string, unknown>>
    const rawClosedOrders = await closedRes.json() as Array<Record<string, unknown>>

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

    function mapOrder(o: Record<string, unknown>) {
      const legs = Array.isArray(o.legs) ? o.legs as Array<Record<string, unknown>> : null
      return {
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
        filled_at: o.filled_at ? String(o.filled_at) : null,
        canceled_at: o.canceled_at ? String(o.canceled_at) : null,
        legs_count: legs ? legs.length : 0,
        legs: legs ? legs.map(l => ({
          id: String(l.id),
          symbol: String(l.symbol),
          side: String(l.side),
          order_type: String(l.order_type ?? l.type ?? ''),
          stop_price: l.stop_price !== null && l.stop_price !== undefined ? Number(l.stop_price) : null,
          limit_price: l.limit_price !== null && l.limit_price !== undefined ? Number(l.limit_price) : null,
          status: String(l.status),
          canceled_at: l.canceled_at ? String(l.canceled_at) : null,
        })) : null,
      }
    }

    const openOrders = rawOpenOrders.map(mapOrder)
    const closedOrders = rawClosedOrders.map(mapOrder)

    // Compute stop coverage: for each position, find an open stop order on same symbol
    const stopCoverage: Record<string, {
      qty: number
      hasStop: boolean
      stopPrice: number | null
      stopOrderId: string | null
      hasTarget: boolean
      targetPrice: number | null
      historicalStops: Array<{ id: string; status: string; stop_price: number | null; canceled_at: string | null; submitted_at: string }>
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
      // Look for historical stop orders for this symbol (canceled, filled, etc.)
      const historicalStops = closedOrders
        .filter(o =>
          o.symbol === pos.symbol &&
          o.side === 'sell' &&
          (o.order_type === 'stop' || o.order_type === 'stop_limit')
        )
        .map(o => ({
          id: o.id,
          status: o.status,
          stop_price: o.stop_price,
          canceled_at: o.canceled_at,
          submitted_at: o.submitted_at,
        }))
      stopCoverage[pos.symbol] = {
        qty: pos.qty,
        hasStop: stops.length > 0,
        stopPrice: stops[0]?.stop_price ?? null,
        stopOrderId: stops[0]?.id ?? null,
        hasTarget: targets.length > 0,
        targetPrice: targets[0]?.limit_price ?? null,
        historicalStops,
      }
    }

    // Also look at the parent BUY orders for each position to see legs
    const parentBuyOrders: Record<string, Array<{
      id: string
      client_order_id: string
      order_class: string
      status: string
      filled_at: string | null
      legs_count: number
      legs: unknown
    }>> = {}
    for (const pos of positions) {
      const buyOrders = [...openOrders, ...closedOrders].filter(o =>
        o.symbol === pos.symbol &&
        o.side === 'buy'
      ).map(o => ({
        id: o.id,
        client_order_id: o.client_order_id,
        order_class: o.order_class,
        status: o.status,
        filled_at: o.filled_at,
        legs_count: o.legs_count,
        legs: o.legs,
      }))
      parentBuyOrders[pos.symbol] = buyOrders
    }

    return NextResponse.json({
      mode,
      positions,
      openOrders,
      closedOrdersCount: closedOrders.length,
      stopCoverage,
      parentBuyOrders,
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
