'use client'

import { useState, useEffect, useCallback } from 'react'
import { Bell, BellRing, X, ChevronDown, AlertTriangle, TrendingDown, TrendingUp, Newspaper, CheckCheck } from 'lucide-react'

interface PortfolioAlert {
  id: string
  ticker: string
  severity: 'watch' | 'alert' | 'urgent'
  alert_type: string
  title: string
  message: string
  price: number | null
  trigger_value: number | null
  created_at: string
  acknowledged: boolean
}

const SEVERITY_CONFIG = {
  urgent: { color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.25)', icon: AlertTriangle, label: 'URGENT' },
  alert:  { color: '#f97316', bg: 'rgba(249,115,22,0.08)', border: 'rgba(249,115,22,0.25)', icon: TrendingDown,   label: 'ALERT'  },
  watch:  { color: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.25)', icon: Bell,           label: 'WATCH'  },
}

const TYPE_ICONS: Record<string, typeof Bell> = {
  support_break:    TrendingDown,
  resistance_break: TrendingUp,
  pnl_threshold:    TrendingDown,
  news:             Newspaper,
  volume_spike:     BellRing,
  pattern_change:   AlertTriangle,
}

function isMarketOpen() {
  const now = new Date()
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const day = et.getDay()
  const mins = et.getHours() * 60 + et.getMinutes()
  return day >= 1 && day <= 5 && mins >= 570 && mins < 960
}

interface Props {
  isDark: boolean
}

