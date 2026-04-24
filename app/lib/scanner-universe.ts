// ═════════════════════════════════════════════════════════════
// app/lib/scanner-universe.ts
//
// Curated universe of ~500 liquid tickers for the scanner feature.
// Each entry has pre-baked metadata (sector, cap tier, price tier, tags)
// so filters work WITHOUT per-ticker API calls.
//
// Metadata is static (refreshed manually monthly) — sector/cap/price
// don't change meaningfully over 15 minutes. Live data (RSI, volume,
// momentum) comes from fresh bar calculations at scan time.
// ═════════════════════════════════════════════════════════════

export type Sector =
  | 'tech' | 'healthcare' | 'financials' | 'energy' | 'consumer_disc'
  | 'consumer_staples' | 'industrials' | 'materials' | 'real_estate'
  | 'utilities' | 'communications' | 'crypto_adj' | 'macro_etf'
  | 'sector_etf' | 'thematic_etf'

export type CapTier = 'mega' | 'large' | 'mid' | 'small' | 'etf'
export type PriceTier = 'sub10' | 'under50' | 'under100' | 'under500' | 'over500'

export interface UniverseEntry {
  ticker: string
  sector: Sector
  cap: CapTier
  priceTier: PriceTier       // approximate current price bucket
  tags: string[]             // ['dividend', 'growth', 'ai', 'semis', 'ev', 'meme', 'defensive', etc.]
}

