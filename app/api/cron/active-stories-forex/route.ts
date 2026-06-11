// =============================================================
// app/api/cron/active-stories-forex/route.ts
//
// Forex-specific Active Stories cron. Runs 3× daily aligned to
// session opens:
//   - 08:00 UTC (London open)
//   - 13:30 UTC (NY open / morning data releases)
//   - 22:00 UTC (Asia open)
//
// Architectural mirror of /api/cron/active-stories but isolated:
//   - Only processes forex-typed stories (filters loadActiveStories)
//   - Uses classifyForexActiveStories (different prompt, forex universe)
//   - Pulls COT context alongside news/regime/scheduled-catalysts
//   - Writes to the same tracked_stories table, distinguished by asset_type
//
// Equity cron keeps running independently — they share the table but
// not the stories (asset_type='stock'|'crypto' for equity cron,
// 'forex' for this cron).
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { fetchMultiSourceNews, formatNewsForPrompt } from '@/app/lib/multi-source-news'
import { getMarketRegime } from '@/app/lib/market-regime'
import {
  loadActiveStories,
  insertStory,
  updateStory,
  expireTimeCapped,
  expireIdle,
  enforceHardCap,
  startRun,
  finishRun,
  cronSourceLabel,
  type RunSummary,
} from '@/app/lib/story-tracker'
import {
  classifyForexActiveStories,
  filterNewsForForex,
  filterActiveStoriesForex,
  buildForexCotContext,
} from '@/app/lib/active-stories-forex-classifier'
import { fetchCurrentPricesMany } from '@/app/lib/data/current-price'
import { getEconomicCalendarContext } from '@/app/lib/forward-data'

export const runtime = 'nodejs'
export const maxDuration = 300

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  const auth = req.headers.get('authorization')
  if (!auth) return false
  return auth === `Bearer ${cronSecret}`
}

export async function GET(req: NextRequest) {
  return runCron(req)
}

export async function POST(req: NextRequest) {
  return runCron(req)
}

