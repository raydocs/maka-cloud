import type { IncomingMessage } from 'node:http';

/**
 * The web app keeps its device session in a cookie no script can read, so a reload or a tap on a
 * notification stays signed in and the token itself never reaches the page.
 *
 * - `__Host-` binds it to this host and path `/`, sent only over https (or to loopback).
 * - `SameSite=Strict` keeps other sites' requests from carrying it.
 * - It counts only on a request that also sends `X-Maka-Cookie: 1`. No other origin can send that
 *   header (the server answers no CORS preflight), so a cross-site form or image request is never
 *   signed in by it, whatever the browser does with `SameSite`.
 * - It only ever holds a device session (`mks_`), never an invite token.
 * - The server's own idle expiry (90 days) decides when it stops working; the cookie lasts as long
 *   as a browser keeps one (400 days in Chrome).
 */
export const SESSION_COOKIE = '__Host-maka-session';
export const COOKIE_HEADER = 'x-maka-cookie';

const SESSION_PREFIX = 'mks_';
const MAX_AGE_S = 400 * 24 * 60 * 60;
const ATTRIBUTES = 'Path=/; HttpOnly; Secure; SameSite=Strict';

/** Whether the caller asked to be signed in by the cookie, not by a bearer token. */
export function wantsCookie(req: IncomingMessage): boolean {
  return req.headers[COOKIE_HEADER] === '1';
}

/** The session token in the request's cookie, when it asked for the cookie and holds a session. */
export function cookieToken(req: IncomingMessage): string | undefined {
  if (!wantsCookie(req)) return undefined;
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(at + 1).trim();
    return value.startsWith(SESSION_PREFIX) ? value : undefined;
  }
  return undefined;
}

export function setSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${MAX_AGE_S}; ${ATTRIBUTES}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;
}
