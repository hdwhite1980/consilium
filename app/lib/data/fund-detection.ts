// =============================================================
// app/lib/data/fund-detection.ts
//
// Identifies ETFs, ETPs, mutual funds, and other non-operating-company
// tickers so the Council can apply the right analytical framework.
//
// Why this exists:
//   - Commodity ETFs (USO, GLD, UNG) have no earnings, no dilution risk
//     in the traditional sense, no insider transactions
//   - Their "negative revenue" and "net income loss" in fundamentals data
//     are accounting artifacts of futures roll costs and management fees
//   - Their continuous 424B3 prospectus filings are routine ETF mechanics,
//     NOT signs of imminent dilutive equity issuance
//   - Treating them like operating companies produces nonsense verdicts
//     (e.g., "short USO because of dilution risk" — see April 28 2026 verdict)
//
// Three categorization tiers:
//   1. commodity:    Tracks a commodity (oil, gold, ag, etc.)
//   2. volatility:   Tracks VIX or volatility indices
//   3. equity-fund:  Tracks an equity index, sector, or theme
//   4. leveraged:    2x/3x leveraged or inverse fund
//   5. bond:         Treasury, corporate bond, etc.
//   6. unknown:      Not in our list, treat as regular equity
// =============================================================

export type FundCategory =
  | 'commodity'
  | 'volatility'
  | 'equity-fund'
  | 'leveraged'
  | 'bond'
  | 'unknown'

export interface FundInfo {
  isFund: boolean
  category: FundCategory
  description: string  // human-readable for prompt context
  tracksUnderlying: string | null  // what the fund tracks
}

// =============================================================
// Curated lookup — common ETFs/funds that hit a /analyze run
// =============================================================
// Format: ticker -> [category, description, underlying]
//
// This list is curated (not exhaustive). Tickers not in this list
// fall through to heuristic detection, then default to 'unknown'
// (treated as regular equity).
//
// Source priority: most-liquid, most-likely-analyzed funds first.

