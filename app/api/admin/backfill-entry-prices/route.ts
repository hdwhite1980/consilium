// =============================================================
// app/api/admin/backfill-entry-prices/route.ts
//
// One-shot backfill: for every active/playing_out story with a
// NULL entry_price, fetch the current spot price and use it as
// the entry price. This is for stories that were created BEFORE
// the Bug 23 migration added the entry_price columns.
//
// Auth: CRON_SECRET Bearer header (same pattern as the cron route).
// Idempotent: re-running finds nothing to backfill (entry_price is no
// longer NULL after the first successful run).
//
// CALLER MUST UNDERSTAND: the resulting entry price reflects "the
// moment of backfill," NOT the moment the story was first tracked.
// For a story tracked 18.7 hours ago, this means the delta will
// effectively start from today, not from the original flag-point.
// This is a deliberate choice for Option A — see the original
// design decision discussion.
//
// Trigger:
//   curl -X POST https://wali-os.com/api/admin/backfill-entry-prices \
//     -H "Authorization: Bearer $CRON_SECRET"
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { fetchCurrentPricesMany } from '@/app/lib/data/current-price'

export const runtime = 'nodejs'
export const maxDuration = 60

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  const auth = req.headers.get('authorization')
  return auth === `Bearer ${cronSecret}`
}

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createAdmin(url, key)
}

interface BackfillResult {
  ok: boolean
  candidatesFound: number
  succeeded: number
  failed: number
  skipped: number
  failures: Array<{ ticker: string; reason: string }>
  durationMs: number
}

export async function POST(req: NextRequest) {
  return runBackfill(req)
}

// Allow GET too for browser-based manual triggering during admin work
export async function GET(req: NextRequest) {
  return runBackfill(req)
}

async function runBackfill(req: NextRequest): Promise<NextResponse<BackfillResult | { error: string }>> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const start = Date.now()
  const result: BackfillResult = {
    ok: true,
    candidatesFound: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    failures: [],
    durationMs: 0,
  }

  try {
    const admin = getAdmin()

    // Step 1: load candidates (active or playing_out, entry_price IS NULL)
    const { data: candidates, error: loadErr } = await admin
      .from('tracked_stories')
      .select('id, ticker, asset_type, signal, status')
      .in('status', ['active', 'playing_out'])
      .is('entry_price', null)

    if (loadErr) {
      return NextResponse.json({ error: `Failed to load candidates: ${loadErr.message}` }, { status: 500 })
    }

    const rows = candidates ?? []
    result.candidatesFound = rows.length

    if (rows.length === 0) {
      result.durationMs = Date.now() - start
      console.log(`[backfill-entry-prices] no candidates found, nothing to do`)
      return NextResponse.json(result)
    }

    console.log(`[backfill-entry-prices] found ${rows.length} candidates, fetching prices...`)

    // Step 2: fetch prices for unique tickers in parallel
    const uniqueTickers = new Map<string, { ticker: string; assetType: string }>()
    for (const r of rows) {
      const key = `${r.ticker}:${r.asset_type ?? 'stock'}`
      if (!uniqueTickers.has(key)) {
        uniqueTickers.set(key, { ticker: r.ticker, assetType: r.asset_type ?? 'stock' })
      }
    }

    const lookups = await fetchCurrentPricesMany(Array.from(uniqueTickers.values()))
    console.log(`[backfill-entry-prices] fetched ${lookups.size} unique prices`)

    // Step 3: update each row sequentially with its corresponding price
    const now = new Date().toISOString()
    for (const row of rows) {
      const lookup = lookups.get(row.ticker.toUpperCase())
      if (!lookup || lookup.price === null) {
        result.skipped++
        result.failures.push({
          ticker: row.ticker,
          reason: lookup ? `lookup returned null (source: ${lookup.source})` : 'no lookup result',
        })
        continue
      }

      const { error: updateErr } = await admin
        .from('tracked_stories')
        .update({
          entry_price: lookup.price,
          entry_price_at: now,
          // Also normalize asset_type if the lookup auto-corrected it
          // (e.g. forex pair tagged as 'stock' in old rows)
          asset_type: lookup.assetType,
        })
        .eq('id', row.id)
        .is('entry_price', null) // safety: don't overwrite if another process beat us to it

      if (updateErr) {
        result.failed++
        result.failures.push({ ticker: row.ticker, reason: `update failed: ${updateErr.message}` })
      } else {
        result.succeeded++
      }
    }

    result.durationMs = Date.now() - start
    console.log(`[backfill-entry-prices] done: ${result.succeeded} succeeded, ${result.skipped} skipped (price lookup failed), ${result.failed} update errors in ${result.durationMs}ms`)
    return NextResponse.json(result)
  } catch (e) {
    result.ok = false
    result.durationMs = Date.now() - start
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[backfill-entry-prices] FAILED:', msg)
    return NextResponse.json({ error: msg.slice(0, 500) }, { status: 500 })
  }
}
