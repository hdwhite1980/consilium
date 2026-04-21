// ═════════════════════════════════════════════════════════════
// app/lib/optionable-universe.ts
//
// Curated list of liquid optionable tickers for the options scanner.
//
// Selection criteria:
//   - High daily volume (>5M avg shares)
//   - Liquid options (tight spreads, high OI at major strikes)
//   - Spans all major sectors for diversification
//   - Plus major ETFs for macro plays
//
// Not just "S&P 500" — many S&P names have illiquid options.
// This list is hand-picked for option liquidity specifically.
// ═════════════════════════════════════════════════════════════

export interface OptionableUniverseEntry {
  ticker: string
  sector: 'tech' | 'healthcare' | 'financials' | 'energy' | 'consumer_disc'
    | 'consumer_staples' | 'industrials' | 'materials' | 'real_estate'
    | 'utilities' | 'communications' | 'crypto_adj' | 'macro_etf'
  tier: 'mega' | 'large' | 'mid'   // liquidity tier
}

export const OPTIONABLE_UNIVERSE: OptionableUniverseEntry[] = [
  // ── Macro ETFs (broad market, sector, macro plays) ─────────
  { ticker: 'SPY',  sector: 'macro_etf', tier: 'mega' },
  { ticker: 'QQQ',  sector: 'macro_etf', tier: 'mega' },
  { ticker: 'IWM',  sector: 'macro_etf', tier: 'mega' },
  { ticker: 'DIA',  sector: 'macro_etf', tier: 'large' },
  { ticker: 'TLT',  sector: 'macro_etf', tier: 'large' },   // long bonds
  { ticker: 'GLD',  sector: 'macro_etf', tier: 'large' },   // gold
  { ticker: 'SLV',  sector: 'macro_etf', tier: 'mid' },     // silver
  { ticker: 'USO',  sector: 'macro_etf', tier: 'mid' },     // oil
  { ticker: 'UVXY', sector: 'macro_etf', tier: 'large' },   // volatility
  { ticker: 'XLE',  sector: 'macro_etf', tier: 'large' },   // energy sector
  { ticker: 'XLF',  sector: 'macro_etf', tier: 'large' },   // financials sector
  { ticker: 'XLK',  sector: 'macro_etf', tier: 'large' },   // tech sector

  // ── Tech mega-caps ─────────────────────────────────────────
  { ticker: 'AAPL', sector: 'tech', tier: 'mega' },
  { ticker: 'MSFT', sector: 'tech', tier: 'mega' },
  { ticker: 'GOOGL', sector: 'tech', tier: 'mega' },
  { ticker: 'AMZN', sector: 'tech', tier: 'mega' },
  { ticker: 'META', sector: 'tech', tier: 'mega' },
  { ticker: 'NVDA', sector: 'tech', tier: 'mega' },
  { ticker: 'TSLA', sector: 'consumer_disc', tier: 'mega' },
  { ticker: 'AMD',  sector: 'tech', tier: 'large' },
  { ticker: 'AVGO', sector: 'tech', tier: 'large' },
  { ticker: 'ORCL', sector: 'tech', tier: 'large' },
  { ticker: 'CRM',  sector: 'tech', tier: 'large' },
  { ticker: 'ADBE', sector: 'tech', tier: 'large' },
  { ticker: 'INTC', sector: 'tech', tier: 'large' },
  { ticker: 'MU',   sector: 'tech', tier: 'large' },
  { ticker: 'QCOM', sector: 'tech', tier: 'large' },
  { ticker: 'PLTR', sector: 'tech', tier: 'large' },
  { ticker: 'SMCI', sector: 'tech', tier: 'mid' },
  { ticker: 'SHOP', sector: 'tech', tier: 'large' },
  { ticker: 'PYPL', sector: 'tech', tier: 'large' },
  { ticker: 'SNOW', sector: 'tech', tier: 'large' },
  { ticker: 'NET',  sector: 'tech', tier: 'mid' },
  { ticker: 'CRWD', sector: 'tech', tier: 'large' },
  { ticker: 'ZS',   sector: 'tech', tier: 'mid' },
  { ticker: 'MDB',  sector: 'tech', tier: 'mid' },

  // ── Healthcare ─────────────────────────────────────────────
  { ticker: 'LLY',   sector: 'healthcare', tier: 'mega' },
  { ticker: 'UNH',   sector: 'healthcare', tier: 'mega' },
  { ticker: 'JNJ',   sector: 'healthcare', tier: 'mega' },
  { ticker: 'ABBV',  sector: 'healthcare', tier: 'large' },
  { ticker: 'MRK',   sector: 'healthcare', tier: 'large' },
  { ticker: 'PFE',   sector: 'healthcare', tier: 'large' },
  { ticker: 'TMO',   sector: 'healthcare', tier: 'large' },
  { ticker: 'ABT',   sector: 'healthcare', tier: 'large' },
  { ticker: 'MRNA',  sector: 'healthcare', tier: 'mid' },
  { ticker: 'GILD',  sector: 'healthcare', tier: 'large' },
  { ticker: 'AMGN',  sector: 'healthcare', tier: 'large' },

  // ── Financials ─────────────────────────────────────────────
  { ticker: 'JPM',  sector: 'financials', tier: 'mega' },
  { ticker: 'BAC',  sector: 'financials', tier: 'large' },
  { ticker: 'WFC',  sector: 'financials', tier: 'large' },
  { ticker: 'GS',   sector: 'financials', tier: 'large' },
  { ticker: 'MS',   sector: 'financials', tier: 'large' },
  { ticker: 'C',    sector: 'financials', tier: 'large' },
  { ticker: 'V',    sector: 'financials', tier: 'mega' },
  { ticker: 'MA',   sector: 'financials', tier: 'mega' },
  { ticker: 'SCHW', sector: 'financials', tier: 'large' },
  { ticker: 'AXP',  sector: 'financials', tier: 'large' },
  { ticker: 'BX',   sector: 'financials', tier: 'large' },

  // ── Energy ─────────────────────────────────────────────────
  { ticker: 'XOM', sector: 'energy', tier: 'mega' },
  { ticker: 'CVX', sector: 'energy', tier: 'large' },
  { ticker: 'COP', sector: 'energy', tier: 'large' },
  { ticker: 'OXY', sector: 'energy', tier: 'large' },
  { ticker: 'SLB', sector: 'energy', tier: 'large' },
  { ticker: 'MPC', sector: 'energy', tier: 'large' },
  { ticker: 'HAL', sector: 'energy', tier: 'mid' },

  // ── Consumer discretionary ─────────────────────────────────
  { ticker: 'HD',   sector: 'consumer_disc', tier: 'large' },
  { ticker: 'MCD',  sector: 'consumer_disc', tier: 'large' },
  { ticker: 'NKE',  sector: 'consumer_disc', tier: 'large' },
  { ticker: 'SBUX', sector: 'consumer_disc', tier: 'large' },
  { ticker: 'DIS',  sector: 'communications', tier: 'large' },
  { ticker: 'BKNG', sector: 'consumer_disc', tier: 'large' },
  { ticker: 'LULU', sector: 'consumer_disc', tier: 'mid' },
  { ticker: 'F',    sector: 'consumer_disc', tier: 'mid' },
  { ticker: 'GM',   sector: 'consumer_disc', tier: 'mid' },
  { ticker: 'RIVN', sector: 'consumer_disc', tier: 'mid' },
  { ticker: 'NIO',  sector: 'consumer_disc', tier: 'mid' },

  // ── Consumer staples ───────────────────────────────────────
  { ticker: 'WMT',  sector: 'consumer_staples', tier: 'mega' },
  { ticker: 'PG',   sector: 'consumer_staples', tier: 'large' },
  { ticker: 'KO',   sector: 'consumer_staples', tier: 'large' },
  { ticker: 'PEP',  sector: 'consumer_staples', tier: 'large' },
  { ticker: 'COST', sector: 'consumer_staples', tier: 'large' },

  // ── Industrials ────────────────────────────────────────────
  { ticker: 'BA',   sector: 'industrials', tier: 'large' },
  { ticker: 'CAT',  sector: 'industrials', tier: 'large' },
  { ticker: 'GE',   sector: 'industrials', tier: 'large' },
  { ticker: 'UPS',  sector: 'industrials', tier: 'large' },
  { ticker: 'RTX',  sector: 'industrials', tier: 'large' },
  { ticker: 'LMT',  sector: 'industrials', tier: 'large' },
  { ticker: 'DE',   sector: 'industrials', tier: 'large' },

  // ── Communications / Media ─────────────────────────────────
  { ticker: 'NFLX', sector: 'communications', tier: 'large' },
  { ticker: 'T',    sector: 'communications', tier: 'mid' },
  { ticker: 'VZ',   sector: 'communications', tier: 'mid' },
  { ticker: 'TMUS', sector: 'communications', tier: 'large' },

  // ── Real estate ────────────────────────────────────────────
  { ticker: 'AMT',  sector: 'real_estate', tier: 'mid' },
  { ticker: 'PLD',  sector: 'real_estate', tier: 'mid' },

  // ── Materials ──────────────────────────────────────────────
  { ticker: 'FCX',  sector: 'materials', tier: 'mid' },
  { ticker: 'NEM',  sector: 'materials', tier: 'mid' },
  { ticker: 'LIN',  sector: 'materials', tier: 'large' },

  // ── Crypto-adjacent ────────────────────────────────────────
  { ticker: 'COIN',  sector: 'crypto_adj', tier: 'large' },
  { ticker: 'MARA',  sector: 'crypto_adj', tier: 'mid' },
  { ticker: 'RIOT',  sector: 'crypto_adj', tier: 'mid' },
  { ticker: 'MSTR',  sector: 'crypto_adj', tier: 'large' },
  { ticker: 'BITO',  sector: 'crypto_adj', tier: 'mid' },
]

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Return just the ticker symbols from the universe.
 * Use for bulk API calls.
 */
