// =============================================================
// app/api/auto-trader/settings/route.ts
//
// User-facing trading-rule controls for the requesting user's OWN
// account. No admin required — the user is acting on their own data.
//
// GET   → current rule toggles (enabled, allowShorts, asset filters)
// PATCH → { enabled?, allowShorts?, tradeStocks?, tradeCrypto?,
//           tradeForex?, tradeFutures?, tradeOptions? }  (all boolean)
//
// Deliberately scoped to safe booleans. It does NOT expose mode
// (paper/live) or numeric risk limits — those stay on the broker-connect
// / admin paths, so a stray UI toggle can never flip the account to live
// or widen risk.
//
// Auth: session required (mirrors auto-trader/clear-halt).
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/app/lib/auth/server'
import { loadUserTradingSettings, upsertUserTradingSettings } from '@/app/lib/trading/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BOOL_FIELDS = [
  'enabled', 'allowShorts',
  'tradeStocks', 'tradeCrypto', 'tradeForex', 'tradeFutures', 'tradeOptions',
  'earningsFullSize', 'allowLowPriceShares', 'allowFractionalShares',
  'coinbaseFuturesEnabled',
] as const
type BoolField = typeof BOOL_FIELDS[number]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rulesView(s: any) {
  return {
    enabled: s.enabled,
    allowShorts: s.allowShorts,
    tradeStocks: s.tradeStocks,
    tradeCrypto: s.tradeCrypto,
    tradeForex: s.tradeForex,
    tradeFutures: s.tradeFutures,
    tradeOptions: s.tradeOptions,
    earningsFullSize: s.earningsFullSize,
    allowLowPriceShares: s.allowLowPriceShares,
    allowFractionalShares: s.allowFractionalShares,
    coinbaseFuturesEnabled: s.coinbaseFuturesEnabled,
  }
}

export async function GET(): Promise<NextResponse> {
  const supa = await createAuthClient()
  const { data: { user } } = await supa.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const s = await loadUserTradingSettings(user.id)
    if (!s) return NextResponse.json({ error: 'No trading settings found' }, { status: 404 })
    return NextResponse.json({ rules: rulesView(s) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supa = await createAuthClient()
  const { data: { user } } = await supa.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // Whitelist: only the known boolean rule fields are accepted, and each
  // must actually be a boolean. Everything else is ignored/rejected.
  const patch: Partial<Record<BoolField, boolean>> = {}
  for (const f of BOOL_FIELDS) {
    if (f in body) {
      if (typeof body[f] !== 'boolean') {
        return NextResponse.json({ error: `${f} must be boolean` }, { status: 400 })
      }
      patch[f] = body[f] as boolean
    }
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No valid rule fields provided' }, { status: 400 })
  }

  try {
    const existing = await loadUserTradingSettings(user.id)
    if (!existing) return NextResponse.json({ error: 'No trading settings found' }, { status: 404 })
    const updated = await upsertUserTradingSettings(
      user.id, patch as Parameters<typeof upsertUserTradingSettings>[1],
    )
    console.log(
      `[auto-trader settings] user=${user.id} updated rules: ` +
      Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', '),
    )
    return NextResponse.json({ ok: true, rules: rulesView(updated) })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }
}
