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

  const { data, error } = await getAdmin()
    .from('tutorial_progress')
    .select('*')
    .eq('user_id', user.id)
    .eq('tutorial_id', tutorialId)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ progress: null, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ progress: data ?? null })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })

  let body: { tutorialId?: string; step?: number; completed?: boolean; skipped?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const { tutorialId, step, completed, skipped } = body

  // Use maybeSingle() instead of single() — upsert can legitimately return
  // 0 rows if RLS or onConflict behavior kicks in, and single() throws in
  // that case, making the POST appear to fail even though the write succeeded.
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
    .maybeSingle()

  if (error) {
    // Log on the server for visibility, return 500 with details so the
    // client-side fetch interceptor shows the real failure reason.
    console.error('[tutorial POST] upsert error:', error)
    return NextResponse.json({ ok: false, error: error.message, details: error }, { status: 500 })
  }

  return NextResponse.json({ ok: true, progress: data ?? null })
}
