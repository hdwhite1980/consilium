import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

// Uses service role to bypass RLS for session writes
function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// Called on login - generates a fresh device_id, stores it, returns it.
// The returned device_id is set as a cookie on the login response so
// this device can prove itself on subsequent requests. When a new
// login happens (same user, different browser), a new device_id replaces
// this one, and the old device will be rejected by validateDeviceId.
export async function registerSession(userId: string, deviceHint: string): Promise<string> {
  const admin = getAdminClient()
  const deviceId = crypto.randomUUID()
  const { error } = await admin
    .from('active_sessions')
    .upsert({
      user_id: userId,
      device_id: deviceId,
      device_hint: deviceHint,
      logged_in_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
  console.log('[session] registered device', deviceId.slice(0, 8) + '...', 'for user', userId.slice(0, 8) + '...', error ? 'ERROR: ' + error.message : 'OK')
  return deviceId
}

// Called by middleware on every protected request.
// Returns true iff the device_id cookie matches what we stored at login.
// A mismatch means the user logged in from another device, displacing
// this one - we should bounce them to login with ?error=session_displaced.
export async function validateDeviceId(userId: string, deviceId: string | undefined): Promise<boolean> {
  if (!deviceId) {
    console.log('[session] validateDeviceId: no cookie for user', userId.slice(0, 8) + '...')
    return false
  }
  const admin = getAdminClient()
  const { data, error } = await admin
    .from('active_sessions')
    .select('device_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    console.log('[session] validateDeviceId ERROR:', error.message)
    return false
  }
  if (!data) {
    console.log('[session] validateDeviceId: no DB row for user', userId.slice(0, 8) + '...')
    return false
  }
  const matches = data.device_id === deviceId
  console.log('[session] validateDeviceId:', matches ? 'MATCH' : 'MISMATCH',
    '- cookie:', deviceId.slice(0, 8) + '...',
    '- db:', (data.device_id as string).slice(0, 8) + '...')
  return matches
}

// Called on logout - removes the session record
export async function clearSession(userId: string) {
  const admin = getAdminClient()
  await admin
    .from('active_sessions')
    .delete()
    .eq('user_id', userId)
}

// Extracts a device hint string from the User-Agent header
export function getDeviceHint(userAgent: string): string {
  if (!userAgent) return 'Unknown device'
  const ua = userAgent.toLowerCase()
  const os =
    ua.includes('windows') ? 'Windows' :
    ua.includes('mac') ? 'Mac' :
    ua.includes('iphone') ? 'iPhone' :
    ua.includes('android') ? 'Android' :
    ua.includes('linux') ? 'Linux' : 'Unknown OS'
  const browser =
    ua.includes('chrome') ? 'Chrome' :
    ua.includes('firefox') ? 'Firefox' :
    ua.includes('safari') ? 'Safari' :
    ua.includes('edge') ? 'Edge' : 'Browser'
  return `${browser} on ${os}`
}