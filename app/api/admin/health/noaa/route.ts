// =============================================================
// app/api/admin/health/noaa/route.ts (Layer 7)
//
// Standalone NOAA Climate Data Online API health check. Admin-only.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { checkNoaaHealth } from '@/app/lib/data/noaa-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  const adminSecret = process.env.ADMIN_SECRET ?? process.env.CRON_SECRET ?? ''
  if (adminSecret && auth !== `Bearer ${adminSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await checkNoaaHealth()
  return NextResponse.json({
    service: 'NOAA CDO',
    ...result,
    checkedAt: new Date().toISOString(),
  })
}
