// =============================================================
// app/api/cron/day-shark-monitor/route.ts
//
// Max's exit discipline (Phase 3). Owns day_shark crypto exits EXCLUSIVELY —
// the slow crypto-position-monitor is patched to skip signal_source='day_shark'
// so the two never fight over the same position.
//
// Run on TWO schedules:
//   • frequent (every ~10-15m, no flag): enforces hard stop, target, max-hold.
//   • daily checkpoint (once/day, ?eod=1): the EOD rule — cut losers/flat,
//     let confirmed winners ride one more cycle (capped by max-hold).
//
// Max's rules, in priority order, per open position:
//   1. hard stop hit            → CLOSE (loss). Cut losers instantly.
//   2. target hit               → CLOSE (win).  Bank gains fast.
//   3. age ≥ MAX_HOLD_HOURS     → CLOSE (force). It rode its night; it's a
//                                  day trade, not an investment.
//   4. ?eod=1 checkpoint:
//        • up ≥ RIDE_THRESHOLD  → RIDE (hold, stop stays). Winner earns a night.
//        • otherwise            → CLOSE. Losers and flats don't sleep over.
//   5. else                     → HOLD (stop/target already enforced above).
//
// Auth: Authorization: Bearer ${CRON_SECRET}   ?userId=<uuid>  &eod=1  &dryRun=1
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { listEnabledTradingUsers, type UserTradingSettings } from '@/app/lib/trading/settings'
import { selectCryptoBroker } from '@/app/lib/trading/crypto-broker'
import { allocationPctFor } from '@/app/lib/trading/day-shark-budget'
import type { CoinbaseClient } from '@/app/lib/trading/coinbase-client'
import type { AlpacaCryptoClient } from '@/app/lib/trading/alpaca-crypto-client'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MAX_HOLD_HOURS = 30      // rode one night → force out (day trade ceiling)
const RIDE_THRESHOLD = 0.02    // up ≥ +2% at checkpoint = "confirmed winner" → may sleep over

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}
function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

interface OpenPos {
  id: number
  ticker: string
  qty: number | null
  entry_price_est: number | null
  filled_avg_price: number | null
  stop_price: number | null
  target_price: number | null
  created_at: string
}

async function loadOpen(userId: string): Promise<OpenPos[]> {
  const { data } = await admin()
    .from('trade_attempts')
    .select('id, ticker, qty, entry_price_est, filled_avg_price, stop_price, target_price, created_at')
    .eq('user_id', userId)
    .eq('asset_class', 'crypto')
    .eq('signal_source', 'day_shark')
    .in('outcome', ['placed', 'filled', 'partial_fill'])
  return (data ?? []) as OpenPos[]
}

async function getPrice(broker: Awaited<ReturnType<typeof selectCryptoBroker>>, ticker: string): Promise<number | null> {
  if (!broker) return null
  if (broker.kind === 'coinbase') {
    return await (broker.client as CoinbaseClient).getSpotPrice(ticker).catch(() => null)
  }
  try {
    const positions = await (broker.client as AlpacaCryptoClient).positions()
    const p = positions.find(x => x.symbol === ticker)
    return p?.current_price ?? null
  } catch { return null }
}

async function closeOut(
  broker: NonNullable<Awaited<ReturnType<typeof selectCryptoBroker>>>,
  pos: OpenPos, price: number, entry: number, reason: string, dryRun: boolean,
): Promise<'win' | 'loss'> {
  const win = price >= entry
  const outcome = win ? 'closed_win' : 'closed_loss'
  if (!dryRun) {
    if (broker.kind === 'coinbase') await (broker.client as CoinbaseClient).closePosition(pos.ticker)
    else await (broker.client as AlpacaCryptoClient).closePosition(pos.ticker)
    const qty = pos.qty !== null && pos.qty !== undefined ? Number(pos.qty) : 0
    const realizedPnl = qty > 0 ? Number(((price - entry) * qty).toFixed(2)) : null
    await admin().from('trade_attempts').update({
      outcome,
      exit_price: price,
      realized_pnl: realizedPnl,
      closure_kind: win ? 'target_hit' : 'stop_fired',
      closed_at: new Date().toISOString(),
    }).eq('id', pos.id)
  }
  console.log(`[day-shark-monitor] CLOSE ${pos.ticker} @ ${price} (${reason}, ${win ? 'WIN' : 'LOSS'})${dryRun ? ' [dry]' : ''}`)
  return win ? 'win' : 'loss'
}

async function runUser(settings: UserTradingSettings, isEod: boolean, dryRun: boolean) {
  const r = { open: 0, closed: 0, ridden: 0, held: 0, noPrice: 0, notes: [] as string[] }
  if (allocationPctFor(settings, 'crypto') <= 0) return r

  const broker = await selectCryptoBroker(settings)
  if (!broker) return r

  const positions = await loadOpen(settings.userId)
  r.open = positions.length
  const now = Date.now()

  for (const pos of positions) {
    const entry = pos.filled_avg_price ?? pos.entry_price_est
    if (!entry || entry <= 0) { r.held++; continue }
    const price = await getPrice(broker, pos.ticker)
    if (price === null || price <= 0) { r.noPrice++; r.notes.push(`${pos.ticker}: no price`); continue }

    const ageHours = (now - new Date(pos.created_at).getTime()) / 3_600_000
    const gainPct = (price - entry) / entry

    // 1. hard stop
    if (pos.stop_price && price <= pos.stop_price) {
      await closeOut(broker, pos, price, entry, 'stop', dryRun); r.closed++; continue
    }
    // 2. target
    if (pos.target_price && price >= pos.target_price) {
      await closeOut(broker, pos, price, entry, 'target', dryRun); r.closed++; continue
    }
    // 3. max hold — rode its night, force out
    if (ageHours >= MAX_HOLD_HOURS) {
      await closeOut(broker, pos, price, entry, 'max_hold', dryRun); r.closed++; continue
    }
    // 4. EOD checkpoint
    if (isEod) {
      if (gainPct >= RIDE_THRESHOLD) {
        r.ridden++; r.notes.push(`${pos.ticker}: rides (+${(gainPct * 100).toFixed(1)}%)`)
      } else {
        await closeOut(broker, pos, price, entry, 'eod_flat', dryRun); r.closed++
      }
      continue
    }
    // 5. intraday hold
    r.held++
  }
  return r
}

async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const onlyUser = url.searchParams.get('userId')
  const isEod = url.searchParams.get('eod') === '1'
  const dryRun = url.searchParams.get('dryRun') === '1'

  const users = (await listEnabledTradingUsers()).filter(s => !onlyUser || s.userId === onlyUser)
  const summary = { mode: isEod ? 'eod-checkpoint' : 'intraday', users: users.length, closed: 0, ridden: 0, perUser: [] as unknown[] }
  for (const settings of users) {
    try {
      const ur = await runUser(settings, isEod, dryRun)
      summary.closed += ur.closed; summary.ridden += ur.ridden
      summary.perUser.push({ userId: settings.userId, ...ur })
    } catch (e) {
      summary.perUser.push({ userId: settings.userId, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return NextResponse.json({ ok: true, ...summary })
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }
