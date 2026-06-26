// =============================================================
// app/api/cron/crypto-accumulation-trade/route.ts
//
// Accumulation -> Council -> trade lane. The counterpart to crypto-scanner-trade,
// but sourced from the weekly accumulation scan instead of the 24h momentum scan.
//
// Flow (identical downstream to the momentum lane):
//   1. Read fresh accumulation coils from crypto_accumulation_scan
//   2. Gate: phase=accumulation + bullish + strength>=MIN + has_history
//      (a coil is consolidating, so it CAN'T pass the momentum scanner's
//       BULLISH-breakout/RSI gate — that's exactly why it needs its own lane)
//   3. Dedup against tickers analyzed in the last 4h
//   4. POST top picks to /api/analyze -> Council issues TAKE/PASS/WAIT
//   5. The existing auto-trade-crypto cron executes the TAKE verdicts
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//   ?minStrength=50 &limit=6 &userId=<uuid> &maxAgeHours=24
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const DEFAULT_USER = '709312ee-df59-47f2-a351-49660142ed77'
const DEFAULT_MIN_STRENGTH = 50
const DEFAULT_LIMIT = 6
const DEDUP_HOURS = 4

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`
}

function getAdmin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// Council/ticker-gate canonical crypto form is concatenated BASE+USD (no hyphen).
function toCouncilSymbol(symbolOrBase: string): string {
  const base = (symbolOrBase.split('-')[0] ?? symbolOrBase).toUpperCase()
  return `${base}USD`
}

async function getRecentlyAnalyzed(userId: string, hours: number): Promise<Set<string>> {
  const admin = getAdmin()
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
  const { data } = await admin
    .from('verdict_log').select('ticker')
    .eq('user_id', userId).gte('created_at', cutoff)
  return new Set((data as Array<{ ticker: string }> ?? []).map(r => r.ticker.toUpperCase()))
}

async function triggerAnalyze(userId: string, ticker: string): Promise<boolean> {
  const rawBase = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '')
  if (!rawBase) { console.warn('[crypto-accum-trade] APP_BASE_URL not set'); return false }
  const baseUrl = /^https?:\/\//.test(rawBase) ? rawBase : `https://${rawBase}`
  try {
    const res = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Trigger': 'crypto-accumulation-trade',
        'X-Service-User-Id': userId,
        'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
      },
      body: JSON.stringify({ ticker, userId, source: 'crypto_accumulation', timeframe: '1D', persona: 'balanced' }),
      signal: AbortSignal.timeout(90_000),
    })
    return res.ok
  } catch (e) {
    console.warn(`[crypto-accum-trade] analyze trigger failed for ${ticker}:`, e instanceof Error ? e.message : e)
    return false
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }

async function run(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const userId = url.searchParams.get('userId') ?? DEFAULT_USER
  const minStrength = Number(url.searchParams.get('minStrength') ?? DEFAULT_MIN_STRENGTH)
  const limit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const maxAgeHours = Number(url.searchParams.get('maxAgeHours') ?? '24')
  const dryRun = url.searchParams.get('dryRun') === '1'

  const admin = getAdmin()
  const freshCutoff = new Date(Date.now() - maxAgeHours * 3_600_000).toISOString()

  // Candidate coils: bullish accumulation, real history, scanned recently.
  const { data: coils, error } = await admin
    .from('crypto_accumulation_scan')
    .select('symbol, base_symbol, band, strength, phase, bias, has_history, scanned_at')
    .eq('phase', 'accumulation')
    .eq('bias', 'bullish')
    .eq('has_history', true)
    .gte('strength', minStrength)
    .gte('scanned_at', freshCutoff)
    .order('strength', { ascending: false })
    .limit(limit * 3)  // over-fetch; dedup trims below

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const recentlyAnalyzed = await getRecentlyAnalyzed(userId, DEDUP_HOURS)

  const selected: Array<{ base: string; council: string; strength: number; band: string }> = []
  for (const c of (coils ?? [])) {
    const council = toCouncilSymbol(c.base_symbol ?? c.symbol)
    if (recentlyAnalyzed.has(council)) continue
    if (selected.some(s => s.council === council)) continue
    selected.push({ base: c.base_symbol ?? c.symbol, council, strength: c.strength, band: c.band })
    if (selected.length >= limit) break
  }

  const triggered: string[] = []
  const failed: string[] = []
  if (!dryRun) {
    for (const s of selected) {
      const ok = await triggerAnalyze(userId, s.council)
      if (ok) triggered.push(s.council); else failed.push(s.council)
    }
  }

  console.log(`[crypto-accum-trade] candidates=${selected.length} triggered=${triggered.length} failed=${failed.length}${dryRun ? ' (dryRun)' : ''}`)

  return NextResponse.json({
    userId,
    minStrength,
    candidatesConsidered: coils?.length ?? 0,
    selected: selected.map(s => ({ ticker: s.council, base: s.base, strength: s.strength, band: s.band })),
    triggered,
    failed,
    dryRun,
    note: 'Triggered coils now flow through the Council; auto-trade-crypto executes any TAKE verdicts.',
  }, { status: 200 })
}
