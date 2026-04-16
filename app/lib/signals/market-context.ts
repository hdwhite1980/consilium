// ─────────────────────────────────────────────────────────────
// PHASE 1 — Market Context
// Fetches SPY, QQQ, VIX, sector ETFs, competitors
// All from Alpaca — no extra API key needed
// ─────────────────────────────────────────────────────────────

import { fetchBars, type AlpacaBar } from '../data/alpaca'
import { calculateTechnicals } from './technicals'

export interface MarketContext {
  // Broad market
  spy: MarketSnapshot
  qqq: MarketSnapshot
  vix: VixSnapshot

  // Sector
  sectorETF: string
  sector: MarketSnapshot

  // Competitors
  competitors: CompetitorSnapshot[]

  // Currency / macro
  dxy: MacroSnapshot | null

  // Regime assessment
  regime: MarketRegime
  regimeSummary: string

  // Full text for AI
  summary: string
}

export interface MarketSnapshot {
  ticker: string
  change1D: number
  changePeriod: number
  rsi: number
  trend: 'up' | 'down' | 'flat'
}

export interface VixSnapshot {
  level: number
  signal: 'fear' | 'greed' | 'neutral'
  description: string
}

export interface CompetitorSnapshot {
  ticker: string
  change1D: number
  changePeriod: number
  relativeDiff: number // vs the analyzed stock
}

export interface MacroSnapshot {
  ticker: string
  change1D: number
  level: number
}

export type MarketRegime =
  | 'risk_on_bull'
  | 'risk_on_volatile'
  | 'risk_off_bear'
  | 'high_fear'
  | 'neutral'

// ── Sector ETF Map ────────────────────────────────────────────
// Maps common tickers to their sector ETF
const SECTOR_MAP: Record<string, { etf: string; name: string; peers: string[] }> = {
  // Tech
  AAPL: { etf: 'XLK', name: 'Technology', peers: ['MSFT','GOOGL','META'] },
  MSFT: { etf: 'XLK', name: 'Technology', peers: ['AAPL','GOOGL','AMZN'] },
  GOOGL: { etf: 'XLK', name: 'Technology', peers: ['MSFT','META','AMZN'] },
  META: { etf: 'XLK', name: 'Technology', peers: ['GOOGL','SNAP','PINS'] },
  NVDA: { etf: 'XLK', name: 'Technology', peers: ['AMD','INTC','AVGO'] },
  AMD:  { etf: 'XLK', name: 'Technology', peers: ['NVDA','INTC','QCOM'] },
  INTC: { etf: 'XLK', name: 'Technology', peers: ['AMD','NVDA','TSM'] },
  // Finance
  JPM:  { etf: 'XLF', name: 'Financials', peers: ['BAC','GS','MS'] },
  BAC:  { etf: 'XLF', name: 'Financials', peers: ['JPM','WFC','C'] },
  GS:   { etf: 'XLF', name: 'Financials', peers: ['MS','JPM','BLK'] },
  // Healthcare
  JNJ:  { etf: 'XLV', name: 'Healthcare', peers: ['PFE','MRK','ABT'] },
  PFE:  { etf: 'XLV', name: 'Healthcare', peers: ['JNJ','MRK','BMY'] },
  // Energy
  XOM:  { etf: 'XLE', name: 'Energy', peers: ['CVX','COP','SLB'] },
  CVX:  { etf: 'XLE', name: 'Energy', peers: ['XOM','COP','EOG'] },
  // Consumer
  AMZN: { etf: 'XLY', name: 'Consumer Disc.', peers: ['TSLA','HD','TGT'] },
  TSLA: { etf: 'XLY', name: 'Consumer Disc.', peers: ['RIVN','F','GM'] },
  // Default
  DEFAULT: { etf: 'SPY', name: 'Broad Market', peers: ['QQQ','IWM','DIA'] },
}

function getSectorInfo(ticker: string) {
  return SECTOR_MAP[ticker.toUpperCase()] ?? SECTOR_MAP.DEFAULT
}

async function getSnapshot(ticker: string, timeframe: string): Promise<MarketSnapshot> {
  try {
    // Use daily bars for market context — intraday bars give misleading macro signals
    const macroTf = (timeframe === '1D' || timeframe === '1W') ? '1M' : timeframe
    const bars = await fetchBars(ticker, macroTf)
    if (!bars.length) return { ticker, change1D: 0, changePeriod: 0, rsi: 50, trend: 'flat' }
    const tech = calculateTechnicals(bars)
    return {
      ticker,
      change1D: tech.priceChange1D,
      changePeriod: tech.priceChangePeriod,
      rsi: tech.rsi,
      trend: tech.priceChangePeriod > 1 ? 'up' : tech.priceChangePeriod < -1 ? 'down' : 'flat',
    }
  } catch {
    return { ticker, change1D: 0, changePeriod: 0, rsi: 50, trend: 'flat' }
  }
}