export default function PortfolioAlerts({ isDark }: Props) {
  const [alerts, setAlerts] = useState<PortfolioAlert[]>([])
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)
  const [nextCheck, setNextCheck] = useState<Date | null>(null)
  const [countdown, setCountdown] = useState<string>('')

  const txt  = isDark ? 'rgba(255,255,255,0.9)'  : 'rgba(0,0,0,0.9)'
  const txt2 = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
  const txt3 = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.35)'
  const surf = isDark ? 'var(--surface)' : '#ffffff'
  const surf2 = isDark ? 'var(--surface2)' : '#f5f7fb'
  const brd  = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)'

  // Load existing unacked alerts
  const loadAlerts = useCallback(async () => {
    try {
      const r = await fetch('/api/portfolio/monitor')
      const d = await r.json()
      setAlerts(d.alerts ?? [])
    } catch { /* ignore */ }
  }, [])

  // Run a monitor check
  const runCheck = useCallback(async () => {
    if (checking) return
    setChecking(true)
    try {
      const r = await fetch('/api/portfolio/monitor', { method: 'POST' })
      const d = await r.json()
      if (d.newAlertsCount > 0) {
        await loadAlerts() // reload to get full alert objects
      }
      setLastChecked(new Date())
    } catch { /* ignore */ }
    setChecking(false)
  }, [checking, loadAlerts])

  // Initial load + immediate first check on mount
  useEffect(() => {
    loadAlerts()
    // Run first check immediately after mount (don't wait 15 min)
    runCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // intentionally empty — run once on mount

  // Auto-check interval — stable, not dependent on runCheck to avoid reset
  useEffect(() => {
    const intervalMs = isMarketOpen() ? 15 * 60 * 1000 : 60 * 60 * 1000
    const next = new Date(Date.now() + intervalMs)
    setNextCheck(next)

    const interval = setInterval(() => {
      const newNext = new Date(Date.now() + intervalMs)
      setNextCheck(newNext)
      // Use fetch directly to avoid stale closure issues
      fetch('/api/portfolio/monitor', { method: 'POST' })
        .then(r => r.json())
        .then(d => {
          if (d.newAlertsCount > 0) {
            fetch('/api/portfolio/monitor')
              .then(r => r.json())
              .then(d2 => setAlerts(d2.alerts ?? []))
              .catch(() => null)
          }
          setLastChecked(new Date())
        })
        .catch(() => null)
    }, intervalMs)

    return () => clearInterval(interval)
  }, []) // intentionally empty — stable interval, no re-registration

  // Countdown ticker — updates every second
  useEffect(() => {
    const tick = setInterval(() => {
      if (!nextCheck) return
      const secsLeft = Math.max(0, Math.round((nextCheck.getTime() - Date.now()) / 1000))
      const mins = Math.floor(secsLeft / 60)
      const secs = secsLeft % 60
      setCountdown(secsLeft <= 0 ? 'checking...' : `${mins}:${secs.toString().padStart(2, '0')}`)
    }, 1000)
    return () => clearInterval(tick)
  }, [nextCheck])

  const acknowledge = async (alertId?: string) => {
    await fetch('/api/portfolio/monitor', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alertId ? { alertId } : { all: true }),
    })
    setAlerts(prev => alertId
      ? prev.filter(a => a.id !== alertId)
      : []
    )
  }

  const urgentCount = alerts.filter(a => a.severity === 'urgent').length
  const alertCount  = alerts.filter(a => a.severity === 'alert').length
  const totalUnread = alerts.length

  const badgeColor = urgentCount > 0 ? '#ef4444' : alertCount > 0 ? '#f97316' : '#fbbf24'

  return (
    <div className="relative">
      {/* Bell button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
        style={{ background: totalUnread > 0 ? 'rgba(239,68,68,0.08)' : surf2, border: `1px solid ${totalUnread > 0 ? 'rgba(239,68,68,0.2)' : brd}` }}
      >
        {totalUnread > 0
          ? <BellRing size={13} style={{ color: badgeColor }} />
          : <Bell size={13} style={{ color: txt3 }} />
        }
        {totalUnread > 0 && (
          <span className="text-[10px] font-bold font-mono" style={{ color: badgeColor }}>{totalUnread}</span>
        )}
        <ChevronDown size={11} style={{ color: txt3, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-96 rounded-2xl shadow-2xl z-50 overflow-hidden"
          style={{ background: surf, border: `1px solid ${brd}` }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: brd, background: surf2 }}>
            <div className="flex items-center gap-2">
              <BellRing size={13} style={{ color: '#a78bfa' }} />
              <span className="text-xs font-bold" style={{ color: txt }}>Portfolio Alerts</span>
              {checking && (
                <span className="text-[10px] font-mono animate-pulse" style={{ color: txt3 }}>checking...</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] flex items-center gap-1.5" style={{ color: txt3 }}>
                <span>{isMarketOpen() ? '🟢' : '⚫'}</span>
                {lastChecked && (
                  <span>last {lastChecked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                )}
                {countdown && !checking && (
                  <span style={{ color: 'rgba(167,139,250,0.6)' }}>· next {countdown}</span>
                )}
              </span>
              {alerts.length > 0 && (
                <button onClick={() => acknowledge()} className="text-[10px] hover:opacity-70 flex items-center gap-1" style={{ color: txt3 }}>
                  <CheckCheck size={11} /> All read
                </button>
              )}
              <button onClick={() => setOpen(false)} style={{ color: txt3 }}>
                <X size={13} />
              </button>
            </div>
          </div>

          {/* Alert list */}
          <div className="max-h-96 overflow-y-auto">
            {alerts.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <Bell size={20} style={{ color: txt3, margin: '0 auto 8px' }} />
                <p className="text-xs" style={{ color: txt3 }}>No active alerts</p>
                <p className="text-[10px] mt-1" style={{ color: txt3 }}>
                  {checking ? 'Running check now...' : countdown ? `Next check in ${countdown}` : isMarketOpen() ? 'Every 15 minutes' : 'Market closed — hourly'}
                </p>
                <button
                  onClick={() => { runCheck(); }}
                  className="mt-3 text-[10px] px-3 py-1.5 rounded-lg hover:opacity-70"
                  style={{ background: surf2, color: txt3, border: `1px solid ${brd}` }}>
                  Check now
                </button>
              </div>
            ) : (
              <div className="divide-y" style={{ borderColor: brd }}>
                {alerts.map(alert => {
                  const cfg = SEVERITY_CONFIG[alert.severity]
                  const Icon = TYPE_ICONS[alert.alert_type] ?? Bell
                  const age = Math.round((Date.now() - new Date(alert.created_at).getTime()) / 60000)
                  const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`

                  return (
                    <div key={alert.id} className="px-4 py-3 flex gap-3 group"
                      style={{ background: cfg.bg }}>
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                        style={{ background: `${cfg.color}15`, border: `1px solid ${cfg.border}` }}>
                        <Icon size={12} style={{ color: cfg.color }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9px] font-bold font-mono px-1.5 py-0.5 rounded"
                              style={{ background: `${cfg.color}20`, color: cfg.color }}>
                              {cfg.label}
                            </span>
                            <span className="text-xs font-bold" style={{ color: txt }}>{alert.ticker}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px]" style={{ color: txt3 }}>{ageStr}</span>
                            <button onClick={() => acknowledge(alert.id)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity"
                              style={{ color: txt3 }}>
                              <X size={11} />
                            </button>
                          </div>
                        </div>
                        <p className="text-[11px] font-semibold mb-0.5" style={{ color: txt }}>{alert.title}</p>
                        <p className="text-[11px] leading-relaxed" style={{ color: txt2 }}>{alert.message}</p>
                        {alert.price && (
                          <p className="text-[10px] mt-1 font-mono" style={{ color: txt3 }}>
                            Price at alert: ${alert.price.toFixed(2)}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t text-[10px] flex items-center justify-between" style={{ borderColor: brd, background: surf2, color: txt3 }}>
            <span style={{ color: txt3 }}>
              {isMarketOpen() ? `Every 15 min · next in ${countdown || '...'}` : `After hours · next in ${countdown || '...'}`}
            </span>
            <button onClick={runCheck} disabled={checking} className="hover:opacity-70 disabled:opacity-40" style={{ color: checking ? txt3 : '#a78bfa' }}>
              {checking ? 'Checking...' : '↻ Check now'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
