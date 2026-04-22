'use client'

// ═════════════════════════════════════════════════════════════
// app/components/AddToWatchlistButton.tsx
//
// Reusable button for /today, /tomorrow, /analyze, /options pages.
// Adds a ticker to the user's watchlist with a given source label.
//
// States:
//   - idle: "+ Watch"
//   - adding: spinner
//   - added: checkmark (for 2 seconds, then reverts)
//   - error: brief error message
//
// Doesn't show "already on watchlist" — upsert is idempotent so
// clicking on a ticker already in watchlist just refreshes the
// verdict metadata silently.
// ═════════════════════════════════════════════════════════════

import { useState, useCallback } from 'react'
import { Eye, Check, Plus } from 'lucide-react'

interface Props {
  ticker: string
  source?: 'analyze' | 'invest' | 'movers' | 'manual'
  size?: 'sm' | 'md'
  variant?: 'ghost' | 'filled'
  className?: string
  onAdded?: () => void
}

export function AddToWatchlistButton({
  ticker,
  source = 'manual',
  size = 'sm',
  variant = 'ghost',
  className = '',
  onAdded,
}: Props) {
  const [state, setState] = useState<'idle' | 'adding' | 'added' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (state === 'adding' || state === 'added') return

    setState('adding')
    setErrorMsg(null)

    try {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, source }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(body?.error ?? 'Failed')
      }
      setState('added')
      onAdded?.()
      setTimeout(() => setState('idle'), 2000)
    } catch (err) {
      setErrorMsg((err as Error).message?.slice(0, 60) ?? 'Error')
      setState('error')
      setTimeout(() => { setState('idle'); setErrorMsg(null) }, 3000)
    }
  }, [ticker, source, state, onAdded])

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

  return (
    <button
      onClick={handleClick}
      disabled={state === 'adding' || state === 'added'}
      title={state === 'error' ? errorMsg ?? 'Error' : `Add ${ticker} to watchlist`}
      className={`inline-flex items-center gap-1 ${padX} ${padY} ${textSize} font-mono rounded transition-all hover:opacity-90 disabled:cursor-default ${className}`}
      style={style}>
      {state === 'idle' && (<>
        <Plus size={iconSize} />
        <span>Watch</span>
      </>)}
      {state === 'adding' && (<>
        <span className="inline-block w-2 h-2 rounded-full thinking-dot"
          style={{ background: '#a78bfa' }} />
        <span>...</span>
      </>)}
      {state === 'added' && (<>
        <Check size={iconSize} />
        <span>Added</span>
      </>)}
      {state === 'error' && (<>
        <Eye size={iconSize} />
        <span>{errorMsg ?? 'Error'}</span>
      </>)}
    </button>
  )
}
