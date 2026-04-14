import { NextRequest } from 'next/server'
import { createServerClient } from '@/app/lib/supabase'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const ticker = searchParams.get('ticker')
  const limit = parseInt(searchParams.get('limit') || '20')

  const supabase = createServerClient()

  let query = supabase
    .from('analyses')
    .select('id, ticker, timeframe, created_at, final_signal, final_confidence, final_target, rounds_taken')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (ticker) query = query.eq('ticker', ticker.toUpperCase())

  const { data, error } = await query
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ analyses: data })
}
