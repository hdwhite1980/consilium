// =============================================================
// app/api/admin/flags/route.ts
//
// View / flip the Council RAG master switch (the C-engine activation).
// Auth: Bearer CRON_SECRET.
//
//   GET  /api/admin/flags                       -> current mode + RAG readiness
//   POST /api/admin/flags?mode=off|auto|on      -> set council_rag_mode
//
// PowerShell:
//   $h = @{ Authorization = "Bearer wali-os-cron-2026" }
//   Invoke-RestMethod -Uri "https://wali-os.com/api/admin/flags" -Headers $h
//   Invoke-RestMethod -Method Post -Uri "https://wali-os.com/api/admin/flags?mode=auto" -Headers $h
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getFlag, setFlag } from '@/app/lib/learning/flags'
import { ragReadiness } from '@/app/lib/learning/council-rag'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const FLAG_KEY = 'council_rag_mode'
const VALID = ['off', 'auto', 'on']

function authed(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return auth === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const mode = await getFlag(FLAG_KEY, 'off')
  const readiness = await ragReadiness('1m')
  return NextResponse.json({ flag: FLAG_KEY, mode, readiness })
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const mode = (url.searchParams.get('mode') ?? '').toLowerCase()
  if (!VALID.includes(mode)) {
    return NextResponse.json({ error: `mode must be one of ${VALID.join(', ')}` }, { status: 400 })
  }
  const ok = await setFlag(FLAG_KEY, mode)
  if (!ok) return NextResponse.json({ error: 'failed to set flag' }, { status: 500 })
  const readiness = await ragReadiness('1m')
  return NextResponse.json({ flag: FLAG_KEY, mode, readiness })
}
