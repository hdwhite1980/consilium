// ─────────────────────────────────────────────────────────────
// Signal Bundle Aggregator
// Runs all 5 phases in parallel, assembles the full context
// object that every AI stage receives
// ─────────────────────────────────────────────────────────────

import { fetchNews, fetchBars, formatNewsForAI, formatBarsForAI } from './data/alpaca'
import { fetchCryptoBars, fetchCryptoPrice, fetchCryptoMetadata, isCryptoTicker } from './data/crypto'
import { fetchForexBars, fetchForexRate, fetchForexMetadata, isForexTicker, getForexInfo } from './data/forex'
import { calculateTechnicals } from './signals/technicals'
import { buildMarketContext } from './signals/market-context'
import { fetchFundamentals } from './signals/fundamentals'
import { fetchEdgarFundamentals, formatEdgarForAI } from './data/edgar'
import { fetchSmartMoney } from './signals/smart-money'
import { fetchOptionsFlow } from './signals/options-flow'
import { buildConvictionOutput } from './signals/conviction'

export type SignalBundle = {
  ticker: string
  timeframe: string
  timestamp: string
  persona?: 'balanced' | 'technical' | 'fundamental'

  // Raw data
  bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>
  news: Array<{ headline: string; summary: string; created_at: string; url: string }>
  currentPrice: number

  // Phase 1
  technicals: Awaited<ReturnType<typeof calculateTechnicals>>
  marketContext: Awaited<ReturnType<typeof buildMarketContext>>

  // Phase 2
  fundamentals: Awaited<ReturnType<typeof fetchFundamentals>>

  // Phase 3
  smartMoney: Awaited<ReturnType<typeof fetchSmartMoney>>

  // Phase 4
  optionsFlow: Awaited<ReturnType<typeof fetchOptionsFlow>>

  // Phase 5
  conviction: Awaited<ReturnType<typeof buildConvictionOutput>>

  // Combined AI-ready context strings (what gets passed to each AI)
  aiContext: {
    newsSection: string
    macroIntelligenceSection?: string
    priceSection: string
    technicalsSection: string
    marketSection: string
    fundamentalsSection: string
    smartMoneySection: string
    optionsSection: string
    convictionSection: string
    fullBundle: string  // everything combined
  }
}

