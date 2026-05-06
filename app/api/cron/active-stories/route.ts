// =============================================================
// app/api/cron/active-stories/route.ts
//
// Cron job that runs 4× daily (6am/12pm/5pm/9pm ET) to:
//   1. Load currently-active stories
//   2. Fetch fresh news + market regime
//   3. Ask Claude to classify (updates + new stories)
//   4. Apply changes via story-tracker helpers
//   5. Enforce decay (idle expiry, time cap, hard cap)
//   6. Log run summary
//
// Auth: Vercel-style cron secret check via CRON_SECRET env var.
// Returns 200 with summary JSON; the route never throws to the caller.
// All operational failures are caught and logged to tracked_stories_run_log.
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
import { classifyActiveStories } from '@/app/lib/active-stories-classifier'
import { fetchCurrentPricesMany } from '@/app/lib/data/current-price'

// Vercel cron config — runs 6am/12pm/5pm/9pm ET (10/16/21/01 UTC during EDT)
// Configure in vercel.json — this route is the target.
export const runtime = 'nodejs'
export const maxDuration = 300  // 5 minutes — accommodates Claude + news fetch

// ─────────────────────────────────────────────────────────────
// Auth — gate the cron with a shared secret so only Vercel/Railway
// can trigger it. Allow GET (cron) and POST (manual trigger for testing).
// ─────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false  // never allow if secret not configured
  const auth = req.headers.get('authorization')
  if (!auth) return false
  // Vercel sends: "Bearer <secret>"
  return auth === `Bearer ${cronSecret}`
}

export async function GET(req: NextRequest) {
  return runCron(req)
}

export async function POST(req: NextRequest) {
  return runCron(req)
}

// ─────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────

