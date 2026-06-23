// =============================================================
// app/api/admin/credentials/coinbase/route.ts
//
// Admin endpoint to add/verify Coinbase credentials.
//
// SECURITY:
//   - Gated by ADMIN_SECRET env var (not user auth — this is for ops only)
//   - Accepts the raw private key once, encrypts it, stores it
//   - Returns only metadata, never echoes the secret back
//
// USAGE (PowerShell):
//   $body = @{
//     userId = "709312ee-df59-47f2-a351-49660142ed77"
//     keyName = "organizations/abc/apiKeys/xyz"
//     privateKey = "-----BEGIN EC PRIVATE KEY-----`n...`n-----END EC PRIVATE KEY-----`n"
//   } | ConvertTo-Json
//   curl.exe -X POST https://wali-os.com/api/admin/credentials/coinbase `
//     -H "Authorization: Bearer YOUR_ADMIN_SECRET" `
//     -H "Content-Type: application/json" `
//     -d $body
//
// VERIFY (GET):
//   curl.exe https://wali-os.com/api/admin/credentials/coinbase?userId=... `
//     -H "Authorization: Bearer YOUR_ADMIN_SECRET"
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { saveBrokerCredential, loadCoinbaseCredential } from '@/app/lib/trading/credentials'
import { makeCoinbaseClient } from '@/app/lib/trading/coinbase-client'

export const runtime = 'nodejs'

function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.ADMIN_SECRET ?? process.env.CRON_SECRET ?? ''
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  return auth === `Bearer ${expected}`
}

interface AddCredentialBody {
  userId: string
  keyName: string
  privateKey: string
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: AddCredentialBody
  try {
    body = await req.json() as AddCredentialBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.userId || !body.keyName || !body.privateKey) {
    return NextResponse.json({
      error: 'Missing required fields: userId, keyName, privateKey'
    }, { status: 400 })
  }

  // Basic sanity check on keyName format
  if (!body.keyName.startsWith('organizations/') || !body.keyName.includes('/apiKeys/')) {
    return NextResponse.json({
      error: 'keyName must be in format: organizations/{org}/apiKeys/{key}'
    }, { status: 400 })
  }

  // Sanity check on private key
  const isPem = body.privateKey.includes('-----BEGIN') && body.privateKey.includes('PRIVATE KEY')
  const trimmed = body.privateKey.trim()
  const looksLikeBase64 = /^[A-Za-z0-9+/=]+$/.test(trimmed)
  if (!isPem && !looksLikeBase64) {
    return NextResponse.json({
      error: 'privateKey must be PEM (-----BEGIN PRIVATE KEY-----) or raw base64'
    }, { status: 400 })
  }

  // Test the key by attempting a Coinbase account call BEFORE saving
  try {
    const testClient = makeCoinbaseClient(body.keyName, body.privateKey)
    const account = await testClient.account()
    if (!account || account.status === 'INACTIVE') {
      return NextResponse.json({
        error: `Coinbase account check failed: status=${account?.status ?? 'unknown'}`
      }, { status: 400 })
    }
    // Now save (encryption happens inside saveBrokerCredential)
    const saved = await saveBrokerCredential({
      userId: body.userId,
      broker: 'coinbase',
      mode: 'live',
      assetClass: 'crypto',
      keyId: body.keyName,
      secret: body.privateKey,
    })

    return NextResponse.json({
      ok: true,
      credentialId: saved.id,
      keyNamePreview: body.keyName.slice(0, 40) + '...',
      accountStatus: account.status,
      cashUsd: account.cash,
      message: 'Coinbase credentials saved successfully. Set trade_crypto=true in user_trading_settings to enable trading.',
    })
  } catch (e) {
    return NextResponse.json({
      error: `Coinbase verification failed: ${e instanceof Error ? e.message : String(e)}`,
      hint: 'Common causes: wrong key format, key revoked, missing TRADE permission, network issue'
    }, { status: 400 })
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) {
    return NextResponse.json({ error: 'Missing userId query param' }, { status: 400 })
  }

  const cred = await loadCoinbaseCredential(userId)
  if (!cred) {
    return NextResponse.json({
      configured: false,
      message: 'No Coinbase credential configured for this user'
    })
  }

  // Test live connectivity
  try {
    const client = makeCoinbaseClient(cred.keyName, cred.privateKey)
    const account = await client.account()
    return NextResponse.json({
      configured: true,
      credentialId: cred.credentialRowId,
      keyNamePreview: cred.keyName.slice(0, 40) + '...',
      accountStatus: account.status,
      cashUsd: account.cash,
      equityUsd: account.equity,
    })
  } catch (e) {
    return NextResponse.json({
      configured: true,
      credentialId: cred.credentialRowId,
      keyNamePreview: cred.keyName.slice(0, 40) + '...',
      error: `Live connectivity check failed: ${e instanceof Error ? e.message : String(e)}`,
    })
  }
}
