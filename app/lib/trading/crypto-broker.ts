// =============================================================
// app/lib/trading/crypto-broker.ts
//
// Crypto broker selection, extracted verbatim from auto-trade-crypto so both the
// slow crypto lane AND the day_shark (Max) executor can place through the same
// tested abstraction. Behavior is identical to the in-route version it replaced.
//
// Selection per user:
//   1. Coinbase credential present → Coinbase (live only; no paper env)
//   2. else Alpaca crypto credential → Alpaca (honors settings.mode)
//   3. else → null (no crypto broker)
// =============================================================

import type { UserTradingSettings } from './settings'
import { loadBrokerCredentialForUse, loadCoinbaseCredential } from './credentials'
import { makeAlpacaCryptoClient, type AlpacaCryptoClient, type AlpacaCryptoPosition } from './alpaca-crypto-client'
import { makeCoinbaseClient, type CoinbaseClient } from './coinbase-client'

export type BrokerKind = 'alpaca' | 'coinbase'

export interface CryptoBrokerHandle {
  kind: BrokerKind
  brokerName: 'alpaca' | 'coinbase'
  effectiveMode: 'paper' | 'live'
  symbolFor(canonicalSymbol: string): string
  client: AlpacaCryptoClient | CoinbaseClient
  account: () => Promise<{ status: string; cash: number; equity: number }>
  positions: () => Promise<Array<{ symbol: string; qty: number }>>
  assetTradable: (sym: string) => Promise<{ tradable: boolean; reason?: string }>
  marketEntry: (input: { symbol: string; notionalUsd: number; side: 'buy'; clientOrderId: string }) => Promise<{ id: string; client_order_id: string }>
}

/**
 * Select the crypto broker for a user. Coinbase takes precedence if configured
 * (explicit opt-in to live crypto); Alpaca crypto is the legacy default. Returns
 * null if no crypto broker is configured.
 *
 * Coinbase has no paper environment — if settings.mode is 'paper' but the user
 * is on Coinbase, trades are LIVE and trade_attempts.mode is set to 'live'.
 */
export async function selectCryptoBroker(settings: UserTradingSettings): Promise<CryptoBrokerHandle | null> {
  const coinbase = await loadCoinbaseCredential(settings.userId)
  if (coinbase) {
    const client = makeCoinbaseClient(coinbase.keyName, coinbase.privateKey)
    return {
      kind: 'coinbase',
      brokerName: 'coinbase',
      effectiveMode: 'live',  // Coinbase is always live
      symbolFor: (canonical: string) => canonical.replace('/', '-'),  // BTC/USD → BTC-USD
      client,
      account: async () => {
        const a = await client.account()
        return { status: a.status, cash: a.cash, equity: a.equity }
      },
      positions: async () => {
        const pos = await client.positions()
        return pos.map(p => ({ symbol: p.symbol, qty: p.qty }))
      },
      assetTradable: (sym: string) => client.assetTradable(sym),
      marketEntry: async (input) => {
        const order = await client.marketEntry({
          symbol: input.symbol,
          notionalUsd: input.notionalUsd,
          side: 'buy',
          clientOrderId: input.clientOrderId,
        })
        return { id: order.id, client_order_id: order.client_order_id }
      },
    }
  }

  const alpacaCred = await loadBrokerCredentialForUse(settings.userId, 'alpaca', settings.mode, 'crypto')
  if (alpacaCred) {
    const client = makeAlpacaCryptoClient(alpacaCred.keyId, alpacaCred.secret, settings.mode)
    return {
      kind: 'alpaca',
      brokerName: 'alpaca',
      effectiveMode: settings.mode,
      symbolFor: (canonical: string) => canonical,  // BTC/USD stays BTC/USD on Alpaca
      client,
      account: async () => {
        const a = await client.account()
        return { status: a.status, cash: a.cash, equity: a.equity }
      },
      positions: async () => {
        const pos = await client.positions()
        return pos.map((p: AlpacaCryptoPosition) => ({ symbol: p.symbol, qty: p.qty }))
      },
      assetTradable: (sym: string) => client.assetTradable(sym),
      marketEntry: async (input) => {
        const order = await client.marketEntry({
          symbol: input.symbol,
          notionalUsd: input.notionalUsd,
          side: 'buy',
          clientOrderId: input.clientOrderId,
        })
        return { id: order.id, client_order_id: order.client_order_id }
      },
    }
  }

  return null
}
