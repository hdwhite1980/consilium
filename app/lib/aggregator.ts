// ─────────────────────────────────────────────────────────────
// Signal Bundle Aggregator
// Runs all 5 phases in parallel, assembles the full context
// object that every AI stage receives
// ─────────────────────────────────────────────────────────────

import { fetchNews, fetchBars, formatNewsForAI, formatBarsForAI } from './data/alpaca'
import { fetchCryptoBars, fetchCryptoPrice, fetchCryptoMetadata, isCryptoTicker } from './data/crypto'
import { calculateTechnicals } from './signals/technicals'
import { buildMarketContext } from './signals/market-context'
import { fetchFundamentals } from './signals/fundamentals'
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
  const isCrypto = isCryptoTicker(sym)

  onProgress?.(`Fetching ${isCrypto ? 'crypto' : 'price'} data and news...`)

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

    onProgress?.('Computing technical indicators...')
    const technicals = calculateTechnicals(bars)

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
      technicals, cryptoFundamentals, cryptoSmartMoney, optionsFlow, marketContext
    )

    const newsSection = `=== NEWS & SENTIMENT ===\n${formatNewsForAI(news)}`
    const priceSection = `=== PRICE ACTION ===\n${formatBarsForAI(bars, timeframe)}`
    const technicalsSection = technicals.summary
    const marketSection = marketContext.summary
    const fundamentalsSection = cryptoFundamentals.summary
    const smartMoneySection = cryptoSmartMoney.summary
    const optionsSection = optionsFlow.summary
    const convictionSection = conviction.summary
    const fullBundle = [newsSection, priceSection, technicalsSection, marketSection, fundamentalsSection, smartMoneySection, optionsSection, convictionSection].join('\n\n')

    return {
      ticker: sym, timeframe, timestamp: new Date().toISOString(),
      bars, news, currentPrice,
      technicals, marketContext,
      fundamentals: cryptoFundamentals,
      smartMoney: cryptoSmartMoney,
      optionsFlow, conviction,
      aiContext: { newsSection, priceSection, technicalsSection, marketSection, fundamentalsSection, smartMoneySection, optionsSection, convictionSection, fullBundle },
    }
  }

  // ── Equity path (unchanged) ────────────────────────────────
  const [bars, news] = await Promise.all([
    fetchBars(sym, timeframe),
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

  onProgress?.('Computing technical indicators...')
  const technicals = calculateTechnicals(bars)

  // Phases 1-4 in parallel
  onProgress?.('Fetching market context, fundamentals, smart money, options...')
  const [marketContext, fundamentals, smartMoney, optionsFlow] = await Promise.all([
    buildMarketContext(sym, timeframe),
    fetchFundamentals(sym, currentPrice),
    fetchSmartMoney(sym),
    fetchOptionsFlow(sym, currentPrice),
  ])

  onProgress?.('Running conviction engine...')
  const conviction = buildConvictionOutput(
    sym, currentPrice,
    technicals, fundamentals, smartMoney, optionsFlow, marketContext
  )

  // Build AI-ready text sections
  const newsSection = `=== NEWS & SENTIMENT ===\n${formatNewsForAI(news)}`
  const priceSection = `=== PRICE ACTION ===\n${formatBarsForAI(bars, timeframe)}`
  const technicalsSection = technicals.summary
  const marketSection = marketContext.summary
  const fundamentalsSection = fundamentals.summary
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
