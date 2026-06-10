// =============================================================
// app/api/admin/reingest-13f/route.ts
//
// Admin route to re-ingest 13F institutional holdings for a single
// ticker after the CUSIP-matching fix (June 2026).
//
// Usage (PowerShell):
//   $secret = "<your CRON_SECRET>"
//   curl -X POST "https://wali-os.com/api/admin/reingest-13f?ticker=MSFT" `
//        -H "Authorization: Bearer $secret"
//
// Or for a quick batch (run sequentially to be polite to EDGAR):
//   foreach ($t in @('MSFT','AAPL','LI','LLY','NVDA','TSLA','PDD')) {
//     curl -X POST "https://wali-os.com/api/admin/reingest-13f?ticker=$t" `
//          -H "Authorization: Bearer $secret"
//   }
//
// Workflow:
//   1. Delete existing rows for this ticker from institutional_holdings
//      (they were polluted by the substring-matching bug)
//   2. Call fetch13FForTicker which now matches by CUSIP
//   3. Return counts so caller can verify
//
// This route is gated by the same CRON_SECRET as other admin routes.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fetch13FForTicker } from '@/app/lib/data/sec-filings'

export const runtime = 'nodejs'
export const maxDuration = 120  // EDGAR fetches can be slow

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const header = req.headers.get('authorization')
  return header === `Bearer ${secret}`
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ticker = req.nextUrl.searchParams.get('ticker')?.toUpperCase().trim()
  if (!ticker || !/^[A-Z0-9.]{1,10}$/.test(ticker)) {
    return NextResponse.json({ error: 'Valid ticker required' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'Supabase env not set' }, { status: 500 })
  }
  const supabase = createClient(url, key)

  try {
    // Step 1: Count what we're about to wipe (for the audit log)
    const { count: countBefore, error: countErr } = await supabase
      .from('institutional_holdings')
      .select('*', { count: 'exact', head: true })
      .eq('ticker', ticker)
    if (countErr) {
      return NextResponse.json({
        error: 'Count query failed',
        detail: countErr.message,
      }, { status: 500 })
    }

    // Step 2: Delete existing rows for this ticker.
    // These were written by the buggy substring-matcher and need to go.
    // We delete rather than mark 'rejected' because the next ingestion
    // will rebuild from scratch with correct data — no value in keeping
    // the polluted rows.
    const { error: delErr } = await supabase
      .from('institutional_holdings')
      .delete()
      .eq('ticker', ticker)
    if (delErr) {
      return NextResponse.json({
        error: 'Delete failed',
        detail: delErr.message,
      }, { status: 500 })
    }

    // Step 3: Re-ingest with the CUSIP-matching ingestion.
    // fetch13FForTicker iterates the 10 major institutions and writes
    // any positions it finds for this ticker (matched by CUSIP).
    const tStart = Date.now()
    await fetch13FForTicker(ticker)
    const durationMs = Date.now() - tStart

    // Step 4: Verify what got written
    const { data: rowsAfter, error: postErr } = await supabase
      .from('institutional_holdings')
      .select('institution, shares_held, data_quality, quarter')
      .eq('ticker', ticker)
      .order('shares_held', { ascending: false })
    if (postErr) {
      return NextResponse.json({
        error: 'Post-ingestion query failed',
        detail: postErr.message,
      }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      ticker,
      rowsDeleted: countBefore ?? 0,
      rowsWritten: rowsAfter?.length ?? 0,
      durationMs,
      verified: rowsAfter?.filter(r => r.data_quality === 'verified').length ?? 0,
      unverified: rowsAfter?.filter(r => r.data_quality === 'unverified').length ?? 0,
      rows: rowsAfter,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({
      error: 'Re-ingestion failed',
      detail: msg.slice(0, 500),
    }, { status: 500 })
  }
}

// GET variant for convenience — same behavior, easier to invoke from
// a browser or curl without -X POST.
export async function GET(req: NextRequest) {
  return POST(req)
}
