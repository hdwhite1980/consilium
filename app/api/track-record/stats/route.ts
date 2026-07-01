// =============================================================
// app/api/track-record/stats/route.ts
//
// GET /api/track-record/stats?version=<n|all>&source=<src>
//
// Returns hit-rate and direction-accuracy stats for the requested
// system version (or all-time if version=all).
//
// Adds a `sampleNote` field with an honest disclaimer when the
// graded verdict count is too low for the numbers to be meaningful.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { isCryptoPairSymbol } from '@/app/lib/crypto-symbol'
import { bucketStats, type VRow, type BucketStats, MIN_ASSET_GRADED } from '@/app/lib/track-record/stats-core'
import {
  getCurrentVersion,
  getVersionByNumber,
  type SystemVersion,
} from '@/app/lib/system-versions'

export const runtime = 'nodejs'
export const maxDuration = 10

const MIN_GRADED_FOR_MATURE = 30  // below this, return preview note

// BucketStats is imported from the shared stats-core (single source of truth).
interface Stats extends BucketStats {
  sampleNote: string | null
  versionLabel: string
  byAsset: { stock: BucketStats; crypto: BucketStats; forex: BucketStats }
}

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createAdmin(url, key)
}

export async function GET(req: NextRequest) {
  try {
    // NOTE: This endpoint is intentionally PUBLIC.
    //
    // The track-record page is a conversion surface — anonymous visitors must be
    // able to see the version timeline and aggregated stats (hit rate, direction
    // accuracy, sample sizes) before they sign up. Gating it behind auth means
    // potential customers leave before seeing the trust story (version-honest
    // dashboard with preview badges, multi-version comparison).
    //
    // The exposed data is intentionally aggregated marketing content — no PII,
    // no individual user data, no sensitive trade-plan specifics. The verdict
    // list (which contains per-verdict entry/stop/target prices) is handled
    // separately by VerdictList and may apply its own gating policy.
    //
    // Previously this returned 401 for anonymous requests, which broke the
    // page's primary purpose. Email collection, if needed, happens via a
    // softer inline mechanism on the page itself rather than a hard auth wall.

    const url = new URL(req.url)
    const versionParam = url.searchParams.get('version') ?? 'current'
    const sourceParam = url.searchParams.get('source')

    // Resolve to a version metadata object (or null for all-time)
    let version: SystemVersion | null = null
    if (versionParam === 'all') {
      version = null
    } else if (versionParam === 'current') {
      version = getCurrentVersion()
    } else {
      const n = parseInt(versionParam, 10)
      if (Number.isNaN(n)) {
        return NextResponse.json({ error: 'Invalid version param' }, { status: 400 })
      }
      version = getVersionByNumber(n)
      if (!version) {
        return NextResponse.json({ error: `Unknown version ${n}` }, { status: 404 })
      }
    }

    const stats = await computeStats(version, sourceParam)
    return NextResponse.json(stats, {
      // Public, short-lived cache: response is identical for all visitors,
      // graded outcomes don't change minute-to-minute (cron grades 1x daily).
      // s-maxage applies at CDN/edge; max-age in the browser. Both 5 min.
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300' },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[track-record/stats] Error:', msg)
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────
// Stats math lives in the shared core so this page and the public verdict feed
// compute identical numbers. Only the local asset classifier is kept (it uses
// the project's isCryptoPairSymbol helper for the per-asset breakdown).


function assetOf(ticker: string | null): 'crypto' | 'forex' | 'stock' {
  if (!ticker) return 'stock'
  if (isCryptoPairSymbol(ticker)) return 'crypto'
  if (/^[A-Z]{6}$/.test(ticker)) return 'forex'
  return 'stock'
}

async function computeStats(version: SystemVersion | null, source?: string | null): Promise<Stats> {
  const admin = getAdmin()
  let q = admin
    .from('verdict_log')
    .select('outcome_1w_strict, outcome_1w_directional, outcome_1w_price, signal, entry_price, stop_loss, take_profit, ticker, spy_return_1w')
    .in('signal', ['BULLISH', 'BEARISH'])

  // Max (day_shark) is measured separately — exclude by default; opt in via ?source=day_shark
  if (source === 'day_shark') q = q.eq('source', 'day_shark')
  else q = q.or('source.is.null,source.neq.day_shark')

  if (version) q = q.eq('version_number', version.number)

  const { data, error } = await q
  if (error) throw new Error(`stats query failed: ${error.message}`)

  const rows = (data ?? []) as VRow[]
  const overall = bucketStats(rows)
  // Per-asset breakdown — but blank out any asset with too few graded outcomes.
  // A single crypto sample producing a "-98060% median return" is noise that
  // erodes trust on a customer-facing page, so it's suppressed until meaningful.
  const assetBucket = (r: VRow[]) => {
    const b = bucketStats(r)
    return b.gradedVerdicts >= MIN_ASSET_GRADED ? b : { ...b, lowSample: true }
  }
  const byAsset = {
    stock: assetBucket(rows.filter(r => assetOf(r.ticker) === 'stock')),
    crypto: assetBucket(rows.filter(r => assetOf(r.ticker) === 'crypto')),
    forex: assetBucket(rows.filter(r => assetOf(r.ticker) === 'forex')),
  }

  // Honest sample-size note
  let sampleNote: string | null = null
  if (overall.gradedVerdicts === 0 && overall.totalVerdicts > 0) {
    sampleNote = `${overall.totalVerdicts} verdicts logged, none graded yet — outcomes need ~5 trading days to resolve`
  } else if (overall.gradedVerdicts < MIN_GRADED_FOR_MATURE) {
    sampleNote = `Preview — only ${overall.gradedVerdicts} graded outcomes, too small to draw conclusions yet`
  }

  return { ...overall, byAsset, sampleNote, versionLabel: version?.label ?? 'All time' }
}
