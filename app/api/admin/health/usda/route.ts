// =============================================================
// app/api/admin/health/usda/route.ts (Layer 7)
//
// Standalone USDA NASS Quick Stats API health check. Admin-only.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { checkUsdaHealth } from '@/app/lib/data/usda-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  const adminSecret = process.env.ADMIN_SECRET ?? process.env.CRON_SECRET ?? ''
  if (adminSecret && auth !== `Bearer ${adminSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await checkUsdaHealth()
  return NextResponse.json({
    service: 'USDA NASS',
    ...result,
    checkedAt: new Date().toISOString(),
  })
}
