// ═════════════════════════════════════════════════════════════
// app/lib/forward-data.ts
//
// Forward-looking data sources for Tomorrow's Movers rewrite.
//
// Where current /api/tomorrow fails:
//   - Uses Alpaca headlines (today's news) to guess at tomorrow
//   - Gemini hallucinates specific earnings dates and EPS estimates
//   - No pre-market or after-hours data
//
// What this module provides:
//   1. Real Finnhub earnings calendar for next trading day(s)
//   2. After-hours % moves for stocks that reported today
//   3. Pre-market snapshot (if running after-hours)
//   4. Basic economic calendar (FRED-powered, free)
// ═════════════════════════════════════════════════════════════

const FINNHUB_BASE = 'https://finnhub.io/api/v1'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export interface EarningsEvent {
  ticker: string
  companyName?: string
  reportDate: string         // YYYY-MM-DD
  reportTime: 'bmo' | 'amc' | 'dmh' | 'unknown'  // bmo=before market open, amc=after close, dmh=during market
  epsEstimate: number | null
  epsActual: number | null
  revenueEstimate: number | null
  revenueActual: number | null
  quarter: number | null
  year: number | null
}

export interface AfterHoursMove {
  ticker: string
  closePrice: number
  afterHoursPrice: number
  afterHoursChangePct: number
  reportedToday: boolean      // did they report earnings today?
}

export interface EconomicEvent {
  name: string
  date: string                // YYYY-MM-DD
  time?: string               // optional time-of-day
  impact: 'high' | 'medium' | 'low'
  actual?: string | number
  forecast?: string | number
  previous?: string | number
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function getNextTradingDay(): string {
  const now = new Date()
  const day = now.getUTCDay()
  // Mon-Thu → tomorrow; Fri → Monday; Sat → Monday; Sun → Monday
  const daysAhead = day === 5 ? 3 : day === 6 ? 2 : 1
  const next = new Date(now)
  next.setUTCDate(next.getUTCDate() + daysAhead)
  return next.toISOString().split('T')[0]
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function normalizeReportTime(raw: string | null | undefined): EarningsEvent['reportTime'] {
  if (!raw) return 'unknown'
  const r = raw.toLowerCase()
  if (r === 'bmo' || r.includes('before')) return 'bmo'
  if (r === 'amc' || r.includes('after')) return 'amc'
  if (r === 'dmh' || r.includes('during')) return 'dmh'
  return 'unknown'
}

async function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = 8000): Promise<Response | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store' })
    return res
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// 1. Finnhub earnings calendar for next trading day(s)
// ─────────────────────────────────────────────────────────────
export async function fetchTomorrowEarnings(): Promise<EarningsEvent[]> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return []

  const from = getNextTradingDay()
  // Pull 3 days forward so /tomorrow Friday shows Mon/Tue too
  const toDate = new Date(from + 'T00:00:00Z')
  toDate.setUTCDate(toDate.getUTCDate() + 3)
  const to = toDate.toISOString().split('T')[0]

  try {
    const res = await fetchWithTimeout(
      `${FINNHUB_BASE}/calendar/earnings?from=${from}&to=${to}&token=${key}`,
      {}, 10000
    )
    if (!res || !res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data?.earningsCalendar)) return []

    return (data.earningsCalendar as Array<Record<string, unknown>>)
      .map(e => ({
        ticker: String(e.symbol ?? '').toUpperCase(),
        companyName: typeof e.name === 'string' ? e.name : undefined,
        reportDate: typeof e.date === 'string' ? e.date : from,
        reportTime: normalizeReportTime(e.hour as string | null | undefined),
        epsEstimate: typeof e.epsEstimate === 'number' ? e.epsEstimate : null,
        epsActual: typeof e.epsActual === 'number' ? e.epsActual : null,
        revenueEstimate: typeof e.revenueEstimate === 'number' ? e.revenueEstimate : null,
        revenueActual: typeof e.revenueActual === 'number' ? e.revenueActual : null,
        quarter: typeof e.quarter === 'number' ? e.quarter : null,
        year: typeof e.year === 'number' ? e.year : null,
      }))
      .filter(e => e.ticker.length > 0)
      .sort((a, b) => {
        // Sort by date, then prioritize BMO (biggest move potential before open)
        if (a.reportDate !== b.reportDate) return a.reportDate.localeCompare(b.reportDate)
        const order: Record<EarningsEvent['reportTime'], number> = { bmo: 0, dmh: 1, amc: 2, unknown: 3 }
        return order[a.reportTime] - order[b.reportTime]
      })
      .slice(0, 50)
  } catch (e) {
    console.warn('[forward-data] earnings fetch failed:', (e as Error).message?.slice(0, 100))
    return []
  }
}

