// ════════════════════════════════════════════════════════════════
// app/components/TrackRecordGate.tsx
//
// Client-side form for the /track-record email gate.
//
// The PAGE decides whether to render this (cookie missing) or skip it
// (cookie present and full content rendered instead). This component
// just owns the form UI + POST to /api/subscribe + reload-on-success.
//
// On successful submit:
//   - /api/subscribe sets the wali_track_record_unlocked cookie
//   - We call router.refresh() so the server component re-renders with
//     the cookie now visible, swapping preview → full content.
// ════════════════════════════════════════════════════════════════

'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function TrackRecordGate() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [optIn, setOptIn] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmed = email.trim().toLowerCase()
    if (!trimmed || !EMAIL_RE.test(trimmed)) {
      setError('Please enter a valid email address.')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: trimmed,
          newsletterOptIn: optIn,
          source: 'track_record_gate',
        }),
      })

      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError(typeof json.error === 'string' ? json.error : 'Something went wrong. Please try again.')
        setSubmitting(false)
        return
      }

      // Cookie is set server-side. Refresh to re-render the page with
      // full content visible (server component reads the cookie fresh).
      router.refresh()
    } catch {
      setError('Network error. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div
      className="w-full max-w-md mx-auto rounded-2xl border overflow-hidden"
      style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.08)' }}
    >
      <div className="px-6 py-5 border-b" style={{ borderColor: 'rgba(255,255,255,0.07)' }}>
        <h2 className="text-lg font-bold text-white mb-1">See the full track record</h2>
        <p className="text-sm text-white/50">
          Enter your email to unlock every verdict, win/loss outcome, and the methodology behind the calls.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
        <div>
          <label htmlFor="email" className="block text-xs font-medium text-white/60 mb-1.5">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={submitting}
            className="w-full px-4 py-3 rounded-lg text-white placeholder-white/30 outline-none transition-colors"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          />
        </div>

        <label className="flex items-start gap-3 cursor-pointer group">
          <div className="relative mt-0.5 shrink-0">
            <input
              type="checkbox"
              checked={optIn}
              onChange={e => setOptIn(e.target.checked)}
              disabled={submitting}
              className="sr-only"
            />
            <div
              className="w-5 h-5 rounded border-2 transition-all flex items-center justify-center"
              style={{
                borderColor: optIn ? '#7c3aed' : 'rgba(255,255,255,0.2)',
                background: optIn ? '#7c3aed' : 'transparent',
              }}
            >
              {optIn && <span className="text-white text-xs font-bold">{'\u2713'}</span>}
            </div>
          </div>
          <span className="text-sm text-white/60 leading-relaxed">
            Send me weekly track record updates
          </span>
        </label>

        {error && (
          <div
            className="px-3 py-2 rounded-lg text-sm"
            style={{ background: 'rgba(220, 38, 38, 0.1)', color: '#fca5a5' }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !email}
          className="w-full py-3.5 rounded-xl font-bold text-white transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}
        >
          {submitting ? 'Unlocking\u2026' : 'Unlock track record'}
        </button>

        <p className="text-xs text-white/35 text-center leading-relaxed">
          We only send track record updates. No spam. Unsubscribe any time.
        </p>
      </form>
    </div>
  )
}
