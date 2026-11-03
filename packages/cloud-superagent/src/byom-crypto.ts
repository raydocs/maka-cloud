import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function hmacOk(secret: string, payload: string, offered: string): boolean {
  const expected = Buffer.from(hmacHex(secret, payload), 'hex');
  let got: Buffer;
  try {
    got = Buffer.from(offered, 'hex');
  } catch {
    return false;
  }
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function randomPairingCode(length = 8): string {
  const raw = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += PAIRING_ALPHABET[raw[i]! % PAIRING_ALPHABET.length];
  }
  return out;
}

export function randomNonce(): string {
  return randomBytes(16).toString('hex');
}
