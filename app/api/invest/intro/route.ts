import { NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const admin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ accepted: false })

  const { data } = await admin()
    .from('invest_intro_accepted')
    .select('accepted_at')
    .eq('user_id', user.id)
    .single()

  return NextResponse.json({ accepted: !!data, acceptedAt: data?.accepted_at ?? null })
}

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  await admin()
    .from('invest_intro_accepted')
    .upsert({ user_id: user.id, accepted_at: new Date().toISOString() }, { onConflict: 'user_id' })

  return NextResponse.json({ accepted: true })
}
