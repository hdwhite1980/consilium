// =============================================================
// app/lib/signals/weekly-trend.ts
//
// Weekly-bar trend & accumulation/distribution analyzer. Shared engine for
// crypto, stocks, and futures-proxies (anything with REAL volume). It answers
// "what is the longer trend, and is volume building under the surface while
// price consolidates" — the POL-style coiling setup the 24h scanner misses.
//
// Design principles:
//  - Deterministic & explainable. Every read comes with the sub-metrics and a
//    human-readable note, so it can be verified by eye and fed to the Council.
//  - Honest about direction. Rising volume during consolidation means a move is
//    building, but it resolves up (accumulation) OR down (distribution). We lean
//    on where weekly closes sit in their range (effort vs. result / Wyckoff),
//    but we DAMP confidence for coiling reads — this is a discovery & timing
//    signal, not a directional oracle.
//  - FOREX EXCLUDED. OANDA "volume" is tick count, not market volume, so this
//    engine is unreliable for FX. Forex uses a COT-positioning analog instead.
// =============================================================

import type { Bar } from '@/app/lib/signals/technicals'

export interface WeeklyTrendAnalysis {
  ok: boolean
  reason?: string                  // populated when ok=false (e.g. not enough data)
  weeksAnalyzed: number

  // Trend
  priceChangePctWindow: number     // % over the full analyzed window
  priceChangePctRecent: number     // % over the last ~4 weeks
  trend: 'up' | 'down' | 'sideways'

  // Volume
  volumeTrendPct: number           // recent-half vs older-half avg weekly volume, %
  volumeTrend: 'rising' | 'falling' | 'flat'

  // Structure
  rangeContractionPct: number      // recent vs prior weekly range, % (negative = tightening/coiling)
  isConsolidating: boolean
  closePositionAvg: number         // 0..1: where recent weekly closes sit in their H-L range

  // Read
  phase: 'accumulation' | 'distribution' | 'markup' | 'markdown' | 'neutral'
  bias: 'bullish' | 'bearish' | 'neutral'
  strength: number                 // 0..100 confidence in the read (damped for coiling)
  notes: string[]
}

export interface WeeklyTrendOptions {
  maxWeeks?: number                // analysis window, default 26
  trendPctThreshold?: number       // |window %| above which trend is up/down, default 8
  volumeTrendThreshold?: number    // |volume %| above which volume is rising/falling, default 15
}

// ── ISO week key (year + week number), so daily bars group Mon–Sun ──
function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** Aggregate daily bars into weekly OHLCV bars (chronological). */
export function aggregateDailyToWeekly(daily: Bar[]): Bar[] {
  if (!daily?.length) return []
  const sorted = [...daily].sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
  const byWeek = new Map<string, Bar[]>()
  for (const bar of sorted) {
    const key = isoWeekKey(new Date(bar.t))
    const arr = byWeek.get(key)
    if (arr) arr.push(bar); else byWeek.set(key, [bar])
  }
  const weeks: Bar[] = []
  for (const [, bars] of byWeek) {
    weeks.push({
      t: bars[0].t,
      o: bars[0].o,
      h: Math.max(...bars.map(b => b.h)),
      l: Math.min(...bars.map(b => b.l)),
      c: bars[bars.length - 1].c,
      v: bars.reduce((s, b) => s + (b.v ?? 0), 0),
    })
  }
  return weeks
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0
}

