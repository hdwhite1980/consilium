// =============================================================
// app/api/admin/users/[userId]/trading/clear-halt/route.ts
//
// POST → reset halted=false on a user's trading settings.
// Admin-only. Used to re-enable an auto-halted account.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/app/lib/admin/admin-auth'
import { upsertUserTradingSettings } from '@/app/lib/trading/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response!
  const { userId } = await ctx.params

  try {
    const updated = await upsertUserTradingSettings(userId, {
      halted: false,
      haltReason: null,
      haltedAt: null,
    })
    console.log(`[admin clear-halt] user=${userId} by=${guard.user?.email}`)
    return NextResponse.json({ ok: true, settings: updated })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }
}
