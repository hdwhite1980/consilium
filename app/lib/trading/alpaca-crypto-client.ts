// =============================================================
// app/lib/trading/alpaca-crypto-client.ts
//
// Alpaca crypto API. Different from stocks API:
//   - Endpoint: same domain, /v2/orders but with crypto symbols
//   - Symbols use BASE/QUOTE format: BTC/USD, ETH/USD
//   - Fractional quantities supported (notional sizing)
//   - 24/7 markets — no time-in-force restrictions
//   - No bracket orders (no order_class='bracket' on crypto)
//   - Instead: use OCO via separate calls or rely on stop+limit
//
// For v1 we place market entry + separate stop_limit child orders
// to approximate bracket behavior.
//
// Auth uses the same Alpaca paper/live key+secret as the stocks
// client. (You can use stocks keys for crypto if your account has
// crypto enabled, OR generate separate keys with crypto perms.)
// =============================================================

const ALPACA_PAPER_BASE = 'https://paper-api.alpaca.markets'
const ALPACA_LIVE_BASE  = 'https://api.alpaca.markets'

export interface AlpacaCryptoConfig {
  keyId: string
  secret: string
  mode: 'paper' | 'live'
}

export interface AlpacaCryptoAccount {
  status: string
  cash: number
  equity: number
  crypto_status?: string
}

export interface AlpacaCryptoPosition {
  symbol: string                 // e.g. "BTCUSD" (Alpaca returns without slash)
  qty: number
  side: 'long'                   // crypto can only be long on Alpaca
  avg_entry_price: number
  market_value: number
  unrealized_pl: number
  current_price: number
}

export interface AlpacaCryptoOrder {
  id: string
  client_order_id: string
  symbol: string
  qty: number | null
  notional: number | null
  filled_qty: number
  filled_avg_price: number | null
  side: 'buy' | 'sell'
  type: string
  status: string
  submitted_at: string | null
  filled_at: string | null
  cancelled_at: string | null
}

export interface CryptoEntryInput {
  symbol: string                  // canonical "BTC/USD"
  notionalUsd?: number            // dollar amount to buy (preferred for fractional)
  qty?: number                    // OR explicit qty (e.g. 0.001 BTC)
  side: 'buy' | 'sell'            // sell-to-close only (no shorting crypto on Alpaca)
  clientOrderId: string
}

export interface CryptoStopInput {
  symbol: string
  qty: number
  stopPrice: number
  clientOrderId: string
}

export class AlpacaCryptoClient {
  private baseUrl: string
  private headers: Record<string, string>

