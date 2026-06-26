// =============================================================
// app/lib/signals/live-movers.ts
//
// Live intraday "early gainer" detection for crypto, forex, and futures-proxies
// — the fast-momentum counterpart to the stock fast_movers scanner. Where the
// weekly-trend engine finds slow coils, this finds things STARTING to move right
// now (last ~2h) so they can be evaluated before the move is obvious.
//
// Per-class data:
//   crypto  — Coinbase 15-min bars (real price + volume)
//   forex   — OANDA M15 bars (price; tick-volume is unreliable so RVOL is skipped)
//   futures — the index/macro ETF proxies on Alpaca, 15-min bars (price + volume)
// =============================================================

import type { Bar } from '@/app/lib/signals/technicals'

export type LiveAssetType = 'crypto' | 'forex' | 'futures'

export interface LiveMover {
  symbol: string                 // display symbol (e.g. POL, EURUSD, SPY)
  assetType: LiveAssetType
  price: number
  intradayChangePct: number      // % over the recent window (~2h)
  momentumPct: number            // last few bars (acceleration)
  rvol: number                   // recent vs baseline volume (1 for forex)
  rangeBreakout: boolean         // broke the prior intraday range high
  direction: 'up' | 'down'
  score: number                  // 0..100 early-gainer score (up-biased)
  note: string
}

export interface LiveMoverOptions {
  minChangePct?: number          // min |intraday %| to qualify (class default)
  universeLimit?: number         // crypto only: cap intraday fetches, default 40
  recentBars?: number            // window for "intraday" move, default 8 (~2h on 15m)
}

const FUTURES_PROXIES = ['SPY', 'QQQ', 'IWM', 'DIA', 'VIXY', 'TLT', 'IEF', 'UUP']
const FOREX_PAIRS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD',
  'EURJPY', 'GBPJPY', 'EURGBP', 'AUDJPY', 'USDMXN',
]

// Class-appropriate "this is a real move" floors (crypto swings far more than FX).
const DEFAULT_MIN_CHANGE: Record<LiveAssetType, number> = { crypto: 2.5, forex: 0.3, futures: 0.6 }

async function mapLimited<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker(): Promise<void> {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]) }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function avg(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0 }

/** Analyze recent intraday bars for an early move. Returns null if not enough data. */
export function analyzeIntraday(
  symbol: string,
  assetType: LiveAssetType,
  bars: Bar[],
  opts: LiveMoverOptions = {},
): LiveMover | null {
  const recent = opts.recentBars ?? 8
  if (!bars || bars.length < recent + 12) return null
  const b = bars.slice(-Math.max(recent + 22, 30))   // recent window + baseline
  const last = b[b.length - 1]

  const refClose = b[b.length - 1 - recent].c
  const intradayChangePct = refClose > 0 ? ((last.c - refClose) / refClose) * 100 : 0

  const mom3Ref = b[b.length - 4]?.c ?? refClose
  const momentumPct = mom3Ref > 0 ? ((last.c - mom3Ref) / mom3Ref) * 100 : 0

  // RVOL: last 4 bars avg volume vs prior 20 (skip for forex tick-volume)
  let rvol = 1
  if (assetType !== 'forex') {
    const recentVol = avg(b.slice(-4).map(x => x.v ?? 0))
    const baseVol = avg(b.slice(-24, -4).map(x => x.v ?? 0))
    rvol = baseVol > 0 ? recentVol / baseVol : 1
  }

  // Range breakout: last close above the prior window's high (excl. last 2 bars)
  const priorHigh = Math.max(...b.slice(-24, -2).map(x => x.h))
  const rangeBreakout = last.c > priorHigh

  const direction: 'up' | 'down' = intradayChangePct >= 0 ? 'up' : 'down'

  // Score — up-biased (early GAINERS). Down moves score low.
  let score = 0
  score += Math.min(40, Math.abs(intradayChangePct) * (assetType === 'forex' ? 30 : 6))
  score += Math.min(20, Math.max(0, momentumPct) * (assetType === 'forex' ? 25 : 5))
  score += Math.min(25, Math.max(0, (rvol - 1)) * 25)     // volume confirmation
  score += rangeBreakout ? 15 : 0
  if (direction === 'down') score *= 0.4                  // gainers, not fallers
  score = Math.round(Math.max(0, Math.min(100, score)))

  const note =
    `${direction === 'up' ? '+' : ''}${intradayChangePct.toFixed(2)}% / ~${recent * 15}m` +
    (assetType !== 'forex' ? `, RVOL ${rvol.toFixed(1)}x` : '') +
    (rangeBreakout ? ', range breakout' : '')

  return {
    symbol, assetType, price: last.c,
    intradayChangePct: Math.round(intradayChangePct * 100) / 100,
    momentumPct: Math.round(momentumPct * 100) / 100,
    rvol: Math.round(rvol * 100) / 100,
    rangeBreakout, direction, score, note,
  }
}

