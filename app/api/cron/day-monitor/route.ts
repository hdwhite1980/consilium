// =============================================================
// app/api/cron/day-monitor/route.ts
//
// DAY monitor cron entry. Thin wrapper over the shared monitor core, run with
// DAY_CONFIG (fast tactical lens). Owns positions tagged monitor_mode='day' —
// which it only acquires via hand-off from the swing monitor.
//
// Register this URL in QStash as a separate schedule (e.g. every few minutes
// during market hours) with the same Bearer CRON_SECRET auth as the swing cron.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { runMonitor } from '@/app/lib/trading/monitor-core'
import { DAY_CONFIG } from '@/app/lib/trading/monitor-config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const summary = await runMonitor(DAY_CONFIG)
    return NextResponse.json(summary)
  } catch (e) {
    console.error('[day-monitor cron] outer:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }
}
