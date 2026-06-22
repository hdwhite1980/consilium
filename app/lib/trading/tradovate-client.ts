// =============================================================
// app/lib/trading/tradovate-client.ts
//
// Tradovate REST client for futures auto-trading.
//
// Key differences from Alpaca/OANDA:
//   - Access tokens expire every ~80 min; client transparently
//     refreshes using stored credentials
//   - Contract specs: contracts have integer IDs that we resolve
//     from symbol root (e.g. "ES" → front-month contract ID)
//   - Orders use "qty" in CONTRACT units (each ES contract = $250 × index)
//   - Order types: Market, Limit, Stop. We use Market for entry,
//     attach OCO (stop + limit) child orders to manage exit
//
// The client is constructed with a token cache callback so it can
// refresh the cache after auth.
// =============================================================

import {
  tradovateAuth,
  type TradovateAuthResponse,
  type TradovateCredentialInput,
} from './tradovate-validate'

const TRADOVATE_DEMO_BASE = 'https://demo.tradovateapi.com/v1'
const TRADOVATE_LIVE_BASE = 'https://live.tradovateapi.com/v1'

// Refresh threshold: refresh if token expires within this window
const REFRESH_WINDOW_MS = 10 * 60_000  // 10 minutes

export interface TradovateClientConfig {
  mode: 'paper' | 'live'
  credentials: TradovateCredentialInput
  accountSpec: string                 // e.g. "DEMO12345"
  accountIntId: number                // numeric account ID
  cachedAccessToken: string | null
  cachedExpiresAt: string | null       // ISO timestamp
  onTokenRefreshed?: (token: string, expiresAt: string) => Promise<void>
}

export interface TradovateContract {
  id: number
  name: string                        // e.g. "ESH6"
  contractMaturityId: number
  productId: number
  productType: string                  // "Future"
  status: string                       // "Active"
}

export interface TradovatePosition {
  id: number
  accountId: number
  contractId: number
  contractName?: string
  netPos: number                       // contracts (signed: positive=long, negative=short)
  netPrice: number | null              // average entry price
  prevPrice: number | null
  openPL?: number | null
}

export interface TradovateCashSummary {
  totalCashValue: number
  availableLiquidity: number
  realizedPnL: number
  unrealizedPnL: number
}

export interface PlaceOrderInput {
  contractId: number
  action: 'Buy' | 'Sell'
  qty: number                          // contracts
  orderType: 'Market' | 'Limit' | 'Stop'
  price?: number                       // for Limit and Stop
  isAutomated?: boolean
}

export interface PlaceOrderResult {
  orderId?: number
  failureReason?: string
  failureText?: string
}

export interface TradovateOrder {
  id: number
  accountId: number
  contractId: number
  action: 'Buy' | 'Sell'
  orderType: string
  ordStatus: string         // Tradovate's status enum: Working | Filled | Canceled | Rejected | Expired | etc.
  status: string            // alias of ordStatus for compatibility
  cumQty: number            // cumulative filled qty
  avgPrice: number | null   // average fill price
  timestamp: string | null  // last update time
}

export class TradovateClient {
  private mode: 'paper' | 'live'
  private baseUrl: string
  private credentials: TradovateCredentialInput
  private accessToken: string | null
  private expiresAt: Date | null
  private onTokenRefreshed?: (token: string, expiresAt: string) => Promise<void>
  public readonly accountSpec: string
  public readonly accountIntId: number

  constructor(config: TradovateClientConfig) {
    this.mode = config.mode
    this.baseUrl = config.mode === 'paper' ? TRADOVATE_DEMO_BASE : TRADOVATE_LIVE_BASE
    this.credentials = config.credentials
    this.accessToken = config.cachedAccessToken
    this.expiresAt = config.cachedExpiresAt ? new Date(config.cachedExpiresAt) : null
    this.onTokenRefreshed = config.onTokenRefreshed
    this.accountSpec = config.accountSpec
    this.accountIntId = config.accountIntId
  }

