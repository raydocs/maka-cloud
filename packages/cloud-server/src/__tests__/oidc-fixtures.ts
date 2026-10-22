import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';

export const NOW = 1_800_000_000_000;
export const AUD = 'cloud.maka.app';
export const NONCE = 'n0nce-from-the-server';

export interface Signer {
  kid: string;
  privateKey: KeyObject;
  jwk: JsonWebKey & { kid: string };
}

export function signer(kid: string, bits = 2048): Signer {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
  };
}

export const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function token(
  key: Signer,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const head = b64({ alg: 'RS256', kid: key.kid, ...header });
  const body = b64({
    iss: 'https://accounts.google.com',
    aud: AUD,
    sub: 'g-123',
    exp: NOW / 1000 + 600,
    iat: NOW / 1000 - 10,
    nonce: NONCE,
    email: 'ada@example.com',
    email_verified: true,
    ...claims,
  });
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key.privateKey).toString(
    'base64url',
  );
  return `${head}.${body}.${sig}`;
}