// ─────────────────────────────────────────────────────────────
// 2. After-hours moves on stocks that reported TODAY
// Uses Alpaca's latest trade endpoint (after-hours quotes)
// ─────────────────────────────────────────────────────────────
export async function fetchAfterHoursMoves(tickersReportingToday: string[]): Promise<AfterHoursMove[]> {
  if (tickersReportingToday.length === 0) return []
  const akey = process.env.ALPACA_API_KEY
  const asec = process.env.ALPACA_SECRET_KEY
  if (!akey || !asec) return []

  const results: AfterHoursMove[] = []

  // Alpaca latest trade endpoint — supports bulk
  const symbols = tickersReportingToday.slice(0, 30).join(',')
  const headers = {
    'APCA-API-KEY-ID': akey,
    'APCA-API-SECRET-KEY': asec,
    Accept: 'application/json',
  }

  try {
    // Get latest trade (includes after-hours if market is closed)
    const res = await fetchWithTimeout(
      `https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${symbols}`,
      { headers }, 6000
    )
    if (!res || !res.ok) return []
    const data = await res.json()
    const trades = data?.trades ?? {}

    // Also get snapshots (includes daily close price) for the move calc
    const snapRes = await fetchWithTimeout(
      `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${symbols}`,
      { headers }, 6000
    )
    if (!snapRes || !snapRes.ok) return []
    const snapData = await snapRes.json()
    const snapshots = snapData?.snapshots ?? snapData ?? {}

    for (const ticker of tickersReportingToday) {
      const snap = snapshots[ticker] ?? snapshots[ticker.toUpperCase()]
      const latest = trades[ticker] ?? trades[ticker.toUpperCase()]
      if (!snap || !latest) continue

      // Daily bar close price (today's regular-session close)
      const closePrice = snap?.dailyBar?.c ?? snap?.prevDailyBar?.c ?? null
      const latestPrice = latest?.p ?? null
      if (typeof closePrice !== 'number' || typeof latestPrice !== 'number' || closePrice <= 0) continue

      const changePct = ((latestPrice - closePrice) / closePrice) * 100
      // Only report meaningful after-hours moves (>= 1%)
      if (Math.abs(changePct) < 1) continue

      results.push({
        ticker: ticker.toUpperCase(),
        closePrice: parseFloat(closePrice.toFixed(2)),
        afterHoursPrice: parseFloat(latestPrice.toFixed(2)),
        afterHoursChangePct: parseFloat(changePct.toFixed(2)),
        reportedToday: true,
      })
    }
  } catch (e) {
    console.warn('[forward-data] after-hours fetch failed:', (e as Error).message?.slice(0, 100))
  }

  return results.sort((a, b) => Math.abs(b.afterHoursChangePct) - Math.abs(a.afterHoursChangePct)).slice(0, 15)
}

// ─────────────────────────────────────────────────────────────
// 3. Get today's earnings reporters (so we can check after-hours moves)
// ─────────────────────────────────────────────────────────────
export async function fetchTodayEarnings(): Promise<EarningsEvent[]> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return []

  const today = todayStr()
  try {
    const res = await fetchWithTimeout(
      `${FINNHUB_BASE}/calendar/earnings?from=${today}&to=${today}&token=${key}`,
      {}, 8000
    )
    if (!res || !res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data?.earningsCalendar)) return []

    return (data.earningsCalendar as Array<Record<string, unknown>>)
      .map(e => ({
        ticker: String(e.symbol ?? '').toUpperCase(),
        companyName: typeof e.name === 'string' ? e.name : undefined,
        reportDate: today,
        reportTime: normalizeReportTime(e.hour as string | null | undefined),
        epsEstimate: typeof e.epsEstimate === 'number' ? e.epsEstimate : null,
        epsActual: typeof e.epsActual === 'number' ? e.epsActual : null,
        revenueEstimate: typeof e.revenueEstimate === 'number' ? e.revenueEstimate : null,
        revenueActual: typeof e.revenueActual === 'number' ? e.revenueActual : null,
        quarter: typeof e.quarter === 'number' ? e.quarter : null,
        year: typeof e.year === 'number' ? e.year : null,
      }))
      .filter(e => e.ticker.length > 0)
  } catch {
    return []
  }
}

