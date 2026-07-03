// =============================================================
// app/lib/trading/oanda-client.ts
//
// OANDA v3 REST API client. Used by the forex auto-trader.
//
// OANDA API model:
//   - Single account per token (accountId in URL path)
//   - Instruments named "USD_CAD", "EUR_USD" (underscore)
//   - Position sizes in UNITS, not lots. Positive = long, negative = short.
//   - "instruments/{instrument}/candles" for prices
//   - "accounts/{accountId}/orders" for orders
//   - "accounts/{accountId}/positions/{instrument}" for positions
//   - Orders are placed via JSON body wrapped in { order: { ... } }
//
// We support market orders with attached TAKE_PROFIT_ON_FILL and
// STOP_LOSS_ON_FILL clauses (OANDA's native bracket equivalent).
// =============================================================

import type { Bar } from '@/app/lib/signals/technicals'

const OANDA_PRACTICE_BASE = 'https://api-fxpractice.oanda.com'
const OANDA_LIVE_BASE     = 'https://api-fxtrade.oanda.com'

export interface OandaClientConfig {
  accountId: string
  accessToken: string
  mode: 'paper' | 'live'
}

export interface OandaAccountSummary {
  id: string
  currency: string
  balance: number
  equity: number              // OANDA NAV (balance + unrealizedPL)
  unrealizedPL: number
  marginAvailable: number
  marginUsed: number
  openTradeCount: number
  openPositionCount: number
}

export interface OandaPosition {
  instrument: string          // e.g. "USD_CAD"
  longUnits: number
  shortUnits: number
  unrealizedPL: number
  avgPrice: number | null     // entry price of currently open units
  side: 'long' | 'short' | 'flat'
  netUnits: number            // longUnits - shortUnits (signed)
}

export interface OandaInstrument {
  name: string                // e.g. "USD_CAD"
  type: string                // "CURRENCY"
  displayPrecision: number
  pipLocation: number         // -4 for most pairs (1 pip = 0.0001), -2 for JPY pairs
  tradeUnitsPrecision: number
  minimumTradeSize: string
}

export interface OandaPriceQuote {
  instrument: string
  bid: number
  ask: number
  mid: number
  time: string
}

export interface OandaOrderResult {
  orderCreateTransaction?: { id?: string; clientOrderId?: string }
  orderFillTransaction?: {
    id?: string
    units?: string
    price?: string
    pl?: string
    tradeOpened?: { tradeID?: string; units?: string; price?: string }
  }
  orderCancelTransaction?: { reason?: string }
  lastTransactionID?: string
  errorMessage?: string
  errorCode?: string
}

export interface MarketOrderInput {
  instrument: string          // canonical "USD_CAD"
  units: number               // positive=long, negative=short
  takeProfitPrice: number
  stopLossPrice: number
  clientOrderId: string       // we generate
}

export interface OandaTrade {
  tradeId: string
  instrument: string
  currentUnits: number          // signed: + long, - short
  side: 'long' | 'short'
  entryPrice: number | null
  unrealizedPL: number
  stopLossOrderId: string | null
  stopLossPrice: number | null
  takeProfitPrice: number | null
}

export class OandaClient {
  private baseUrl: string
  private headers: Record<string, string>
  private accountId: string

