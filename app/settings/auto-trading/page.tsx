'use client'

// =============================================================
// app/settings/auto-trading/page.tsx
//
// Multi-broker connect page. Pick broker + asset class + mode,
// then enter the broker-specific credentials.
//
// Brokers:
//   - Alpaca (stocks OR crypto): keyId + secret
//   - OANDA (forex):             accountId + Personal Access Token
//   - Tradovate (futures):       username + password + appKey
// =============================================================

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, RefreshCw, Plus, Trash2, CheckCircle2, AlertCircle,
  Eye, EyeOff, ShieldCheck, AlertTriangle, ExternalLink,
} from 'lucide-react'

type BrokerName = 'alpaca' | 'oanda' | 'tradovate'
type AssetClass = 'stock' | 'crypto' | 'forex' | 'futures'
type Mode = 'paper' | 'live'

interface BrokerCredentialView {
  id: string
  broker: BrokerName
  mode: Mode
  assetClass: AssetClass
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

interface BrokerConfig {
  name: BrokerName
  label: string
  color: string
  allowedAssetClasses: AssetClass[]
  helpUrl: string
  keyIdLabel: string
  keyIdPlaceholder: string
  secretLabel: string
  secretPlaceholder: string
  instructions: string
}

const BROKERS: BrokerConfig[] = [
  {
    name: 'alpaca',
    label: 'Alpaca',
    color: '#fbbf24',
    allowedAssetClasses: ['stock', 'crypto'],
    helpUrl: 'https://app.alpaca.markets/paper/dashboard/overview',
    keyIdLabel: 'API Key ID',
    keyIdPlaceholder: 'e.g. PKLMABC1234XYZ',
    secretLabel: 'API Secret',
    secretPlaceholder: 'Paste your Alpaca API secret',
    instructions: 'Generate keys from your Alpaca dashboard. The same keys work for stocks AND crypto if both are enabled on your Alpaca account. Use paper-mode keys with paper, live-mode keys with live.',
  },
  {
    name: 'oanda',
    label: 'OANDA',
    color: '#34d399',
    allowedAssetClasses: ['forex'],
    helpUrl: 'https://www.oanda.com/account/tpa/personal_token',
    keyIdLabel: 'Account ID',
    keyIdPlaceholder: 'e.g. 001-001-12345678-001',
    secretLabel: 'Personal Access Token',
    secretPlaceholder: 'Paste your OANDA PAT',
    instructions: 'For OANDA, the "key" is your account ID (looks like 001-001-XXXXXXXX-001) and the "secret" is a Personal Access Token. Generate the token from the OANDA account portal — it is shown ONCE, copy immediately. Practice and live environments use separate accounts and separate tokens.',
  },
  {
    name: 'tradovate',
    label: 'Tradovate',
    color: '#a78bfa',
    allowedAssetClasses: ['futures'],
    helpUrl: 'https://api.tradovate.com/',
    keyIdLabel: 'Username',
    keyIdPlaceholder: 'Your Tradovate username',
    secretLabel: 'Password',
    secretPlaceholder: 'Your Tradovate password',
    instructions: 'Tradovate uses OAuth2 with username + password + an app key. Sign up at tradovate.com and request API access. NOTE: Tradovate validation is not yet implemented server-side; saving will return a 501 error until the next deployment. You can fill the form to test the UI flow.',
  },
]

const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  stock: 'Stocks',
  crypto: 'Crypto',
  forex: 'Forex',
  futures: 'Futures',
}

