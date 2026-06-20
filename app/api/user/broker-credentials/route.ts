// =============================================================
// app/api/user/broker-credentials/route.ts
//
// Multi-broker credential management with broker-specific
// validation. Alpaca + OANDA implemented. Tradovate placeholder.
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
import { validateOandaCredential } from '@/app/lib/trading/oanda-validate'
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
  try { body = await req.json() as PostBody }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

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
    return NextResponse.json({ error: 'keyId is required (use OANDA account ID for OANDA)' }, { status: 400 })
  }
  if (!secret || typeof secret !== 'string' || secret.length < 4) {
    return NextResponse.json({ error: 'secret is required (use Personal Access Token for OANDA)' }, { status: 400 })
  }

  // ── ALPACA ────────────────────────────────────────────────
  if (broker === 'alpaca') {
    const validation = await validateAlpacaCredential(keyId, secret, mode)
    if (!validation.ok) {
      return NextResponse.json({ error: `Alpaca validation failed: ${validation.error}` }, { status: 400 })
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
        ok: true, credentialId: cred.id, broker, mode, assetClass,
        accountStatus: validation.accountStatus, equity: validation.equity,
      })
    } catch (e) {
      console.error('[user/broker-credentials POST alpaca] failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to save credential' }, { status: 500 })
    }
  }

  // ── OANDA ─────────────────────────────────────────────────
  if (broker === 'oanda') {
    if (assetClass !== 'forex') {
      return NextResponse.json({ error: `OANDA only supports assetClass=forex` }, { status: 400 })
    }
    const validation = await validateOandaCredential(keyId, secret, mode)
    if (!validation.ok) {
      return NextResponse.json({ error: `OANDA validation failed: ${validation.error}` }, { status: 400 })
    }
    try {
      const cred = await saveBrokerCredential({
        userId, broker, mode, assetClass, keyId, secret,
        accountId: validation.accountId ?? keyId,
      })
      await updateCachedAccountInfo(cred.id, {
        accountId: validation.accountId,
        accountStatus: validation.accountStatus,
        accountCash: validation.balance,
        accountEquity: validation.balance !== undefined && validation.unrealizedPL !== undefined
          ? validation.balance + validation.unrealizedPL
          : validation.balance,
      })
      return NextResponse.json({
        ok: true, credentialId: cred.id, broker, mode, assetClass,
        accountStatus: validation.accountStatus,
        currency: validation.currency,
        balance: validation.balance,
        marginAvailable: validation.marginAvailable,
      })
    } catch (e) {
      console.error('[user/broker-credentials POST oanda] failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to save OANDA credential' }, { status: 500 })
    }
  }

  if (broker === 'tradovate') {
    return NextResponse.json({
      error: `Tradovate credentials not yet supported. Coming in next deployment.`,
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
