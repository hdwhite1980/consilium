import { createClient } from '@supabase/supabase-js'

// Uses service role to bypass RLS for session writes
function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// Called on login — registers this device as the only active session
export async function registerSession(userId: string, sessionToken: string, deviceHint: string) {
  const admin = getAdminClient()
  await admin
    .from('active_sessions')
    .upsert({
      user_id: userId,
      session_token: sessionToken,
      device_hint: deviceHint,
      logged_in_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
}

// Called on each protected page load — checks token still matches
export async function validateSession(userId: string, sessionToken: string): Promise<boolean> {
  const admin = getAdminClient()
  const { data } = await admin
    .from('active_sessions')
    .select('session_token, last_seen_at')
    .eq('user_id', userId)
    .single()

  if (!data) return false
  if (data.session_token !== sessionToken) return false

  // Update last_seen_at (heartbeat)
  await admin
    .from('active_sessions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('user_id', userId)

  return true
}

// Called on logout — removes the session record
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
