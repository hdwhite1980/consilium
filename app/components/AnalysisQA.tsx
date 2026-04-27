'use client'

// =============================================================
// app/components/AnalysisQA.tsx
//
// Follow-up Q&A panel that renders below the Council verdict.
// Toggle button opens/closes the panel. Conversation state is
// in-memory only (resets when component unmounts or ticker
// changes via the `ticker` prop).
//
// Each question sends the full analysis context + conversation
// history to /api/analyze/qa, displays Claude's answer.
// =============================================================

import { useState, useRef, useEffect, useCallback } from 'react'
import { MessageSquare, Send, X, Loader2 } from 'lucide-react'

// =============================================================
// Types
// =============================================================

export interface AnalysisQAContext {
  ticker: string
  currentPrice: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verdict: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  news: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  leadAnalyst: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  devilsAdvocate: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rebuttal: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  counter: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  technicals: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  social?: any
}

interface QAMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

interface AnalysisQAProps {
  context: AnalysisQAContext
}

// =============================================================
// Suggested questions (rotated/randomized for variety)
// =============================================================

const SUGGESTIONS = [
  "What would change your mind?",
  "What are you most uncertain about?",
  "Walk me through the strongest counter-argument",
  "Which signal carried the most weight?",
  "What's the bear case if I'm wrong?",
  "Are there any blind spots in this analysis?",
  "What macro events could derail this?",
  "Is the Devil's Advocate right about anything important?",
  "How much should I weight the news vs technicals?",
  "What would you watch over the next 5 trading days?",
] as const

function pickSuggestions(count: number): string[] {
  const shuffled = [...SUGGESTIONS].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count)
}

// =============================================================
// Component
// =============================================================

