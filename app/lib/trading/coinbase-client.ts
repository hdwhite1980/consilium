// =============================================================
// app/lib/trading/coinbase-client.ts
//
// Coinbase Advanced Trade API client. Used for spot crypto trading
// alongside Alpaca. Coinbase has no paper mode — all trading is live
// against real funds.
//
// Key differences from Alpaca crypto:
//   - Authentication: CDP API keys, JWT signed with Ed25519 (per request)
//   - Base URL: https://api.coinbase.com/api/v3/brokerage
//   - Product format: 'BTC-USD' (dash, not slash)
//   - Orders use order_configuration objects, not flat fields
//   - Market buy uses quote_size (USD amount); market sell uses base_size (qty)
//   - Stop orders are stop_limit_stop_limit_gtc with stop_direction
//   - No paper/sandbox — testing is real money
//
// Interface intentionally mirrors AlpacaCryptoClient where possible so
// auto-trade-crypto cron can switch via broker flag.
//
// Auth approach:
//   - Per Coinbase docs (June 2026), JWT must be EdDSA with Ed25519 key
//   - JWT includes a `uri` claim: "METHOD api.coinbase.com/api/v3/brokerage/..."
//   - JWT expires 120s after issuance — we generate a fresh JWT per request
//   - Private key stored encrypted as PEM string or base64 raw seed
// =============================================================

import { createPrivateKey, randomBytes, sign as cryptoSign } from 'crypto'

const COINBASE_BASE_URL = 'https://api.coinbase.com'
const COINBASE_API_PATH = '/api/v3/brokerage'
const COINBASE_HOST = 'api.coinbase.com'
const JWT_EXPIRY_SECONDS = 120

export interface CoinbaseConfig {
  // Full key name from CDP portal: "organizations/{org}/apiKeys/{key}"
  keyName: string
  // PEM-formatted Ed25519 private key OR base64-encoded raw seed (32 or 64 bytes)
  privateKey: string
}

export interface CoinbaseAccount {
  status: 'ACTIVE' | 'INACTIVE' | string
  cash: number          // available USD
  equity: number        // cash + crypto holdings at current prices
  crypto_status: 'ACTIVE'
}

export interface CoinbasePosition {
  symbol: string                  // canonical BASE-USD ("BTC-USD")
  qty: number
  side: 'long'
  avg_entry_price: number         // from cost-basis if available, else 0
  market_value: number
  unrealized_pl: number
  current_price: number
}

export interface CoinbaseOrder {
  id: string
  client_order_id: string
  symbol: string                  // product_id like "BTC-USD"
  qty: number | null              // base_size from completion
  notional: number | null         // quote_size for market buys
  filled_qty: number
  filled_avg_price: number | null
  side: 'buy' | 'sell'
  type: string                    // 'market', 'stop_limit', 'limit'
  status: string                  // OPEN, FILLED, CANCELLED, etc.
  submitted_at: string | null
  filled_at: string | null
  cancelled_at: string | null
}

export interface CryptoEntryInput {
  symbol: string                  // 'BTC-USD'
  notionalUsd?: number            // dollar amount (market buy quote_size)
  qty?: number                    // base size (market sell base_size)
  side: 'buy' | 'sell'
  clientOrderId: string
}

export interface CryptoStopInput {
  symbol: string
  qty: number
  stopPrice: number
  clientOrderId: string
}

// ─── Futures (CFM) types ───────────────────────────────────────

export interface CoinbaseFuturesBalance {
  totalUsd: number          // total CFM futures-account value
  availableMargin: number   // free margin available for new positions
  initialMargin: number     // margin currently locked by open positions
  futuresBuyingPower: number
  liquidationThreshold: number
  unrealizedPnl: number
}

export interface CoinbaseFuturesPosition {
  productId: string
  side: 'long' | 'short'
  contracts: number
  avgEntryPrice: number
  currentPrice: number
  unrealizedPnl: number
  liquidationPrice: number | null
}

export interface FuturesEntryInput {
  productId: string
  side: 'buy' | 'sell'
  contracts: number          // integer contract count
  clientOrderId: string
}