// ── Per-class intraday bar fetchers ──
async function cryptoBars(symbol: string): Promise<Bar[]> {
  const { fetchCryptoBars } = await import('@/app/lib/trading/crypto-bars')
  const sym = symbol.includes('-') ? symbol : `${symbol.toUpperCase()}-USD`
  return fetchCryptoBars({ symbol: sym, granularity: 'FIFTEEN_MINUTE', limit: 60 })
}
async function forexBars(ticker: string): Promise<Bar[]> {
  const { fetchForexBars } = await import('@/app/lib/data/forex')
  return (await fetchForexBars(ticker.toUpperCase(), '1D')) as unknown as Bar[]  // 1D -> M15
}
async function futuresProxyBars(ticker: string): Promise<Bar[]> {
  const { fetchBars } = await import('@/app/lib/data/alpaca')
  return (await fetchBars(ticker.toUpperCase(), '1D')) as unknown as Bar[]        // 1D -> 15Min
}

/** Detect live early-gainers for an asset class, ranked by score. */
export async function detectLiveMovers(assetType: LiveAssetType, opts: LiveMoverOptions = {}): Promise<LiveMover[]> {
  const minChange = opts.minChangePct ?? DEFAULT_MIN_CHANGE[assetType]
  const movers: LiveMover[] = []

  if (assetType === 'forex') {
    const analyzed = await mapLimited(FOREX_PAIRS, 6, async (pair) => {
      try { return analyzeIntraday(pair, 'forex', await forexBars(pair), opts) } catch { return null }
    })
    for (const m of analyzed) if (m) movers.push(m)
  } else if (assetType === 'futures') {
    const analyzed = await mapLimited(FUTURES_PROXIES, 6, async (p) => {
      try { return analyzeIntraday(p, 'futures', await futuresProxyBars(p), opts) } catch { return null }
    })
    for (const m of analyzed) if (m) movers.push(m)
  } else {
    // crypto: bound to the most liquid coins, then check intraday acceleration
    const { runCryptoScan } = await import('@/app/lib/trading/crypto-scanner')
    const scan = await runCryptoScan({ minMovement: 0, minVolume: 0, limit: 500 })
    const universe = [...scan.picks]
      .sort((a, b) => b.volumeUsd24h - a.volumeUsd24h)
      .slice(0, opts.universeLimit ?? 40)
    const analyzed = await mapLimited(universe, 8, async (c) => {
      try {
        const sym = c.baseDisplaySymbol ?? c.symbol.replace('-USD', '')
        return analyzeIntraday(sym, 'crypto', await cryptoBars(c.symbol), opts)
      } catch { return null }
    })
    for (const m of analyzed) if (m) movers.push(m)
  }

  return movers
    .filter(m => m.direction === 'up' && Math.abs(m.intradayChangePct) >= minChange)
    .sort((a, b) => b.score - a.score)
}