const FUND_REGISTRY: Record<string, [FundCategory, string, string]> = {
  // ── Broad market ──────────────────────────────────────────────
  'SPY':  ['equity-fund', 'S&P 500 ETF', 'S&P 500 index'],
  'VOO':  ['equity-fund', 'Vanguard S&P 500 ETF', 'S&P 500 index'],
  'IVV':  ['equity-fund', 'iShares Core S&P 500 ETF', 'S&P 500 index'],
  'QQQ':  ['equity-fund', 'Nasdaq-100 ETF', 'Nasdaq-100 index'],
  'QQQM': ['equity-fund', 'Nasdaq-100 ETF (Mini)', 'Nasdaq-100 index'],
  'DIA':  ['equity-fund', 'Dow Jones Industrial Average ETF', 'DJIA'],
  'IWM':  ['equity-fund', 'Russell 2000 ETF', 'Russell 2000 small-caps'],
  'IWB':  ['equity-fund', 'Russell 1000 ETF', 'Russell 1000'],
  'VTI':  ['equity-fund', 'Total Stock Market ETF', 'CRSP Total Market'],
  'VEA':  ['equity-fund', 'Developed Markets ETF', 'FTSE Developed ex-US'],
  'VWO':  ['equity-fund', 'Emerging Markets ETF', 'FTSE Emerging Markets'],
  'EFA':  ['equity-fund', 'iShares EAFE ETF', 'developed ex-US-Canada'],
  'EEM':  ['equity-fund', 'iShares Emerging Markets ETF', 'MSCI EM'],

  // ── Sector SPDRs ──────────────────────────────────────────────
  'XLK':  ['equity-fund', 'Technology Select Sector SPDR', 'tech sector'],
  'XLF':  ['equity-fund', 'Financial Select Sector SPDR', 'financials sector'],
  'XLE':  ['equity-fund', 'Energy Select Sector SPDR', 'energy sector'],
  'XLV':  ['equity-fund', 'Health Care Select Sector SPDR', 'healthcare'],
  'XLI':  ['equity-fund', 'Industrial Select Sector SPDR', 'industrials'],
  'XLP':  ['equity-fund', 'Consumer Staples Select Sector SPDR', 'staples'],
  'XLY':  ['equity-fund', 'Consumer Discretionary Select Sector SPDR', 'discretionary'],
  'XLU':  ['equity-fund', 'Utilities Select Sector SPDR', 'utilities'],
  'XLB':  ['equity-fund', 'Materials Select Sector SPDR', 'materials'],
  'XLRE': ['equity-fund', 'Real Estate Select Sector SPDR', 'REITs/real estate'],
  'XLC':  ['equity-fund', 'Communication Services SPDR', 'communications/media'],
  'SOXX': ['equity-fund', 'iShares Semiconductor ETF', 'semiconductor stocks'],
  'SMH':  ['equity-fund', 'VanEck Semiconductor ETF', 'semiconductor stocks'],
  'IBB':  ['equity-fund', 'iShares Biotechnology ETF', 'biotech sector'],
  'XBI':  ['equity-fund', 'SPDR Biotech ETF', 'biotech (equal-weight)'],
  'KRE':  ['equity-fund', 'SPDR Regional Banking ETF', 'regional banks'],
  'KBE':  ['equity-fund', 'SPDR Bank ETF', 'banks broadly'],
  'ITA':  ['equity-fund', 'iShares Aerospace & Defense ETF', 'aerospace/defense'],
  'ITB':  ['equity-fund', 'iShares Home Construction ETF', 'homebuilders'],
  'XHB':  ['equity-fund', 'SPDR Homebuilders ETF', 'homebuilders'],
  'XRT':  ['equity-fund', 'SPDR Retail ETF', 'retail sector'],
  'XME':  ['equity-fund', 'SPDR Metals & Mining ETF', 'metals & mining'],
  'XOP':  ['equity-fund', 'SPDR Oil & Gas Exploration ETF', 'E&P companies'],
  'OIH':  ['equity-fund', 'VanEck Oil Services ETF', 'oil services'],

  // ── Commodity ETFs (the USO category) ─────────────────────────
  'USO':  ['commodity', 'United States Oil Fund', 'WTI crude oil futures'],
  'BNO':  ['commodity', 'United States Brent Oil Fund', 'Brent crude futures'],
  'UNG':  ['commodity', 'United States Natural Gas Fund', 'natural gas futures'],
  'UCO':  ['leveraged', 'ProShares 2x Crude Oil', 'WTI crude oil futures (2x)'],
  'SCO':  ['leveraged', 'ProShares -2x Crude Oil', 'WTI crude oil futures (-2x)'],
  'GLD':  ['commodity', 'SPDR Gold Trust', 'physical gold'],
  'IAU':  ['commodity', 'iShares Gold Trust', 'physical gold'],
  'SLV':  ['commodity', 'iShares Silver Trust', 'physical silver'],
  'PPLT': ['commodity', 'abrdn Physical Platinum Shares', 'physical platinum'],
  'PALL': ['commodity', 'abrdn Physical Palladium Shares', 'physical palladium'],
  'CPER': ['commodity', 'United States Copper Index Fund', 'copper futures'],
  'DBC':  ['commodity', 'Invesco DB Commodity Tracking', 'broad commodity index'],
  'DBA':  ['commodity', 'Invesco DB Agriculture', 'agricultural commodities'],
  'CORN': ['commodity', 'Teucrium Corn Fund', 'corn futures'],
  'WEAT': ['commodity', 'Teucrium Wheat Fund', 'wheat futures'],
  'SOYB': ['commodity', 'Teucrium Soybean Fund', 'soybean futures'],
  'CANE': ['commodity', 'Teucrium Sugar Fund', 'sugar futures'],
  'JJC':  ['commodity', 'iPath Copper Subindex', 'copper futures'],
  'URA':  ['equity-fund', 'Global X Uranium ETF', 'uranium mining stocks'],

  // ── Volatility ────────────────────────────────────────────────
  'VXX':  ['volatility', 'iPath VIX Short-Term ETN', 'VIX short-term futures'],
  'UVXY': ['leveraged', 'ProShares 1.5x VIX Short-Term', 'VIX futures (1.5x)'],
  'SVXY': ['leveraged', 'ProShares -0.5x VIX Short-Term', 'VIX futures (-0.5x)'],
  'VIXY': ['volatility', 'ProShares VIX Short-Term', 'VIX short-term futures'],

  // ── Bonds ─────────────────────────────────────────────────────
  'TLT':  ['bond', 'iShares 20+ Year Treasury Bond ETF', 'long-dated Treasuries'],
  'IEF':  ['bond', 'iShares 7-10 Year Treasury Bond ETF', 'intermediate Treasuries'],
  'SHY':  ['bond', 'iShares 1-3 Year Treasury Bond ETF', 'short-term Treasuries'],
  'BND':  ['bond', 'Vanguard Total Bond Market ETF', 'broad investment-grade bonds'],
  'AGG':  ['bond', 'iShares Core US Aggregate Bond ETF', 'broad investment-grade bonds'],
  'LQD':  ['bond', 'iShares Investment Grade Corporate Bond', 'IG corporates'],
  'HYG':  ['bond', 'iShares High Yield Corporate Bond', 'high-yield corporates'],
  'JNK':  ['bond', 'SPDR High Yield Bond ETF', 'high-yield corporates'],
  'TIP':  ['bond', 'iShares TIPS Bond ETF', 'inflation-protected Treasuries'],
  'MUB':  ['bond', 'iShares National Muni Bond ETF', 'municipal bonds'],

  // ── Leveraged equity ──────────────────────────────────────────
  'TQQQ': ['leveraged', 'ProShares 3x Nasdaq-100', 'Nasdaq-100 (3x)'],
  'SQQQ': ['leveraged', 'ProShares -3x Nasdaq-100', 'Nasdaq-100 (-3x)'],
  'SPXL': ['leveraged', 'Direxion 3x S&P 500', 'S&P 500 (3x)'],
  'SPXS': ['leveraged', 'Direxion -3x S&P 500', 'S&P 500 (-3x)'],
  'SOXL': ['leveraged', 'Direxion 3x Semiconductor', 'semis (3x)'],
  'SOXS': ['leveraged', 'Direxion -3x Semiconductor', 'semis (-3x)'],
  'TNA':  ['leveraged', 'Direxion 3x Small Cap', 'Russell 2000 (3x)'],
  'TZA':  ['leveraged', 'Direxion -3x Small Cap', 'Russell 2000 (-3x)'],
  'FAS':  ['leveraged', 'Direxion 3x Financials', 'financials (3x)'],
  'FAZ':  ['leveraged', 'Direxion -3x Financials', 'financials (-3x)'],
  'NUGT': ['leveraged', 'Direxion 2x Gold Miners', 'gold miners (2x)'],
  'DUST': ['leveraged', 'Direxion -2x Gold Miners', 'gold miners (-2x)'],
  'JNUG': ['leveraged', 'Direxion 2x Junior Gold Miners', 'jr gold miners (2x)'],
  'JDST': ['leveraged', 'Direxion -2x Junior Gold Miners', 'jr gold miners (-2x)'],

  // ── International / thematic ──────────────────────────────────
  'FXI':  ['equity-fund', 'iShares China Large-Cap', 'China large-caps'],
  'MCHI': ['equity-fund', 'iShares MSCI China', 'China broad'],
  'EWJ':  ['equity-fund', 'iShares MSCI Japan', 'Japan large-caps'],
  'EWZ':  ['equity-fund', 'iShares MSCI Brazil', 'Brazil large-caps'],
  'INDA': ['equity-fund', 'iShares MSCI India', 'India large-caps'],
  'EWY':  ['equity-fund', 'iShares MSCI South Korea', 'Korea large-caps'],
  'EWT':  ['equity-fund', 'iShares MSCI Taiwan', 'Taiwan large-caps'],
  'ICLN': ['equity-fund', 'iShares Global Clean Energy ETF', 'clean energy stocks'],
  'TAN':  ['equity-fund', 'Invesco Solar ETF', 'solar stocks'],
  'LIT':  ['equity-fund', 'Global X Lithium & Battery Tech', 'lithium/battery stocks'],
  'JETS': ['equity-fund', 'US Global Jets ETF', 'airlines'],
  'ARKK': ['equity-fund', 'ARK Innovation ETF', 'disruptive innovation stocks'],
  'ARKG': ['equity-fund', 'ARK Genomic Revolution ETF', 'genomics stocks'],
  'ARKW': ['equity-fund', 'ARK Next Generation Internet', 'internet/cloud stocks'],
}

