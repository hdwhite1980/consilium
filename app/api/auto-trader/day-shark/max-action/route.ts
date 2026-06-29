// =============================================================
// app/api/auto-trader/day-shark/max-action/route.ts
//
// Deterministic close executor for Max's chat. The LLM NEVER calls this —
// only an explicit user confirmation (confirm:true from a button tap) does.
// Scope is day_shark positions ONLY (the book Max manages). Reuses the same
// per-asset broker-close path as day-shark-monitor. Refuses to close anything
// it can't get a live price for — no blind real-money sells.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { loadUserTradingSettings } from '@/app/lib/trading/settings'
import { setupSharkLane, type SharkLane } from '@/app/lib/trading/day-shark-lane'
import type { SharkAsset } from '@/app/lib/trading/day-shark'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

function admin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

interface OpenPos {
  id: number; ticker: string; asset_class: string | null; side: string | null
  qty: number | null; entry_price_est: number | null; filled_avg_price: number | null
}

async function loadOpen(userId: string): Promise<OpenPos[]> {
  const { data } = await admin()
    .from('trade_attempts')
    .select('id, ticker, asset_class, side, qty, entry_price_est, filled_avg_price')
    .eq('user_id', userId)
    .eq('signal_source', 'day_shark')
    .in('outcome', ['placed', 'filled', 'partial_fill'])
  return (data ?? []) as OpenPos[]
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { action?: string; ticker?: string; confirm?: boolean }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad request' }, { status: 400 }) }

  // Safety gate: nothing executes without an explicit confirmation flag.
  if (body.confirm !== true) return NextResponse.json({ error: 'confirmation required' }, { status: 400 })

  const action = body.action
  if (action !== 'close_one' && action !== 'close_all') {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }

  const settings = await loadUserTradingSettings(user.id)
  if (!settings) return NextResponse.json({ error: 'no trading settings' }, { status: 400 })

  let positions = await loadOpen(user.id)
  if (action === 'close_one') {
    const t = String(body.ticker ?? '').toUpperCase().trim()
    if (!t) return NextResponse.json({ error: 'no ticker' }, { status: 400 })
    positions = positions.filter(p => p.ticker.toUpperCase() === t)
    if (!positions.length) return NextResponse.json({ error: `No open ${t} position to close.` }, { status: 404 })
  }
  if (!positions.length) {
    return NextResponse.json({ closed: [], errors: [], message: 'Nothing open to close.' })
  }

  const lanes = new Map<string, SharkLane | { error: string }>()
  const closed: Array<{ ticker: string; price: number; pnl: number | null }> = []
  const errors: Array<{ ticker: string; error: string }> = []

  for (const pos of positions) {
    const asset = (pos.asset_class ?? 'stock') as SharkAsset
    if (!lanes.has(asset)) lanes.set(asset, await setupSharkLane(settings, asset))
    const lane = lanes.get(asset)!
    if ('error' in lane) { errors.push({ ticker: pos.ticker, error: lane.error }); continue }

    const entry = pos.filled_avg_price ?? pos.entry_price_est
    const isLong = pos.side !== 'sell'
    const side: 'buy' | 'sell' = isLong ? 'buy' : 'sell'

    try {
      // Require a live price BEFORE closing — no blind real-money sells, and it
      // keeps the win/loss label honest instead of guessing.
      const price = await lane.price(pos.ticker)
      if (price === null || price <= 0) {
        errors.push({ ticker: pos.ticker, error: 'no live price right now — try again in a moment' })
        continue
      }

      await lane.close(pos.ticker, side)

      const gainPct = entry && entry > 0 ? (isLong ? (price - entry) / entry : (entry - price) / entry) : 0
      const win = gainPct >= 0
      const qty = pos.qty != null ? Number(pos.qty) : 0
      const pnl = qty > 0 && entry && entry > 0 ? Number((gainPct * entry * qty).toFixed(2)) : null

      await admin().from('trade_attempts').update({
        outcome: win ? 'closed_win' : 'closed_loss',
        exit_price: price,
        realized_pnl: pnl,
        closure_kind: 'manual_close',
        closed_at: new Date().toISOString(),
      }).eq('id', pos.id)

      closed.push({ ticker: pos.ticker, price, pnl })
      console.log(`[max-action] CLOSE ${pos.ticker} @ ${price} (manual, ${win ? 'WIN' : 'LOSS'})`)
    } catch (e) {
      errors.push({ ticker: pos.ticker, error: e instanceof Error ? e.message : 'close failed' })
    }
  }

  return NextResponse.json({ closed, errors })
}
