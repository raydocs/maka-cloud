import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 1;

/** The key is wrong or missing. The message never holds any part of the key. */
export class PlanKeyError extends Error {}

/**
 * The key that seals stored plan credentials: 32 random bytes, as base64 or as 64 hex digits.
 * Anything else is refused, so a typo cannot silently become a weak key.
 */
export function parsePlanKey(text: string | undefined): Buffer {
  const value = text?.trim();
  if (value === undefined || value === '') throw new PlanKeyError('the plan key is not set');
  const key = /^[0-9a-fA-F]{64}$/u.test(value)
    ? Buffer.from(value, 'hex')
    : /^[A-Za-z0-9+/]{43}=?$/u.test(value)
      ? Buffer.from(value, 'base64')
      : undefined;
  if (key === undefined || key.length !== KEY_BYTES) {
    throw new PlanKeyError('the plan key must be 32 bytes, as base64 or 64 hex digits');
  }
  return key;
}

/**
 * AES-256-GCM. The associated data names the record the secret belongs to, so a sealed value copied
 * to another invite's row, or to another vendor's, does not open (Rakazo's record-bound AAD).
 */
export function seal(key: Buffer, aad: string, plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/** The plaintext, or `undefined` when the value is damaged, for another record or sealed with another key. */
export function open(key: Buffer, aad: string, sealed: Uint8Array): string | undefined {
  const bytes = Buffer.from(sealed);
  if (bytes.length < 1 + IV_BYTES + TAG_BYTES || bytes[0] !== VERSION) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 1 + IV_BYTES));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(bytes.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(1 + IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
}