async function runCron(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const start = Date.now()
  const triggerSource = `${cronSourceLabel()}-forex`
  let runId = 0
  let errorMessage: string | undefined
  const summary: RunSummary = {
    runId: 0,
    storiesActiveBefore: 0,
    storiesActiveAfter: 0,
    storiesAdded: 0,
    storiesUpdated: 0,
    storiesResolved: 0,
    storiesForceResolved: 0,
    durationMs: 0,
  }

  try {
    runId = await startRun(triggerSource)
    summary.runId = runId
    console.log(`[active-stories-forex cron] runId=${runId} source=${triggerSource} starting`)

    // ── Step 1: load all active stories, filter to forex ──────
    const allActive = await loadActiveStories()
    const activeForex = filterActiveStoriesForex(allActive)
    summary.storiesActiveBefore = activeForex.length
    console.log(`[active-stories-forex cron] runId=${runId} loaded ${activeForex.length} active forex stories (${allActive.length} total in table)`)

    // ── Step 2: fetch news + regime + scheduled catalysts + COT in parallel ──
    const fetchStart = Date.now()
    const [newsResult, regime, scheduledCatalysts, cotContext] = await Promise.all([
      fetchMultiSourceNews({ includeCrypto: false }),
      getMarketRegime(),
      // Use the per-asset-class economic calendar context with a generic
      // forex pair to get the full FX-relevant calendar (all 7 majors share
      // the same calendar coverage — EUR/USD/GBP/JPY/AUD/CAD/CHF/NZD events).
      // EURUSD as the anchor returns USD+EUR events; we want broader coverage
      // so we build our own combined calendar below.
      Promise.all(['EURUSD', 'USDJPY', 'GBPUSD', 'AUDUSD'].map(p =>
        getEconomicCalendarContext(p, 'forex', '1D').catch(() => '')
      )).then(blocks => {
        // Dedupe lines across the 4 calls
        const seen = new Set<string>()
        const merged: string[] = []
        for (const block of blocks) {
          for (const line of block.split('\n')) {
            if (line.startsWith('  •')) {
              if (seen.has(line)) continue
              seen.add(line)
            }
            merged.push(line)
          }
        }
        return merged.length > 0 ? merged.join('\n') : ''
      }).catch(e => {
        console.warn(`[active-stories-forex cron] econ calendar fetch failed:`, (e as Error).message)
        return ''
      }),
      buildForexCotContext().catch(e => {
        console.warn(`[active-stories-forex cron] COT context fetch failed:`, (e as Error).message)
        return null
      }),
    ])
    const newsBlockFull = formatNewsForPrompt(newsResult.items, 80)
    const newsBlockForex = filterNewsForForex(newsBlockFull)
    console.log(`[active-stories-forex cron] runId=${runId} fetched ${newsResult.counts.afterDedupe} headlines (${newsBlockForex.split('\n').filter(l => l.trim()).length} forex-relevant) + regime=${regime.regime} + cal=${scheduledCatalysts ? 'Y' : 'N'} + cot=${cotContext ? 'Y' : 'N'} in ${Date.now() - fetchStart}ms`)

    // ── Step 3: classify with forex-specific Claude prompt ────
    const classifyStart = Date.now()
    const classification = await classifyForexActiveStories({
      runId,
      triggerSource,
      regime,
      activeStories: activeForex,
      newsBlock: newsBlockForex,
      scheduledCatalysts: scheduledCatalysts || null,
      cotContext,
    })
    console.log(`[active-stories-forex cron] runId=${runId} classified in ${Date.now() - classifyStart}ms (updates=${classification.storyUpdates.length} new=${classification.newStories.length})`)

    // ── Step 4: apply LLM-driven updates ──────────────────────
    let updatedCount = 0
    let resolvedByLLM = 0
    for (const u of classification.storyUpdates) {
      try {
        await updateStory(
          {
            storyId: u.storyId,
            note: u.note,
            newSignal: u.newSignal,
            newConfidence: u.newConfidence,
            markPlayingOut: u.markPlayingOut,
            markResolved: u.markResolved,
            resolutionReason: u.resolutionReason,
          },
          runId,
        )
        if (u.markResolved) {
          resolvedByLLM++
        } else {
          updatedCount++
        }
      } catch (e) {
        console.warn(`[active-stories-forex cron] runId=${runId} updateStory failed for ${u.storyId}:`, e instanceof Error ? e.message : e)
      }
    }
    summary.storiesUpdated = updatedCount
    summary.storiesResolved = resolvedByLLM

    // ── Step 5: enforce idle/time-cap decay for forex stories ──
    // Note: expireIdle/expireTimeCapped operate on ALL stories in the table,
    // not just forex. That's fine — they're safe to run from either cron;
    // they just won't act on equity stories the equity cron already handles.
    const idleResolved = await expireIdle(runId)
    const timeCapResolved = await expireTimeCapped()
    summary.storiesForceResolved += idleResolved + timeCapResolved
    console.log(`[active-stories-forex cron] runId=${runId} decay: idle=${idleResolved} timeCap=${timeCapResolved}`)

    // ── Step 6: enforce hard cap (overflow eviction) ──────────
    if (classification.newStories.length > 0) {
      const overflowResolved = await enforceHardCap()
      summary.storiesForceResolved += overflowResolved
    }

    // ── Step 7: fetch entry prices then insert new forex stories ──
    let addedCount = 0
    if (classification.newStories.length > 0) {
      const priceLookups = await fetchCurrentPricesMany(
        classification.newStories.map(n => ({ ticker: n.ticker, assetType: n.assetType })),
      )
      for (const n of classification.newStories) {
        const lookup = priceLookups.get(n.ticker.toUpperCase())
        const enriched = {
          ...n,
          // Force assetType to 'forex' regardless of what the price lookup
          // says — forex pairs may not be recognized by current-price helper
          // but we know they're forex.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          assetType: 'forex' as any,
          entryPrice: lookup?.price ?? null,
          entryPriceAt: lookup?.price !== null && lookup?.price !== undefined
            ? lookup.fetchedAt
            : null,
        }
        try {
          await insertStory(enriched, runId)
          addedCount++
        } catch (e) {
          console.warn(`[active-stories-forex cron] runId=${runId} insertStory failed for ${n.ticker}:`, e instanceof Error ? e.message : e)
        }
      }
    }
    summary.storiesAdded = addedCount

    // ── Step 8: re-count active forex stories for summary ────
    const allActiveAfter = await loadActiveStories()
    summary.storiesActiveAfter = filterActiveStoriesForex(allActiveAfter).length

    // ── Step 9: persist forex-specific run metadata ──────────
    // Separate row (id=2) so equity dashboard metadata (id=1) is untouched
    await persistLatestForexRunMetadata({
      runId,
      triggerSource,
      generatedAt: new Date().toISOString(),
      marketTheme: classification.marketTheme,
      marketStatus: classification.marketStatus,
      summary: classification.summary,
    })
  } catch (e) {
    errorMessage = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)
    console.error(`[active-stories-forex cron] runId=${runId} FAILED:`, errorMessage)
  } finally {
    summary.durationMs = Date.now() - start
    if (runId > 0) {
      await finishRun(runId, summary, errorMessage).catch(e =>
        console.warn(`[active-stories-forex cron] finishRun log failed:`, e instanceof Error ? e.message : e),
      )
    }
    console.log(`[active-stories-forex cron] runId=${runId} done in ${summary.durationMs}ms`)
  }

  return NextResponse.json({
    ok: !errorMessage,
    runId,
    triggerSource,
    summary,
    error: errorMessage?.slice(0, 500),
  })
}

// ─────────────────────────────────────────────────────────────
// Forex-specific run metadata persistence (id=2 row to isolate
// from equity dashboard's id=1 row)
// ─────────────────────────────────────────────────────────────

interface LatestForexRunMetadata {
  runId: number
  triggerSource: string
  generatedAt: string
  marketTheme: string
  marketStatus: string
  summary: string
}

async function persistLatestForexRunMetadata(meta: LatestForexRunMetadata): Promise<void> {
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) return
    const admin = createClient(url, key)
    await admin
      .from('active_stories_meta')
      .upsert({
        id: 2,  // distinct from id=1 (equity)
        run_id: meta.runId,
        trigger_source: meta.triggerSource,
        generated_at: meta.generatedAt,
        market_theme: meta.marketTheme,
        market_status: meta.marketStatus,
        summary: meta.summary,
      })
  } catch (e) {
    console.warn(`[active-stories-forex cron] persistLatestForexRunMetadata failed:`, e instanceof Error ? e.message : e)
  }
}