export function getUniverseTickers(): string[] {
  return OPTIONABLE_UNIVERSE.map(u => u.ticker)
}

/**
 * Get the universe filtered by tier for budget-appropriate scans.
 * mega and large names have liquid options at more strikes.
 */
export function getUniverseByTier(
  minTier: 'mega' | 'large' | 'mid' = 'mid'
): OptionableUniverseEntry[] {
  if (minTier === 'mega') {
    return OPTIONABLE_UNIVERSE.filter(u => u.tier === 'mega')
  }
  if (minTier === 'large') {
    return OPTIONABLE_UNIVERSE.filter(u => u.tier === 'mega' || u.tier === 'large')
  }
  return OPTIONABLE_UNIVERSE
}

/**
 * Look up metadata for a single ticker (sector, tier).
 * Returns null if not in universe.
 */
export function getUniverseEntry(ticker: string): OptionableUniverseEntry | null {
  const t = ticker.toUpperCase()
  return OPTIONABLE_UNIVERSE.find(u => u.ticker === t) ?? null
}

/**
 * Combine universe with Council candidate tickers, deduplicated.
 * Council candidates take priority (they get the user's actual research).
 */
export function mergeWithCouncilCandidates(
  universe: string[],
  councilTickers: string[]
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  // Council candidates first (higher priority)
  for (const t of councilTickers) {
    const u = t.toUpperCase()
    if (!seen.has(u)) { seen.add(u); result.push(u) }
  }
  // Then the static universe
  for (const t of universe) {
    const u = t.toUpperCase()
    if (!seen.has(u)) { seen.add(u); result.push(u) }
  }
  return result
}
