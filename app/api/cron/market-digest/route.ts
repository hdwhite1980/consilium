/**
 * GET /api/cron/market-digest
 * Called by Railway cron at 4:30pm ET (21:30 UTC) and 8:00am ET (13:00 UTC)
 * Protected by CRON_SECRET header
 */
import { NextRequest, NextResponse } from 'next/server'
import { runMarketDigest, generatePremarketBrief } from '@/app/lib/market-digest'

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') || req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const type = req.nextUrl.searchParams.get('type') || 'digest'

  try {
    if (type === 'premarket') {
      await generatePremarketBrief()
      return NextResponse.json({ ok: true, type: 'premarket' })
    } else {
      const result = await runMarketDigest()
      return NextResponse.json({ ok: true, type: 'digest', ...result })
    }
  } catch (e) {
    console.error('[cron/market-digest] Error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
