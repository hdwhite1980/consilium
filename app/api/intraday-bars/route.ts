// =============================================================
// app/api/intraday-bars/route.ts
//
// Fetches raw OHLCV bars at a specific resolution (5Min/15Min/1Hour)
// and computes overlay values for chart rendering:
//   - VWAP series (per-bar)
//   - EMA9 / EMA20 series
//   - Bollinger Bands
//   - Detected candle pattern (this timeframe)
//   - Detected chart pattern (this timeframe)
//   - Support/resistance levels
//
// Used by /components/IntradayCharts.tsx to render multi-timeframe
// candlestick charts with annotations.
//
// No AI calls. No alerts. Pure data computation for visualization.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { fetchBars as fetchAlpacaBars, type AlpacaBar } from '@/app/lib/data/alpaca'
import {
  detectCandlePattern,
  detectChartPattern,
  type Bar,
  type CandlePattern,
  type ChartPattern,
} from '@/app/lib/signals/technicals'

export const runtime = 'nodejs'
export const maxDuration = 15

// =============================================================
// Helpers (computed inline so no dependency on technicals internals)
// =============================================================

/** EMA series — returns same length as input bars */
function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return []
  const k = 2 / (period + 1)
  const out: number[] = []
  let prev = values[0]
  out.push(prev)
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

/** Rolling VWAP across the entire bar set (typical-price-volume weighted) */
function vwapSeries(bars: Bar[]): number[] {
  let cumPV = 0
  let cumV = 0
  const out: number[] = []
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3
    cumPV += tp * b.v
    cumV += b.v
    out.push(cumV > 0 ? cumPV / cumV : tp)
  }
  return out
}

/** Bollinger Bands middle/upper/lower series */
function bollingerSeries(values: number[], period = 20, stdDevMul = 2) {
  const middle: (number | null)[] = []
  const upper: (number | null)[] = []
  const lower: (number | null)[] = []
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      middle.push(null); upper.push(null); lower.push(null)
      continue
    }
    const slice = values.slice(i - period + 1, i + 1)
    const mean = slice.reduce((s, v) => s + v, 0) / period
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period
    const sd = Math.sqrt(variance)
    middle.push(mean)
    upper.push(mean + sd * stdDevMul)
    lower.push(mean - sd * stdDevMul)
  }
  return { middle, upper, lower }
}

/** Find local pivot highs / lows for support/resistance */
function findSupportResistance(bars: Bar[]): { support: number[]; resistance: number[] } {
  if (bars.length < 10) return { support: [], resistance: [] }
  const lookback = 5
  const supports: number[] = []
  const resistances: number[] = []
  for (let i = lookback; i < bars.length - lookback; i++) {
    const window = bars.slice(i - lookback, i + lookback + 1)
    const isLow = window.every(b => b.l >= bars[i].l)
    const isHigh = window.every(b => b.h <= bars[i].h)
    if (isLow) supports.push(bars[i].l)
    if (isHigh) resistances.push(bars[i].h)
  }
  // De-duplicate within 0.5% bands, keep the most recent 4 of each
  const dedupe = (arr: number[]) => {
    const out: number[] = []
    for (const v of arr.slice().reverse()) {
      if (out.every(x => Math.abs(x - v) / v > 0.005)) {
        out.push(v)
      }
      if (out.length >= 4) break
    }
    return out
  }
  return {
    support: dedupe(supports),
    resistance: dedupe(resistances),
  }
}

// =============================================================
// Resolution mapping
// =============================================================

interface ResolutionConfig {
  alpacaTimeframe: string  // Alpaca format: 5Min / 15Min / 1Hour
  daysBack: number         // How much history
  expectedBars: number     // Roughly how many bars to expect
}

const RESOLUTIONS: Record<string, ResolutionConfig> = {
  '5Min':  { alpacaTimeframe: '5Min',  daysBack: 2,  expectedBars: 156 },   // 2 days, 78 bars/day
  '15Min': { alpacaTimeframe: '15Min', daysBack: 5,  expectedBars: 130 },   // 5 days, 26 bars/day
  '1Hour': { alpacaTimeframe: '1Hour', daysBack: 15, expectedBars: 105 },   // 15 days, 7 bars/day
}

