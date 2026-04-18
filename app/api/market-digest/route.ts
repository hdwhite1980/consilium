/**
 * POST /api/market-digest          — run end-of-day digest (manual trigger)
 * POST /api/market-digest?type=premarket — generate pre-market brief
 * GET  /api/market-digest          — get latest digest + pre-market brief
 * GET  /api/market-digest?date=2026-04-18 — get specific date
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { runMarketDigest, generatePremarketBrief } from '@/app/lib/market-digest'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  // Allow cron secret or authenticated user
  const cronSecret = req.headers.get('x-cron-secret')
  const isCron = cronSecret && cronSecret === process.env.CRON_SECRET

  if (!isCron) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const date = searchParams.get('date')

  try {
    if (type === 'premarket') {
      await generatePremarketBrief(date || undefined)
      return NextResponse.json({ ok: true, type: 'premarket', date: date || 'today' })
    } else {
      const result = await runMarketDigest(date || undefined)
      return NextResponse.json({ ok: true, type: 'digest', ...result })
    }
  } catch (e) {
    console.error('[market-digest] Error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const date = searchParams.get('date')
  const admin = getAdmin()

  const digestQuery = admin
    .from('market_digests')
    .select('*')
    .order('digest_date', { ascending: false })
    .limit(1)
  if (date) digestQuery.eq('digest_date', date)

  const briefQuery = admin
    .from('premarket_sentiment')
    .select('*')
    .order('brief_date', { ascending: false })
    .limit(1)
  if (date) briefQuery.eq('brief_date', date)

  const [{ data: digest }, { data: brief }] = await Promise.all([
    digestQuery.maybeSingle(),
    briefQuery.maybeSingle(),
  ])

  return NextResponse.json({ digest, brief })
}
