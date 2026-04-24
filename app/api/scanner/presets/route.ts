// ═════════════════════════════════════════════════════════════
// app/api/scanner/presets/route.ts
//
// Manage saved filter combos for one-click scans.
//
// GET    /api/scanner/presets          — list user's presets
// POST   /api/scanner/presets          — create or update (upsert by name)
//   body: { name, universe, mode, filter, isFavorite? }
// DELETE /api/scanner/presets?name=X   — delete preset by name
// PATCH  /api/scanner/presets          — mark as used (updates last_used_at)
//   body: { name }
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export interface PresetRow {
  id: number
  name: string
  universe: string
  mode: 'bullish' | 'bearish' | 'both'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filter: Record<string, any>
  isFavorite: boolean
  createdAt: string
  lastUsedAt: string | null
}

// ─────────────────────────────────────────────────────────────
// GET — list user's presets
// ─────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const admin = getAdmin()
    const { data, error } = await admin
      .from('scanner_presets')
      .select('id, name, universe, mode, filter_json, is_favorite, created_at, last_used_at')
      .eq('user_id', user.id)
      .order('is_favorite', { ascending: false })
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .limit(50)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const presets: PresetRow[] = (data ?? []).map((r: any) => ({
      id: Number(r.id),
      name: String(r.name),
      universe: String(r.universe),
      mode: r.mode,
      filter: r.filter_json ?? {},
      isFavorite: Boolean(r.is_favorite),
      createdAt: String(r.created_at),
      lastUsedAt: r.last_used_at ?? null,
    }))

    return NextResponse.json({ presets })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message?.slice(0, 200) }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────
// POST — upsert preset (by name)
// ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 60) : ''
    if (!name) return NextResponse.json({ error: 'name required (max 60 chars)' }, { status: 400 })

    const universe = typeof body?.universe === 'string' ? body.universe : 'all'
    const mode = ['bullish', 'bearish', 'both'].includes(body?.mode) ? body.mode : 'both'
    const filter = typeof body?.filter === 'object' && body.filter !== null ? body.filter : {}
    const isFavorite = Boolean(body?.isFavorite)

    const admin = getAdmin()
    const { data, error } = await admin
      .from('scanner_presets')
      .upsert({
        user_id: user.id,
        name,
        universe,
        mode,
        filter_json: filter,
        is_favorite: isFavorite,
      }, {
        onConflict: 'user_id,name',
        ignoreDuplicates: false,
      })
      .select('id, name')
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ ok: true, id: data.id, name: data.name })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message?.slice(0, 200) }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────
// DELETE — remove preset by name
// ─────────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const url = new URL(req.url)
    const name = (url.searchParams.get('name') ?? '').trim()
    if (!name) return NextResponse.json({ error: 'name query param required' }, { status: 400 })

    const admin = getAdmin()
    const { error } = await admin
      .from('scanner_presets')
      .delete()
      .eq('user_id', user.id)
      .eq('name', name)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, deleted: true, name })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message?.slice(0, 200) }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────
// PATCH — mark as used / toggle favorite
// ─────────────────────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: Record<string, any> = { last_used_at: new Date().toISOString() }
    if (typeof body?.isFavorite === 'boolean') updates.is_favorite = body.isFavorite

    const admin = getAdmin()
    const { error } = await admin
      .from('scanner_presets')
      .update(updates)
      .eq('user_id', user.id)
      .eq('name', name)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, name, updates })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message?.slice(0, 200) }, { status: 500 })
  }
}
