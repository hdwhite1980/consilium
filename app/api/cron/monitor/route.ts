/**
 * GET /api/cron/monitor?secret=XXX
 * Called by Railway cron every 3 minutes
 * Schedule: *\/3 * * * * (every 3 min)
 */
import { NextRequest, NextResponse } from 'next/server'
import { runMarketMonitor } from '@/app/lib/market-monitor'

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret') || req.headers.get('x-cron-secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const result = await runMarketMonitor()
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
