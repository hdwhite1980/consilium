/**
 * POST /api/monitor   — run one monitor cycle (manual trigger or cron)
 * GET  /api/monitor   — get recent unacknowledged alerts
 * PATCH /api/monitor  — acknowledge alerts { ids: string[] }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { runMarketMonitor, getUnacknowledgedAlerts } from '@/app/lib/market-monitor'

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
    const result = await runMarketMonitor()
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    console.error('[monitor] Error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const alerts = await getUnacknowledgedAlerts()
  return NextResponse.json({ alerts })
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { ids } = await req.json()
  if (!ids?.length) return NextResponse.json({ ok: true })
  await getAdmin()
    .from('monitor_alerts')
    .update({ acknowledged: true })
    .in('id', ids)
  return NextResponse.json({ ok: true })
}
