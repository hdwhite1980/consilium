// app/components/portfolio/CloseModal.tsx
//
// Modal for closing a position (full or partial).
// Auto-fills exit price from current market price.
// Optional AI postmortem with skip button.
//
// This is a standalone component — drops into app/components/portfolio/
// and gets rendered from the portfolio page.

'use client'

import { useState, useEffect, useMemo } from 'react'
import { X, AlertCircle } from 'lucide-react'

// ─────────────────────────────────────────────────────────────
// Types — matches the shape of portfolio_positions and the API
// ─────────────────────────────────────────────────────────────

export interface ClosablePosition {
  id: string
  ticker: string
  position_type: 'stock' | 'option' | null
  option_type: 'call' | 'put' | null
  strike: number | null
  expiry: string | null
  contracts: number | null
  entry_premium: number | null
  underlying: string | null
  shares: number
  avg_cost: number | null
  // Live data for autofill
  currentPrice?: number | null
  currentPremium?: number | null
}

export interface CloseResult {
  close_event: {
    id: string
    quantity_closed: number
    exit_price: number
    realized_pnl: number
    realized_pnl_pct: number | null
    close_type: 'full' | 'partial' | 'scale_out_step'
  }
  position: ClosablePosition & { status: 'open' | 'partial' | 'closed' }
  postmortem: Record<string, unknown> | null
}

interface CloseModalProps {
  position: ClosablePosition
  onClose: () => void
  onSuccess: (result: CloseResult) => void
}

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────

