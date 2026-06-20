// =============================================================
// app/api/user/broker-credentials/route.ts
//
// Multi-broker credential management. Now wires Tradovate validation
// alongside Alpaca and OANDA.
//
// Tradovate body shape (uses tradovate object instead of keyId/secret):
//   { broker: 'tradovate', mode, assetClass: 'futures',
//     keyId: <username>,
//     secret: JSON.stringify({ password, appId, appVersion, cid, sec }) }
//
// We keep the simple keyId/secret shape so the UI doesn't have to know.
// The secret carries the bundle as JSON; the validator unpacks it.
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
import { validateTradovateCredential } from '@/app/lib/trading/tradovate-validate'
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
  if (!keyId || typeof keyId !== 'string' || keyId.length < 2) {
    return NextResponse.json({ error: 'keyId is required' }, { status: 400 })
  }
  if (!secret || typeof secret !== 'string' || secret.length < 4) {
    return NextResponse.json({ error: 'secret is required' }, { status: 400 })
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
        accountStatus: validation.accountStatus, currency: validation.currency,
        balance: validation.balance, marginAvailable: validation.marginAvailable,
      })
    } catch (e) {
      console.error('[user/broker-credentials POST oanda] failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to save OANDA credential' }, { status: 500 })
    }
  }

  // ── TRADOVATE ─────────────────────────────────────────────
  if (broker === 'tradovate') {
    if (assetClass !== 'futures') {
      return NextResponse.json({ error: `Tradovate only supports assetClass=futures` }, { status: 400 })
    }

    // For Tradovate, secret is a JSON bundle containing the rest of the creds.
    // The UI assembles it; we unpack here.
    let bundle: { password?: string; appId?: string; appVersion?: string; cid?: string; sec?: string }
    try { bundle = JSON.parse(secret) as typeof bundle }
    catch {
      return NextResponse.json({
        error: 'Tradovate secret must be JSON: { "password":"...", "appId":"...", "appVersion":"...", "cid":"...", "sec":"..." }',
      }, { status: 400 })
    }
    if (!bundle.password || !bundle.appId || !bundle.appVersion || !bundle.cid || !bundle.sec) {
      return NextResponse.json({
        error: 'Tradovate secret bundle missing one of: password, appId, appVersion, cid, sec',
      }, { status: 400 })
    }

    const validation = await validateTradovateCredential({
      username: keyId,
      password: bundle.password,
      appId: bundle.appId,
      appVersion: bundle.appVersion,
      cid: bundle.cid,
      sec: bundle.sec,
    }, mode)
    if (!validation.ok) {
      return NextResponse.json({ error: `Tradovate validation failed: ${validation.error}` }, { status: 400 })
    }

    try {
      const cred = await saveBrokerCredential({
        userId, broker, mode, assetClass, keyId, secret,
        accountId: validation.accountSpec ?? null,
        cachedAccessToken: validation.accessToken,
        cachedTokenExpiresAt: validation.expirationTime,
        cachedAccountSpec: validation.accountSpec,
        cachedAccountIntId: validation.accountIntId,
      })
      await updateCachedAccountInfo(cred.id, {
        accountId: validation.accountSpec,
        accountStatus: 'ACTIVE',
        accountCash: validation.balance,
        accountEquity: validation.balance,
      })
      return NextResponse.json({
        ok: true, credentialId: cred.id, broker, mode, assetClass,
        accountSpec: validation.accountSpec,
        balance: validation.balance,
        marginAvailable: validation.marginAvailable,
      })
    } catch (e) {
      console.error('[user/broker-credentials POST tradovate] failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to save Tradovate credential' }, { status: 500 })
    }
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