/** Pure analysis over daily bars. */
export function analyzeWeeklyTrend(daily: Bar[], opts: WeeklyTrendOptions = {}): WeeklyTrendAnalysis {
  const maxWeeks = opts.maxWeeks ?? 26
  const trendThr = opts.trendPctThreshold ?? 8
  const volThr = opts.volumeTrendThreshold ?? 15

  const empty: WeeklyTrendAnalysis = {
    ok: false, weeksAnalyzed: 0,
    priceChangePctWindow: 0, priceChangePctRecent: 0, trend: 'sideways',
    volumeTrendPct: 0, volumeTrend: 'flat',
    rangeContractionPct: 0, isConsolidating: false, closePositionAvg: 0.5,
    phase: 'neutral', bias: 'neutral', strength: 0, notes: [],
  }

  const allWeeks = aggregateDailyToWeekly(daily)
  if (allWeeks.length < 8) {
    return { ...empty, reason: `need >=8 weekly bars, got ${allWeeks.length}` }
  }
  const weeks = allWeeks.slice(-maxWeeks)
  const n = weeks.length

  // Trend
  const firstClose = weeks[0].c
  const lastClose = weeks[n - 1].c
  const priceChangePctWindow = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0
  const recentN = Math.min(4, n)
  const recentStartClose = weeks[n - recentN].c
  const priceChangePctRecent = recentStartClose > 0 ? ((lastClose - recentStartClose) / recentStartClose) * 100 : 0
  const trend: WeeklyTrendAnalysis['trend'] =
    priceChangePctWindow > trendThr ? 'up' : priceChangePctWindow < -trendThr ? 'down' : 'sideways'

  // Volume: recent half vs older half
  const half = Math.floor(n / 2)
  const olderVolAvg = avg(weeks.slice(0, half).map(w => w.v))
  const recentVolAvg = avg(weeks.slice(half).map(w => w.v))
  const volumeTrendPct = olderVolAvg > 0 ? ((recentVolAvg - olderVolAvg) / olderVolAvg) * 100 : 0
  const volumeTrend: WeeklyTrendAnalysis['volumeTrend'] =
    volumeTrendPct > volThr ? 'rising' : volumeTrendPct < -volThr ? 'falling' : 'flat'

  // Structure: weekly range % (high-low over close), recent vs prior
  const rangePct = (w: Bar) => (w.c > 0 ? ((w.h - w.l) / w.c) * 100 : 0)
  const recentRange = avg(weeks.slice(-recentN).map(rangePct))
  const priorRange = avg(weeks.slice(0, Math.max(1, n - recentN)).map(rangePct))
  const rangeContractionPct = priorRange > 0 ? ((recentRange - priorRange) / priorRange) * 100 : 0

  // Where recent weekly closes sit in their H-L range (0=low, 1=high)
  const closePos = (w: Bar) => (w.h > w.l ? (w.c - w.l) / (w.h - w.l) : 0.5)
  const closePositionAvg = avg(weeks.slice(-Math.min(6, n)).map(closePos))

  const isConsolidating = Math.abs(priceChangePctRecent) < 6 && rangeContractionPct <= 5

  // ── Read: classify the phase ──
  let phase: WeeklyTrendAnalysis['phase'] = 'neutral'
  let bias: WeeklyTrendAnalysis['bias'] = 'neutral'
  const notes: string[] = []

  if (trend === 'up' && priceChangePctRecent >= -2) {
    phase = 'markup'; bias = 'bullish'
    notes.push(`Uptrend: +${priceChangePctWindow.toFixed(1)}% over ${n} wks, still advancing.`)
  } else if (trend === 'down' && priceChangePctRecent <= 2) {
    phase = 'markdown'; bias = 'bearish'
    notes.push(`Downtrend: ${priceChangePctWindow.toFixed(1)}% over ${n} wks, still declining.`)
  } else if (isConsolidating && volumeTrend === 'rising') {
    // Coiling with building volume — direction from close position (effort vs result)
    if (closePositionAvg >= 0.55) {
      phase = 'accumulation'; bias = 'bullish'
      notes.push(`Coiling: volume rising ${volumeTrendPct >= 0 ? '+' : ''}${volumeTrendPct.toFixed(0)}% while price flat (${priceChangePctRecent.toFixed(1)}% / 4wk); closes in upper range (${closePositionAvg.toFixed(2)}) -> accumulation lean.`)
    } else if (closePositionAvg <= 0.45) {
      phase = 'distribution'; bias = 'bearish'
      notes.push(`Coiling: volume rising ${volumeTrendPct >= 0 ? '+' : ''}${volumeTrendPct.toFixed(0)}% while price flat (${priceChangePctRecent.toFixed(1)}% / 4wk); closes in lower range (${closePositionAvg.toFixed(2)}) -> distribution lean.`)
    } else {
      phase = 'neutral'; bias = 'neutral'
      notes.push(`Coiling: volume rising ${volumeTrendPct.toFixed(0)}% but closes mid-range (${closePositionAvg.toFixed(2)}) -> move building, direction unresolved.`)
    }
  } else {
    notes.push(`No strong weekly signal: trend ${trend}, volume ${volumeTrend}.`)
  }

  // ── Strength: weight volume trend, range contraction, close conviction, trend ──
  let strength = 0
  strength += Math.min(35, Math.abs(volumeTrendPct) * 0.7)          // volume conviction
  strength += Math.min(20, Math.max(0, -rangeContractionPct) * 0.5) // tightening adds (coil)
  strength += Math.min(25, Math.abs(closePositionAvg - 0.5) * 80)   // close-position conviction
  strength += Math.min(20, Math.abs(priceChangePctWindow) * 0.4)    // trend magnitude
  strength = Math.round(Math.max(0, Math.min(100, strength)))
  // Damp coiling reads — a move is building but direction is genuinely uncertain
  if (phase === 'accumulation' || phase === 'distribution') strength = Math.round(strength * 0.8)
  if (phase === 'neutral') strength = Math.min(strength, 40)

  notes.push(`Range ${rangeContractionPct <= 0 ? 'tightening' : 'expanding'} ${rangeContractionPct.toFixed(0)}%, weekly volume ${volumeTrend}.`)

  return {
    ok: true,
    weeksAnalyzed: n,
    priceChangePctWindow: Math.round(priceChangePctWindow * 100) / 100,
    priceChangePctRecent: Math.round(priceChangePctRecent * 100) / 100,
    trend,
    volumeTrendPct: Math.round(volumeTrendPct * 100) / 100,
    volumeTrend,
    rangeContractionPct: Math.round(rangeContractionPct * 100) / 100,
    isConsolidating,
    closePositionAvg: Math.round(closePositionAvg * 1000) / 1000,
    phase, bias, strength, notes,
  }
}