export function CloseModal({ position, onClose, onSuccess }: CloseModalProps) {
  const isOption = position.position_type === 'option'
  const totalQuantity = isOption ? (position.contracts ?? 1) : position.shares
  const entryPrice = isOption ? (position.entry_premium ?? 0) : (position.avg_cost ?? 0)
  const autofillExit = isOption
    ? (position.currentPremium ?? position.entry_premium ?? 0)
    : (position.currentPrice ?? position.avg_cost ?? 0)

  // ── State
  const [exitPriceStr, setExitPriceStr] = useState(autofillExit > 0 ? autofillExit.toFixed(2) : '')
  const [closeMode, setCloseMode] = useState<'full' | 'partial'>('full')
  const [partialQty, setPartialQty] = useState(totalQuantity.toString())
  const [closedReason, setClosedReason] = useState<'manual' | 'target_hit' | 'stop_hit' | 'expired' | 'assigned' | 'exercised'>('manual')
  const [generatePostmortem, setGeneratePostmortem] = useState(true)
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Re-autofill if currentPrice arrives after modal opened
  useEffect(() => {
    if (autofillExit > 0 && exitPriceStr === '') {
      setExitPriceStr(autofillExit.toFixed(2))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autofillExit])

  // ── Derived values
  const exitPrice = parseFloat(exitPriceStr)
  const validExit = !isNaN(exitPrice) && exitPrice > 0
  const partialQtyNum = parseFloat(partialQty)
  const validPartial = !isNaN(partialQtyNum) && partialQtyNum > 0 && partialQtyNum <= totalQuantity

  const closeQty = closeMode === 'full' ? totalQuantity : (validPartial ? partialQtyNum : 0)
  const isValid = validExit && (closeMode === 'full' || validPartial)

  // P&L preview
  const preview = useMemo(() => {
    if (!validExit || closeQty <= 0 || entryPrice <= 0) return null
    const multiplier = isOption ? 100 : 1
    const pnlDollar = (exitPrice - entryPrice) * closeQty * multiplier
    const costBasis = entryPrice * closeQty * multiplier
    const pnlPct = costBasis > 0 ? (pnlDollar / costBasis) * 100 : 0
    return { pnlDollar, pnlPct, costBasis }
  }, [validExit, closeQty, entryPrice, exitPrice, isOption])

  const isWin = preview && preview.pnlDollar > 0

  // ── Submit
  const submit = async () => {
    if (!isValid) return
    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch('/api/portfolio/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          position_id: position.id,
          exit_price: exitPrice,
          quantity: closeMode === 'full' ? undefined : partialQtyNum,
          closed_reason: closedReason,
          generate_postmortem: generatePostmortem,
          notes: notes.trim() || undefined,
        }),
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Close failed')
        setSubmitting(false)
        return
      }

      onSuccess(data as CloseResult)
    } catch (e) {
      setError((e as Error).message ?? 'Network error')
      setSubmitting(false)
    }
  }

  // ─────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl shadow-2xl"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <div>
            <span className="font-semibold text-sm" style={{ color: 'var(--text)' }}>
              Close {position.ticker}
            </span>
            {isOption && position.option_type && (
              <span
                className="ml-2 text-[10px] font-mono px-1.5 py-0.5 rounded"
                style={{
                  background: position.option_type === 'call' ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)',
                  color: position.option_type === 'call' ? '#34d399' : '#f87171',
                }}
              >
                {position.option_type.toUpperCase()} ${position.strike}
              </span>
            )}
          </div>
          <button onClick={onClose} style={{ color: 'var(--text3)' }} aria-label="Close modal">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Position summary */}
          <div className="text-xs" style={{ color: 'var(--text2)' }}>
            {isOption ? (
              <>
                Holding: <span className="font-mono">{totalQuantity} contract{totalQuantity === 1 ? '' : 's'}</span>
                {' '}@ <span className="font-mono">${entryPrice.toFixed(2)}/share</span>
              </>
            ) : (
              <>
                Holding: <span className="font-mono">{totalQuantity} shares</span>
                {' '}@ <span className="font-mono">${entryPrice.toFixed(2)}</span>
              </>
            )}
          </div>

          {/* Close mode toggle */}
          <div
            className="flex rounded-lg overflow-hidden border"
            style={{ borderColor: 'var(--border)' }}
          >
            {(['full', 'partial'] as const).map(m => (
              <button
                key={m}
                onClick={() => setCloseMode(m)}
                className="flex-1 px-3 py-2 text-xs font-semibold transition-all"
                style={{
                  background: closeMode === m ? 'rgba(167,139,250,0.15)' : 'transparent',
                  color: closeMode === m ? '#a78bfa' : 'var(--text3)',
                }}
              >
                {m === 'full' ? 'Full close' : 'Partial close'}
              </button>
            ))}
          </div>

          {/* Partial quantity input */}
          {closeMode === 'partial' && (
            <div>
              <label className="block text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text3)' }}>
                {isOption ? 'Contracts to close' : 'Shares to close'}
              </label>
              <input
                type="number"
                value={partialQty}
                onChange={e => setPartialQty(e.target.value)}
                min={isOption ? '1' : '0.001'}
                step={isOption ? '1' : '0.001'}
                max={totalQuantity}
                className="w-full h-9 px-3 rounded-lg text-sm font-mono"
                style={{
                  background: 'var(--surface2)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                }}
              />
              {!validPartial && partialQty !== '' && (
                <div className="text-[10px] mt-1" style={{ color: '#f87171' }}>
                  Must be between 0 and {totalQuantity}
                </div>
              )}
            </div>
          )}

          {/* Exit price */}
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text3)' }}>
              {isOption ? 'Exit premium / share' : 'Exit price'}
              {autofillExit > 0 && (
                <span className="ml-2 normal-case font-sans" style={{ color: 'var(--text3)' }}>
                  (autofilled from current price)
                </span>
              )}
            </label>
            <input
              type="number"
              value={exitPriceStr}
              onChange={e => setExitPriceStr(e.target.value)}
              placeholder="0.00"
              min="0.01"
              step="0.01"
              autoFocus
              className="w-full h-10 px-3 rounded-lg text-sm font-mono font-bold"
              style={{
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                color: 'var(--text)',
              }}
            />
          </div>

          {/* Close reason */}
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text3)' }}>
              Reason
            </label>
            <select
              value={closedReason}
              onChange={e => setClosedReason(e.target.value as typeof closedReason)}
              className="w-full h-9 px-3 rounded-lg text-sm"
              style={{
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                color: 'var(--text)',
              }}
            >
              <option value="manual">Manual close</option>
              <option value="target_hit">Target hit</option>
              <option value="stop_hit">Stop hit</option>
              <option value="expired">Expired (option)</option>
              <option value="assigned">Assigned (option)</option>
              <option value="exercised">Exercised (option)</option>
            </select>
          </div>

          {/* P&L preview */}
          {preview && (
            <div
              className="px-3 py-3 rounded-lg text-center"
              style={{
                background: isWin ? 'rgba(52,211,153,0.1)' : preview.pnlDollar < 0 ? 'rgba(248,113,113,0.1)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${isWin ? 'rgba(52,211,153,0.3)' : preview.pnlDollar < 0 ? 'rgba(248,113,113,0.3)' : 'rgba(255,255,255,0.1)'}`,
              }}
            >
              <div className="text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>
                Realized P&L
              </div>
              <div
                className="text-2xl font-bold font-mono tabular-nums"
                style={{ color: isWin ? '#34d399' : preview.pnlDollar < 0 ? '#f87171' : 'var(--text2)' }}
              >
                {preview.pnlDollar >= 0 ? '+' : ''}${Math.abs(preview.pnlDollar).toFixed(2)}
              </div>
              <div
                className="text-xs font-mono mt-0.5"
                style={{ color: isWin ? '#34d399' : preview.pnlDollar < 0 ? '#f87171' : 'var(--text2)' }}
              >
                {preview.pnlPct >= 0 ? '+' : ''}{preview.pnlPct.toFixed(2)}%
                {' · '}
                cost basis ${preview.costBasis.toFixed(2)}
              </div>
            </div>
          )}

          {/* Postmortem toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={generatePostmortem}
              onChange={e => setGeneratePostmortem(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-xs" style={{ color: 'var(--text2)' }}>
              Generate AI postmortem (recommended for review)
            </span>
          </label>

          {/* Notes */}
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text3)' }}>
              Notes (optional)
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Why did you close? What did you learn?"
              rows={2}
              className="w-full px-3 py-2 rounded-lg text-sm"
              style={{
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                color: 'var(--text)',
              }}
            />
          </div>

          {/* Error */}
          {error && (
            <div
              className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
              style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.3)' }}
            >
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 pb-5">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-1.5 rounded-lg text-sm"
            style={{
              color: 'var(--text2)',
              background: 'var(--surface2)',
              border: '1px solid var(--border)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!isValid || submitting}
            className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white disabled:opacity-40"
            style={{
              background: isWin
                ? 'linear-gradient(135deg, #10b981, #059669)'
                : preview && preview.pnlDollar < 0
                ? 'linear-gradient(135deg, #dc2626, #991b1b)'
                : 'linear-gradient(135deg, #7c3aed, #4f46e5)',
            }}
          >
            {submitting
              ? 'Closing…'
              : closeMode === 'full'
              ? 'Close position'
              : `Close ${closeQty} ${isOption ? 'contract' + (closeQty === 1 ? '' : 's') : 'share' + (closeQty === 1 ? '' : 's')}`}
          </button>
        </div>
      </div>
    </div>
  )
}
