// =============================================================
// app/api/cron/auto-council-trigger/route.ts
//
// Hourly cron that pushes candidate tickers into the Council
// pipeline so the auto-trader has fresh verdicts to act on.
//
// TWO PARALLEL CANDIDATE PATHS, merged then deduped:
//
//   1. NEWS PATH — query v_active_stories for active stories with
//      confidence ≥ 60 and age_hours ≤ 24, filtered to stocks.
//      Stories with verified=false (caught by Phase 2.5 verifier
//      as likely hallucinated) are EXCLUDED.
//
//   2. SCANNER PATH — call runScan() directly with newsBoost=true.
//      Filter to picks where compositeWithNews ≥ 60 AND
//      |1-day price change| ≥ 2.5%.
//
// For each surviving candidate ticker:
//   - Dedup: skip if a verdict_log row exists for this user+ticker
//     in the last 12h. Avoids redundant Council on the same setup.
//     (The auto-trade-reeval cron handles thesis decay for tickers
//     you actually hold.)
//   - Else: POST /api/analyze with service auth, fire-and-forget.
//     /api/analyze handles disconnects gracefully (its pipeline
//     continues server-side), so we don't wait for SSE completion.
//
// Cap: max 8 tickers per run (5 scanner + 3 news) after dedup.
// Cadence: hourly during US market hours (set in cron YAML).
// CRON_SECRET gated.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers } from '@/app/lib/trading/settings'
import { runScan } from '@/app/lib/scanner-engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ─────────────────────────────────────────────────────────────
// Tuning constants
// ─────────────────────────────────────────────────────────────

const NEWS_CONFIDENCE_MIN = 60
const NEWS_AGE_HOURS_MAX = 24
const NEWS_PATH_LIMIT = 3                  // max news-driven tickers per user per run

const SCANNER_LIMIT_FETCH = 15             // how many picks runScan returns
const SCANNER_COMPOSITE_MIN = 60
const SCANNER_MOVE_PCT_MIN = 2.5           // |1-day price change| threshold
const SCANNER_PATH_LIMIT = 5               // max scanner-driven tickers per user per run

const DEDUP_WINDOW_HOURS = 12              // skip if verdict_log row exists in this window

const TOTAL_TICKERS_PER_USER_PER_RUN = 8   // hard cap after dedup

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface TriggerSummary {
  users: number
  newsCandidates: number
  scannerCandidates: number
  mergedUnique: number
  dedupSkipped: number
  triggered: number
  errors: number
  byUser: Array<{
    userId: string
    newsTickers: string[]
    scannerTickers: string[]
    triggered: string[]
    skipped: string[]
  }>
  durationMs: number
}

interface NewsStoryRow {
  ticker: string | null
  signal: string | null
  confidence: number | null
  age_hours: number | null
  verified: boolean | null
  asset_type: string | null
  timeframes: string[] | null   // jsonb array on tracked_stories
  session_anchor: string | null  // 'today' | 'tomorrow' | 'weekend'
}

