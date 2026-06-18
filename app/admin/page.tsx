'use client'

// =============================================================
// app/admin/page.tsx
//
// Admin dashboard for managing users — subscription state, comp
// access, trial extension, tier changes.
//
// Access control: server-side check happens in the API routes.
// This client page renders even if the user isn't admin, but
// the API calls fail with 404 and the UI shows the error state.
// (For stronger UX we could move the page to a server component
// and notFound() — for v1 the API gate is sufficient.)
// =============================================================

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, RefreshCw, Search, Shield, Check, X,
  CalendarDays, Clock, AlertCircle, Star,
  Activity, Users, CheckCircle2, XCircle, AlertTriangle, MinusCircle,
  Cpu, Database, Briefcase, Mail, BarChart3,
} from 'lucide-react'

interface AdminUserRow {
  id: string
  email: string
  createdAt: string
  lastSignInAt: string | null
  isAdmin: boolean
  subscriptionId: string | null
  status: string | null
  tier: string | null
  trialEndsAt: string | null
  currentPeriodEnd: string | null
  isExempt: boolean
  stripeCustomerId: string | null
  stripeSubId: string | null
}

interface AdminUsersResponse {
  users: AdminUserRow[]
  page: number
  pageSize: number
  totalCount: number
}

const TIER_OPTIONS = ['standard', 'pro', 'trial', 'comp']
const STATUS_OPTIONS = ['trialing', 'active', 'canceled', 'past_due', 'incomplete', 'paused']
const TRIAL_PRESETS = [7, 14, 30, 60, 90]

type AdminTab = 'users' | 'health'

