'use client'

// =============================================================
// app/components/TradingRulesCard.tsx
//
// Self-contained controls card for the auto-trader dashboard.
// Renders toggle switches for the user's own trading rules and
// PATCHes /api/auto-trader/settings on change, then asks the parent
// to refetch via onChanged().
//
// Scoped to safe booleans (master switch, shorts, asset filters).
// Mode (paper/live) and numeric risk limits are intentionally NOT
// here — those live on the broker-connect / admin paths.
// =============================================================

import { useState } from 'react'
import { Layers, TrendingDown, AlertTriangle } from 'lucide-react'

export interface TradingRules {
  enabled: boolean
  allowShorts: boolean
  tradeStocks: boolean
  tradeCrypto: boolean
  tradeForex: boolean
  tradeFutures: boolean
  tradeOptions?: boolean
  earningsFullSize?: boolean
  allowLowPriceShares?: boolean
  allowFractionalShares?: boolean
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50"
      style={{ background: on ? '#34d399' : 'rgba(156,163,175,0.35)' }}>
      <span
        className="inline-block h-4 w-4 rounded-full bg-white transition-transform"
        style={{ transform: on ? 'translateX(18px)' : 'translateX(2px)' }} />
    </button>
  )
}

export default function TradingRulesCard({
  rules, onChanged,
}: {
  rules: TradingRules
  onChanged: () => void
}) {
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function patch(field: keyof TradingRules, value: boolean) {
    setSaving(field)
    setError(null)
    try {
      const res = await fetch('/api/auto-trader/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error((j as { error?: string }).error ?? `Save failed (${res.status})`)
      }
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(null)
    }
  }

  const rows: Array<{ key: keyof TradingRules; label: string; hint?: string; on: boolean; accent?: boolean }> = [
    { key: 'enabled', label: 'Auto-trading', hint: 'Master switch — places trades from new verdicts', on: rules.enabled },
    { key: 'allowShorts', label: 'Allow short trades', hint: 'Enables BEARISH / short entries. Stocks only; symbol must be shortable at your broker.', on: rules.allowShorts, accent: true },
    { key: 'tradeStocks', label: 'Stocks', on: rules.tradeStocks },
    { key: 'tradeCrypto', label: 'Crypto', on: rules.tradeCrypto },
    { key: 'tradeForex', label: 'Forex', on: rules.tradeForex },
    { key: 'tradeFutures', label: 'Futures', on: rules.tradeFutures },
    { key: 'earningsFullSize', label: 'Trade through earnings', hint: 'Takes earnings-window setups at full size (vs. half). Managed by the day-monitor and flattened before the print — but stops do NOT protect against an overnight earnings gap. Required for the pre-earnings run-up tracker.', on: rules.earningsFullSize ?? false, accent: true },
    { key: 'allowLowPriceShares', label: 'Allow sub-$5 shares', hint: 'Drops the $3/share sizing floor to $0 so low-priced stocks become tradeable. For small accounts; Alpaca still won\u2019t trade true OTC/penny names.', on: rules.allowLowPriceShares ?? false, accent: true },
    { key: 'allowFractionalShares', label: 'Allow fractional shares', hint: 'When a setup sizes to less than one whole share, buy a fractional amount instead of skipping. Fractional orders can\u2019t use a broker bracket, so the stop/target are enforced by the position-monitor (hard close on a stop breach) rather than sitting at the broker. Best for small accounts and high-priced names.', on: rules.allowFractionalShares ?? false, accent: true },
  ]

  return (
    <div className="mb-4 p-4 rounded-xl"
      style={{ background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.18)' }}>
      <div className="flex items-center gap-2 mb-3">
        <Layers size={14} style={{ color: '#60a5fa' }} />
        <span className="text-sm font-bold" style={{ color: 'var(--text)' }}>Trading Rules</span>
      </div>

      <div className="grid gap-1.5">
        {rows.map(r => (
          <div key={r.key} className="flex items-center justify-between gap-3 py-1">
            <div className="min-w-0">
              <div className="text-xs font-semibold flex items-center gap-1.5" style={{ color: 'var(--text2)' }}>
                {r.accent && <TrendingDown size={12} style={{ color: r.on ? '#34d399' : '#9ca3af' }} />}
                <span>{r.label}</span>
                <span className="font-mono" style={{ color: r.on ? '#34d399' : '#9ca3af' }}>{r.on ? 'ON' : 'OFF'}</span>
              </div>
              {r.hint && (
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text3)' }}>{r.hint}</div>
              )}
            </div>
            <Toggle on={r.on} disabled={saving === r.key} onClick={() => { void patch(r.key, !r.on) }} />
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-3 text-[11px] flex items-center gap-1.5" style={{ color: '#f87171' }}>
          <AlertTriangle size={12} className="shrink-0" /> {error}
        </div>
      )}

      <div className="mt-3 text-[11px]" style={{ color: 'var(--text3)' }}>
        Changes apply on the next worker run. Turning a market off won&apos;t close existing positions — it only stops new entries.
      </div>
    </div>
  )
}