// =============================================================
// Heuristic detection for tickers not in registry
// =============================================================
//
// Rough heuristics — won't catch everything but covers common
// cases. False positives are OK (treats some equity like ETF =
// minor prompt waste); false negatives are NOT OK (treats ETF
// like equity = the bug we're fixing).

function heuristicFundDetection(ticker: string): FundInfo | null {
  // Direxion 3x patterns: 3-letter tickers ending in BULL/BEAR-like codes
  // Most are already in registry. Skip.

  // Vanguard "V*" ETFs — VOO, VTI, VEA, VWO covered above
  // VanEck "VAN*" prefix — too rare to heuristic

  // Common ETF-naming patterns
  const t = ticker.toUpperCase()

  // ProShares Ultra/UltraShort 2x/3x: starts with U, S, etc. Too unreliable.
  // iShares: typically "I*" but many real companies start with I (IBM)

  // Don't make false positives — only flag if reasonably certain.
  // Returning null falls through to 'unknown' which treats as equity.
  return null
}

// =============================================================
// Public API
// =============================================================

export function isFundTicker(ticker: string): boolean {
  if (!ticker) return false
  const t = ticker.toUpperCase().trim()
  if (t in FUND_REGISTRY) return true
  return heuristicFundDetection(t) !== null
}

export function getFundInfo(ticker: string): FundInfo {
  const empty: FundInfo = {
    isFund: false,
    category: 'unknown',
    description: '',
    tracksUnderlying: null,
  }
  if (!ticker) return empty

  const t = ticker.toUpperCase().trim()
  const entry = FUND_REGISTRY[t]
  if (entry) {
    return {
      isFund: true,
      category: entry[0],
      description: entry[1],
      tracksUnderlying: entry[2],
    }
  }

  const heuristic = heuristicFundDetection(t)
  if (heuristic) return heuristic

  return empty
}