async function getVix(timeframe: string): Promise<VixSnapshot> {
  try {
    // Always use daily bars for VIX — intraday VIXY bars are meaningless for macro regime
    const vixTf = (timeframe === '1D' || timeframe === '1W') ? '1M' : timeframe
    const bars = await fetchBars('VIXY', vixTf) // VIX proxy ETF
    if (!bars.length) return { level: 18, signal: 'neutral', description: 'VIX data unavailable' }
    const level = bars[bars.length - 1].c
    const signal = level > 30 ? 'fear' : level < 15 ? 'greed' : 'neutral'
    const description =
      level > 40 ? `VIX ${level.toFixed(1)} — extreme fear, market in panic` :
      level > 30 ? `VIX ${level.toFixed(1)} — elevated fear, defensive posture warranted` :
      level > 20 ? `VIX ${level.toFixed(1)} — moderate volatility, cautious environment` :
      level > 15 ? `VIX ${level.toFixed(1)} — calm markets, moderate risk appetite` :
      `VIX ${level.toFixed(1)} — complacency, very low fear — potential contrarian warning`
    return { level, signal, description }
  } catch {
    return { level: 18, signal: 'neutral', description: 'VIX data unavailable' }
  }
}

function detectRegime(spy: MarketSnapshot, vix: VixSnapshot): { regime: MarketRegime; summary: string } {
  if (vix.level > 30) return {
    regime: 'high_fear',
    summary: `High fear regime (VIX ${vix.level.toFixed(0)}). Market in risk-off mode. Defensive and short-side setups favored. Any bullish thesis faces macro headwind.`
  }
  if (spy.trend === 'up' && vix.level < 20) return {
    regime: 'risk_on_bull',
    summary: `Risk-on bull regime. SPY trending up, VIX subdued (${vix.level.toFixed(0)}). Favorable backdrop for long positions, particularly in growth and momentum.`
  }
  if (spy.trend === 'up' && vix.level >= 20) return {
    regime: 'risk_on_volatile',
    summary: `Risk-on but volatile (VIX ${vix.level.toFixed(0)}). Market grinding higher against elevated uncertainty. Sizing down and tighter stops appropriate.`
  }
  if (spy.trend === 'down') return {
    regime: 'risk_off_bear',
    summary: `Risk-off bear regime. SPY trending down. Bearish bias warranted. Oversold bounces possible but selling into strength is the dominant strategy.`
  }
  return { regime: 'neutral', summary: `Neutral market regime. No clear directional bias in broad market. Stock-specific factors dominate.` }
}

export async function buildMarketContext(ticker: string, timeframe: string): Promise<MarketContext> {
  const sectorInfo = getSectorInfo(ticker)

  // Parallel fetch everything
  const [spy, qqq, vix, sector, ...competitorSnapshots] = await Promise.all([
    getSnapshot('SPY', timeframe),
    getSnapshot('QQQ', timeframe),
    getVix(timeframe),
    getSnapshot(sectorInfo.etf, timeframe),
    ...sectorInfo.peers.map(p => getSnapshot(p, timeframe)),
  ])

  // DXY proxy (UUP ETF)
  let dxy: MacroSnapshot | null = null
  try {
    const dxyBars = await fetchBars('UUP', timeframe)
    if (dxyBars.length) {
      const bars = dxyBars
      dxy = {
        ticker: 'DXY (UUP)',
        change1D: ((bars[bars.length-1].c - bars[bars.length-2]?.c) / (bars[bars.length-2]?.c ?? 1)) * 100,
        level: bars[bars.length-1].c,
      }
    }
  } catch { /* skip if unavailable */ }

  const competitors: CompetitorSnapshot[] = competitorSnapshots.map(c => ({
    ticker: c.ticker,
    change1D: c.change1D,
    changePeriod: c.changePeriod,
    relativeDiff: 0, // filled below
  }))

  const { regime, summary: regimeSummary } = detectRegime(spy, vix)

  // Relative strength: stock period change vs sector period change
  // This is computed in aggregator after we have both technicals and market context
  const stockPeriodChange = 0 // placeholder — filled in aggregator

  // Build text summary for AI
  const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
  const lines = [
    `=== MARKET CONTEXT ===`,
    `Regime: ${regime.toUpperCase().replace(/_/g, ' ')} — ${regimeSummary}`,
    ``,
    `Broad market (${timeframe}):`,
    `  SPY: ${pct(spy.change1D)} today / ${pct(spy.changePeriod)} period, RSI ${spy.rsi.toFixed(0)}, trend ${spy.trend}`,
    `  QQQ: ${pct(qqq.change1D)} today / ${pct(qqq.changePeriod)} period, RSI ${qqq.rsi.toFixed(0)}, trend ${qqq.trend}`,
    `  ${vix.description}`,
    ``,
    `Sector (${sectorInfo.name} — ${sectorInfo.etf}):`,
    `  ${pct(sector.changePeriod)} period, RSI ${sector.rsi.toFixed(0)}, trend ${sector.trend}`,
    `  Relative strength vs sector will be computed once stock data is available.`,
    ``,
    `Competitors:`,
    ...competitors.map(c => `  ${c.ticker}: ${pct(c.change1D)} today / ${pct(c.changePeriod)} period`),
    ``,
    dxy ? `Dollar (DXY proxy): ${pct(dxy.change1D)} today — ${dxy.change1D > 0.3 ? 'strengthening, headwind for multinationals' : dxy.change1D < -0.3 ? 'weakening, tailwind for multinationals' : 'stable'}` : '',
  ].filter(Boolean)

  return {
    spy, qqq, vix, sectorETF: sectorInfo.etf, sector,
    competitors, dxy, regime, regimeSummary,
    summary: lines.join('\n'),
  }
}
