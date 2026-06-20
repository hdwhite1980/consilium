// =============================================================
// app/lib/signals/futures-cot.ts (Layer 5)
//
// Fetch CFTC Commitments of Traders data for futures contracts.
//
// Data source: CFTC's Socrata API (public, free, no key required)
//   Base: https://publicreporting.cftc.gov/resource/6dca-aqww.json
//   This is the disaggregated futures-only weekly report.
//
// Key fields:
//   - market_and_exchange_names: "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE"
//   - report_date_as_yyyy_mm_dd: "2026-06-09"
//   - noncomm_positions_long_all: long speculator positions
//   - noncomm_positions_short_all: short speculator positions
//   - comm_positions_long_all: long commercial (hedger) positions
//   - comm_positions_short_all: short commercial positions
//   - open_interest_all
//   - change_in_*_all: WoW changes
//
// Reports released Friday 3:30pm ET reflecting Tuesday close.
// =============================================================

import type { CotSnapshot } from './futures-bundle'

const CFTC_BASE = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json'

// Map of futures root → CFTC market_and_exchange_names substring.
// We use SOQL `like` matching since exact names vary slightly.
const COT_NAME_MAP: Record<string, string[]> = {
  // Equity index
  ES:  ['E-MINI S&P 500', 'CHICAGO MERCANTILE EXCHANGE'],
  NQ:  ['NASDAQ-100', 'CHICAGO MERCANTILE EXCHANGE'],
  RTY: ['RUSSELL 2000', 'CHICAGO MERCANTILE EXCHANGE'],
  YM:  ['DJIA', 'CHICAGO BOARD OF TRADE'],
  VX:  ['VIX FUTURES', 'CBOE FUTURES EXCHANGE'],
  // Energy
  CL:  ['CRUDE OIL', 'NEW YORK MERCANTILE EXCHANGE'],
  NG:  ['NATURAL GAS', 'NEW YORK MERCANTILE EXCHANGE'],
  HO:  ['ULSD - NY HARBOR', 'NEW YORK MERCANTILE EXCHANGE'],
  RB:  ['GASOLINE RBOB', 'NEW YORK MERCANTILE EXCHANGE'],
  BZ:  ['BRENT', 'NEW YORK MERCANTILE EXCHANGE'],
  // Metals
  GC:  ['GOLD', 'COMMODITY EXCHANGE'],
  SI:  ['SILVER', 'COMMODITY EXCHANGE'],
  HG:  ['COPPER', 'COMMODITY EXCHANGE'],
  PL:  ['PLATINUM', 'NEW YORK MERCANTILE EXCHANGE'],
  PA:  ['PALLADIUM', 'NEW YORK MERCANTILE EXCHANGE'],
  // Grains
  ZC:  ['CORN', 'CHICAGO BOARD OF TRADE'],
  ZW:  ['WHEAT', 'CHICAGO BOARD OF TRADE'],
  ZS:  ['SOYBEANS', 'CHICAGO BOARD OF TRADE'],
  ZM:  ['SOYBEAN MEAL', 'CHICAGO BOARD OF TRADE'],
  ZL:  ['SOYBEAN OIL', 'CHICAGO BOARD OF TRADE'],
  // Rates
  ZB:  ['U.S. TREASURY BONDS', 'CHICAGO BOARD OF TRADE'],
  UB:  ['ULTRA U.S. TREASURY BONDS', 'CHICAGO BOARD OF TRADE'],
  ZN:  ['10-YEAR U.S. TREASURY NOTES', 'CHICAGO BOARD OF TRADE'],
  TN:  ['ULTRA 10-YEAR U.S. TREASURY', 'CHICAGO BOARD OF TRADE'],
  ZF:  ['5-YEAR U.S. TREASURY NOTES', 'CHICAGO BOARD OF TRADE'],
  ZT:  ['2-YEAR U.S. TREASURY NOTES', 'CHICAGO BOARD OF TRADE'],
  // FX futures (CME)
  '6E': ['EURO FX', 'CHICAGO MERCANTILE EXCHANGE'],
  '6B': ['BRITISH POUND', 'CHICAGO MERCANTILE EXCHANGE'],
  '6J': ['JAPANESE YEN', 'CHICAGO MERCANTILE EXCHANGE'],
  '6A': ['AUSTRALIAN DOLLAR', 'CHICAGO MERCANTILE EXCHANGE'],
  '6C': ['CANADIAN DOLLAR', 'CHICAGO MERCANTILE EXCHANGE'],
  '6S': ['SWISS FRANC', 'CHICAGO MERCANTILE EXCHANGE'],
  '6N': ['NEW ZEALAND DOLLAR', 'CHICAGO MERCANTILE EXCHANGE'],
}

