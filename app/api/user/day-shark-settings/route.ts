// =============================================================
// app/api/user/day-shark-settings/route.ts
//
// Load/save Max's per-asset allocation sliders. Backs the Day Shark settings UI
// so allocations can be set without hand-editing SQL.
//
// GET  → { stock, crypto, forex }  (each 0..1)
// POST { stock?, crypto?, forex? } → clamps to 0..1, writes user_trading_settings
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function getUserId(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id ?? null
}

function admin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

function clamp01(v: unknown): number | null {
  if (v === undefined || v === null) return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(1, n))
}

export async function GET(): Promise<NextResponse> {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data, error } = await admin()
    .from('user_trading_settings')
    .select('max_alloc_stock_pct, max_alloc_crypto_pct, max_alloc_forex_pct')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({
    stock: Number(data?.max_alloc_stock_pct ?? 0),
    crypto: Number(data?.max_alloc_crypto_pct ?? 0),
    forex: Number(data?.max_alloc_forex_pct ?? 0),
  })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }

  const patch: Record<string, number> = {}
  const stock = clamp01(body.stock); if (stock !== null) patch.max_alloc_stock_pct = stock
  const crypto = clamp01(body.crypto); if (crypto !== null) patch.max_alloc_crypto_pct = crypto
  const forex = clamp01(body.forex); if (forex !== null) patch.max_alloc_forex_pct = forex
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'nothing to update' }, { status: 400 })

  const { error } = await admin()
    .from('user_trading_settings')
    .update(patch)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, ...patch })
}
