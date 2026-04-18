/**
 * POST /api/social-signals        — trigger a scan
 * GET  /api/social-signals        — get latest signals
 * GET  /api/social-signals?ticker=NVDA — get ticker-specific signals
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { scanSocialSignals } from '@/app/lib/social-signals'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get('x-cron-secret')
  const isCron = cronSecret && cronSecret === process.env.CRON_SECRET
  if (!isCron) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const count = await scanSocialSignals()
    return NextResponse.json({ ok: true, signals_found: count })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const ticker = searchParams.get('ticker')?.toUpperCase()
  const admin = getAdmin()
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0]

  let query = admin
    .from('social_signals')
    .select('*')
    .gte('signal_date', twoDaysAgo)
    .order('detected_at', { ascending: false })
    .limit(20)

  if (ticker) {
    query = query.contains('affected_tickers', [ticker])
  }

  const { data: signals } = await query
  return NextResponse.json({ signals: signals || [] })
}