// ─────────────────────────────────────────────────────────────
// 4. Economic calendar
// ─────────────────────────────────────────────────────────────
//
// PRIMARY SOURCE: hardcoded central bank meeting calendar.
//   - FOMC, ECB, BoE, BoJ, BoC, RBA dates are public and scheduled
//     in advance, rarely change, and are the dominant catalysts
//     for currency pairs AND a major factor for equity/bond moves
//     in the days before/around the meeting.
//   - Hardcoding ~50 dates per year is trivial and avoids the
//     dependency on a paid tier of Finnhub's calendar endpoint.
//
// SECONDARY SOURCE: Finnhub /calendar/economic.
//   - Layers on top when it returns data (NFP, CPI, retail sales).
//   - Silently returns empty on free/Basic tier, which is fine —
//     the central bank calendar covers the highest-impact events.
//
// Window: 14 days forward — enough to catch the next FOMC for stocks,
// next ECB for EUR pairs, etc., without flooding the bundle.

interface CentralBankMeeting {
  bank: 'FOMC' | 'ECB' | 'BoE' | 'BoJ' | 'BoC' | 'RBA'
  date: string         // YYYY-MM-DD (decision day)
  hasPressConf: boolean
  hasSEP?: boolean     // FOMC Summary of Economic Projections
}

