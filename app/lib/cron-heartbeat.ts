// =============================================================
// app/lib/cron-heartbeat.ts
//
// Lightweight liveness tracking. Each monitored cron calls recordHeartbeat()
// on every run; the heartbeat-watchdog cron reads these timestamps and alerts
// if anything goes quiet. This is the safety net for the June-2026 incident
// where a GitHub Actions schedule silently stopped firing for a week.
// =============================================================

import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'

export async function recordHeartbeat(
  cronName: string,
  status: 'ok' | 'error' = 'ok',
  meta?: Record<string, unknown>,
): Promise<void> {
  try {
    const admin = await getSupabaseAdmin()
    await admin.from('cron_heartbeats').upsert(
      {
        cron_name: cronName,
        last_run_at: new Date().toISOString(),
        last_status: status,
        meta: meta ?? null,
      },
      { onConflict: 'cron_name' },
    )
  } catch (e) {
    // Never let heartbeat bookkeeping break the cron it's tracking.
    console.warn(`[heartbeat] ${cronName} record failed:`, e instanceof Error ? e.message : e)
  }
}
