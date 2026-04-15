import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET — load all training progress for user
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const [{ data: lessons }, { data: quizzes }] = await Promise.all([
    getAdmin()
      .from('tutorial_progress')
      .select('tutorial_id, step, completed, skipped, updated_at')
      .eq('user_id', user.id)
      .like('tutorial_id', 'training:%'),
    getAdmin()
      .from('training_quiz_answers')
      .select('lesson_id, question_id, correct')
      .eq('user_id', user.id),
  ])

  // Build progress map
  const lessonProgress: Record<string, { completed: boolean; step: number }> = {}
  for (const l of lessons ?? []) {
    lessonProgress[l.tutorial_id] = { completed: l.completed, step: l.step }
  }

  // Build quiz results map
  const quizResults: Record<string, boolean> = {}
  for (const q of quizzes ?? []) {
    quizResults[`${q.lesson_id}:${q.question_id}`] = q.correct
  }

  const totalCompleted = Object.values(lessonProgress).filter(l => l.completed).length
  const totalCorrect = Object.values(quizResults).filter(Boolean).length
  const totalQuizzes = Object.keys(quizResults).length
  const accuracy = totalQuizzes > 0 ? Math.round((totalCorrect / totalQuizzes) * 100) : 0

  return NextResponse.json({ lessonProgress, quizResults, totalCompleted, accuracy })
}

// POST — mark lesson complete or save quiz answer
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json()
  const { type } = body

  if (type === 'lesson_complete') {
    const { lessonId } = body
    const { data, error } = await getAdmin()
      .from('tutorial_progress')
      .upsert({
        user_id: user.id,
        tutorial_id: lessonId,
        step: 100,
        completed: true,
        skipped: false,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,tutorial_id' })
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, lesson: data })
  }

  if (type === 'quiz_answer') {
    const { lessonId, questionId, correct } = body
    const { error } = await getAdmin()
      .from('training_quiz_answers')
      .insert({
        user_id: user.id,
        lesson_id: lessonId,
        question_id: questionId,
        correct: !!correct,
      })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  }

  return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
}
