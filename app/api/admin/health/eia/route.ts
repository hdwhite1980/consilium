// =============================================================
// app/api/admin/health/eia/route.ts (Layer 6)
//
// Standalone EIA API health check. Admin-only.
//
// If you have an existing /api/admin/api-health route that aggregates
// multiple data sources, you can either:
//   (a) leave this route in place as a dedicated EIA check, OR
//   (b) inline the checkEiaHealth() call from eia-client.ts into
//       your existing aggregator route.
//
// This route returns:
//   { ok: true,  sample: { period: "2026-06-13", value: 423456 } }
//   { ok: false, error: "EIA_API_KEY not configured" }
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { checkEiaHealth } from '@/app/lib/data/eia-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Admin-only: require either an admin session cookie OR the cron secret.
  // Adjust this guard to match your existing admin auth pattern.
  const auth = req.headers.get('authorization') ?? ''
  const adminSecret = process.env.ADMIN_SECRET ?? process.env.CRON_SECRET ?? ''
  if (adminSecret && auth !== `Bearer ${adminSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await checkEiaHealth()
  return NextResponse.json({
    service: 'EIA',
    ...result,
    checkedAt: new Date().toISOString(),
  })
}