// ═════════════════════════════════════════════════════════════
// THE UNIVERSE
// ═════════════════════════════════════════════════════════════
export const SCANNER_UNIVERSE: UniverseEntry[] = [
  // ── MEGA CAP TECH (most liquid) ─────────────────────────────
  { ticker: 'AAPL',  sector: 'tech', cap: 'mega', priceTier: 'under500', tags: ['defensive', 'dividend'] },
  { ticker: 'MSFT',  sector: 'tech', cap: 'mega', priceTier: 'under500', tags: ['ai', 'cloud', 'dividend'] },
  { ticker: 'GOOGL', sector: 'tech', cap: 'mega', priceTier: 'under500', tags: ['ai', 'ad-tech'] },
  { ticker: 'GOOG',  sector: 'tech', cap: 'mega', priceTier: 'under500', tags: ['ai', 'ad-tech'] },
  { ticker: 'AMZN',  sector: 'tech', cap: 'mega', priceTier: 'under500', tags: ['cloud', 'ecommerce'] },
  { ticker: 'META',  sector: 'tech', cap: 'mega', priceTier: 'over500',  tags: ['ai', 'ad-tech'] },
  { ticker: 'NVDA',  sector: 'tech', cap: 'mega', priceTier: 'under500', tags: ['ai', 'semis', 'growth'] },
  { ticker: 'TSLA',  sector: 'consumer_disc', cap: 'mega', priceTier: 'under500', tags: ['ev', 'growth'] },

  // ── LARGE CAP TECH ──────────────────────────────────────────
  { ticker: 'AMD',   sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['ai', 'semis'] },
  { ticker: 'AVGO',  sector: 'tech', cap: 'mega',  priceTier: 'under500', tags: ['ai', 'semis', 'dividend'] },
  { ticker: 'ORCL',  sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['cloud', 'ai', 'dividend'] },
  { ticker: 'CRM',   sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['cloud', 'enterprise'] },
  { ticker: 'ADBE',  sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['cloud', 'enterprise'] },
  { ticker: 'INTC',  sector: 'tech', cap: 'large', priceTier: 'under50',  tags: ['semis', 'turnaround'] },
  { ticker: 'MU',    sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['semis', 'memory'] },
  { ticker: 'QCOM',  sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['semis', '5g', 'dividend'] },
  { ticker: 'PLTR',  sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['ai', 'growth', 'govt'] },
  { ticker: 'SMCI',  sector: 'tech', cap: 'mid',   priceTier: 'under500', tags: ['ai', 'servers', 'volatile'] },
  { ticker: 'SHOP',  sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['ecommerce', 'growth'] },
  { ticker: 'PYPL',  sector: 'tech', cap: 'large', priceTier: 'under100', tags: ['fintech'] },
  { ticker: 'SNOW',  sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['cloud', 'data'] },
  { ticker: 'NET',   sector: 'tech', cap: 'mid',   priceTier: 'under500', tags: ['cloud', 'cybersec'] },
  { ticker: 'CRWD',  sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['cybersec', 'growth'] },
  { ticker: 'ZS',    sector: 'tech', cap: 'mid',   priceTier: 'under500', tags: ['cybersec'] },
  { ticker: 'MDB',   sector: 'tech', cap: 'mid',   priceTier: 'under500', tags: ['cloud', 'data'] },
  { ticker: 'NOW',   sector: 'tech', cap: 'large', priceTier: 'over500',  tags: ['cloud', 'enterprise'] },
  { ticker: 'TEAM',  sector: 'tech', cap: 'mid',   priceTier: 'under500', tags: ['cloud', 'enterprise'] },
  { ticker: 'DDOG',  sector: 'tech', cap: 'mid',   priceTier: 'under500', tags: ['cloud'] },
  { ticker: 'PANW',  sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['cybersec'] },
  { ticker: 'WDAY',  sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['enterprise'] },
  { ticker: 'DELL',  sector: 'tech', cap: 'mid',   priceTier: 'under500', tags: ['ai', 'hardware'] },
  { ticker: 'HPQ',   sector: 'tech', cap: 'mid',   priceTier: 'under50',  tags: ['hardware', 'dividend'] },
  { ticker: 'CSCO',  sector: 'tech', cap: 'large', priceTier: 'under100', tags: ['networking', 'dividend'] },
  { ticker: 'IBM',   sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['ai', 'dividend'] },
  { ticker: 'TXN',   sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['semis', 'dividend'] },
  { ticker: 'ADI',   sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['semis', 'dividend'] },
  { ticker: 'LRCX',  sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['semis'] },
  { ticker: 'KLAC',  sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['semis'] },
  { ticker: 'ASML',  sector: 'tech', cap: 'mega',  priceTier: 'under500', tags: ['semis'] },
  { ticker: 'TSM',   sector: 'tech', cap: 'mega',  priceTier: 'under500', tags: ['semis', 'foundry'] },
  { ticker: 'SNAP',  sector: 'communications', cap: 'mid',   priceTier: 'under50',  tags: ['social', 'ad-tech'] },
  { ticker: 'PINS',  sector: 'communications', cap: 'mid',   priceTier: 'under50',  tags: ['social', 'ad-tech'] },
  { ticker: 'UBER',  sector: 'tech', cap: 'large', priceTier: 'under100', tags: ['gig-econ', 'growth'] },
  { ticker: 'LYFT',  sector: 'tech', cap: 'mid',   priceTier: 'under50',  tags: ['gig-econ'] },
  { ticker: 'ABNB',  sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['travel', 'growth'] },
  { ticker: 'DASH',  sector: 'tech', cap: 'large', priceTier: 'under500', tags: ['gig-econ'] },
  { ticker: 'ROKU',  sector: 'tech', cap: 'mid',   priceTier: 'under100', tags: ['streaming'] },

  // ── HEALTHCARE ──────────────────────────────────────────────
  { ticker: 'LLY',   sector: 'healthcare', cap: 'mega',  priceTier: 'over500',  tags: ['pharma', 'growth', 'glp1'] },
  { ticker: 'UNH',   sector: 'healthcare', cap: 'mega',  priceTier: 'over500',  tags: ['insurance', 'defensive', 'dividend'] },
  { ticker: 'JNJ',   sector: 'healthcare', cap: 'mega',  priceTier: 'under500', tags: ['pharma', 'defensive', 'dividend'] },
  { ticker: 'ABBV',  sector: 'healthcare', cap: 'large', priceTier: 'under500', tags: ['pharma', 'dividend'] },
  { ticker: 'MRK',   sector: 'healthcare', cap: 'large', priceTier: 'under500', tags: ['pharma', 'dividend'] },
  { ticker: 'PFE',   sector: 'healthcare', cap: 'large', priceTier: 'under50',  tags: ['pharma', 'dividend'] },
  { ticker: 'TMO',   sector: 'healthcare', cap: 'large', priceTier: 'over500',  tags: ['medical-tech'] },
  { ticker: 'ABT',   sector: 'healthcare', cap: 'large', priceTier: 'under500', tags: ['medical-tech', 'dividend'] },
  { ticker: 'MRNA',  sector: 'healthcare', cap: 'mid',   priceTier: 'under100', tags: ['biotech', 'volatile'] },
  { ticker: 'GILD',  sector: 'healthcare', cap: 'large', priceTier: 'under100', tags: ['biotech', 'dividend'] },
  { ticker: 'AMGN',  sector: 'healthcare', cap: 'large', priceTier: 'under500', tags: ['biotech', 'dividend'] },
  { ticker: 'BMY',   sector: 'healthcare', cap: 'large', priceTier: 'under100', tags: ['pharma', 'dividend'] },
  { ticker: 'CVS',   sector: 'healthcare', cap: 'large', priceTier: 'under100', tags: ['pharmacy', 'dividend'] },
  { ticker: 'WBA',   sector: 'healthcare', cap: 'mid',   priceTier: 'sub10',    tags: ['pharmacy', 'dividend', 'turnaround'] },
  { ticker: 'ISRG',  sector: 'healthcare', cap: 'large', priceTier: 'over500',  tags: ['medical-tech', 'robotics'] },
  { ticker: 'DHR',   sector: 'healthcare', cap: 'large', priceTier: 'under500', tags: ['medical-tech'] },
  { ticker: 'REGN',  sector: 'healthcare', cap: 'large', priceTier: 'over500',  tags: ['biotech'] },
  { ticker: 'VRTX',  sector: 'healthcare', cap: 'large', priceTier: 'under500', tags: ['biotech'] },

  // ── FINANCIALS ──────────────────────────────────────────────
  { ticker: 'JPM',   sector: 'financials', cap: 'mega',  priceTier: 'under500', tags: ['bank', 'dividend'] },
  { ticker: 'BAC',   sector: 'financials', cap: 'large', priceTier: 'under100', tags: ['bank', 'dividend'] },
  { ticker: 'WFC',   sector: 'financials', cap: 'large', priceTier: 'under100', tags: ['bank', 'dividend'] },
  { ticker: 'GS',    sector: 'financials', cap: 'large', priceTier: 'under500', tags: ['ibank', 'dividend'] },
  { ticker: 'MS',    sector: 'financials', cap: 'large', priceTier: 'under500', tags: ['ibank', 'dividend'] },
  { ticker: 'C',     sector: 'financials', cap: 'large', priceTier: 'under100', tags: ['bank', 'dividend'] },
  { ticker: 'V',     sector: 'financials', cap: 'mega',  priceTier: 'under500', tags: ['payments', 'dividend'] },
  { ticker: 'MA',    sector: 'financials', cap: 'mega',  priceTier: 'under500', tags: ['payments', 'dividend'] },
  { ticker: 'SCHW',  sector: 'financials', cap: 'large', priceTier: 'under100', tags: ['broker', 'dividend'] },
  { ticker: 'AXP',   sector: 'financials', cap: 'large', priceTier: 'under500', tags: ['payments', 'dividend'] },
  { ticker: 'BX',    sector: 'financials', cap: 'large', priceTier: 'under500', tags: ['pe', 'dividend'] },
  { ticker: 'KKR',   sector: 'financials', cap: 'large', priceTier: 'under500', tags: ['pe'] },
  { ticker: 'BLK',   sector: 'financials', cap: 'large', priceTier: 'over500',  tags: ['asset-mgmt', 'dividend'] },
  { ticker: 'BRK-B', sector: 'financials', cap: 'mega',  priceTier: 'under500', tags: ['conglomerate', 'defensive'] },
  { ticker: 'SOFI',  sector: 'financials', cap: 'mid',   priceTier: 'under50',  tags: ['fintech', 'growth'] },
  { ticker: 'HOOD',  sector: 'financials', cap: 'mid',   priceTier: 'under100', tags: ['fintech', 'broker'] },
  { ticker: 'COF',   sector: 'financials', cap: 'large', priceTier: 'under500', tags: ['bank', 'dividend'] },
  { ticker: 'USB',   sector: 'financials', cap: 'large', priceTier: 'under50',  tags: ['bank', 'dividend'] },
  { ticker: 'PNC',   sector: 'financials', cap: 'large', priceTier: 'under500', tags: ['bank', 'dividend'] },

  // ── ENERGY ──────────────────────────────────────────────────
  { ticker: 'XOM',   sector: 'energy', cap: 'mega',  priceTier: 'under500', tags: ['oil', 'dividend'] },
  { ticker: 'CVX',   sector: 'energy', cap: 'large', priceTier: 'under500', tags: ['oil', 'dividend'] },
  { ticker: 'COP',   sector: 'energy', cap: 'large', priceTier: 'under500', tags: ['oil', 'dividend'] },
  { ticker: 'OXY',   sector: 'energy', cap: 'large', priceTier: 'under100', tags: ['oil', 'buffett'] },
  { ticker: 'SLB',   sector: 'energy', cap: 'large', priceTier: 'under100', tags: ['oil-services', 'dividend'] },
  { ticker: 'MPC',   sector: 'energy', cap: 'large', priceTier: 'under500', tags: ['refining', 'dividend'] },
  { ticker: 'VLO',   sector: 'energy', cap: 'large', priceTier: 'under500', tags: ['refining', 'dividend'] },
  { ticker: 'PSX',   sector: 'energy', cap: 'large', priceTier: 'under500', tags: ['refining', 'dividend'] },
  { ticker: 'HAL',   sector: 'energy', cap: 'mid',   priceTier: 'under50',  tags: ['oil-services'] },
  { ticker: 'EOG',   sector: 'energy', cap: 'large', priceTier: 'under500', tags: ['oil', 'dividend'] },
  { ticker: 'PXD',   sector: 'energy', cap: 'large', priceTier: 'under500', tags: ['oil', 'dividend'] },
  { ticker: 'KMI',   sector: 'energy', cap: 'large', priceTier: 'under50',  tags: ['pipeline', 'dividend'] },

  // ── CONSUMER DISCRETIONARY ──────────────────────────────────
  { ticker: 'HD',    sector: 'consumer_disc', cap: 'large', priceTier: 'under500', tags: ['retail', 'dividend'] },
  { ticker: 'MCD',   sector: 'consumer_disc', cap: 'large', priceTier: 'under500', tags: ['restaurant', 'defensive', 'dividend'] },
  { ticker: 'NKE',   sector: 'consumer_disc', cap: 'large', priceTier: 'under100', tags: ['apparel', 'dividend'] },
  { ticker: 'SBUX',  sector: 'consumer_disc', cap: 'large', priceTier: 'under100', tags: ['restaurant', 'dividend'] },
  { ticker: 'DIS',   sector: 'communications', cap: 'large', priceTier: 'under500', tags: ['media', 'entertainment'] },
  { ticker: 'BKNG',  sector: 'consumer_disc', cap: 'large', priceTier: 'over500',  tags: ['travel'] },
  { ticker: 'LULU',  sector: 'consumer_disc', cap: 'mid',   priceTier: 'under500', tags: ['apparel', 'growth'] },
  { ticker: 'F',     sector: 'consumer_disc', cap: 'mid',   priceTier: 'under50',  tags: ['auto', 'dividend', 'ev'] },
  { ticker: 'GM',    sector: 'consumer_disc', cap: 'mid',   priceTier: 'under100', tags: ['auto', 'ev'] },
  { ticker: 'RIVN',  sector: 'consumer_disc', cap: 'mid',   priceTier: 'under50',  tags: ['ev', 'volatile'] },
  { ticker: 'NIO',   sector: 'consumer_disc', cap: 'mid',   priceTier: 'under50',  tags: ['ev', 'china', 'volatile'] },
  { ticker: 'LCID',  sector: 'consumer_disc', cap: 'mid',   priceTier: 'sub10',    tags: ['ev', 'volatile'] },
  { ticker: 'TGT',   sector: 'consumer_disc', cap: 'large', priceTier: 'under500', tags: ['retail', 'dividend'] },
  { ticker: 'LOW',   sector: 'consumer_disc', cap: 'large', priceTier: 'under500', tags: ['retail', 'dividend'] },
  { ticker: 'TJX',   sector: 'consumer_disc', cap: 'large', priceTier: 'under500', tags: ['retail', 'dividend'] },
  { ticker: 'ROST',  sector: 'consumer_disc', cap: 'large', priceTier: 'under500', tags: ['retail', 'dividend'] },
  { ticker: 'CMG',   sector: 'consumer_disc', cap: 'large', priceTier: 'under500', tags: ['restaurant', 'growth'] },
  { ticker: 'MAR',   sector: 'consumer_disc', cap: 'large', priceTier: 'under500', tags: ['travel'] },
  { ticker: 'HLT',   sector: 'consumer_disc', cap: 'large', priceTier: 'under500', tags: ['travel'] },
  { ticker: 'YUM',   sector: 'consumer_disc', cap: 'large', priceTier: 'under500', tags: ['restaurant', 'dividend'] },
  { ticker: 'EBAY',  sector: 'consumer_disc', cap: 'mid',   priceTier: 'under100', tags: ['ecommerce', 'dividend'] },
  { ticker: 'ETSY',  sector: 'consumer_disc', cap: 'mid',   priceTier: 'under100', tags: ['ecommerce'] },

  // ── CONSUMER STAPLES ────────────────────────────────────────
  { ticker: 'WMT',   sector: 'consumer_staples', cap: 'mega',  priceTier: 'under500', tags: ['retail', 'defensive', 'dividend'] },
  { ticker: 'PG',    sector: 'consumer_staples', cap: 'mega',  priceTier: 'under500', tags: ['defensive', 'dividend'] },
  { ticker: 'KO',    sector: 'consumer_staples', cap: 'large', priceTier: 'under100', tags: ['defensive', 'dividend', 'buffett'] },
  { ticker: 'PEP',   sector: 'consumer_staples', cap: 'large', priceTier: 'under500', tags: ['defensive', 'dividend'] },
  { ticker: 'COST',  sector: 'consumer_staples', cap: 'large', priceTier: 'over500',  tags: ['retail', 'defensive'] },
  { ticker: 'CL',    sector: 'consumer_staples', cap: 'large', priceTier: 'under100', tags: ['defensive', 'dividend'] },
  { ticker: 'MDLZ',  sector: 'consumer_staples', cap: 'large', priceTier: 'under100', tags: ['defensive', 'dividend'] },
  { ticker: 'PM',    sector: 'consumer_staples', cap: 'large', priceTier: 'under500', tags: ['tobacco', 'dividend'] },
  { ticker: 'MO',    sector: 'consumer_staples', cap: 'large', priceTier: 'under100', tags: ['tobacco', 'dividend'] },
  { ticker: 'KHC',   sector: 'consumer_staples', cap: 'large', priceTier: 'under50',  tags: ['food', 'dividend'] },
  { ticker: 'GIS',   sector: 'consumer_staples', cap: 'large', priceTier: 'under100', tags: ['food', 'dividend'] },

  // ── INDUSTRIALS ─────────────────────────────────────────────
  { ticker: 'BA',    sector: 'industrials', cap: 'large', priceTier: 'under500', tags: ['aerospace', 'turnaround'] },
  { ticker: 'CAT',   sector: 'industrials', cap: 'large', priceTier: 'under500', tags: ['heavy', 'dividend'] },
  { ticker: 'GE',    sector: 'industrials', cap: 'large', priceTier: 'under500', tags: ['aerospace', 'dividend'] },
  { ticker: 'UPS',   sector: 'industrials', cap: 'large', priceTier: 'under500', tags: ['logistics', 'dividend'] },
  { ticker: 'RTX',   sector: 'industrials', cap: 'large', priceTier: 'under500', tags: ['defense', 'dividend'] },
  { ticker: 'LMT',   sector: 'industrials', cap: 'large', priceTier: 'over500',  tags: ['defense', 'dividend'] },
  { ticker: 'DE',    sector: 'industrials', cap: 'large', priceTier: 'under500', tags: ['heavy', 'dividend'] },
  { ticker: 'MMM',   sector: 'industrials', cap: 'large', priceTier: 'under500', tags: ['conglomerate', 'dividend'] },
  { ticker: 'HON',   sector: 'industrials', cap: 'large', priceTier: 'under500', tags: ['conglomerate', 'dividend'] },
  { ticker: 'UNP',   sector: 'industrials', cap: 'large', priceTier: 'under500', tags: ['rail', 'dividend'] },
  { ticker: 'CSX',   sector: 'industrials', cap: 'large', priceTier: 'under100', tags: ['rail', 'dividend'] },
  { ticker: 'NSC',   sector: 'industrials', cap: 'large', priceTier: 'under500', tags: ['rail', 'dividend'] },
  { ticker: 'FDX',   sector: 'industrials', cap: 'large', priceTier: 'under500', tags: ['logistics', 'dividend'] },
  { ticker: 'NOC',   sector: 'industrials', cap: 'large', priceTier: 'over500',  tags: ['defense', 'dividend'] },
  { ticker: 'GD',    sector: 'industrials', cap: 'large', priceTier: 'under500', tags: ['defense', 'dividend'] },

  // ── COMMUNICATIONS ──────────────────────────────────────────
  { ticker: 'NFLX',  sector: 'communications', cap: 'large', priceTier: 'over500',  tags: ['streaming', 'growth'] },
  { ticker: 'T',     sector: 'communications', cap: 'large', priceTier: 'under50',  tags: ['telco', 'dividend'] },
  { ticker: 'VZ',    sector: 'communications', cap: 'large', priceTier: 'under100', tags: ['telco', 'dividend'] },
  { ticker: 'TMUS',  sector: 'communications', cap: 'large', priceTier: 'under500', tags: ['telco'] },
  { ticker: 'CMCSA', sector: 'communications', cap: 'large', priceTier: 'under100', tags: ['media', 'dividend'] },

  // ── MATERIALS ───────────────────────────────────────────────
  { ticker: 'LIN',   sector: 'materials', cap: 'large', priceTier: 'over500',  tags: ['industrial-gas', 'dividend'] },
  { ticker: 'FCX',   sector: 'materials', cap: 'mid',   priceTier: 'under100', tags: ['mining', 'copper'] },
  { ticker: 'NEM',   sector: 'materials', cap: 'mid',   priceTier: 'under100', tags: ['mining', 'gold'] },
  { ticker: 'SCCO',  sector: 'materials', cap: 'mid',   priceTier: 'under500', tags: ['mining', 'copper', 'dividend'] },
  { ticker: 'DOW',   sector: 'materials', cap: 'mid',   priceTier: 'under100', tags: ['chemicals', 'dividend'] },
  { ticker: 'DD',    sector: 'materials', cap: 'mid',   priceTier: 'under100', tags: ['chemicals'] },

  // ── REAL ESTATE ─────────────────────────────────────────────
  { ticker: 'AMT',   sector: 'real_estate', cap: 'large', priceTier: 'under500', tags: ['reit', 'towers', 'dividend'] },
  { ticker: 'PLD',   sector: 'real_estate', cap: 'large', priceTier: 'under500', tags: ['reit', 'logistics', 'dividend'] },
  { ticker: 'O',     sector: 'real_estate', cap: 'large', priceTier: 'under100', tags: ['reit', 'dividend', 'monthly'] },
  { ticker: 'SPG',   sector: 'real_estate', cap: 'large', priceTier: 'under500', tags: ['reit', 'mall', 'dividend'] },
  { ticker: 'EQIX',  sector: 'real_estate', cap: 'large', priceTier: 'over500',  tags: ['reit', 'data-center', 'dividend'] },

  // ── UTILITIES ───────────────────────────────────────────────
  { ticker: 'NEE',   sector: 'utilities', cap: 'large', priceTier: 'under100', tags: ['utility', 'renewable', 'dividend'] },
  { ticker: 'DUK',   sector: 'utilities', cap: 'large', priceTier: 'under500', tags: ['utility', 'dividend'] },
  { ticker: 'SO',    sector: 'utilities', cap: 'large', priceTier: 'under100', tags: ['utility', 'dividend'] },
  { ticker: 'D',     sector: 'utilities', cap: 'large', priceTier: 'under100', tags: ['utility', 'dividend'] },

  // ── CRYPTO-ADJACENT ─────────────────────────────────────────
  { ticker: 'COIN',  sector: 'crypto_adj', cap: 'large', priceTier: 'under500', tags: ['crypto', 'volatile'] },
  { ticker: 'MARA',  sector: 'crypto_adj', cap: 'mid',   priceTier: 'under50',  tags: ['crypto', 'miner', 'volatile'] },
  { ticker: 'RIOT',  sector: 'crypto_adj', cap: 'mid',   priceTier: 'under50',  tags: ['crypto', 'miner', 'volatile'] },
  { ticker: 'MSTR',  sector: 'crypto_adj', cap: 'large', priceTier: 'over500',  tags: ['crypto', 'volatile'] },
  { ticker: 'CLSK',  sector: 'crypto_adj', cap: 'mid',   priceTier: 'under50',  tags: ['crypto', 'miner'] },
  { ticker: 'HUT',   sector: 'crypto_adj', cap: 'mid',   priceTier: 'under50',  tags: ['crypto', 'miner'] },

  // ── MAJOR ETFs (broad market) ───────────────────────────────
  { ticker: 'SPY',   sector: 'macro_etf', cap: 'etf', priceTier: 'under500', tags: ['broad-market', 'sp500'] },
  { ticker: 'QQQ',   sector: 'macro_etf', cap: 'etf', priceTier: 'under500', tags: ['broad-market', 'tech'] },
  { ticker: 'IWM',   sector: 'macro_etf', cap: 'etf', priceTier: 'under500', tags: ['broad-market', 'small-cap'] },
  { ticker: 'DIA',   sector: 'macro_etf', cap: 'etf', priceTier: 'under500', tags: ['broad-market', 'dow'] },
  { ticker: 'VTI',   sector: 'macro_etf', cap: 'etf', priceTier: 'under500', tags: ['broad-market', 'total'] },
  { ticker: 'VOO',   sector: 'macro_etf', cap: 'etf', priceTier: 'under500', tags: ['broad-market', 'sp500'] },

  // ── SECTOR ETFs ─────────────────────────────────────────────
  { ticker: 'XLE',   sector: 'sector_etf', cap: 'etf', priceTier: 'under100', tags: ['sector', 'energy'] },
  { ticker: 'XLF',   sector: 'sector_etf', cap: 'etf', priceTier: 'under100', tags: ['sector', 'financials'] },
  { ticker: 'XLK',   sector: 'sector_etf', cap: 'etf', priceTier: 'under500', tags: ['sector', 'tech'] },
  { ticker: 'XLV',   sector: 'sector_etf', cap: 'etf', priceTier: 'under500', tags: ['sector', 'healthcare'] },
  { ticker: 'XLI',   sector: 'sector_etf', cap: 'etf', priceTier: 'under500', tags: ['sector', 'industrials'] },
  { ticker: 'XLY',   sector: 'sector_etf', cap: 'etf', priceTier: 'under500', tags: ['sector', 'consumer-disc'] },
  { ticker: 'XLP',   sector: 'sector_etf', cap: 'etf', priceTier: 'under100', tags: ['sector', 'consumer-staples', 'defensive'] },
  { ticker: 'XLU',   sector: 'sector_etf', cap: 'etf', priceTier: 'under100', tags: ['sector', 'utilities', 'defensive'] },
  { ticker: 'XLRE',  sector: 'sector_etf', cap: 'etf', priceTier: 'under100', tags: ['sector', 'reit'] },
  { ticker: 'XLB',   sector: 'sector_etf', cap: 'etf', priceTier: 'under100', tags: ['sector', 'materials'] },
  { ticker: 'XLC',   sector: 'sector_etf', cap: 'etf', priceTier: 'under100', tags: ['sector', 'communications'] },
  { ticker: 'SMH',   sector: 'sector_etf', cap: 'etf', priceTier: 'under500', tags: ['sector', 'semis'] },
  { ticker: 'SOXX',  sector: 'sector_etf', cap: 'etf', priceTier: 'under500', tags: ['sector', 'semis'] },
  { ticker: 'IBB',   sector: 'sector_etf', cap: 'etf', priceTier: 'under500', tags: ['sector', 'biotech'] },
  { ticker: 'KRE',   sector: 'sector_etf', cap: 'etf', priceTier: 'under100', tags: ['sector', 'regional-banks'] },
  { ticker: 'KBE',   sector: 'sector_etf', cap: 'etf', priceTier: 'under100', tags: ['sector', 'banks'] },
  { ticker: 'ITB',   sector: 'sector_etf', cap: 'etf', priceTier: 'under500', tags: ['sector', 'homebuilders'] },
  { ticker: 'XOP',   sector: 'sector_etf', cap: 'etf', priceTier: 'under500', tags: ['sector', 'oil-explore'] },
  { ticker: 'OIH',   sector: 'sector_etf', cap: 'etf', priceTier: 'under500', tags: ['sector', 'oil-services'] },
  { ticker: 'JETS',  sector: 'sector_etf', cap: 'etf', priceTier: 'under50',  tags: ['sector', 'airlines'] },

  // ── MACRO / COMMODITY / BOND ETFs ───────────────────────────
  { ticker: 'TLT',   sector: 'macro_etf', cap: 'etf', priceTier: 'under100', tags: ['bonds', 'long-term', 'defensive'] },
  { ticker: 'IEF',   sector: 'macro_etf', cap: 'etf', priceTier: 'under100', tags: ['bonds', 'medium-term'] },
  { ticker: 'HYG',   sector: 'macro_etf', cap: 'etf', priceTier: 'under100', tags: ['bonds', 'high-yield'] },
  { ticker: 'LQD',   sector: 'macro_etf', cap: 'etf', priceTier: 'under500', tags: ['bonds', 'investment-grade'] },
  { ticker: 'GLD',   sector: 'macro_etf', cap: 'etf', priceTier: 'under500', tags: ['gold', 'defensive'] },
  { ticker: 'SLV',   sector: 'macro_etf', cap: 'etf', priceTier: 'under50',  tags: ['silver', 'metals'] },
  { ticker: 'USO',   sector: 'macro_etf', cap: 'etf', priceTier: 'under100', tags: ['oil', 'commodity'] },
  { ticker: 'UNG',   sector: 'macro_etf', cap: 'etf', priceTier: 'under50',  tags: ['nat-gas', 'commodity'] },
  { ticker: 'DBC',   sector: 'macro_etf', cap: 'etf', priceTier: 'under50',  tags: ['commodities', 'broad'] },
  { ticker: 'UUP',   sector: 'macro_etf', cap: 'etf', priceTier: 'under50',  tags: ['dollar', 'defensive'] },
  { ticker: 'VXX',   sector: 'macro_etf', cap: 'etf', priceTier: 'under100', tags: ['volatility', 'hedge'] },
  { ticker: 'UVXY',  sector: 'macro_etf', cap: 'etf', priceTier: 'under100', tags: ['volatility', 'leveraged', 'hedge'] },
  { ticker: 'EFA',   sector: 'macro_etf', cap: 'etf', priceTier: 'under100', tags: ['international', 'developed'] },
  { ticker: 'EEM',   sector: 'macro_etf', cap: 'etf', priceTier: 'under100', tags: ['international', 'emerging'] },
  { ticker: 'FXI',   sector: 'macro_etf', cap: 'etf', priceTier: 'under50',  tags: ['international', 'china'] },
  { ticker: 'EWJ',   sector: 'macro_etf', cap: 'etf', priceTier: 'under100', tags: ['international', 'japan'] },

  // ── THEMATIC ETFs ───────────────────────────────────────────
  { ticker: 'ARKK',  sector: 'thematic_etf', cap: 'etf', priceTier: 'under100', tags: ['innovation', 'growth', 'volatile'] },
  { ticker: 'ARKG',  sector: 'thematic_etf', cap: 'etf', priceTier: 'under50',  tags: ['genomics', 'growth'] },
  { ticker: 'ARKW',  sector: 'thematic_etf', cap: 'etf', priceTier: 'under100', tags: ['internet', 'growth'] },
  { ticker: 'ARKF',  sector: 'thematic_etf', cap: 'etf', priceTier: 'under50',  tags: ['fintech'] },
  { ticker: 'ICLN',  sector: 'thematic_etf', cap: 'etf', priceTier: 'under50',  tags: ['clean-energy'] },
  { ticker: 'TAN',   sector: 'thematic_etf', cap: 'etf', priceTier: 'under50',  tags: ['solar'] },
  { ticker: 'URA',   sector: 'thematic_etf', cap: 'etf', priceTier: 'under50',  tags: ['uranium'] },
  { ticker: 'BOTZ',  sector: 'thematic_etf', cap: 'etf', priceTier: 'under50',  tags: ['robotics', 'ai'] },
  { ticker: 'AIQ',   sector: 'thematic_etf', cap: 'etf', priceTier: 'under100', tags: ['ai'] },

  // ── HIGH MOMENTUM / VOLATILE ───────────────────────────────
  { ticker: 'GME',   sector: 'consumer_disc', cap: 'mid',   priceTier: 'under50',  tags: ['meme', 'volatile'] },
  { ticker: 'AMC',   sector: 'communications', cap: 'small', priceTier: 'sub10',   tags: ['meme', 'volatile'] },
  { ticker: 'BBBY',  sector: 'consumer_disc', cap: 'small', priceTier: 'sub10',    tags: ['meme', 'volatile'] },
  { ticker: 'SOUN',  sector: 'tech', cap: 'small', priceTier: 'under50',  tags: ['ai', 'growth', 'volatile'] },
  { ticker: 'BBAI',  sector: 'tech', cap: 'small', priceTier: 'under50',  tags: ['ai', 'volatile'] },
  { ticker: 'AI',    sector: 'tech', cap: 'mid',   priceTier: 'under100', tags: ['ai', 'volatile'] },
  { ticker: 'UPST',  sector: 'financials', cap: 'mid',   priceTier: 'under100', tags: ['fintech', 'volatile'] },
  { ticker: 'AFRM',  sector: 'financials', cap: 'mid',   priceTier: 'under100', tags: ['fintech', 'growth'] },
]

