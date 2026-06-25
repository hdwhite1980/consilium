// =============================================================
// app/lib/trading/coinbase-futures-products.ts
//
// Discovery + resolution for Coinbase Financial Markets (CFM) futures.
//
// Design: DISCOVER, don't hardcode. Coinbase self-certifies and lists new
// futures contracts constantly, so the tradable universe is pulled live from
// listProducts('FUTURE'). We parse each product defensively (Coinbase nests
// the futures-specific fields under future_product_details and the field set
// has shifted over time), and only fall back to a small static overlay for
// contract sizes we're confident about when the live feed omits one.
//
// resolveFuturesContract() maps a Council/verdict root (e.g. "BTC", "ETH",
// "GC", "CL") to a concrete tradable contract, preferring PERPETUAL contracts
// (no expiry / no roll) and otherwise the nearest non-expired front month.
// =============================================================

import type { CoinbaseClient } from './coinbase-client'

export interface FuturesContract {
  productId: string            // e.g. "BIT-28JUL25-CDE" or a perp product_id
  rootUnit: string             // underlying unit, e.g. "BTC", "ETH", "XRP"
  displayName: string
  price: number
  contractSize: number         // base units per contract (0.01 BTC, 5 SOL, ...)
  tickSize: number | null
  perpetual: boolean
  expiryMs: number | null      // ms epoch of expiry (null for perpetual)
  initialMarginPerContract: number | null
  tradable: boolean
  notTradableReason?: string
}

// Static contract-size overlay — ONLY used when the live product omits
// contract_size. Values sourced from Coinbase Derivatives contract specs.
const CONTRACT_SIZE_OVERLAY: Record<string, number> = {
  BTC: 0.01,   // nano Bitcoin
  ETH: 0.1,    // nano Ether
  SOL: 5,      // nano Solana
  XRP: 500,    // nano XRP
  DOT: 100,    // Polkadot
  ADA: 0,      // unknown → leave 0 so caller rejects rather than mis-sizes
  HBAR: 0,
  DOGE: 0,
  LINK: 0,
  XLM: 0,
}

// Bridge common Council/CME-style roots to the underlying unit Coinbase uses.
// Matching is also attempted directly and via display-name contains, so this
// only needs to cover non-obvious aliases.
const ROOT_ALIASES: Record<string, string[]> = {
  BTC: ['BTC', 'BIT', 'BITCOIN'],
  ETH: ['ETH', 'ET', 'ETHER', 'ETHEREUM'],
  SOL: ['SOL', 'SOLANA'],
  XRP: ['XRP', 'RIPPLE'],
  GC: ['GOLD', 'GLD', 'XAU'],
  GOLD: ['GOLD', 'GLD', 'XAU'],
  SI: ['SILVER', 'SLV', 'XAG'],
  SILVER: ['SILVER', 'SLV', 'XAG'],
  CL: ['CRUDE', 'OIL', 'WTI', 'NOL'],
  NG: ['NATGAS', 'NATURAL', 'NGS', 'GAS'],
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return undefined
}

/**
 * Parse one raw Coinbase FUTURE product into our normalized contract shape.
 * Returns null if it isn't a usable futures product.
 */
