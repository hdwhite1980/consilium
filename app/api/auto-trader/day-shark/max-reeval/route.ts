// =============================================================
// app/api/auto-trader/day-shark/max-reeval/route.ts
//
// Max re-evaluates a position he HOLDS. Read-only: pulls a live price, runs the
// existing /api/reeval-thesis-check (fresh data, real LLM thesis check), and
// returns the result in Max's voice. If the thesis is broken, it hands back a
// close action so the UI can offer a confirm-to-exit button. No money moves here.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { loadUserTradingSettings } from '@/app/lib/trading/settings'
import { setupSharkLane } from '@/app/lib/trading/day-shark-lane'
import type { SharkAsset } from '@/app/lib/trading/day-shark'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

function admin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

interface HeldPos {
  id: number; ticker: string; asset_class: string | null; side: string | null
  entry_price_est: number | null; filled_avg_price: number | null
  verdict_log_id: number | null
}

async function loadHeld(userId: string, ticker: string): Promise<HeldPos | null> {
  const { data } = await admin()
    .from('trade_attempts')
    .select('id, ticker, asset_class, side, entry_price_est, filled_avg_price, verdict_log_id')
    .eq('user_id', userId)
    .eq('signal_source', 'day_shark')
    .eq('ticker', ticker)
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .order('created_at', { ascending: false })
    .limit(1)
  const row = (data ?? [])[0]
  return row ? (row as HeldPos) : null
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { ticker?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad request' }, { status: 400 }) }
  const ticker = String(body.ticker ?? '').toUpperCase().trim()
  if (!ticker) return NextResponse.json({ error: 'no ticker' }, { status: 400 })

  const pos = await loadHeld(user.id, ticker)
  if (!pos) return NextResponse.json({ reply: `I\u2019m not holding ${ticker} right now \u2014 nothing to re-check.`, action: null })
  if (pos.verdict_log_id == null) {
    return NextResponse.json({ reply: `${ticker} doesn\u2019t have an original verdict on file, so I can\u2019t run a thesis check on it.`, action: null })
  }

  const settings = await loadUserTradingSettings(user.id)
  if (!settings) return NextResponse.json({ error: 'no trading settings' }, { status: 400 })

  // Live price for the thesis-check + unrealized P/L.
  const asset = (pos.asset_class ?? 'stock') as SharkAsset
  const lane = await setupSharkLane(settings, asset)
  if ('error' in lane) return NextResponse.json({ reply: `Can\u2019t re-check ${ticker} right now: ${lane.error}.`, action: null })
  const price = await lane.price(ticker)
  if (price === null || price <= 0) {
    return NextResponse.json({ reply: `Couldn\u2019t pull a live price on ${ticker} this second \u2014 ask me again in a moment.`, action: null })
  }

  const entry = pos.filled_avg_price ?? pos.entry_price_est ?? 0
  const dir = pos.side === 'sell' ? -1 : 1
  const unrealizedPnlPct = entry > 0 ? ((price - entry) / entry) * 100 * dir : 0

  // Reuse the real thesis-check pipeline (fresh data + LLM), same as the cron re-evals.
  const rawBase = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '')
  if (!rawBase) return NextResponse.json({ error: 'APP_BASE_URL not configured' }, { status: 500 })
  const baseUrl = /^https?:\/\//.test(rawBase) ? rawBase : `https://${rawBase}`

  try {
    const res = await fetch(`${baseUrl}/api/reeval-thesis-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
        'x-service-trigger': 'max-chat-reeval',
        'x-service-user-id': user.id,
      },
      body: JSON.stringify({
        verdictId: pos.verdict_log_id,
        currentPrice: price,
        unrealizedPnlPct,
        triggersFired: ['max_chat: trader asked for a fresh read'],
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      console.error('[max-reeval] thesis-check failed', res.status, t.slice(0, 200))
      return NextResponse.json({ reply: `Tried to re-check ${ticker} but the read came back empty \u2014 try again in a sec.`, action: null })
    }

    const data = await res.json() as { thesisStatus?: string; action?: string; confidence?: number; rationale?: string }
    const status = data.thesisStatus ?? 'intact'
    const tAction = data.action ?? 'hold'
    const conf = typeof data.confidence === 'number' ? Math.round(data.confidence) : null
    const why = (data.rationale ?? '').trim()
    const pnlTxt = `${unrealizedPnlPct >= 0 ? '+' : ''}${unrealizedPnlPct.toFixed(1)}%`

    // Max-voiced wrapper around the real verdict.
    let head: string
    if (status === 'invalidated' || tAction === 'early_exit') head = `${ticker} thesis is broken`
    else if (status === 'weakened' || tAction === 'tighten_stop') head = `${ticker} is getting shaky`
    else if (tAction === 'add') head = `${ticker} thesis is still strong`
    else head = `${ticker} thesis still holds`

    const reply = `${head} (${pnlTxt}${conf != null ? `, ${conf}% conviction` : ''}). ${why}`.trim()

    // If the thesis is broken, hand back a close action so the UI offers an exit button.
    const action = (status === 'invalidated' || tAction === 'early_exit')
      ? { type: 'close_one' as const, ticker }
      : null

    return NextResponse.json({ reply, action })
  } catch (e) {
    console.error('[max-reeval] error', e)
    return NextResponse.json({ reply: `${ticker} re-check timed out \u2014 give it another shot.`, action: null })
  }
}
