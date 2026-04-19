/**
 * POST /api/market-digest          — run end-of-day digest (manual or cron trigger)
 * POST /api/market-digest?type=premarket — generate pre-market brief
 * GET  /api/market-digest          — get latest digest + pre-market brief
 * GET  /api/market-digest?date=2026-04-18 — get specific date
 *
 * IMPORTANT: POST returns 202 Accepted immediately. The actual generation
 * runs in the background on the server because it takes 60-120 seconds —
 * far longer than Railway's 30s HTTP proxy timeout.
 *
 * This pattern works because Railway runs Next.js as a long-lived Node
 * process, so async work continues after the response is sent. Do NOT
 * deploy this exact pattern to Vercel serverless without adjustment.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { runMarketDigest, generatePremarketBrief } from '@/app/lib/market-digest'

export const runtime = 'nodejs'
export const maxDuration = 300  // Vercel-compat: allow up to 5min for manual requests

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * Log a failure to cron_job_failures for dead-letter auditing.
 * Fire-and-forget — never blocks the pipeline on logging failure.
 */
function logJobFailure(jobType: string, err: unknown): void {
  void (async () => {
    try {
      const admin = getAdmin()
      await admin.from('cron_job_failures').insert({
        job_type: jobType,
        error_message: err instanceof Error ? err.message : String(err),
        error_stack: err instanceof Error ? err.stack?.slice(0, 4000) : null,
      })
    } catch (e) {
      console.error('[cron-failure-log] itself failed:', (e as Error).message)
    }
  })()
}

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
  const waitForResult = searchParams.get('wait') === 'true'  // for manual clicks that want to block

  // ── Path 1: Manual user click with wait=true → block and return full result ──
  // This preserves the original UX where clicking the button returns the
  // completed digest to the browser (though the user won't see anything
  // for 60-120s, the existing UI handles this with a loading spinner).
  if (waitForResult && !isCron) {
    try {
      if (type === 'premarket') {
        await generatePremarketBrief(date || undefined)
        return NextResponse.json({ ok: true, type: 'premarket', date: date || 'today' })
      } else {
        const result = await runMarketDigest(date || undefined)
        return NextResponse.json({ ok: true, type: 'digest', ...result })
      }
    } catch (e) {
      console.error('[market-digest] sync run error:', e)
      logJobFailure(type === 'premarket' ? 'premarket' : 'digest', e)
      return NextResponse.json({ error: (e as Error).message }, { status: 500 })
    }
  }

  // ── Path 2: Cron (or async manual) → fire-and-forget, return 202 immediately ──
  const startedAt = new Date().toISOString()
  console.log(`[market-digest] Starting ${type || 'digest'} job in background at ${startedAt}`)

  void (async () => {
    try {
      if (type === 'premarket') {
        await generatePremarketBrief(date || undefined)
        console.log(`[market-digest] Background premarket completed (started ${startedAt})`)
      } else {
        const result = await runMarketDigest(date || undefined)
        console.log(`[market-digest] Background digest completed (started ${startedAt}):`, result)
      }
    } catch (e) {
      console.error('[market-digest] Background job failed:', e)
      logJobFailure(type === 'premarket' ? 'premarket' : 'digest', e)
    }
  })()

  return NextResponse.json(
    { ok: true, type: type || 'digest', status: 'processing', startedAt },
    { status: 202 }
  )
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