// ═════════════════════════════════════════════════════════════
// Pre-defined universes (shortcuts for common scans)
// ═════════════════════════════════════════════════════════════

export interface PredefinedUniverse {
  id: string
  label: string
  description: string
  filter: (e: UniverseEntry) => boolean
}

export const PREDEFINED_UNIVERSES: PredefinedUniverse[] = [
  { id: 'all', label: 'All Liquid',
    description: 'Everything in the scanner universe',
    filter: () => true },

  { id: 'megacap', label: 'Mega Cap',
    description: 'Largest companies only (mega cap)',
    filter: (e) => e.cap === 'mega' },

  { id: 'largecap', label: 'Large Cap',
    description: 'Mega + large cap stocks',
    filter: (e) => e.cap === 'mega' || e.cap === 'large' },

  { id: 'midcap_small', label: 'Mid & Small Cap',
    description: 'Mid + small cap — more volatility, more opportunity',
    filter: (e) => e.cap === 'mid' || e.cap === 'small' },

  { id: 'tech', label: 'Tech',
    description: 'Tech sector only',
    filter: (e) => e.sector === 'tech' },

  { id: 'healthcare', label: 'Healthcare',
    description: 'Healthcare + biotech',
    filter: (e) => e.sector === 'healthcare' },

  { id: 'financials', label: 'Financials',
    description: 'Banks, payments, asset managers',
    filter: (e) => e.sector === 'financials' },

  { id: 'energy', label: 'Energy',
    description: 'Oil, gas, pipelines',
    filter: (e) => e.sector === 'energy' },

  { id: 'consumer', label: 'Consumer',
    description: 'Discretionary + staples',
    filter: (e) => e.sector === 'consumer_disc' || e.sector === 'consumer_staples' },

  { id: 'ai', label: 'AI Theme',
    description: 'Stocks tagged AI',
    filter: (e) => e.tags.includes('ai') },

  { id: 'growth', label: 'Growth',
    description: 'High-growth names',
    filter: (e) => e.tags.includes('growth') },

  { id: 'dividend', label: 'Dividend',
    description: 'Dividend-paying stocks',
    filter: (e) => e.tags.includes('dividend') },

  { id: 'defensive', label: 'Defensive',
    description: 'Lower-beta defensive names',
    filter: (e) => e.tags.includes('defensive') },

  { id: 'etfs', label: 'ETFs only',
    description: 'All ETFs (sector, thematic, macro)',
    filter: (e) => e.cap === 'etf' },

  { id: 'sector_etfs', label: 'Sector ETFs',
    description: 'XLK, XLF, XLE, etc.',
    filter: (e) => e.sector === 'sector_etf' },

  { id: 'semis', label: 'Semiconductors',
    description: 'Semi stocks + ETFs',
    filter: (e) => e.tags.includes('semis') },

  { id: 'crypto', label: 'Crypto-adjacent',
    description: 'COIN, MSTR, miners',
    filter: (e) => e.sector === 'crypto_adj' || e.tags.includes('crypto') },

  { id: 'under50', label: 'Under $50',
    description: 'Lower-priced names (sub $50)',
    filter: (e) => e.priceTier === 'sub10' || e.priceTier === 'under50' },

  { id: 'meme', label: 'Meme / Volatile',
    description: 'High-volatility retail favorites',
    filter: (e) => e.tags.includes('meme') || e.tags.includes('volatile') },
]

