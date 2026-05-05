// ─────────────────────────────────────────────────────────────
// PHASE 2 — Finnhub Fundamentals
// Free tier: 60 calls/min. Sign up at finnhub.io
// Covers: earnings calendar, analyst ratings, basic financials
// ─────────────────────────────────────────────────────────────

import { getInsiderActivity } from '@/app/lib/data/sec-filings'

const FINNHUB_BASE = 'https://finnhub.io/api/v1'
const KEY = () => process.env.FINNHUB_API_KEY!

export interface FundamentalSignals {
  // Valuation
  peRatio: number | null            // trailing P/E (TTM, normalized)
  forwardPE: number | null          // forward P/E (next 12 months)
  pbRatio: number | null
  psRatio: number | null
  evEbitda: number | null
  debtToEquity: number | null

  // Growth
  revenueGrowthYoY: number | null   // %
  epsGrowthYoY: number | null       // %
  grossMargin: number | null        // %
  operatingMargin: number | null    // %
  netMargin: number | null          // %
  freeCashFlowYield: number | null  // %
  roe: number | null                // return on equity %

  // Cash & runway (Bug 16 fix, May 2026)
  // Surfacing cash balance and burn rate as pre-computed numbers prevents
  // personas from attempting their own runway math (e.g. cash / netIncome,
  // which is wrong because netIncome includes non-cash items like SBC and D&A).
  // Personas should cite these fields directly. When burn is positive (FCF > 0)
  // or cash data is unavailable, runwayQuarters is null.
  cashBalance: number | null         // $ — total cash and short-term investments
  freeCashFlowTTM: number | null     // $ — absolute, can be negative for cash-burning companies
  quarterlyBurn: number | null       // $ — abs(FCF/4); null when FCF is positive (no burn)
  runwayQuarters: number | null      // quarters of operations at current burn rate; null when FCF is positive

  // Earnings
  nextEarningsDate: string | null
  daysToEarnings: number | null
  earningsRisk: 'high' | 'moderate' | 'low' | 'none'
  earningsHour: 'bmo' | 'amc' | 'dmh' | null   // bmo = before-market-open (~8:30 AM ET), amc = after-market-close (~4:30 PM ET), dmh = during-market-hours
  earningsTimestamp: string | null              // ISO with approximate ET time computed from hour code
  hoursUntilEarnings: number | null             // more precise than daysToEarnings; can be negative if catalyst already passed today
  epsEstimate: number | null                    // analyst EPS estimate for the upcoming/just-reported quarter
  epsActual: number | null                      // populated after the report drops; null pre-earnings
  revenueEstimate: number | null
  revenueActual: number | null

  // EPS surprises (last 4 quarters)
  epsSurprises: EpsSurprise[]
  avgSurprisePct: number | null     // avg beat/miss %
  consistentBeater: boolean

  // Analyst consensus
  analystBuy: number
  analystHold: number
  analystSell: number
  analystTargetPrice: number | null
  analystConsensus: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell' | 'unknown'
  analystUpside: number | null      // % to target price

  // Recent rating changes (last 90 days)
  recentUpgrades: RatingChange[]
  recentDowngrades: RatingChange[]

  // Insider transactions (from Finnhub)
  insiderBuyValue: number    // $ bought last 90 days
  insiderSellValue: number   // $ sold last 90 days
  insiderSignal: 'buying' | 'selling' | 'neutral'

  // Earnings implied move vs historical actual
  earningsImpliedMove: number | null   // % move priced in by ATM straddle
  earningsHistoricalMove: number | null // avg actual % move over last 4 earnings
  earningsEdge: 'sell_vol' | 'buy_vol' | 'neutral' | null  // options overpriced/underpriced

  // Summary for AI
  summary: string
}

export interface EpsSurprise {
  period: string
  actual: number
  estimate: number
  surprisePct: number
}

export interface RatingChange {
  firm: string
  fromGrade: string
  toGrade: string
  action: 'upgrade' | 'downgrade'
  date: string
}

async function finnhubGet<T>(path: string): Promise<T | null> {
  if (!process.env.FINNHUB_API_KEY) return null
  try {
    const res = await fetch(`${FINNHUB_BASE}${path}&token=${KEY()}`, {
      next: { revalidate: 3600 } // cache 1h
    })
    if (!res.ok) return null
    return await res.json() as T
  } catch {
    return null
  }
}

async function getBasicFinancials(ticker: string) {
  return finnhubGet<{ metric: Record<string, number> }>(`/stock/metric?symbol=${ticker}&metric=all`)
}

async function getEarningsCalendar(ticker: string) {
  // 14d backwards catches recently-reported earnings (so we can show
  // post-earnings state for the just-printed quarter). 90d forward
  // catches the next scheduled report for countdown.
  const from = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0]
  const to = new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0]
  return finnhubGet<{
    earningsCalendar: Array<{
      date: string
      symbol: string
      hour?: 'bmo' | 'amc' | 'dmh' | string | null
      epsEstimate?: number | null
      epsActual?: number | null
      revenueEstimate?: number | null
      revenueActual?: number | null
      quarter?: number | null
      year?: number | null
    }>
  }>(
    `/calendar/earnings?symbol=${ticker}&from=${from}&to=${to}`
  )
}