  constructor(config: OandaClientConfig) {
    this.baseUrl = config.mode === 'paper' ? OANDA_PRACTICE_BASE : OANDA_LIVE_BASE
    this.accountId = config.accountId
    this.headers = {
      'Authorization': `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
      'Accept-Datetime-Format': 'RFC3339',
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
          const j = JSON.parse(text) as { errorMessage?: string; errorCode?: string; message?: string }
          if (j.errorMessage) detail += `: ${j.errorMessage}`
          else if (j.message) detail += `: ${j.message}`
          if (j.errorCode) detail += ` (${j.errorCode})`
        } catch { if (text) detail += `: ${text.slice(0, 200)}` }
        throw new Error(detail)
      }
      return (text ? JSON.parse(text) : {}) as T
    } finally { clearTimeout(timer) }
  }

  async accountSummary(): Promise<OandaAccountSummary> {
    const raw = await this.request<{ account?: Record<string, unknown> }>(
      'GET', `/v3/accounts/${encodeURIComponent(this.accountId)}/summary`
    )
    const a = raw.account ?? {}
    const balance = Number(a.balance ?? 0)
    const unrealizedPL = Number(a.unrealizedPL ?? 0)
    return {
      id: String(a.id ?? this.accountId),
      currency: String(a.currency ?? 'USD'),
      balance,
      equity: balance + unrealizedPL,  // OANDA's NAV
      unrealizedPL,
      marginAvailable: Number(a.marginAvailable ?? 0),
      marginUsed: Number(a.marginUsed ?? 0),
      openTradeCount: Number(a.openTradeCount ?? 0),
      openPositionCount: Number(a.openPositionCount ?? 0),
    }
  }

  async positions(): Promise<OandaPosition[]> {
    const raw = await this.request<{ positions?: Array<Record<string, unknown>> }>(
      'GET', `/v3/accounts/${encodeURIComponent(this.accountId)}/openPositions`
    )
    const positions = raw.positions ?? []
    return positions.map(p => {
      const long = p.long as Record<string, unknown> | undefined
      const short = p.short as Record<string, unknown> | undefined
      const longUnits = long ? Number(long.units ?? 0) : 0
      const shortUnits = short ? Math.abs(Number(short.units ?? 0)) : 0
      const longAvg = long?.averagePrice !== undefined ? Number(long.averagePrice) : null
      const shortAvg = short?.averagePrice !== undefined ? Number(short.averagePrice) : null
      const netUnits = longUnits - shortUnits
      const side: 'long' | 'short' | 'flat' = netUnits > 0 ? 'long' : netUnits < 0 ? 'short' : 'flat'
      return {
        instrument: String(p.instrument ?? ''),
        longUnits, shortUnits,
        unrealizedPL: Number(p.unrealizedPL ?? 0),
        avgPrice: side === 'long' ? longAvg : side === 'short' ? shortAvg : null,
        side,
        netUnits,
      }
    })
  }

  async instrument(name: string): Promise<OandaInstrument | null> {
    try {
      const raw = await this.request<{ instruments?: Array<Record<string, unknown>> }>(
        'GET', `/v3/accounts/${encodeURIComponent(this.accountId)}/instruments?instruments=${encodeURIComponent(name)}`
      )
      const inst = raw.instruments?.[0]
      if (!inst) return null
      return {
        name: String(inst.name ?? name),
        type: String(inst.type ?? 'CURRENCY'),
        displayPrecision: Number(inst.displayPrecision ?? 5),
        pipLocation: Number(inst.pipLocation ?? -4),
        tradeUnitsPrecision: Number(inst.tradeUnitsPrecision ?? 0),
        minimumTradeSize: String(inst.minimumTradeSize ?? '1'),
      }
    } catch {
      return null
    }
  }

  async priceQuote(instrument: string): Promise<OandaPriceQuote | null> {
    try {
      const raw = await this.request<{ prices?: Array<Record<string, unknown>> }>(
        'GET', `/v3/accounts/${encodeURIComponent(this.accountId)}/pricing?instruments=${encodeURIComponent(instrument)}`
      )
      const p = raw.prices?.[0]
      if (!p) return null
      // OANDA returns bids/asks as arrays — take the first (top of book)
      const bids = p.bids as Array<{ price?: string }> | undefined
      const asks = p.asks as Array<{ price?: string }> | undefined
      const bid = bids?.[0]?.price !== undefined ? Number(bids[0].price) : 0
      const ask = asks?.[0]?.price !== undefined ? Number(asks[0].price) : 0
      return {
        instrument: String(p.instrument ?? instrument),
        bid, ask, mid: (bid + ask) / 2,
        time: String(p.time ?? new Date().toISOString()),
      }
    } catch {
      return null
    }
  }

  /**
   * Place market order with attached TP and SL.
   * `units` is signed: positive = long (buy base), negative = short (sell base).
   */
  private precisionCache = new Map<string, number>()

  /** Per-instrument display precision for TP/SL price formatting. JPY pairs
   *  use 3 decimals — the old hardcoded .toFixed(5) produced prices OANDA
   *  rejects with PRICE_PRECISION_EXCEEDED, failing the whole order. */
  private async pricePrecision(instrument: string): Promise<number> {
    const cached = this.precisionCache.get(instrument)
    if (cached !== undefined) return cached
    try {
      const inst = await this.instrument(instrument)
      const p = inst?.displayPrecision ?? 5
      this.precisionCache.set(instrument, p)
      return p
    } catch { return 5 }
  }

  async marketOrder(input: MarketOrderInput): Promise<OandaOrderResult> {
    const prec = await this.pricePrecision(input.instrument)
    const body = {
      order: {
        type: 'MARKET',
        instrument: input.instrument,
        units: String(Math.trunc(input.units)),  // OANDA requires integer units
        timeInForce: 'FOK',                       // fill-or-kill
        positionFill: 'DEFAULT',
        clientExtensions: {
          id: input.clientOrderId,
          tag: 'wali-os',
        },
        takeProfitOnFill: {
          timeInForce: 'GTC',
          price: input.takeProfitPrice.toFixed(prec),
        },
        stopLossOnFill: {
          timeInForce: 'GTC',
          price: input.stopLossPrice.toFixed(prec),
        },
      },
    }
    return await this.request<OandaOrderResult>(
      'POST', `/v3/accounts/${encodeURIComponent(this.accountId)}/orders`, body, 15_000,
    )
  }

  /**
   * Close an instrument's position. units='ALL' closes long (or short) entirely.
   */
  async closePosition(instrument: string, side: 'long' | 'short'): Promise<unknown> {
    const body = side === 'long'
      ? { longUnits: 'ALL' }
      : { shortUnits: 'ALL' }
    return await this.request(
      'PUT', `/v3/accounts/${encodeURIComponent(this.accountId)}/positions/${encodeURIComponent(instrument)}/close`, body,
    )
  }

  // ── Monitor support: candles for signals, open-trade lookup, stop trailing ──

  /** Mid-price candles, oldest-first, mapped to the shared Bar shape so the
   *  same technical-signal engine the other monitors use can consume them.
   *  granularity: OANDA codes — 'M5', 'M15', 'H1', etc. */
  async candles(instrument: string, granularity: string, count = 100): Promise<Bar[]> {
    const raw = await this.request<{
      candles?: Array<{ time?: string; volume?: number; complete?: boolean; mid?: { o?: string; h?: string; l?: string; c?: string } }>
    }>(
      'GET',
      `/v3/instruments/${encodeURIComponent(instrument)}/candles?price=M&granularity=${encodeURIComponent(granularity)}&count=${count}`,
    )
    const out: Bar[] = []
    for (const c of raw.candles ?? []) {
      if (c.complete === false) continue          // skip the still-forming candle
      const m = c.mid
      if (!m) continue
      const o = Number(m.o), h = Number(m.h), l = Number(m.l), cl = Number(m.c)
      if (![o, h, l, cl].every(v => Number.isFinite(v))) continue
      out.push({ t: String(c.time ?? ''), o, h, l, c: cl, v: Number(c.volume ?? 0) })
    }
    return out
  }

  /** Open trades with their attached stop-loss order — needed to trail. */
  /**
   * Recently CLOSED trades for an instrument — carries OANDA's authoritative
   * realizedPL and averageClosePrice. Used by the monitor's reconcile path so
   * a TP-hit win is recorded as a WIN at the real close price (previously the
   * exit was guessed as the STOP price, mislabeling every take-profit win as
   * a loss).
   */
  async closedTrades(instrument: string, count = 10): Promise<Array<{
    id: string; instrument: string; initialUnits: number
    realizedPL: number | null; averageClosePrice: number | null
    openTime: string | null; closeTime: string | null
  }>> {
    const raw = await this.request<{ trades?: Array<Record<string, unknown>> }>(
      'GET',
      `/v3/accounts/${encodeURIComponent(this.accountId)}/trades?instrument=${encodeURIComponent(instrument)}&state=CLOSED&count=${count}`,
    )
    return (raw.trades ?? []).map(t => ({
      id: String(t.id ?? ''),
      instrument: String(t.instrument ?? ''),
      initialUnits: Number(t.initialUnits ?? 0),
      realizedPL: t.realizedPL != null ? Number(t.realizedPL) : null,
      averageClosePrice: t.averageClosePrice != null ? Number(t.averageClosePrice) : null,
      openTime: t.openTime != null ? String(t.openTime) : null,
      closeTime: t.closeTime != null ? String(t.closeTime) : null,
    }))
  }

  async openTrades(): Promise<OandaTrade[]> {
    const raw = await this.request<{ trades?: Array<Record<string, unknown>> }>(
      'GET', `/v3/accounts/${encodeURIComponent(this.accountId)}/openTrades`,
    )
    return (raw.trades ?? []).map(t => {
      const sl = t.stopLossOrder as Record<string, unknown> | undefined
      const tp = t.takeProfitOrder as Record<string, unknown> | undefined
      const units = Number(t.currentUnits ?? 0)
      return {
        tradeId: String(t.id ?? ''),
        instrument: String(t.instrument ?? ''),
        currentUnits: units,
        side: units >= 0 ? 'long' : 'short',
        entryPrice: t.price !== undefined ? Number(t.price) : null,
        unrealizedPL: Number(t.unrealizedPL ?? 0),
        stopLossOrderId: sl?.id !== undefined ? String(sl.id) : null,
        stopLossPrice: sl?.price !== undefined ? Number(sl.price) : null,
        takeProfitPrice: tp?.price !== undefined ? Number(tp.price) : null,
      } as OandaTrade
    })
  }

  /** Replace a trade's stop-loss in place (OANDA cancels the old SL and arms a
   *  new one atomically). This is the trailing action. */
  async setTradeStopLoss(tradeId: string, instrument: string, price: number): Promise<{ ok: boolean; stopOrderId?: string; reason?: string }> {
    try {
      const res = await this.request<{ stopLossOrderTransaction?: { id?: string } }>(
        'PUT', `/v3/accounts/${encodeURIComponent(this.accountId)}/trades/${encodeURIComponent(tradeId)}/orders`,
        { stopLoss: { price: this.fmtPrice(instrument, price), timeInForce: 'GTC' } },
      )
      return { ok: true, stopOrderId: res.stopLossOrderTransaction?.id }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : 'unknown' }
    }
  }

  /** OANDA rejects stop prices that don't match the instrument's price
   *  precision: JPY pairs are quoted to 3 decimals, everything else to 5. */
  private fmtPrice(instrument: string, price: number): string {
    return price.toFixed(instrument.toUpperCase().includes('JPY') ? 3 : 5)
  }
}

export function makeOandaClient(accountId: string, accessToken: string, mode: 'paper' | 'live'): OandaClient {
  return new OandaClient({ accountId, accessToken, mode })
}

/**
 * Pip value for 1 unit. For most pairs pipLocation=-4 means 1 pip = 0.0001.
 * For JPY pairs pipLocation=-2 means 1 pip = 0.01.
 *
 * Pip value in QUOTE currency for 1 unit:
 *   = 10 ^ pipLocation
 *
 * For sizing we need pip value in ACCOUNT currency, which requires
 * converting the quote currency. For now we approximate using the
 * quote price (caller should use the helper in forex-sizing.ts).
 */
export function pipSize(pipLocation: number): number {
  return Math.pow(10, pipLocation)
}
