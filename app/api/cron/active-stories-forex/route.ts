// =============================================================
// app/api/cron/active-stories-forex/route.ts
//
// Active Stories — FOREX generation cron. The forex counterpart to the stock
// active-stories cron. Mirrors that pipeline but feeds the classifier
// forex-filtered news + COT positioning, and only touches forex stories:
//
//   1. Load existing active stories, keep the forex ones
//   2. Fetch news + market regime + COT context (forex-relevant)
//   3. classifyForexActiveStories() — Claude/Sonar, forex-tuned
//   4. Apply updates + insert new forex stories via story-tracker
//
// Global lifecycle (idle/time-cap/hard-cap eviction) is intentionally owned by
// the stock cron's global passes, so this run is purely additive for forex and
// never evicts stock stories.
//
// NOTE: this file previously contained a stray copy of the auto-trade-forex
// worker, so the forex classifier was never invoked — forex stories were not
// being generated at all.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { fetchMultiSourceNews, formatNewsForPrompt } from '@/app/lib/multi-source-news'
import { getMarketRegime } from '@/app/lib/market-regime'
import {
  loadActiveStories,
  insertStory,
  updateStory,
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
import { fetchForexRate } from '@/app/lib/data/forex'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(req: NextRequest): Promise<NextResponse> { return runCron(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return runCron(req) }

async function runCron(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const start = Date.now()
  const triggerSource = cronSourceLabel()
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

    // ── Step 1: existing active forex stories ──
    const allActive = await loadActiveStories()
    const forexActive = filterActiveStoriesForex(allActive)
    summary.storiesActiveBefore = forexActive.length
    console.log(`[active-stories-forex cron] runId=${runId} ${forexActive.length} active forex stories (of ${allActive.length} total)`)

    // ── Step 2: news + regime + COT in parallel ──
    const fetchStart = Date.now()
    const [newsResult, regime, cotContext] = await Promise.all([
      fetchMultiSourceNews({ includeCrypto: false }),
      getMarketRegime(),
      buildForexCotContext().catch(e => {
        console.warn(`[active-stories-forex cron] COT context failed:`, (e as Error).message?.slice(0, 100))
        return null
      }),
    ])
    const newsBlock = filterNewsForForex(formatNewsForPrompt(newsResult.items, 80))
    console.log(`[active-stories-forex cron] runId=${runId} news+regime+cot in ${Date.now() - fetchStart}ms (regime=${regime.regime}, cot=${cotContext ? 'Y' : 'N'})`)

    // ── Step 3: classify ──
    const classifyStart = Date.now()
    const classification = await classifyForexActiveStories({
      runId,
      triggerSource,
      regime,
      activeStories: forexActive,
      newsBlock,
      scheduledCatalysts: null,
      cotContext,
    })
    console.log(`[active-stories-forex cron] runId=${runId} classified in ${Date.now() - classifyStart}ms (updates=${classification.storyUpdates.length} new=${classification.newStories.length})`)

    // ── Step 4: apply updates ──
    let updatedCount = 0
    let resolvedByLLM = 0
    for (const u of classification.storyUpdates) {
      try {
        await updateStory({
          storyId: u.storyId,
          note: u.note,
          newSignal: u.newSignal,
          newConfidence: u.newConfidence,
          markPlayingOut: u.markPlayingOut,
          markResolved: u.markResolved,
          resolutionReason: u.resolutionReason,
        }, runId)
        if (u.markResolved) resolvedByLLM++; else updatedCount++
      } catch (e) {
        console.warn(`[active-stories-forex cron] runId=${runId} updateStory ${u.storyId} failed:`, e instanceof Error ? e.message : e)
      }
    }
    summary.storiesUpdated = updatedCount
    summary.storiesResolved = resolvedByLLM

    // ── Step 5: insert new forex stories (entry price best-effort via OANDA/ECB rate) ──
    let addedCount = 0
    for (const n of classification.newStories) {
      let entryPrice: number | null = null
      try { const r = await fetchForexRate(n.ticker); if (r > 0) entryPrice = r } catch { /* best-effort */ }
      const enriched = {
        ...n,
        assetType: 'forex' as const,
        entryPrice,
        entryPriceAt: entryPrice !== null ? new Date().toISOString() : null,
      }
      try {
        await insertStory(enriched, runId)
        addedCount++
      } catch (e) {
        console.warn(`[active-stories-forex cron] runId=${runId} insertStory ${n.ticker} failed:`, e instanceof Error ? e.message : e)
      }
    }
    summary.storiesAdded = addedCount

    // ── Step 6: re-count + finish ──
    const forexAfter = filterActiveStoriesForex(await loadActiveStories())
    summary.storiesActiveAfter = forexAfter.length
    console.log(`[active-stories-forex cron] runId=${runId} done: +${addedCount} new, ${updatedCount} updated, ${resolvedByLLM} resolved → ${forexAfter.length} active`)
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e)
    console.error(`[active-stories-forex cron] runId=${runId} failed:`, errorMessage)
  } finally {
    summary.durationMs = Date.now() - start
    if (runId > 0) {
      await finishRun(runId, summary, errorMessage).catch(e =>
        console.warn(`[active-stories-forex cron] finishRun failed:`, e instanceof Error ? e.message : e))
    }
  }

  return NextResponse.json(summary)
}
