import { NextRequest, NextResponse } from 'next/server'
import { fetchEdgarFundamentals, refreshExpiringEdgarCache, getCIK } from '@/app/lib/data/edgar'

// GET /api/edgar?ticker=NVDA — fetch/refresh a single ticker
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const ticker = searchParams.get('ticker')
  const refresh = searchParams.get('refresh') === 'true'

  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })

  // Verify cron secret for refresh operations
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (refresh && cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const data = await fetchEdgarFundamentals(ticker.toUpperCase())
  if (!data) return NextResponse.json({ error: 'No EDGAR data found for ticker' }, { status: 404 })

  return NextResponse.json({ data })
}

// POST /api/edgar — nightly cache refresh (called by cron)
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET

  // Require auth for cron jobs
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await refreshExpiringEdgarCache()
  return NextResponse.json({ ok: true, ...result })
}
