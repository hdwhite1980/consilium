// app/api/debug-timeframe/route.ts — verify the preliminary chart read.
//   GET ?ticker=SOLUSD&assetType=crypto   (assetType: stock|crypto|forex|futures)
// Auth: Authorization: Bearer ${CRON_SECRET}
import { NextRequest, NextResponse } from 'next/server'
import { selectTimeframe, type SelectorAssetType } from '@/app/lib/signals/timeframe-selector'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

const VALID: SelectorAssetType[] = ['stock', 'crypto', 'forex', 'futures']

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const ticker = url.searchParams.get('ticker')
  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })
  const at = (url.searchParams.get('assetType') ?? 'crypto').toLowerCase() as SelectorAssetType
  const assetType = VALID.includes(at) ? at : 'crypto'
  const read = await selectTimeframe(ticker, assetType)
  return NextResponse.json(read)
}