export interface FuturesStopInput {
  productId: string
  side: 'buy' | 'sell'       // closing side (sell to close long, buy to close short)
  contracts: number
  stopPrice: number
  stopDirection: 'STOP_DIRECTION_STOP_DOWN' | 'STOP_DIRECTION_STOP_UP'
  clientOrderId: string
}

// ─────────────────────────────────────────────────────────────
// JWT signing
// ─────────────────────────────────────────────────────────────

/**
 * Build the canonical URI claim used in Coinbase JWTs.
 * Format: "METHOD api.coinbase.com/api/v3/brokerage/<path>"
 * Note: no protocol, no leading slash on host, NO QUERY STRING.
 *
 * Coinbase's JWT validator computes the expected URI from request method,
 * host, and path only — NOT including query parameters. If the JWT claim
 * includes ?foo=bar, validation fails with 401. We strip it here.
 */
function buildJwtUri(method: 'GET' | 'POST' | 'DELETE' | 'PUT', path: string): string {
  // path here is the segment under /api/v3/brokerage (e.g. "/orders")
  // Strip query string — Coinbase signs path only, not full URL.
  const pathOnly = path.split('?')[0]
  const cleanPath = pathOnly.startsWith('/') ? pathOnly : '/' + pathOnly
  // Final form: "GET api.coinbase.com/api/v3/brokerage/orders"
  return `${method} ${COINBASE_HOST}${COINBASE_API_PATH}${cleanPath}`
}

/**
 * base64url encode a Buffer (no padding, URL-safe alphabet).
 */
function base64url(input: Buffer): string {
  return input.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Extract a numeric value from Coinbase CFM money fields, which arrive either
 * as a bare number/string or as a { value, currency } object. Returns 0 for
 * anything unparseable so downstream gates fail safe (treat as no funds).
 */
function cfmValue(v: unknown): number {
  if (v === null || v === undefined) return 0
  if (typeof v === 'object' && v !== null && 'value' in (v as Record<string, unknown>)) {
    const n = Number((v as { value?: unknown }).value)
    return Number.isFinite(n) ? n : 0
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Parse the private key from either PKCS8 PEM format or base64-encoded raw seed.
 *
 * Coinbase CDP delivers Ed25519 keys in one of two forms depending on portal version:
 *   - PEM: "-----BEGIN PRIVATE KEY-----\n<base64>\n-----END PRIVATE KEY-----"
 *   - Raw base64: 32-byte seed OR 64-byte seed||pubkey
 *
 * For raw base64, we wrap into PKCS8 by prepending the standard Ed25519 OID prefix.
 */
function loadPrivateKey(secret: string): import('crypto').KeyObject {
  const trimmed = secret.trim()

  // PEM format
  if (trimmed.includes('-----BEGIN PRIVATE KEY-----')) {
    return createPrivateKey({
      key: trimmed,
      format: 'pem',
    })
  }

  // Raw base64 (32-byte seed or 64-byte seed||pub)
  const decoded = Buffer.from(trimmed, 'base64')
  if (decoded.length !== 32 && decoded.length !== 64) {
    throw new Error(`Invalid Ed25519 key length: ${decoded.length} bytes; expected 32 or 64`)
  }
  const seed = decoded.subarray(0, 32)

  // Build PKCS8 wrapper around the seed
  // PKCS8 prefix for Ed25519: SEQUENCE(INTEGER 0, SEQUENCE(OID 1.3.101.112), OCTET STRING(OCTET STRING(seed)))
  // Standard 16-byte prefix:
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex')
  const pkcs8Der = Buffer.concat([pkcs8Prefix, seed])
  return createPrivateKey({
    key: pkcs8Der,
    format: 'der',
    type: 'pkcs8',
  })
}

/**
 * Build a signed Coinbase CDP JWT for a single API call.
 *
 * Header: { alg: 'EdDSA', typ: 'JWT', kid: keyName, nonce: <random hex> }
 * Claims: { sub: keyName, iss: 'cdp', aud: ['cdp_service'], nbf, exp, uri }
 * Signature: EdDSA over (encodedHeader + '.' + encodedPayload)
 */
function buildJwt(config: CoinbaseConfig, uri: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = {
    alg: 'EdDSA',
    typ: 'JWT',
    kid: config.keyName,
    nonce: randomBytes(16).toString('hex'),
  }
  const claims = {
    sub: config.keyName,
    iss: 'cdp',
    aud: ['cdp_service'],
    nbf: now,
    exp: now + JWT_EXPIRY_SECONDS,
    uri,
  }
  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)))
  const encodedPayload = base64url(Buffer.from(JSON.stringify(claims)))
  const signingInput = `${encodedHeader}.${encodedPayload}`

  const privateKey = loadPrivateKey(config.privateKey)
  // Ed25519: no separate digest algorithm — pass null for algorithm
  const signature = cryptoSign(null, Buffer.from(signingInput), privateKey)
  const encodedSignature = base64url(signature)

  return `${signingInput}.${encodedSignature}`
}

