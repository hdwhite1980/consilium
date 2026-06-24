'use client'
// =============================================================
// app/auto-trader/dashboard/page.tsx
//
// Auto-trader monitoring dashboard. Shows live state, today's KPIs,
// open positions (joined Alpaca + Coinbase + our overlay), recent
// activity, skip reason breakdown, 30-day track record.
//
// Auto-refresh every 30s + manual refresh button.
// =============================================================

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'
import TradingRulesCard from '@/app/components/TradingRulesCard'
import {
  Activity, AlertTriangle, RefreshCw, CheckCircle, XCircle, Pause,
  TrendingUp, TrendingDown, Zap, Target, Shield, DollarSign, Clock,
  ChevronDown, ChevronUp, Settings, ExternalLink,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface DashboardSettings {
  enabled: boolean
  mode: 'paper' | 'live'
  halted: boolean
  haltReason: string | null
  haltedAt: string | null
  riskPerTradePct: number
  maxPositionPct: number
  maxDailyLossPct: number
  maxConcurrentPos: number
  maxConsecLosses: number
  minGrade: 'A' | 'B' | 'C'
  scannerEnabled: boolean
  scannerMaxConcurrent: number
  scannerMinComposite: number
  activeMgmtEnabled: boolean
  reevalDrawdownPct: number
  allowTightenStop: boolean
  allowEarlyExit: boolean
  allowAddPosition: boolean
  allowShorts: boolean
  tradeStocks: boolean
  tradeCrypto: boolean
  tradeForex: boolean
  tradeFutures: boolean
  tradeOptions: boolean
}

interface DashboardBroker {
  connected: boolean
  broker?: string
  mode?: string
  keyIdMasked?: string
  accountStatus?: string | null
  accountEquity?: number | null
  accountCash?: number | null
  lastValidatedAt?: string | null
}

interface DashboardKpis {
  total: number
  placed: number
  skipped: number
  rejected: number
  errors: number
  closedWin: number
  closedLoss: number
  closedBe: number
  realizedPnl: number
  winRate: number | null
  bySignalSource: { council: number; scanner: number; reeval: number }
}

interface Summary30d {
  totalClosed: number
  wins: number
  losses: number
  breakEvens: number
  winRate: number | null
  totalPnl: number
  avgWin: number | null
  avgLoss: number | null
  bySignalSource: { council: number; scanner: number }
}

interface RecentAttempt {
  id: string
  created_at: string
  ticker: string
  signal_source: string | null
  council_signal: string | null
  outcome: string
  side: string | null
  qty: number | null
  entry_price_est: number | null
  stop_price: number | null
  target_price: number | null
  filled_avg_price: number | null
  realized_pnl: number | null
  reject_reason: string | null
  mode: string | null
  broker_order_id: string | null
  reeval_count: number | null
  last_reeval_at: string | null
}

interface SkipBreakdownRow {
  category: string
  count: number
  sample: string
}

interface DashboardData {
  ok: boolean
  notSetup?: boolean
  message?: string
  settings?: DashboardSettings
  broker?: DashboardBroker
  todayKpis?: DashboardKpis
  summary30d?: Summary30d
  recent?: RecentAttempt[]
  skipBreakdown?: SkipBreakdownRow[]
}

interface PositionRow {
  ticker: string
  side: 'long' | 'short'
  qty: number
  avgEntry: number
  currentPrice: number
  marketValue: number
  unrealizedPl: number
  unrealizedPlPct: number
  attemptId?: string
  ourStop?: number
  ourTarget?: number
  signalSource?: string
  councilSignal?: string
  reevalCount?: number
  lastReevalAt?: string
  filledAt?: string
  // ADDED: asset-class discrimination so the table can show CRYPTO vs STOCK
  assetClass?: 'stock' | 'crypto'
  brokerName?: 'alpaca' | 'coinbase'
}

interface PositionsData {
  ok: boolean
  positions: PositionRow[]
  account: {
    status: string
    equity: number
    cash: number
    buyingPower: number
  } | null
  // ADDED: per-broker breakdown when both Alpaca and Coinbase are connected
  brokers?: Array<{
    broker: 'alpaca' | 'coinbase'
    account: {
      status: string
      equity: number
      cash: number
      buyingPower: number
    }
  }>
  message?: string
}

// ── Verdicts (today's Council pipeline) ──
interface VerdictsKpis {
  total: number
  takes: number
  passes: number
  waits: number
  bullish: number
  bearish: number
  takesBullish: number
  takesBearish: number
}

interface RecentVerdict {
  id: number
  ticker: string
  signal: string | null
  confidence: number | null
  trader_decision: string | null
  trader_grade: string | null
  trader_risk_reward: number | null
  entry_price: number | null
  stop_loss: number | null
  take_profit: number | null
  timeframe: string | null
  pass_reason_short: string | null
  created_at: string
}

interface PassReasonCategory {
  category: string
  count: number
  sample: string
}

interface VerdictsData {
  ok: boolean
  kpis: VerdictsKpis
  recent: RecentVerdict[]
  passReasons: PassReasonCategory[]
  error?: string
}

// ── Position-monitor activity (today) ──
interface MonitorKpis {
  total: number
  holds: number
  tightens: number
  exits: number
  escalates: number
  failures: number
}

interface RecentMonitorCheck {
  id: number
  ticker: string
  decision: string
  action_taken: string
  current_price: number | null
  current_stop: number | null
  new_stop_price: number | null
  bearish_15m: number | null
  bullish_15m: number | null
  bearish_5m: number | null
  bullish_5m: number | null
  error_reason: string | null
  created_at: string
}

interface PerTickerLatest {
  ticker: string
  latest_decision: string
  latest_action: string
  latest_at: string
  total_checks_today: number
  total_tightens: number
  total_exits: number
}

interface MonitorActivityData {
  ok: boolean
  kpis: MonitorKpis
  recent: RecentMonitorCheck[]
  perTicker: PerTickerLatest[]
  error?: string
}

// ── Reeval activity (after-hours + pre-market + morning crons) ──
interface ReevalKpis {
  total: number
  afterHoursChecks: number
  preMarketChecks: number
  morningChecks: number
  materialChanges: number
  councilEscalations: number
  ordersCancelled: number
  errors: number
}

interface RecentReeval {
  id: number
  trigger_source: string
  ticker: string
  kind: string
  verdict_log_id: number | null
  material: boolean
  material_reasons: string[]
  price_gap_pct: number | null
  current_price: number | null
  council_action: string | null
  council_thesis_status: string | null
  action_taken: string | null
  cancel_ok: boolean | null
  error_reason: string | null
  created_at: string
}

interface PerTriggerSummary {
  trigger_source: string
  total_checks: number
  material_count: number
  council_count: number
  cancel_count: number
  last_run_at: string
}

interface ReevalActivityData {
  ok: boolean
  kpis: ReevalKpis
  recent: RecentReeval[]
  perTrigger: PerTriggerSummary[]
  error?: string
}

const REFRESH_INTERVAL_MS = 30_000

// ─────────────────────────────────────────────────────────────
// Page component
// ─────────────────────────────────────────────────────────────

export default function AutoTraderDashboardPage() {
  const router = useRouter()
  const [authChecked, setAuthChecked] = useState(false)
  const [data, setData] = useState<DashboardData | null>(null)
  const [positions, setPositions] = useState<PositionsData | null>(null)
  const [verdicts, setVerdicts] = useState<VerdictsData | null>(null)
  const [monitor, setMonitor] = useState<MonitorActivityData | null>(null)
  const [reeval, setReeval] = useState<ReevalActivityData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [clearingHalt, setClearingHalt] = useState(false)
  const [expandedSection, setExpandedSection] = useState<string | null>('positions')
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Auth check
  useEffect(() => {
    let active = true
    ;(async () => {
      const supa = createClient()
      const { data: { user } } = await supa.auth.getUser()
      if (!active) return
      if (!user) {
        router.push('/')
        return
      }
      setAuthChecked(true)
    })()
    return () => { active = false }
  }, [router])

  // Fetch data
  const fetchAll = useCallback(async () => {
    try {
      setError(null)
      const [dashRes, posRes, verdRes, monRes, reevalRes] = await Promise.all([
        fetch('/api/auto-trader/dashboard', { cache: 'no-store' }),
        fetch('/api/auto-trader/positions', { cache: 'no-store' }),
        fetch('/api/auto-trader/dashboard/verdicts', { cache: 'no-store' }),
        fetch('/api/auto-trader/dashboard/monitor-activity', { cache: 'no-store' }),
        fetch('/api/auto-trader/dashboard/reeval-activity', { cache: 'no-store' }),
      ])

      if (!dashRes.ok) {
        const errBody = await dashRes.json().catch(() => ({})) as { error?: string }
        throw new Error(errBody.error || `dashboard returned ${dashRes.status}`)
      }
      if (!posRes.ok) {
        const errBody = await posRes.json().catch(() => ({})) as { error?: string }
        throw new Error(errBody.error || `positions returned ${posRes.status}`)
      }
      // verdicts/monitor/reeval are non-blocking — partial failure shouldn't break the page
      const dashData = await dashRes.json() as DashboardData
      const posData = await posRes.json() as PositionsData
      const verdData = verdRes.ok ? await verdRes.json() as VerdictsData : null
      const monData = monRes.ok ? await monRes.json() as MonitorActivityData : null
      const reevalData = reevalRes.ok ? await reevalRes.json() as ReevalActivityData : null
      setData(dashData)
      setPositions(posData)
      setVerdicts(verdData)
      setMonitor(monData)
      setReeval(reevalData)
      setLastUpdated(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!authChecked) return
    void fetchAll()
    refreshTimerRef.current = setInterval(() => { void fetchAll() }, REFRESH_INTERVAL_MS)
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    }
  }, [authChecked, fetchAll])

  const clearHalt = async () => {
    if (!confirm('Clear the halt? Auto-trading will resume on the next worker run if enabled.')) return
    setClearingHalt(true)
    try {
      const res = await fetch('/api/auto-trader/clear-halt', { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string }
        alert(`Failed: ${err.error ?? res.status}`)
      } else {
        await fetchAll()
      }
    } catch (e) {
      alert(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setClearingHalt(false)
    }
  }

  if (!authChecked) {
    return <div style={{ padding: 40, color: 'var(--text)' }}>Checking authentication...</div>
  }

  if (loading && !data) {
    return (
      <div style={{ padding: 40, background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh' }}>
        <div className="flex items-center gap-2">
          <RefreshCw size={16} className="animate-spin" />
          <span>Loading auto-trader dashboard...</span>
        </div>
      </div>
    )
  }

  return (
    <div style={{ background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh', padding: '20px 16px 40px' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>

        {/* Header */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Zap size={24} style={{ color: '#fbbf24' }} />
            <div>
              <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>Auto Trader Dashboard</h1>
              <p className="text-xs" style={{ color: 'var(--text3)' }}>
                {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Loading...'} · Auto-refresh 30s
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { void fetchAll() }}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all hover:opacity-80"
              style={{
                background: 'var(--surface)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
              }}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
            <button
              onClick={() => router.push('/settings/auto-trading')}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all hover:opacity-80"
              style={{
                background: 'var(--surface)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
              }}>
              <Settings size={12} />
              Settings
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mb-4 p-3 rounded-lg flex items-start gap-2"
            style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171' }}>
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div className="flex-1">
              <div className="text-xs font-semibold mb-0.5">Error loading data</div>
              <div className="text-xs opacity-80">{error}</div>
            </div>
          </div>
        )}

        {/* Not configured */}
        {data?.notSetup && (
          <div className="mb-4 p-4 rounded-lg"
            style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', color: '#fbbf24' }}>
            <div className="text-sm font-semibold mb-1">Auto-trader not configured</div>
            <div className="text-xs opacity-80 mb-3">{data.message}</div>
            <button
              onClick={() => router.push('/settings/auto-trading')}
              className="px-3 py-2 rounded-lg text-xs font-semibold"
              style={{ background: '#fbbf24', color: '#000' }}>
              Go to Settings →
            </button>
          </div>
        )}

        {data?.settings && (
          <>
            {/* Status banner */}
            <StatusBanner
              settings={data.settings}
              broker={data.broker}
              onClearHalt={clearHalt}
              clearingHalt={clearingHalt}
            />

            {/* Trading rules — user-editable toggles (master switch, shorts, asset filters) */}
            <TradingRulesCard
              rules={{
                enabled: data.settings.enabled,
                allowShorts: data.settings.allowShorts,
                tradeStocks: data.settings.tradeStocks,
                tradeCrypto: data.settings.tradeCrypto,
                tradeForex: data.settings.tradeForex,
                tradeFutures: data.settings.tradeFutures,
                tradeOptions: data.settings.tradeOptions,
              }}
              onChanged={() => { void fetchAll() }}
            />

            {/* KPI row */}
            {data.todayKpis && (
              <KpiRow kpis={data.todayKpis} mode={data.settings.mode} />
            )}

            {/* Account snapshot — now shows per-broker when multiple connected */}
            {positions?.account && (
              <AccountSnapshot
                account={positions.account}
                brokers={positions.brokers}
                mode={data.settings.mode}
              />
            )}

            {/* Open positions */}
            <Section
              title="Open Positions"
              icon={<TrendingUp size={14} />}
              expanded={expandedSection === 'positions'}
              onToggle={() => setExpandedSection(expandedSection === 'positions' ? null : 'positions')}
              count={positions?.positions?.length ?? 0}
              color="#34d399">
              <OpenPositionsTable positions={positions?.positions ?? []} />
            </Section>

            {/* Today's verdicts (Council pipeline) */}
            <Section
              title="Today's Verdicts"
              icon={<Zap size={14} />}
              expanded={expandedSection === 'verdicts'}
              onToggle={() => setExpandedSection(expandedSection === 'verdicts' ? null : 'verdicts')}
              count={verdicts?.kpis.total ?? 0}
              color="#60a5fa">
              <VerdictsPanel data={verdicts} />
            </Section>

            {/* Position-monitor activity (today) */}
            <Section
              title="Position-Monitor Activity"
              icon={<Shield size={14} />}
              expanded={expandedSection === 'monitor'}
              onToggle={() => setExpandedSection(expandedSection === 'monitor' ? null : 'monitor')}
              count={monitor?.kpis.total ?? 0}
              color="#a78bfa">
              <MonitorActivityPanel data={monitor} />
            </Section>

            {/* Reeval activity (after-hours + pre-market + morning crons) */}
            <Section
              title="Reeval Activity"
              icon={<Clock size={14} />}
              expanded={expandedSection === 'reeval'}
              onToggle={() => setExpandedSection(expandedSection === 'reeval' ? null : 'reeval')}
              count={reeval?.kpis.total ?? 0}
              color="#22d3ee">
              <ReevalActivityPanel data={reeval} />
            </Section>

            {/* Recent activity */}
            <Section
              title="Recent Activity"
              icon={<Activity size={14} />}
              expanded={expandedSection === 'recent'}
              onToggle={() => setExpandedSection(expandedSection === 'recent' ? null : 'recent')}
              count={data.recent?.length ?? 0}
              color="#60a5fa">
              <RecentTable rows={data.recent ?? []} />
            </Section>

            {/* Skip breakdown */}
            <Section
              title="Skipped Trades (7d)"
              icon={<Pause size={14} />}
              expanded={expandedSection === 'skips'}
              onToggle={() => setExpandedSection(expandedSection === 'skips' ? null : 'skips')}
              count={data.skipBreakdown?.reduce((s, r) => s + r.count, 0) ?? 0}
              color="#a78bfa">
              <SkipBreakdownTable rows={data.skipBreakdown ?? []} />
            </Section>

            {/* 30-day track record */}
            {data.summary30d && (
              <Section
                title="30-Day Track Record"
                icon={<Target size={14} />}
                expanded={expandedSection === 'track'}
                onToggle={() => setExpandedSection(expandedSection === 'track' ? null : 'track')}
                count={data.summary30d.totalClosed}
                color="#fbbf24">
                <TrackRecord30 summary={data.summary30d} />
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────

function StatusBanner({
  settings, broker, onClearHalt, clearingHalt,
}: {
  settings: DashboardSettings
  broker?: DashboardBroker
  onClearHalt: () => void
  clearingHalt: boolean
}) {
  // Three states: halted (red), disabled (gray), running (green)
  const state = settings.halted ? 'halted'
              : !settings.enabled ? 'disabled'
              : 'running'
  const stateConfig = {
    halted: { bg: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.2)', color: '#f87171', label: 'HALTED', icon: <XCircle size={14} /> },
    disabled: { bg: 'rgba(156,163,175,0.08)', border: 'rgba(156,163,175,0.2)', color: '#9ca3af', label: 'DISABLED', icon: <Pause size={14} /> },
    running: { bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.2)', color: '#34d399', label: 'RUNNING', icon: <CheckCircle size={14} /> },
  }[state]

  return (
    <div className="mb-4 p-4 rounded-xl"
      style={{ background: stateConfig.bg, border: `1px solid ${stateConfig.border}` }}>
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-start gap-3">
          <div style={{ color: stateConfig.color }} className="mt-0.5">{stateConfig.icon}</div>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-bold" style={{ color: stateConfig.color }}>{stateConfig.label}</span>
              <span className="text-xs px-2 py-0.5 rounded-md font-mono"
                style={{
                  background: settings.mode === 'live' ? 'rgba(248,113,113,0.15)' : 'rgba(96,165,250,0.15)',
                  color: settings.mode === 'live' ? '#f87171' : '#60a5fa',
                }}>
                {settings.mode.toUpperCase()}
              </span>
            </div>
            {settings.halted && settings.haltReason && (
              <div className="text-xs mb-1" style={{ color: 'var(--text2)' }}>
                <span className="font-semibold">Reason:</span> {settings.haltReason}
                {settings.haltedAt && (
                  <span className="opacity-60"> · {new Date(settings.haltedAt).toLocaleString()}</span>
                )}
              </div>
            )}
            <div className="text-xs flex flex-wrap gap-x-3 gap-y-1" style={{ color: 'var(--text3)' }}>
              <span>Risk: <strong>{(settings.riskPerTradePct * 100).toFixed(2)}%/trade</strong></span>
              <span>Daily loss limit: <strong>{(settings.maxDailyLossPct * 100).toFixed(1)}%</strong></span>
              <span>Max positions: <strong>{settings.maxConcurrentPos}</strong></span>
              <span>Grade floor: <strong>{settings.minGrade}</strong></span>
              <span>Scanner: <strong style={{ color: settings.scannerEnabled ? '#34d399' : '#9ca3af' }}>{settings.scannerEnabled ? 'ON' : 'OFF'}</strong></span>
              <span>Active mgmt: <strong style={{ color: settings.activeMgmtEnabled ? '#34d399' : '#9ca3af' }}>{settings.activeMgmtEnabled ? 'ON' : 'OFF'}</strong></span>
              <span>Shorts: <strong style={{ color: settings.allowShorts ? '#34d399' : '#9ca3af' }}>{settings.allowShorts ? 'ON' : 'OFF'}</strong></span>
            </div>
            {broker?.connected && (
              <div className="text-xs mt-1" style={{ color: 'var(--text3)' }}>
                Broker: <strong>{broker.broker} {broker.mode}</strong> · Key <code>{broker.keyIdMasked}</code> · Status <strong>{broker.accountStatus ?? '?'}</strong>
              </div>
            )}
          </div>
        </div>
        {settings.halted && (
          <button
            onClick={onClearHalt}
            disabled={clearingHalt}
            className="px-3 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-80"
            style={{ background: '#f87171', color: '#000' }}>
            {clearingHalt ? 'Clearing...' : 'Clear Halt'}
          </button>
        )}
      </div>
    </div>
  )
}

function KpiRow({ kpis, mode }: { kpis: DashboardKpis; mode: 'paper' | 'live' }) {
  const pnlColor = kpis.realizedPnl > 0 ? '#34d399' : kpis.realizedPnl < 0 ? '#f87171' : 'var(--text3)'
  const cards: Array<{ label: string; value: string; sub?: string; color: string }> = [
    { label: 'Attempts today', value: kpis.total.toString(), sub: `${kpis.placed} placed · ${kpis.skipped} skipped`, color: '#60a5fa' },
    { label: 'Closed today', value: (kpis.closedWin + kpis.closedLoss + kpis.closedBe).toString(), sub: `${kpis.closedWin}W · ${kpis.closedLoss}L · ${kpis.closedBe}BE`, color: '#a78bfa' },
    { label: 'Realized P&L', value: `${kpis.realizedPnl >= 0 ? '+' : ''}$${kpis.realizedPnl.toFixed(2)}`, sub: mode === 'paper' ? 'paper money' : 'live', color: pnlColor },
    { label: 'Win rate today', value: kpis.winRate !== null ? `${kpis.winRate.toFixed(0)}%` : '—', sub: kpis.winRate !== null ? `of ${kpis.closedWin + kpis.closedLoss + kpis.closedBe} closed` : 'no closed trades', color: '#fbbf24' },
    { label: 'Errors today', value: kpis.errors.toString(), sub: kpis.errors > 0 ? 'check logs' : 'clean', color: kpis.errors > 0 ? '#f87171' : '#34d399' },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
      {cards.map(c => (
        <div key={c.label} className="p-3 rounded-lg"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="text-xs opacity-60 mb-1" style={{ color: 'var(--text3)' }}>{c.label}</div>
          <div className="text-lg font-bold" style={{ color: c.color }}>{c.value}</div>
          {c.sub && <div className="text-xs opacity-70 mt-0.5" style={{ color: 'var(--text3)' }}>{c.sub}</div>}
        </div>
      ))}
    </div>
  )
}

function AccountSnapshot({
  account, brokers, mode,
}: {
  account: { status: string; equity: number; cash: number; buyingPower: number }
  brokers?: PositionsData['brokers']
  mode: string
}) {
  const hasMultipleBrokers = brokers && brokers.length > 1

  return (
    <>
      {/* Combined snapshot — same as before, slight relabel when multiple brokers */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        <div className="p-3 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="text-xs opacity-60 mb-1" style={{ color: 'var(--text3)' }}>Status</div>
          <div className="text-sm font-bold" style={{ color: account.status === 'ACTIVE' ? '#34d399' : '#f87171' }}>
            {account.status}
          </div>
          <div className="text-xs opacity-70 mt-0.5" style={{ color: 'var(--text3)' }}>{mode}</div>
        </div>
        <div className="p-3 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="text-xs opacity-60 mb-1" style={{ color: 'var(--text3)' }}>
            {hasMultipleBrokers ? 'Total Equity' : 'Equity'}
          </div>
          <div className="text-sm font-bold" style={{ color: 'var(--text)' }}>${account.equity.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        </div>
        <div className="p-3 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="text-xs opacity-60 mb-1" style={{ color: 'var(--text3)' }}>
            {hasMultipleBrokers ? 'Total Cash' : 'Cash'}
          </div>
          <div className="text-sm font-bold" style={{ color: 'var(--text)' }}>${account.cash.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        </div>
        <div className="p-3 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="text-xs opacity-60 mb-1" style={{ color: 'var(--text3)' }}>Buying power</div>
          <div className="text-sm font-bold" style={{ color: 'var(--text)' }}>${account.buyingPower.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        </div>
      </div>

      {/* Per-broker breakdown — only shown when both Alpaca and Coinbase connected */}
      {hasMultipleBrokers && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-4">
          {brokers!.map(b => (
            <div key={b.broker}
              className="p-3 rounded-lg flex items-center justify-between"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
              <div>
                <div className="text-xs opacity-60 mb-1" style={{ color: 'var(--text3)' }}>
                  {b.broker === 'coinbase' ? 'Coinbase (live)' : 'Alpaca (paper)'}
                </div>
                <div className="text-sm font-bold" style={{ color: 'var(--text)' }}>
                  ${b.account.cash.toFixed(2)} cash · ${b.account.equity.toFixed(2)} equity
                </div>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-md font-mono"
                style={{
                  background: b.account.status === 'ACTIVE' ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)',
                  color: b.account.status === 'ACTIVE' ? '#34d399' : '#f87171',
                }}>
                {b.account.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function Section({
  title, icon, expanded, onToggle, count, color, children,
}: {
  title: string
  icon: React.ReactNode
  expanded: boolean
  onToggle: () => void
  count: number
  color: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-3 rounded-xl overflow-hidden"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-3 hover:opacity-90"
        style={{ background: 'transparent', color: 'var(--text)' }}>
        <div className="flex items-center gap-2">
          <div style={{ color }}>{icon}</div>
          <span className="text-sm font-semibold">{title}</span>
          <span className="text-xs px-2 py-0.5 rounded-md font-mono"
            style={{ background: `${color}20`, color }}>
            {count}
          </span>
        </div>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {children}
        </div>
      )}
    </div>
  )
}

function OpenPositionsTable({ positions }: { positions: PositionRow[] }) {
  if (positions.length === 0) {
    return <div className="p-6 text-center text-xs" style={{ color: 'var(--text3)' }}>No open positions.</div>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="w-full text-xs">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <Th>Ticker</Th>
            <Th>Asset</Th>
            <Th>Side</Th>
            <Th>Qty</Th>
            <Th>Entry</Th>
            <Th>Current</Th>
            <Th>Stop</Th>
            <Th>Target</Th>
            <Th>P/L</Th>
            <Th>P/L %</Th>
            <Th>Source</Th>
            <Th>Reeval</Th>
          </tr>
        </thead>
        <tbody>
          {positions.map(p => (
            <tr key={`${p.ticker}-${p.brokerName ?? 'unknown'}`} style={{ borderBottom: '1px solid var(--border)' }}>
              <Td><strong>{p.ticker}</strong></Td>
              <Td>
                {p.assetClass && p.brokerName ? (
                  <span className="text-xs px-1.5 py-0.5 rounded font-mono"
                    style={{
                      background: p.assetClass === 'crypto' ? 'rgba(251,191,36,0.15)' : 'rgba(96,165,250,0.15)',
                      color: p.assetClass === 'crypto' ? '#fbbf24' : '#60a5fa',
                    }}>
                    {p.assetClass === 'crypto' ? 'CRYPTO' : 'STOCK'}
                    {p.brokerName === 'coinbase' && <span className="opacity-60"> · CB</span>}
                  </span>
                ) : (
                  <span style={{ color: 'var(--text3)' }}>—</span>
                )}
              </Td>
              <Td>
                <span style={{ color: p.side === 'long' ? '#34d399' : '#f87171' }}>
                  {p.side.toUpperCase()}
                </span>
              </Td>
              <Td>{p.qty}</Td>
              <Td>${p.avgEntry.toFixed(2)}</Td>
              <Td>${p.currentPrice.toFixed(2)}</Td>
              <Td>{p.ourStop !== undefined ? `$${p.ourStop.toFixed(2)}` : '—'}</Td>
              <Td>{p.ourTarget !== undefined ? `$${p.ourTarget.toFixed(2)}` : '—'}</Td>
              <Td style={{ color: p.unrealizedPl > 0 ? '#34d399' : p.unrealizedPl < 0 ? '#f87171' : 'var(--text3)' }}>
                {p.unrealizedPl >= 0 ? '+' : ''}${p.unrealizedPl.toFixed(2)}
              </Td>
              <Td style={{ color: p.unrealizedPlPct > 0 ? '#34d399' : p.unrealizedPlPct < 0 ? '#f87171' : 'var(--text3)' }}>
                {p.unrealizedPlPct >= 0 ? '+' : ''}{p.unrealizedPlPct.toFixed(2)}%
              </Td>
              <Td>
                {p.signalSource && (
                  <span className="text-xs px-1.5 py-0.5 rounded font-mono"
                    style={{
                      background: p.signalSource === 'council' ? 'rgba(167,139,250,0.15)' : 'rgba(251,191,36,0.15)',
                      color: p.signalSource === 'council' ? '#a78bfa' : '#fbbf24',
                    }}>
                    {p.signalSource}
                  </span>
                )}
              </Td>
              <Td>
                {p.reevalCount !== undefined && p.reevalCount > 0
                  ? <span title={p.lastReevalAt ?? ''}>{p.reevalCount}×</span>
                  : <span style={{ color: 'var(--text3)' }}>—</span>}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RecentTable({ rows }: { rows: RecentAttempt[] }) {
  if (rows.length === 0) {
    return <div className="p-6 text-center text-xs" style={{ color: 'var(--text3)' }}>No recent activity.</div>
  }
  return (
    <div style={{ overflowX: 'auto', maxHeight: 600 }}>
      <table className="w-full text-xs">
        <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)' }}>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <Th>Time</Th>
            <Th>Ticker</Th>
            <Th>Source</Th>
            <Th>Outcome</Th>
            <Th>Side</Th>
            <Th>Qty</Th>
            <Th>Entry</Th>
            <Th>P&L</Th>
            <Th>Reason</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <Td>
                <span style={{ color: 'var(--text3)' }}>
                  {new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </Td>
              <Td><strong>{r.ticker}</strong></Td>
              <Td>
                {r.signal_source && (
                  <span className="text-xs px-1.5 py-0.5 rounded font-mono"
                    style={{
                      background: r.signal_source === 'council' ? 'rgba(167,139,250,0.15)'
                                : r.signal_source === 'scanner' ? 'rgba(251,191,36,0.15)'
                                : 'rgba(96,165,250,0.15)',
                      color: r.signal_source === 'council' ? '#a78bfa'
                           : r.signal_source === 'scanner' ? '#fbbf24'
                           : '#60a5fa',
                    }}>
                    {r.signal_source}
                  </span>
                )}
              </Td>
              <Td><OutcomeBadge outcome={r.outcome} /></Td>
              <Td>{r.side ?? '—'}</Td>
              <Td>{r.qty ?? '—'}</Td>
              <Td>{r.entry_price_est !== null ? `$${Number(r.entry_price_est).toFixed(2)}` : '—'}</Td>
              <Td style={{ color: (r.realized_pnl ?? 0) > 0 ? '#34d399' : (r.realized_pnl ?? 0) < 0 ? '#f87171' : 'var(--text3)' }}>
                {r.realized_pnl !== null ? `${Number(r.realized_pnl) >= 0 ? '+' : ''}$${Number(r.realized_pnl).toFixed(2)}` : '—'}
              </Td>
              <Td>
                <span style={{ color: 'var(--text3)' }} title={r.reject_reason ?? ''}>
                  {r.reject_reason ? (r.reject_reason.length > 60 ? r.reject_reason.slice(0, 60) + '…' : r.reject_reason) : '—'}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SkipBreakdownTable({ rows }: { rows: SkipBreakdownRow[] }) {
  if (rows.length === 0) {
    return <div className="p-6 text-center text-xs" style={{ color: 'var(--text3)' }}>No skipped trades in last 7 days.</div>
  }
  const total = rows.reduce((s, r) => s + r.count, 0)
  return (
    <div style={{ padding: '8px 12px' }}>
      {rows.map(r => (
        <div key={r.category} className="flex items-center justify-between py-2"
          style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex-1 min-w-0 pr-3">
            <div className="text-xs font-semibold" style={{ color: 'var(--text)' }}>{r.category}</div>
            <div className="text-xs mt-0.5 opacity-60" style={{ color: 'var(--text3)' }}>
              e.g. {r.sample.length > 100 ? r.sample.slice(0, 100) + '…' : r.sample}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-sm font-bold" style={{ color: '#a78bfa' }}>{r.count}</div>
            <div className="text-xs opacity-60" style={{ color: 'var(--text3)' }}>{((r.count / total) * 100).toFixed(0)}%</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function TrackRecord30({ summary }: { summary: Summary30d }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-3">
      <Stat label="Closed trades" value={summary.totalClosed.toString()} sub={`${summary.bySignalSource.council} council · ${summary.bySignalSource.scanner} scanner`} />
      <Stat
        label="Win rate"
        value={summary.winRate !== null ? `${summary.winRate.toFixed(0)}%` : '—'}
        sub={`${summary.wins}W · ${summary.losses}L · ${summary.breakEvens}BE`}
        color={summary.winRate !== null && summary.winRate >= 50 ? '#34d399' : summary.winRate !== null ? '#f87171' : 'var(--text3)'}
      />
      <Stat
        label="Total P&L"
        value={`${summary.totalPnl >= 0 ? '+' : ''}$${summary.totalPnl.toFixed(2)}`}
        sub="30 days"
        color={summary.totalPnl > 0 ? '#34d399' : summary.totalPnl < 0 ? '#f87171' : 'var(--text3)'}
      />
      <Stat
        label="Avg win / avg loss"
        value={
          summary.avgWin !== null && summary.avgLoss !== null
            ? `+$${summary.avgWin.toFixed(0)} / $${summary.avgLoss.toFixed(0)}`
            : '—'
        }
        sub="per trade"
      />
    </div>
  )
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="p-2 rounded-lg" style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
      <div className="text-xs opacity-60 mb-1" style={{ color: 'var(--text3)' }}>{label}</div>
      <div className="text-sm font-bold" style={{ color: color ?? 'var(--text)' }}>{value}</div>
      {sub && <div className="text-xs opacity-70 mt-0.5" style={{ color: 'var(--text3)' }}>{sub}</div>}
    </div>
  )
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const config = (() => {
    if (outcome === 'placed' || outcome === 'filled' || outcome === 'partial_fill') return { bg: 'rgba(52,211,153,0.15)', color: '#34d399' }
    if (outcome === 'skipped') return { bg: 'rgba(167,139,250,0.15)', color: '#a78bfa' }
    if (outcome === 'rejected' || outcome === 'error') return { bg: 'rgba(248,113,113,0.15)', color: '#f87171' }
    if (outcome === 'cancelled') return { bg: 'rgba(156,163,175,0.15)', color: '#9ca3af' }
    if (outcome === 'closed_win') return { bg: 'rgba(52,211,153,0.2)', color: '#34d399' }
    if (outcome === 'closed_loss') return { bg: 'rgba(248,113,113,0.2)', color: '#f87171' }
    if (outcome === 'closed_be') return { bg: 'rgba(156,163,175,0.2)', color: '#9ca3af' }
    if (outcome.startsWith('reeval_')) return { bg: 'rgba(96,165,250,0.15)', color: '#60a5fa' }
    return { bg: 'var(--surface)', color: 'var(--text)' }
  })()
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-mono"
      style={{ background: config.bg, color: config.color }}>
      {outcome}
    </span>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left p-2 font-semibold opacity-70" style={{ color: 'var(--text3)' }}>{children}</th>
}

function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td className="p-2" style={style}>{children}</td>
}

// ─────────────────────────────────────────────────────────────
// Verdicts (today's Council pipeline)
// ─────────────────────────────────────────────────────────────

function VerdictsPanel({ data }: { data: VerdictsData | null }) {
  if (!data) {
    return <div className="p-4 text-xs opacity-60" style={{ color: 'var(--text3)' }}>Loading verdicts…</div>
  }
  if (!data.ok && data.error) {
    return (
      <div className="p-4 text-xs" style={{ color: '#f87171' }}>
        Failed to load: {data.error}
      </div>
    )
  }
  if (data.kpis.total === 0) {
    return <div className="p-4 text-xs opacity-60" style={{ color: 'var(--text3)' }}>No verdicts today yet.</div>
  }
  return (
    <div className="space-y-3">
      {/* KPI row */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 p-2">
        <Stat label="Total" value={String(data.kpis.total)} />
        <Stat label="TAKE" value={String(data.kpis.takes)} color="#34d399" />
        <Stat label="PASS" value={String(data.kpis.passes)} color="#f87171" />
        <Stat label="WAIT" value={String(data.kpis.waits)} color="#fbbf24" />
        <Stat label="Bullish" value={`${data.kpis.takesBullish}/${data.kpis.bullish}`} sub="taken / total" color="#34d399" />
        <Stat label="Bearish" value={`${data.kpis.takesBearish}/${data.kpis.bearish}`} sub="taken / total" color="#f87171" />
      </div>

      {/* Pass reason categories */}
      {data.passReasons.length > 0 && (
        <div className="p-2">
          <div className="text-xs font-semibold mb-2 opacity-70" style={{ color: 'var(--text3)' }}>
            Why blocked
          </div>
          <div className="flex flex-wrap gap-2">
            {data.passReasons.map(p => (
              <div key={p.category}
                className="px-2 py-1 rounded-md text-xs flex items-center gap-2"
                style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
                title={p.sample}>
                <span className="font-mono opacity-60" style={{ color: 'var(--text3)' }}>{p.category}</span>
                <span className="font-bold">{p.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent verdicts table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <Th>Time</Th>
              <Th>Ticker</Th>
              <Th>Signal</Th>
              <Th>Conf</Th>
              <Th>Decision</Th>
              <Th>R:R</Th>
              <Th>Entry → Target / Stop</Th>
              <Th>Note</Th>
            </tr>
          </thead>
          <tbody>
            {data.recent.map(v => (
              <tr key={v.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <Td>
                  <span className="font-mono opacity-70" style={{ color: 'var(--text3)' }}>
                    {new Date(v.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </Td>
                <Td><span className="font-bold">{v.ticker}</span></Td>
                <Td>
                  <SignalBadge signal={v.signal} />
                </Td>
                <Td><span className="font-mono">{v.confidence ?? '—'}%</span></Td>
                <Td><DecisionBadge decision={v.trader_decision} grade={v.trader_grade} /></Td>
                <Td>
                  <span className="font-mono" style={{
                    color: v.trader_risk_reward !== null && v.trader_risk_reward < 1.5
                      ? '#f87171' : 'var(--text)',
                  }}>
                    {v.trader_risk_reward !== null ? `${v.trader_risk_reward.toFixed(2)}:1` : '—'}
                  </span>
                </Td>
                <Td>
                  <span className="font-mono opacity-80">
                    {v.entry_price !== null
                      ? `$${v.entry_price.toFixed(2)} → $${(v.take_profit ?? 0).toFixed(2)} / $${(v.stop_loss ?? 0).toFixed(2)}`
                      : '—'}
                  </span>
                </Td>
                <Td>
                  <span className="text-xs opacity-70" style={{ color: 'var(--text3)' }}>
                    {v.pass_reason_short ?? ''}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SignalBadge({ signal }: { signal: string | null }) {
  if (!signal) return <span className="opacity-50">—</span>
  const isBull = signal === 'BULLISH'
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-mono"
      style={{
        background: isBull ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)',
        color: isBull ? '#34d399' : '#f87171',
      }}>
      {isBull ? '↑' : '↓'} {signal.slice(0, 4)}
    </span>
  )
}

function DecisionBadge({ decision, grade }: { decision: string | null; grade: string | null }) {
  if (!decision) return <span className="opacity-50">—</span>
  const config = (() => {
    if (decision === 'TAKE') return { bg: 'rgba(52,211,153,0.2)', color: '#34d399' }
    if (decision === 'PASS') return { bg: 'rgba(248,113,113,0.15)', color: '#f87171' }
    if (decision === 'WAIT') return { bg: 'rgba(251,191,36,0.15)', color: '#fbbf24' }
    return { bg: 'var(--surface)', color: 'var(--text)' }
  })()
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-mono font-bold"
      style={{ background: config.bg, color: config.color }}>
      {decision}{grade ? ` ${grade}` : ''}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
// Position-Monitor Activity
// ─────────────────────────────────────────────────────────────

function MonitorActivityPanel({ data }: { data: MonitorActivityData | null }) {
  if (!data) {
    return <div className="p-4 text-xs opacity-60" style={{ color: 'var(--text3)' }}>Loading monitor activity…</div>
  }
  if (!data.ok && data.error) {
    return (
      <div className="p-4 text-xs" style={{ color: '#f87171' }}>
        Failed to load: {data.error}
      </div>
    )
  }
  if (data.kpis.total === 0) {
    return <div className="p-4 text-xs opacity-60" style={{ color: 'var(--text3)' }}>No monitor checks today yet.</div>
  }
  return (
    <div className="space-y-3">
      {/* KPI row */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 p-2">
        <Stat label="Checks" value={String(data.kpis.total)} />
        <Stat label="HOLD" value={String(data.kpis.holds)} color="#9ca3af" />
        <Stat label="TIGHTEN" value={String(data.kpis.tightens)} color="#fbbf24" />
        <Stat label="EXIT" value={String(data.kpis.exits)} color="#f87171" />
        <Stat label="ESCALATE" value={String(data.kpis.escalates)} color="#a78bfa" />
        <Stat label="Failures" value={String(data.kpis.failures)} color={data.kpis.failures > 0 ? '#f87171' : 'var(--text3)'} />
      </div>

      {/* Per-ticker summary */}
      {data.perTicker.length > 0 && (
        <div className="p-2">
          <div className="text-xs font-semibold mb-2 opacity-70" style={{ color: 'var(--text3)' }}>
            Today by ticker
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {data.perTicker.map(t => (
              <div key={t.ticker}
                className="p-2 rounded-md flex items-center justify-between"
                style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2">
                  <span className="font-bold">{t.ticker}</span>
                  <MonitorDecisionBadge decision={t.latest_decision} action={t.latest_action} />
                </div>
                <div className="text-xs opacity-70 font-mono" style={{ color: 'var(--text3)' }}>
                  {t.total_checks_today} checks
                  {t.total_tightens > 0 ? ` · ${t.total_tightens} tighten` : ''}
                  {t.total_exits > 0 ? ` · ${t.total_exits} exit` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent checks table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <Th>Time</Th>
              <Th>Ticker</Th>
              <Th>Decision</Th>
              <Th>Price</Th>
              <Th>Stop</Th>
              <Th>15m b/u</Th>
              <Th>5m b/u</Th>
              <Th>Note</Th>
            </tr>
          </thead>
          <tbody>
            {data.recent.map(c => (
              <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <Td>
                  <span className="font-mono opacity-70" style={{ color: 'var(--text3)' }}>
                    {new Date(c.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </Td>
                <Td><span className="font-bold">{c.ticker}</span></Td>
                <Td><MonitorDecisionBadge decision={c.decision} action={c.action_taken} /></Td>
                <Td>
                  <span className="font-mono">{c.current_price !== null ? `$${c.current_price.toFixed(2)}` : '—'}</span>
                </Td>
                <Td>
                  <span className="font-mono opacity-80">
                    {c.current_stop !== null ? `$${c.current_stop.toFixed(2)}` : '—'}
                    {c.new_stop_price !== null && c.new_stop_price !== c.current_stop
                      ? <span style={{ color: '#fbbf24' }}> → ${c.new_stop_price.toFixed(2)}</span>
                      : null}
                  </span>
                </Td>
                <Td>
                  <span className="font-mono">
                    <span style={{ color: '#f87171' }}>{c.bearish_15m ?? '—'}</span>
                    /
                    <span style={{ color: '#34d399' }}>{c.bullish_15m ?? '—'}</span>
                  </span>
                </Td>
                <Td>
                  <span className="font-mono">
                    <span style={{ color: '#f87171' }}>{c.bearish_5m ?? '—'}</span>
                    /
                    <span style={{ color: '#34d399' }}>{c.bullish_5m ?? '—'}</span>
                  </span>
                </Td>
                <Td>
                  <span className="text-xs opacity-70" style={{ color: c.error_reason ? '#f87171' : 'var(--text3)' }}>
                    {c.error_reason ?? ''}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function MonitorDecisionBadge({ decision, action }: { decision: string; action: string }) {
  const isFailed = action.endsWith('_failed') || action === 'error'
  const config = (() => {
    if (isFailed) return { bg: 'rgba(248,113,113,0.2)', color: '#f87171', label: `${decision}!` }
    if (decision === 'HOLD') return { bg: 'rgba(156,163,175,0.15)', color: '#9ca3af', label: 'HOLD' }
    if (decision === 'TIGHTEN_STOP') return { bg: 'rgba(251,191,36,0.2)', color: '#fbbf24', label: 'TIGHTEN' }
    if (decision === 'EXIT') return { bg: 'rgba(248,113,113,0.2)', color: '#f87171', label: 'EXIT' }
    if (decision === 'ESCALATE') return { bg: 'rgba(167,139,250,0.2)', color: '#a78bfa', label: 'ESCALATE' }
    return { bg: 'var(--surface)', color: 'var(--text)', label: decision }
  })()
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-mono font-bold"
      style={{ background: config.bg, color: config.color }}>
      {config.label}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
// Reeval Activity (after-hours + pre-market + morning crons)
// ─────────────────────────────────────────────────────────────

function ReevalActivityPanel({ data }: { data: ReevalActivityData | null }) {
  if (!data) {
    return <div className="p-4 text-xs opacity-60" style={{ color: 'var(--text3)' }}>Loading reeval activity…</div>
  }
  if (!data.ok && data.error) {
    return (
      <div className="p-4 text-xs" style={{ color: '#f87171' }}>
        Failed to load: {data.error}
      </div>
    )
  }
  if (data.kpis.total === 0) {
    return (
      <div className="p-4 text-xs opacity-60" style={{ color: 'var(--text3)' }}>
        No reeval activity today yet.
        <span className="block mt-1 opacity-75">
          Crons fire at: 12:30 UTC (pre-market), 13:35 UTC (morning), 21:30 UTC (after-hours)
        </span>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {/* KPI row */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 p-2">
        <Stat label="Checks" value={String(data.kpis.total)} />
        <Stat label="Pre-Market" value={String(data.kpis.preMarketChecks)} color="#60a5fa" />
        <Stat label="Morning" value={String(data.kpis.morningChecks)} color="#34d399" />
        <Stat label="After-Hours" value={String(data.kpis.afterHoursChecks)} color="#a78bfa" />
        <Stat label="Material" value={String(data.kpis.materialChanges)} color="#fbbf24" />
        <Stat label="Cancelled" value={String(data.kpis.ordersCancelled)} color={data.kpis.ordersCancelled > 0 ? '#f87171' : 'var(--text3)'} />
      </div>

      {/* Per-trigger summary */}
      {data.perTrigger.length > 0 && (
        <div className="p-2">
          <div className="text-xs font-semibold mb-2 opacity-70" style={{ color: 'var(--text3)' }}>
            Today by cron run
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {data.perTrigger.map(t => (
              <div key={t.trigger_source}
                className="p-2 rounded-md flex flex-col gap-1"
                style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
                <div className="flex items-center justify-between">
                  <ReevalTriggerBadge trigger={t.trigger_source} />
                  <span className="text-xs opacity-70 font-mono" style={{ color: 'var(--text3)' }}>
                    {new Date(t.last_run_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="text-xs opacity-70 font-mono" style={{ color: 'var(--text3)' }}>
                  {t.total_checks} checks
                  {t.material_count > 0 ? ` · ${t.material_count} material` : ''}
                  {t.council_count > 0 ? ` · ${t.council_count} council` : ''}
                  {t.cancel_count > 0 ? ` · ${t.cancel_count} cancelled` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent reeval checks table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <Th>Time</Th>
              <Th>Cron</Th>
              <Th>Ticker</Th>
              <Th>Kind</Th>
              <Th>Material?</Th>
              <Th>Gap %</Th>
              <Th>Council</Th>
              <Th>Action</Th>
              <Th>Note</Th>
            </tr>
          </thead>
          <tbody>
            {data.recent.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <Td>
                  <span className="font-mono opacity-70" style={{ color: 'var(--text3)' }}>
                    {new Date(r.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </Td>
                <Td><ReevalTriggerBadge trigger={r.trigger_source} /></Td>
                <Td><span className="font-bold">{r.ticker}</span></Td>
                <Td>
                  <span className="text-xs opacity-80 font-mono">
                    {r.kind === 'open_position' ? 'POS' : 'HELD'}
                  </span>
                </Td>
                <Td>
                  {r.material
                    ? <span className="text-xs px-1.5 py-0.5 rounded font-mono font-bold"
                        style={{ background: 'rgba(251,191,36,0.2)', color: '#fbbf24' }}>YES</span>
                    : <span className="text-xs opacity-60" style={{ color: 'var(--text3)' }}>no</span>}
                </Td>
                <Td>
                  <span className="font-mono" style={{
                    color: r.price_gap_pct !== null && Math.abs(r.price_gap_pct) > 2
                      ? '#fbbf24' : 'var(--text)',
                  }}>
                    {r.price_gap_pct !== null ? `${r.price_gap_pct > 0 ? '+' : ''}${r.price_gap_pct.toFixed(2)}%` : '—'}
                  </span>
                </Td>
                <Td><ReevalCouncilBadge action={r.council_action} thesis={r.council_thesis_status} /></Td>
                <Td><ReevalActionBadge action={r.action_taken} cancelOk={r.cancel_ok} /></Td>
                <Td>
                  <span className="text-xs opacity-70" style={{ color: r.error_reason ? '#f87171' : 'var(--text3)' }}>
                    {r.error_reason ?? (r.material_reasons.length > 0 ? r.material_reasons.join('; ').slice(0, 80) : '')}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ReevalTriggerBadge({ trigger }: { trigger: string }) {
  const config = (() => {
    if (trigger === 'pre_market_reeval') return { bg: 'rgba(96,165,250,0.2)', color: '#60a5fa', label: 'PRE-MKT' }
    if (trigger === 'morning_reeval') return { bg: 'rgba(52,211,153,0.2)', color: '#34d399', label: 'MORNING' }
    if (trigger === 'after_hours_reeval') return { bg: 'rgba(167,139,250,0.2)', color: '#a78bfa', label: 'AFTER-HRS' }
    return { bg: 'var(--surface)', color: 'var(--text)', label: trigger.slice(0, 8) }
  })()
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-mono font-bold"
      style={{ background: config.bg, color: config.color }}>
      {config.label}
    </span>
  )
}

function ReevalCouncilBadge({ action, thesis }: { action: string | null; thesis: string | null }) {
  if (!action) return <span className="opacity-50">—</span>
  const a = action.toUpperCase()
  const config = (() => {
    if (a === 'EARLY_EXIT' || a === 'EXIT') return { bg: 'rgba(248,113,113,0.2)', color: '#f87171' }
    if (a === 'TIGHTEN_STOP' || a === 'TIGHTEN') return { bg: 'rgba(251,191,36,0.2)', color: '#fbbf24' }
    if (a === 'HOLD') return { bg: 'rgba(52,211,153,0.15)', color: '#34d399' }
    return { bg: 'var(--surface)', color: 'var(--text)' }
  })()
  const thesisShort = thesis ? ` · ${thesis.slice(0, 12)}` : ''
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-mono"
      style={{ background: config.bg, color: config.color }}
      title={thesis ?? ''}>
      {a}{thesisShort}
    </span>
  )
}

function ReevalActionBadge({ action, cancelOk }: { action: string | null; cancelOk: boolean | null }) {
  if (!action) return <span className="opacity-50">—</span>
  if (action === 'cancelled' && cancelOk === true) {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded font-mono font-bold"
        style={{ background: 'rgba(248,113,113,0.3)', color: '#f87171' }}>
        CANCELLED
      </span>
    )
  }
  if (action === 'cancelled' && cancelOk === false) {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded font-mono"
        style={{ background: 'rgba(248,113,113,0.15)', color: '#f87171' }}>
        cancel_failed
      </span>
    )
  }
  if (action === 'logged') {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded font-mono opacity-70"
        style={{ background: 'var(--bg)', color: 'var(--text3)' }}>
        logged
      </span>
    )
  }
  return <span className="text-xs opacity-60" style={{ color: 'var(--text3)' }}>{action}</span>
}