export function parseFuturesProduct(raw: Record<string, unknown>): FuturesContract | null {
  const productId = String(pick(raw, 'product_id') ?? '')
  if (!productId) return null

  const fpd = (raw.future_product_details ?? raw.fcm_trading_session_details ?? {}) as Record<string, unknown>
  const perpDetails = pick(fpd, 'perpetual_details', 'perpetual') as Record<string, unknown> | undefined

  const expiryType = String(pick(fpd, 'contract_expiry_type', 'expiry_type') ?? '').toUpperCase()
  const expiryRaw = pick(fpd, 'contract_expiry', 'expiry_date', 'contract_expiry_timestamp')
  const expiryMs = (() => {
    if (!expiryRaw) return null
    const asNum = Number(expiryRaw)
    if (Number.isFinite(asNum) && asNum > 0) return asNum < 1e12 ? asNum * 1000 : asNum
    const t = Date.parse(String(expiryRaw))
    return Number.isFinite(t) ? t : null
  })()
  const perpetual = expiryType.includes('PERPETUAL') || perpDetails !== undefined || expiryMs === null

  const rootUnit = String(
    pick(fpd, 'contract_root_unit', 'root_unit') ??
    pick(raw, 'base_currency_id', 'base_display_symbol') ??
    productId.split('-')[0],
  ).toUpperCase()

  const displayName = String(pick(fpd, 'contract_display_name', 'display_name') ?? pick(raw, 'display_name') ?? productId)

  let contractSize = num(pick(fpd, 'contract_size', 'base_increment')) ?? 0
  if (contractSize <= 0) {
    contractSize = CONTRACT_SIZE_OVERLAY[rootUnit] ?? 0
  }

  const price = num(pick(raw, 'price', 'mid_market_price')) ?? 0
  const tickSize = num(pick(fpd, 'min_price_increment', 'tick_size')) ?? num(pick(raw, 'quote_increment'))
  const initialMargin = num(pick(fpd, 'initial_margin', 'initial_margin_per_contract'))

  const tradingDisabled = pick(raw, 'trading_disabled') === true
  const cancelOnly = pick(raw, 'cancel_only') === true
  const limitOnly = pick(raw, 'limit_only') === true
  const status = String(pick(raw, 'status') ?? '').toLowerCase()
  let tradable = true
  let notTradableReason: string | undefined
  if (tradingDisabled) { tradable = false; notTradableReason = 'trading_disabled' }
  else if (cancelOnly) { tradable = false; notTradableReason = 'cancel_only' }
  else if (limitOnly) { tradable = false; notTradableReason = 'limit_only (we place market entries)' }
  else if (status && status !== 'online') { tradable = false; notTradableReason = `status ${status}` }
  if (contractSize <= 0) { tradable = false; notTradableReason = 'unknown contract_size' }
  if (price <= 0) { tradable = false; notTradableReason = notTradableReason ?? 'no price' }

  return {
    productId,
    rootUnit,
    displayName,
    price,
    contractSize,
    tickSize,
    perpetual,
    expiryMs,
    initialMarginPerContract: initialMargin,
    tradable,
    notTradableReason,
  }
}

/** Pull and parse the full live CFM futures universe. */
export async function listCoinbaseFuturesContracts(client: CoinbaseClient): Promise<FuturesContract[]> {
  const raw = await client.listProducts('FUTURE')
  const out: FuturesContract[] = []
  for (const p of raw) {
    const parsed = parseFuturesProduct(p)
    if (parsed) out.push(parsed)
  }
  return out
}

function rootCandidates(requested: string): string[] {
  const r = requested.toUpperCase().replace(/[\/\-]/g, '').replace(/USD[CT]?$/, '')
  const set = new Set<string>([r])
  for (const a of ROOT_ALIASES[r] ?? []) set.add(a)
  return Array.from(set)
}

/**
 * Resolve a Council root (e.g. "BTC", "ETH", "GC", "CL") to the best tradable
 * Coinbase futures contract. Prefers perpetual (no roll); else the nearest
 * non-expired front month. Returns null if nothing tradable matches.
 */
export async function resolveFuturesContract(
  client: CoinbaseClient,
  root: string,
  preloaded?: FuturesContract[],
): Promise<FuturesContract | null> {
  const all = preloaded ?? await listCoinbaseFuturesContracts(client)
  const cands = rootCandidates(root)
  const now = Date.now()

  const matches = all.filter(c => {
    if (!c.tradable) return false
    if (cands.includes(c.rootUnit.toUpperCase())) return true
    const dn = c.displayName.toUpperCase()
    return cands.some(cd => dn.includes(cd))
  })
  if (matches.length === 0) return null

  // Prefer perpetual; among dated, nearest non-expired expiry.
  const perps = matches.filter(m => m.perpetual)
  if (perps.length > 0) {
    // If multiple perps (rare), take the highest-priced/most-liquid proxy: first.
    return perps[0]
  }
  const dated = matches
    .filter(m => m.expiryMs === null || m.expiryMs > now)
    .sort((a, b) => (a.expiryMs ?? Infinity) - (b.expiryMs ?? Infinity))
  return dated[0] ?? null
}
