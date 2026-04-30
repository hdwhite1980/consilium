// ═════════════════════════════════════════════════════════════
// app/components/DefinedTerm.tsx
//
// Renders a small "?" icon that, when clicked, shows a plain-English
// definition of the trading term inline.
//
// Usage (inline next to a label):
//   <label>
//     Stop-loss *
//     <DefinedTerm term="stop" />
//   </label>
//
// Styles are defined globally in FloorStyles (in app/invest/page.tsx).
// ═════════════════════════════════════════════════════════════

'use client'

import { useState, useRef, useEffect } from 'react'
import { lookupVocab, type VocabDef } from '@/app/lib/invest-vocab'

interface Props {
  term: string
  /** Optional override label — by default uses VocabDef.term */
  label?: string
}

export function DefinedTerm({ term, label }: Props) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLSpanElement | null>(null)
  const def: VocabDef | null = lookupVocab(term)

  // Close when clicking outside
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  if (!def) return null

  return (
    <span ref={containerRef} className="fl-define">
      <button
        type="button"
        className="fl-define-btn"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen(v => !v)
        }}
        aria-label={`What is ${label ?? def.term}?`}
        title={`What is ${label ?? def.term}?`}
      >
        ?
      </button>

      {open && (
        <span className="fl-define-popout">
          <span className="fl-define-head">
            <span className="fl-define-term">{label ?? def.term}</span>
            <button
              type="button"
              className="fl-define-close"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
              }}
              aria-label="Close definition"
            >
              ×
            </button>
          </span>
          <span className="fl-define-short">{def.short}</span>
          {def.long && <span className="fl-define-long">{def.long}</span>}
          {def.see && def.see.length > 0 && (
            <span className="fl-define-see">
              See also: {def.see.join(', ')}
            </span>
          )}
        </span>
      )}
    </span>
  )
}
