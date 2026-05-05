// =============================================================
// app/api/active-stories/route.ts
//
// GET /api/active-stories?session=today
//
// Returns the unified Active Stories payload for the dashboard.
// The frontend filters by session toggle (today/tomorrow/weekend)
// and groups within each session by timeframe.
//
// Thin read-only endpoint — all heavy lifting happens in the
// 4×daily cron route. This endpoint just reads the cached state.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import {
  loadStoriesBySession,
  type SessionAnchor,
  type Signal,
  type Timeframe,
} from '@/app/lib/story-tracker'
import type { ActiveStoriesPayload } from '@/app/lib/types/active-stories'

export const runtime = 'nodejs'
export const maxDuration = 10

const VALID_SESSIONS: SessionAnchor[] = ['today', 'tomorrow', 'weekend']

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createAdmin(url, key)
}

export async function GET(req: NextRequest) {
  try {
    // Auth check
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Parse session param (default: today)
    const url = new URL(req.url)
    const sessionParam = (url.searchParams.get('session') ?? 'today') as SessionAnchor
    const session: SessionAnchor = VALID_SESSIONS.includes(sessionParam) ? sessionParam : 'today'

    // Load filtered stories + latest run metadata in parallel
    const admin = getAdmin()
    const [stories, metaRes] = await Promise.all([
      loadStoriesBySession(session),
      admin.from('active_stories_meta').select('*').eq('id', 1).maybeSingle(),
    ])

    // Build counts breakdown
    const counts = computeCounts(stories)

    // Assemble payload
    const meta = metaRes.data
    const payload: ActiveStoriesPayload = {
      generatedAt: meta?.generated_at ?? new Date().toISOString(),
      lastRunSource: meta?.trigger_source ?? 'unknown',
      marketTheme: meta?.market_theme ?? '',
      marketStatus: meta?.market_status ?? '',
      summary: meta?.summary ?? '',
      stories,
      counts,
    }

    return NextResponse.json(payload, {
      headers: {
        // Cache for 60s — cron runs every few hours, so a minute of staleness is fine
        'Cache-Control': 'private, max-age=60',
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[active-stories GET] Error:', msg)
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────
// Counts helper — gives the dashboard a quick breakdown for
// rendering counts/badges by session/timeframe/signal.
// ─────────────────────────────────────────────────────────────

function computeCounts(
  stories: Awaited<ReturnType<typeof loadStoriesBySession>>,
): ActiveStoriesPayload['counts'] {
  const bySession: Record<SessionAnchor, number> = { today: 0, tomorrow: 0, weekend: 0 }
  const byTimeframe: Record<Timeframe, number> = { '1D': 0, '1W': 0, '1M': 0, '3M': 0 }
  const bySignal: Record<Signal, number> = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 }

  for (const s of stories) {
    bySession[s.sessionAnchor] = (bySession[s.sessionAnchor] ?? 0) + 1
    bySignal[s.signal] = (bySignal[s.signal] ?? 0) + 1
    for (const tf of s.timeframes) {
      if (tf in byTimeframe) byTimeframe[tf] = (byTimeframe[tf] ?? 0) + 1
    }
  }

  return {
    total: stories.length,
    bySession,
    byTimeframe,
    bySignal,
  }
}
