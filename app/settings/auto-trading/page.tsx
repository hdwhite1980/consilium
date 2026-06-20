'use client'

// =============================================================
// app/settings/auto-trading/page.tsx
//
// User-facing page to connect Alpaca account(s) and view trading status.
//
// Important: this page does NOT let users toggle their own auto-trading
// on/off. That's an admin-only switch (per the original design — admin
// controls who's enabled, users only connect their broker).
//
// Users CAN:
//   - Add a paper or live Alpaca credential
//   - Delete a credential
//   - See their connection status and cached account info
//
// If admin hasn't enabled them, this page shows an info banner letting
// them know to contact admin (you) to be enabled.
// =============================================================

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, RefreshCw, Plus, Trash2, CheckCircle2, AlertCircle,
  Eye, EyeOff, Wallet, ShieldCheck, AlertTriangle,
} from 'lucide-react'

interface BrokerCredentialView {
  id: string
  broker: 'alpaca'
  mode: 'paper' | 'live'
  keyIdMasked: string
  accountId: string | null
  accountStatus: string | null
  accountCash: number | null
  accountEquity: number | null
  lastSyncedAt: string | null
  lastValidatedAt: string | null
  validationError: string | null
  createdAt: string
}

export default function AutoTradingSettingsPage() {
  const router = useRouter()
  const [credentials, setCredentials] = useState<BrokerCredentialView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)

  // Add form state
  const [newMode, setNewMode] = useState<'paper' | 'live'>('paper')
  const [newKeyId, setNewKeyId] = useState('')
  const [newSecret, setNewSecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/user/broker-credentials')
      if (!res.ok) {
        if (res.status === 401) {
          router.push('/login?next=/settings/auto-trading')
          return
        }
        throw new Error(`HTTP ${res.status}`)
      }
      const json = await res.json() as { credentials: BrokerCredentialView[] }
      setCredentials(json.credentials)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => { load() }, [load])

  async function handleAdd() {
    setSubmitting(true)
    setSubmitError(null)
    try {
      const res = await fetch('/api/user/broker-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          broker: 'alpaca',
          mode: newMode,
          keyId: newKeyId.trim(),
          secret: newSecret.trim(),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      // Success — reset form and reload
      setNewKeyId('')
      setNewSecret('')
      setShowAddForm(false)
      await load()
    } catch (e) {
      setSubmitError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(credentialId: string) {
    if (!confirm('Remove this credential? Any auto-trades currently enabled in this mode will stop firing.')) return
    try {
      const res = await fetch(`/api/user/broker-credentials?id=${encodeURIComponent(credentialId)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      await load()
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`)
    }
  }

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <header
        className="flex items-center gap-2 px-3 py-3 border-b sticky top-0 z-10"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70">
          <ArrowLeft size={13} />
          Back
        </button>
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} style={{ color: '#a78bfa' }} />
          <span className="text-sm font-bold">Auto-trading</span>
        </div>
        <span className="text-[10px] font-mono text-white/25">broker connections</span>
        <button
          onClick={load}
          className="ml-auto flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70"
          disabled={loading}
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </header>

      <main className="flex-1 max-w-3xl mx-auto w-full px-3 py-5 space-y-4">

        {/* Heads-up notice */}
        <div className="rounded-xl border p-4"
          style={{ background: 'rgba(167,139,250,0.05)', borderColor: 'rgba(167,139,250,0.25)' }}>
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} style={{ color: '#a78bfa' }} className="shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-semibold" style={{ color: '#a78bfa' }}>How this works</div>
              <p className="text-[11px] text-white/55 mt-1 leading-relaxed">
                Connecting an Alpaca account here lets the bot place trades for you when the Council issues
                Trader-approved BUY/SELL signals. Auto-trading is enabled per-user by an admin. If your account
                isn't enabled yet, you can still connect credentials so they're ready when you're activated.
              </p>
              <p className="text-[11px] text-white/40 mt-2 leading-relaxed">
                <strong>Paper trading</strong> uses Alpaca&apos;s simulated environment — no real money. Use this
                for testing. <strong>Live trading</strong> places real orders with real money. Use with caution.
              </p>
            </div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-xl border p-4 flex items-start gap-2"
            style={{ background: 'rgba(248,113,113,0.05)', borderColor: 'rgba(248,113,113,0.2)' }}>
            <AlertCircle size={14} style={{ color: '#f87171' }} className="shrink-0 mt-0.5" />
            <div>
              <div className="text-xs font-semibold" style={{ color: '#f87171' }}>Error</div>
              <p className="text-[11px] text-white/55 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* Credentials list */}
        <div className="space-y-2">
          {credentials.map(cred => (
            <CredentialCard key={cred.id} cred={cred} onDelete={() => handleDelete(cred.id)} />
          ))}
          {credentials.length === 0 && !loading && (
            <div className="rounded-xl border border-dashed p-6 text-center"
              style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <p className="text-xs text-white/40">No broker connections yet. Add an Alpaca account below.</p>
            </div>
          )}
        </div>

        {/* Add form */}
        {!showAddForm && (
          <button
            onClick={() => { setShowAddForm(true); setSubmitError(null) }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:border-white/30 mx-auto"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            <Plus size={13} />
            Connect Alpaca account
          </button>
        )}

        {showAddForm && (
          <div className="rounded-xl border p-4 space-y-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold">Connect Alpaca account</h3>
              <button
                onClick={() => { setShowAddForm(false); setSubmitError(null) }}
                className="text-xs text-white/40 hover:text-white/70"
              >
                Cancel
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-widest text-white/40 font-bold">Mode</label>
              <div className="flex items-center gap-2">
                {(['paper', 'live'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => setNewMode(m)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold border"
                    style={{
                      background: newMode === m ? (m === 'live' ? 'rgba(248,113,113,0.1)' : 'rgba(96,165,250,0.1)') : 'transparent',
                      borderColor: newMode === m ? (m === 'live' ? 'rgba(248,113,113,0.3)' : 'rgba(96,165,250,0.3)') : 'var(--border)',
                      color: newMode === m ? (m === 'live' ? '#f87171' : '#60a5fa') : 'rgba(255,255,255,0.55)',
                    }}
                  >
                    {m === 'paper' ? 'Paper (no real money)' : 'Live (real money)'}
                  </button>
                ))}
              </div>
              {newMode === 'live' && (
                <p className="text-[10px] font-mono text-amber-300">
                  ⚠ Live mode places real orders with real money.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-widest text-white/40 font-bold">API Key ID</label>
              <input
                type="text"
                value={newKeyId}
                onChange={e => setNewKeyId(e.target.value)}
                placeholder="e.g. PKLMABC1234XYZ"
                className="w-full px-3 py-2 rounded-lg border text-xs font-mono outline-none"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
              />
            </div>

            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-widest text-white/40 font-bold">API Secret</label>
              <div className="relative">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={newSecret}
                  onChange={e => setNewSecret(e.target.value)}
                  placeholder="Paste your Alpaca API secret"
                  className="w-full px-3 py-2 pr-10 rounded-lg border text-xs font-mono outline-none"
                  style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
                />
                <button
                  type="button"
                  onClick={() => setShowSecret(s => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70"
                >
                  {showSecret ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
              <p className="text-[10px] text-white/30 leading-relaxed">
                The secret is encrypted at rest. We never store plaintext. You can revoke this credential from Alpaca at any time.
              </p>
            </div>

            {submitError && (
              <div className="text-[11px] text-red-300 px-3 py-2 rounded border"
                style={{ background: 'rgba(248,113,113,0.05)', borderColor: 'rgba(248,113,113,0.3)' }}>
                {submitError}
              </div>
            )}

            <button
              onClick={handleAdd}
              disabled={submitting || !newKeyId.trim() || !newSecret.trim()}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border disabled:opacity-30"
              style={{
                background: 'rgba(167,139,250,0.15)',
                borderColor: 'rgba(167,139,250,0.3)',
                color: '#a78bfa',
              }}
            >
              {submitting ? <RefreshCw size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              {submitting ? 'Validating with Alpaca...' : 'Validate & save'}
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

function CredentialCard({
  cred, onDelete,
}: {
  cred: BrokerCredentialView
  onDelete: () => void
}) {
  const isLive = cred.mode === 'live'
  const isOk = cred.accountStatus === 'ACTIVE' && !cred.validationError
  const modeColor = isLive ? '#f87171' : '#60a5fa'

  return (
    <div className="rounded-xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-widest font-bold"
              style={{ background: `${modeColor}15`, color: modeColor, border: `1px solid ${modeColor}30` }}
            >
              {cred.mode}
            </span>
            <span className="text-sm font-bold">Alpaca</span>
            {isOk ? (
              <span className="flex items-center gap-1 text-[10px] text-emerald-300">
                <CheckCircle2 size={10} /> connected
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[10px] text-amber-300">
                <AlertCircle size={10} /> needs attention
              </span>
            )}
          </div>
          <div className="text-[10px] font-mono text-white/40">key: {cred.keyIdMasked}</div>
        </div>
        <button
          onClick={onDelete}
          className="text-white/30 hover:text-red-300"
          title="Remove credential"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 mt-3 text-[11px]">
        <div>
          <div className="text-[9px] uppercase tracking-widest text-white/30 font-bold mb-0.5">Account status</div>
          <div className="text-white/65">{cred.accountStatus ?? '—'}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-white/30 font-bold mb-0.5">Equity</div>
          <div className="text-white/65 font-mono">
            {cred.accountEquity !== null ? `$${cred.accountEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-white/30 font-bold mb-0.5">Cash</div>
          <div className="text-white/65 font-mono">
            {cred.accountCash !== null ? `$${cred.accountCash.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-white/30 font-bold mb-0.5">Last synced</div>
          <div className="text-white/65 font-mono">
            {cred.lastSyncedAt ? new Date(cred.lastSyncedAt).toLocaleString() : '—'}
          </div>
        </div>
      </div>

      {cred.validationError && (
        <div className="mt-3 text-[10px] text-red-300 px-2 py-1.5 rounded border"
          style={{ background: 'rgba(248,113,113,0.05)', borderColor: 'rgba(248,113,113,0.3)' }}>
          Last validation error: {cred.validationError}
        </div>
      )}
    </div>
  )
}