// ── Fetch adapter: pull daily bars for any class and analyze ──
export type WeeklyTrendAssetType = 'stock' | 'crypto' | 'futures' | 'forex'

export async function getWeeklyTrend(
  ticker: string,
  assetType: WeeklyTrendAssetType,
  opts: WeeklyTrendOptions = {},
): Promise<WeeklyTrendAnalysis> {
  const base: WeeklyTrendAnalysis = {
    ok: false, weeksAnalyzed: 0,
    priceChangePctWindow: 0, priceChangePctRecent: 0, trend: 'sideways',
    volumeTrendPct: 0, volumeTrend: 'flat',
    rangeContractionPct: 0, isConsolidating: false, closePositionAvg: 0.5,
    phase: 'neutral', bias: 'neutral', strength: 0, notes: [],
  }

  if (assetType === 'forex') {
    return { ...base, reason: 'forex has no real volume (OANDA volume is tick count) — use the COT positioning analyzer instead' }
  }

  try {
    let daily: Bar[]
    if (assetType === 'crypto') {
      const { fetchCryptoBars } = await import('@/app/lib/trading/crypto-bars')
      const sym = ticker.includes('-') ? ticker : `${ticker.toUpperCase()}-USD`
      daily = await fetchCryptoBars({ symbol: sym, granularity: 'ONE_DAY', limit: 200 })
    } else {
      // stock + futures-proxy (SPY/QQQ/...) both use the equity bar feed.
      // '1M' maps to 1Day bars over ~500 days (~70 weeks) — the right lens for
      // weekly aggregation. ('1D' is intraday 15-min and far too short.)
      const { fetchBars } = await import('@/app/lib/data/alpaca')
      daily = (await fetchBars(ticker.toUpperCase(), '1M')) as unknown as Bar[]
    }
    if (!daily?.length) return { ...base, reason: 'no bars returned' }
    return analyzeWeeklyTrend(daily, opts)
  } catch (e) {
    return { ...base, reason: e instanceof Error ? e.message : String(e) }
  }
}

// =============================================================
// Accumulation discovery scan (crypto).
//
// Reuses the existing momentum scanner's universe with the 24h movement floor
// set to 0 — so it sees the quiet-but-liquid coins the momentum scan drops —
// then runs the weekly-trend engine on the most liquid of them and returns the
// ones reading accumulation/distribution. This is the POL-style lane: it does
// NOT modify runCryptoScan, it sits alongside it.
// =============================================================

export interface AccumulationPick {
  symbol: string
  baseSymbol: string
  price: number
  volumeUsd24h: number
  priceChange24h: number
  weekly: WeeklyTrendAnalysis
}