// ─────────────────────────────────────────────────────────────
// Coinbase client
// ─────────────────────────────────────────────────────────────

export class CoinbaseClient {
  private config: CoinbaseConfig

  constructor(config: CoinbaseConfig) {
    if (!config.keyName) throw new Error('CoinbaseClient: keyName required')
    if (!config.privateKey) throw new Error('CoinbaseClient: privateKey required')
    this.config = config
  }

  /**
   * Authenticated request to the Coinbase Advanced Trade API.
   * Generates a fresh JWT per call (120s expiry, single-use nonce).
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
  ): Promise<T> {
    const uri = buildJwtUri(method, path)
    const jwt = buildJwt(this.config, uri)
    const url = `${COINBASE_BASE_URL}${COINBASE_API_PATH}${path.startsWith('/') ? path : '/' + path}`

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        let detail = `Coinbase HTTP ${res.status}`
        try {
          const parsed = JSON.parse(text) as { error?: string; error_details?: string; message?: string }
          if (parsed.error) detail += `: ${parsed.error}`
          if (parsed.error_details) detail += ` (${parsed.error_details})`
          if (parsed.message) detail += ` ${parsed.message}`
        } catch {
          if (text) detail += `: ${text.slice(0, 200)}`
        }
        throw new Error(detail)
      }
      return (text ? JSON.parse(text) : {}) as T
    } finally {
      clearTimeout(timer)
    }
  }

  // ─── Account ────────────────────────────────────────────────

  /**
   * Get account summary: USD cash, total equity, status.
   *
   * Coinbase doesn't return a single "account" endpoint like Alpaca;
   * we synthesize this from /accounts (list of currency accounts).
   * Equity = USD cash + sum(crypto qty * spot price). For speed we
   * approximate equity as USD cash + sum of `available_balance` * 0
   * for non-USD (i.e., we report USD cash as both cash and equity).
   * The cron computes effectiveEquity = min(equity, cash) anyway, so
   * this conservative approach is safe.
   */
  async account(): Promise<CoinbaseAccount> {
    const raw = await this.request<{ accounts?: Array<Record<string, unknown>> }>(
      'GET', '/accounts?limit=250',
    )
    const accounts = raw.accounts ?? []
    let usdCash = 0
    let hasActive = false
    for (const acct of accounts) {
      const currency = String(acct.currency ?? '')
      const active = String(acct.active ?? '') === 'true' || acct.active === true
      if (active) hasActive = true
      if (currency === 'USD' || currency === 'USDC') {
        const ab = acct.available_balance as { value?: string | number } | undefined
        if (ab && ab.value !== undefined) {
          usdCash += Number(ab.value)
        }
      }
    }
    return {
      status: hasActive ? 'ACTIVE' : 'INACTIVE',
      cash: usdCash,
      equity: usdCash,  // conservative; positions added below if caller wants total
      crypto_status: 'ACTIVE',
    }
  }

