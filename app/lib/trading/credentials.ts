// =============================================================
// app/lib/trading/credentials.ts
//
// Multi-asset, multi-broker credential storage.
// Each row is keyed (user_id, broker, mode, asset_class).
// Secrets AES-256-GCM encrypted.
//
// Layer 4 additions:
//   - Tradovate session token cache fields (encrypted)
//   - loadTradovateSession / saveTradovateToken helpers
// =============================================================

import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { encrypt, decrypt } from './encryption'
import type { AssetClass } from './settings'

export type BrokerName = 'alpaca' | 'oanda' | 'tradovate' | 'coinbase'

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
  asset_class: string | null
  key_id: string; encrypted_secret: string
  account_id: string | null; account_status: string | null
  account_cash: string | number | null; account_equity: string | number | null
  last_synced_at: string | null; last_validated_at: string | null; validation_error: string | null
  cached_access_token: string | null
  cached_token_expires_at: string | null
  cached_account_spec: string | null
  cached_account_int_id: number | null
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
  // Tradovate-specific cached session state (optional)
  cachedAccessToken?: string
  cachedTokenExpiresAt?: string
  cachedAccountSpec?: string
  cachedAccountIntId?: number
}): Promise<BrokerCredentialRow> {
  const admin = await getSupabaseAdmin()
  const encryptedSecret = encrypt(opts.secret)

  const { data: existing } = await admin
    .from('user_broker_credentials')
    .select('id')
    .eq('user_id', opts.userId)
    .eq('broker', opts.broker)
    .eq('mode', opts.mode)
    .eq('asset_class', opts.assetClass)
    .maybeSingle()

  const upsertFields: Record<string, unknown> = {
    key_id: opts.keyId,
    encrypted_secret: encryptedSecret,
    account_id: opts.accountId ?? null,
    last_validated_at: null,
    validation_error: null,
  }
  if (opts.cachedAccessToken !== undefined) upsertFields.cached_access_token = encrypt(opts.cachedAccessToken)
  if (opts.cachedTokenExpiresAt !== undefined) upsertFields.cached_token_expires_at = opts.cachedTokenExpiresAt
  if (opts.cachedAccountSpec !== undefined) upsertFields.cached_account_spec = opts.cachedAccountSpec
  if (opts.cachedAccountIntId !== undefined) upsertFields.cached_account_int_id = opts.cachedAccountIntId

  if (existing) {
    const { data, error } = await admin
      .from('user_broker_credentials')
      .update(upsertFields)
      .eq('id', (existing as { id: string }).id)
      .select('*').single()
    if (error) throw new Error(`saveBrokerCredential update failed: ${error.message}`)
    return rowToCred(data as DbRow)
  }

  const insertFields: Record<string, unknown> = {
    user_id: opts.userId,
    broker: opts.broker,
    mode: opts.mode,
    asset_class: opts.assetClass,
    ...upsertFields,
  }
  const { data, error } = await admin
    .from('user_broker_credentials')
    .insert(insertFields)
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

/**
 * Tradovate-specific: load credential + cached session state.
 * Returns enough to construct a TradovateClient.
 */
export interface TradovateSessionLoad {
  credentialRowId: string
  // Persisted creds — used to refresh the access token when needed
  username: string                  // stored in key_id
  password: string                  // first part of structured secret
  appId: string
  appVersion: string
  cid: string
  sec: string
  // Cached session (may be expired)
  cachedAccessToken: string | null
  cachedTokenExpiresAt: string | null
  accountSpec: string | null
  accountIntId: number | null
}

/**
 * Coinbase-specific credential loader.
 *
 * Coinbase has no paper/sandbox mode — all trading is live. We store
 * Coinbase credentials with mode='live', asset_class='crypto'.
 *
 *   key_id           = full CDP key name "organizations/{org}/apiKeys/{key}"
 *   encrypted_secret = Ed25519 private key (PEM or base64 raw seed format)
 *
 * Returns null if no Coinbase credential is configured for this user.
 */
export async function loadCoinbaseCredential(
  userId: string,
): Promise<{ credentialRowId: string; keyName: string; privateKey: string } | null> {
  const admin = await getSupabaseAdmin()
  const { data, error } = await admin
    .from('user_broker_credentials')
    .select('*')
    .eq('user_id', userId)
    .eq('broker', 'coinbase')
    .eq('mode', 'live')
    .eq('asset_class', 'crypto')
    .maybeSingle()
  if (error || !data) return null
  const dbRow = data as DbRow
  return {
    credentialRowId: dbRow.id,
    keyName: dbRow.key_id,
    privateKey: decrypt(dbRow.encrypted_secret),
  }
}

export async function loadTradovateSession(
  userId: string,
  mode: 'paper' | 'live',
): Promise<TradovateSessionLoad | null> {
  const admin = await getSupabaseAdmin()
  const { data, error } = await admin
    .from('user_broker_credentials')
    .select('*')
    .eq('user_id', userId)
    .eq('broker', 'tradovate')
    .eq('mode', mode)
    .eq('asset_class', 'futures')
    .maybeSingle()
  if (error || !data) return null
  const dbRow = data as DbRow

  // The "secret" for Tradovate is a JSON-encoded blob with all the creds
  // beyond username. We store: { password, appId, appVersion, cid, sec }
  // username goes in key_id (plaintext, like Alpaca key_id)
  let bundle: { password: string; appId: string; appVersion: string; cid: string; sec: string }
  try {
    bundle = JSON.parse(decrypt(dbRow.encrypted_secret)) as typeof bundle
  } catch {
    return null
  }
  const cachedToken = dbRow.cached_access_token ? decrypt(dbRow.cached_access_token) : null
  return {
    credentialRowId: dbRow.id,
    username: dbRow.key_id,
    password: bundle.password,
    appId: bundle.appId,
    appVersion: bundle.appVersion,
    cid: bundle.cid,
    sec: bundle.sec,
    cachedAccessToken: cachedToken,
    cachedTokenExpiresAt: dbRow.cached_token_expires_at,
    accountSpec: dbRow.cached_account_spec,
    accountIntId: dbRow.cached_account_int_id,
  }
}

export async function saveTradovateTokenCache(
  credentialRowId: string,
  accessToken: string,
  expiresAt: string,
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('user_broker_credentials').update({
    cached_access_token: encrypt(accessToken),
    cached_token_expires_at: expiresAt,
  }).eq('id', credentialRowId)
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
