// =============================================================
// app/api/cron/day-shark-monitor/route.ts
//
// Max's exit discipline — MULTI-ASSET. Owns day_shark exits EXCLUSIVELY for
// every asset (slow monitors are patched to skip signal_source='day_shark').
//
//   crypto → price via Coinbase spot / Alpaca; close via client.closePosition.
//   stock  → price via Alpaca position; close via alpaca.closePosition. Acts
//            only while the market is open (fractional positions can't trade
//            after hours).
//   forex  → OANDA holds native TP/SL as a broker-side backstop; this monitor
//            still independently checks and applies EOD cut/ride + max-hold,
//            closing via oanda.closePosition. Direction-aware (forex can short).
//
// Rules, priority order, per open position (direction-aware via side):
//   1. stop hit            → CLOSE (loss). 2. target hit → CLOSE (win).
//   3. age ≥ MAX_HOLD      → CLOSE (force). 4. ?eod=1: up≥RIDE → ride, else CLOSE.
//   5. else HOLD.
//
// Auth: Bearer ${CRON_SECRET}  ?asset=stock|crypto|forex|all (default crypto)
//   &userId=<uuid>  &eod=1  &dryRun=1
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { listEnabledTradingUsers, type UserTradingSettings } from '@/app/lib/trading/settings'
import { selectCryptoBroker } from '@/app/lib/trading/crypto-broker'
import { allocationPctFor } from '@/app/lib/trading/day-shark-budget'
import { maxNarration, type MaxEvent, type SharkAsset } from '@/app/lib/trading/day-shark'
import { makeAlpacaClient } from '@/app/lib/trading/alpaca-client'
import { makeOandaClient } from '@/app/lib/trading/oanda-client'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import type { CoinbaseClient } from '@/app/lib/trading/coinbase-client'
import type { AlpacaCryptoClient } from '@/app/lib/trading/alpaca-crypto-client'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MAX_HOLD_HOURS = 30

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
  side: string | null
  qty: number | null
  entry_price_est: number | null
  filled_avg_price: number | null
  stop_price: number | null
  target_price: number | null
  created_at: string
}

async function loadOpen(userId: string, asset: SharkAsset): Promise<OpenPos[]> {
  const { data } = await admin()
    .from('trade_attempts')
    .select('id, ticker, side, qty, entry_price_est, filled_avg_price, stop_price, target_price, created_at')
    .eq('user_id', userId)
    .eq('asset_class', asset)
    .eq('signal_source', 'day_shark')
    .in('outcome', ['placed', 'filled', 'partial_fill'])
  return (data ?? []) as OpenPos[]
}

interface MonLane {
  price: (ticker: string) => Promise<number | null>
  close: (ticker: string, side: 'buy' | 'sell') => Promise<void>
}

async function setupMonLane(settings: UserTradingSettings, asset: SharkAsset): Promise<MonLane | { error: string }> {
  if (asset === 'crypto') {
    const broker = await selectCryptoBroker(settings)
    if (!broker) return { error: 'no crypto broker' }
    return {
      price: async (ticker) => {
        if (broker.kind === 'coinbase') return await (broker.client as CoinbaseClient).getSpotPrice(ticker).catch(() => null)
        try {
          const ps = await (broker.client as AlpacaCryptoClient).positions()
          return ps.find(x => x.symbol === ticker)?.current_price ?? null
        } catch { return null }
      },
      close: async (ticker) => {
        if (broker.kind === 'coinbase') await (broker.client as CoinbaseClient).closePosition(ticker)
        else await (broker.client as AlpacaCryptoClient).closePosition(ticker)
      },
    }
  }

  if (asset === 'stock') {
    const cred = await loadBrokerCredentialForUse(settings.userId, 'alpaca', settings.mode, 'stock')
    if (!cred) return { error: 'no alpaca stock broker' }
    const alpaca = makeAlpacaClient(cred.keyId, cred.secret, settings.mode)
    const clock = await alpaca.getClock()
    if (!clock.isOpen) return { error: 'market closed' }   // can't price/flatten after hours
    return {
      price: async (ticker) => {
        try {
          const ps = await alpaca.positions()
          return ps.find(p => p.symbol === ticker)?.current_price ?? null
        } catch { return null }
      },
      close: async (ticker) => { await alpaca.closePosition(ticker) },
    }
  }

  // forex
  const cred = await loadBrokerCredentialForUse(settings.userId, 'oanda', settings.mode, 'forex')
  if (!cred) return { error: 'no oanda broker' }
  const oanda = makeOandaClient(cred.keyId, cred.secret, settings.mode)
  return {
    price: async (instrument) => {
      const q = await oanda.priceQuote(instrument).catch(() => null)
      return q?.mid ?? null
    },
    close: async (instrument, side) => { await oanda.closePosition(instrument, side === 'sell' ? 'short' : 'long') },
  }
}

