// =============================================================
// app/api/cron/reingest-13f-batch/route.ts
//
// Batch 13F re-ingestion. Runs server-side on Railway, iterating the
// full TICKER_CUSIPS list with polite pacing to EDGAR.
//
// Triggered by GitHub Actions cron (quarterly, ~3 weeks after each
// 13F filing deadline), or manually via a workflow_dispatch.
//
// Auth: Bearer CRON_SECRET (same pattern as active-stories-cron).
//
// Behavior:
//   - mode=full (default): deletes ALL existing rows for each ticker,
//     re-fetches from EDGAR with CUSIP matching. Used after fixing
//     the substring-matching bug — rebuilds the table cleanly.
//   - mode=incremental: only re-ingests tickers whose latest row is
//     older than the current quarter. Cheaper, runs quarterly.
//
// Pacing: 2 seconds between tickers, plus the natural delay of the
// 10 sequential EDGAR fetches inside each fetch13FForTicker call.
// At ~50 tickers, this takes 5-15 minutes of wall time on Railway,
// well within the 30-minute maxDuration cap.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fetch13FForTicker, TICKER_CUSIPS } from '@/app/lib/data/sec-filings'

export const runtime = 'nodejs'
export const maxDuration = 1800  // 30 min — large enough for ~100 tickers

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const header = req.headers.get('authorization')
  return header === `Bearer ${secret}`
}

interface TickerResult {
  ticker: string
  rowsDeletedFirst: number
  rowsWritten: number
  verified: number
  unverified: number
  durationMs: number
  error?: string
}

async function processTicker(
  supabase: ReturnType<typeof createClient>,
  ticker: string,
  mode: 'full' | 'incremental',
): Promise<TickerResult> {
  const tStart = Date.now()
  const result: TickerResult = {
    ticker,
    rowsDeletedFirst: 0,
    rowsWritten: 0,
    verified: 0,
    unverified: 0,
    durationMs: 0,
  }

  try {
    if (mode === 'full') {
      // Wipe existing rows so the CUSIP-matched ingestion has a clean slate.
      // The existing rows were written by the broken substring matcher and
      // are mostly wrong; keeping them only confuses the data.
      const { count: countBefore } = await supabase
        .from('institutional_holdings')
        .select('*', { count: 'exact', head: true })
        .eq('ticker', ticker)
      result.rowsDeletedFirst = countBefore ?? 0

      const { error: delErr } = await supabase
        .from('institutional_holdings')
        .delete()
        .eq('ticker', ticker)
      if (delErr) throw new Error(`delete: ${delErr.message}`)
    }
    // Note: in incremental mode we don't delete. fetch13FForTicker has its
    // own existing-quarter check that skips if data already exists for the
    // current quarter — so incremental runs are essentially no-ops for
    // already-current tickers.

    await fetch13FForTicker(ticker)

    // Count what got written.
    // Explicit type annotation needed because Supabase JS returns `never[]`
    // when table types aren't generated — the filter callbacks below need
    // the row shape declared so TypeScript can check `r.data_quality`.
    const { data: rowsAfter, error: postErr } = await supabase
      .from('institutional_holdings')
      .select('data_quality')
      .eq('ticker', ticker)
    if (postErr) throw new Error(`verify: ${postErr.message}`)

    const typedRows = (rowsAfter ?? []) as Array<{ data_quality: string }>
    result.rowsWritten = typedRows.length
    result.verified = typedRows.filter(r => r.data_quality === 'verified').length
    result.unverified = typedRows.filter(r => r.data_quality === 'unverified').length
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
  }

  result.durationMs = Date.now() - tStart
  return result
}

async function runBatch(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json({ error: 'Supabase env not set' }, { status: 500 })
  }
  const supabase = createClient(url, key)

  // Parse params
  const mode = (req.nextUrl.searchParams.get('mode') ?? 'full') as 'full' | 'incremental'
  if (!['full', 'incremental'].includes(mode)) {
    return NextResponse.json({ error: 'mode must be full or incremental' }, { status: 400 })
  }

  // Optional comma-separated ticker filter — if not provided, run the
  // entire TICKER_CUSIPS list. Useful for one-off "fix one ticker" runs.
  const onlyParam = req.nextUrl.searchParams.get('only')
  const allTickers = Object.keys(TICKER_CUSIPS).filter((t: string) => !t.endsWith('_DUP'))
  const tickers = onlyParam
    ? onlyParam.split(',').map((t: string) => t.trim().toUpperCase()).filter((t: string) => allTickers.includes(t))
    : allTickers

  if (tickers.length === 0) {
    return NextResponse.json({ error: 'No matching tickers' }, { status: 400 })
  }

  const overallStart = Date.now()
  console.log(`[reingest-13f-batch] mode=${mode} tickers=${tickers.length} starting`)

  const results: TickerResult[] = []
  let successCount = 0
  let failureCount = 0

  for (const ticker of tickers) {
    const result = await processTicker(supabase, ticker, mode)
    results.push(result)
    if (result.error) {
      failureCount++
      console.warn(`[reingest-13f-batch] ${ticker} FAILED: ${result.error}`)
    } else {
      successCount++
      console.log(
        `[reingest-13f-batch] ${ticker}: deleted=${result.rowsDeletedFirst} ` +
        `written=${result.rowsWritten} (verified=${result.verified} unverified=${result.unverified}) ` +
        `in ${result.durationMs}ms`,
      )
    }
    // Polite pacing — EDGAR is okay with 10 req/sec per IP but this
    // function makes ~10 EDGAR calls per ticker already, so we space
    // ticker batches with a 2-second pause.
    await new Promise(r => setTimeout(r, 2000))
  }

  const totalDuration = Date.now() - overallStart
  const totalRowsWritten = results.reduce((s, r) => s + r.rowsWritten, 0)
  const totalVerified = results.reduce((s, r) => s + r.verified, 0)

  console.log(
    `[reingest-13f-batch] DONE: ${successCount} succeeded, ${failureCount} failed, ` +
    `${totalRowsWritten} rows written (${totalVerified} verified) in ${(totalDuration / 1000).toFixed(1)}s`,
  )

  return NextResponse.json({
    ok: true,
    mode,
    totalTickers: tickers.length,
    successCount,
    failureCount,
    totalRowsWritten,
    totalVerified,
    totalDurationMs: totalDuration,
    results,
  })
}

export async function POST(req: NextRequest) {
  return runBatch(req)
}

export async function GET(req: NextRequest) {
  return runBatch(req)
}
