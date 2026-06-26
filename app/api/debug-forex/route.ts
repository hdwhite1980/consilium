// =============================================================
// app/api/debug-forex/route.ts
//
// In-app OANDA path test. Proves the whole chain the forex cron/monitor relies
// on: load the stored ENCRYPTED credential -> decrypt -> build the OANDA client
// -> call account summary, pricing, candles, open trades -> and exercise the
// data-layer fetchForexBars the story desk uses for charts.
//
// Each step is independently try/caught so a failure in one is visible without
// hiding the others. The secret is never returned (only a masked key id).
//
// Auth: GET with `Authorization: Bearer ${CRON_SECRET}`.
//   /api/debug-forex
//   /api/debug-forex?instrument=GBP_USD&ticker=GBPUSD&userId=<uuid>
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import { makeOandaClient } from '@/app/lib/trading/oanda-client'
import { fetchForexBars } from '@/app/lib/data/forex'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DEFAULT_USER = '709312ee-df59-47f2-a351-49660142ed77'

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

function mask(s: string): string {
  if (!s || s.length < 8) return '****'
  return s.slice(0, 2) + '*'.repeat(Math.max(4, s.length - 6)) + s.slice(-4)
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized - send Authorization: Bearer <CRON_SECRET>' }, { status: 401 })
  }

  const url = new URL(req.url)
  const userId = url.searchParams.get('userId') ?? DEFAULT_USER
  const instrument = url.searchParams.get('instrument') ?? 'EUR_USD'  // OANDA format (underscore)
  const appTicker = url.searchParams.get('ticker') ?? 'EURUSD'        // app format (concatenated)

  const report: Record<string, unknown> = {
    userId,
    instrument,
    appTicker,
    startedAt: new Date().toISOString(),
  }

  // Step 1: load + decrypt the stored credential
  let keyId = ''
  let secret = ''
  try {
    const cred = await loadBrokerCredentialForUse(userId, 'oanda', 'paper', 'forex')
    if (!cred) {
      report.step1_credential = { ok: false, error: 'no oanda/paper/forex credential found for this user' }
      return NextResponse.json(report, { status: 200 })
    }
    keyId = cred.keyId
    secret = cred.secret
    report.step1_credential = {
      ok: true,
      accountId: keyId,                 // OANDA account id is stored as keyId
      secretDecrypted: secret.length > 0,
      secretMasked: mask(secret),
    }
  } catch (e) {
    report.step1_credential = { ok: false, error: e instanceof Error ? e.message : String(e) }
    return NextResponse.json(report, { status: 200 })
  }

  const oanda = makeOandaClient(keyId, secret, 'paper')

  // Step 2: account summary (balance / margin / funding check)
  try {
    const sum = await oanda.accountSummary()
    report.step2_accountSummary = {
      ok: true,
      currency: sum.currency,
      balance: sum.balance,
      equity: sum.equity,
      unrealizedPL: sum.unrealizedPL,
      marginAvailable: sum.marginAvailable,
      marginUsed: sum.marginUsed,
      openTradeCount: sum.openTradeCount,
      openPositionCount: sum.openPositionCount,
      funded: sum.balance > 0,
    }
  } catch (e) {
    report.step2_accountSummary = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  // Step 3: live pricing (bid/ask/mid)
  try {
    const q = await oanda.priceQuote(instrument)
    report.step3_priceQuote = q
      ? { ok: true, bid: q.bid, ask: q.ask, mid: q.mid, time: q.time }
      : { ok: false, error: 'priceQuote returned null (market closed or bad instrument?)' }
  } catch (e) {
    report.step3_priceQuote = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  // Step 4: candles (raw client, what the monitor reads)
  try {
    const bars = await oanda.candles(instrument, 'M15', 5)
    report.step4_candles_M15 = {
      ok: true,
      count: bars.length,
      first: bars[0] ?? null,
      last: bars[bars.length - 1] ?? null,
      note: bars.length === 0 ? 'empty - market closed (forex shut Fri 5pm-Sun 5pm ET)?' : undefined,
    }
  } catch (e) {
    report.step4_candles_M15 = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  // Step 5: open trades
  try {
    const trades = await oanda.openTrades()
    report.step5_openTrades = {
      ok: true,
      count: trades.length,
      trades: trades.slice(0, 5),
    }
  } catch (e) {
    report.step5_openTrades = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  // Step 6: data-layer fetchForexBars (what the story desk uses)
  try {
    const dayBars = await fetchForexBars(appTicker, '1D')
    report.step6_fetchForexBars_1D = {
      ok: true,
      count: dayBars.length,
      first: dayBars[0] ?? null,
      last: dayBars[dayBars.length - 1] ?? null,
      looksLikeRealOandaData: dayBars.some(b => (b.v ?? 0) > 0),
    }
  } catch (e) {
    report.step6_fetchForexBars_1D = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  report.finishedAt = new Date().toISOString()
  return NextResponse.json(report, { status: 200 })
}
