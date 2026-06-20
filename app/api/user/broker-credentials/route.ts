// =============================================================
// app/api/user/broker-credentials/route.ts
//
// GET    /api/user/broker-credentials  → list current user's credentials (no secrets)
// POST   /api/user/broker-credentials  → save a credential (body: { broker, mode, keyId, secret })
// DELETE /api/user/broker-credentials?id=<credId> → remove a credential
//
// Validates the credential against Alpaca before saving. If validation
// fails, returns 400 with the error and does NOT persist.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import {
  listBrokerCredentials,
  saveBrokerCredential,
  deleteBrokerCredential,
  updateCachedAccountInfo,
  recordValidationError,
} from '@/app/lib/trading/credentials'
import { validateAlpacaCredential } from '@/app/lib/trading/alpaca-validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function getUserId(): Promise<string | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id ?? null
}

export async function GET(): Promise<NextResponse> {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const credentials = await listBrokerCredentials(userId)
    return NextResponse.json({ credentials })
  } catch (e) {
    console.error('[user/broker-credentials GET] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Failed to load credentials' }, { status: 500 })
  }
}

interface PostBody {
  broker?: string
  mode?: string
  keyId?: string
  secret?: string
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: PostBody
  try {
    body = await req.json() as PostBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const broker = body.broker
  const mode = body.mode
  const keyId = body.keyId
  const secret = body.secret

  if (broker !== 'alpaca') {
    return NextResponse.json({ error: 'Only alpaca broker is supported in v1' }, { status: 400 })
  }
  if (mode !== 'paper' && mode !== 'live') {
    return NextResponse.json({ error: 'mode must be "paper" or "live"' }, { status: 400 })
  }
  if (!keyId || typeof keyId !== 'string' || keyId.length < 4) {
    return NextResponse.json({ error: 'keyId is required' }, { status: 400 })
  }
  if (!secret || typeof secret !== 'string' || secret.length < 4) {
    return NextResponse.json({ error: 'secret is required' }, { status: 400 })
  }

  // Validate against Alpaca BEFORE saving — don't persist broken creds
  const validation = await validateAlpacaCredential(keyId, secret, mode)
  if (!validation.ok) {
    return NextResponse.json({
      error: `Alpaca validation failed: ${validation.error}`,
    }, { status: 400 })
  }

  try {
    const cred = await saveBrokerCredential({ userId, broker, mode, keyId, secret })
    await updateCachedAccountInfo(cred.id, {
      accountId: validation.accountId,
      accountStatus: validation.accountStatus,
      cash: validation.cash,
      equity: validation.equity,
    })
    return NextResponse.json({
      ok: true,
      credentialId: cred.id,
      accountStatus: validation.accountStatus,
      equity: validation.equity,
    })
  } catch (e) {
    console.error('[user/broker-credentials POST] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({
      error: e instanceof Error ? e.message : 'Failed to save credential',
    }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 })

  try {
    await deleteBrokerCredential(userId, id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[user/broker-credentials DELETE] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
  }
}