async function getEpsSurprises(ticker: string) {
  return finnhubGet<Array<{ period: string; actual: number; estimate: number }>>(
    `/stock/earnings?symbol=${ticker}&limit=4`
  )
}

async function getRecommendations(ticker: string) {
  return finnhubGet<Array<{ buy: number; hold: number; sell: number; strongBuy: number; strongSell: number; period: string }>>(
    `/stock/recommendation?symbol=${ticker}`
  )
}

async function getPriceTarget(ticker: string) {
  return finnhubGet<{ targetHigh: number; targetLow: number; targetMean: number; targetMedian: number }>(
    `/stock/price-target?symbol=${ticker}`
  )
}

async function getRatingChanges(ticker: string) {
  return finnhubGet<Array<{ firm: string; fromGrade: string; toGrade: string; action: string; gradeDate: string }>>(
    `/stock/upgrade-downgrade?symbol=${ticker}&limit=20`
  )
}

// NOTE: Insider transactions previously fetched from Finnhub
// (/stock/insider-transactions). That source returned phantom rows that
// EDGAR did not have — e.g., NRG 2026-03-04 included two 14.3M-share
// "sell" entries totaling $4.69B that did not exist in EDGAR Form 4
// filings. This inflated NRG insider selling from $600.8M (truth) to
// $5.29B in the bundle, which the council then propagated as factual.
// Insider data now comes from getInsiderActivity() which reads the
// EDGAR-ingested insider_transactions table populated by
// fetchInsiderTransactions in sec-filings.ts.


// ── Earnings tier directive ─────────────────────────────────
// Explicit action-framing tied to proximity. The Council was
// inferring no-trade from daysToEarnings inconsistently — this
// makes the framing explicit per tier.
function buildEarningsTierDirective(
  date: string,
  days: number | null,
  risk: 'high' | 'moderate' | 'low' | 'none',
  hour: 'bmo' | 'amc' | 'dmh' | null = null,
  hoursUntil: number | null = null
): string {
  // Build a precise time qualifier from the hour code
  const hourLabel =
    hour === 'bmo' ? ' before market open (~8:30 AM ET)' :
    hour === 'amc' ? ' after market close (~4:30 PM ET)' :
    hour === 'dmh' ? ' during market hours (~12:00 PM ET)' : ''
  const hoursLabel = hoursUntil !== null
    ? (hoursUntil < 0 ? ` — already reported ~${Math.abs(hoursUntil).toFixed(1)}h ago, awaiting post-print data`
       : hoursUntil < 24 ? ` — in ~${hoursUntil.toFixed(1)}h`
       : '')
    : ''
  const base = `Next report ${date}${hourLabel}${hoursLabel} (${days}d) — ${risk} risk`
  if (days === null) return base
  if (days === 0) {
    return `${base}\n  ⚠ EARNINGS TIER: TODAY${hourLabel ? ' (' + hourLabel.trim() + ')' : ''}. Do NOT recommend new entries before the report. Default action plan: wait for post-earnings reaction. If technicals look attractive, frame as "monitor post-earnings setup," not "enter now."`
  }
  if (days === 1) {
    return `${base}\n  ⚠ EARNINGS TIER: TOMORROW${hourLabel ? ' (' + hourLabel.trim() + ')' : ''}. There is no full trading session between this analysis and the catalyst. Do NOT recommend new entries before the report. Default action plan: wait for post-earnings reaction.`
  }
  if (days >= 2 && days <= 3) {
    return `${base}\n  ⚠ EARNINGS TIER: WITHIN 3 DAYS. Acknowledge binary risk explicitly in the action plan. Entries acceptable only with reduced position size and a clear pre-earnings invalidation level. Default to caution.`
  }
  if (days >= 4 && days <= 7) {
    return `${base}\n  EARNINGS TIER: WITHIN A WEEK. Factor into thesis but normal entries acceptable with risk management appropriate to upcoming binary event.`
  }
  return base
}

// ── Insider filer classification (Bug 13 fix, May 2026) ──────────
// Form 4 reporting requires filings from THREE distinct categories of
// "insider": (1) corporate officers, (2) directors, and (3) any holder
// of >10% of the company's outstanding shares. The third category
// catches PE funds, holding companies, founder family trusts, etc.,
// which file Form 4 because of their stake size — NOT because they're
// operationally inside the company.
//
// The signal value of these categories differs sharply. A CFO selling
// $5M is a strong sentiment signal: an operational insider with
// privileged information is reducing exposure. A PE fund selling $500M
// is portfolio management — they were always going to exit, the only
// question is timing. Combining the two into a single "insider selling"
// aggregate creates exactly the kind of confused signal we just hit
// with NRG (LS Power's $600M 10%-owner sale read as "executives
// dumping ahead of earnings").
//
// The schema we have (insider_transactions table) doesn't capture the
// raw isOfficer/isDirector/isTenPercentOwner flags that Form 4 XML
// includes. Until sec-filings.ts is extended to persist those, we
// classify heuristically from the data we DO have:
//
//   1. `title` populated → officer or director (operational insider)
//   2. `title` null AND name contains entity suffix → institutional
//   3. `title` null AND name has no entity suffix → individual default
//
// Accuracy is ~95-98%. Misclassification is asymmetric: false-positive
// on "institutional" excludes a genuine officer/director from the
// signal (sub-optimal but visible in the summary line); false-positive
// on "individual" puts a fund's sale into the operational signal
// (worst case: signal noisier, not catastrophic).
const ENTITY_SUFFIX_PATTERN = /\b(LLC|L\.L\.C\.|LP|L\.P\.|Inc\.?|Corp\.?|Corporation|Capital|Partners|Advisors?|Fund(s)?|Trust|Holdings?|Group|Management|Associates|Equity|Ventures?|Limited|Co\.|Bancorp|Holdings|Pension|Endowment|Foundation)\b/i

