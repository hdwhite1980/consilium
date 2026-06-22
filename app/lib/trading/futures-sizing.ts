// =============================================================
// app/lib/trading/futures-sizing.ts (Layer 5)
//
// Specs expanded to ALL major CME futures families.
// Council scope enforced via the futures-aware ticker gate +
// dataLayer notes on each spec.
// =============================================================

export interface FuturesContractSpec {
  root: string
  tickSize: number
  tickValueUsd: number
  pointMultiplier: number
  initialMarginEst: number
  category: 'equity_index' | 'volatility' | 'energy' | 'metals' | 'grains' | 'rates' | 'fx' | 'other'
  micro: boolean
  // Price derivation from underlying proxy ETF:
  //   - linear: futures_price = etf_price * priceMultiplierFromProxy
  //   - proxy_only: use ETF price as-is and tag as approximation
  //   - none: no proxy, price must come from elsewhere
  priceFromProxy?: {
    method: 'linear' | 'proxy_only' | 'none'
    multiplier?: number          // when method='linear'
    note?: string                 // displayed alongside price for transparency
  }
  dataLayer: {
    fundamentalsWired: boolean
    underlyingEtfProxy: string | null
    citationNote: string
  }
}

export const FUTURES_SPECS: Record<string, FuturesContractSpec> = {
  // Equity index
  ES:  { root: 'ES',  tickSize: 0.25, tickValueUsd: 12.50, pointMultiplier: 50,  initialMarginEst: 14000, category: 'equity_index', micro: false, priceFromProxy: { method: 'linear', multiplier: 10, note: 'ES futures price ≈ SPY × 10 (front-month approx; basis varies by dividends/rates).' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: 'SPY', citationNote: 'ES tracks S&P 500. Use SPY analysis as underlying. COT positioning available.' } },

  MES: { root: 'MES', tickSize: 0.25, tickValueUsd: 1.25,  pointMultiplier: 5,   initialMarginEst: 1400,  category: 'equity_index', micro: true, priceFromProxy: { method: 'linear', multiplier: 10, note: 'MES futures price ≈ SPY × 10 (front-month approx).' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: 'SPY', citationNote: 'MES = 1/10 of ES.' } },

  NQ:  { root: 'NQ',  tickSize: 0.25, tickValueUsd: 5.00,  pointMultiplier: 20,  initialMarginEst: 17000, category: 'equity_index', micro: false, priceFromProxy: { method: 'linear', multiplier: 40, note: 'NQ futures price ≈ QQQ × 40 (front-month approx).' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: 'QQQ', citationNote: 'NQ tracks Nasdaq-100. Use QQQ analysis. COT available.' } },

  MNQ: { root: 'MNQ', tickSize: 0.25, tickValueUsd: 0.50,  pointMultiplier: 2,   initialMarginEst: 1700,  category: 'equity_index', micro: true, priceFromProxy: { method: 'linear', multiplier: 40, note: 'MNQ futures price ≈ QQQ × 40 (front-month approx).' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: 'QQQ', citationNote: 'MNQ = 1/10 of NQ.' } },

  RTY: { root: 'RTY', tickSize: 0.10, tickValueUsd: 5.00,  pointMultiplier: 50,  initialMarginEst: 7500,  category: 'equity_index', micro: false, priceFromProxy: { method: 'linear', multiplier: 10, note: 'RTY futures price ≈ IWM × 10 (front-month approx).' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: 'IWM', citationNote: 'RTY tracks Russell 2000. Use IWM.' } },

  M2K: { root: 'M2K', tickSize: 0.10, tickValueUsd: 0.50,  pointMultiplier: 5,   initialMarginEst: 750,   category: 'equity_index', micro: true, priceFromProxy: { method: 'linear', multiplier: 10, note: 'M2K futures price ≈ IWM × 10 (front-month approx).' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: 'IWM', citationNote: 'M2K = 1/10 of RTY.' } },

  YM:  { root: 'YM',  tickSize: 1.00, tickValueUsd: 5.00,  pointMultiplier: 5,   initialMarginEst: 9500,  category: 'equity_index', micro: false, priceFromProxy: { method: 'linear', multiplier: 100, note: 'YM futures price ≈ DIA × 100 (front-month approx).' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: 'DIA', citationNote: 'YM tracks Dow Industrial. Use DIA.' } },

  MYM: { root: 'MYM', tickSize: 1.00, tickValueUsd: 0.50,  pointMultiplier: 0.5, initialMarginEst: 950,   category: 'equity_index', micro: true, priceFromProxy: { method: 'linear', multiplier: 100, note: 'MYM futures price ≈ DIA × 100 (front-month approx).' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: 'DIA', citationNote: 'MYM = 1/10 of YM.' } },

  // Volatility
  VX:  { root: 'VX',  tickSize: 0.05, tickValueUsd: 50.00, pointMultiplier: 1000,initialMarginEst: 9000,  category: 'volatility', micro: false, priceFromProxy: { method: 'linear', multiplier: 1, note: 'VX futures price ≈ VIX index level (front-month approx; term structure not yet wired).' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: 'VIXY', citationNote: 'VX tracks VIX. Term structure is dominant signal. VIX level + COT available; full term structure NOT yet wired in v1.' } },

  // Energy
  CL:  { root: 'CL',  tickSize: 0.01,  tickValueUsd: 10.00, pointMultiplier: 1000, initialMarginEst: 6500, category: 'energy', micro: false, priceFromProxy: { method: 'proxy_only', note: 'CL futures price will be wired via TwelveData / Tradovate in a later session. Currently showing USO ETF as proxy reference only.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'USO', citationNote: 'WTI crude. EIA inventory/refinery NOT wired in v1. Use COT + technicals + macro (dollar, geopolitics).' } },

  MCL: { root: 'MCL', tickSize: 0.025, tickValueUsd: 2.50,  pointMultiplier: 100,  initialMarginEst: 650,  category: 'energy', micro: true, priceFromProxy: { method: 'proxy_only', note: 'MCL futures price will be wired via TwelveData / Tradovate. Showing USO as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'USO', citationNote: 'Micro WTI = 1/10 of CL.' } },

  NG:  { root: 'NG',  tickSize: 0.001, tickValueUsd: 10.00, pointMultiplier: 10000,initialMarginEst: 3500, category: 'energy', micro: false, priceFromProxy: { method: 'proxy_only', note: 'NG futures price will be wired via TwelveData / Tradovate. Showing UNG as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'UNG', citationNote: 'Nat gas. EIA storage NOT wired. Use COT + technicals + weather narrative from news.' } },

  QG:  { root: 'QG',  tickSize: 0.005, tickValueUsd: 12.50, pointMultiplier: 2500, initialMarginEst: 900,  category: 'energy', micro: true, priceFromProxy: { method: 'proxy_only', note: 'QG futures price will be wired via TwelveData / Tradovate. Showing UNG as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'UNG', citationNote: 'Mini nat gas = 1/4 of NG.' } },

  HO:  { root: 'HO',  tickSize: 0.0001,tickValueUsd: 4.20,  pointMultiplier: 42000,initialMarginEst: 5500, category: 'energy', micro: false, priceFromProxy: { method: 'none', note: 'No ETF proxy for HO; futures price wiring required for accurate analysis.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: null,  citationNote: 'Heating oil. EIA distillate NOT wired.' } },

  RB:  { root: 'RB',  tickSize: 0.0001,tickValueUsd: 4.20,  pointMultiplier: 42000,initialMarginEst: 5000, category: 'energy', micro: false, priceFromProxy: { method: 'proxy_only', note: 'RB futures price will be wired in a later session. Showing UGA as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'UGA', citationNote: 'RBOB Gasoline. EIA gasoline stocks NOT wired.' } },

  BZ:  { root: 'BZ',  tickSize: 0.01,  tickValueUsd: 10.00, pointMultiplier: 1000, initialMarginEst: 6800, category: 'energy', micro: false, priceFromProxy: { method: 'none', note: 'No ETF proxy for BZ Brent; futures price wiring required.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: null,  citationNote: 'Brent crude. OPEC + EIA NOT wired.' } },

  // Metals
  GC:  { root: 'GC',  tickSize: 0.10,   tickValueUsd: 10.00, pointMultiplier: 100,   initialMarginEst: 11000, category: 'metals', micro: false, priceFromProxy: { method: 'proxy_only', note: 'GC futures price will be wired in a later session. Showing GLD as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'GLD',  citationNote: 'Gold. COMEX warehouse + LBMA + WGC central bank flows NOT wired. Use COT + DXY + macro. GLD correlated proxy.' } },

  MGC: { root: 'MGC', tickSize: 0.10,   tickValueUsd: 1.00,  pointMultiplier: 10,    initialMarginEst: 1100,  category: 'metals', micro: true, priceFromProxy: { method: 'proxy_only', note: 'MGC futures price will be wired. Showing GLD as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'GLD',  citationNote: 'Micro gold = 1/10 of GC.' } },

  SI:  { root: 'SI',  tickSize: 0.005,  tickValueUsd: 25.00, pointMultiplier: 5000,  initialMarginEst: 13000, category: 'metals', micro: false, priceFromProxy: { method: 'proxy_only', note: 'SI futures price will be wired. Showing SLV as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'SLV',  citationNote: 'Silver. Same caveats as gold. SLV correlated proxy. Industrial demand component.' } },

  SIL: { root: 'SIL', tickSize: 0.005,  tickValueUsd: 12.50, pointMultiplier: 2500,  initialMarginEst: 6500,  category: 'metals', micro: true, priceFromProxy: { method: 'proxy_only', note: 'SIL futures price will be wired. Showing SLV as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'SLV',  citationNote: 'Mini silver = 1/2 of SI.' } },

  HG:  { root: 'HG',  tickSize: 0.0005, tickValueUsd: 12.50, pointMultiplier: 25000, initialMarginEst: 6500,  category: 'metals', micro: false, priceFromProxy: { method: 'proxy_only', note: 'HG futures price will be wired. Showing CPER as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'CPER', citationNote: 'Copper. Industrial demand (China) dominant. Not wired.' } },

  MHG: { root: 'MHG', tickSize: 0.0005, tickValueUsd: 1.25,  pointMultiplier: 2500,  initialMarginEst: 650,   category: 'metals', micro: true, priceFromProxy: { method: 'proxy_only', note: 'MHG futures price will be wired. Showing CPER as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'CPER', citationNote: 'Micro copper = 1/10 of HG.' } },

  PL:  { root: 'PL',  tickSize: 0.10,   tickValueUsd: 5.00,  pointMultiplier: 50,    initialMarginEst: 3500,  category: 'metals', micro: false, priceFromProxy: { method: 'proxy_only', note: 'PL futures price will be wired. Showing PPLT as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'PPLT', citationNote: 'Platinum. Auto catalyst demand. Not wired.' } },

  PA:  { root: 'PA',  tickSize: 0.10,   tickValueUsd: 10.00, pointMultiplier: 100,   initialMarginEst: 18000, category: 'metals', micro: false, priceFromProxy: { method: 'proxy_only', note: 'PA futures price will be wired. Showing PALL as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'PALL', citationNote: 'Palladium. Russia/SA supply + auto demand. Volatile.' } },

  // Grains
  ZC:  { root: 'ZC',  tickSize: 0.25, tickValueUsd: 12.50, pointMultiplier: 50,  initialMarginEst: 2500, category: 'grains', micro: false, priceFromProxy: { method: 'proxy_only', note: 'ZC futures price will be wired. Showing CORN as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'CORN', citationNote: 'Corn (cents/bushel). USDA WASDE + crop progress + drought NOT wired. Use COT + seasonal + news.' } },

  ZW:  { root: 'ZW',  tickSize: 0.25, tickValueUsd: 12.50, pointMultiplier: 50,  initialMarginEst: 2800, category: 'grains', micro: false, priceFromProxy: { method: 'proxy_only', note: 'ZW futures price will be wired. Showing WEAT as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'WEAT', citationNote: 'Wheat. USDA NOT wired. Russia/Ukraine supply context matters.' } },

  ZS:  { root: 'ZS',  tickSize: 0.25, tickValueUsd: 12.50, pointMultiplier: 50,  initialMarginEst: 3500, category: 'grains', micro: false, priceFromProxy: { method: 'proxy_only', note: 'ZS futures price will be wired. Showing SOYB as proxy reference.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'SOYB', citationNote: 'Soybeans. China demand + USDA NOT wired.' } },

  ZM:  { root: 'ZM',  tickSize: 0.10, tickValueUsd: 10.00, pointMultiplier: 100, initialMarginEst: 2500, category: 'grains', micro: false, priceFromProxy: { method: 'none', note: 'No clean ETF proxy for ZM soybean meal; futures price wiring required.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: null,   citationNote: 'Soybean meal. Tied to ZS.' } },

  ZL:  { root: 'ZL',  tickSize: 0.01, tickValueUsd: 6.00,  pointMultiplier: 600, initialMarginEst: 2500, category: 'grains', micro: false, priceFromProxy: { method: 'none', note: 'No clean ETF proxy for ZL soybean oil; futures price wiring required.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: null,   citationNote: 'Soybean oil. Tied to ZS.' } },

  // Rates
  ZB:  { root: 'ZB',  tickSize: 0.03125,   tickValueUsd: 31.250, pointMultiplier: 1000, initialMarginEst: 3500, category: 'rates', micro: false, priceFromProxy: { method: 'proxy_only', note: 'ZB futures trade in 32nds; TLT ETF is inverse-correlated proxy. Real price wiring required.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'TLT', citationNote: '30Y T-bond. FRED + Fed funds futures + auctions NOT wired. Use COT + macro. TLT inverse proxy.' } },

  UB:  { root: 'UB',  tickSize: 0.03125,   tickValueUsd: 31.250, pointMultiplier: 1000, initialMarginEst: 5500, category: 'rates', micro: false, priceFromProxy: { method: 'proxy_only', note: 'UB ultra-bond. Same caveats as ZB. TLT as inverse proxy.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'TLT', citationNote: 'Ultra T-bond (higher duration).' } },

  ZN:  { root: 'ZN',  tickSize: 0.015625,  tickValueUsd: 15.625, pointMultiplier: 1000, initialMarginEst: 2200, category: 'rates', micro: false, priceFromProxy: { method: 'proxy_only', note: 'ZN 10Y trades in 32nds. IEF inverse-correlated proxy. Real price wiring required.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'IEF', citationNote: '10Y T-note. IEF proxy.' } },

  TN:  { root: 'TN',  tickSize: 0.015625,  tickValueUsd: 15.625, pointMultiplier: 1000, initialMarginEst: 2800, category: 'rates', micro: false, priceFromProxy: { method: 'proxy_only', note: 'TN ultra-10Y. Same caveats as ZN.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'IEF', citationNote: 'Ultra 10Y T-note.' } },

  ZF:  { root: 'ZF',  tickSize: 0.0078125, tickValueUsd: 7.8125, pointMultiplier: 1000, initialMarginEst: 1500, category: 'rates', micro: false, priceFromProxy: { method: 'proxy_only', note: 'ZF 5Y trades in 32nds. IEI inverse-correlated proxy.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'IEI', citationNote: '5Y T-note.' } },

  ZT:  { root: 'ZT',  tickSize: 0.0078125, tickValueUsd: 15.625, pointMultiplier: 2000, initialMarginEst: 800,  category: 'rates', micro: false, priceFromProxy: { method: 'proxy_only', note: 'ZT 2Y trades in 32nds. SHY inverse-correlated proxy.' }, dataLayer: { fundamentalsWired: false, underlyingEtfProxy: 'SHY', citationNote: '2Y T-note.' } },

  // FX futures (CME)
  '6E': { root: '6E', tickSize: 0.00005,   tickValueUsd: 6.25, pointMultiplier: 125000,  initialMarginEst: 3000, category: 'fx', micro: false, priceFromProxy: { method: 'none', note: 'CME EUR futures use EURUSD spot from forex stack (no ETF proxy).' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: null, citationNote: 'Euro FX futures. Use EURUSD spot via existing forex stack.' } },

  '6B': { root: '6B', tickSize: 0.0001,    tickValueUsd: 6.25, pointMultiplier: 62500,   initialMarginEst: 2400, category: 'fx', micro: false, priceFromProxy: { method: 'none', note: 'CME GBP futures use GBPUSD spot.' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: null, citationNote: 'GBP futures. Use GBPUSD spot.' } },

  '6J': { root: '6J', tickSize: 0.0000005, tickValueUsd: 6.25, pointMultiplier: 12500000,initialMarginEst: 2800, category: 'fx', micro: false, priceFromProxy: { method: 'none', note: 'CME JPY futures use USDJPY (inverted) spot.' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: null, citationNote: 'JPY futures. Use USDJPY (inverted) spot.' } },

  '6A': { root: '6A', tickSize: 0.00005,   tickValueUsd: 5.00, pointMultiplier: 100000,  initialMarginEst: 1900, category: 'fx', micro: false, priceFromProxy: { method: 'none', note: 'CME AUD futures use AUDUSD spot.' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: null, citationNote: 'AUD futures. Use AUDUSD spot.' } },

  '6C': { root: '6C', tickSize: 0.00005,   tickValueUsd: 5.00, pointMultiplier: 100000,  initialMarginEst: 1700, category: 'fx', micro: false, priceFromProxy: { method: 'none', note: 'CME CAD futures use USDCAD (inverted) spot.' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: null, citationNote: 'CAD futures. Use USDCAD (inverted) spot.' } },

  '6S': { root: '6S', tickSize: 0.0001,    tickValueUsd: 12.50,pointMultiplier: 125000,  initialMarginEst: 3500, category: 'fx', micro: false, priceFromProxy: { method: 'none', note: 'CME CHF futures use USDCHF spot.' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: null, citationNote: 'CHF futures. Use USDCHF spot.' } },

  '6N': { root: '6N', tickSize: 0.0001,    tickValueUsd: 10.00,pointMultiplier: 100000,  initialMarginEst: 2000, category: 'fx', micro: false, priceFromProxy: { method: 'none', note: 'CME NZD futures use NZDUSD spot.' }, dataLayer: { fundamentalsWired: true, underlyingEtfProxy: null, citationNote: 'NZD futures. Use NZDUSD spot.' } },

}

export function getFuturesSpec(rootOrSymbol: string): FuturesContractSpec | null {
  const cleaned = rootOrSymbol.replace(/[FGHJKMNQUVXZ][0-9]{1,2}$/, '')
  return FUTURES_SPECS[cleaned] ?? null
}

export interface FuturesSizingInput {
  accountEquity: number; riskPerTradePct: number; maxPositionPct: number
  entryPrice: number; stopPrice: number; rootSymbol: string
  traderPositionSizePct?: number

  // Per-trade dollar bounds (Audit Phase 2). NULL = unbounded.
  // For futures, "notional" = estimated margin used (not market value of underlying).
  minDollarRiskPerTrade?: number | null
  maxDollarRiskPerTrade?: number | null
  minTradeNotional?: number | null   // floor on estimated margin
  maxTradeNotional?: number | null   // ceiling on estimated margin
}

export type FuturesSizingOutcome =
  | { ok: true; contracts: number; stopTicks: number; riskPerContract: number; totalDollarRisk: number; estimatedMarginUsd: number; spec: FuturesContractSpec; rationale: string }
  | { ok: false; reason: string }

export function computeFuturesSize(input: FuturesSizingInput): FuturesSizingOutcome {
  const { accountEquity, riskPerTradePct, maxPositionPct, entryPrice, stopPrice, rootSymbol,
    traderPositionSizePct = 1,
    minDollarRiskPerTrade = null,
    maxDollarRiskPerTrade = null,
    minTradeNotional = null,
    maxTradeNotional = null,
  } = input
  if (!Number.isFinite(accountEquity) || accountEquity <= 0) return { ok: false, reason: `Invalid accountEquity: ${accountEquity}` }
  if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 0.05) return { ok: false, reason: `Invalid riskPerTradePct: ${riskPerTradePct}` }
  if (!Number.isFinite(maxPositionPct) || maxPositionPct <= 0 || maxPositionPct > 0.50) return { ok: false, reason: `Invalid maxPositionPct: ${maxPositionPct}` }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: false, reason: `Invalid entryPrice: ${entryPrice}` }
  if (!Number.isFinite(stopPrice) || stopPrice <= 0) return { ok: false, reason: `Invalid stopPrice: ${stopPrice}` }
  if (!Number.isFinite(traderPositionSizePct) || traderPositionSizePct <= 0 || traderPositionSizePct > 1) return { ok: false, reason: `Invalid traderPositionSizePct: ${traderPositionSizePct}` }
  const spec = getFuturesSpec(rootSymbol)
  if (!spec) return { ok: false, reason: `Unknown futures root: ${rootSymbol}` }
  const stopDistance = Math.abs(entryPrice - stopPrice)
  if (stopDistance <= 0) return { ok: false, reason: 'Stop equals entry — distance is zero' }
  const stopTicks = stopDistance / spec.tickSize
  if (stopTicks < 1) return { ok: false, reason: `Stop too tight: ${stopTicks.toFixed(2)} ticks` }
  const riskPerContract = stopTicks * spec.tickValueUsd
  const baseDollarRisk = accountEquity * riskPerTradePct * traderPositionSizePct
  let contracts = Math.floor(baseDollarRisk / riskPerContract)
  if (contracts < 1) return { ok: false, reason: `Risk $${baseDollarRisk.toFixed(2)} below 1 contract of ${rootSymbol} ($${riskPerContract.toFixed(2)} per contract at ${stopTicks.toFixed(1)}-tick stop)` }
  const maxMargin = accountEquity * maxPositionPct
  const marginAllowedContracts = Math.floor(maxMargin / spec.initialMarginEst)
  let capped = false
  let cappedReason: string | null = null
  if (contracts > marginAllowedContracts) {
    if (marginAllowedContracts < 1) return { ok: false, reason: `Initial margin $${spec.initialMarginEst} for 1 ${rootSymbol} exceeds maxPositionPct ${(maxPositionPct * 100).toFixed(0)}% of $${accountEquity.toFixed(0)} equity` }
    contracts = marginAllowedContracts
    capped = true
    cappedReason = `${(maxPositionPct * 100).toFixed(0)}% margin cap`
  }

  // Per-trade dollar ceilings (Audit Phase 2)
  if (maxDollarRiskPerTrade !== null && Number.isFinite(maxDollarRiskPerTrade) && maxDollarRiskPerTrade > 0) {
    const maxContractsByRisk = Math.floor(maxDollarRiskPerTrade / riskPerContract)
    if (contracts > maxContractsByRisk) {
      if (maxContractsByRisk < 1) {
        return { ok: false, reason: `max_dollar_risk_per_trade $${maxDollarRiskPerTrade.toFixed(2)} below 1 contract risk ($${riskPerContract.toFixed(2)})` }
      }
      contracts = maxContractsByRisk
      capped = true
      cappedReason = `max_dollar_risk_per_trade $${maxDollarRiskPerTrade.toFixed(2)}`
    }
  }
  if (maxTradeNotional !== null && Number.isFinite(maxTradeNotional) && maxTradeNotional > 0) {
    // For futures, notional bound applies to estimated margin
    const maxContractsByMargin = Math.floor(maxTradeNotional / spec.initialMarginEst)
    if (contracts > maxContractsByMargin) {
      if (maxContractsByMargin < 1) {
        return { ok: false, reason: `max_trade_notional $${maxTradeNotional.toFixed(2)} below 1 contract margin (~$${spec.initialMarginEst})` }
      }
      contracts = maxContractsByMargin
      capped = true
      cappedReason = `max_trade_notional $${maxTradeNotional.toFixed(2)}`
    }
  }

  const totalDollarRisk = contracts * riskPerContract
  const estimatedMarginUsd = contracts * spec.initialMarginEst

  // Per-trade dollar floors — skip if below
  if (minDollarRiskPerTrade !== null && Number.isFinite(minDollarRiskPerTrade) && minDollarRiskPerTrade > 0) {
    if (totalDollarRisk < minDollarRiskPerTrade) {
      return { ok: false, reason: `totalDollarRisk $${totalDollarRisk.toFixed(2)} below min_dollar_risk_per_trade $${minDollarRiskPerTrade.toFixed(2)}` }
    }
  }
  if (minTradeNotional !== null && Number.isFinite(minTradeNotional) && minTradeNotional > 0) {
    if (estimatedMarginUsd < minTradeNotional) {
      return { ok: false, reason: `estimatedMargin $${estimatedMarginUsd.toFixed(2)} below min_trade_notional $${minTradeNotional.toFixed(2)}` }
    }
  }

  return { ok: true, contracts, stopTicks, riskPerContract, totalDollarRisk, estimatedMarginUsd, spec,
    rationale: capped
      ? `${contracts}× ${rootSymbol} (capped by ${cappedReason ?? 'cap'}, $${estimatedMarginUsd.toFixed(0)} margin, $${totalDollarRisk.toFixed(2)} risk)`
      : `${contracts}× ${rootSymbol} ($${totalDollarRisk.toFixed(2)} risk at ${stopTicks.toFixed(1)} ticks, margin ~$${estimatedMarginUsd.toFixed(0)})` }
}

export function isFuturesRootSupported(root: string): boolean {
  const cleaned = root.replace(/[FGHJKMNQUVXZ][0-9]{1,2}$/, '')
  return cleaned in FUTURES_SPECS
}

/**
 * Compute the futures contract price from an underlying ETF/spot price.
 * Returns { price, note } where note explains the derivation.
 *
 * - 'linear': futures = proxy * multiplier (ES = SPY * 10)
 * - 'proxy_only': return proxy price unchanged with explicit approximation note
 * - 'none': return null (caller must fetch from elsewhere)
 *
 * The note is intended to be passed into the Council prompt and dashboard
 * so the price approximation is visible, not silent.
 */
export function deriveFuturesPriceFromProxy(
  rootOrSymbol: string,
  proxyPrice: number,
): { price: number; note: string; approximate: boolean } | null {
  const spec = getFuturesSpec(rootOrSymbol)
  if (!spec || !spec.priceFromProxy) return null
  const cfg = spec.priceFromProxy
  if (!Number.isFinite(proxyPrice) || proxyPrice <= 0) return null
  if (cfg.method === 'linear' && cfg.multiplier !== undefined) {
    return {
      price: proxyPrice * cfg.multiplier,
      note: cfg.note ?? `${spec.root} = proxy × ${cfg.multiplier}`,
      approximate: true,
    }
  }
  if (cfg.method === 'proxy_only') {
    return {
      price: proxyPrice,
      note: cfg.note ?? `${spec.root} price shown is from underlying ETF proxy, not the contract itself.`,
      approximate: true,
    }
  }
  // method === 'none': caller needs another data source
  return null
}
