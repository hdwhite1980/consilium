// =============================================================
// app/lib/trading/credentials.ts
//
// Server-side helpers for storing/loading broker API credentials.
// Secrets are AES-256-GCM encrypted before insert. Plaintext secrets
// only exist briefly in memory at write/read time.
// =============================================================

import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { encrypt, decrypt } from './encryption'

export interface BrokerCredentialRow {
  id: string
  userId: string
  broker: 'alpaca'
  mode: 'paper' | 'live'
  keyId: string

  // Cached Alpaca account info
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

/**
 * Public-safe view (never includes the decrypted secret).
 * This is what gets returned to the user-facing settings page.
 */
export interface BrokerCredentialView {
  id: string
  broker: 'alpaca'
  mode: 'paper' | 'live'
  keyIdMasked: string                  // e.g. "PK********ABCD"
  accountId: string | null
  accountStatus: string | null
  accountCash: number | null
  accountEquity: number | null
  lastSyncedAt: string | null
  lastValidatedAt: string | null
  validationError: string | null
  createdAt: string
}

function maskKeyId(keyId: string): string {
  if (!keyId || keyId.length < 8) return '****'
  return keyId.slice(0, 2) + '*'.repeat(Math.max(4, keyId.length - 6)) + keyId.slice(-4)
}

interface DbRow {
  id: string
  user_id: string
  broker: string
  mode: string
  key_id: string
  encrypted_secret: string
  account_id: string | null
  account_status: string | null
  account_cash: string | number | null
  account_equity: string | number | null
  last_synced_at: string | null
  last_validated_at: string | null
  validation_error: string | null
  created_at: string
  updated_at: string
}

function rowToCred(row: DbRow): BrokerCredentialRow {
  return {
    id: row.id,
    userId: row.user_id,
    broker: row.broker as 'alpaca',
    mode: row.mode as 'paper' | 'live',
    keyId: row.key_id,
    accountId: row.account_id,
    accountStatus: row.account_status,
    accountCash: row.account_cash !== null ? Number(row.account_cash) : null,
    accountEquity: row.account_equity !== null ? Number(row.account_equity) : null,
    lastSyncedAt: row.last_synced_at,
    lastValidatedAt: row.last_validated_at,
    validationError: row.validation_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToView(row: BrokerCredentialRow): BrokerCredentialView {
  return {
    id: row.id,
    broker: row.broker,
    mode: row.mode,
    keyIdMasked: maskKeyId(row.keyId),
    accountId: row.accountId,
    accountStatus: row.accountStatus,
    accountCash: row.accountCash,
    accountEquity: row.accountEquity,
    lastSyncedAt: row.lastSyncedAt,
    lastValidatedAt: row.lastValidatedAt,
    validationError: row.validationError,
    createdAt: row.createdAt,
  }
}

/**
 * Save (or replace) a credential. Encrypts the secret. UNIQUE constraint
 * on (user_id, broker, mode) means re-saving for the same combo overwrites.
 */
export async function saveBrokerCredential(opts: {
  userId: string
  broker: 'alpaca'
  mode: 'paper' | 'live'
  keyId: string
  secret: string
}): Promise<BrokerCredentialRow> {
  const admin = await getSupabaseAdmin()
  const encryptedSecret = encrypt(opts.secret)

  // Upsert: check existing, then insert or update
  const { data: existing } = await admin
    .from('user_broker_credentials')
    .select('id')
    .eq('user_id', opts.userId)
    .eq('broker', opts.broker)
    .eq('mode', opts.mode)
    .maybeSingle()

  if (existing) {
    const { data, error } = await admin
      .from('user_broker_credentials')
      .update({
        key_id: opts.keyId,
        encrypted_secret: encryptedSecret,
        // Reset validation fields — they'll be re-set on next validation
        last_validated_at: null,
        validation_error: null,
      })
      .eq('id', (existing as { id: string }).id)
      .select('*')
      .single()
    if (error) throw new Error(`saveBrokerCredential update failed: ${error.message}`)
    return rowToCred(data as DbRow)
  }

  const { data, error } = await admin
    .from('user_broker_credentials')
    .insert({
      user_id: opts.userId,
      broker: opts.broker,
      mode: opts.mode,
      key_id: opts.keyId,
      encrypted_secret: encryptedSecret,
    })
    .select('*')
    .single()
  if (error) throw new Error(`saveBrokerCredential insert failed: ${error.message}`)
  return rowToCred(data as DbRow)
}

/**
 * Load and decrypt credentials for use by the trading worker.
 * Returns { keyId, secret } in plaintext — handle carefully.
 */
export async function loadBrokerCredentialForUse(
  userId: string,
  broker: 'alpaca',
  mode: 'paper' | 'live',
): Promise<{ row: BrokerCredentialRow; keyId: string; secret: string } | null> {
  const admin = await getSupabaseAdmin()
  const { data, error } = await admin
    .from('user_broker_credentials')
    .select('*')
    .eq('user_id', userId)
    .eq('broker', broker)
    .eq('mode', mode)
    .maybeSingle()
  if (error) throw new Error(`loadBrokerCredentialForUse failed: ${error.message}`)
  if (!data) return null
  const row = rowToCred(data as DbRow)
  const dbRow = data as DbRow
  const secret = decrypt(dbRow.encrypted_secret)
  return { row, keyId: row.keyId, secret }
}

/**
 * List a user's credentials in safe view form (no secrets).
 */
export async function listBrokerCredentials(userId: string): Promise<BrokerCredentialView[]> {
  const admin = await getSupabaseAdmin()
  const { data, error } = await admin
    .from('user_broker_credentials')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`listBrokerCredentials failed: ${error.message}`)
  return (data ?? []).map(r => rowToView(rowToCred(r as DbRow)))
}

/**
 * Delete a credential row.
 */
export async function deleteBrokerCredential(userId: string, credentialId: string): Promise<void> {
  const admin = await getSupabaseAdmin()
  const { error } = await admin
    .from('user_broker_credentials')
    .delete()
    .eq('id', credentialId)
    .eq('user_id', userId)
  if (error) throw new Error(`deleteBrokerCredential failed: ${error.message}`)
}

/**
 * Update cached account info after a successful Alpaca /v2/account hit.
 */
export async function updateCachedAccountInfo(
  credentialId: string,
  info: { accountId?: string; accountStatus?: string; cash?: number; equity?: number },
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin
    .from('user_broker_credentials')
    .update({
      account_id: info.accountId ?? null,
      account_status: info.accountStatus ?? null,
      account_cash: info.cash ?? null,
      account_equity: info.equity ?? null,
      last_synced_at: new Date().toISOString(),
      last_validated_at: new Date().toISOString(),
      validation_error: null,
    })
    .eq('id', credentialId)
}

/**
 * Record a validation failure (bad key, network error, etc.)
 */
export async function recordValidationError(credentialId: string, errorMsg: string): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin
    .from('user_broker_credentials')
    .update({
      last_validated_at: new Date().toISOString(),
      validation_error: errorMsg.slice(0, 500),
    })
    .eq('id', credentialId)
}
