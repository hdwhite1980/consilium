// =============================================================
// app/lib/trading/alpaca-client.ts
//
// Wraps the Alpaca REST API for the auto-trader. Per-user creds
// passed in via factory function — never reads env vars for
// trading creds (those are per-account, not global).
//
// What this does:
//   - account()           → live equity/cash
//   - positions()         → open positions
//   - bracketOrder()      → market entry with attached stop + target (atomic)
//   - getOrder()          → fetch a placed order by client_order_id or id
//   - closedOrdersToday() → realized P&L source
//   - assetTradable()     → verify ticker is tradable (catches BRK.B vs BRKB)
//
// What this does NOT do:
//   - Decide what to trade (decide.ts does that)
//   - Compute sizing (sizing.ts does that)
//   - Apply kill switches (kill-switches.ts does that)
//   - Touch live trading credentials unless mode='live'
// =============================================================

const ALPACA_PAPER_BASE = 'https://paper-api.alpaca.markets'
const ALPACA_LIVE_BASE  = 'https://api.alpaca.markets'

export interface AlpacaClientConfig {
  keyId: string
  secret: string
  mode: 'paper' | 'live'
}

export interface AlpacaAccount {
  id: string
  status: string
  cash: number
  equity: number
  buying_power: number
  // Shorting support. shorting_enabled is Alpaca's account-level flag;
  // multiplier > 1 indicates a margin account (cash accounts are 1 and
  // cannot short). Both must hold before we place a sell-to-open order.
  shorting_enabled: boolean
  multiplier: number
  // Note (2026-06-22): PDT-related fields removed.
  // FINRA eliminated the Pattern Day Trader designation effective June 4, 2026
  // (SR-FINRA-2025-017, SEC approved April 14, 2026). Alpaca will remove
  // pattern_day_trader, daytrade_count, last_daytrade_count,
  // last_daytrading_buying_power, and daytrading_buying_power from the
  // /v2/account response by July 6, 2026. These fields had no consumers
  // in our codebase, so they're dropped entirely rather than maintained as
  // always-zero / always-false stubs.
}

export interface AlpacaPosition {
  symbol: string
  qty: number
  side: 'long' | 'short'
  avg_entry_price: number
  market_value: number
  unrealized_pl: number
  current_price: number
}

export interface AlpacaOrder {
  id: string
  client_order_id: string
  symbol: string
  qty: number | null
  filled_qty: number
  filled_avg_price: number | null
  side: 'buy' | 'sell'
  type: string
  status: string
  submitted_at: string | null
  filled_at: string | null
  cancelled_at: string | null
  rejected_at: string | null
  failed_at: string | null
  legs: AlpacaOrder[] | null
}

export interface BracketOrderInput {
  symbol: string                  // canonical Alpaca symbol (already normalized)
  qty: number                     // shares (whole number for stocks)
  side: 'buy' | 'sell'            // BUY for BULLISH, SELL for BEARISH
  takeProfitPrice: number
  stopLossPrice: number
  clientOrderId: string           // idempotency key (we generate)
  timeInForce?: 'day' | 'gtc'     // default 'gtc' so the stop survives EOD
}

export class AlpacaClient {
  private baseUrl: string
  private headers: Record<string, string>