export default function AutoTradingSettingsPage() {
  const router = useRouter()
  const [credentials, setCredentials] = useState<BrokerCredentialView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)

  // Add form state
  const [newBroker, setNewBroker] = useState<BrokerName>('alpaca')
  const [newAssetClass, setNewAssetClass] = useState<AssetClass>('stock')
  const [newMode, setNewMode] = useState<Mode>('paper')
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

  useEffect(() => { void load() }, [load])

  function handleBrokerChange(broker: BrokerName) {
    setNewBroker(broker)
    // Auto-set asset class to the first allowed one for this broker
    const config = BROKERS.find(b => b.name === broker)
    if (config && !config.allowedAssetClasses.includes(newAssetClass)) {
      setNewAssetClass(config.allowedAssetClasses[0])
    }
    setSubmitError(null)
  }

  async function handleAdd() {
    setSubmitting(true)
    setSubmitError(null)
    try {
      const res = await fetch('/api/user/broker-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          broker: newBroker,
          mode: newMode,
          assetClass: newAssetClass,
          keyId: newKeyId.trim(),
          secret: newSecret.trim(),
        }),
      })
      const body = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) {
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
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
    if (!confirm('Remove this credential? Any auto-trades currently enabled for this broker/asset class will stop firing.')) return
    try {
      const res = await fetch(`/api/user/broker-credentials?id=${encodeURIComponent(credentialId)}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      await load()
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`)
    }
  }

  const selectedBrokerConfig = BROKERS.find(b => b.name === newBroker)!

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
          onClick={() => { void load() }}
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
                You can connect multiple broker accounts here. Each (broker + mode + asset class)
                combination is a separate credential. For example, you might have Alpaca paper for stocks,
                Alpaca paper for crypto, and OANDA practice for forex — three separate connections.
              </p>
              <p className="text-[11px] text-white/40 mt-2 leading-relaxed">
                <strong>Paper / Practice</strong> = simulated, no real money. <strong>Live</strong> = real orders, real money. Each broker has its own paper/live environments with separate credentials.
              </p>
            </div>
          </div>
        </div>

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
            <CredentialCard key={cred.id} cred={cred} onDelete={() => { void handleDelete(cred.id) }} />
          ))}
          {credentials.length === 0 && !loading && (
            <div className="rounded-xl border border-dashed p-6 text-center"
              style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <p className="text-xs text-white/40">No broker connections yet. Add one below.</p>
            </div>
          )}
        </div>

        {/* Add form trigger */}
        {!showAddForm && (
          <button
            onClick={() => { setShowAddForm(true); setSubmitError(null) }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-semibold hover:border-white/30 mx-auto"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            <Plus size={13} />
            Connect a broker
          </button>
        )}

        {/* Add form */}
        {showAddForm && (
          <div className="rounded-xl border p-4 space-y-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold">Connect broker account</h3>
              <button
                onClick={() => { setShowAddForm(false); setSubmitError(null) }}
                className="text-xs text-white/40 hover:text-white/70"
              >
                Cancel
              </button>
            </div>

            {/* Broker selector */}
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-widest text-white/40 font-bold">Broker</label>
              <div className="grid grid-cols-3 gap-2">
                {BROKERS.map(b => (
                  <button
                    key={b.name}
                    onClick={() => handleBrokerChange(b.name)}
                    className="px-3 py-2 rounded-lg text-xs font-semibold border transition-all"
                    style={{
                      background: newBroker === b.name ? `${b.color}15` : 'transparent',
                      borderColor: newBroker === b.name ? `${b.color}50` : 'var(--border)',
                      color: newBroker === b.name ? b.color : 'rgba(255,255,255,0.55)',
                    }}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Asset class selector */}
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-widest text-white/40 font-bold">Asset class</label>
              <div className="grid grid-cols-4 gap-2">
                {(['stock', 'crypto', 'forex', 'futures'] as AssetClass[]).map(ac => {
                  const allowed = selectedBrokerConfig.allowedAssetClasses.includes(ac)
                  return (
                    <button
                      key={ac}
                      onClick={() => allowed && setNewAssetClass(ac)}
                      disabled={!allowed}
                      className="px-2 py-1.5 rounded-lg text-[11px] font-semibold border"
                      style={{
                        background: newAssetClass === ac && allowed ? 'rgba(167,139,250,0.1)' : 'transparent',
                        borderColor: newAssetClass === ac && allowed ? 'rgba(167,139,250,0.3)' : 'var(--border)',
                        color: !allowed ? 'rgba(255,255,255,0.2)' : newAssetClass === ac ? '#a78bfa' : 'rgba(255,255,255,0.55)',
                        cursor: allowed ? 'pointer' : 'not-allowed',
                      }}
                      title={allowed ? '' : `${selectedBrokerConfig.label} does not support ${ASSET_CLASS_LABELS[ac]}`}
                    >
                      {ASSET_CLASS_LABELS[ac]}
                    </button>
                  )
                })}
              </div>
              <p className="text-[10px] text-white/35">
                Available asset classes depend on the broker. {selectedBrokerConfig.label} supports: {selectedBrokerConfig.allowedAssetClasses.map(ac => ASSET_CLASS_LABELS[ac]).join(', ')}.
              </p>
            </div>

            {/* Mode selector */}
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-widest text-white/40 font-bold">Mode</label>
              <div className="flex items-center gap-2">
                {(['paper', 'live'] as Mode[]).map(m => (
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
                    {m === 'paper' ? 'Paper / Practice' : 'Live (real money)'}
                  </button>
                ))}
              </div>
              {newMode === 'live' && (
                <p className="text-[10px] font-mono text-amber-300">
                  ⚠ Live mode places real orders with real money.
                </p>
              )}
            </div>

            {/* Broker-specific instructions */}
            <div className="rounded-lg p-3 border" style={{ background: 'rgba(0,0,0,0.2)', borderColor: 'var(--border)' }}>
              <div className="flex items-start gap-2">
                <div className="text-[11px] text-white/65 leading-relaxed flex-1">
                  {selectedBrokerConfig.instructions}
                </div>
              </div>
              <a
                href={selectedBrokerConfig.helpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] mt-2 hover:underline"
                style={{ color: selectedBrokerConfig.color }}
              >
                <ExternalLink size={10} />
                Open {selectedBrokerConfig.label} {selectedBrokerConfig.name === 'oanda' ? 'token page' : 'dashboard'}
              </a>
            </div>

            {/* Credential inputs */}
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-widest text-white/40 font-bold">{selectedBrokerConfig.keyIdLabel}</label>
              <input
                type="text"
                value={newKeyId}
                onChange={e => setNewKeyId(e.target.value)}
                placeholder={selectedBrokerConfig.keyIdPlaceholder}
                className="w-full px-3 py-2 rounded-lg border text-xs font-mono outline-none"
                style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
              />
            </div>

            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-widest text-white/40 font-bold">{selectedBrokerConfig.secretLabel}</label>
              <div className="relative">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={newSecret}
                  onChange={e => setNewSecret(e.target.value)}
                  placeholder={selectedBrokerConfig.secretPlaceholder}
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
                The secret is encrypted at rest. We never store plaintext. You can revoke this credential from {selectedBrokerConfig.label} at any time.
              </p>
            </div>

            {submitError && (
              <div className="text-[11px] text-red-300 px-3 py-2 rounded border"
                style={{ background: 'rgba(248,113,113,0.05)', borderColor: 'rgba(248,113,113,0.3)' }}>
                {submitError}
              </div>
            )}

            <button
              onClick={() => { void handleAdd() }}
              disabled={submitting || !newKeyId.trim() || !newSecret.trim()}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border disabled:opacity-30"
              style={{
                background: `${selectedBrokerConfig.color}15`,
                borderColor: `${selectedBrokerConfig.color}50`,
                color: selectedBrokerConfig.color,
              }}
            >
              {submitting ? <RefreshCw size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              {submitting ? `Validating with ${selectedBrokerConfig.label}...` : 'Validate & save'}
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
  const isOk = (cred.accountStatus === 'ACTIVE' || cred.accountStatus === null) && !cred.validationError
  const modeColor = isLive ? '#f87171' : '#60a5fa'
  const brokerConfig = BROKERS.find(b => b.name === cred.broker)
  const brokerColor = brokerConfig?.color ?? '#a78bfa'
  const brokerLabel = brokerConfig?.label ?? cred.broker

  return (
    <div className="rounded-xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span
              className="text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-widest font-bold"
              style={{ background: `${modeColor}15`, color: modeColor, border: `1px solid ${modeColor}30` }}
            >
              {cred.mode}
            </span>
            <span className="text-sm font-bold" style={{ color: brokerColor }}>{brokerLabel}</span>
            <span
              className="text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-widest font-bold"
              style={{ background: `${brokerColor}15`, color: brokerColor, border: `1px solid ${brokerColor}30` }}
            >
              {ASSET_CLASS_LABELS[cred.assetClass]}
            </span>
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
          <div className="text-[9px] uppercase tracking-widest text-white/30 font-bold mb-0.5">Equity / Balance</div>
          <div className="text-white/65 font-mono">
            {cred.accountEquity !== null ? `$${cred.accountEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-widest text-white/30 font-bold mb-0.5">Cash / Margin</div>
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
