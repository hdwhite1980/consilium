/**
 * GET /api/watchlist/brief?ticker=NVDA
 *
 * Manually generate an overnight brief for one ticker. Used for testing
 * brief quality without waiting for the cron. Authenticated — only the
 * logged-in user can hit it.
 *
 * Returns the generated brief as JSON. Does NOT persist it (just preview).
 *
 * Optional params:
 *   ticker     — required, the ticker to brief
 *   start      — optional ISO timestamp for window start
 *   persist    — if 'true', saves to watchlist_overnight_briefs
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { generateOvernightBrief } from '@/app/lib/overnight-brief'

const admin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const ticker = req.nextUrl.searchParams.get('ticker')?.toUpperCase()
  if (!ticker || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    return NextResponse.json({ error: 'Valid ticker required' }, { status: 400 })
  }

  const startParam = req.nextUrl.searchParams.get('start')
  const persistParam = req.nextUrl.searchParams.get('persist') === 'true'

  let windowStart: Date | undefined
  if (startParam) {
    const d = new Date(startParam)
    if (!isNaN(d.getTime())) windowStart = d
  }

  try {
    const brief = await generateOvernightBrief(ticker, { windowStart })

    if (persistParam) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin() as any).from('watchlist_overnight_briefs').upsert({
        user_id: user.id,
        ticker: brief.ticker,
        brief_date: brief.brief_date,
        summary: brief.summary,
        sentiment_skew: brief.sentiment_skew,
        items: brief.items,
        news_count: brief.news_count,
        news_window_start: brief.news_window_start,
        news_window_end: brief.news_window_end,
        llm_input_tokens: brief.llm_input_tokens ?? null,
        llm_output_tokens: brief.llm_output_tokens ?? null,
        generation_ms: brief.generation_ms,
      }, { onConflict: 'user_id,ticker,brief_date' })
    }

    return NextResponse.json({ brief, persisted: persistParam })
  } catch (e) {
    return NextResponse.json({
      error: 'Brief generation failed',
      detail: (e as Error).message,
    }, { status: 500 })
  }
}
