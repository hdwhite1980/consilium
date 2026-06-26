// =============================================================
// app/api/debug-live-movers/route.ts
// Verification endpoint for the live intraday early-gainer engine.
//   GET ?assetType=crypto   (or forex | futures)
//       &minChange=2.5 &limit=40
// Auth: Authorization: Bearer ${CRON_SECRET}
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { detectLiveMovers, type LiveAssetType } from '@/app/lib/signals/live-movers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

const VALID: LiveAssetType[] = ['crypto', 'forex', 'futures']

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const at = (url.searchParams.get('assetType') ?? 'crypto').toLowerCase() as LiveAssetType
  const assetType = VALID.includes(at) ? at : 'crypto'
  const minChange = url.searchParams.get('minChange')
  const universeLimit = url.searchParams.get('limit')

  const movers = await detectLiveMovers(assetType, {
    minChangePct: minChange ? Number(minChange) : undefined,
    universeLimit: universeLimit ? Number(universeLimit) : undefined,
  })

  return NextResponse.json({
    assetType,
    generatedAt: new Date().toISOString(),
    found: movers.length,
    movers: movers.slice(0, 25),
  })
}