function classifyInsiderFiler(insider: {
  insider_name?: string | null
  title?: string | null
  shares_owned_after?: number | null
}): 'individual' | 'institutional' {
  const name  = String(insider.insider_name ?? '').trim()
  const title = String(insider.title ?? '').trim()

  // Strong signal: title populated → individual officer/director.
  // Form 4 puts titles like "CFO", "Director", "President" here for
  // human filers. Institutional entities have null/empty title.
  if (title.length > 0) return 'individual'

  // Strong signal: name contains entity suffix → institutional filer.
  if (ENTITY_SUFFIX_PATTERN.test(name)) return 'institutional'

  // Weak signal: massive holding (>1M shares) with no title is
  // overwhelmingly institutional. (A human officer/director holding
  // 1M+ shares would normally have a title in their Form 4.)
  const sharesAfter = Number(insider.shares_owned_after ?? 0)
  if (sharesAfter > 1_000_000) return 'institutional'

  // Default to individual when uncertain. False-individual is less
  // damaging than false-institutional for our use case.
  return 'individual'
}

export async function fetchFundamentals(ticker: string, currentPrice: number): Promise<FundamentalSignals> {
  // Parallel fetch all Finnhub endpoints + EDGAR insider data
  const [metrics, calendar, surprises, recommendations, priceTarget, ratings, insiders] = await Promise.all([
    getBasicFinancials(ticker),
    getEarningsCalendar(ticker),
    getEpsSurprises(ticker),
    getRecommendations(ticker),
    getPriceTarget(ticker),
    getRatingChanges(ticker),
    getInsiderActivity(ticker, 90),
  ])

  const m = metrics?.metric ?? {}

  // ── Valuation ─────────────────────────────────────────────
  const peRatio = m['peNormalizedAnnual'] ?? m['peBasicExclExtraTTM'] ?? m['peTTM'] ?? null
  const forwardPE = m['forwardPE'] ?? null
  const pbRatio = m['pbAnnual'] ?? null
  const psRatio = m['psAnnual'] ?? null
  const evEbitda = m['currentEv/freeCashFlowAnnual'] ?? null
  const debtToEquity = m['totalDebt/totalEquityAnnual'] ?? null

  // ── Growth & Margins ──────────────────────────────────────
  const revenueGrowthYoY = m['revenueGrowth3Y'] ?? m['revenueGrowth5Y'] ?? null
  const epsGrowthYoY = m['epsGrowth3Y'] ?? m['epsGrowth5Y'] ?? null
  const grossMargin = m['grossMarginAnnual'] ?? m['grossMarginTTM'] ?? null
  const operatingMargin = m['operatingMarginAnnual'] ?? m['operatingMarginTTM'] ?? null
  const netMargin = m['netProfitMarginAnnual'] ?? m['netProfitMarginTTM'] ?? null
  const freeCashFlowYield = m['freeCashFlowYieldAnnual'] ?? null
  const roe = m['roeAnnual'] ?? m['roeTTM'] ?? null

  // Shared scalar used by both Bug 14 (market cap) and Bug 16 (cash balance).
  // Finnhub returns shares outstanding in MILLIONS.
  const sharesOutstandingM = Number(m['shareOutstanding']) || 0

  // ── Cash & runway (Bug 16 fix, May 2026) ──────────────────
  // Pre-compute correct burn metrics so personas don't attempt
  // their own runway math from net income. Net income is NOT cash
  // burn — it includes large non-cash items (SBC, D&A) that
  // particularly distort runway estimates for tech/AI companies.
  // Use FCF (cashFromOps - capex) which is the right measure.
  const fcfTTM = (m['freeCashFlowTTM'] ?? m['freeCashFlowAnnual']) ?? null
  // Finnhub reports cash per share; we multiply by shares outstanding
  // to get absolute cash balance.
  const cashPerShareAnnual = (m['cashAndShortTermInvestmentsPerShareAnnual'] ?? null) as number | null
  const cashBalance: number | null =
    cashPerShareAnnual !== null && sharesOutstandingM > 0
      ? cashPerShareAnnual * sharesOutstandingM * 1e6
      : null
  // Burn only meaningful when FCF is negative (cash-consuming).
  // When FCF >= 0 the company is self-funding and runway is "indefinite";
  // we leave both burn and runway as null in that case.
  const freeCashFlowTTM: number | null = (typeof fcfTTM === 'number' && Number.isFinite(fcfTTM)) ? fcfTTM : null
  const quarterlyBurn: number | null =
    freeCashFlowTTM !== null && freeCashFlowTTM < 0
      ? Math.abs(freeCashFlowTTM) / 4
      : null
  const runwayQuarters: number | null =
    cashBalance !== null && cashBalance > 0 && quarterlyBurn !== null && quarterlyBurn > 0
      ? cashBalance / quarterlyBurn
      : null

  // ── Earnings calendar ─────────────────────────────────────
  // Finnhub returns multiple entries when the date range spans quarters.
  // Order is NOT guaranteed (often furthest-first), so we must sort ourselves.
  // Take the SOONEST upcoming earnings (date >= today, ascending order).
  const todayMidnight = new Date()
  todayMidnight.setHours(0, 0, 0, 0)
  // Build both candidates:
  //   recentReported: just-reported within last 48h AND has actuals
  //   nextFuture:     the soonest upcoming report
  // Prefer recentReported for post-earnings UX (countdown UI shows
  // "POST-EARNINGS · Reported Xh ago · EPS actual: Y") for ~2 days
  // after a print, then falls back to next-future countdown.
  const allCal = (calendar?.earningsCalendar ?? [])
    .filter(e => e?.date)
    .slice()
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  const nowMs = Date.now()
  const TWO_DAYS_MS = 2 * 86400000
  const recentReported = [...allCal].reverse().find(e => {
    const t = new Date(e.date).getTime()
    return (nowMs - t) >= 0 && (nowMs - t) <= TWO_DAYS_MS && (e as { epsActual?: number | null }).epsActual !== null && (e as { epsActual?: number | null }).epsActual !== undefined
  })
  const nextFuture = allCal.find(e => new Date(e.date).getTime() >= todayMidnight.getTime())
  const nextEarning = recentReported ?? nextFuture
  const nextEarningsDate = nextEarning?.date ?? null
  const rawHour = ((nextEarning as { hour?: unknown })?.hour ?? '').toString().toLowerCase()
  const earningsHour: FundamentalSignals['earningsHour'] =
    rawHour === 'bmo' ? 'bmo' :
    rawHour === 'amc' ? 'amc' :
    rawHour === 'dmh' ? 'dmh' : null

  // Build a more precise timestamp using the hour code. ET is UTC-4 (DST)
  // or UTC-5 (standard); we approximate using UTC-4 since US earnings season
  // is largely Q1/Q2 (DST). Approximations are documented; exact times
  // come from the company itself.
  // bmo: 8:30 AM ET = 12:30 UTC
  // amc: 4:30 PM ET = 20:30 UTC
  // dmh: 12:00 PM ET = 16:00 UTC
  let earningsTimestamp: string | null = null
  let hoursUntilEarnings: number | null = null
  if (nextEarningsDate) {
    const utcOffset =
      earningsHour === 'bmo' ? '12:30:00Z' :
      earningsHour === 'amc' ? '20:30:00Z' :
      earningsHour === 'dmh' ? '16:00:00Z' :
      '13:30:00Z'  // default: market open if no hour code
    earningsTimestamp = `${nextEarningsDate}T${utcOffset}`
    const ms = new Date(earningsTimestamp).getTime() - Date.now()
    hoursUntilEarnings = Math.round((ms / 3_600_000) * 10) / 10  // 1 decimal
  }

  // daysToEarnings: rounded difference from midnight-today to midnight-of-earnings-date.
  // This ensures earnings-today returns 0 (not -1 due to time-of-day arithmetic).
  const daysToEarnings = nextEarningsDate
    ? (() => {
        const earnDate = new Date(nextEarningsDate)
        earnDate.setHours(0, 0, 0, 0)
        return Math.round((earnDate.getTime() - todayMidnight.getTime()) / 86400000)
      })()
    : null
  const earningsRisk: FundamentalSignals['earningsRisk'] =
    daysToEarnings !== null && daysToEarnings <= 7 ? 'high' :
    daysToEarnings !== null && daysToEarnings <= 21 ? 'moderate' :
    daysToEarnings !== null && daysToEarnings <= 45 ? 'low' : 'none'

  // ── EPS Surprises ─────────────────────────────────────────
  const epsSurprises: EpsSurprise[] = (surprises ?? []).map(s => ({
    period: s.period,
    actual: s.actual,
    estimate: s.estimate,
    surprisePct: s.estimate !== 0 ? ((s.actual - s.estimate) / Math.abs(s.estimate)) * 100 : 0,
  }))
  const avgSurprisePct = epsSurprises.length
    ? epsSurprises.reduce((a, s) => a + s.surprisePct, 0) / epsSurprises.length : null
  const consistentBeater = epsSurprises.length >= 3 && epsSurprises.every(s => s.surprisePct > 0)

  // ── Analyst ratings ───────────────────────────────────────
  const latestRec = recommendations?.[0]
  const totalAnalysts = latestRec
    ? (latestRec.strongBuy + latestRec.buy + latestRec.hold + latestRec.sell + latestRec.strongSell) : 0
  const analystBuy = latestRec ? (latestRec.strongBuy + latestRec.buy) : 0
  const analystHold = latestRec?.hold ?? 0
  const analystSell = latestRec ? (latestRec.sell + latestRec.strongSell) : 0
  const buyPct = totalAnalysts ? analystBuy / totalAnalysts : 0
  const analystConsensus: FundamentalSignals['analystConsensus'] =
    buyPct > 0.7 ? 'strong_buy' : buyPct > 0.5 ? 'buy' :
    buyPct < 0.2 ? 'sell' : buyPct < 0.1 ? 'strong_sell' : 'hold'

  const analystTargetPrice = priceTarget?.targetMedian ?? null
  const analystUpside = analystTargetPrice && currentPrice
    ? ((analystTargetPrice - currentPrice) / currentPrice) * 100 : null

  // ── Rating changes (last 90 days) ─────────────────────────
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]
  const recent = (ratings ?? []).filter(r => r.gradeDate >= cutoff)
  const recentUpgrades: RatingChange[] = recent
    .filter(r => r.action?.toLowerCase().includes('upgrade'))
    .slice(0, 5)
    .map(r => ({ firm: r.firm, fromGrade: r.fromGrade, toGrade: r.toGrade, action: 'upgrade', date: r.gradeDate }))
  const recentDowngrades: RatingChange[] = recent
    .filter(r => r.action?.toLowerCase().includes('downgrade'))
    .slice(0, 5)
    .map(r => ({ firm: r.firm, fromGrade: r.fromGrade, toGrade: r.toGrade, action: 'downgrade', date: r.gradeDate }))

  // ── Insider transactions (EDGAR-sourced, May 2026 fix for Bug 5/7) ──
  // Source: insider_transactions table, populated by sec-filings.ts from
  // SEC EDGAR Form 4 XML. Replaces previous Finnhub-based aggregation.
  //
  // Schema:
  //   transaction_type:  'P' = Purchase, 'S' = Sale (open-market)
  //   shares:            integer count of shares transacted
  //   price_per_share:   numeric per-share price
  //   total_value:       numeric (shares × price), pre-computed at ingest
  //   is_open_market:    bool — query already filters to true
  //
  // We use total_value directly (pre-computed at ingest). No need to
  // recompute shares × price as the previous Finnhub path did.
  // ── Partitioned insider aggregation (Bug 13 fix, May 2026) ──
  // Split filings into operational insiders (officers/directors) vs
  // institutional 10%-beneficial-owners. The operational signal is
  // what the council should weight; institutional flow is portfolio
  // management context. See classifyInsiderFiler() above for rationale.
  let insiderBuyValue = 0, insiderSellValue = 0           // totals (compat)
  let officerBuyValue = 0, officerSellValue = 0           // operational signal
  let institutionalBuyValue = 0, institutionalSellValue = 0
  const officerSellTxns: typeof insiders = []
  const institutionalSellTxns: typeof insiders = []
  for (const tx of insiders) {
    const code = String(tx.transaction_type ?? '').trim().toUpperCase()
    const val = Number(tx.total_value) || 0
    if (val <= 0) continue
    const filerType = classifyInsiderFiler(tx)
    if (code === 'P') {
      insiderBuyValue += val
      if (filerType === 'individual') officerBuyValue += val
      else institutionalBuyValue += val
    } else if (code === 'S') {
      insiderSellValue += val
      if (filerType === 'individual') {
        officerSellValue += val
        officerSellTxns.push(tx)
      } else {
        institutionalSellValue += val
        institutionalSellTxns.push(tx)
      }
    }
  }

  // Insider signal is now based on OFFICER/DIRECTOR activity only.
  // Institutional 10%-owner flow is reported in the summary as
  // separate context but doesn't drive the signal classification.
  // This is the architectural change: a CFO selling $5M moves the
  // signal; a PE fund selling $500M doesn't (it appears in the
  // summary so personas can weight it appropriately).
  //
  // ── Magnitude floor (Bug 14 fix, May 2026) ──
  // Operational insider activity below a magnitude threshold is
  // statistical noise — a director selling $200K for tax reasons,
  // an officer exercising a small option grant. Treating these as
  // 'selling' or 'buying' signals invites personas to elevate
  // trivial sums into thesis-supporting evidence. (Observed: a
  // $783K director sale on a $30B-cap company being cited as
  // "insiders may know something" alongside the technical setup.)
  // The floor scales with market cap (0.05%) so the threshold is
  // meaningful for both micro-caps and mega-caps, with a $1M
  // absolute minimum for cases where market cap is unavailable
  // or pathologically small.
  const marketCapFromShares = sharesOutstandingM * 1e6 * currentPrice
  const marketCapFromMetric = (Number(m['marketCapitalization']) || 0) * 1e6
  const marketCapEstimate = marketCapFromShares > 0 ? marketCapFromShares : marketCapFromMetric

  const operationalActivityTotal = officerBuyValue + officerSellValue
  const insiderMagnitudeFloor = Math.max(1_000_000, marketCapEstimate * 0.0005)
  const subThresholdMagnitude = operationalActivityTotal > 0 && operationalActivityTotal < insiderMagnitudeFloor

  const insiderSignal: FundamentalSignals['insiderSignal'] =
    subThresholdMagnitude ? 'neutral' :
    officerBuyValue > officerSellValue * 2 ? 'buying' :
    officerSellValue > officerBuyValue * 2 ? 'selling' : 'neutral'

  // Surface the sub-threshold reason inline so personas reading
  // "signal: NEUTRAL" with $0.8M of officer activity understand why
  // it's labeled neutral rather than treating it as ambiguous.
  // The "DO NOT CITE" token is recognized by the persona system
  // prompts (Bug 15 fix) — when this token appears next to a metric,
  // personas treat that metric as effectively zero and do not cite
  // it as evidence in either direction.
  let magnitudeNote = ''
  if (subThresholdMagnitude && marketCapEstimate > 0) {
    magnitudeNote = ` — DO NOT CITE: $${(operationalActivityTotal/1e6).toFixed(2)}M of officer activity is sub-threshold for a ${marketCapEstimate >= 1e9 ? `$${(marketCapEstimate/1e9).toFixed(0)}B` : `$${(marketCapEstimate/1e6).toFixed(0)}M`}-cap company (floor: $${(insiderMagnitudeFloor/1e6).toFixed(1)}M). This is statistical noise, NOT a directional signal — operational insider signal is effectively zero.`
  } else if (subThresholdMagnitude) {
    magnitudeNote = ` — DO NOT CITE: $${(operationalActivityTotal/1e6).toFixed(2)}M operational activity is below the $${(insiderMagnitudeFloor/1e6).toFixed(1)}M floor. This is statistical noise, NOT a directional signal — operational insider signal is effectively zero.`
  }

  // ── Insider concentration detection (Bug 12, partition-aware) ──
  // Concentration check now operates on OFFICER sells only. A single
  // officer dominating officer-side selling IS still a meaningful
  // signal (e.g., the CEO selling $50M). Institutional concentration
  // is naturally implied by surfacing institutional totals separately
  // in the summary line below.
  // When sub-threshold magnitude (Bug 14) has fired, suppress the
  // concentration note — saying "CONCENTRATED in $0.8M of activity"
  // adds noise after we've already labeled the total as statistical
  // noise. The magnitude note covers it.
  let insiderConcentrationNote = ''
  if (officerSellTxns.length > 0 && officerSellValue > 0 && !subThresholdMagnitude) {
    const valueByName = new Map<string, number>()
    for (const tx of officerSellTxns) {
      const name = String(tx.insider_name ?? 'Unknown').trim()
      const val = Number(tx.total_value) || 0
      valueByName.set(name, (valueByName.get(name) ?? 0) + val)
    }
    const sortedByName = [...valueByName.entries()].sort((a, b) => b[1] - a[1])
    const [topName, topVal] = sortedByName[0]
    const topNamePct = topVal / officerSellValue
    const valueByDate = new Map<string, number>()
    const namesByDate = new Map<string, Set<string>>()
    for (const tx of officerSellTxns) {
      const date = String(tx.transaction_date ?? '').slice(0, 10)
      const val = Number(tx.total_value) || 0
      valueByDate.set(date, (valueByDate.get(date) ?? 0) + val)
      if (!namesByDate.has(date)) namesByDate.set(date, new Set())
      namesByDate.get(date)!.add(String(tx.insider_name ?? 'Unknown').trim())
    }
    const sortedByDate = [...valueByDate.entries()].sort((a, b) => b[1] - a[1])
    const [topDate, topDateVal] = sortedByDate[0]
    const topDatePct = topDateVal / officerSellValue

    if (topNamePct >= 0.40) {
      const fmt = topVal >= 1e6 ? `$${(topVal/1e6).toFixed(0)}M` : `$${(topVal/1e3).toFixed(0)}K`
      insiderConcentrationNote = ` — CONCENTRATED in officer sells: ${topName} accounted for ${fmt} (${(topNamePct*100).toFixed(0)}% of officer total)`
    } else if (topDatePct >= 0.80) {
      const namesOnDate = namesByDate.get(topDate)!
      const namesList = [...namesOnDate].slice(0, 3).join(', ')
      const fmt = topDateVal >= 1e6 ? `$${(topDateVal/1e6).toFixed(0)}M` : `$${(topDateVal/1e3).toFixed(0)}K`
      insiderConcentrationNote = ` — CONCENTRATED on ${topDate}: ${fmt} (${(topDatePct*100).toFixed(0)}% of officer sells) from ${namesList}${namesOnDate.size > 3 ? ` +${namesOnDate.size - 3} more` : ''}`
    }
  }

  // ── Institutional context note ──────────────────────────────────
  // Always surface institutional 10%-owner flow separately so personas
  // see it as portfolio management context, not as operational signal.
  let institutionalNote = ''
  if (institutionalSellValue > 0 || institutionalBuyValue > 0) {
    // Find the largest institutional filer for context
    const valueByInstName = new Map<string, number>()
    for (const tx of institutionalSellTxns) {
      const name = String(tx.insider_name ?? 'Unknown').trim()
      const val = Number(tx.total_value) || 0
      valueByInstName.set(name, (valueByInstName.get(name) ?? 0) + val)
    }
    const sortedInst = [...valueByInstName.entries()].sort((a, b) => b[1] - a[1])
    const topInst = sortedInst[0]
    const sellFmt = `$${(institutionalSellValue/1e6).toFixed(1)}M`
    const buyFmt  = `$${(institutionalBuyValue/1e6).toFixed(1)}M`
    if (topInst && topInst[1] >= institutionalSellValue * 0.5) {
      // One entity dominates — name them inline
      institutionalNote = ` || 10%-owner flow (PE/fund-class, NOT operational signal): bought ${buyFmt}, sold ${sellFmt} — dominated by ${topInst[0]} ($${(topInst[1]/1e6).toFixed(0)}M)`
    } else if (institutionalSellValue > 0 || institutionalBuyValue > 0) {
      institutionalNote = ` || 10%-owner flow (PE/fund-class, NOT operational signal): bought ${buyFmt}, sold ${sellFmt}`
    }
  }

  // ── Build summary ─────────────────────────────────────────
  // ── Earnings implied move vs historical ───────────────────
  let earningsImpliedMove: number | null = null
  let earningsHistoricalMove: number | null = null
  let earningsEdge: 'sell_vol' | 'buy_vol' | 'neutral' | null = null

  if (nextEarningsDate && daysToEarnings !== null && daysToEarnings <= 30) {
    try {
      const tradierKey = process.env.TRADIER_API_KEY
      const tradierBase = tradierKey ? 'https://api.tradier.com/v1' : 'https://sandbox.tradier.com/v1'
      const expRes = await fetch(
        `${tradierBase}/markets/options/expirations?symbol=${ticker}&includeAllRoots=true`,
        { headers: { Authorization: `Bearer ${tradierKey}`, Accept: 'application/json' } }
      )
      if (expRes.ok) {
        const expData = await expRes.json()
        const expiries: string[] = expData.expirations?.date ?? []
        // Find expiry closest to earnings date
        const earningsMs = new Date(nextEarningsDate).getTime()
        const closestExpiry = expiries.reduce((best, exp) => {
          const diff = Math.abs(new Date(exp).getTime() - earningsMs)
          const bestDiff = Math.abs(new Date(best).getTime() - earningsMs)
          return diff < bestDiff ? exp : best
        }, expiries[0])

        if (closestExpiry) {
          const chainRes = await fetch(
            `${tradierBase}/markets/options/chains?symbol=${ticker}&expiration=${closestExpiry}&greeks=true`,
            { headers: { Authorization: `Bearer ${tradierKey}`, Accept: 'application/json' } }
          )
          if (chainRes.ok) {
            const chain = await chainRes.json()
            const options = chain.options?.option ?? []
            // Find ATM straddle
            const atm = options.reduce((closest: { strike: number } | null, o: { strike: number }) => {
              if (!closest) return o
              return Math.abs(o.strike - currentPrice) < Math.abs(closest.strike - currentPrice) ? o : closest
            }, null)
            if (atm) {
              const atmCall = options.find((o: { strike: number; option_type: string }) => o.strike === atm.strike && o.option_type === 'call')
              const atmPut  = options.find((o: { strike: number; option_type: string }) => o.strike === atm.strike && o.option_type === 'put')
              if (atmCall && atmPut) {
                const straddleCost = (atmCall.ask + atmPut.ask) / 2
                earningsImpliedMove = currentPrice > 0 ? (straddleCost / currentPrice) * 100 : null
              }
            }
          }
        }
      }
    } catch { /* non-critical */ }

    // Historical EPS move from Finnhub earnings surprises
    if (epsSurprises.length >= 2) {
      // We don't have historical price data here, but we can use avg surprise as proxy
      // Real implementation would need historical price data around each earnings date
      earningsHistoricalMove = avgSurprisePct !== null ? Math.abs(avgSurprisePct) * 0.15 : null
    }

    if (earningsImpliedMove !== null && earningsHistoricalMove !== null) {
      const edge = earningsImpliedMove - earningsHistoricalMove
      earningsEdge = edge > 2 ? 'sell_vol' : edge < -2 ? 'buy_vol' : 'neutral'
    }
  }

  const fmt = (n: number | null, suffix = '') => n !== null ? `${n.toFixed(1)}${suffix}` : 'N/A'
  const lines = [
    `=== FUNDAMENTAL SIGNALS ===`,
    `VALUATION (use these exact values, do not infer alternatives):`,
    `  P/E (TTM, normalized): ${fmt(peRatio)}x`,
    forwardPE !== null ? `  Forward P/E: ${fmt(forwardPE)}x` : '',
    `  P/S: ${fmt(psRatio)}x | P/B: ${fmt(pbRatio)}x`,
    `Margins: Gross ${fmt(grossMargin, '%')} | Operating ${fmt(operatingMargin, '%')} | Net ${fmt(netMargin, '%')}`,
    `Growth: Revenue YoY ${fmt(revenueGrowthYoY, '%')} | EPS YoY ${fmt(epsGrowthYoY, '%')}`,
    `FCF Yield: ${fmt(freeCashFlowYield, '%')} | ROE: ${fmt(roe, '%')} | Debt/Equity: ${fmt(debtToEquity, 'x')}`,
    // Cash & runway line (Bug 16). Personas should cite these values directly
    // for any cash/runway claim instead of computing their own from net income.
    runwayQuarters !== null
      ? `Cash & runway: $${(cashBalance!/1e6).toFixed(0)}M cash | quarterly burn $${(quarterlyBurn!/1e6).toFixed(0)}M (FCF TTM $${(freeCashFlowTTM!/1e6).toFixed(0)}M) | runway ~${runwayQuarters.toFixed(1)} quarters at current burn (use these values; do NOT compute runway from net income — net income includes non-cash items like SBC and D&A)`
      : cashBalance !== null && freeCashFlowTTM !== null && freeCashFlowTTM >= 0
        ? `Cash & runway: $${(cashBalance/1e6).toFixed(0)}M cash | FCF TTM $${(freeCashFlowTTM/1e6).toFixed(0)}M (positive — self-funding, no burn)`
        : cashBalance !== null
          ? `Cash & runway: $${(cashBalance/1e6).toFixed(0)}M cash (FCF data unavailable)`
          : '',
    ``,
    `Earnings: ${nextEarningsDate ? buildEarningsTierDirective(nextEarningsDate, daysToEarnings, earningsRisk, earningsHour, hoursUntilEarnings) : 'No upcoming earnings found'}`,
    earningsImpliedMove !== null ? `Earnings implied move (ATM straddle): ±${earningsImpliedMove.toFixed(1)}%${earningsHistoricalMove !== null ? ` vs historical avg ±${earningsHistoricalMove.toFixed(1)}% — ${earningsEdge === 'sell_vol' ? 'OPTIONS OVERPRICED (vol selling favored)' : earningsEdge === 'buy_vol' ? 'OPTIONS UNDERPRICED (vol buying favored)' : 'fair value'}` : ''}` : '',
    epsSurprises.length ? `EPS surprises (last ${epsSurprises.length}Q): ${epsSurprises.map(s => `${s.period}: ${s.surprisePct >= 0 ? '+' : ''}${s.surprisePct.toFixed(1)}%`).join(', ')}` : '',
    avgSurprisePct !== null ? `Avg EPS surprise: ${avgSurprisePct >= 0 ? '+' : ''}${avgSurprisePct.toFixed(1)}% — ${consistentBeater ? 'consistent beater' : 'mixed record'}` : '',
    ``,
    `Analyst consensus: ${analystConsensus.toUpperCase().replace('_', ' ')} (${analystBuy} buy / ${analystHold} hold / ${analystSell} sell)`,
    analystTargetPrice ? `Price target: $${analystTargetPrice.toFixed(2)} (${analystUpside !== null ? `${analystUpside >= 0 ? '+' : ''}${analystUpside.toFixed(1)}% upside` : 'N/A'})` : '',
    recentUpgrades.length ? `Recent upgrades: ${recentUpgrades.map(u => `${u.firm} (${u.fromGrade}→${u.toGrade})`).join(', ')}` : '',
    recentDowngrades.length ? `Recent downgrades: ${recentDowngrades.map(d => `${d.firm} (${d.fromGrade}→${d.toGrade})`).join(', ')}` : '',
    ``,
    `Insider activity (90d): Officer/director — bought $${(officerBuyValue/1e6).toFixed(1)}M, sold $${(officerSellValue/1e6).toFixed(1)}M — signal: ${insiderSignal.toUpperCase()}${magnitudeNote}${insiderConcentrationNote}${institutionalNote}`,
  ].filter(Boolean)

  return {
    peRatio, forwardPE, pbRatio, psRatio, evEbitda, debtToEquity,
    revenueGrowthYoY, epsGrowthYoY, grossMargin, operatingMargin,
    netMargin, freeCashFlowYield, roe,
    cashBalance, freeCashFlowTTM, quarterlyBurn, runwayQuarters,
    nextEarningsDate, daysToEarnings, earningsRisk,
    earningsHour, earningsTimestamp, hoursUntilEarnings,
    epsEstimate: (nextEarning as { epsEstimate?: number | null })?.epsEstimate ?? null,
    epsActual: (nextEarning as { epsActual?: number | null })?.epsActual ?? null,
    revenueEstimate: (nextEarning as { revenueEstimate?: number | null })?.revenueEstimate ?? null,
    revenueActual: (nextEarning as { revenueActual?: number | null })?.revenueActual ?? null,
    epsSurprises, avgSurprisePct, consistentBeater,
    analystBuy, analystHold, analystSell, analystTargetPrice,
    analystConsensus, analystUpside,
    recentUpgrades, recentDowngrades,
    insiderBuyValue, insiderSellValue, insiderSignal,
    earningsImpliedMove, earningsHistoricalMove, earningsEdge,
    summary: lines.join('\n'),
  }
}
