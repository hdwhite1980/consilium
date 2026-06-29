// =============================================================
// app/api/cron/heartbeat-watchdog/route.ts
//
// Reads cron_heartbeats and alerts (email + SMS via the existing notifications
// helper) if a monitored cron hasn't run within its expected window. Runs on
// its own QStash schedule (every ~15 min). This is what turns a silent week-long
// stoppage into a ping within minutes.
//
// Config note: market-hours crons get a UTC window so they don't false-alarm
// overnight; 24/7 crons are checked always. Alerts dedup on a cooldown so a
// sustained outage doesn't spam.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { sendAlert } from '@/app/lib/notifications'
import { recordHeartbeat } from '@/app/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Monitored {
  name: string
  maxStaleMin: number
  // UTC active window (optional). Outside it, the cron is expected idle.
  window?: { startUtc: number; endUtc: number; days: number[] }  // days: 0=Sun..6=Sat
  // sparse crons (run a few fixed times/day) skip the open-edge guard, since
  // their runs may precede the window rather than start at it.
  sparse?: boolean
}

const MONITORED: Monitored[] = [
  // every 5 min, 24/7 — manages crypto too
  { name: 'auto-trade-positions', maxStaleMin: 15 },
  // attach-stops only matters when stock orders fill → market hours (≈9am–5pm ET)
  { name: 'auto-trade-attach-stops', maxStaleMin: 12, window: { startUtc: 13, endUtc: 21, days: [1, 2, 3, 4, 5] } },
  // hourly 14:00–21:00 UTC weekdays — routes stories (incl. forex) to the council
  { name: 'auto-council-trigger', maxStaleMin: 80, window: { startUtc: 14, endUtc: 22, days: [1, 2, 3, 4, 5] } },
  // 3x/day at session opens; coarse weekday-afternoon check that the forex
  // feeder isn't fully dead (alerts if no run in ~9h during a trading day)
  { name: 'active-stories-forex', maxStaleMin: 540, window: { startUtc: 14, endUtc: 22, days: [1, 2, 3, 4, 5] }, sparse: true },
]

const ALERT_COOLDOWN_MIN = 360  // re-alert at most every 6h while still down

interface HeartbeatRow {
  cron_name: string
  last_run_at: string | null
  last_status: string | null
  last_alerted_at: string | null
}

// Is the cron expected to be running right now? 24/7 crons: always. Windowed
// crons: only inside the window, and only once we're far enough past the open
// edge that a run was actually due (prevents a false alarm at the open bell).
function shouldBeRunning(m: Monitored, now: Date): boolean {
  if (!m.window) return true
  const day = now.getUTCDay()
  if (!m.window.days.includes(day)) return false
  const h = now.getUTCHours() + now.getUTCMinutes() / 60
  if (h < m.window.startUtc || h >= m.window.endUtc) return false
  if (!m.sparse && (h - m.window.startUtc) * 60 < m.maxStaleMin) return false
  return true
}

async function run(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = await getSupabaseAdmin()
  const now = new Date()
  const { data } = await admin
    .from('cron_heartbeats')
    .select('cron_name, last_run_at, last_status, last_alerted_at')
  const byName = new Map<string, HeartbeatRow>((data ?? []).map((r) => [(r as HeartbeatRow).cron_name, r as HeartbeatRow]))

  const stale: Array<{ name: string; minutesSince: number }> = []
  const alerted: string[] = []
  const alertEmail = process.env.ALERT_EMAIL
  const alertPhone = process.env.ALERT_PHONE ?? null

  for (const m of MONITORED) {
    if (!shouldBeRunning(m, now)) continue

    const row = byName.get(m.name)
    const lastRun = row?.last_run_at ? new Date(row.last_run_at) : null
    const minutesSince = lastRun ? (now.getTime() - lastRun.getTime()) / 60_000 : Infinity
    if (minutesSince <= m.maxStaleMin) continue  // healthy

    stale.push({ name: m.name, minutesSince: Number.isFinite(minutesSince) ? Math.round(minutesSince) : -1 })

    // Dedup: skip if we alerted recently for this one.
    const lastAlerted = row?.last_alerted_at ? new Date(row.last_alerted_at) : null
    const sinceAlert = lastAlerted ? (now.getTime() - lastAlerted.getTime()) / 60_000 : Infinity
    if (sinceAlert < ALERT_COOLDOWN_MIN) continue

    if (alertEmail) {
      const mins = Number.isFinite(minutesSince) ? `${Math.round(minutesSince)} min` : 'an unknown amount of time'
      await sendAlert({
        userId: 'system',
        email: alertEmail,
        phone: alertPhone,
        ticker: m.name,
        severity: 'urgent',
        title: `Cron down: ${m.name}`,
        message: `${m.name} hasn't run in ${mins} (expected within ${m.maxStaleMin} min). Automated position monitoring may have stopped — check the QStash schedules.`,
        price: null,
      })
      alerted.push(m.name)
      await admin.from('cron_heartbeats').update({ last_alerted_at: now.toISOString() }).eq('cron_name', m.name)
    }
  }

  // The watchdog records its own heartbeat too (so its liveness is visible).
  await recordHeartbeat('heartbeat-watchdog', 'ok', { stale: stale.length, alerted: alerted.length })

  return NextResponse.json({
    checkedAt: now.toISOString(),
    monitored: MONITORED.map((m) => m.name),
    stale,
    alerted,
    alertEmailConfigured: !!alertEmail,
  })
}

export async function GET(req: NextRequest): Promise<NextResponse> { return run(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return run(req) }