// 2026 central bank meeting calendar (decision/press-conference days).
// Sources: federalreserve.gov, ecb.europa.eu, bankofengland.co.uk,
// boj.or.jp, bankofcanada.ca, rba.gov.au.
// Update this list at year-end when 2027 calendars publish.
const CENTRAL_BANK_CALENDAR_2026: CentralBankMeeting[] = [
  // FOMC (Federal Reserve) — 8 meetings/year
  { bank: 'FOMC', date: '2026-01-28', hasPressConf: true },
  { bank: 'FOMC', date: '2026-03-18', hasPressConf: true, hasSEP: true },
  { bank: 'FOMC', date: '2026-04-29', hasPressConf: true },
  { bank: 'FOMC', date: '2026-06-17', hasPressConf: true, hasSEP: true },
  { bank: 'FOMC', date: '2026-07-29', hasPressConf: true },
  { bank: 'FOMC', date: '2026-09-16', hasPressConf: true, hasSEP: true },
  { bank: 'FOMC', date: '2026-10-28', hasPressConf: true },
  { bank: 'FOMC', date: '2026-12-09', hasPressConf: true, hasSEP: true },

  // ECB Governing Council — monetary policy decisions (Day 2 of each meeting)
  { bank: 'ECB', date: '2026-01-22', hasPressConf: true },
  { bank: 'ECB', date: '2026-03-12', hasPressConf: true },
  { bank: 'ECB', date: '2026-04-30', hasPressConf: true },
  { bank: 'ECB', date: '2026-06-11', hasPressConf: true },
  { bank: 'ECB', date: '2026-07-23', hasPressConf: true },
  { bank: 'ECB', date: '2026-09-10', hasPressConf: true },
  { bank: 'ECB', date: '2026-10-29', hasPressConf: true },
  { bank: 'ECB', date: '2026-12-17', hasPressConf: true },

  // BoE (Bank of England) — MPC announcements (Thursdays, 12:00 UK)
  { bank: 'BoE', date: '2026-02-05', hasPressConf: true },
  { bank: 'BoE', date: '2026-03-19', hasPressConf: false },
  { bank: 'BoE', date: '2026-05-07', hasPressConf: true },
  { bank: 'BoE', date: '2026-06-18', hasPressConf: false },
  { bank: 'BoE', date: '2026-08-06', hasPressConf: true },
  { bank: 'BoE', date: '2026-09-17', hasPressConf: false },
  { bank: 'BoE', date: '2026-11-05', hasPressConf: true },
  { bank: 'BoE', date: '2026-12-17', hasPressConf: false },

  // BoJ (Bank of Japan) — 8 meetings/year, decision typically Friday
  { bank: 'BoJ', date: '2026-01-23', hasPressConf: true },
  { bank: 'BoJ', date: '2026-03-19', hasPressConf: true },
  { bank: 'BoJ', date: '2026-04-30', hasPressConf: true },
  { bank: 'BoJ', date: '2026-06-19', hasPressConf: true },
  { bank: 'BoJ', date: '2026-07-31', hasPressConf: true },
  { bank: 'BoJ', date: '2026-09-18', hasPressConf: true },
  { bank: 'BoJ', date: '2026-10-30', hasPressConf: true },
  { bank: 'BoJ', date: '2026-12-18', hasPressConf: true },

  // BoC (Bank of Canada) — 8 fixed announcement dates
  { bank: 'BoC', date: '2026-01-21', hasPressConf: true },
  { bank: 'BoC', date: '2026-03-11', hasPressConf: false },
  { bank: 'BoC', date: '2026-04-15', hasPressConf: true },
  { bank: 'BoC', date: '2026-06-03', hasPressConf: false },
  { bank: 'BoC', date: '2026-07-29', hasPressConf: true },
  { bank: 'BoC', date: '2026-09-09', hasPressConf: false },
  { bank: 'BoC', date: '2026-10-28', hasPressConf: true },
  { bank: 'BoC', date: '2026-12-09', hasPressConf: false },

  // RBA (Reserve Bank of Australia) — first Tuesday of most months
  { bank: 'RBA', date: '2026-02-03', hasPressConf: true },
  { bank: 'RBA', date: '2026-03-03', hasPressConf: false },
  { bank: 'RBA', date: '2026-04-07', hasPressConf: false },
  { bank: 'RBA', date: '2026-05-05', hasPressConf: true },
  { bank: 'RBA', date: '2026-06-02', hasPressConf: false },
  { bank: 'RBA', date: '2026-07-07', hasPressConf: false },
  { bank: 'RBA', date: '2026-08-04', hasPressConf: true },
  { bank: 'RBA', date: '2026-09-22', hasPressConf: false },
  { bank: 'RBA', date: '2026-11-03', hasPressConf: true },
  { bank: 'RBA', date: '2026-12-08', hasPressConf: false },
]

function buildCentralBankEvents(daysAhead: number): EconomicEvent[] {
  const today = todayStr()
  const horizon = new Date(today + 'T00:00:00Z')
  horizon.setUTCDate(horizon.getUTCDate() + daysAhead)
  const horizonStr = horizon.toISOString().split('T')[0]

  const events: EconomicEvent[] = []
  for (const m of CENTRAL_BANK_CALENDAR_2026) {
    if (m.date < today || m.date > horizonStr) continue
    // Format: "FOMC Meeting (rate decision + SEP)" etc.
    const detail = m.bank === 'FOMC' && m.hasSEP
      ? ' (rate decision + SEP/dot plot + press conference)'
      : m.hasPressConf
      ? ' (rate decision + press conference)'
      : ' (rate decision)'
    events.push({
      name: `${m.bank} Meeting${detail}`,
      date: m.date,
      impact: 'high',
    })
  }
  return events
}

