import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const admin = createAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown'

  await admin.from('disclaimer_accepted').upsert({
    user_id: user.id,
    accepted_at: new Date().toISOString(),
    ip_hint: ip,
  }, { onConflict: 'user_id' })

  return NextResponse.json({ ok: true })
}
