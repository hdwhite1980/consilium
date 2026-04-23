'use client'

// ═════════════════════════════════════════════════════════════
// app/components/AddToWatchlistButton.tsx
//
// Reusable button that adds a STOCK or OPTION to the user's watchlist.
// Use on /today, /tomorrow, /analyze, /options pages.
//
// Usage:
//   // Stock:
//   <AddToWatchlistButton ticker="NVDA" source="movers" />
//
//   // Option:
//   <AddToWatchlistButton
//     ticker="NVDA"
//     source="analyze"
//     assetType="option"
//     optionSymbol="NVDA250517C00500000"
//     optionType="call"
//     strike={500}
//     expiration="2025-05-17"
//     premiumAtAdd={12.50}
//     deltaAtAdd={0.45}
//     ivAtAdd={0.42}
//   />
//
// State machine: idle → adding → added (2s) → idle
//                                       → error (3s) → idle
// ═════════════════════════════════════════════════════════════

import { useState, useCallback } from 'react'
import { Eye, Check, Plus, Zap } from 'lucide-react'

interface StockProps {
  ticker: string
  source?: 'analyze' | 'invest' | 'movers' | 'manual'
  size?: 'sm' | 'md'
  variant?: 'ghost' | 'filled'
  className?: string
  onAdded?: () => void
  assetType?: 'stock'
}

interface OptionProps {
  ticker: string                          // underlying
  source?: 'analyze' | 'invest' | 'movers' | 'manual'
  size?: 'sm' | 'md'
  variant?: 'ghost' | 'filled'
  className?: string
  onAdded?: () => void
  assetType: 'option'
  optionSymbol: string
  optionType: 'call' | 'put'
  strike: number
  expiration: string                      // YYYY-MM-DD
  premiumAtAdd?: number
  deltaAtAdd?: number
  ivAtAdd?: number
}

type Props = StockProps | OptionProps

export function AddToWatchlistButton(props: Props) {
  const {
    ticker,
    source = 'manual',
    size = 'sm',
    variant = 'ghost',
    className = '',
    onAdded,
  } = props

  const isOption = props.assetType === 'option'

  const [state, setState] = useState<'idle' | 'adding' | 'added' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (state === 'adding' || state === 'added') return

    setState('adding')
    setErrorMsg(null)

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = { ticker, source }
      if (isOption) {
        const o = props as OptionProps
        body.assetType = 'option'
        body.optionSymbol = o.optionSymbol
        body.optionType = o.optionType
        body.strike = o.strike
        body.expiration = o.expiration
        if (typeof o.premiumAtAdd === 'number') body.premiumAtAdd = o.premiumAtAdd
        if (typeof o.deltaAtAdd === 'number') body.deltaAtAdd = o.deltaAtAdd
        if (typeof o.ivAtAdd === 'number') body.ivAtAdd = o.ivAtAdd
      }

      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const resBody = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(resBody?.error ?? 'Failed')

      setState('added')
      onAdded?.()
      setTimeout(() => setState('idle'), 2000)
    } catch (err) {
      setErrorMsg((err as Error).message?.slice(0, 60) ?? 'Error')
      setState('error')
      setTimeout(() => { setState('idle'); setErrorMsg(null) }, 3000)
    }
  }, [ticker, source, state, onAdded, isOption, props])

  const padX = size === 'sm' ? 'px-2' : 'px-3'
  const padY = size === 'sm' ? 'py-1' : 'py-1.5'
  const textSize = size === 'sm' ? 'text-[10px]' : 'text-xs'
  const iconSize = size === 'sm' ? 10 : 11

  const baseStyle = variant === 'filled'
    ? { background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)' }
    : { background: 'transparent', color: '#a78bfa80', border: '1px solid rgba(167,139,250,0.2)' }

  const addedStyle = { background: 'rgba(52,211,153,0.15)', color: '#34d399', border: '1px solid rgba(52,211,153,0.3)' }
  const errorStyle = { background: 'rgba(248,113,113,0.12)', color: '#f87171', border: '1px solid rgba(248,113,113,0.25)' }

  const style = state === 'added' ? addedStyle : state === 'error' ? errorStyle : baseStyle

  const idleLabel = isOption ? 'Watch option' : 'Watch'
  const addedLabel = isOption ? 'Watching' : 'Added'
  const IdleIcon = isOption ? Zap : Plus

  const titleText = state === 'error'
    ? (errorMsg ?? 'Error')
    : isOption
      ? `Add ${ticker} ${(props as OptionProps).optionType.toUpperCase()} $${(props as OptionProps).strike} to watchlist`
      : `Add ${ticker} to watchlist`

  return (
    <button
      onClick={handleClick}
      disabled={state === 'adding' || state === 'added'}
      title={titleText}
      className={`inline-flex items-center gap-1 ${padX} ${padY} ${textSize} font-mono rounded transition-all hover:opacity-90 disabled:cursor-default ${className}`}
      style={style}>
      {state === 'idle' && (<>
        <IdleIcon size={iconSize} />
        <span>{idleLabel}</span>
      </>)}
      {state === 'adding' && (<>
        <span className="inline-block w-2 h-2 rounded-full thinking-dot"
          style={{ background: '#a78bfa' }} />
        <span>...</span>
      </>)}
      {state === 'added' && (<>
        <Check size={iconSize} />
        <span>{addedLabel}</span>
      </>)}
      {state === 'error' && (<>
        <Eye size={iconSize} />
        <span>{errorMsg ?? 'Error'}</span>
      </>)}
    </button>
  )
}