interface CftcRow {
  market_and_exchange_names?: string
  report_date_as_yyyy_mm_dd?: string
  noncomm_positions_long_all?: string
  noncomm_positions_short_all?: string
  comm_positions_long_all?: string
  comm_positions_short_all?: string
  open_interest_all?: string
  change_in_noncomm_long_all?: string
  change_in_noncomm_short_all?: string
  change_in_open_interest_all?: string
}

/**
 * Fetch the latest COT snapshot for a futures root.
 * Returns null if no match or fetch fails (caller falls back gracefully).
 */
export async function fetchFuturesCot(root: string): Promise<CotSnapshot | null> {
  const matchers = COT_NAME_MAP[root]
  if (!matchers || matchers.length === 0) return null

  // Build SOQL: WHERE market_and_exchange_names LIKE '%first%' AND ... LIKE '%second%' ORDER BY date DESC LIMIT 1
  const whereClauses = matchers.map(m => `upper(market_and_exchange_names) LIKE '%${m.toUpperCase().replace(/'/g, "''")}%'`).join(' AND ')
  const url = `${CFTC_BASE}?$where=${encodeURIComponent(whereClauses)}&$order=report_date_as_yyyy_mm_dd DESC&$limit=1`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      console.warn(`[futures-cot] ${root} fetch HTTP ${res.status}`)
      return null
    }
    const rows = await res.json() as CftcRow[]
    if (!rows || rows.length === 0) {
      console.warn(`[futures-cot] ${root} no rows for matchers: ${matchers.join(' AND ')}`)
      return null
    }
    return rowToSnapshot(rows[0])
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      console.warn(`[futures-cot] ${root} fetch timeout`)
    } else {
      console.warn(`[futures-cot] ${root} fetch error:`, e instanceof Error ? e.message : e)
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

function rowToSnapshot(row: CftcRow): CotSnapshot {
  const num = (v: string | undefined): number => v !== undefined ? Number(v) || 0 : 0

  const ncLong = num(row.noncomm_positions_long_all)
  const ncShort = num(row.noncomm_positions_short_all)
  const ncNet = ncLong - ncShort
  const cLong = num(row.comm_positions_long_all)
  const cShort = num(row.comm_positions_short_all)
  const cNet = cLong - cShort
  const oi = num(row.open_interest_all)
  const ncNetPctOI = oi > 0 ? ncNet / oi : 0
  const ncLongWoW = num(row.change_in_noncomm_long_all)
  const ncShortWoW = num(row.change_in_noncomm_short_all)
  const oiWoW = num(row.change_in_open_interest_all)

  // Generate a Council-readable interpretation
  const interpretation = interpretCot(ncNet, ncNetPctOI, ncLongWoW, ncShortWoW, cNet)

  return {
    reportDate: row.report_date_as_yyyy_mm_dd ?? '',
    contractName: row.market_and_exchange_names ?? '',
    nonCommercialLong: ncLong,
    nonCommercialShort: ncShort,
    nonCommercialNet: ncNet,
    nonCommercialNetPctOI: ncNetPctOI,
    nonCommercialLongChangeWoW: ncLongWoW,
    nonCommercialShortChangeWoW: ncShortWoW,
    commercialLong: cLong,
    commercialShort: cShort,
    commercialNet: cNet,
    openInterest: oi,
    openInterestChangeWoW: oiWoW,
    interpretation,
  }
}

/**
 * Lightweight interpretation of COT positioning. The Council gets this
 * as a hint but is instructed to apply its own analysis on top.
 */
function interpretCot(
  ncNet: number,
  ncNetPctOI: number,
  ncLongWoW: number,
  ncShortWoW: number,
  cNet: number,
): string {
  const parts: string[] = []

  // Positioning extremity
  if (Math.abs(ncNetPctOI) > 0.30) {
    parts.push(`Extreme speculator positioning (${(ncNetPctOI * 100).toFixed(0)}% of OI ${ncNet > 0 ? 'long' : 'short'})`)
  } else if (Math.abs(ncNetPctOI) > 0.15) {
    parts.push(`Notable speculator skew (${(ncNetPctOI * 100).toFixed(0)}% of OI ${ncNet > 0 ? 'long' : 'short'})`)
  } else {
    parts.push(`Speculator positioning is balanced (${(ncNetPctOI * 100).toFixed(0)}% of OI net ${ncNet > 0 ? 'long' : 'short'})`)
  }

  // Weekly change direction
  const longSwing = ncLongWoW - ncShortWoW
  if (Math.abs(longSwing) > 5000) {
    parts.push(`Speculators ${longSwing > 0 ? 'added longs' : 'added shorts'} last week (net ${longSwing > 0 ? '+' : ''}${longSwing.toLocaleString()})`)
  }

  // Commercials are usually contrarian to speculators (they hedge real exposure)
  if (cNet * ncNet < 0 && Math.abs(ncNet) > 50000) {
    parts.push(`Commercials are positioned opposite of speculators (typical hedger behavior, not a directional signal alone)`)
  }

  return parts.join('. ')
}
