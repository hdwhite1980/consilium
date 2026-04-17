import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { getActiveThemes, getRecentMacroEvents } from '@/app/lib/macro-intelligence'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [themes, events] = await Promise.all([
    getActiveThemes(),
    getRecentMacroEvents(20),
  ])

  return NextResponse.json({ themes, events })
}
