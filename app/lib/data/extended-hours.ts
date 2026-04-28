// =============================================================
// app/lib/data/extended-hours.ts
//
// Computes extended-hours (pre-market / after-hours) price context
// for /analyze and pipeline prompts.
//
// Uses Alpaca's snapshot endpoint which returns latestTrade,
// dailyBar, and prevDailyBar in a single call.
//
// The "extended move" represents price action OUTSIDE regular
// session (pre-market 4:00-9:30 AM ET, after-hours 4:00-8:00 PM ET).
//
// Quality flag (isSignificant) requires:
//   - move magnitude >= 0.5%
//   - latest trade size >= 100 shares (filters thin prints)
//   - latest trade timestamp within last 24 hours
// =============================================================

const BASE = process.env.ALPACA_BASE_URL || 'https://data.alpaca.markets'

function alpacaHeaders() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
    'Accept': 'application/json',
  }
}

// =============================================================
// Types
// =============================================================

export type MarketStatus = 'pre-market' | 'regular' | 'after-hours' | 'closed'

export interface ExtendedHoursMove {
  /** 'pre-market' if morning, 'after-hours' if evening */
  direction: 'pre-market' | 'after-hours'

  /** Reference price the move is measured from (yesterday's close or today's RTH close) */
  fromPrice: number

  /** Latest extended-hours trade price */
  toPrice: number

  /** Percentage change */
  pctChange: number

  /** Dollar change */
  dollarChange: number

  /** Quality assessment - true if real volume + recent + magnitude >= 0.5% */
  isSignificant: boolean

  /** Plain-text quality note ("real volume" | "thin print" | "stale" | "minimal move") */
  qualityNote: string

  /** Size of the latest extended-hours trade (in shares) */
  lastTradeSize: number

  /** ISO timestamp of the latest trade */
  lastTradeTime: string

  /** Minutes since the latest extended-hours trade */
  ageMinutes: number
}

export interface ExtendedHoursContext {
  ticker: string

  /** Current market session */
  marketStatus: MarketStatus

  /** Whether market is currently open for regular trading */
  isMarketOpen: boolean

  /** Most recent trade price (regular OR extended) */
  latestPrice: number

  /** Most recently completed regular session close (yesterday during pre-market, today during after-hours) */
  lastRegularClose: number | null

  /** The session-before-last close (for context — usually 2 trading days ago during pre-market) */
  priorRegularClose: number | null

  /** The extended-hours move object (null if no meaningful AH/PM data) */
  extendedMove: ExtendedHoursMove | null

  /** Plain-text context ready to inject into LLM prompts. Empty string if nothing to report. */
  promptContext: string
}

// =============================================================
// Alpaca snapshot response shape
// =============================================================

interface AlpacaTrade {
  t: string  // timestamp
  p: number  // price
  s: number  // size (shares)
  x: string  // exchange
}

interface AlpacaDailyBar {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

interface AlpacaSnapshot {
  symbol?: string
  latestTrade?: AlpacaTrade
  latestQuote?: { ap: number; bp: number; t: string }
  minuteBar?: AlpacaDailyBar
  dailyBar?: AlpacaDailyBar
  prevDailyBar?: AlpacaDailyBar
}

// =============================================================
// Market hours detection (US Eastern)
// =============================================================

/**
 * Determines current market status based on US Eastern time.
 * Uses Intl.DateTimeFormat for reliable cross-platform timezone handling.
 *
 * Regular hours:    Mon-Fri 9:30 AM - 4:00 PM ET
 * Pre-market:       Mon-Fri 4:00 AM - 9:30 AM ET
 * After-hours:      Mon-Fri 4:00 PM - 8:00 PM ET
 * Closed:           Weekends, overnight gaps, holidays
 *
 * Note: Does not account for early-close days (half-days) or holidays.
 * For our purposes, treating those as "regular" is acceptable; the
 * extended-hours move detection logic handles edge cases gracefully.
 */
export function getMarketStatus(now: Date = new Date()): MarketStatus {
  // Format as ET (handles DST automatically)
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now)

  const weekday = etParts.find(p => p.type === 'weekday')?.value ?? ''
  const hour = parseInt(etParts.find(p => p.type === 'hour')?.value ?? '0', 10)
  const minute = parseInt(etParts.find(p => p.type === 'minute')?.value ?? '0', 10)
  const minutesOfDay = hour * 60 + minute

