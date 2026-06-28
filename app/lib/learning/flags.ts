// =============================================================
// app/lib/learning/flags.ts
//
// Tiny DB-backed feature flags so toggles (like the RAG master switch) can be
// flipped from an admin call without a redeploy.
// =============================================================

import { createClient } from '@supabase/supabase-js'

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function getFlag(key: string, fallback = ''): Promise<string> {
  try {
    const { data } = await admin().from('system_flags').select('value').eq('key', key).maybeSingle()
    return (data as { value?: string } | null)?.value ?? fallback
  } catch {
    return fallback
  }
}

export async function setFlag(key: string, value: string): Promise<boolean> {
  try {
    const { error } = await admin()
      .from('system_flags')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    return !error
  } catch {
    return false
  }
}
