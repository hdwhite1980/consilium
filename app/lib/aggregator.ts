// ─────────────────────────────────────────────────────────────
// Signal Bundle Aggregator
// Runs all 5 phases in parallel, assembles the full context
// object that every AI stage receives
// ─────────────────────────────────────────────────────────────

import { fetchNews, fetchBars, formatNewsForAI, formatBarsForAI } from './data/alpaca'
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

  onProgress?.('Fetching price data and news...')
  const [bars, news] = await Promise.all([
    fetchBars(sym, timeframe),
    fetchNews(sym, 15),
  ])

  const currentPrice = bars.length ? bars[bars.length - 1].c : 0

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
    newsSection,
    priceSection,
    technicalsSection,
    marketSection,
    fundamentalsSection,
    smartMoneySection,
    optionsSection,
    convictionSection,
  ].join('\n\n')

  return {
    ticker: sym,
    timeframe,
    timestamp: new Date().toISOString(),
    bars,
    news,
    currentPrice,
    technicals,
    marketContext,
    fundamentals,
    smartMoney,
    optionsFlow,
    conviction,
    aiContext: {
      newsSection,
      priceSection,
      technicalsSection,
      marketSection,
      fundamentalsSection,
      smartMoneySection,
      optionsSection,
      convictionSection,
      fullBundle,
    },
  }
}
