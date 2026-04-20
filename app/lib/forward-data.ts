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
// 4. Economic calendar (Finnhub has it too)
// ─────────────────────────────────────────────────────────────
export async function fetchEconomicCalendar(): Promise<EconomicEvent[]> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return []

  const from = todayStr()
  const toDate = new Date(from + 'T00:00:00Z')
  toDate.setUTCDate(toDate.getUTCDate() + 3)
  const to = toDate.toISOString().split('T')[0]

  try {
    const res = await fetchWithTimeout(
      `${FINNHUB_BASE}/calendar/economic?from=${from}&to=${to}&token=${key}`,
      {}, 8000
    )
    if (!res || !res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data?.economicCalendar)) return []

    return (data.economicCalendar as Array<Record<string, unknown>>)
      .filter(e => {
        // Only US events, medium+ impact
        const country = typeof e.country === 'string' ? e.country : ''
        const impact = typeof e.impact === 'string' ? e.impact.toLowerCase() : ''
        return country === 'US' && (impact === 'high' || impact === 'medium')
      })
      .map(e => ({
        name: String(e.event ?? ''),
        date: String(e.time ?? '').split(' ')[0] || from,
        time: String(e.time ?? '').split(' ')[1] ?? undefined,
        impact: (String(e.impact ?? 'medium').toLowerCase() as 'high' | 'medium' | 'low'),
        actual: e.actual as string | number | undefined,
        forecast: e.estimate as string | number | undefined,
        previous: e.prev as string | number | undefined,
      }))
      .filter(e => e.name.length > 0)
      .slice(0, 20)
  } catch {
    return []
  }
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