export async function fetchEconomicCalendar(): Promise<EconomicEvent[]> {
  // 1. Hardcoded central bank calendar (always available)
  const cbEvents = buildCentralBankEvents(14)

  // 2. Finnhub layered fallback (NFP, CPI, retail sales, etc.)
  //    Often empty on free/Basic tier — that's fine, we have central
  //    bank coverage above. When Finnhub does return data, it layers.
  const key = process.env.FINNHUB_API_KEY
  const finnhubEvents: EconomicEvent[] = []
  if (key) {
    const from = todayStr()
    const toDate = new Date(from + 'T00:00:00Z')
    toDate.setUTCDate(toDate.getUTCDate() + 14)
    const to = toDate.toISOString().split('T')[0]
    try {
      const res = await fetchWithTimeout(
        `${FINNHUB_BASE}/calendar/economic?from=${from}&to=${to}&token=${key}`,
        {}, 8000
      )
      if (res && res.ok) {
        const data = await res.json()
        if (Array.isArray(data?.economicCalendar)) {
          for (const e of data.economicCalendar as Array<Record<string, unknown>>) {
            const country = typeof e.country === 'string' ? e.country : ''
            const impact = typeof e.impact === 'string' ? e.impact.toLowerCase() : ''
            if (country !== 'US' || (impact !== 'high' && impact !== 'medium')) continue
            const name = String(e.event ?? '')
            if (!name) continue
            // Skip if it duplicates a central bank meeting we already have
            // (Finnhub sometimes labels FOMC as "Fed Interest Rate Decision")
            const date = String(e.time ?? '').split(' ')[0] || from
            const isFomcDup = /fomc|fed.*rate.*decision|interest.*rate.*decision/i.test(name) &&
              cbEvents.some(c => c.date === date && c.name.startsWith('FOMC'))
            if (isFomcDup) continue
            finnhubEvents.push({
              name,
              date,
              time: String(e.time ?? '').split(' ')[1] ?? undefined,
              impact: (impact as 'high' | 'medium' | 'low'),
              actual: e.actual as string | number | undefined,
              forecast: e.estimate as string | number | undefined,
              previous: e.prev as string | number | undefined,
            })
          }
        }
      }
    } catch {
      // Finnhub failed — that's fine, central bank events still cover us
    }
  }

  // Combine and sort by date
  const combined = [...cbEvents, ...finnhubEvents]
  combined.sort((a, b) => a.date.localeCompare(b.date))
  return combined.slice(0, 30)
}

// ─────────────────────────────────────────────────────────────
// Bundle everything into a single forward-looking context object
// ─────────────────────────────────────────────────────────────
export interface ForwardContext {
  tomorrowEarnings: EarningsEvent[]
  todayReporters: EarningsEvent[]
  afterHoursMovers: AfterHoursMove[]
  economicEvents: EconomicEvent[]
  nextTradingDay: string
  fetchedAt: string
  counts: {
    tomorrowEarnings: number
    afterHoursMovers: number
    economicEvents: number
  }
}

export async function fetchForwardContext(): Promise<ForwardContext> {
  const started = Date.now()
  const nextTradingDay = getNextTradingDay()

  // Fetch tomorrow earnings + today reporters + economic events in parallel
  const [tomorrowEarnings, todayReporters, economicEvents] = await Promise.all([
    fetchTomorrowEarnings(),
    fetchTodayEarnings(),
    fetchEconomicCalendar(),
  ])

  // Given today's reporters, fetch their after-hours moves
  const todayTickers = todayReporters.map(e => e.ticker)
  const afterHoursMovers = todayTickers.length > 0
    ? await fetchAfterHoursMoves(todayTickers)
    : []

  const elapsed = Date.now() - started
  console.log(`[forward-data] fetched in ${elapsed}ms — earnings:${tomorrowEarnings.length} today-reporters:${todayReporters.length} afterhours:${afterHoursMovers.length} econ:${economicEvents.length}`)

  return {
    tomorrowEarnings,
    todayReporters,
    afterHoursMovers,
    economicEvents,
    nextTradingDay,
    fetchedAt: new Date().toISOString(),
    counts: {
      tomorrowEarnings: tomorrowEarnings.length,
      afterHoursMovers: afterHoursMovers.length,
      economicEvents: economicEvents.length,
    },
  }
}