/** Map with bounded concurrency so we don't burst Coinbase's rate limit. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function runAccumulationScan(opts?: {
  minVolumeUsd?: number      // liquidity floor, default 0 (NO floor — see every coin)
  maxVolumeUsd?: number      // upper band cap (exclusive); omit for no cap
  universeLimit?: number     // cap on weekly-bar fetches (cost control), default 120
  minStrength?: number       // default 45
  phases?: Array<WeeklyTrendAnalysis['phase']>  // default accumulation + distribution
}): Promise<{
  picks: AccumulationPick[]
  scanned: number
  universeSize: number
  scannedReads: Array<{ symbol: string; phase: WeeklyTrendAnalysis['phase']; bias: WeeklyTrendAnalysis['bias']; strength: number; ok: boolean; isNew: boolean; price: number; volumeUsd24h: number; priceChange24h: number; note: string | null }>
  newCoins: Array<{ symbol: string; priceChange24h: number; volumeUsd24h: number }>
}> {
  const { runCryptoScan } = await import('@/app/lib/trading/crypto-scanner')
  const minVolumeUsd = opts?.minVolumeUsd ?? 0          // no floor by default
  const maxVolumeUsd = opts?.maxVolumeUsd               // optional upper band cap
  const universeLimit = opts?.universeLimit ?? 120
  const minStrength = opts?.minStrength ?? 45
  const phases = opts?.phases ?? ['accumulation', 'distribution']

  // movement floor 0 + volume floor 0 -> the FULL liquid+illiquid universe,
  // including brand-new listings the momentum scan never surfaces.
  const scanRaw = await runCryptoScan({ minMovement: 0, minVolume: minVolumeUsd, limit: 500 })
  // Apply the upper band cap (runCryptoScan only floors, doesn't cap).
  const universe = maxVolumeUsd != null
    ? scanRaw.picks.filter(c => c.volumeUsd24h < maxVolumeUsd)
    : scanRaw.picks
  const scan = { ...scanRaw, picks: universe }

  // New listings: surface them explicitly even though they lack the >=8 weeks
  // of history the weekly engine needs — visibility is the point.
  const newCoins = scan.picks
    .filter(c => c.isNew)
    .map(c => ({
      symbol: c.baseDisplaySymbol ?? c.symbol.replace('-USD', ''),
      priceChange24h: c.priceChange24h,
      volumeUsd24h: Math.round(c.volumeUsd24h),
    }))

  // Candidates for weekly analysis: highest-volume first (cost cap), but always
  // fold in every new coin so nothing new is dropped by the cap.
  const byVol = [...scan.picks].sort((a, b) => b.volumeUsd24h - a.volumeUsd24h)
  const seen = new Set<string>()
  const candidates: typeof scan.picks = []
  for (const c of byVol) {
    if (candidates.length >= universeLimit) break
    if (seen.has(c.symbol)) continue
    seen.add(c.symbol); candidates.push(c)
  }
  for (const c of scan.picks) {
    if (c.isNew && !seen.has(c.symbol)) { seen.add(c.symbol); candidates.push(c) }
  }

  // Bounded concurrency (8) to respect rate limits across the wide universe.
  const analyzed = await mapLimited(candidates, 8, async (c) => {
    const weekly = await getWeeklyTrend(c.symbol, 'crypto')
    return { c, weekly }
  })

  const scannedReads = analyzed.map(({ c, weekly }) => ({
    symbol: c.baseDisplaySymbol ?? c.symbol.replace('-USD', ''),
    phase: weekly.phase, bias: weekly.bias, strength: weekly.strength, ok: weekly.ok,
    isNew: c.isNew, price: c.price, volumeUsd24h: Math.round(c.volumeUsd24h),
    priceChange24h: c.priceChange24h, note: weekly.notes[0] ?? null,
  }))

  const picks: AccumulationPick[] = analyzed
    .filter(({ weekly }) => weekly.ok && phases.includes(weekly.phase) && weekly.strength >= minStrength)
    .map(({ c, weekly }) => ({
      symbol: c.symbol,
      baseSymbol: c.baseDisplaySymbol ?? c.symbol.replace('-USD', ''),
      price: c.price,
      volumeUsd24h: c.volumeUsd24h,
      priceChange24h: c.priceChange24h,
      weekly,
    }))
    .sort((a, b) => b.weekly.strength - a.weekly.strength)

  return { picks, scanned: candidates.length, universeSize: scan.universeSize, scannedReads, newCoins }
}

// ─────────────────────────────────────────────────────────────
// Stock accumulation scan — the equity counterpart. Runs the SAME weekly-trend
// engine over the curated liquid stock universe (not crypto). Validated by the
// out-of-sample backtest as the asset class where this signal actually has edge.
// Scans a slice of the universe (offset/limit) so several schedules can cover it
// without any one call timing out.
// ─────────────────────────────────────────────────────────────
export interface StockAccumulationRead {
  symbol: string
  phase: WeeklyTrendAnalysis['phase']
  bias: WeeklyTrendAnalysis['bias']
  strength: number
  ok: boolean
  priceChangeRecentPct: number
  cap: string
  sector: string
  note: string | null
}

export async function runStockAccumulationScan(opts?: {
  tickers?: string[]
  offset?: number
  limit?: number
  concurrency?: number
}): Promise<{ scanned: number; reads: StockAccumulationRead[] }> {
  const { getAllUniverseTickers, getUniverseEntry } = await import('@/app/lib/scanner-universe')
  const all = opts?.tickers ?? getAllUniverseTickers()
  const offset = Math.max(0, opts?.offset ?? 0)
  const limit = opts?.limit ?? all.length
  const slice = all.slice(offset, offset + limit)
  const concurrency = opts?.concurrency ?? 8

  const reads = await mapLimited(slice, concurrency, async (ticker): Promise<StockAccumulationRead> => {
    const w = await getWeeklyTrend(ticker, 'stock')
    const entry = getUniverseEntry(ticker)
    return {
      symbol: ticker.toUpperCase(),
      phase: w.phase, bias: w.bias, strength: w.strength, ok: w.ok,
      priceChangeRecentPct: w.priceChangePctRecent ?? 0,
      cap: entry?.cap ?? 'unknown',
      sector: entry?.sector ?? 'unknown',
      note: w.ok ? null : (w.reason ?? null),
    }
  })

  return { scanned: reads.length, reads }
}
