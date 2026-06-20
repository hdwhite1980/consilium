// =============================================================
// app/api/admin/users/[userId]/trading/route.ts
//
// GET   → get user's trading settings (creates row with defaults if none exists)
// PATCH → update settings { action, payload }
//
// Actions:
//   - { action: 'toggle_enabled', payload: { enabled: boolean } }
//   - { action: 'set_mode', payload: { mode: 'paper' | 'live' } }
//   - { action: 'clear_halt', payload: {} }     -- re-enable a halted account
//   - { action: 'update_limits', payload: { ...numeric fields } }
//   - { action: 'set_asset_filters', payload: { trade_stocks?, trade_crypto?, ... } }
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/app/lib/admin/admin-auth'
import { loadUserTradingSettings, upsertUserTradingSettings } from '@/app/lib/trading/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response!
  const { userId } = await ctx.params

  try {
    let settings = await loadUserTradingSettings(userId)
    if (!settings) {
      // Lazily create a row with defaults so the UI has something to edit
      settings = await upsertUserTradingSettings(userId, {})
    }
    return NextResponse.json({ settings })
  } catch (e) {
    console.error('[admin trading GET] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }
}

interface PatchBody {
  action:
    | 'toggle_enabled'
    | 'set_mode'
    | 'clear_halt'
    | 'update_limits'
    | 'set_asset_filters'
  payload?: Record<string, unknown>
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response!
  const { userId } = await ctx.params

  let body: PatchBody
  try {
    body = await req.json() as PatchBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const { action } = body
  const payload = body.payload ?? {}

  try {
    let updated: Awaited<ReturnType<typeof upsertUserTradingSettings>>
    switch (action) {
      case 'toggle_enabled': {
        const enabled = payload.enabled
        if (typeof enabled !== 'boolean') {
          return NextResponse.json({ error: 'payload.enabled must be boolean' }, { status: 400 })
        }
        updated = await upsertUserTradingSettings(userId, { enabled })
        break
      }
      case 'set_mode': {
        const mode = payload.mode
        if (mode !== 'paper' && mode !== 'live') {
          return NextResponse.json({ error: 'payload.mode must be "paper" or "live"' }, { status: 400 })
        }
        updated = await upsertUserTradingSettings(userId, { mode })
        break
      }
      case 'clear_halt': {
        updated = await upsertUserTradingSettings(userId, {
          halted: false,
          haltReason: null,
          haltedAt: null,
        })
        break
      }
      case 'update_limits': {
        const patch: Record<string, number> = {}
        const numericFields: Array<[keyof typeof patch, 'riskPerTradePct' | 'maxPositionPct' | 'maxDailyLossPct' | 'maxConcurrentPos' | 'maxConsecLosses']> = [
          ['risk_per_trade_pct', 'riskPerTradePct'],
          ['max_position_pct', 'maxPositionPct'],
          ['max_daily_loss_pct', 'maxDailyLossPct'],
          ['max_concurrent_pos', 'maxConcurrentPos'],
          ['max_consec_losses', 'maxConsecLosses'],
        ]
        const updates: Record<string, number> = {}
        for (const [snake, camel] of numericFields) {
          const v = payload[snake] ?? payload[camel as string]
          if (v !== undefined) {
            if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
              return NextResponse.json({ error: `${snake} must be a positive number` }, { status: 400 })
            }
            updates[camel as string] = v
          }
        }
        updated = await upsertUserTradingSettings(userId, updates as Parameters<typeof upsertUserTradingSettings>[1])
        break
      }
      case 'set_asset_filters': {
        const fields: Array<['trade_stocks' | 'trade_crypto' | 'trade_options' | 'trade_forex', 'tradeStocks' | 'tradeCrypto' | 'tradeOptions' | 'tradeForex']> = [
          ['trade_stocks', 'tradeStocks'],
          ['trade_crypto', 'tradeCrypto'],
          ['trade_options', 'tradeOptions'],
          ['trade_forex', 'tradeForex'],
        ]
        const updates: Record<string, boolean> = {}
        for (const [snake, camel] of fields) {
          const v = payload[snake] ?? payload[camel]
          if (v !== undefined) {
            if (typeof v !== 'boolean') {
              return NextResponse.json({ error: `${snake} must be boolean` }, { status: 400 })
            }
            updates[camel] = v
          }
        }
        updated = await upsertUserTradingSettings(userId, updates as Parameters<typeof upsertUserTradingSettings>[1])
        break
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
    console.log(`[admin trading PATCH] user=${userId} action=${action} by=${guard.user?.email}`)
    return NextResponse.json({ ok: true, settings: updated })
  } catch (e) {
    let detail: string
    if (e instanceof Error) detail = e.message
    else if (e && typeof e === 'object') {
      const obj = e as Record<string, unknown>
      detail = [obj.message, obj.details, obj.hint, obj.code ? `code=${obj.code}` : null]
        .filter(Boolean).join(' | ') || JSON.stringify(obj)
    } else detail = String(e)
    console.error('[admin trading PATCH] failed:', detail, e)
    return NextResponse.json({ error: detail }, { status: 500 })
  }
}
