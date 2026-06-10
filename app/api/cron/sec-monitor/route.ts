// =============================================================
// app/api/cron/sec-monitor/route.ts
//
// Real-time SEC filing monitor cron. Polls EDGAR atom feeds for
// new Form 4 / 13D / 13G / 8-K filings, parses the structured
// data, filters for signal, and writes matches to filing_alerts.
//
// Triggered by GitHub Actions every 10 minutes.
// Auth: Bearer CRON_SECRET.
//
// Current scope (Step 1):
//   - Form 4 only
// Coming in subsequent steps:
//   - Step 2: 13D + 13G (with passive-giant filter)
//   - Step 3: 8-K (items 1.01, 2.01, 2.02, 5.02, 7.01, 8.01)
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { fetchRecentForm4s } from '@/app/lib/data/sec-monitor'

export const runtime = 'nodejs'
export const maxDuration = 300  // 5 min — well under Railway's HTTP cap

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const header = req.headers.get('authorization')
  return header === `Bearer ${secret}`
}

async function runMonitor(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tStart = Date.now()
  console.log('[sec-monitor] cron run starting')

  // Form 4 polling. Default feedCount=40 covers ~10 minutes of normal
  // filing volume comfortably. Override via ?feedCount=N for catch-up
  // runs if Railway logs ever show the backlog growing.
  const feedCountParam = req.nextUrl.searchParams.get('feedCount')
  const feedCount = feedCountParam ? Math.min(parseInt(feedCountParam, 10) || 40, 100) : 40

  const form4Result = await fetchRecentForm4s(feedCount).catch((e: Error) => ({
    error: e.message,
    scanned: 0, parsed: 0, transactionsSeen: 0, inserted: 0,
    belowThreshold: 0, nonPS: 0, duplicates: 0, errors: 1,
  }))

  // TODO Step 2: const dgResult = await fetchRecent13DG()
  // TODO Step 3: const k8Result = await fetchRecent8Ks()

  const totalDuration = Date.now() - tStart
  console.log(`[sec-monitor] cron run complete in ${totalDuration}ms`)

  return NextResponse.json({
    ok: true,
    durationMs: totalDuration,
    form4: form4Result,
    // dg: dgResult,    // Step 2
    // k8: k8Result,    // Step 3
  })
}

export async function POST(req: NextRequest) {
  return runMonitor(req)
}

export async function GET(req: NextRequest) {
  return runMonitor(req)
}
