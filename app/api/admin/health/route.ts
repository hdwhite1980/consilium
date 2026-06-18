// =============================================================
// app/api/admin/health/route.ts
//
// GET /api/admin/health           → run all checks, return results
// GET /api/admin/health?id=alpaca → run one check by id
//
// Admin-gated. Returns 404 to non-admins.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/app/lib/admin/admin-auth'
import { runAllApiChecks, runApiCheck } from '@/app/lib/admin/api-checks'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30  // generous: 14 checks at ~5s each in parallel

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin()
  if (!guard.ok) return guard.response!

  const id = new URL(req.url).searchParams.get('id')
  const started = Date.now()

  try {
    if (id) {
      const result = await runApiCheck(id)
      if (!result) {
        return NextResponse.json({ error: `Unknown check id: ${id}` }, { status: 400 })
      }
      return NextResponse.json({ results: [result], elapsed_ms: Date.now() - started })
    }
    const results = await runAllApiChecks()
    return NextResponse.json({
      results,
      elapsed_ms: Date.now() - started,
      summary: {
        total: results.length,
        ok: results.filter(r => r.status === 'ok').length,
        degraded: results.filter(r => r.status === 'degraded').length,
        down: results.filter(r => r.status === 'down').length,
        not_configured: results.filter(r => r.status === 'not_configured').length,
      },
    })
  } catch (e) {
    console.error('[admin/health GET] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