// =============================================================
// Prompt-ready guidance string for fund-type tickers
// =============================================================

export function buildFundContext(info: FundInfo): string {
  if (!info.isFund) return ''

  const base = `${info.description} — tracks ${info.tracksUnderlying}.`

  switch (info.category) {
    case 'commodity':
      return `FUND TYPE: This ticker is a COMMODITY ETF/ETP. ${base}
ANALYTICAL FRAMEWORK FOR COMMODITY ETFs:
- These funds hold futures contracts (or physical assets) — they are NOT operating companies.
- DO NOT analyze: P/E ratio, EPS, revenue, net income, profit margins, "earnings" reports, analyst recommendations on the fund itself, insider trading, dilution risk from prospectus filings.
- 424B3 prospectus filings are ROUTINE for ETFs (continuous share creation/redemption mechanics) and DO NOT signal imminent dilutive equity issuance.
- Reported "negative revenue" or "net income losses" are accounting artifacts (futures roll costs, management fees, contango drag) — not business deterioration.
- DO analyze: technical price action, the underlying commodity's supply/demand, geopolitical drivers, macro regime, contango/backwardation in the futures curve, ETF tracking error vs spot price, fund flows.
- The Devil's Advocate should pressure-test on: contango drag (chronic decay vs spot), tracking error, parabolic moves at ATH that often mean-revert, futures-curve dynamics, NOT on company fundamentals.`

    case 'volatility':
      return `FUND TYPE: This ticker is a VOLATILITY-LINKED ETP. ${base}
ANALYTICAL FRAMEWORK FOR VOLATILITY ETPs:
- These products track VIX futures, NOT realized volatility or stocks. They have STRUCTURAL DECAY due to futures roll costs (contango).
- DO NOT analyze: P/E, earnings, revenue, dilution from prospectus filings, insider activity, analyst recommendations.
- 424B3 filings are routine ETP mechanics, not dilution events.
- DO analyze: VIX index level and term structure, contango/backwardation in VIX futures, market regime (risk-on/risk-off), expected mean reversion, time decay.
- The Devil's Advocate should attack on: structural decay (long-VIX products lose ~5-15%/month in calm markets), mean-reversion mathematics, regime-mismatch.`

    case 'leveraged':
      return `FUND TYPE: This ticker is a LEVERAGED/INVERSE ETF. ${base}
ANALYTICAL FRAMEWORK FOR LEVERAGED FUNDS:
- These rebalance DAILY to maintain leverage. They are NOT designed for long-term holding — they suffer compounding decay in volatile or sideways markets ("volatility drag").
- DO NOT analyze: P/E, earnings, revenue, dilution from prospectus filings, insider activity, analyst recommendations on the fund itself.
- DO analyze: the underlying index/sector being tracked, holding period, market volatility regime, daily-rebalancing decay risk, suitability for the timeframe.
- The Devil's Advocate should attack on: holding-period mismatch (multi-day moves don't equal stated leverage), volatility drag, structural decay in choppy markets.`

    case 'bond':
      return `FUND TYPE: This ticker is a BOND ETF. ${base}
ANALYTICAL FRAMEWORK FOR BOND ETFs:
- DO NOT analyze: P/E, earnings, revenue, dilution from prospectus filings, insider activity (the FUND has none — issuers within the fund do, but those are different securities).
- DO analyze: interest rate environment (Fed policy, yield curve), duration risk, credit spreads (for non-Treasury), inflation expectations, technical levels.
- The Devil's Advocate should attack on: duration mismatch with timeframe, rate-hike risk, credit deterioration (for HY/LQD), curve dynamics.`

    case 'equity-fund':
      return `FUND TYPE: This ticker is an EQUITY-INDEX/SECTOR ETF. ${base}
ANALYTICAL FRAMEWORK FOR EQUITY ETFs:
- The fund itself has NO earnings, P/E, or dilution risk in the company sense. The HOLDINGS do, but you're trading the basket.
- DO NOT analyze: the fund's "revenue" or "net income" (these are management-fee and operational artifacts).
- DO NOT cite 424B3 prospectus filings as dilution risk — these are routine ETF mechanics.
- DO analyze: the underlying index/sector trends, sector rotation, top holdings' aggregate fundamentals, technical price action, fund flows.
- The Devil's Advocate should attack on: sector-level risks, rotation away from theme, concentration risk in top holdings, broader macro.`

    default:
      return `FUND TYPE: ${base}
This is a fund product. Apply fund-appropriate analysis: technical price action and the underlying being tracked, NOT operating-company metrics like P/E, earnings, dilution.`
  }
}
