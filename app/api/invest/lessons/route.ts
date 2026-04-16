import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const admin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ progress: [] })

  const { data } = await admin()
    .from('invest_lesson_progress')
    .select('lesson_id, completed_at, quiz_answer, correct')
    .eq('user_id', user.id)

  return NextResponse.json({ progress: data ?? [] })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { lessonId, quizAnswer, correct } = await req.json()

  await admin()
    .from('invest_lesson_progress')
    .upsert({
      user_id: user.id,
      lesson_id: lessonId,
      quiz_answer: quizAnswer,
      correct,
      completed_at: new Date().toISOString(),
    }, { onConflict: 'user_id,lesson_id' })

  return NextResponse.json({ success: true })
}
