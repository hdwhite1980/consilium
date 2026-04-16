import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const tutorialId = req.nextUrl.searchParams.get('id') ?? 'main'

  const { data } = await getAdmin()
    .from('tutorial_progress')
    .select('*')
    .eq('user_id', user.id)
    .eq('tutorial_id', tutorialId)
    .maybeSingle()

  return NextResponse.json({ progress: data ?? null })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { tutorialId, step, completed, skipped } = await req.json()

  const { data, error } = await getAdmin()
    .from('tutorial_progress')
    .upsert({
      user_id: user.id,
      tutorial_id: tutorialId ?? 'main',
      step: step ?? 0,
      completed: completed ?? false,
      skipped: skipped ?? false,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,tutorial_id' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ progress: data })
}
