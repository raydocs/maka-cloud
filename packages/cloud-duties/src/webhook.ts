import { createHmac, timingSafeEqual } from 'node:crypto';

/** The events a duty can wake on. `ping` is GitHub's test delivery. Any other event is rejected. */
export const ACCEPTED_EVENTS = [
  'ping',
  'workflow_run',
  'issues',
  'issue_comment',
  'pull_request_review_comment',
  'pull_request_review',
] as const;
export type AcceptedEvent = (typeof ACCEPTED_EVENTS)[number];

export const MAX_BODY_BYTES = 1_048_576;
export const MIN_SECRET_LENGTH = 16;
const DELIVERY_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/u;

export type Rejection = {
  ok: false;
  status: 400 | 401 | 413;
  code:
    | 'missing_delivery_id'
    | 'missing_signature'
    | 'bad_signature'
    | 'unsupported_event'
    | 'invalid_payload'
    | 'too_large';
};

export type Headers = Readonly<Record<string, string | string[] | undefined>>;

export interface Delivery {
  ok: true;
  deliveryId: string;
  event: AcceptedEvent;
  payload: unknown;
}

function one(headers: Headers, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

/** HMAC-SHA256 of the raw body, compared in constant time. A malformed header never matches. */
export function verifySignature(
  secret: string,
  body: Uint8Array,
  header: string | undefined,
): boolean {
  const match = header === undefined ? null : SIGNATURE.exec(header);
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(match[1] as string, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Admits one webhook request or says why not. Fail closed, in this order: the body is too large,
 * no delivery id, no or wrong signature (nothing about the request is read before it is proven to
 * come from GitHub), an event this product does not handle, a body that is not JSON.
 */
export function readDelivery(
  secret: string,
  headers: Headers,
  body: Uint8Array,
): Delivery | Rejection {
  if (body.length > MAX_BODY_BYTES) return { ok: false, status: 413, code: 'too_large' };
  const signature = one(headers, 'x-hub-signature-256');
  if (signature === undefined) return { ok: false, status: 401, code: 'missing_signature' };
  if (!verifySignature(secret, body, signature)) {
    return { ok: false, status: 401, code: 'bad_signature' };
  }
  const deliveryId = one(headers, 'x-github-delivery');
  if (deliveryId === undefined || !DELIVERY_ID.test(deliveryId)) {
    return { ok: false, status: 400, code: 'missing_delivery_id' };
  }
  const event = one(headers, 'x-github-event');
  if (event === undefined || !(ACCEPTED_EVENTS as readonly string[]).includes(event)) {
    return { ok: false, status: 400, code: 'unsupported_event' };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    return { ok: false, status: 400, code: 'invalid_payload' };
  }
  return { ok: true, deliveryId, event: event as AcceptedEvent, payload };
}