async function runCron(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
    console.log(`[active-stories cron] runId=${runId} source=${triggerSource} starting`)

    // ── Step 1: load existing active stories ──────────────────
    const activeBefore = await loadActiveStories()
    summary.storiesActiveBefore = activeBefore.length
    console.log(`[active-stories cron] runId=${runId} loaded ${activeBefore.length} active stories`)

    // ── Step 2: fetch news + regime in parallel ───────────────
    const fetchStart = Date.now()
    const [newsResult, regime] = await Promise.all([
      fetchMultiSourceNews({ includeCrypto: true }),
      getMarketRegime(),
    ])
    const newsBlock = formatNewsForPrompt(newsResult.items, 60)
    console.log(`[active-stories cron] runId=${runId} fetched ${newsResult.counts.afterDedupe} headlines + regime=${regime.regime} in ${Date.now() - fetchStart}ms`)

    // ── Step 3: classify with Claude ──────────────────────────
    const classifyStart = Date.now()
    const classification = await classifyActiveStories({
      runId,
      triggerSource,
      regime,
      activeStories: activeBefore,
      newsBlock,
    })
    console.log(`[active-stories cron] runId=${runId} classified in ${Date.now() - classifyStart}ms (updates=${classification.storyUpdates.length} new=${classification.newStories.length})`)

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
        console.warn(`[active-stories cron] runId=${runId} updateStory failed for ${u.storyId}:`, e instanceof Error ? e.message : e)
      }
    }
    summary.storiesUpdated = updatedCount
    summary.storiesResolved = resolvedByLLM
    console.log(`[active-stories cron] runId=${runId} applied ${updatedCount} updates + ${resolvedByLLM} LLM resolutions`)

    // ── Step 5: enforce idle expiry + time-cap decay BEFORE inserting new ──
    // (Sequenced this way so we evict stale entries before checking hard cap.)
    const idleResolved = await expireIdle(runId)
    const timeCapResolved = await expireTimeCapped()
    summary.storiesForceResolved += idleResolved + timeCapResolved
    console.log(`[active-stories cron] runId=${runId} decay: idle=${idleResolved} timeCap=${timeCapResolved}`)

    // ── Step 6: enforce hard cap (overflow eviction) ──────────
    // Run BEFORE insertions so we make space for the fresh batch.
    if (classification.newStories.length > 0) {
      const overflowResolved = await enforceHardCap()
      summary.storiesForceResolved += overflowResolved
      if (overflowResolved > 0) {
        console.log(`[active-stories cron] runId=${runId} overflow: evicted ${overflowResolved} oldest stories`)
      }
    }

    // ── Step 7: fetch entry prices then insert new stories ───
    // Bug 23: capture spot price at the moment of creation (immutable
    // audit trail). Lookups run in parallel; failures don't block insertion.
    let addedCount = 0
    if (classification.newStories.length > 0) {
      const priceLookups = await fetchCurrentPricesMany(
        classification.newStories.map(n => ({ ticker: n.ticker, assetType: n.assetType })),
      )
      for (const n of classification.newStories) {
        const lookup = priceLookups.get(n.ticker.toUpperCase())
        const enriched = {
          ...n,
          // Apply auto-corrected asset type so the DB row is canonical
          assetType: lookup?.assetType ?? n.assetType ?? 'stock',
          entryPrice: lookup?.price ?? null,
          entryPriceAt: lookup?.price !== null && lookup?.price !== undefined
            ? lookup.fetchedAt
            : null,
        }
        try {
          await insertStory(enriched, runId)
          addedCount++
        } catch (e) {
          console.warn(`[active-stories cron] runId=${runId} insertStory failed for ${n.ticker}:`, e instanceof Error ? e.message : e)
        }
      }
    }
    summary.storiesAdded = addedCount
    console.log(`[active-stories cron] runId=${runId} inserted ${addedCount} new stories`)

    // ── Step 8: re-count active for summary ───────────────────
    const activeAfter = await loadActiveStories()
    summary.storiesActiveAfter = activeAfter.length

    // ── Step 9: persist run summary metadata for the dashboard ─
    // Stored in a small kv-style row so the GET endpoint can read latest run context
    // without re-querying every active story for theme/status.
    await persistLatestRunMetadata({
      runId,
      triggerSource,
      generatedAt: new Date().toISOString(),
      marketTheme: classification.marketTheme,
      marketStatus: classification.marketStatus,
      summary: classification.summary,
    })
  } catch (e) {
    errorMessage = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)
    console.error(`[active-stories cron] runId=${runId} FAILED:`, errorMessage)
  } finally {
    summary.durationMs = Date.now() - start
    if (runId > 0) {
      await finishRun(runId, summary, errorMessage).catch(e =>
        console.warn(`[active-stories cron] finishRun log failed:`, e instanceof Error ? e.message : e),
      )
    }
    console.log(`[active-stories cron] runId=${runId} done in ${summary.durationMs}ms`)
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
// Latest-run metadata persistence
//
// The classification produces marketTheme/marketStatus/summary for THIS run.
// The dashboard wants the most-recent run's metadata. Rather than infer it
// from logs, we store it in a tiny kv table — one row, latest values.
// ─────────────────────────────────────────────────────────────

interface LatestRunMetadata {
  runId: number
  triggerSource: string
  generatedAt: string
  marketTheme: string
  marketStatus: string
  summary: string
}

async function persistLatestRunMetadata(meta: LatestRunMetadata): Promise<void> {
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) return
    const admin = createClient(url, key)
    // Upsert into a single-row table — id=1 always
    await admin
      .from('active_stories_meta')
      .upsert({
        id: 1,
        run_id: meta.runId,
        trigger_source: meta.triggerSource,
        generated_at: meta.generatedAt,
        market_theme: meta.marketTheme,
        market_status: meta.marketStatus,
        summary: meta.summary,
      })
  } catch (e) {
    console.warn(`[active-stories cron] persistLatestRunMetadata failed:`, e instanceof Error ? e.message : e)
  }
}