  constructor(config: AlpacaClientConfig) {
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
    timeoutMs = 8_000,
  ): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        // Alpaca returns helpful error bodies — surface them
        let detail = `HTTP ${res.status}`
        try {
          const parsed = JSON.parse(text) as { message?: string; code?: number }
          if (parsed.message) detail += `: ${parsed.message}`
          if (parsed.code) detail += ` (code=${parsed.code})`
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

  async account(): Promise<AlpacaAccount> {
    const raw = await this.request<Record<string, unknown>>('GET', '/v2/account')
    return {
      id: String(raw.id ?? ''),
      status: String(raw.status ?? ''),
      cash: Number(raw.cash ?? 0),
      equity: Number(raw.equity ?? 0),
      buying_power: Number(raw.buying_power ?? 0),
      shorting_enabled: Boolean(raw.shorting_enabled ?? false),
      multiplier: Number(raw.multiplier ?? 1),
    }
  }

  async positions(): Promise<AlpacaPosition[]> {
    const raw = await this.request<Array<Record<string, unknown>>>('GET', '/v2/positions')
    return raw.map(p => ({
      symbol: String(p.symbol ?? ''),
      qty: Number(p.qty ?? 0),
      side: String(p.side ?? 'long') as 'long' | 'short',
      avg_entry_price: Number(p.avg_entry_price ?? 0),
      market_value: Number(p.market_value ?? 0),
      unrealized_pl: Number(p.unrealized_pl ?? 0),
      current_price: Number(p.current_price ?? 0),
    }))
  }

  /**
   * Verify an asset is tradable on Alpaca. Catches symbol normalization
   * issues (BRK.B vs BRK-B vs BRKB) before order placement.
   */
  async assetTradable(symbol: string): Promise<{ tradable: boolean; shortable?: boolean; easyToBorrow?: boolean; reason?: string }> {
    try {
      const raw = await this.request<{ tradable?: boolean; status?: string; shortable?: boolean; easy_to_borrow?: boolean }>(
        'GET', `/v2/assets/${encodeURIComponent(symbol)}`
      )
      if (raw.tradable !== true) {
        return { tradable: false, reason: `Asset not tradable (status: ${raw.status})` }
      }
      return {
        tradable: true,
        shortable: raw.shortable === true,
        easyToBorrow: raw.easy_to_borrow === true,
      }
    } catch (e) {
      return {
        tradable: false,
        reason: e instanceof Error ? e.message.slice(0, 200) : String(e),
      }
    }
  }

  /**
   * Place a bracket order: market entry + child stop + child target.
   * Alpaca attaches all three legs atomically — if any leg fails to
   * place, the parent order is rejected too.
   *
   * Returns the parent order. Child legs are in order.legs[].
   *
   * IMPORTANT: caller must verify post-fill that the child stop is
   * actually attached. Bracket orders CAN return success while a leg
   * is silently pending or rejected by venue — defensive checking
   * happens in the worker, not here.
   */
  async bracketOrder(input: BracketOrderInput): Promise<AlpacaOrder> {
    const body = {
      symbol: input.symbol,
      qty: input.qty.toString(),
      side: input.side,
      type: 'market',
      time_in_force: input.timeInForce ?? 'gtc',
      order_class: 'bracket',
      client_order_id: input.clientOrderId,
      take_profit: {
        limit_price: input.takeProfitPrice.toFixed(2),
      },
      stop_loss: {
        stop_price: input.stopLossPrice.toFixed(2),
      },
    }
    const raw = await this.request<Record<string, unknown>>('POST', '/v2/orders', body, 10_000)
    return this.toOrder(raw)
  }

  async getOrder(orderId: string): Promise<AlpacaOrder> {
    const raw = await this.request<Record<string, unknown>>('GET', `/v2/orders/${encodeURIComponent(orderId)}`)
    return this.toOrder(raw)
  }

  async getOrderByClientId(clientOrderId: string): Promise<AlpacaOrder | null> {
    try {
      const raw = await this.request<Record<string, unknown>>(
        'GET', `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`
      )
      return this.toOrder(raw)
    } catch (e) {
      // 404 = not found, which we want to treat as null (idempotency check passed)
      if (e instanceof Error && /HTTP 404/.test(e.message)) return null
      throw e
    }
  }

  /**
   * Closed orders since midnight (account's timezone, which Alpaca treats as ET).
   * Used by the position-update worker to find realized P&L.
   */
  async closedOrdersToday(): Promise<AlpacaOrder[]> {
    // Use today's midnight in ET. Alpaca accepts ISO timestamps; we send midnight UTC
    // as a safe lower bound that covers ET market hours.
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const after = today.toISOString()
    const raw = await this.request<Array<Record<string, unknown>>>(
      'GET',
      `/v2/orders?status=closed&after=${encodeURIComponent(after)}&limit=500&nested=true`,
    )
    return raw.map(o => this.toOrder(o))
  }

  private toOrder(raw: Record<string, unknown>): AlpacaOrder {
    const legs = Array.isArray(raw.legs) ? raw.legs as Array<Record<string, unknown>> : null
    return {
      id: String(raw.id ?? ''),
      client_order_id: String(raw.client_order_id ?? ''),
      symbol: String(raw.symbol ?? ''),
      qty: raw.qty !== undefined && raw.qty !== null ? Number(raw.qty) : null,
      filled_qty: Number(raw.filled_qty ?? 0),
      filled_avg_price: raw.filled_avg_price !== undefined && raw.filled_avg_price !== null
        ? Number(raw.filled_avg_price) : null,
      side: String(raw.side ?? 'buy') as 'buy' | 'sell',
      type: String(raw.type ?? ''),
      status: String(raw.status ?? ''),
      submitted_at: raw.submitted_at ? String(raw.submitted_at) : null,
      filled_at: raw.filled_at ? String(raw.filled_at) : null,
      cancelled_at: raw.canceled_at ? String(raw.canceled_at) : null,
      rejected_at: raw.replaced_at ? String(raw.replaced_at) : null,
      failed_at: raw.failed_at ? String(raw.failed_at) : null,
      legs: legs ? legs.map(l => this.toOrder(l)) : null,
    }
  }
}

/**
 * Factory: build an AlpacaClient from credentials we load via
 * loadBrokerCredentialForUse. Convenience wrapper around `new AlpacaClient(...)`.
 */
export function makeAlpacaClient(keyId: string, secret: string, mode: 'paper' | 'live'): AlpacaClient {
  return new AlpacaClient({ keyId, secret, mode })
}
