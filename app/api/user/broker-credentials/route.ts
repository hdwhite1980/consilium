// =============================================================
// app/api/user/broker-credentials/route.ts
//
// Multi-asset, multi-broker credential management.
//
// GET    → list current user's credentials (no secrets)
// POST   → save a credential
//          body: { broker, mode, assetClass, keyId, secret, accountId? }
// DELETE → remove a credential by id
//
// Backward compat: if assetClass is missing in POST body, defaults
// to 'stock' so existing single-credential consumers keep working.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import {
  listBrokerCredentials,
  saveBrokerCredential,
  deleteBrokerCredential,
  updateCachedAccountInfo,
  type BrokerName,
} from '@/app/lib/trading/credentials'
import { validateAlpacaCredential } from '@/app/lib/trading/alpaca-validate'
import type { AssetClass } from '@/app/lib/trading/settings'

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
  assetClass?: string
  keyId?: string
  secret?: string
  accountId?: string
}

const VALID_BROKERS: BrokerName[] = ['alpaca', 'oanda', 'tradovate']
const VALID_ASSET_CLASSES: AssetClass[] = ['stock', 'crypto', 'forex', 'futures']

export async function POST(req: NextRequest): Promise<NextResponse> {
  const userId = await getUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: PostBody
  try {
    body = await req.json() as PostBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const broker = body.broker as BrokerName | undefined
  const mode = body.mode
  const assetClass = (body.assetClass ?? 'stock') as AssetClass
  const keyId = body.keyId
  const secret = body.secret
  const accountId = body.accountId ?? null

  if (!broker || !VALID_BROKERS.includes(broker)) {
    return NextResponse.json({ error: `broker must be one of: ${VALID_BROKERS.join(', ')}` }, { status: 400 })
  }
  if (mode !== 'paper' && mode !== 'live') {
    return NextResponse.json({ error: 'mode must be "paper" or "live"' }, { status: 400 })
  }
  if (!VALID_ASSET_CLASSES.includes(assetClass)) {
    return NextResponse.json({ error: `assetClass must be one of: ${VALID_ASSET_CLASSES.join(', ')}` }, { status: 400 })
  }
  if (!keyId || typeof keyId !== 'string' || keyId.length < 4) {
    return NextResponse.json({ error: 'keyId is required' }, { status: 400 })
  }
  if (!secret || typeof secret !== 'string' || secret.length < 4) {
    return NextResponse.json({ error: 'secret is required' }, { status: 400 })
  }

  // Broker-specific validation. Only alpaca implemented today.
  // oanda and tradovate validators ship in subsequent layers.
  if (broker === 'alpaca') {
    // Alpaca crypto credentials can be validated against the same /v2/account
    // endpoint since it's the same auth as stocks. The asset class only affects
    // which assets are tradable, not the validation path.
    const validation = await validateAlpacaCredential(keyId, secret, mode)
    if (!validation.ok) {
      return NextResponse.json({
        error: `Alpaca validation failed: ${validation.error}`,
      }, { status: 400 })
    }

    try {
      const cred = await saveBrokerCredential({ userId, broker, mode, assetClass, keyId, secret, accountId })
      await updateCachedAccountInfo(cred.id, {
        accountId: validation.accountId,
        accountStatus: validation.accountStatus,
        accountCash: validation.cash,
        accountEquity: validation.equity,
      })
      return NextResponse.json({
        ok: true,
        credentialId: cred.id,
        broker,
        mode,
        assetClass,
        accountStatus: validation.accountStatus,
        equity: validation.equity,
      })
    } catch (e) {
      console.error('[user/broker-credentials POST alpaca] failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({
        error: e instanceof Error ? e.message : 'Failed to save credential',
      }, { status: 500 })
    }
  }

  // Other brokers — placeholder; full validation in subsequent commits
  if (broker === 'oanda' || broker === 'tradovate') {
    return NextResponse.json({
      error: `${broker} credentials not yet supported. Coming in next deployment.`,
    }, { status: 501 })
  }

  return NextResponse.json({ error: 'Unhandled broker' }, { status: 400 })
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