export default function AdminPage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<AdminTab>('users')
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [page, setPage] = useState(0)
  const [pageSize] = useState(50)
  const [totalCount, setTotalCount] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      })
      if (search.trim()) params.set('q', search.trim())
      const res = await fetch(`/api/admin/users?${params.toString()}`)
      if (res.status === 404) {
        setError('You do not have access to this page.')
        setUsers([])
        return
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json() as AdminUsersResponse
      setUsers(json.users)
      setTotalCount(json.totalCount)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search])

  useEffect(() => { load() }, [load])

  // ─── Action handlers ────────────────────────────────────────

  async function performAction(
    userId: string,
    action: 'toggle_comp' | 'extend_trial' | 'set_tier' | 'set_status',
    payload: Record<string, unknown>,
  ) {
    setPendingAction(`${userId}:${action}`)
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      // Reload after successful action
      await load()
    } catch (e) {
      alert(`Action failed: ${(e as Error).message}`)
    } finally {
      setPendingAction(null)
    }
  }

  const toggleComp = (u: AdminUserRow) =>
    performAction(u.id, 'toggle_comp', { is_exempt: !u.isExempt })

  const extendTrial = (u: AdminUserRow, days: number) =>
    performAction(u.id, 'extend_trial', { days })

  const setTier = (u: AdminUserRow, tier: string) =>
    performAction(u.id, 'set_tier', { tier })

  const setStatus = (u: AdminUserRow, status: string) =>
    performAction(u.id, 'set_status', { status })

  // ─── Render ─────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      {/* Header */}
      <header
        className="flex flex-wrap items-center gap-2 px-3 py-3 border-b sticky top-0 z-10"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70">
          <ArrowLeft size={13} />
          Back
        </button>
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        <div className="flex items-center gap-2">
          <Shield size={14} style={{ color: '#a78bfa' }} />
          <span className="text-sm font-bold">Admin Dashboard</span>
        </div>
        <span className="text-[10px] font-mono text-white/25">user management</span>

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={load}
            className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70"
            disabled={loading}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full px-3 py-5 space-y-4">

        {/* Tab toggle: Users / API Health */}
        <div
          className="flex items-center gap-1 p-1 rounded-xl border"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)', width: 'fit-content' }}
        >
          {([
            { id: 'users' as AdminTab,  label: 'Users',      Icon: Users },
            { id: 'health' as AdminTab, label: 'API Health', Icon: Activity },
          ]).map(({ id, label, Icon }) => {
            const isActive = activeTab === id
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                style={{
                  background: isActive ? 'rgba(167,139,250,0.15)' : 'transparent',
                  color: isActive ? '#a78bfa' : 'rgba(255,255,255,0.55)',
                  border: isActive ? '1px solid rgba(167,139,250,0.3)' : '1px solid transparent',
                }}
              >
                <Icon size={12} />
                {label}
              </button>
            )
          })}
        </div>

        {/* USERS TAB */}
        {activeTab === 'users' && (
          <>
            {/* Search + count */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border flex-1 min-w-[200px]"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
                <Search size={13} className="text-white/30" />
                <input
                  type="text"
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(0) }}
                  placeholder="Search by email..."
                  className="bg-transparent border-none outline-none text-xs flex-1 placeholder:text-white/25"
                />
              </div>
              <span className="text-[11px] font-mono text-white/40">
                {totalCount} users
              </span>
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

            {/* User list */}
            <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              {users.length === 0 && !loading && !error && (
                <div className="p-8 text-center text-xs text-white/40">No users found.</div>
              )}
              {users.map((u, i) => (
                <UserRow
                  key={u.id}
                  user={u}
                  isExpanded={expandedId === u.id}
                  onToggleExpand={() => setExpandedId(expandedId === u.id ? null : u.id)}
                  isLast={i === users.length - 1}
                  pendingAction={pendingAction}
                  onToggleComp={() => toggleComp(u)}
                  onExtendTrial={(days) => extendTrial(u, days)}
                  onSetTier={(tier) => setTier(u, tier)}
                  onSetStatus={(status) => setStatus(u, status)}
                />
              ))}
            </div>

            {/* Pagination */}
            {totalCount > pageSize && (
              <div className="flex items-center justify-between text-xs text-white/45">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-3 py-1.5 rounded border hover:border-white/30 disabled:opacity-30"
                  style={{ borderColor: 'var(--border)' }}
                >
                  ← Prev
                </button>
                <span className="font-mono">
                  Page {page + 1} of {Math.ceil(totalCount / pageSize)}
                </span>
                <button
                  onClick={() => setPage(p => p + 1)}
                  disabled={(page + 1) * pageSize >= totalCount}
                  className="px-3 py-1.5 rounded border hover:border-white/30 disabled:opacity-30"
                  style={{ borderColor: 'var(--border)' }}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}

        {/* API HEALTH TAB */}
        {activeTab === 'health' && <ApiHealthPanel />}

      </main>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function UserRow({
  user, isExpanded, onToggleExpand, isLast, pendingAction,
  onToggleComp, onExtendTrial, onSetTier, onSetStatus,
}: {
  user: AdminUserRow
  isExpanded: boolean
  onToggleExpand: () => void
  isLast: boolean
  pendingAction: string | null
  onToggleComp: () => void
  onExtendTrial: (days: number) => void
  onSetTier: (tier: string) => void
  onSetStatus: (status: string) => void
}) {
  const statusColor =
    user.status === 'active'    ? '#34d399' :
    user.status === 'trialing'  ? '#60a5fa' :
    user.status === 'canceled'  ? '#94a3b8' :
    user.status === 'past_due'  ? '#f87171' :
                                  '#fbbf24'

  const trialDaysRemaining = user.trialEndsAt
    ? Math.ceil((new Date(user.trialEndsAt).getTime() - Date.now()) / 86_400_000)
    : null

  return (
    <div
      style={{ borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.05)' }}
    >
      {/* Summary row */}
      <button
        onClick={onToggleExpand}
        className="w-full px-4 py-3 text-left hover:bg-white/[0.02] transition-colors flex items-center gap-3"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold truncate">{user.email}</span>
            {user.isAdmin && (
              <span
                className="text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-widest"
                style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)' }}
              >
                <Star size={8} className="inline mr-0.5" /> admin
              </span>
            )}
            {user.isExempt && (
              <span
                className="text-[9px] font-mono px-1.5 py-0.5 rounded uppercase tracking-widest"
                style={{ background: 'rgba(52,211,153,0.12)', color: '#34d399', border: '1px solid rgba(52,211,153,0.25)' }}
              >
                comp
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-white/40">
            {user.status && (
              <span className="flex items-center gap-1" style={{ color: statusColor }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor }} />
                {user.status}
              </span>
            )}
            {user.tier && <span>tier: {user.tier}</span>}
            <span>joined: {formatDate(user.createdAt)}</span>
            {user.lastSignInAt && <span>last: {formatRelative(user.lastSignInAt)}</span>}
            {trialDaysRemaining !== null && trialDaysRemaining >= 0 && (
              <span>trial: {trialDaysRemaining}d left</span>
            )}
          </div>
        </div>
        <div className="text-[10px] font-mono text-white/30">
          {isExpanded ? '−' : '+'}
        </div>
      </button>

      {/* Expanded actions */}
      {isExpanded && (
        <div className="px-4 pb-4 pt-1 space-y-3">
          {/* Detail grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] font-mono">
            <DetailField label="user id" value={user.id} />
            <DetailField label="sub id" value={user.subscriptionId} />
            <DetailField label="trial ends" value={user.trialEndsAt ? formatDate(user.trialEndsAt) : '—'} />
            <DetailField label="period end" value={user.currentPeriodEnd ? formatDate(user.currentPeriodEnd) : '—'} />
            <DetailField label="stripe cust" value={user.stripeCustomerId} />
            <DetailField label="stripe sub" value={user.stripeSubId} />
          </div>

          {/* Actions */}
          <div className="space-y-2 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            {/* Comp toggle */}
            <ActionRow label="Comp (free access)">
              <button
                onClick={onToggleComp}
                disabled={pendingAction === `${user.id}:toggle_comp`}
                className="flex items-center gap-1.5 px-3 py-1 rounded text-[11px] font-semibold border"
                style={{
                  background: user.isExempt ? 'rgba(248,113,113,0.1)' : 'rgba(52,211,153,0.1)',
                  borderColor: user.isExempt ? 'rgba(248,113,113,0.3)' : 'rgba(52,211,153,0.3)',
                  color: user.isExempt ? '#f87171' : '#34d399',
                }}
              >
                {user.isExempt ? <X size={11} /> : <Check size={11} />}
                {user.isExempt ? 'Remove comp' : 'Grant comp'}
              </button>
            </ActionRow>

            {/* Extend trial */}
            <ActionRow label="Extend trial">
              <div className="flex items-center gap-1">
                {TRIAL_PRESETS.map(days => (
                  <button
                    key={days}
                    onClick={() => onExtendTrial(days)}
                    disabled={pendingAction === `${user.id}:extend_trial`}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono border hover:border-white/30"
                    style={{ background: 'rgba(96,165,250,0.05)', borderColor: 'rgba(96,165,250,0.2)', color: '#60a5fa' }}
                  >
                    <CalendarDays size={9} />
                    +{days}d
                  </button>
                ))}
              </div>
            </ActionRow>

            {/* Set tier */}
            <ActionRow label="Tier">
              <select
                onChange={e => { if (e.target.value) onSetTier(e.target.value) }}
                value={user.tier ?? ''}
                disabled={pendingAction === `${user.id}:set_tier`}
                className="px-2 py-1 rounded text-[11px] border outline-none"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }}
              >
                <option value="">—</option>
                {TIER_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </ActionRow>

            {/* Set status */}
            <ActionRow label="Status">
              <select
                onChange={e => { if (e.target.value) onSetStatus(e.target.value) }}
                value={user.status ?? ''}
                disabled={pendingAction === `${user.id}:set_status`}
                className="px-2 py-1 rounded text-[11px] border outline-none"
                style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' }}
              >
                <option value="">—</option>
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </ActionRow>
          </div>
        </div>
      )}
    </div>
  )
}

function DetailField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="text-white/30 uppercase tracking-wider">{label}</div>
      <div className="text-white/65 truncate" title={value ?? ''}>{value ?? '—'}</div>
    </div>
  )
}

function ActionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-[10px] font-mono uppercase tracking-widest text-white/35 w-24 shrink-0">{label}</span>
      {children}
    </div>
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.round(hr / 24)
  return `${d}d ago`
}

// ─────────────────────────────────────────────────────────────
// API Health Panel
// ─────────────────────────────────────────────────────────────

type ApiStatus = 'ok' | 'degraded' | 'down' | 'not_configured' | 'unknown'

interface ApiCheckResult {
  id: string
  name: string
  category: 'data' | 'ai' | 'broker' | 'infra' | 'comms'
  status: ApiStatus
  latencyMs: number | null
  httpStatus: number | null
  message: string | null
  checkedAt: string
}

interface ApiHealthResponse {
  results: ApiCheckResult[]
  elapsed_ms: number
  summary?: {
    total: number
    ok: number
    degraded: number
    down: number
    not_configured: number
  }
}

function ApiHealthPanel() {
  const [results, setResults] = useState<ApiCheckResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set())
  const [elapsed, setElapsed] = useState<number | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/health')
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json() as ApiHealthResponse
      setResults(json.results)
      setElapsed(json.elapsed_ms)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const refreshOne = useCallback(async (id: string) => {
    setRefreshingIds(prev => new Set(prev).add(id))
    try {
      const res = await fetch(`/api/admin/health?id=${encodeURIComponent(id)}`)
      if (!res.ok) return
      const json = await res.json() as ApiHealthResponse
      if (json.results && json.results.length > 0) {
        const updated = json.results[0]
        setResults(prev => prev.map(r => r.id === id ? updated : r))
      }
    } catch {
      // silent — keep the existing result
    } finally {
      setRefreshingIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [])

  // Group by category for display
  const byCategory: Record<ApiCheckResult['category'], ApiCheckResult[]> = {
    infra: [], ai: [], data: [], broker: [], comms: [],
  }
  for (const r of results) {
    byCategory[r.category]?.push(r)
  }

  const summary = {
    total: results.length,
    ok: results.filter(r => r.status === 'ok').length,
    degraded: results.filter(r => r.status === 'degraded').length,
    down: results.filter(r => r.status === 'down').length,
    not_configured: results.filter(r => r.status === 'not_configured').length,
  }

  return (
    <>
      {/* Summary strip */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={loadAll}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-semibold hover:border-white/30"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {loading ? 'Checking...' : 'Check all'}
        </button>
        {results.length > 0 && (
          <div className="flex items-center gap-3 text-[11px] font-mono">
            <SummaryPill count={summary.ok} label="ok" color="#34d399" />
            <SummaryPill count={summary.degraded} label="degraded" color="#fbbf24" />
            <SummaryPill count={summary.down} label="down" color="#f87171" />
            <SummaryPill count={summary.not_configured} label="not configured" color="#94a3b8" />
            {elapsed !== null && (
              <span className="text-white/30">· {(elapsed / 1000).toFixed(1)}s</span>
            )}
          </div>
        )}
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

      {/* Category sections */}
      {(['infra', 'ai', 'data', 'broker', 'comms'] as const).map(cat => {
        const items = byCategory[cat]
        if (items.length === 0) return null
        return (
          <CategorySection
            key={cat}
            category={cat}
            items={items}
            refreshingIds={refreshingIds}
            onRefresh={refreshOne}
          />
        )
      })}
    </>
  )
}

function SummaryPill({ count, label, color }: { count: number; label: string; color: string }) {
  if (count === 0) return null
  return (
    <span
      className="px-1.5 py-0.5 rounded uppercase tracking-widest text-[9px] font-bold"
      style={{ background: `${color}15`, color, border: `1px solid ${color}30` }}
    >
      {count} {label}
    </span>
  )
}

const CATEGORY_LABELS: Record<ApiCheckResult['category'], { title: string; Icon: typeof Cpu }> = {
  infra:  { title: 'Infrastructure',   Icon: Database },
  ai:     { title: 'AI providers',     Icon: Cpu },
  data:   { title: 'Market data',      Icon: BarChart3 },
  broker: { title: 'Brokers',          Icon: Briefcase },
  comms:  { title: 'Communications',   Icon: Mail },
}

function CategorySection({
  category, items, refreshingIds, onRefresh,
}: {
  category: ApiCheckResult['category']
  items: ApiCheckResult[]
  refreshingIds: Set<string>
  onRefresh: (id: string) => void
}) {
  const meta = CATEGORY_LABELS[category]
  return (
    <section>
      <div className="flex items-center gap-2 mb-2.5 px-1">
        <meta.Icon size={12} className="text-white/40" />
        <h2 className="text-xs font-bold uppercase tracking-widest text-white/55">{meta.title}</h2>
        <span className="text-[10px] font-mono text-white/30">({items.length})</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {items.map(item => (
          <HealthCard
            key={item.id}
            item={item}
            isRefreshing={refreshingIds.has(item.id)}
            onRefresh={() => onRefresh(item.id)}
          />
        ))}
      </div>
    </section>
  )
}

function HealthCard({
  item, isRefreshing, onRefresh,
}: {
  item: ApiCheckResult
  isRefreshing: boolean
  onRefresh: () => void
}) {
  const statusColor =
    item.status === 'ok'             ? '#34d399' :
    item.status === 'degraded'       ? '#fbbf24' :
    item.status === 'down'           ? '#f87171' :
    item.status === 'not_configured' ? '#94a3b8' :
                                       '#a78bfa'

  const StatusIcon =
    item.status === 'ok'             ? CheckCircle2 :
    item.status === 'degraded'       ? AlertTriangle :
    item.status === 'down'           ? XCircle :
    item.status === 'not_configured' ? MinusCircle :
                                       AlertCircle

  return (
    <div
      className="rounded-lg border p-3"
      style={{
        background: 'var(--surface)',
        borderColor: item.status === 'down'
          ? 'rgba(248,113,113,0.3)'
          : item.status === 'degraded'
          ? 'rgba(251,191,36,0.25)'
          : 'var(--border)',
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <StatusIcon size={14} style={{ color: statusColor }} className="shrink-0" />
          <span className="text-sm font-semibold truncate">{item.name}</span>
        </div>
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="text-white/30 hover:text-white/60 shrink-0"
        >
          <RefreshCw size={11} className={isRefreshing ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="flex items-center gap-3 text-[10px] font-mono text-white/40 flex-wrap">
        <span
          className="px-1.5 py-0.5 rounded uppercase tracking-widest text-[9px] font-bold"
          style={{ background: `${statusColor}15`, color: statusColor, border: `1px solid ${statusColor}30` }}
        >
          {item.status.replace('_', ' ')}
        </span>
        {item.latencyMs !== null && (
          <span>{item.latencyMs}ms</span>
        )}
        {item.httpStatus !== null && (
          <span>HTTP {item.httpStatus}</span>
        )}
        <span className="ml-auto text-white/25">{formatRelative(item.checkedAt)}</span>
      </div>
      {item.message && (
        <p className="text-[11px] text-white/50 mt-2 leading-relaxed">
          {item.message}
        </p>
      )}
    </div>
  )
}