// ─────────────────────────────────────────────────────────────
// Format forward context as a structured string block for LLM prompts
// ─────────────────────────────────────────────────────────────
export function formatForwardContextForPrompt(ctx: ForwardContext): string {
  const parts: string[] = []

  // Earnings tomorrow — the biggest known catalyst
  if (ctx.tomorrowEarnings.length > 0) {
    const byDate: Record<string, EarningsEvent[]> = {}
    for (const e of ctx.tomorrowEarnings) {
      byDate[e.reportDate] = byDate[e.reportDate] ?? []
      byDate[e.reportDate].push(e)
    }
    const lines: string[] = []
    for (const [date, earns] of Object.entries(byDate)) {
      lines.push(`\nEARNINGS ON ${date}:`)
      for (const e of earns.slice(0, 20)) {
        const eps = e.epsEstimate !== null ? `EPS est $${e.epsEstimate.toFixed(2)}` : ''
        const rev = e.revenueEstimate !== null && e.revenueEstimate > 0 ? `Rev est $${(e.revenueEstimate / 1e9).toFixed(2)}B` : ''
        const timeLabel = e.reportTime === 'bmo' ? 'BMO' : e.reportTime === 'amc' ? 'AMC' : e.reportTime === 'dmh' ? 'DMH' : '?'
        const meta = [eps, rev].filter(Boolean).join(', ')
        const name = e.companyName ? ` (${e.companyName})` : ''
        lines.push(`  • ${e.ticker}${name} [${timeLabel}]${meta ? ' — ' + meta : ''}`)
      }
    }
    parts.push(lines.join('\n'))
  } else {
    parts.push(`NO SCHEDULED EARNINGS for ${ctx.nextTradingDay} (per Finnhub calendar)`)
  }

  // After-hours movers from today's reporters
  if (ctx.afterHoursMovers.length > 0) {
    const lines = ctx.afterHoursMovers.map(m =>
      `  • ${m.ticker}: ${m.afterHoursChangePct >= 0 ? '+' : ''}${m.afterHoursChangePct.toFixed(2)}% AH (close $${m.closePrice.toFixed(2)} → $${m.afterHoursPrice.toFixed(2)})`
    )
    parts.push(`\nAFTER-HOURS MOVES ON TODAY'S REPORTERS:\n${lines.join('\n')}`)
  }

  // Economic events
  if (ctx.economicEvents.length > 0) {
    const lines = ctx.economicEvents.map(e => {
      const t = e.time ? ` at ${e.time}` : ''
      const forecast = e.forecast !== undefined ? `, forecast ${e.forecast}` : ''
      const prev = e.previous !== undefined ? `, prior ${e.previous}` : ''
      return `  • [${e.impact.toUpperCase()}] ${e.date}${t}: ${e.name}${forecast}${prev}`
    })
    parts.push(`\nECONOMIC EVENTS (US, medium+ impact):\n${lines.join('\n')}`)
  } else {
    parts.push('\nNO MAJOR US ECONOMIC EVENTS scheduled')
  }

  return parts.join('\n\n')
}

// ─────────────────────────────────────────────────────────────
// Per-ticker economic events context (Phase 1b)
// ─────────────────────────────────────────────────────────────
//
// Returns a compact text block of upcoming economic events relevant
// to the ticker being analyzed. Used by aggregator.ts to add an
// "ECONOMIC CALENDAR" section to the per-ticker bundle so Council
// stages know about upcoming high-impact events.
//
// Relevance rules:
//   - Forex pairs: include the central banks for BOTH currencies in
//     the pair, plus all high-impact US releases (since USD is in
//     most pairs).
//   - Equities/ETFs/crypto: include FOMC + high-impact US releases.
//     Foreign central banks generally don't move US equities meaningfully
//     intraday, so we skip ECB/BoJ/etc. for stocks to keep noise down.
//
// The window matches the analysis timeframe:
//   - 1D timeframe → next 5 days
//   - 1W timeframe → next 14 days
//   - 1M / 3M timeframes → next 14 days (we already cap at 14)

type AssetClass = 'equity' | 'forex' | 'crypto' | 'commodity' | 'unknown'

// Map forex ticker (e.g. "EURUSD") to the central banks that matter.
function centralBanksForForexPair(ticker: string): Set<CentralBankMeeting['bank']> {
  const t = ticker.toUpperCase().replace(/[^A-Z]/g, '')
  const banks = new Set<CentralBankMeeting['bank']>()
  // FOMC is relevant whenever USD is in the pair (almost always)
  if (t.includes('USD')) banks.add('FOMC')
  if (t.includes('EUR')) banks.add('ECB')
  if (t.includes('GBP')) banks.add('BoE')
  if (t.includes('JPY')) banks.add('BoJ')
  if (t.includes('CAD')) banks.add('BoC')
  if (t.includes('AUD')) banks.add('RBA')
  return banks
}