  constructor(config: AlpacaCryptoConfig) {
    this.baseUrl = config.mode === 'paper' ? ALPACA_PAPER_BASE : ALPACA_LIVE_BASE
    this.headers = {
      'APCA-API-KEY-ID': config.keyId,
      'APCA-API-SECRET-KEY': config.secret,
      'Content-Type': 'application/json',
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
  ): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method, headers: this.headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        let detail = `HTTP ${res.status}`
        try {
          const parsed = JSON.parse(text) as { message?: string; code?: number }
          if (parsed.message) detail += `: ${parsed.message}`
          if (parsed.code) detail += ` (code=${parsed.code})`
        } catch { if (text) detail += `: ${text.slice(0, 200)}` }
        throw new Error(detail)
      }
      return (text ? JSON.parse(text) : {}) as T
    } finally { clearTimeout(timer) }
  }

  async account(): Promise<AlpacaCryptoAccount> {
    const raw = await this.request<Record<string, unknown>>('GET', '/v2/account')
    return {
      status: String(raw.status ?? ''),
      cash: Number(raw.cash ?? 0),
      equity: Number(raw.equity ?? 0),
      crypto_status: raw.crypto_status ? String(raw.crypto_status) : undefined,
    }
  }

  async positions(): Promise<AlpacaCryptoPosition[]> {
    const raw = await this.request<Array<Record<string, unknown>>>('GET', '/v2/positions')
    // Filter to crypto only (Alpaca returns stock + crypto mixed; identify by asset_class)
    return raw
      .filter(p => String(p.asset_class ?? '') === 'crypto')
      .map(p => ({
        symbol: String(p.symbol ?? ''),
        qty: Number(p.qty ?? 0),
        side: 'long' as const,
        avg_entry_price: Number(p.avg_entry_price ?? 0),
        market_value: Number(p.market_value ?? 0),
        unrealized_pl: Number(p.unrealized_pl ?? 0),
        current_price: Number(p.current_price ?? 0),
      }))
  }

  /**
   * Verify a crypto asset is tradable on Alpaca.
   * Symbol format: BASE/USD (e.g. "BTC/USD")
   */
  async assetTradable(symbol: string): Promise<{ tradable: boolean; reason?: string }> {
    try {
      const raw = await this.request<{ tradable?: boolean; status?: string; class?: string }>(
        'GET', `/v2/assets/${encodeURIComponent(symbol)}`
      )
      if (raw.class !== 'crypto') return { tradable: false, reason: `Not a crypto asset (class=${raw.class})` }
      if (raw.tradable !== true) return { tradable: false, reason: `Asset not tradable (status=${raw.status})` }
      return { tradable: true }
    } catch (e) {
      return { tradable: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) }
    }
  }

  /**
   * Market entry for crypto. Uses notional (dollar amount) sizing
   * when notionalUsd is provided, otherwise explicit qty.
   */
  async marketEntry(input: CryptoEntryInput): Promise<AlpacaCryptoOrder> {
    const body: Record<string, unknown> = {
      symbol: input.symbol,
      side: input.side,
      type: 'market',
      time_in_force: 'gtc',
      client_order_id: input.clientOrderId,
    }
    if (input.notionalUsd !== undefined) {
      body.notional = input.notionalUsd.toFixed(2)
    } else if (input.qty !== undefined) {
      body.qty = input.qty.toString()
    } else {
      throw new Error('marketEntry: either notionalUsd or qty required')
    }
    const raw = await this.request<Record<string, unknown>>('POST', '/v2/orders', body)
    return this.toOrder(raw)
  }

  /**
   * Stop-limit sell as protective stop. Crypto on Alpaca doesn't
   * support bracket orders, so we place this as a separate order
   * AFTER entry fills.
   */
  async stopLimitSell(input: CryptoStopInput): Promise<AlpacaCryptoOrder> {
    const body = {
      symbol: input.symbol,
      qty: input.qty.toString(),
      side: 'sell',
      type: 'stop_limit',
      time_in_force: 'gtc',
      stop_price: input.stopPrice.toFixed(2),
      limit_price: (input.stopPrice * 0.995).toFixed(2),  // accept up to 0.5% slippage
      client_order_id: input.clientOrderId,
    }
    const raw = await this.request<Record<string, unknown>>('POST', '/v2/orders', body)
    return this.toOrder(raw)
  }

  async getOrder(orderId: string): Promise<AlpacaCryptoOrder> {
    const raw = await this.request<Record<string, unknown>>('GET', `/v2/orders/${encodeURIComponent(orderId)}`)
    return this.toOrder(raw)
  }

  async getOrderByClientId(clientOrderId: string): Promise<AlpacaCryptoOrder | null> {
    try {
      const raw = await this.request<Record<string, unknown>>(
        'GET', `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`
      )
      return this.toOrder(raw)
    } catch (e) {
      if (e instanceof Error && /HTTP 404/.test(e.message)) return null
      throw e
    }
  }

  async closePosition(symbol: string): Promise<void> {
    await this.request('DELETE', `/v2/positions/${encodeURIComponent(symbol)}`)
  }

  /**
   * Cancel a working order by its broker ID. Used by Session 3a positions
   * worker to cancel the protective stop when a target is hit or reeval
   * decides on early_exit.
   *
   * Idempotent: cancelling an already-filled or already-cancelled order
   * returns the order's current state without error in most cases. We
   * suppress HTTP 422 (order not cancellable) as a no-op since "not
   * cancellable" usually means "already terminal" which is what we want.
   */
  async cancelOrder(orderId: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.request<unknown>('DELETE', `/v2/orders/${encodeURIComponent(orderId)}`)
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 422 = not cancellable (already filled/cancelled). Treat as ok.
      if (/HTTP 422|already (filled|cancel)/i.test(msg)) {
        return { ok: true, reason: 'already terminal' }
      }
      return { ok: false, reason: msg.slice(0, 200) }
    }
  }

  private toOrder(raw: Record<string, unknown>): AlpacaCryptoOrder {
    return {
      id: String(raw.id ?? ''),
      client_order_id: String(raw.client_order_id ?? ''),
      symbol: String(raw.symbol ?? ''),
      qty: raw.qty !== undefined && raw.qty !== null ? Number(raw.qty) : null,
      notional: raw.notional !== undefined && raw.notional !== null ? Number(raw.notional) : null,
      filled_qty: Number(raw.filled_qty ?? 0),
      filled_avg_price: raw.filled_avg_price !== undefined && raw.filled_avg_price !== null
        ? Number(raw.filled_avg_price) : null,
      side: String(raw.side ?? 'buy') as 'buy' | 'sell',
      type: String(raw.type ?? ''),
      status: String(raw.status ?? ''),
      submitted_at: raw.submitted_at ? String(raw.submitted_at) : null,
      filled_at: raw.filled_at ? String(raw.filled_at) : null,
      cancelled_at: raw.canceled_at ? String(raw.canceled_at) : null,
    }
  }
}

export function makeAlpacaCryptoClient(keyId: string, secret: string, mode: 'paper' | 'live'): AlpacaCryptoClient {
  return new AlpacaCryptoClient({ keyId, secret, mode })
}
