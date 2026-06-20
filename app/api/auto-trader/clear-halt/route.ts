// =============================================================
// app/api/auto-trader/clear-halt/route.ts
//
// POST → clear halt on the requesting user's OWN account.
// User-callable (no admin required) since they're acting on
// their own data.
//
// Auth: session required.
// =============================================================

import { NextResponse } from 'next/server'
import { createClient as createAuthClient } from '@/app/lib/auth/server'
import { upsertUserTradingSettings, loadUserTradingSettings } from '@/app/lib/trading/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(): Promise<NextResponse> {
  const supa = await createAuthClient()
  const { data: { user } } = await supa.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const existing = await loadUserTradingSettings(user.id)
    if (!existing) {
      return NextResponse.json({ error: 'No trading settings found' }, { status: 404 })
    }
    if (!existing.halted) {
      return NextResponse.json({ ok: true, message: 'Already not halted', settings: existing })
    }

    const previousReason = existing.haltReason
    const updated = await upsertUserTradingSettings(user.id, {
      halted: false,
      haltReason: null,
      haltedAt: null,
    })
    console.log(`[auto-trader clear-halt] user=${user.id} cleared halt (was: "${previousReason ?? 'unknown'}")`)
    return NextResponse.json({ ok: true, settings: updated })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }
}
