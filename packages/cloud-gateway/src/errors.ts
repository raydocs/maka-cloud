import type { Vendor } from './pricing.js';

export type Refusal =
  | 'invalid_request'
  | 'unauthenticated'
  | 'budget'
  | 'busy'
  | 'not_found'
  | 'too_large'
  | 'unavailable';

const STATUS: Record<Vendor, Record<Refusal, [number, string]>> = {
  anthropic: {
    invalid_request: [400, 'invalid_request_error'],
    unauthenticated: [401, 'authentication_error'],
    budget: [402, 'billing_error'],
    busy: [429, 'rate_limit_error'],
    not_found: [404, 'not_found_error'],
    too_large: [413, 'request_too_large'],
    unavailable: [503, 'api_error'],
  },
  openai: {
    invalid_request: [400, 'invalid_request_error'],
    unauthenticated: [401, 'invalid_api_key'],
    // The status and code a client treats as "out of money", not as a reason to retry.
    budget: [429, 'insufficient_quota'],
    busy: [429, 'rate_limit_exceeded'],
    not_found: [404, 'not_found'],
    too_large: [413, 'request_too_large'],
    unavailable: [503, 'server_error'],
  },
};

/** A refusal in the vendor's error shape, so the CLI reports it. The text names no vendor or model. */
export function refusalResponse(vendor: Vendor, refusal: Refusal, message: string): Response {
  const [status, type] = STATUS[vendor][refusal];
  const body =
    vendor === 'anthropic'
      ? { type: 'error', error: { type, message } }
      : { error: { message, type, code: type, param: null } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The event that ends a stream the gateway cut, in the vendor's stream shape. */
export function cutEvent(vendor: Vendor, message: string): Uint8Array {
  const text =
    vendor === 'anthropic'
      ? `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`
      : `event: error\ndata: ${JSON.stringify({ type: 'error', code: 'server_error', message, param: null })}\n\n`;
  return new TextEncoder().encode(text);
}