// ─────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary: TriggerSummary = {
    users: 0,
    newsCandidates: 0,
    scannerCandidates: 0,
    mergedUnique: 0,
    dedupSkipped: 0,
    triggered: 0,
    errors: 0,
    byUser: [],
    durationMs: 0,
  }

  try {
    // Fetch news candidates ONCE — they're user-agnostic (active stories are global)
    const newsCandidates = await fetchNewsCandidates()
    summary.newsCandidates = newsCandidates.length
    // Map from ticker -> preferred timeframe (from active-story). Scanner
    // tickers not in the map default to '1W' below.
    const newsTimeframeByTicker = new Map<string, string>(
      newsCandidates.map(c => [c.ticker, c.timeframe]),
    )
    const newsTickers = newsCandidates.map(c => c.ticker)

    // Fetch global scanner candidates ONCE as a fallback. When a user has
    // fresh fire_now triage rows, we'll prefer those (per-user, scored).
    // When triage is empty (cron not yet deployed, or no fire_now picks
    // this cycle), we fall back to the global scanner list.
    const globalScannerTickers = await fetchScannerCandidates()
    summary.scannerCandidates = globalScannerTickers.length

    const users = await listEnabledTradingUsers()
    summary.users = users.length

    for (const settings of users) {
      // Per-user scanner candidates: prefer triaged fire_now rows.
      // Returns [] when no fresh fire_now rows exist for this user; we
      // fall back to the global scanner list in that case.
      const { tickers: triagedTickers, triageRowsByTicker } =
        await fetchFireNowTriageForUser(settings.userId)
      const scannerTickersForUser = triagedTickers.length > 0
        ? triagedTickers
        : globalScannerTickers

      // Merge: scanner picks first (higher quality), then news
      const merged = mergeUnique(scannerTickersForUser, newsTickers)
      summary.mergedUnique = Math.max(summary.mergedUnique, merged.length)

      if (merged.length === 0) {
        summary.byUser.push({
          userId: settings.userId,
          newsTickers: [],
          scannerTickers: [],
          triggered: [],
          skipped: [],
        })
        continue
      }

      const userEntry = {
        userId: settings.userId,
        newsTickers: newsTickers.filter(t => merged.includes(t)),
        scannerTickers: scannerTickersForUser.filter(t => merged.includes(t)),
        triggered: [] as string[],
        skipped: [] as string[],
      }

      try {
        for (const ticker of merged) {
          // Dedup check
          const hasRecent = await hasRecentVerdict(settings.userId, ticker, DEDUP_WINDOW_HOURS)
          if (hasRecent) {
            summary.dedupSkipped++
            userEntry.skipped.push(`${ticker}(dup)`)
            continue
          }

          if (userEntry.triggered.length >= TOTAL_TICKERS_PER_USER_PER_RUN) {
            userEntry.skipped.push(`${ticker}(cap)`)
            continue
          }

          // Fire-and-forget POST to /api/analyze.
          // Timeframe selection: if the ticker came from active-stories, use
          // the story's preferred timeframe (shortest of its tagged set,
          // typically 1D for fresh catalysts). Otherwise default to 1W
          // (the existing scanner-path convention).
          const timeframe = newsTimeframeByTicker.get(ticker) ?? '1W'
          const fired = await triggerAnalyze(settings.userId, ticker, timeframe)
          if (fired) {
            summary.triggered++
            userEntry.triggered.push(ticker)

            // If this ticker came from a triage row, mark it as fired
            const triageRow = triageRowsByTicker.get(ticker)
            if (triageRow) {
              await markTriageRowFired(triageRow.id, /* verdictId */ null)
                .catch(err => console.warn(`[auto-council-trigger] markTriageRowFired failed for triage row ${triageRow.id}: ${err instanceof Error ? err.message : err}`))
            }
          } else {
            summary.errors++
            userEntry.skipped.push(`${ticker}(fire-fail)`)
          }
        }
      } catch (e) {
        summary.errors++
        console.error(`[auto-council-trigger] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }

      summary.byUser.push(userEntry)
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[auto-council-trigger cron] done in ${summary.durationMs}ms users=${summary.users} newsCands=${summary.newsCandidates} scannerCands=${summary.scannerCandidates} merged=${summary.mergedUnique} triggered=${summary.triggered} dedupSkipped=${summary.dedupSkipped} errors=${summary.errors}`)
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────
// Candidate sources
// ─────────────────────────────────────────────────────────────

/**
 * News path — query v_active_stories view for active stories on stocks
 * with confidence ≥ 60, age ≤ 24h, and NOT flagged as unverified.
 *
 * The view already filters to status='active' equivalent (it's a view
 * named v_active_stories), but we add explicit guards in case the view
 * definition shifts.
 */
async function fetchNewsCandidates(): Promise<Array<{ ticker: string; timeframe: string }>> {
  const admin = await getSupabaseAdmin()
  try {
    const { data, error } = await admin
      .from('v_active_stories')
      .select('ticker, signal, confidence, age_hours, verified, asset_type, timeframes, session_anchor')
      .gte('confidence', NEWS_CONFIDENCE_MIN)
      .lte('age_hours', NEWS_AGE_HOURS_MAX)
      // BUG FIX (June 22 2026): asset_type is stored as 'stock' singular
      // (per story-tracker.ts insertStory default). The previous .eq('stocks')
      // plural silently matched zero rows, so the active-stories → Council
      // integration has been completely dead since deploy.
      // Accept both 'stock' singular (current convention) and 'stocks' plural
      // (legacy/defensive) so any historical rows match too.
      .in('asset_type', ['stock', 'stocks'])
      .not('verified', 'is', false)     // accepts null OR true; excludes explicit false
      .order('confidence', { ascending: false })
      .limit(NEWS_PATH_LIMIT * 4)        // overfetch in case some get deduped vs scanner
    if (error) {
      console.warn('[auto-council-trigger] news query failed:', error.message)
      return []
    }
    const rows = (data ?? []) as NewsStoryRow[]
    const out: Array<{ ticker: string; timeframe: string }> = []
    const seen = new Set<string>()
    for (const r of rows) {
      if (!r.ticker || typeof r.ticker !== 'string') continue
      if (!r.signal || (r.signal !== 'BULLISH' && r.signal !== 'BEARISH')) continue
      const t = r.ticker.toUpperCase().trim()
      if (!/^[A-Z]{1,6}$/.test(t)) continue
      if (seen.has(t)) continue
      seen.add(t)

      const tf = pickTimeframeForStory(
        Array.isArray(r.timeframes) ? r.timeframes : [],
        (r.session_anchor ?? 'today').toLowerCase(),
      )

      out.push({ ticker: t, timeframe: tf })
      if (out.length >= NEWS_PATH_LIMIT) break
    }
    return out
  } catch (e) {
    console.warn('[auto-council-trigger] news fetch threw:', e instanceof Error ? e.message : e)
    return []
  }
}

/**
 * Choose the timeframe to send to /api/analyze for an active story.
 *
 * Rules:
 *   - sessionAnchor='today':    shortest tagged timeframe (1D > 1W > 1M > 3M)
 *     Catalyst is unfolding NOW; a 1D play captures it tightest.
 *
 *   - sessionAnchor='tomorrow' or 'weekend': minimum 1W
 *     Catalyst is dated for a future session. Same-day plays would expose
 *     the trade to overnight gap risk + an unknown catalyst the position
 *     wasn't sized for. Force the timeframe up to 1W so the trade is
 *     a swing that brackets the catalyst.
 *
 *   - If the story has NO timeframes tagged: default to the safer choice
 *     for the anchor ('1W' for today, '1W' for tomorrow/weekend).
 */
function pickTimeframeForStory(timeframes: string[], sessionAnchor: string): string {
  const order = ['1D', '1W', '1M', '3M']

  if (sessionAnchor === 'tomorrow' || sessionAnchor === 'weekend') {
    // Force minimum 1W — pick the SHORTEST that is ≥ 1W
    const minOrder = ['1W', '1M', '3M']
    return minOrder.find(o => timeframes.includes(o)) ?? '1W'
  }

  // sessionAnchor='today' (default): shortest available
  return order.find(o => timeframes.includes(o)) ?? '1W'
}

/**
 * Scanner path — call runScan() directly. Filter results to picks with
 * compositeWithNews ≥ 60 AND |1-day price change| ≥ 2.5%.
 *
 * Uses the 'directional' scanType which is the production default
 * (Track A directional + Track B rel-strength scoring).
 */
async function fetchScannerCandidates(): Promise<string[]> {
  try {
    const result = await runScan({
      universe: 'all',
      filter: { predefined: 'all' },
      mode: 'both',
      limit: SCANNER_LIMIT_FETCH,
      newsBoost: true,
      scanType: 'directional',
      horizon: 'week',
      priceCeiling: 0,
    })
    if (!result || !Array.isArray(result.picks)) return []

    const tickers: string[] = []
    for (const pick of result.picks) {
      const composite = pick.compositeWithNews ?? pick.compositeScore ?? 0
      if (composite < SCANNER_COMPOSITE_MIN) continue
      // priceChange1D lives on technicals; runScan picks expose pctChange* fields
      // depending on the score shape. We check several common fields defensively.
      const p = pick as unknown as Record<string, unknown>
      const pct1d = pickPctChange1d(p)
      if (pct1d === null) continue
      if (Math.abs(pct1d) < SCANNER_MOVE_PCT_MIN) continue

      const t = String(pick.ticker ?? '').toUpperCase().trim()
      if (!/^[A-Z]{1,6}$/.test(t)) continue
      if (!tickers.includes(t)) tickers.push(t)
      if (tickers.length >= SCANNER_PATH_LIMIT) break
    }
    return tickers
  } catch (e) {
    console.warn('[auto-council-trigger] scanner fetch threw:', e instanceof Error ? e.message : e)
    return []
  }
}

/**
 * Defensive accessor for 1-day price change percent. The scanner exposes
 * this under different field names depending on scanType. We check the
 * most common shapes; returns null if no candidate field found.
 */
function pickPctChange1d(p: Record<string, unknown>): number | null {
  const candidates = [
    'priceChange1D', 'priceChange1d', 'pct_change_1d', 'pctChange1d',
    'priceChange', 'change1d',
  ]
  for (const key of candidates) {
    const v = p[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  // Some shapes nest technicals
  const tech = p.technicals as Record<string, unknown> | undefined
  if (tech) {
    for (const key of candidates) {
      const v = tech[key]
      if (typeof v === 'number' && Number.isFinite(v)) return v
    }
  }
  return null
}

/**
 * Merge two ticker lists keeping order. Scanner list first (directional
 * conviction), then news fillers. Deduplicates.
 */
function mergeUnique(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of [...primary, ...secondary]) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// Scanner triage table — fire_now consumption
// ─────────────────────────────────────────────────────────────

/**
 * Fetch fire_now triage rows for a user that haven't been fired yet,
 * within the last 30 minutes. Returns tickers in score-desc order plus
 * a map for later lookup (so we can mark the row as fired).
 *
 * Returns empty when no triaged rows are available — caller falls back
 * to the global scanner candidates. This preserves backward compat with
 * the prior behavior when the triage cron isn't running.
 */
async function fetchFireNowTriageForUser(userId: string): Promise<{
  tickers: string[]
  triageRowsByTicker: Map<string, { id: number; score: number | null }>
}> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString()
  const { data, error } = await admin
    .from('scanner_triage')
    .select('id, ticker, score')
    .eq('user_id', userId)
    .eq('decision', 'fire_now')
    .is('fired_at', null)
    .gt('triaged_at', cutoff)
    .order('score', { ascending: false })
    .limit(10)
  if (error) {
    console.warn(`[auto-council-trigger] fetchFireNowTriageForUser err: ${error.message}`)
    return { tickers: [], triageRowsByTicker: new Map() }
  }
  const rows = (data ?? []) as Array<{ id: number; ticker: string; score: number | null }>
  const tickers = rows.map(r => String(r.ticker).toUpperCase())
  const triageRowsByTicker = new Map<string, { id: number; score: number | null }>()
  for (const r of rows) {
    triageRowsByTicker.set(String(r.ticker).toUpperCase(), { id: r.id, score: r.score })
  }
  return { tickers, triageRowsByTicker }
}

/**
 * Mark a triage row as fired. Set fired_at = now, fired_verdict_id if
 * we know it (caller may not — verdict_log row is written async after
 * /api/analyze completes, well after this function returns).
 */
async function markTriageRowFired(triageRowId: number, verdictId: number | null): Promise<void> {
  const admin = await getSupabaseAdmin()
  const patch: Record<string, unknown> = { fired_at: new Date().toISOString() }
  if (verdictId !== null) patch.fired_verdict_id = verdictId
  const { error } = await admin
    .from('scanner_triage')
    .update(patch)
    .eq('id', triageRowId)
  if (error) throw new Error(error.message)
}

// ─────────────────────────────────────────────────────────────
// Dedup check
// ─────────────────────────────────────────────────────────────

async function hasRecentVerdict(userId: string, ticker: string, windowHours: number): Promise<boolean> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString()
  const { count, error } = await admin
    .from('verdict_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('ticker', ticker)
    .gte('created_at', cutoff)
  if (error) {
    // Fail closed on dedup error — better to skip a Council run than double-fire
    console.warn(`[auto-council-trigger] dedup check failed for ${ticker}:`, error.message)
    return true
  }
  return (count ?? 0) > 0
}

// ─────────────────────────────────────────────────────────────
// Fire-and-forget trigger of /api/analyze
// ─────────────────────────────────────────────────────────────

/**
 * Posts to /api/analyze with service auth. Does NOT wait for the SSE
 * stream to complete — fires the request and returns. /api/analyze is
 * designed to handle client disconnects: its pipeline continues
 * server-side and persists to verdict_log when done.
 *
 * Returns true if the request was successfully initiated (any 2xx during
 * the brief response head), false on connection error or non-2xx.
 *
 * Brief read timeout: just enough to confirm the route accepted the request,
 * then we abandon the response.
 */
async function triggerAnalyze(userId: string, ticker: string, timeframe: string): Promise<boolean> {
  const rawBase = process.env.APP_BASE_URL ?? ''
  if (!rawBase) {
    console.warn('[auto-council-trigger] APP_BASE_URL not set; cannot trigger analyze')
    return false
  }

  // Normalize: Railway env vars often contain the bare hostname (e.g.
  // `consilium-production-d8e6.up.railway.app`) without a scheme. Node's
  // fetch requires a fully-qualified URL with `https://`. Prepend if missing
  // and strip any trailing slash to keep the join clean.
  const baseUrl = (rawBase.startsWith('http://') || rawBase.startsWith('https://'))
    ? rawBase.replace(/\/+$/, '')
    : `https://${rawBase.replace(/\/+$/, '')}`

  const ctrl = new AbortController()
  const briefHeadTimeout = setTimeout(() => ctrl.abort(), 8_000)

  try {
    const res = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
        'x-service-trigger': 'auto-council-trigger',
        'x-service-user-id': userId,
      },
      body: JSON.stringify({
        ticker,
        timeframe,
        forceRefresh: false,
        persona: 'balanced',
      }),
      signal: ctrl.signal,
    })

    // Clear the head timeout — connection established
    clearTimeout(briefHeadTimeout)

    if (!res.ok) {
      console.warn(`[auto-council-trigger] analyze returned ${res.status} for ${ticker}`)
      return false
    }

    // Fire-and-forget: don't await body. Schedule an async drain of the
    // response stream so the connection is released cleanly on the server,
    // but don't block this function. /api/analyze's controller-closed
    // handler will let the pipeline continue server-side either way.
    void (async () => {
      try {
        const reader = res.body?.getReader()
        if (!reader) return
        // Read a few chunks then abandon — gives the pipeline a head start
        // before we tear down the connection. The server tolerates close.
        for (let i = 0; i < 3; i++) {
          const { done } = await reader.read()
          if (done) break
        }
        try { await reader.cancel() } catch { /* ignore */ }
      } catch { /* ignore drain failures */ }
    })()

    console.log(`[auto-council-trigger] FIRED user=${userId} ${ticker}`)
    return true
  } catch (e) {
    clearTimeout(briefHeadTimeout)
    const msg = e instanceof Error ? e.message : String(e)
    // AbortError on the brief head timeout is also a failure
    console.warn(`[auto-council-trigger] analyze fire failed for ${ticker}: ${msg.slice(0, 200)}`)
    return false
  }
}