async function runUser(settings: UserTradingSettings, asset: SharkAsset, isEod: boolean, dryRun: boolean) {
  const r = { asset, open: 0, closed: 0, ridden: 0, held: 0, noPrice: 0, notes: [] as string[] }
  if (allocationPctFor(settings, asset) <= 0) return r

  const lane = await setupMonLane(settings, asset)
  if ('error' in lane) { if (asset !== 'crypto') r.notes.push(lane.error); return r }

  const positions = await loadOpen(settings.userId, asset)
  r.open = positions.length
  const now = Date.now()
  const say = (event: MaxEvent, ticker: string, gp: number) => r.notes.push(maxNarration({ event, ticker, gainPct: gp }))

  for (const pos of positions) {
    const entry = pos.filled_avg_price ?? pos.entry_price_est
    if (!entry || entry <= 0) { r.held++; continue }
    const price = await lane.price(pos.ticker)
    if (price === null || price <= 0) { r.noPrice++; r.notes.push(`${pos.ticker}: no price`); continue }

    const isLong = pos.side !== 'sell'
    const side: 'buy' | 'sell' = isLong ? 'buy' : 'sell'
    const ageHours = (now - new Date(pos.created_at).getTime()) / 3_600_000
    const gainPct = isLong ? (price - entry) / entry : (entry - price) / entry
    const stopHit = pos.stop_price != null && (isLong ? price <= pos.stop_price : price >= pos.stop_price)
    const targetHit = pos.target_price != null && (isLong ? price >= pos.target_price : price <= pos.target_price)

    const doClose = async (reason: string, event: MaxEvent) => {
      const win = gainPct >= 0
      const qty = pos.qty != null ? Number(pos.qty) : 0
      const realizedPnl = qty > 0 ? Number((gainPct * entry * qty).toFixed(2)) : null
      if (!dryRun) {
        await lane.close(pos.ticker, side)
        await admin().from('trade_attempts').update({
          outcome: win ? 'closed_win' : 'closed_loss',
          exit_price: price, realized_pnl: realizedPnl,
          closure_kind: win ? 'target_hit' : 'stop_fired',
          closed_at: new Date().toISOString(),
        }).eq('id', pos.id)
      }
      say(event, pos.ticker, gainPct); r.closed++
      console.log(`[day-shark-monitor:${asset}] CLOSE ${pos.ticker} @ ${price} (${reason}, ${win ? 'WIN' : 'LOSS'})${dryRun ? ' [dry]' : ''}`)
    }

    if (stopHit) { await doClose('stop', 'stop'); continue }
    if (targetHit) { await doClose('target', 'target'); continue }
    if (ageHours >= MAX_HOLD_HOURS) { await doClose('max_hold', 'max_hold'); continue }
    if (isEod) {
      // Strict day-trade discipline: flatten ALL stock positions at the close —
      // no overnight ride (gap risk + no working stop after hours, and multi-day
      // holds are the council swing lane's job, not the shark's). Crypto (24/7)
      // and forex (24/5) have no EOD; they keep running on stop/target/max-hold.
      if (asset === 'stock') { await doClose('eod_flat', 'eod_cut') }
      else { r.held++ }
      continue
    }
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
  const assetParam = (url.searchParams.get('asset') ?? 'crypto').toLowerCase()
  const assets: SharkAsset[] = assetParam === 'all' ? ['stock', 'crypto', 'forex']
    : (['stock', 'crypto', 'forex'] as SharkAsset[]).includes(assetParam as SharkAsset) ? [assetParam as SharkAsset]
    : ['crypto']

  const users = (await listEnabledTradingUsers()).filter(s => !onlyUser || s.userId === onlyUser)
  const summary = { mode: isEod ? 'eod-checkpoint' : 'intraday', assets, users: users.length, closed: 0, ridden: 0, perUser: [] as unknown[] }
  for (const settings of users) {
    for (const asset of assets) {
      try {
        const ur = await runUser(settings, asset, isEod, dryRun)
        summary.closed += ur.closed; summary.ridden += ur.ridden
        summary.perUser.push({ userId: settings.userId, ...ur })
      } catch (e) {
        summary.perUser.push({ userId: settings.userId, asset, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  return NextResponse.json({ ok: true, ...summary })
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }
