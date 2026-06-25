// =============================================================
// app/api/cron/active-stories-futures/route.ts
//
// Active Stories — INDEX-FUTURES / MACRO generation cron. Mirrors the forex
// story cron but runs the futures (macro) classifier and only touches futures
// stories. Global story lifecycle (idle/time-cap/hard-cap) is owned by the
// stock cron's global passes, so this run is purely additive.
//
// Stories are tagged assetType='futures' with a tradeable ETF-proxy ticker
// (SPY/QQQ/IWM/DIA/VIXY/TLT/IEF/UUP), so the existing equity execution path
// trades the macro view on the funded Alpaca account.
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
  classifyFuturesActiveStories,
  filterActiveStoriesFutures,
  buildFuturesCotContext,
} from '@/app/lib/active-stories-futures-classifier'
import { fetchCurrentPricesMany } from '@/app/lib/data/current-price'

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
    runId: 0, storiesActiveBefore: 0, storiesActiveAfter: 0,
    storiesAdded: 0, storiesUpdated: 0, storiesResolved: 0,
    storiesForceResolved: 0, durationMs: 0,
  }

  try {
    runId = await startRun(triggerSource)
    summary.runId = runId
    console.log(`[active-stories-futures cron] runId=${runId} source=${triggerSource} starting`)

    const allActive = await loadActiveStories()
    const futuresActive = filterActiveStoriesFutures(allActive)
    summary.storiesActiveBefore = futuresActive.length

    const fetchStart = Date.now()
    const [newsResult, regime, cotContext] = await Promise.all([
      fetchMultiSourceNews({ includeCrypto: false }),
      getMarketRegime(),
      buildFuturesCotContext().catch(() => null),
    ])
    const newsBlock = formatNewsForPrompt(newsResult.items, 80)
    console.log(`[active-stories-futures cron] runId=${runId} news+regime+cot in ${Date.now() - fetchStart}ms (regime=${regime.regime}, cot=${cotContext ? 'Y' : 'N'})`)

    const classifyStart = Date.now()
    const classification = await classifyFuturesActiveStories({
      runId, triggerSource, regime,
      activeStories: futuresActive,
      newsBlock,
      cotContext,
    })
    console.log(`[active-stories-futures cron] runId=${runId} classified in ${Date.now() - classifyStart}ms (updates=${classification.storyUpdates.length} new=${classification.newStories.length})`)

    let updatedCount = 0
    let resolvedByLLM = 0
    for (const u of classification.storyUpdates) {
      try {
        await updateStory({
          storyId: u.storyId, note: u.note, newSignal: u.newSignal,
          newConfidence: u.newConfidence, markPlayingOut: u.markPlayingOut,
          markResolved: u.markResolved, resolutionReason: u.resolutionReason,
        }, runId)
        if (u.markResolved) resolvedByLLM++; else updatedCount++
      } catch (e) {
        console.warn(`[active-stories-futures cron] runId=${runId} updateStory ${u.storyId} failed:`, e instanceof Error ? e.message : e)
      }
    }
    summary.storiesUpdated = updatedCount
    summary.storiesResolved = resolvedByLLM

    let addedCount = 0
    if (classification.newStories.length > 0) {
      const priceLookups = await fetchCurrentPricesMany(
        classification.newStories.map(n => ({ ticker: n.ticker, assetType: 'stock' as const })),
      ).catch(() => new Map())
      for (const n of classification.newStories) {
        const lookup = priceLookups.get(n.ticker.toUpperCase())
        const enriched = {
          ...n,
          assetType: 'futures' as const,
          entryPrice: lookup?.price ?? null,
          entryPriceAt: lookup?.price !== null && lookup?.price !== undefined ? lookup.fetchedAt : null,
        }
        try {
          await insertStory(enriched, runId)
          addedCount++
        } catch (e) {
          console.warn(`[active-stories-futures cron] runId=${runId} insertStory ${n.ticker} failed:`, e instanceof Error ? e.message : e)
        }
      }
    }
    summary.storiesAdded = addedCount

    summary.storiesActiveAfter = filterActiveStoriesFutures(await loadActiveStories()).length
    console.log(`[active-stories-futures cron] runId=${runId} done: +${addedCount} new, ${updatedCount} updated, ${resolvedByLLM} resolved → ${summary.storiesActiveAfter} active`)
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e)
    console.error(`[active-stories-futures cron] runId=${runId} failed:`, errorMessage)
  } finally {
    summary.durationMs = Date.now() - start
    if (runId > 0) {
      await finishRun(runId, summary, errorMessage).catch(e =>
        console.warn(`[active-stories-futures cron] finishRun failed:`, e instanceof Error ? e.message : e))
    }
  }

  return NextResponse.json(summary)
}
