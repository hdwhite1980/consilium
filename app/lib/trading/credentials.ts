// =============================================================
// app/lib/trading/credentials.ts
//
// Multi-asset, multi-broker credential storage.
// Each row is keyed (user_id, broker, mode, asset_class).
// Secrets AES-256-GCM encrypted.
// =============================================================

import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { encrypt, decrypt } from './encryption'
import type { AssetClass } from './settings'

export type BrokerName = 'alpaca' | 'oanda' | 'tradovate'

export interface BrokerCredentialRow {
  id: string
  userId: string
  broker: BrokerName
  mode: 'paper' | 'live'
  assetClass: AssetClass
  keyId: string
  accountId: string | null
  accountStatus: string | null
  accountCash: number | null
  accountEquity: number | null
  lastSyncedAt: string | null
  lastValidatedAt: string | null
  validationError: string | null
  createdAt: string
  updatedAt: string
}

export interface BrokerCredentialView {
  id: string
  broker: BrokerName
  mode: 'paper' | 'live'
  assetClass: AssetClass
  keyIdMasked: string
  accountId: string | null
  accountStatus: string | null
  accountCash: number | null
  accountEquity: number | null
  lastSyncedAt: string | null
  lastValidatedAt: string | null
  validationError: string | null
  createdAt: string
}

interface DbRow {
  id: string; user_id: string; broker: string; mode: string
  asset_class: string | null    // null on legacy rows pre-migration
  key_id: string; encrypted_secret: string
  account_id: string | null; account_status: string | null
  account_cash: string | number | null; account_equity: string | number | null
  last_synced_at: string | null; last_validated_at: string | null; validation_error: string | null
  created_at: string; updated_at: string
}

function maskKeyId(keyId: string): string {
  if (!keyId || keyId.length < 8) return '****'
  return keyId.slice(0, 2) + '*'.repeat(Math.max(4, keyId.length - 6)) + keyId.slice(-4)
}

function rowToCred(row: DbRow): BrokerCredentialRow {
  return {
    id: row.id, userId: row.user_id,
    broker: row.broker as BrokerName, mode: row.mode as 'paper' | 'live',
    assetClass: (row.asset_class ?? 'stock') as AssetClass,
    keyId: row.key_id,
    accountId: row.account_id, accountStatus: row.account_status,
    accountCash: row.account_cash !== null ? Number(row.account_cash) : null,
    accountEquity: row.account_equity !== null ? Number(row.account_equity) : null,
    lastSyncedAt: row.last_synced_at, lastValidatedAt: row.last_validated_at,
    validationError: row.validation_error,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function rowToView(row: DbRow): BrokerCredentialView {
  const c = rowToCred(row)
  return {
    id: c.id, broker: c.broker, mode: c.mode, assetClass: c.assetClass,
    keyIdMasked: maskKeyId(c.keyId),
    accountId: c.accountId, accountStatus: c.accountStatus,
    accountCash: c.accountCash, accountEquity: c.accountEquity,
    lastSyncedAt: c.lastSyncedAt, lastValidatedAt: c.lastValidatedAt,
    validationError: c.validationError, createdAt: c.createdAt,
  }
}

export async function saveBrokerCredential(opts: {
  userId: string
  broker: BrokerName
  mode: 'paper' | 'live'
  assetClass: AssetClass
  keyId: string
  secret: string
  accountId?: string | null
}): Promise<BrokerCredentialRow> {
  const admin = await getSupabaseAdmin()
  const encryptedSecret = encrypt(opts.secret)

  // Look up existing (user, broker, mode, asset_class) tuple
  const { data: existing } = await admin
    .from('user_broker_credentials')
    .select('id')
    .eq('user_id', opts.userId)
    .eq('broker', opts.broker)
    .eq('mode', opts.mode)
    .eq('asset_class', opts.assetClass)
    .maybeSingle()

  if (existing) {
    const { data, error } = await admin
      .from('user_broker_credentials')
      .update({
        key_id: opts.keyId,
        encrypted_secret: encryptedSecret,
        account_id: opts.accountId ?? null,
        last_validated_at: null,
        validation_error: null,
      })
      .eq('id', (existing as { id: string }).id)
      .select('*').single()
    if (error) throw new Error(`saveBrokerCredential update failed: ${error.message}`)
    return rowToCred(data as DbRow)
  }

  const { data, error } = await admin
    .from('user_broker_credentials')
    .insert({
      user_id: opts.userId,
      broker: opts.broker,
      mode: opts.mode,
      asset_class: opts.assetClass,
      key_id: opts.keyId,
      encrypted_secret: encryptedSecret,
      account_id: opts.accountId ?? null,
    })
    .select('*').single()
  if (error) throw new Error(`saveBrokerCredential insert failed: ${error.message}`)
  return rowToCred(data as DbRow)
}

export async function loadBrokerCredentialForUse(
  userId: string,
  broker: BrokerName,
  mode: 'paper' | 'live',
  assetClass: AssetClass = 'stock',
): Promise<{ row: BrokerCredentialRow; keyId: string; secret: string } | null> {
  const admin = await getSupabaseAdmin()
  const { data, error } = await admin
    .from('user_broker_credentials')
    .select('*')
    .eq('user_id', userId)
    .eq('broker', broker)
    .eq('mode', mode)
    .eq('asset_class', assetClass)
    .maybeSingle()
  if (error) throw new Error(`loadBrokerCredentialForUse failed: ${error.message}`)
  if (!data) return null
  const row = rowToCred(data as DbRow)
  const dbRow = data as DbRow
  const secret = decrypt(dbRow.encrypted_secret)
  return { row, keyId: row.keyId, secret }
}

export async function listBrokerCredentials(userId: string): Promise<BrokerCredentialView[]> {
  const admin = await getSupabaseAdmin()
  const { data, error } = await admin
    .from('user_broker_credentials')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`listBrokerCredentials failed: ${error.message}`)
  return (data ?? []).map(r => rowToView(r as DbRow))
}

export async function deleteBrokerCredential(userId: string, credentialId: string): Promise<void> {
  const admin = await getSupabaseAdmin()
  const { error } = await admin.from('user_broker_credentials').delete().eq('id', credentialId).eq('user_id', userId)
  if (error) throw new Error(`deleteBrokerCredential failed: ${error.message}`)
}

export async function updateCachedAccountInfo(
  credentialId: string,
  info: {
    accountId?: string | null
    accountStatus?: string | null
    accountCash?: number | null
    accountEquity?: number | null
  }
): Promise<void> {
  const admin = await getSupabaseAdmin()
  const now = new Date().toISOString()
  await admin.from('user_broker_credentials').update({
    account_id: info.accountId ?? null,
    account_status: info.accountStatus ?? null,
    account_cash: info.accountCash ?? null,
    account_equity: info.accountEquity ?? null,
    last_synced_at: now,
    last_validated_at: now,
    validation_error: null,
  }).eq('id', credentialId)
}

export async function recordValidationError(credentialId: string, errorMsg: string): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('user_broker_credentials').update({
    validation_error: errorMsg.slice(0, 500),
    last_validated_at: new Date().toISOString(),
  }).eq('id', credentialId)
}