  /**
   * Get all crypto positions (non-USD balances > 0).
   *
   * Coinbase doesn't track "positions" with avg cost basis the way Alpaca
   * does — accounts just hold currency balances. For trading purposes we
   * synthesize positions from non-zero crypto balances and look up spot
   * prices to get current market value. Avg entry price comes from the
   * original trade_attempts row (caller's responsibility), not from
   * Coinbase, since the API doesn't expose it.
   */
  async positions(): Promise<CoinbasePosition[]> {
    const raw = await this.request<{ accounts?: Array<Record<string, unknown>> }>(
      'GET', '/accounts?limit=250',
    )
    const accounts = raw.accounts ?? []
    const positions: CoinbasePosition[] = []
    for (const acct of accounts) {
      const currency = String(acct.currency ?? '')
      if (currency === 'USD' || currency === 'USDC') continue
      const ab = acct.available_balance as { value?: string | number } | undefined
      const qty = ab && ab.value !== undefined ? Number(ab.value) : 0
      if (!Number.isFinite(qty) || qty <= 0) continue

      const symbol = `${currency}-USD`
      // Fetch spot to compute market value
      let currentPrice = 0
      try {
        currentPrice = await this.getSpotPrice(symbol)
      } catch {
        currentPrice = 0
      }
      const marketValue = qty * currentPrice
      positions.push({
        symbol,
        qty,
        side: 'long' as const,
        avg_entry_price: 0,  // unknown to Coinbase; caller tracks via trade_attempts
        market_value: marketValue,
        unrealized_pl: 0,    // unknown without avg entry
        current_price: currentPrice,
      })
    }
    return positions
  }

  /**
   * Get current spot price for a product (e.g. "BTC-USD").
   * Uses public market endpoint — still authed for consistency.
   */
  async getSpotPrice(symbol: string): Promise<number> {
    const raw = await this.request<{ price?: string; trades?: Array<{ price?: string }> }>(
      'GET', `/products/${encodeURIComponent(symbol)}/ticker?limit=1`,
    )
    if (raw.price !== undefined) return Number(raw.price)
    if (raw.trades && raw.trades.length > 0 && raw.trades[0].price !== undefined) {
      return Number(raw.trades[0].price)
    }
    throw new Error(`No spot price available for ${symbol}`)
  }