  // Weekend
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed'

  // Pre-market: 4:00 AM - 9:30 AM ET (240-570 minutes)
  if (minutesOfDay >= 240 && minutesOfDay < 570) return 'pre-market'

  // Regular: 9:30 AM - 4:00 PM ET (570-960)
  if (minutesOfDay >= 570 && minutesOfDay < 960) return 'regular'

  // After-hours: 4:00 PM - 8:00 PM ET (960-1200)
  if (minutesOfDay >= 960 && minutesOfDay < 1200) return 'after-hours'

  // Otherwise closed (overnight)
  return 'closed'
}

// =============================================================
// Snapshot fetcher
// =============================================================

async function fetchSnapshot(ticker: string): Promise<AlpacaSnapshot | null> {
  for (const feed of ['sip', 'iex'] as const) {
    try {
      const url = `${BASE}/v2/stocks/${ticker}/snapshot?feed=${feed}`
      const res = await fetch(url, {
        headers: alpacaHeaders(),
        next: { revalidate: 60 },
      })
      if (res.ok) {
        const data = (await res.json()) as AlpacaSnapshot
        if (data && (data.latestTrade || data.dailyBar)) {
          return data
        }
      }
    } catch {
      // try next feed
    }
  }
  return null
}

// =============================================================
// Main — assemble extended-hours context
// =============================================================

export async function getExtendedHoursContext(
  ticker: string,
  now: Date = new Date(),
): Promise<ExtendedHoursContext> {
  const marketStatus = getMarketStatus(now)
  const isMarketOpen = marketStatus === 'regular'

  const empty: ExtendedHoursContext = {
    ticker,
    marketStatus,
    isMarketOpen,
    latestPrice: 0,
    lastRegularClose: null,
    priorRegularClose: null,
    extendedMove: null,
    promptContext: '',
  }

  const snap = await fetchSnapshot(ticker)
  if (!snap || !snap.latestTrade) {
    return empty
  }

  const latestPrice = snap.latestTrade.p
  const lastTradeTime = snap.latestTrade.t
  const lastTradeSize = snap.latestTrade.s ?? 0

  // Today's daily bar close (if it exists, market has had some session today)
  const todayClose = snap.dailyBar?.c ?? null

  // Yesterday's close
  const prevClose = snap.prevDailyBar?.c ?? null

  // Compute extended move (only meaningful when market is closed OR pre-market)
  let extendedMove: ExtendedHoursMove | null = null

  if (marketStatus !== 'regular') {
    // Reference price is ALWAYS the most recently completed regular session close.
    //
    // Alpaca snapshot fields work like this:
    //   - dailyBar.c       = most recently COMPLETED daily bar's close
    //   - prevDailyBar.c   = the bar before that
    //
    // Concretely:
    //   - Tuesday pre-market: dailyBar = Monday's close (yesterday)  <- USE THIS
    //                         prevDailyBar = Friday's close
    //   - Tuesday after-hours: dailyBar = Tuesday's close (just-finished)  <- USE THIS
    //                          prevDailyBar = Monday's close
    //   - Saturday closed: dailyBar = Friday's close  <- USE THIS
    //                      prevDailyBar = Thursday's close
    //
    // So `dailyBar.c` is correct in every closed-market scenario.

    let direction: 'pre-market' | 'after-hours'
    if (marketStatus === 'pre-market') {
      direction = 'pre-market'
    } else if (marketStatus === 'after-hours') {
      direction = 'after-hours'
    } else {
      // 'closed' (overnight or weekend) - frame depends on time of day
      // After 8 PM ET: still "after-hours" until midnight, but market data quiet
      // Overnight (midnight-4 AM) and weekend: "pre-market" framing for next session
      // We use the simpler heuristic: closed = pre-market framing for next session.
      direction = 'pre-market'
    }

    const fromPrice = todayClose  // most recently completed regular session

    if (fromPrice && fromPrice > 0 && latestPrice > 0) {
      const dollarChange = latestPrice - fromPrice
      const pctChange = (dollarChange / fromPrice) * 100
      const ageMinutes = Math.max(0, (now.getTime() - new Date(lastTradeTime).getTime()) / 60000)

      // Quality assessment
      const absMove = Math.abs(pctChange)
      const isStale = ageMinutes > 720 // >12h old
      const isThin = lastTradeSize < 100
      const isMeaningful = absMove >= 0.5

      let qualityNote: string
      if (isStale) {
        qualityNote = 'stale (>12h old)'
      } else if (!isMeaningful) {
        qualityNote = 'minimal move'
      } else if (isThin) {
        qualityNote = 'thin print (<100 shares)'
      } else {
        qualityNote = 'real volume'
      }

      const isSignificant = isMeaningful && !isThin && !isStale

      extendedMove = {
        direction,
        fromPrice,
        toPrice: latestPrice,
        pctChange,
        dollarChange,
        isSignificant,
        qualityNote,
        lastTradeSize,
        lastTradeTime,
        ageMinutes,
      }
    }
  }

  // Build prompt context string (empty if nothing to report)
  const promptContext = buildPromptContext(marketStatus, latestPrice, todayClose, prevClose, extendedMove)

  return {
    ticker,
    marketStatus,
    isMarketOpen,
    latestPrice,
    lastRegularClose: todayClose,
    priorRegularClose: prevClose,
    extendedMove,
    promptContext,
  }
}