/**
 * Build a per-ticker economic calendar text block for the bundle.
 *
 * @param ticker        ticker symbol (e.g. "AAPL", "EURUSD", "BTCUSD")
 * @param assetClass    detected asset class
 * @param timeframe     analysis timeframe ('1D' | '1W' | '1M' | '3M')
 *                      controls how far forward to look
 * @returns formatted text block, or empty string if no relevant events
 */
export async function getEconomicCalendarContext(
  ticker: string,
  assetClass: AssetClass,
  timeframe: string = '1D',
): Promise<string> {
  const daysAhead = timeframe === '1D' ? 5 : 14
  const cbAll = buildCentralBankEvents(daysAhead)

  // Filter central bank events by asset class
  let cbFiltered: EconomicEvent[]
  if (assetClass === 'forex') {
    const relevantBanks = centralBanksForForexPair(ticker)
    cbFiltered = cbAll.filter(e => {
      // Event name format: "FOMC Meeting (...)"
      const bank = e.name.split(' ')[0] as CentralBankMeeting['bank']
      return relevantBanks.has(bank)
    })
  } else {
    // Equities/crypto/commodities: FOMC only (foreign central banks
    // typically don't move US assets enough to clutter the bundle)
    cbFiltered = cbAll.filter(e => e.name.startsWith('FOMC'))
  }

  // Also pull Finnhub-side US events (NFP, CPI, retail sales, etc.)
  // for everything. These matter for stocks/forex/crypto alike.
  const allEvents = await fetchEconomicCalendar()
  const cbInCombined = new Set(cbFiltered.map(e => `${e.name}|${e.date}`))
  const otherUsEvents = allEvents.filter(e => {
    // Skip central bank events (we filter those separately above)
    if (/^(FOMC|ECB|BoE|BoJ|BoC|RBA)\s/i.test(e.name)) return false
    // Limit non-CB events to high+medium impact and within window
    const eventDate = new Date(e.date + 'T00:00:00Z')
    const horizon = new Date(todayStr() + 'T00:00:00Z')
    horizon.setUTCDate(horizon.getUTCDate() + daysAhead)
    return eventDate <= horizon
  })

  const finalEvents = [...cbFiltered, ...otherUsEvents]
    .filter(e => !cbInCombined.has(`${e.name}|${e.date}`) || cbFiltered.includes(e))
  if (finalEvents.length === 0) return ''

  // Sort by date and format
  finalEvents.sort((a, b) => a.date.localeCompare(b.date))

  // Compute days-until for each event (helps the Council weight imminence)
  const today = new Date(todayStr() + 'T00:00:00Z')
  const lines: string[] = [
    '=== ECONOMIC CALENDAR — UPCOMING HIGH-IMPACT EVENTS ===',
    'Central bank decisions and major data releases that may affect this asset within the timeframe.',
    'Events within 24-48h are BINARY CATALYSTS — size and confidence should reflect that.',
    '',
  ]
  for (const e of finalEvents.slice(0, 15)) {
    const eventDate = new Date(e.date + 'T00:00:00Z')
    const daysUntil = Math.round((eventDate.getTime() - today.getTime()) / 86_400_000)
    const dayLabel = daysUntil === 0 ? 'TODAY' : daysUntil === 1 ? 'TOMORROW' : `in ${daysUntil}d`
    const impactTag = e.impact === 'high' ? '[HIGH]' : e.impact === 'medium' ? '[MED]' : '[LOW]'
    const fc = e.forecast !== undefined ? ` forecast ${e.forecast}` : ''
    const pr = e.previous !== undefined ? ` prior ${e.previous}` : ''
    lines.push(`  • ${impactTag} ${e.date} (${dayLabel}): ${e.name}${fc}${pr}`)
  }

  return lines.join('\n')
}