  /**
   * Get the full product details for a symbol. Returns the raw object from
   * Coinbase's /products/{id} endpoint, which includes price,
   * price_percentage_change_24h, volume_24h, base_increment, etc.
   *
   * Used by crypto-scanner to compute composite scores via authenticated
   * endpoint (30 req/sec rate limit vs 10/sec public).
   */
  async getProduct(symbol: string): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>(
      'GET', `/products/${encodeURIComponent(symbol)}`,
    )
  }

  /**
   * List ALL products in one call. Returns up to ~500 products with full
   * stats (price, 24h change, volume, new flag, status, increments).
   *
   * Used by the dynamic-universe scanner: one call replaces 30+ per-symbol
   * calls, then we filter client-side by USD quote, status, volume, movement.
   *
   * The response shape:
   *   { products: [ { product_id, price, price_percentage_change_24h,
   *                   volume_24h, volume_percentage_change_24h,
   *                   quote_currency_id, base_currency_id,
   *                   status, trading_disabled, cancel_only, limit_only,
   *                   new, base_min_size, quote_increment, ... } ] }
   */
  async listProducts(productType: 'SPOT' | 'FUTURE' = 'SPOT'): Promise<Array<Record<string, unknown>>> {
    const raw = await this.request<{ products?: Array<Record<string, unknown>> }>(
      'GET', `/products?product_type=${productType}&limit=500`,
    )
    return raw.products ?? []
  }

  /**
   * Get candles via authenticated endpoint. Same as the public
   * /market/products/{id}/candles but with 30 req/sec rate limit.
   */
  async getCandles(symbol: string, granularity: string, startUnix: number, endUnix: number): Promise<Array<Record<string, unknown>>> {
    const path = `/products/${encodeURIComponent(symbol)}/candles?start=${startUnix}&end=${endUnix}&granularity=${granularity}`
    const raw = await this.request<{ candles?: Array<Record<string, unknown>> }>('GET', path)
    return raw.candles ?? []
  }

  /**
   * Check if a product (e.g. "BTC-USD") is tradable on Coinbase.
   */
  async assetTradable(symbol: string): Promise<{ tradable: boolean; reason?: string }> {
    try {
      const raw = await this.request<{ trading_disabled?: boolean; status?: string; cancel_only?: boolean; limit_only?: boolean }>(
        'GET', `/products/${encodeURIComponent(symbol)}`,
      )
      if (raw.trading_disabled === true) {
        return { tradable: false, reason: 'trading_disabled on product' }
      }
      if (raw.cancel_only === true) {
        return { tradable: false, reason: 'cancel_only mode' }
      }
      // limit_only is technically still tradable but our cron places market orders
      if (raw.limit_only === true) {
        return { tradable: false, reason: 'limit_only mode (we place market entries)' }
      }
      if (raw.status && raw.status.toLowerCase() !== 'online') {
        return { tradable: false, reason: `product status: ${raw.status}` }
      }
      return { tradable: true }
    } catch (e) {
      return { tradable: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) }
    }
  }

  // ─── Orders ─────────────────────────────────────────────────

  /**
   * Place a market order. For BUY, sizes in USD (quote_size); for SELL,
   * sizes in base units (base_size). Coinbase market orders are IOC.
   */
  async marketEntry(input: CryptoEntryInput): Promise<CoinbaseOrder> {
    const orderConfig: Record<string, unknown> = {}
    if (input.side === 'buy') {
      if (input.notionalUsd === undefined) {
        throw new Error('Coinbase market BUY requires notionalUsd (quote_size)')
      }
      orderConfig.market_market_ioc = { quote_size: input.notionalUsd.toFixed(2) }
    } else {
      // sell: prefer qty (base_size); fall back to notional
      if (input.qty !== undefined) {
        orderConfig.market_market_ioc = { base_size: input.qty.toString() }
      } else if (input.notionalUsd !== undefined) {
        // selling by USD notional — Coinbase allows quote_size on sells too
        orderConfig.market_market_ioc = { quote_size: input.notionalUsd.toFixed(2) }
      } else {
        throw new Error('Coinbase market SELL requires qty or notionalUsd')
      }
    }
    const body = {
      client_order_id: input.clientOrderId,
      product_id: input.symbol,
      side: input.side.toUpperCase(),
      order_configuration: orderConfig,
    }
    const raw = await this.request<{
      success?: boolean
      success_response?: { order_id?: string; product_id?: string; side?: string; client_order_id?: string }
      error_response?: { error?: string; message?: string; error_details?: string }
      failure_reason?: string
    }>('POST', '/orders', body)

    if (raw.success === false || !raw.success_response?.order_id) {
      const detail = raw.error_response?.error
        ?? raw.error_response?.message
        ?? raw.error_response?.error_details
        ?? raw.failure_reason
        ?? 'order placement failed'
      throw new Error(`Coinbase marketEntry: ${detail}`)
    }
    // Fetch full order to populate filled_avg_price etc.
    return this.getOrder(raw.success_response.order_id)
  }

  /**
   * Place a protective stop-limit sell order. Triggers when price falls
   * below stopPrice; once triggered, places a limit at limit_price.
   * limit_price is set 0.5% below stop to accept reasonable slippage.
   *
   * stop_direction:
   *   - STOP_DIRECTION_STOP_DOWN: triggers when price drops to/below stop (protective stop on long)
   *   - STOP_DIRECTION_STOP_UP: triggers when price rises to/above stop (protective stop on short — not used here)
   */
  async stopLimitSell(input: CryptoStopInput): Promise<CoinbaseOrder> {
    const limitPrice = (input.stopPrice * 0.995).toFixed(2)
    const body = {
      client_order_id: input.clientOrderId,
      product_id: input.symbol,
      side: 'SELL',
      order_configuration: {
        stop_limit_stop_limit_gtc: {
          base_size: input.qty.toString(),
          limit_price: limitPrice,
          stop_price: input.stopPrice.toFixed(2),
          stop_direction: 'STOP_DIRECTION_STOP_DOWN',
        },
      },
    }
    const raw = await this.request<{
      success?: boolean
      success_response?: { order_id?: string }
      error_response?: { error?: string; message?: string; error_details?: string }
      failure_reason?: string
    }>('POST', '/orders', body)
    if (raw.success === false || !raw.success_response?.order_id) {
      const detail = raw.error_response?.error
        ?? raw.error_response?.message
        ?? raw.error_response?.error_details
        ?? raw.failure_reason
        ?? 'stop placement failed'
      throw new Error(`Coinbase stopLimitSell: ${detail}`)
    }
    return this.getOrder(raw.success_response.order_id)
  }

  async getOrder(orderId: string): Promise<CoinbaseOrder> {
    const raw = await this.request<{ order?: Record<string, unknown> }>(
      'GET', `/orders/historical/${encodeURIComponent(orderId)}`,
    )
    if (!raw.order) throw new Error(`Coinbase: order ${orderId} not found`)
    return this.toOrder(raw.order)
  }

  /**
   * Look up an order by the client-side ID we submitted. Used to verify
   * a placement succeeded when the POST response was unclear (e.g. timeout).
   * Returns null when not found.
   */
  async getOrderByClientId(clientOrderId: string): Promise<CoinbaseOrder | null> {
    try {
      const raw = await this.request<{ orders?: Array<Record<string, unknown>> }>(
        'GET',
        `/orders/historical/batch?limit=10&order_status=OPEN,FILLED,CANCELLED,EXPIRED`,
      )
      const orders = raw.orders ?? []
      const match = orders.find(o => String(o.client_order_id ?? '') === clientOrderId)
      return match ? this.toOrder(match) : null
    } catch {
      return null
    }
  }

  /**
   * Cancel one or more open orders by broker ID. Coinbase accepts an array
   * but we use it per-order for clarity.
   */
  async cancelOrder(orderId: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const raw = await this.request<{ results?: Array<{ success?: boolean; failure_reason?: string; order_id?: string }> }>(
        'POST',
        '/orders/batch_cancel',
        { order_ids: [orderId] },
      )
      const result = raw.results?.[0]
      if (!result) return { ok: false, reason: 'no result in batch_cancel response' }
      if (result.success) return { ok: true }
      const reason = result.failure_reason ?? 'unknown'
      // "ORDER_NOT_OPEN" or similar = already terminal — treat as ok
      if (/NOT.OPEN|ALREADY|FILLED|CANCELLED|TERMINAL/i.test(reason)) {
        return { ok: true, reason: 'already terminal' }
      }
      return { ok: false, reason }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/HTTP 404|not.found|already/i.test(msg)) {
        return { ok: true, reason: 'already terminal' }
      }
      return { ok: false, reason: msg.slice(0, 200) }
    }
  }

  /**
   * Close a crypto position by placing a market sell for the entire base balance.
   * Used by reeval EARLY_EXIT and target-hit detection.
   */
  async closePosition(symbol: string): Promise<CoinbaseOrder> {
    // Find current position size
    const positions = await this.positions()
    const pos = positions.find(p => p.symbol === symbol)
    if (!pos || pos.qty <= 0) {
      throw new Error(`Coinbase closePosition: no position in ${symbol}`)
    }
    const clientOrderId = `wos-close-${randomBytes(8).toString('hex')}`
    return this.marketEntry({
      symbol,
      qty: pos.qty,
      side: 'sell',
      clientOrderId,
    })
  }

  // ─── Futures (CFM) ──────────────────────────────────────────

  /**
   * CFM futures account balance summary. Coinbase money fields arrive as
   * { value, currency }; we extract the numeric value defensively.
   */
  async futuresBalanceSummary(): Promise<CoinbaseFuturesBalance> {
    const raw = await this.request<{ balance_summary?: Record<string, unknown> }>(
      'GET', '/cfm/balance_summary',
    )
    const bs = raw.balance_summary ?? {}
    return {
      totalUsd: cfmValue(bs.total_usd_balance ?? bs.cfm_usd_balance),
      availableMargin: cfmValue(bs.available_margin ?? bs.futures_buying_power),
      initialMargin: cfmValue(bs.initial_margin),
      futuresBuyingPower: cfmValue(bs.futures_buying_power),
      liquidationThreshold: cfmValue(bs.liquidation_threshold),
      unrealizedPnl: cfmValue(bs.unrealized_pnl),
    }
  }

  /** All open CFM futures positions. */
  async listFuturesPositions(): Promise<CoinbaseFuturesPosition[]> {
    const raw = await this.request<{ positions?: Array<Record<string, unknown>> }>(
      'GET', '/cfm/positions',
    )
    return (raw.positions ?? []).map(p => this.toFuturesPosition(p))
  }

  /** A single CFM futures position by product_id (null if flat). */
  async getFuturesPosition(productId: string): Promise<CoinbaseFuturesPosition | null> {
    try {
      const raw = await this.request<{ position?: Record<string, unknown> }>(
        'GET', `/cfm/positions/${encodeURIComponent(productId)}`,
      )
      if (!raw.position) return null
      const pos = this.toFuturesPosition(raw.position)
      return pos.contracts > 0 ? pos : null
    } catch {
      return null
    }
  }

  /**
   * Current intraday-margin window (READ-ONLY). We never auto-switch the
   * window — switching to INTRADAY raises leverage, which we deliberately
   * avoid. Exposed only so callers/monitor can log which regime is active.
   */
  async getMarginWindow(): Promise<{ window: string; isIntraday: boolean }> {
    try {
      const raw = await this.request<{ margin_window?: { margin_window_type?: string } }>(
        'GET', '/cfm/intraday/current_margin_window',
      )
      const w = String(raw.margin_window?.margin_window_type ?? 'UNKNOWN')
      return { window: w, isIntraday: /INTRADAY/i.test(w) }
    } catch {
      return { window: 'UNKNOWN', isIntraday: false }
    }
  }

  /**
   * Place a futures market order. base_size = number of CONTRACTS (integer).
   * Leverage is governed by the account margin window, not this order.
   */
  async futuresMarketOrder(input: FuturesEntryInput): Promise<CoinbaseOrder> {
    const body = {
      client_order_id: input.clientOrderId,
      product_id: input.productId,
      side: input.side.toUpperCase(),
      order_configuration: { market_market_ioc: { base_size: String(input.contracts) } },
    }
    const raw = await this.request<{
      success?: boolean
      success_response?: { order_id?: string }
      error_response?: { error?: string; message?: string; error_details?: string }
      failure_reason?: string
    }>('POST', '/orders', body)
    if (raw.success === false || !raw.success_response?.order_id) {
      const detail = raw.error_response?.error ?? raw.error_response?.message
        ?? raw.error_response?.error_details ?? raw.failure_reason ?? 'order placement failed'
      throw new Error(`Coinbase futuresMarketOrder: ${detail}`)
    }
    return this.getOrder(raw.success_response.order_id)
  }

  /**
   * Place a protective futures stop (stop-limit GTC). For a long position the
   * closing side is SELL with STOP_DOWN; for a short, BUY with STOP_UP.
   */
  async futuresStopOrder(input: FuturesStopInput): Promise<CoinbaseOrder> {
    const slip = input.stopDirection === 'STOP_DIRECTION_STOP_DOWN' ? 0.995 : 1.005
    const limitPrice = (input.stopPrice * slip).toFixed(2)
    const body = {
      client_order_id: input.clientOrderId,
      product_id: input.productId,
      side: input.side.toUpperCase(),
      order_configuration: {
        stop_limit_stop_limit_gtc: {
          base_size: String(input.contracts),
          limit_price: limitPrice,
          stop_price: input.stopPrice.toFixed(2),
          stop_direction: input.stopDirection,
        },
      },
    }
    const raw = await this.request<{
      success?: boolean
      success_response?: { order_id?: string }
      error_response?: { error?: string; message?: string; error_details?: string }
      failure_reason?: string
    }>('POST', '/orders', body)
    if (raw.success === false || !raw.success_response?.order_id) {
      const detail = raw.error_response?.error ?? raw.error_response?.message
        ?? raw.error_response?.error_details ?? raw.failure_reason ?? 'stop placement failed'
      throw new Error(`Coinbase futuresStopOrder: ${detail}`)
    }
    return this.getOrder(raw.success_response.order_id)
  }

  private toFuturesPosition(raw: Record<string, unknown>): CoinbaseFuturesPosition {
    const sideRaw = String(raw.side ?? raw.position_side ?? '').toUpperCase()
    const side: 'long' | 'short' = /SHORT|SELL/.test(sideRaw) ? 'short' : 'long'
    const liq = cfmValue(raw.liquidation_price)
    return {
      productId: String(raw.product_id ?? ''),
      side,
      contracts: Math.abs(cfmValue(raw.number_of_contracts ?? raw.net_size ?? raw.contracts)),
      avgEntryPrice: cfmValue(raw.avg_entry_price ?? raw.entry_price),
      currentPrice: cfmValue(raw.current_price ?? raw.mark_price),
      unrealizedPnl: cfmValue(raw.unrealized_pnl),
      liquidationPrice: liq > 0 ? liq : null,
    }
  }

  /**
   * Coerce a Coinbase order object into our normalized shape.
   *
   * Coinbase orders nest sizing info inside order_configuration which varies
   * by order type. We extract what we can; null for missing fields.
   */
  private toOrder(raw: Record<string, unknown>): CoinbaseOrder {
    const cfg = (raw.order_configuration ?? {}) as Record<string, unknown>
    let qty: number | null = null
    let notional: number | null = null

    // market_market_ioc
    const mm = cfg.market_market_ioc as Record<string, unknown> | undefined
    if (mm) {
      if (mm.base_size !== undefined) qty = Number(mm.base_size)
      if (mm.quote_size !== undefined) notional = Number(mm.quote_size)
    }
    // stop_limit_stop_limit_gtc
    const sl = cfg.stop_limit_stop_limit_gtc as Record<string, unknown> | undefined
    if (sl && sl.base_size !== undefined) qty = Number(sl.base_size)
    // limit_limit_gtc
    const ll = cfg.limit_limit_gtc as Record<string, unknown> | undefined
    if (ll && ll.base_size !== undefined) qty = Number(ll.base_size)

    // filled stats
    const filledSize = raw.filled_size !== undefined ? Number(raw.filled_size) : 0
    const filledAvgPrice = raw.average_filled_price !== undefined && raw.average_filled_price !== null
      ? Number(raw.average_filled_price)
      : null

    // type: pick from order_configuration keys
    let orderType = ''
    if (mm) orderType = 'market'
    else if (sl) orderType = 'stop_limit'
    else if (ll) orderType = 'limit'

    return {
      id: String(raw.order_id ?? raw.id ?? ''),
      client_order_id: String(raw.client_order_id ?? ''),
      symbol: String(raw.product_id ?? ''),
      qty,
      notional,
      filled_qty: filledSize,
      filled_avg_price: filledAvgPrice !== null && Number.isFinite(filledAvgPrice) ? filledAvgPrice : null,
      side: String(raw.side ?? 'buy').toLowerCase() as 'buy' | 'sell',
      type: orderType,
      status: String(raw.status ?? ''),
      submitted_at: raw.created_time ? String(raw.created_time) : null,
      filled_at: raw.completion_percentage === '100' || raw.status === 'FILLED'
        ? String(raw.last_fill_time ?? raw.created_time ?? '')
        : null,
      cancelled_at: raw.status === 'CANCELLED' ? String(raw.created_time ?? '') : null,
    }
  }
}

export function makeCoinbaseClient(keyName: string, privateKey: string): CoinbaseClient {
  return new CoinbaseClient({ keyName, privateKey })
}