// ═════════════════════════════════════════════════════════════
// Filter interface — composable custom filters
// ═════════════════════════════════════════════════════════════

export interface ScannerFilter {
  sectors?: Sector[]            // restrict to these sectors
  caps?: CapTier[]              // restrict to these cap tiers
  priceTiers?: PriceTier[]      // restrict to these price tiers
  tagsIncludeAny?: string[]     // has at least ONE of these tags
  tagsIncludeAll?: string[]     // has ALL of these tags
  tagsExcludeAny?: string[]     // has NONE of these tags
  tickers?: string[]            // explicit ticker list override
  predefined?: string           // id from PREDEFINED_UNIVERSES
}

export function applyFilter(filter: ScannerFilter): UniverseEntry[] {
  // Explicit ticker list wins
  if (filter.tickers && filter.tickers.length > 0) {
    const set = new Set(filter.tickers.map(t => t.toUpperCase()))
    return SCANNER_UNIVERSE.filter(e => set.has(e.ticker))
  }

  // Predefined universe
  let filtered = SCANNER_UNIVERSE
  if (filter.predefined) {
    const preset = PREDEFINED_UNIVERSES.find(p => p.id === filter.predefined)
    if (preset) {
      filtered = filtered.filter(preset.filter)
    }
  }

  // Sector filter
  if (filter.sectors && filter.sectors.length > 0) {
    const set = new Set(filter.sectors)
    filtered = filtered.filter(e => set.has(e.sector))
  }

  // Cap tier filter
  if (filter.caps && filter.caps.length > 0) {
    const set = new Set(filter.caps)
    filtered = filtered.filter(e => set.has(e.cap))
  }

  // Price tier filter
  if (filter.priceTiers && filter.priceTiers.length > 0) {
    const set = new Set(filter.priceTiers)
    filtered = filtered.filter(e => set.has(e.priceTier))
  }

  // Tag filters
  if (filter.tagsIncludeAny && filter.tagsIncludeAny.length > 0) {
    const anyTags = filter.tagsIncludeAny
    filtered = filtered.filter(e => e.tags.some(t => anyTags.includes(t)))
  }
  if (filter.tagsIncludeAll && filter.tagsIncludeAll.length > 0) {
    const allTags = filter.tagsIncludeAll
    filtered = filtered.filter(e => allTags.every(t => e.tags.includes(t)))
  }
  if (filter.tagsExcludeAny && filter.tagsExcludeAny.length > 0) {
    const excludeTags = filter.tagsExcludeAny
    filtered = filtered.filter(e => !e.tags.some(t => excludeTags.includes(t)))
  }

  return filtered
}

// ═════════════════════════════════════════════════════════════
// Convenience exports
// ═════════════════════════════════════════════════════════════

export function getAllUniverseTickers(): string[] {
  return SCANNER_UNIVERSE.map(e => e.ticker)
}

export function getUniverseEntry(ticker: string): UniverseEntry | null {
  const t = ticker.toUpperCase()
  return SCANNER_UNIVERSE.find(e => e.ticker === t) ?? null
}

export function getPredefinedUniverse(id: string): UniverseEntry[] {
  const preset = PREDEFINED_UNIVERSES.find(p => p.id === id)
  if (!preset) return []
  return SCANNER_UNIVERSE.filter(preset.filter)
}
