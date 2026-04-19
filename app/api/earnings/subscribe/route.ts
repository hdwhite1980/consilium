// ═════════════════════════════════════════════════════════════
// /api/earnings/subscribe — Manage earnings notification subscriptions
//
// POST   body: { ticker: 'NVDA' }         → subscribe to ticker (manual)
// DELETE body: { ticker: 'NVDA' }         → unsubscribe from ticker
// PATCH  body: { autoPortfolio: true }    → set master portfolio auto-toggle
// GET                                      → return current subscription state
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function getUserId(): Promise<string | null> {
  try {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
          setAll: () => {},
        },
      }
    )
    const { data: { user } } = await supabase.auth.getUser()
    return user?.id ?? null
  } catch {
    return null
  }
}

export async function GET() {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const [subsResult, settingsResult] = await Promise.all([
    admin.from('earnings_subscriptions').select('ticker, subscription_type').eq('user_id', userId),
    admin.from('earnings_notification_settings').select('auto_portfolio_enabled').eq('user_id', userId).maybeSingle(),
  ])

  const manualTickers: string[] = []
  for (const s of subsResult.data ?? []) {
    if (s.subscription_type === 'manual_ticker' && s.ticker) manualTickers.push(s.ticker.toUpperCase())
  }

  return NextResponse.json({
    ok: true,
    autoPortfolioEnabled: settingsResult.data?.auto_portfolio_enabled ?? false,
    manualSubscriptions: manualTickers,
  })
}

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const ticker = (body.ticker ?? '').toString().trim().toUpperCase()
  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })
  if (ticker.length > 10) return NextResponse.json({ error: 'invalid ticker' }, { status: 400 })

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { error } = await admin
    .from('earnings_subscriptions')
    .upsert({ user_id: userId, ticker, subscription_type: 'manual_ticker' }, { onConflict: 'user_id,ticker,subscription_type' })

  if (error) {
    console.error('[earnings-subscribe] POST failed:', error.message)
    return NextResponse.json({ error: 'subscription failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, ticker })
}

export async function DELETE(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const ticker = (body.ticker ?? '').toString().trim().toUpperCase()
  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { error } = await admin
    .from('earnings_subscriptions')
    .delete()
    .eq('user_id', userId)
    .eq('ticker', ticker)
    .eq('subscription_type', 'manual_ticker')

  if (error) {
    console.error('[earnings-subscribe] DELETE failed:', error.message)
    return NextResponse.json({ error: 'unsubscribe failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, ticker })
}

export async function PATCH(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'auth required' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const autoPortfolio = Boolean(body.autoPortfolio)

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { error } = await admin
    .from('earnings_notification_settings')
    .upsert({
      user_id: userId,
      auto_portfolio_enabled: autoPortfolio,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

  if (error) {
    console.error('[earnings-subscribe] PATCH failed:', error.message)
    return NextResponse.json({ error: 'setting update failed' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, autoPortfolioEnabled: autoPortfolio })
}
