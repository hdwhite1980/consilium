// =============================================================
// app/lib/trading/day-shark-lane.ts
//
// Single source of truth for Max's per-asset price + close path, shared by
// the chat action endpoints (max-action, max-reeval). Mirrors the logic in
// day-shark-monitor's setupMonLane; the monitor keeps its own inline copy to
// stay untouched, but all NEW code uses this so the broker path lives in one place.
// =============================================================

import { selectCryptoBroker } from './crypto-broker'
import { makeAlpacaClient } from './alpaca-client'
import { makeOandaClient } from './oanda-client'
import { loadBrokerCredentialForUse } from './credentials'
import type { CoinbaseClient } from './coinbase-client'
import type { AlpacaCryptoClient } from './alpaca-crypto-client'
import type { UserTradingSettings } from './settings'
import type { SharkAsset } from './day-shark'

export interface SharkLane {
  price: (ticker: string) => Promise<number | null>
  close: (ticker: string, side: 'buy' | 'sell') => Promise<void>
}

export async function setupSharkLane(
  settings: UserTradingSettings,
  asset: SharkAsset,
): Promise<SharkLane | { error: string }> {
  if (asset === 'crypto') {
    const broker = await selectCryptoBroker(settings)
    if (!broker) return { error: 'no crypto broker' }
    return {
      price: async (ticker) => {
        if (broker.kind === 'coinbase') return await (broker.client as CoinbaseClient).getSpotPrice(ticker).catch(() => null)
        try {
          const ps = await (broker.client as AlpacaCryptoClient).positions()
          return ps.find(x => x.symbol === ticker)?.current_price ?? null
        } catch { return null }
      },
      close: async (ticker) => {
        if (broker.kind === 'coinbase') await (broker.client as CoinbaseClient).closePosition(ticker)
        else await (broker.client as AlpacaCryptoClient).closePosition(ticker)
      },
    }
  }

  if (asset === 'stock') {
    const cred = await loadBrokerCredentialForUse(settings.userId, 'alpaca', settings.mode, 'stock')
    if (!cred) return { error: 'no alpaca stock broker' }
    const alpaca = makeAlpacaClient(cred.keyId, cred.secret, settings.mode)
    const clock = await alpaca.getClock()
    if (!clock.isOpen) return { error: 'market closed \u2014 can\u2019t price or flatten stocks until the open' }
    return {
      price: async (ticker) => {
        try {
          const ps = await alpaca.positions()
          return ps.find(p => p.symbol === ticker)?.current_price ?? null
        } catch { return null }
      },
      close: async (ticker) => { await alpaca.closePositionSafe(ticker) },
    }
  }

  // forex
  const cred = await loadBrokerCredentialForUse(settings.userId, 'oanda', settings.mode, 'forex')
  if (!cred) return { error: 'no oanda broker' }
  const oanda = makeOandaClient(cred.keyId, cred.secret, settings.mode)
  return {
    price: async (instrument) => {
      const q = await oanda.priceQuote(instrument).catch(() => null)
      return q?.mid ?? null
    },
    close: async (instrument, side) => { await oanda.closePosition(instrument, side === 'sell' ? 'short' : 'long') },
  }
}
