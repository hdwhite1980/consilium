// =============================================================
// app/lib/trading/encryption.ts
//
// AES-256-GCM encryption for broker API secrets.
//
// Key management:
//   - BROKER_ENCRYPTION_KEY env var holds the encryption key
//   - Must be a 32-byte hex string (64 hex chars). Generate via:
//       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//   - If the key is lost, all stored secrets are unrecoverable.
//     ALWAYS back up the encryption key separately from the DB.
//
// Output format: base64(iv || ciphertext || authTag)
//   - iv:         12 bytes (GCM standard)
//   - ciphertext: variable
//   - authTag:    16 bytes
// =============================================================

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

function getKey(): Buffer {
  const raw = process.env.BROKER_ENCRYPTION_KEY
  if (!raw) {
    throw new Error('BROKER_ENCRYPTION_KEY env var is required for broker credential encryption')
  }
  // Accept either 64-hex-char string (32 bytes) or any string we hash to 32 bytes.
  // Hex is the recommended format because it's deterministic. Hashing is a
  // fallback so a typo or shorter key doesn't crash — but you should use hex
  // in production.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex')
  }
  // Fallback: hash the provided string to 32 bytes via SHA-256
  return createHash('sha256').update(raw).digest()
}

/**
 * Encrypt a plaintext string. Returns base64(iv || ciphertext || authTag).
 */
export function encrypt(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new Error('encrypt: plaintext must be a string')
  }
  const key = getKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, ciphertext, authTag]).toString('base64')
}

/**
 * Decrypt a base64-encoded bundle produced by encrypt().
 * Throws if the bundle is corrupt, the auth tag fails, or the key is wrong.
 */
export function decrypt(encoded: string): string {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('decrypt: encoded value must be a non-empty string')
  }
  const key = getKey()
  const buf = Buffer.from(encoded, 'base64')
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('decrypt: encoded value is too short to be valid')
  }
  const iv = buf.subarray(0, IV_LENGTH)
  const authTag = buf.subarray(buf.length - AUTH_TAG_LENGTH)
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

/**
 * Self-test. Call from a CLI or health-check route to verify the
 * encryption key is set and round-trip works.
 */
export function selfTest(): { ok: true } | { ok: false; error: string } {
  try {
    const plaintext = 'self-test-' + Date.now()
    const enc = encrypt(plaintext)
    const dec = decrypt(enc)
    if (dec !== plaintext) {
      return { ok: false, error: 'Round-trip mismatch' }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