export async function buildSignalBundle(
  ticker: string,
  timeframe: string,
  onProgress?: (step: string) => void
): Promise<SignalBundle> {
  const sym = ticker.toUpperCase()
  const isCrypto = isForexTicker(sym) ? false : isCryptoTicker(sym)
  const isForex = isForexTicker(sym)

  onProgress?.(`Fetching ${isForex ? 'forex' : isCrypto ? 'crypto' : 'price'} data and news...`)

  // ── Crypto path: CoinGecko bars + Alpaca news ──────────────
  if (isCrypto) {
    const [bars, news, cryptoMeta] = await Promise.all([
      fetchCryptoBars(sym, timeframe),
      fetchNews(sym, 15),
      fetchCryptoMetadata(sym),
    ])

    // CoinGecko live price — always real-time
    let currentPrice = bars.length ? bars[bars.length - 1].c : 0
    const livePrice = await fetchCryptoPrice(sym)
    if (livePrice > 0) currentPrice = livePrice

    // ── Sanity check: validate bars against live price ──────────────────
    // If bars are wildly inconsistent with the live price, discard them.
    // This catches Alpaca returning wrong-pair data or CoinGecko rate-limit garbage.
    let validatedBars = bars
    if (bars.length > 0 && livePrice > 0) {
      const lastBarPrice = bars[bars.length - 1].c
      const ratio = livePrice / lastBarPrice
      // If last bar is more than 5x or less than 0.2x the live price — data is bad
      if (ratio > 5 || ratio < 0.2) {
        console.warn(`[crypto] Bar price ${lastBarPrice} vs live ${livePrice} — ratio ${ratio.toFixed(2)} is suspect, using scaled bars`)
        // Scale all bars proportionally to match live price
        const scale = livePrice / lastBarPrice
        validatedBars = bars.map(b => ({
          ...b,
          o: b.o * scale,
          h: b.h * scale,
          l: b.l * scale,
          c: b.c * scale,
        }))
      }
    }

    onProgress?.('Computing technical indicators...')
    // For intraday crypto timeframes, fetch daily bars for accurate RSI/MACD/SMA
    let cryptoIndicatorBars = validatedBars
    if (timeframe === '1D' || timeframe === '1W') {
      try {
        const daily = await fetchCryptoBars(sym, '1M')
        if (daily.length >= 50) cryptoIndicatorBars = daily
      } catch { /* use original */ }
    }
    const technicals = calculateTechnicals(cryptoIndicatorBars)

    onProgress?.('Fetching market context...')
    const [marketContext, optionsFlow] = await Promise.all([
      buildMarketContext(sym, timeframe),
      fetchOptionsFlow(sym, currentPrice),
    ])

    // Build crypto-specific fundamentals stub (no earnings, P/E etc)
    const cryptoFundamentals = {
      summary: `=== CRYPTO FUNDAMENTALS ===
Asset: ${cryptoMeta.name} (${sym})
Market Cap: ${cryptoMeta.marketCap ? '$' + (cryptoMeta.marketCap / 1e9).toFixed(2) + 'B' : 'N/A'}
24h Volume: ${cryptoMeta.volume24h ? '$' + (cryptoMeta.volume24h / 1e6).toFixed(0) + 'M' : 'N/A'}
Circulating Supply: ${cryptoMeta.circulatingSupply ? (cryptoMeta.circulatingSupply / 1e6).toFixed(2) + 'M' : 'N/A'}
24h Change: ${cryptoMeta.priceChange24h?.toFixed(2) ?? 'N/A'}%
7d Change: ${cryptoMeta.priceChange7d?.toFixed(2) ?? 'N/A'}%
ATH: ${cryptoMeta.ath ? '$' + cryptoMeta.ath.toLocaleString() : 'N/A'} (${cryptoMeta.athChangePercent?.toFixed(1) ?? 'N/A'}% from ATH)
${cryptoMeta.description ? 'About: ' + cryptoMeta.description : ''}`,
      // Valuation
      peRatio: null, pbRatio: null, psRatio: null, evEbitda: null, debtToEquity: null,
      // Growth
      revenueGrowthYoY: cryptoMeta.priceChange7d ?? null,
      epsGrowthYoY: null, grossMargin: null, operatingMargin: null,
      netMargin: null, freeCashFlowYield: null, roe: null,
      // Earnings (N/A for crypto)
      nextEarningsDate: null,
      earningsDate: null,
      daysToEarnings: null,
      earningsRisk: 'none' as const,
      // EPS
      epsSurprises: [],
      avgSurprisePct: null,
      consistentBeater: false,
      // Analyst
      analystBuy: 0, analystHold: 0, analystSell: 0,
      analystTargetPrice: null,
      analystConsensus: 'unknown' as const,
      analystUpside: null,
      recentUpgrades: [],
      recentDowngrades: [],
      // Insider
      insiderBuyValue: 0, insiderSellValue: 0,
      insiderSignal: 'neutral' as const,
      // Earnings implied move (N/A for crypto)
      earningsImpliedMove: null,
      earningsHistoricalMove: null,
      earningsEdge: null,
    }

    const cryptoSmartMoney = {
      summary: `=== SMART MONEY (CRYPTO) ===
On-chain institutional data not available via free tier.
Focus on technical signals, volume trends, and market structure for directional bias.`,
      insiderTransactions: [],
      insiderNetValue: 0,
      insiderSignal: 'neutral' as const,
      insiderHighlight: '',
      institutionalOwnership: [],
      totalInstitutionalPct: 0,
      institutionalNetChange: 'stable' as const,
      notableHolders: [],
      congressionalTrades: [],
      congressSignal: 'none' as const,
    }

    onProgress?.('Running conviction engine...')
    const conviction = buildConvictionOutput(
      sym, currentPrice,
      technicals, cryptoFundamentals, cryptoSmartMoney, optionsFlow, marketContext,
      timeframe
    )

    const newsSection = `=== NEWS & SENTIMENT ===\n${formatNewsForAI(news)}`
    const priceSection = `=== PRICE ACTION ===\n${formatBarsForAI(validatedBars, timeframe)}`
    const technicalsSection = technicals.summary
    const marketSection = marketContext.summary
    const fundamentalsSection = cryptoFundamentals.summary
    const smartMoneySection = cryptoSmartMoney.summary
    const optionsSection = optionsFlow.summary
    const convictionSection = conviction.summary
    const fullBundle = [newsSection, priceSection, technicalsSection, marketSection, fundamentalsSection, smartMoneySection, optionsSection, convictionSection].join('\n\n')

    return {
      ticker: sym, timeframe, timestamp: new Date().toISOString(),
      bars: validatedBars, news, currentPrice,
      technicals, marketContext,
      fundamentals: cryptoFundamentals,
      smartMoney: cryptoSmartMoney,
      optionsFlow, conviction,
      aiContext: { newsSection, priceSection, technicalsSection, marketSection, fundamentalsSection, smartMoneySection, optionsSection, convictionSection, fullBundle },
    }
  }

  // ── Forex path ─────────────────────────────────────────────
  if (isForex) {
    const forexInfo = getForexInfo(sym)!
    const [bars, news, forexMeta] = await Promise.all([
      fetchForexBars(sym, timeframe),
      fetchNews(`${forexInfo.base} ${forexInfo.quote} forex`, 10),
      fetchForexMetadata(sym),
    ])

    let currentPrice = bars.length ? bars[bars.length - 1].c : 0
    const liveRate = await fetchForexRate(sym)
    if (liveRate > 0) currentPrice = liveRate

    // Validate bars against live rate
    if (bars.length > 0 && liveRate > 0) {
      const ratio = liveRate / bars[bars.length - 1].c
      if (ratio > 2 || ratio < 0.5) {
        const scale = liveRate / bars[bars.length - 1].c
        bars.forEach(b => { b.o *= scale; b.h *= scale; b.l *= scale; b.c *= scale })
      }
    }

    onProgress?.('Computing technical indicators...')
    // For intraday forex timeframes, use daily bars for accurate indicators
    let forexIndicatorBars = bars
    if ((timeframe === '1D' || timeframe === '1W') && bars.length > 0) {
      try {
        const dailyForex = await fetchForexBars(sym, '1M')
        if (dailyForex.length >= 50) forexIndicatorBars = dailyForex
      } catch { /* use original bars */ }
    }
    const technicals = calculateTechnicals(forexIndicatorBars)

    onProgress?.('Fetching market context...')
    const [marketContext, optionsFlow] = await Promise.all([
      buildMarketContext('SPY', timeframe), // macro context via SPY
      fetchOptionsFlow(sym, currentPrice),  // usually empty for forex
    ])

    // Forex-specific fundamentals stub
    const dp = (n: number | null) => n != null ? n.toFixed(5) : 'N/A'
    const forexFundamentals = {
      summary: `=== FOREX FUNDAMENTALS ===
Pair: ${forexMeta.name} (${sym})
Current Rate: ${dp(currentPrice)}
24h Change: ${forexMeta.change24hPct != null ? (forexMeta.change24hPct >= 0 ? '+' : '') + forexMeta.change24hPct.toFixed(3) + '%' : 'N/A'}
Session High: ${dp(forexMeta.weekHigh)} | Session Low: ${dp(forexMeta.weekLow)}
Group: ${forexMeta.group} pair
Background: ${forexMeta.description}
Note: Forex has no P/E ratio, earnings, or insider data. Analysis focuses on technical signals, macro regime, central bank policy divergence, and price action.`,
      peRatio: null, pbRatio: null, psRatio: null, evEbitda: null, debtToEquity: null,
      revenueGrowthYoY: null, epsGrowthYoY: null, grossMargin: null, operatingMargin: null,
      netMargin: null, freeCashFlowYield: null, roe: null,
      nextEarningsDate: null, daysToEarnings: null, earningsRisk: 'none' as const,
      epsSurprises: [], avgSurprisePct: null, consistentBeater: false,
      analystBuy: 0, analystHold: 0, analystSell: 0, analystTargetPrice: null,
      analystConsensus: 'unknown' as const, analystUpside: null,
      recentUpgrades: [], recentDowngrades: [],
      insiderBuyValue: 0, insiderSellValue: 0, insiderSignal: 'neutral' as const,
      earningsImpliedMove: null, earningsHistoricalMove: null, earningsEdge: null,
    }

    const forexSmartMoney = {
      summary: `=== SMART MONEY (FOREX) ===
Institutional positioning data (COT reports) not available via current data sources.
Focus on central bank policy signals, economic data releases, and technical structure.`,
      insiderTransactions: [],
      insiderNetValue: 0,
      insiderSignal: 'neutral' as const,
      insiderHighlight: '',
      institutionalOwnership: [],
      totalInstitutionalPct: 0,
      institutionalNetChange: 'stable',
      notableHolders: [],
      congressionalTrades: [],
      congressSignal: 'none' as const,
    }

    onProgress?.('Running conviction engine...')
    const conviction = buildConvictionOutput(
      sym, currentPrice,
      technicals, forexFundamentals, forexSmartMoney, optionsFlow, marketContext,
      timeframe
    )

    const newsSection = `=== NEWS & FOREX EVENTS ===\n${formatNewsForAI(news)}`
    const priceSection = `=== PRICE ACTION ===\n${formatBarsForAI(bars, timeframe)}`
    const technicalsSection = technicals.summary
    const marketSection = marketContext.summary
    const fundamentalsSection = forexFundamentals.summary
    const smartMoneySection = forexSmartMoney.summary
    const optionsSection = optionsFlow.summary
    const convictionSection = conviction.summary
    const fullBundle = [newsSection, priceSection, technicalsSection, marketSection, fundamentalsSection, smartMoneySection, optionsSection, convictionSection].join('\n\n')

    return {
      ticker: sym, timeframe, timestamp: new Date().toISOString(),
      bars, news, currentPrice,
      technicals, marketContext,
      fundamentals: forexFundamentals,
      smartMoney: forexSmartMoney,
      optionsFlow, conviction,
      aiContext: { newsSection, priceSection, technicalsSection, marketSection, fundamentalsSection, smartMoneySection, optionsSection, convictionSection, fullBundle },
    }
  }

  // ── Equity path ─────────────────────────────────────────────
  // Fetch timeframe bars (for price action context) AND daily bars (for indicators)
  // in parallel. RSI/MACD/SMA/Bollinger must use daily bars — 15min RSI ≠ daily RSI.
  const [bars, dailyBars, news] = await Promise.all([
    fetchBars(sym, timeframe),
    timeframe === '1D' || timeframe === '1W' ? fetchBars(sym, '1M') : Promise.resolve([] as Awaited<ReturnType<typeof fetchBars>>),
    fetchNews(sym, 15),
  ])

  // Use Finnhub for real-time price — much more accurate than last bar close
  let currentPrice = bars.length ? bars[bars.length - 1].c : 0
  try {
    const fhKey = process.env.FINNHUB_API_KEY
    if (fhKey) {
      const quoteRes = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${fhKey}`
      )
      if (quoteRes.ok) {
        const q = await quoteRes.json()
        if (q.c && q.c > 0) currentPrice = q.c
      }
    }
  } catch { /* fall back to bar close */ }

  // Use daily bars for indicators when available — prevents intraday RSI/MACD confusion
  // For 1M/3M timeframes, the bars are already daily so no separate fetch needed
  const indicatorBars = (timeframe === '1D' || timeframe === '1W') && dailyBars.length >= 50
    ? dailyBars
    : bars

  onProgress?.('Computing technical indicators...')
  const technicals = calculateTechnicals(indicatorBars)

  // Phases 1-4 in parallel
  onProgress?.('Fetching market context, fundamentals, smart money, options...')
  const [marketContext, fundamentals, smartMoney, optionsFlow, edgarData] = await Promise.all([
    buildMarketContext(sym, timeframe),
    fetchFundamentals(sym, currentPrice),
    fetchSmartMoney(sym),
    fetchOptionsFlow(sym, currentPrice),
    fetchEdgarFundamentals(sym).catch(() => null),  // best-effort, never blocks analysis
  ])

  // Compute relative strength vs sector now that we have both
  const sectorChange = marketContext.sector.changePeriod
  const stockChange = technicals.priceChangePeriod
  const relStrength = stockChange - sectorChange
  technicals.relStrengthVsSector = parseFloat(relStrength.toFixed(2))
  technicals.relStrengthSignal =
    relStrength > 3  ? 'outperforming' :
    relStrength < -3 ? 'underperforming' : 'inline'

  // Update market context summary with actual relative strength
  const rsNote = `  Relative strength vs ${marketContext.sectorETF}: ${relStrength >= 0 ? '+' : ''}${relStrength.toFixed(1)}% — ${technicals.relStrengthSignal}`
  marketContext.summary = marketContext.summary.replace(
    '  Relative strength vs sector will be computed once stock data is available.',
    rsNote
  )

  onProgress?.('Running conviction engine...')
  const conviction = buildConvictionOutput(
    sym, currentPrice,
    technicals, fundamentals, smartMoney, optionsFlow, marketContext,
    timeframe
  )

  // Build AI-ready text sections
  const newsSection = `=== NEWS & SENTIMENT ===\n${formatNewsForAI(news)}`
  const priceSection = `=== PRICE ACTION ===\n${formatBarsForAI(bars, timeframe)}`
  const technicalsSection = technicals.summary
  const marketSection = marketContext.summary
  // Blend EDGAR verified data into fundamentals section if available
  const edgarSection = edgarData ? formatEdgarForAI(edgarData, currentPrice) : null
  const fundamentalsSection = edgarSection
    ? `${edgarSection}\n\n${fundamentals.summary}`
    : fundamentals.summary
  const smartMoneySection = smartMoney.summary
  const optionsSection = optionsFlow.summary
  const convictionSection = conviction.summary

  const fullBundle = [
    newsSection, priceSection, technicalsSection, marketSection,
    fundamentalsSection, smartMoneySection, optionsSection, convictionSection,
  ].join('\n\n')

  return {
    ticker: sym, timeframe, timestamp: new Date().toISOString(),
    bars, news, currentPrice,
    technicals, marketContext, fundamentals, smartMoney, optionsFlow, conviction,
    aiContext: { newsSection, priceSection, technicalsSection, marketSection, fundamentalsSection, smartMoneySection, optionsSection, convictionSection, fullBundle },
  }
}
