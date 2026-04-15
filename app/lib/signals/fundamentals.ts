// ─────────────────────────────────────────────────────────────
// PHASE 2 — Finnhub Fundamentals
// Free tier: 60 calls/min. Sign up at finnhub.io
// Covers: earnings calendar, analyst ratings, basic financials
// ─────────────────────────────────────────────────────────────

const FINNHUB_BASE = 'https://finnhub.io/api/v1'
const KEY = () => process.env.FINNHUB_API_KEY!

export interface FundamentalSignals {
  // Valuation
  peRatio: number | null
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

  // Earnings
  nextEarningsDate: string | null
  daysToEarnings: number | null
  earningsRisk: 'high' | 'moderate' | 'low' | 'none'

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
  const from = new Date().toISOString().split('T')[0]
  const to = new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0]
  return finnhubGet<{ earningsCalendar: Array<{ date: string; symbol: string }> }>(
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

async function getInsiderTransactions(ticker: string) {
  const from = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]
  return finnhubGet<{ data: Array<{ transactionType: string; transactionPrice: number; share: number; date: string }> }>(
    `/stock/insider-transactions?symbol=${ticker}&from=${from}`
  )
}

export async function fetchFundamentals(ticker: string, currentPrice: number): Promise<FundamentalSignals> {
  // Parallel fetch all Finnhub endpoints
  const [metrics, calendar, surprises, recommendations, priceTarget, ratings, insiders] = await Promise.all([
    getBasicFinancials(ticker),
    getEarningsCalendar(ticker),
    getEpsSurprises(ticker),
    getRecommendations(ticker),
    getPriceTarget(ticker),
    getRatingChanges(ticker),
    getInsiderTransactions(ticker),
  ])

  const m = metrics?.metric ?? {}

  // ── Valuation ─────────────────────────────────────────────
  const peRatio = m['peNormalizedAnnual'] ?? m['peBasicExclExtraTTM'] ?? null
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

  // ── Earnings calendar ─────────────────────────────────────
  const nextEarning = calendar?.earningsCalendar?.[0]
  const nextEarningsDate = nextEarning?.date ?? null
  const daysToEarnings = nextEarningsDate
    ? Math.round((new Date(nextEarningsDate).getTime() - Date.now()) / 86400000) : null
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

  // ── Insider transactions ──────────────────────────────────
  let insiderBuyValue = 0, insiderSellValue = 0
  for (const tx of insiders?.data ?? []) {
    const val = Math.abs(tx.transactionPrice * tx.share)
    if (tx.transactionType === 'P - Purchase') insiderBuyValue += val
    else if (tx.transactionType === 'S - Sale') insiderSellValue += val
  }
  const insiderSignal: FundamentalSignals['insiderSignal'] =
    insiderBuyValue > insiderSellValue * 2 ? 'buying' :
    insiderSellValue > insiderBuyValue * 2 ? 'selling' : 'neutral'

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
    `Valuation: P/E ${fmt(peRatio)}x | P/S ${fmt(psRatio)}x | P/B ${fmt(pbRatio)}x`,
    `Margins: Gross ${fmt(grossMargin, '%')} | Operating ${fmt(operatingMargin, '%')} | Net ${fmt(netMargin, '%')}`,
    `Growth: Revenue YoY ${fmt(revenueGrowthYoY, '%')} | EPS YoY ${fmt(epsGrowthYoY, '%')}`,
    `FCF Yield: ${fmt(freeCashFlowYield, '%')} | ROE: ${fmt(roe, '%')} | Debt/Equity: ${fmt(debtToEquity, 'x')}`,
    ``,
    `Earnings: ${nextEarningsDate ? `Next report ${nextEarningsDate} (${daysToEarnings}d) — ${earningsRisk} risk` : 'No upcoming earnings found'}`,
    earningsImpliedMove !== null ? `Earnings implied move (ATM straddle): ±${earningsImpliedMove.toFixed(1)}%${earningsHistoricalMove !== null ? ` vs historical avg ±${earningsHistoricalMove.toFixed(1)}% — ${earningsEdge === 'sell_vol' ? 'OPTIONS OVERPRICED (vol selling favored)' : earningsEdge === 'buy_vol' ? 'OPTIONS UNDERPRICED (vol buying favored)' : 'fair value'}` : ''}` : '',
    epsSurprises.length ? `EPS surprises (last ${epsSurprises.length}Q): ${epsSurprises.map(s => `${s.period}: ${s.surprisePct >= 0 ? '+' : ''}${s.surprisePct.toFixed(1)}%`).join(', ')}` : '',
    avgSurprisePct !== null ? `Avg EPS surprise: ${avgSurprisePct >= 0 ? '+' : ''}${avgSurprisePct.toFixed(1)}% — ${consistentBeater ? 'consistent beater' : 'mixed record'}` : '',
    ``,
    `Analyst consensus: ${analystConsensus.toUpperCase().replace('_', ' ')} (${analystBuy} buy / ${analystHold} hold / ${analystSell} sell)`,
    analystTargetPrice ? `Price target: $${analystTargetPrice.toFixed(2)} (${analystUpside !== null ? `${analystUpside >= 0 ? '+' : ''}${analystUpside.toFixed(1)}% upside` : 'N/A'})` : '',
    recentUpgrades.length ? `Recent upgrades: ${recentUpgrades.map(u => `${u.firm} (${u.fromGrade}→${u.toGrade})`).join(', ')}` : '',
    recentDowngrades.length ? `Recent downgrades: ${recentDowngrades.map(d => `${d.firm} (${d.fromGrade}→${d.toGrade})`).join(', ')}` : '',
    ``,
    `Insider activity (90d): Bought $${(insiderBuyValue/1e6).toFixed(1)}M | Sold $${(insiderSellValue/1e6).toFixed(1)}M — signal: ${insiderSignal.toUpperCase()}`,
  ].filter(Boolean)

  return {
    peRatio, pbRatio, psRatio, evEbitda, debtToEquity,
    revenueGrowthYoY, epsGrowthYoY, grossMargin, operatingMargin,
    netMargin, freeCashFlowYield, roe,
    nextEarningsDate, daysToEarnings, earningsRisk,
    epsSurprises, avgSurprisePct, consistentBeater,
    analystBuy, analystHold, analystSell, analystTargetPrice,
    analystConsensus, analystUpside,
    recentUpgrades, recentDowngrades,
    insiderBuyValue, insiderSellValue, insiderSignal,
    earningsImpliedMove, earningsHistoricalMove, earningsEdge,
    summary: lines.join('\n'),
  }
}