export default function AnalysisQA({ context }: AnalysisQAProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<QAMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [suggestions] = useState<string[]>(() => pickSuggestions(4))

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Reset conversation when ticker changes
  useEffect(() => {
    setMessages([])
    setInput('')
    setError(null)
  }, [context.ticker])

  // Auto-scroll to latest message
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, busy])

  // Focus textarea when panel opens
  useEffect(() => {
    if (isOpen && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [isOpen])

  const send = useCallback(async (questionText: string) => {
    const trimmed = questionText.trim()
    if (!trimmed || busy) return

    const userMsg: QAMessage = { role: 'user', content: trimmed, timestamp: Date.now() }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setBusy(true)
    setError(null)

    try {
      const res = await fetch('/api/analyze/qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analysisContext: context,
          history: messages.map(m => ({ role: m.role, content: m.content })),
          question: trimmed,
        }),
      })

      const body = await res.json().catch(() => null)

      if (!res.ok) {
        const errMsg = body?.error || `Request failed (${res.status})`
        setError(errMsg)
        setBusy(false)
        return
      }

      const answer = typeof body?.answer === 'string' ? body.answer : ''
      if (!answer) {
        setError('Empty response from model')
        setBusy(false)
        return
      }

      const assistantMsg: QAMessage = { role: 'assistant', content: answer, timestamp: Date.now() }
      setMessages(prev => [...prev, assistantMsg])
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Network error'
      setError(msg.slice(0, 200))
    } finally {
      setBusy(false)
    }
  }, [context, messages, busy])

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    void send(input)
  }, [send, input])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(input)
    }
  }, [send, input])

  const handleSuggestionClick = useCallback((s: string) => {
    void send(s)
  }, [send])

  const handleClear = useCallback(() => {
    if (messages.length === 0) return
    if (confirm('Clear this conversation? This cannot be undone.')) {
      setMessages([])
      setError(null)
    }
  }, [messages.length])

  // ============================================================
  // Render
  // ============================================================

  // Toggle button (closed state)
  if (!isOpen) {
    return (
      <div className="rounded-2xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
          style={{
            background: 'rgba(167,139,250,0.12)',
            color: '#a78bfa',
            border: '1px solid rgba(167,139,250,0.3)',
          }}>
          <MessageSquare size={14} />
          <span>Ask follow-up questions about this analysis</span>
        </button>
      </div>
    )
  }

  // Open state
  return (
    <div className="rounded-2xl border" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-2">
          <MessageSquare size={14} style={{ color: '#a78bfa' }} />
          <span className="text-sm font-semibold">Follow-up Q&amp;A</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
            style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa' }}>
            {context.ticker}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              title="Clear conversation"
              className="text-[10px] font-mono px-2 py-1 rounded transition-all hover:opacity-80"
              style={{ color: 'var(--text3)', background: 'transparent' }}>
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            title="Close panel"
            className="p-1 rounded transition-all hover:opacity-80"
            style={{ color: 'var(--text3)' }}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Conversation area */}
      <div
        ref={scrollRef}
        className="px-4 py-3 space-y-3 overflow-y-auto"
        style={{ maxHeight: '400px', minHeight: messages.length === 0 ? 'auto' : '200px' }}>

        {/* Empty state - show suggestions */}
        {messages.length === 0 && (
          <div className="space-y-3 py-2">
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text3)' }}>
              Ask anything about the Council&apos;s analysis. Examples:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => handleSuggestionClick(s)}
                  disabled={busy}
                  className="text-xs px-2.5 py-1.5 rounded-lg transition-all hover:opacity-90 text-left disabled:opacity-50"
                  style={{
                    background: 'rgba(167,139,250,0.08)',
                    color: '#a78bfa',
                    border: '1px solid rgba(167,139,250,0.2)',
                  }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Messages */}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className="rounded-xl px-3 py-2 max-w-[85%]"
              style={{
                background: m.role === 'user' ? 'rgba(167,139,250,0.12)' : 'rgba(96,165,250,0.06)',
                border: `1px solid ${m.role === 'user' ? 'rgba(167,139,250,0.25)' : 'rgba(96,165,250,0.15)'}`,
                color: 'var(--text1)',
              }}>
              <div className="text-[9px] font-mono uppercase tracking-widest mb-1" style={{
                color: m.role === 'user' ? '#a78bfa' : '#60a5fa',
              }}>
                {m.role === 'user' ? 'You' : 'Analyst'}
              </div>
              <div className="text-xs leading-relaxed whitespace-pre-wrap">
                {m.content}
              </div>
            </div>
          </div>
        ))}

        {/* Loading indicator */}
        {busy && (
          <div className="flex justify-start">
            <div
              className="rounded-xl px-3 py-2"
              style={{
                background: 'rgba(96,165,250,0.06)',
                border: '1px solid rgba(96,165,250,0.15)',
              }}>
              <div className="flex items-center gap-2">
                <Loader2 size={11} className="animate-spin" style={{ color: '#60a5fa' }} />
                <span className="text-xs" style={{ color: 'var(--text3)' }}>Thinking...</span>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-lg p-2.5 text-xs"
            style={{
              background: 'rgba(248,113,113,0.08)',
              color: '#f87171',
              border: '1px solid rgba(248,113,113,0.2)',
            }}>
            <div className="font-mono text-[10px] uppercase tracking-widest mb-0.5">Error</div>
            <div>{error}</div>
          </div>
        )}
      </div>

      {/* Input form */}
      <form onSubmit={handleSubmit} className="px-4 py-3 border-t" style={{ borderColor: 'var(--border)' }}>
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={busy ? 'Waiting for response...' : 'Ask a question (Enter to send, Shift+Enter for newline)'}
            disabled={busy}
            maxLength={1000}
            rows={1}
            className="flex-1 text-xs font-mono px-3 py-2 rounded-lg resize-none disabled:opacity-50"
            style={{
              background: 'var(--surface2)',
              color: 'var(--text1)',
              border: '1px solid rgba(255,255,255,0.1)',
              minHeight: '36px',
              maxHeight: '120px',
            }} />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="px-3 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
            style={{
              background: 'rgba(167,139,250,0.15)',
              color: '#a78bfa',
              border: '1px solid rgba(167,139,250,0.3)',
              minWidth: '60px',
            }}>
            {busy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <>
                <Send size={11} />
                <span>Send</span>
              </>
            )}
          </button>
        </div>
        {input.length > 800 && (
          <div className="text-[9px] font-mono mt-1 text-right" style={{ color: input.length > 950 ? '#f87171' : 'var(--text3)' }}>
            {input.length} / 1000
          </div>
        )}
      </form>
    </div>
  )
}