// =============================================================
// Fetch raw bars at custom resolution
// (Alpaca fetchBars wraps timeframes; we need direct access)
// =============================================================

async function fetchBarsAtResolution(ticker: string, resolution: string): Promise<AlpacaBar[]> {
  const cfg = RESOLUTIONS[resolution]
  if (!cfg) return []

  const BASE = process.env.ALPACA_BASE_URL || 'https://data.alpaca.markets'
  const headers = {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
    'Accept': 'application/json',
  }

  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - cfg.daysBack)
  const startStr = start.toISOString().split('T')[0]
  const endStr = end.toISOString().split('T')[0]

  // Try SIP first, fall back to IEX
  for (const feed of ['sip', 'iex']) {
    try {
      const url = `${BASE}/v2/stocks/${ticker}/bars?timeframe=${cfg.alpacaTimeframe}&start=${startStr}&end=${endStr}&limit=10000&adjustment=all&feed=${feed}`
      const res = await fetch(url, { headers, next: { revalidate: 120 } })
      if (res.ok) {
        const data = await res.json()
        const bars = (data.bars || []) as AlpacaBar[]
        if (bars.length >= 5) return bars
      }
    } catch {
      // try next feed
    }
  }

  return []
}

// =============================================================
// Response shape
// =============================================================

export interface IntradayChartData {
  ticker: string
  resolution: string
  bars: AlpacaBar[]
  overlays: {
    vwap: number[]
    ema9: number[]
    ema20: number[]
    bbMiddle: (number | null)[]
    bbUpper: (number | null)[]
    bbLower: (number | null)[]
  }
  patterns: {
    candle: CandlePattern | null
    chart: ChartPattern | null
  }
  levels: {
    support: number[]
    resistance: number[]
  }
  meta: {
    barCount: number
    fetchedAt: string
  }
  error?: string
}

// =============================================================
// Route handler
// =============================================================

export async function GET(req: NextRequest) {
  try {
    // Auth
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const url = new URL(req.url)
    const ticker = (url.searchParams.get('ticker') ?? '').trim().toUpperCase()
    const resolution = (url.searchParams.get('resolution') ?? '15Min').trim()

    if (!ticker) {
      return NextResponse.json({ error: 'ticker required' }, { status: 400 })
    }
    if (!RESOLUTIONS[resolution]) {
      return NextResponse.json({
        error: `Invalid resolution. Allowed: ${Object.keys(RESOLUTIONS).join(', ')}`,
      }, { status: 400 })
    }

    // Fetch bars
    const bars = await fetchBarsAtResolution(ticker, resolution)
    if (bars.length < 5) {
      return NextResponse.json({
        ticker, resolution, bars: [],
        overlays: { vwap: [], ema9: [], ema20: [], bbMiddle: [], bbUpper: [], bbLower: [] },
        patterns: { candle: null, chart: null },
        levels: { support: [], resistance: [] },
        meta: { barCount: 0, fetchedAt: new Date().toISOString() },
        error: 'Insufficient bar data',
      } satisfies IntradayChartData)
    }

    // Compute overlays
    const closes = bars.map(b => b.c)
    const vwap = vwapSeries(bars as Bar[])
    const ema9 = emaSeries(closes, 9)
    const ema20 = emaSeries(closes, 20)
    const bb = bollingerSeries(closes, 20, 2)

    // Detect patterns at THIS timeframe
    const candle = detectCandlePattern(bars as Bar[])
    const lastClose = bars[bars.length - 1].c
    const chart = detectChartPattern(bars as Bar[], lastClose)

    // Support/resistance from this timeframe
    const levels = findSupportResistance(bars as Bar[])

    const result: IntradayChartData = {
      ticker,
      resolution,
      bars,
      overlays: {
        vwap,
        ema9,
        ema20,
        bbMiddle: bb.middle,
        bbUpper: bb.upper,
        bbLower: bb.lower,
      },
      patterns: { candle, chart },
      levels,
      meta: {
        barCount: bars.length,
        fetchedAt: new Date().toISOString(),
      },
    }

    return NextResponse.json(result)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[intraday-bars] Error:', msg)
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 })
  }
}