// =============================================================
// Prompt context formatter
// =============================================================

function buildPromptContext(
  marketStatus: MarketStatus,
  latestPrice: number,
  todayClose: number | null,
  prevClose: number | null,
  extendedMove: ExtendedHoursMove | null,
): string {
  // Market open mid-session: extended-hours data is stale background, briefly note it
  if (marketStatus === 'regular') {
    if (!extendedMove && prevClose && todayClose) {
      const overnightMove = ((todayClose - prevClose) / prevClose) * 100
      // Only mention if substantial gap (>1%) — avoids noise on quiet opens
      if (Math.abs(overnightMove) >= 1.0) {
        return `MARKET STATUS: Regular session active. Today opened with a ${overnightMove >= 0 ? '+' : ''}${overnightMove.toFixed(2)}% gap from yesterday's close ($${prevClose.toFixed(2)} -> $${todayClose.toFixed(2)}); opening gap context is now baked into intraday price action.`
      }
    }
    return ''
  }

  // Market closed and we have a meaningful extended move
  if (extendedMove) {
    const arrow = extendedMove.pctChange >= 0 ? '+' : ''
    const sign = extendedMove.pctChange >= 0 ? 'higher' : 'lower'
    const tradeAge = extendedMove.ageMinutes < 60
      ? `${Math.round(extendedMove.ageMinutes)}min ago`
      : `${(extendedMove.ageMinutes / 60).toFixed(1)}h ago`

    const sessionLabel = extendedMove.direction === 'after-hours' ? 'AFTER-HOURS' : 'PRE-MARKET'

    let weight: string
    if (extendedMove.isSignificant) {
      weight = `WEIGHT THIS APPROPRIATELY: This is a real-volume move OUTSIDE regular session — entry/stop/target should account for likely opening gap. However, extended-hours moves often partially reverse at the open; do NOT treat the extended price as the new baseline.`
    } else {
      weight = `WEIGHT WITH CAUTION: This move has poor data quality (${extendedMove.qualityNote}) — likely noise, not signal. Anchor analysis on the regular session close ($${extendedMove.fromPrice.toFixed(2)}), not the extended-hours print.`
    }

    return `MARKET STATUS: ${marketStatus.toUpperCase()}. Regular session closed at $${extendedMove.fromPrice.toFixed(2)}. ${sessionLabel} TRADING shows the stock at $${extendedMove.toPrice.toFixed(2)} (${arrow}${extendedMove.pctChange.toFixed(2)}%, ${sign}, last trade ${tradeAge}, ${extendedMove.lastTradeSize.toLocaleString()} shares, quality: ${extendedMove.qualityNote}). ${weight}`
  }

  // Market closed but no meaningful extended move
  if (prevClose) {
    return `MARKET STATUS: ${marketStatus.toUpperCase()}. Last regular session close $${prevClose.toFixed(2)}. No meaningful extended-hours activity to report.`
  }

  return ''
}