  private async ensureToken(): Promise<string> {
    const now = Date.now()
    const expiresMs = this.expiresAt ? this.expiresAt.getTime() : 0
    const needsRefresh = !this.accessToken || (expiresMs - now) < REFRESH_WINDOW_MS

    if (!needsRefresh && this.accessToken) return this.accessToken

    // Refresh
    const auth = await tradovateAuth(this.baseUrl, this.credentials)
    if (!auth.accessToken) {
      throw new Error(`Tradovate token refresh failed: ${auth.errorText ?? 'unknown'}`)
    }
    this.accessToken = auth.accessToken
    this.expiresAt = auth.expirationTime ? new Date(auth.expirationTime) : null

    // Notify caller so it can persist the new token
    if (this.onTokenRefreshed && auth.expirationTime) {
      try {
        await this.onTokenRefreshed(auth.accessToken, auth.expirationTime)
      } catch (e) {
        console.warn('[tradovate] onTokenRefreshed callback failed:', e instanceof Error ? e.message : e)
      }
    }

    if (!this.accessToken) throw new Error('Tradovate access token still null after refresh')
    return this.accessToken
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = 12_000,
  ): Promise<T> {
    const token = await this.ensureToken()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        let detail = `HTTP ${res.status}`
        try {
          const j = JSON.parse(text) as { errorText?: string; message?: string; errorCode?: number }
          if (j.errorText) detail += `: ${j.errorText}`
          else if (j.message) detail += `: ${j.message}`
        } catch { if (text) detail += `: ${text.slice(0, 200)}` }
        throw new Error(detail)
      }
      return (text ? JSON.parse(text) : {}) as T
    } finally { clearTimeout(timer) }
  }

  async cashSummary(): Promise<TradovateCashSummary> {
    const raw = await this.request<Record<string, unknown>>(
      'POST', `/cashBalance/getCashBalanceSnapshot`, { accountId: this.accountIntId }
    )
    return {
      totalCashValue: Number(raw.totalCashValue ?? 0),
      availableLiquidity: Number(raw.availableLiquidity ?? 0),
      realizedPnL: Number(raw.realizedPnL ?? 0),
      unrealizedPnL: Number(raw.unrealizedPnL ?? 0),
    }
  }

  async positions(): Promise<TradovatePosition[]> {
    const raw = await this.request<Array<Record<string, unknown>>>('GET', '/position/list')
    // Filter to this account only
    return raw
      .filter(p => Number(p.accountId ?? 0) === this.accountIntId)
      .map(p => ({
        id: Number(p.id ?? 0),
        accountId: Number(p.accountId ?? 0),
        contractId: Number(p.contractId ?? 0),
        netPos: Number(p.netPos ?? 0),
        netPrice: p.netPrice !== undefined && p.netPrice !== null ? Number(p.netPrice) : null,
        prevPrice: p.prevPrice !== undefined && p.prevPrice !== null ? Number(p.prevPrice) : null,
      }))
  }

  /**
   * Find front-month contract for a futures root.
   *
   * Tradovate's contract API:
   *   GET /contract/find?name=<root>  → searches all contracts matching root
   * We pick the one with the nearest active expiration that's still trading.
   *
   * For roots like "ES", returns the current front-month (e.g. ESH6 in
   * Jan-Mar 2026, ESM6 in Apr-Jun, etc.)
   */
  async findFrontMonthContract(root: string): Promise<TradovateContract | null> {
    try {
      // Search by name prefix
      const search = await this.request<TradovateContract[]>(
        'GET', `/contract/suggest?t=${encodeURIComponent(root)}&l=20`
      )
      if (!search || search.length === 0) return null
      // Filter to active futures matching this root
      const candidates = search.filter(c =>
        c.productType === 'Future' &&
        c.status === 'Active' &&
        c.name.startsWith(root)
      )
      if (candidates.length === 0) return null
      // Take first (Tradovate returns by maturity ascending)
      return candidates[0]
    } catch (e) {
      console.warn(`[tradovate] findFrontMonthContract(${root}) failed:`, e instanceof Error ? e.message : e)
      return null
    }
  }

  async getContract(contractId: number): Promise<TradovateContract | null> {
    try {
      return await this.request<TradovateContract>('GET', `/contract/item?id=${contractId}`)
    } catch {
      return null
    }
  }

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    const body: Record<string, unknown> = {
      accountSpec: this.accountSpec,
      accountId: this.accountIntId,
      action: input.action,
      symbol: undefined,                              // we use contractId, not symbol
      orderQty: Math.trunc(input.qty),
      orderType: input.orderType,
      contractId: input.contractId,
      isAutomated: input.isAutomated ?? true,
      timeInForce: 'GTC',
    }
    if (input.orderType === 'Limit' && input.price !== undefined) body.price = input.price
    if (input.orderType === 'Stop' && input.price !== undefined) body.stopPrice = input.price
    return await this.request<PlaceOrderResult>('POST', '/order/placeorder', body)
  }

  /**
   * Place an OSO bracket: entry + child stop + child target.
   * Tradovate's OSO/OCO support requires a different endpoint shape.
   * For v1 we place market entry, then place stop+limit as separate
   * orders after entry confirms. Caller handles the sequencing.
   */
  async closePositionMarket(contractId: number, qty: number): Promise<PlaceOrderResult> {
    return this.placeOrder({
      contractId,
      action: qty > 0 ? 'Sell' : 'Buy',  // opposite of current
      qty: Math.abs(qty),
      orderType: 'Market',
      isAutomated: true,
    })
  }

  /**
   * Cancel a working order. Used by Session 3a positions worker to cancel
   * a protective stop on target-hit or reeval-driven exit.
   *
   * Tradovate's /order/cancelorder accepts the integer orderId in the body.
   * Returns ok=true on success OR if the order is already in a terminal
   * state (already filled, already cancelled, expired).
   */
  async cancelOrder(orderId: number): Promise<{ ok: boolean; reason?: string }> {
    try {
      const result = await this.request<{ failureReason?: string; failureText?: string; orderId?: number }>(
        'POST', '/order/cancelorder', { orderId }
      )
      if (result.failureReason || result.failureText) {
        const msg = `${result.failureReason ?? 'unknown'}: ${result.failureText ?? ''}`
        // "OrderNotInRefuseState" or similar terminal-state responses are no-ops for our purposes
        if (/notinrefusestate|already|completed|terminal|filled|cancel/i.test(msg)) {
          return { ok: true, reason: 'already terminal' }
        }
        return { ok: false, reason: msg.slice(0, 200) }
      }
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, reason: msg.slice(0, 200) }
    }
  }

  /**
   * Fetch an order by ID. Used by Session 3a to check whether a stop
   * order has filled (closure detection).
   *
   * Tradovate's /order/item returns the order with status, filledQty,
   * avgPrice, and timestamps.
   */
  async getOrder(orderId: number): Promise<TradovateOrder | null> {
    try {
      const raw = await this.request<Record<string, unknown>>('GET', `/order/item?id=${orderId}`)
      return {
        id: Number(raw.id ?? 0),
        accountId: Number(raw.accountId ?? 0),
        contractId: Number(raw.contractId ?? 0),
        action: String(raw.action ?? '') as 'Buy' | 'Sell',
        orderType: String(raw.orderType ?? ''),
        ordStatus: String(raw.ordStatus ?? ''),
        status: String(raw.ordStatus ?? ''),
        cumQty: Number(raw.cumQty ?? 0),
        avgPrice: raw.avgPrice !== undefined && raw.avgPrice !== null ? Number(raw.avgPrice) : null,
        timestamp: raw.timestamp ? String(raw.timestamp) : null,
      }
    } catch {
      return null
    }
  }
}

/**
 * Factory: build TradovateClient from cached credentials + DB callback.
 */
export function makeTradovateClient(
  config: TradovateClientConfig,
): TradovateClient {
  return new TradovateClient(config)
}
