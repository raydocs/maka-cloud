import type { SignedInDevices } from './contract';
import { ApiError } from './client';
import { Store } from './store';

export type Provider = 'apple' | 'google';

/** Which ways in the server has turned on (`GET /v1/auth/options`). */
export interface SignInWays {
  apple: boolean;
  google: boolean;
  email: boolean;
}

/** The person closed Apple's or Google's sheet. That is not a failure and says nothing. */
export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in was cancelled.');
  }
}

/** What only the platform can do. */
export interface AuthPlatform {
  /**
   * Shows Apple's or Google's own sheet. The nonce is the server's, passed on unchanged; the
   * provider puts it in the ID token it returns. Throws `SignInCancelled` when the person backs out.
   */
  credential(provider: Provider, nonce: string): Promise<string>;
  /** What this device is called in the list of signed-in devices. */
  deviceLabel: string;
}

export type AuthState =
  /** Reading which ways in the server offers. */
  | { step: 'loading' }
  | { step: 'choose'; ways: SignInWays; error: string }
  /** A request is out; the screen shows progress and takes no input. */
  | { step: 'working'; ways: SignInWays }
  | { step: 'emailSent'; address: string; error: string }
  /** The identity is proven but has no account yet: ask for the invite code, once. */
  | { step: 'needsInvite'; error: string }
  /** The options could not be read (no connection, or this is not a Maka server). */
  | { step: 'failed'; message: string }
  | { step: 'signedIn' };

export interface AuthFlowOptions {
  platform: AuthPlatform;
  /** Prefix for every path, as for `CloudClient`. */
  baseUrl?: string;
  fetcher?: typeof fetch;
  /**
   * The signed-in session's token. The caller keeps it where secrets go and opens the workspace
   * with it; if that throws, the flow says so and stays where it is.
   */
  onSignedIn: (token: string) => void | Promise<void>;
}

interface Challenge {
  challengeId: string;
  deviceSecret: string;
}

type Outcome =
  | { status: 'signed_in'; token: string }
  | { status: 'needs_invite'; pendingToken: string };

const NO_WAYS: SignInWays = { apple: false, google: false, email: false };

/**
 * Signing in: Apple, Google, or a code sent to an address. Nothing here is a UI. The secrets of a
 * half-finished sign-in (the code's device secret, the pending token) are held in the flow and
 * never in its state, which a screen renders. A late answer to a step the person has left is dropped.
 */
export class AuthFlow extends Store<AuthState> {
  private readonly platform: AuthPlatform;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly onSignedIn: AuthFlowOptions['onSignedIn'];
  private ways: SignInWays = NO_WAYS;
  private challenge: Challenge | undefined;
  private pendingToken: string | undefined;
  /** Bumped when a step starts or the person goes back; an answer for an older one is dropped. */
  private turn = 0;

  constructor(options: AuthFlowOptions) {
    super({ step: 'loading' });
    this.platform = options.platform;
    this.baseUrl = options.baseUrl ?? '';
    const given = options.fetcher;
    this.fetcher = given ? (input, init) => given(input, init) : globalThis.fetch.bind(globalThis);
    this.onSignedIn = options.onSignedIn;
  }

  /** Reads which ways in the server offers. Also the retry after `failed`. */
  async start(): Promise<void> {
    const mine = ++this.turn;
    this.set({ step: 'loading' });
    try {
      const ways = await this.call<SignInWays>('GET', '/v1/auth/options');
      if (mine !== this.turn) return;
      this.ways = {
        apple: ways.apple === true,
        google: ways.google === true,
        email: ways.email === true,
      };
      this.choose('');
    } catch (e) {
      if (mine !== this.turn) return;
      this.set({ step: 'failed', message: failure(e, 'options') });
    }
  }

  async signInWith(provider: Provider): Promise<void> {
    if (this.state.step !== 'choose' || !this.ways[provider]) return;
    const mine = ++this.turn;
    this.set({ step: 'working', ways: this.ways });
    try {
      const { nonce } = await this.call<{ nonce: string }>('POST', '/v1/auth/nonce');
      if (mine !== this.turn) return;
      const idToken = await this.platform.credential(provider, nonce);
      if (mine !== this.turn) return;
      const outcome = await this.call<Outcome>('POST', '/v1/auth/session', {
        provider,
        idToken,
        nonce,
        device: this.platform.deviceLabel,
      });
      await this.finish(mine, outcome);
    } catch (e) {
      if (mine !== this.turn) return;
      this.choose(e instanceof SignInCancelled ? '' : failure(e, 'provider'));
    }
  }

  /** Asks for a code to be mailed to the address. */
  async sendEmail(address: string): Promise<void> {
    if ((this.state.step !== 'choose' && this.state.step !== 'emailSent') || !this.ways.email)
      return;
    const to = address.trim();
    if (!to) return;
    const mine = ++this.turn;
    const before = this.state;
    this.set({ step: 'working', ways: this.ways });
    try {
      const challenge = await this.call<Challenge>('POST', '/v1/auth/email', { address: to });
      if (mine !== this.turn) return;
      this.challenge = challenge;
      this.set({ step: 'emailSent', address: to, error: '' });
    } catch (e) {
      if (mine !== this.turn) return;
      const error = failure(e, 'email-request');
      if (before.step === 'emailSent') this.set({ ...before, error });
      else this.choose(error);
    }
  }

  /** Redeems the code from the mail. */
  async verifyEmail(code: string): Promise<void> {
    const before = this.state;
    const challenge = this.challenge;
    if (before.step !== 'emailSent' || !challenge) return;
    const typed = code.replace(/\s+/gu, '');
    if (!typed) return;
    const mine = ++this.turn;
    this.set({ step: 'working', ways: this.ways });
    try {
      const outcome = await this.call<Outcome>('POST', '/v1/auth/email/verify', {
        challengeId: challenge.challengeId,
        deviceSecret: challenge.deviceSecret,
        code: typed,
        device: this.platform.deviceLabel,
      });
      await this.finish(mine, outcome);
    } catch (e) {
      if (mine !== this.turn) return;
      // A code is tried a few times; a 401 may mean it is used up, so the person can ask for another.
      this.set({ ...before, error: failure(e, 'email-verify') });
    }
  }

  /** The one-time invite code of a person with no account yet. */
  async claim(inviteToken: string): Promise<void> {
    const pending = this.pendingToken;
    if (this.state.step !== 'needsInvite' || !pending) return;
    const token = inviteToken.trim();
    if (!token) return;
    const mine = ++this.turn;
    this.set({ step: 'working', ways: this.ways });
    try {
      const outcome = await this.call<Outcome>('POST', '/v1/auth/claim', {
        pendingToken: pending,
        inviteToken: token,
        device: this.platform.deviceLabel,
      });
      await this.finish(mine, outcome);
    } catch (e) {
      if (mine !== this.turn) return;
      if (e instanceof ApiError && e.status === 401) {
        // The sign-in itself ran out (ten minutes or five tries): start again from the top.
        this.pendingToken = undefined;
        this.choose('That sign-in ran out. Start again.');
      } else this.set({ step: 'needsInvite', error: failure(e, 'claim') });
    }
  }

  /**
   * The flow is no longer on screen (another server was chosen, or the screen went away). Whatever
   * it was waiting for is dropped, and a session the server still issues for it is ended instead of
   * being handed on. Starting the flow again makes it live again.
   */
  close(): void {
    this.turn += 1;
    this.forget();
  }

  /** Leaves the email or invite step and forgets what it held. */
  back(): void {
    if (this.state.step !== 'emailSent' && this.state.step !== 'needsInvite') return;
    this.turn += 1;
    this.forget();
    this.choose('');
  }

  private async finish(mine: number, outcome: Outcome): Promise<void> {
    if (!validOutcome(outcome)) {
      // Not what a Maka server answers (a proxy's page, another service): a plain error, nothing handed on.
      if (mine === this.turn) this.choose(failure(new ApiError(502), 'provider'));
      return;
    }
    if (mine !== this.turn) {
      // The person left this step, but the server has already issued a session for it: end it.
      if (outcome.status === 'signed_in') void this.endSession(outcome.token);
      return;
    }
    if (outcome.status === 'needs_invite') {
      this.forget();
      this.pendingToken = outcome.pendingToken;
      this.set({ step: 'needsInvite', error: '' });
      return;
    }
    this.forget();
    try {
      await this.onSignedIn(outcome.token);
    } catch (e) {
      // The device did not take the session (for example the secure store refused it): end it.
      void this.endSession(outcome.token);
      if (mine !== this.turn) return;
      // Our own words (a failed save on the device) are shown as written; anything else is described.
      this.choose(e instanceof Error && e.constructor === Error ? e.message : failure(e, 'open'));
      return;
    }
    if (mine === this.turn) this.set({ step: 'signedIn' });
  }

  /** Best effort: a session no device holds should not sit in the list of signed-in devices. */
  private async endSession(token: string): Promise<void> {
    try {
      await this.fetcher(`${this.baseUrl}/v1/auth/sign-out`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // It ends by itself when idle.
    }
  }

  private forget(): void {
    this.challenge = undefined;
    this.pendingToken = undefined;
  }

  private choose(error: string): void {
    this.set({ step: 'choose', ways: this.ways, error });
  }

  private set(next: AuthState): void {
    this.update(() => next);
  }

  private get state(): AuthState {
    return this.getSnapshot();
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await response.json().catch(() => undefined)) as
      | (T & { error?: unknown })
      | undefined;
    if (!response.ok)
      throw new ApiError(
        response.status,
        typeof parsed?.error === 'string' ? parsed.error : undefined,
        parsed,
      );
    if (parsed === undefined) throw new Error('The server sent no answer.');
    return parsed;
  }
}

/** A device session token, as the server issues it. */
const SESSION_PREFIX = 'mks_';

function validOutcome(outcome: unknown): outcome is Outcome {
  if (typeof outcome !== 'object' || outcome === null) return false;
  const { status, token, pendingToken } = outcome as Record<string, unknown>;
  if (status === 'signed_in') return typeof token === 'string' && token.startsWith(SESSION_PREFIX);
  return status === 'needs_invite' && typeof pendingToken === 'string' && pendingToken !== '';
}

type Step = 'options' | 'provider' | 'email-request' | 'email-verify' | 'claim' | 'open';

/** What went wrong, in words for the person. The server's reasons are deliberately few. */
function failure(error: unknown, step: Step): string {
  if (error instanceof ApiError) {
    // The sign-in worked; it is the workspace that did not open, so the sign-in's words do not fit.
    if (step === 'open')
      return `Signed in, but the workspace could not be opened (${error.status}). Try again.`;
    if (error.status === 429)
      return step === 'email-request'
        ? 'Wait a few seconds before asking for another code.'
        : 'Too many tries. Wait a moment and try again.';
    if (error.status === 400)
      return step === 'email-request'
        ? 'Enter a valid email address.'
        : 'That did not look right. Check it and try again.';
    if (error.status === 403)
      return 'That invite code did not work. Check it, or ask for a new one.';
    if (error.status === 401 && step === 'email-verify')
      return 'That code is not right, or it has expired. Check it, or ask for a new code.';
    if (error.status === 401) return 'We could not sign you in. Try again.';
    if (error.status === 404)
      return step === 'options'
        ? 'This address does not look like a Maka server.'
        : 'That way of signing in is not available here.';
    if (error.status === 503) return 'The code could not be sent. Try again in a moment.';
    return `Could not sign in (${error.status}). Try again.`;
  }
  return 'Could not reach the server. Check your connection and try again.';
}

/** When a device was last active, in words ("Active now", "Active 3 hours ago"). */
export function activeWords(lastSeenAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - lastSeenAt) / 60_000));
  if (minutes < 2) return 'Active now';
  if (minutes < 60) return `Active ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Active ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `Active ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** Which ways an account signs in, in words ("Apple, Google and email ada@example.com"). */
export function identityWords(identities: SignedInDevices['identities']): string {
  const names = identities.map((identity) =>
    identity.provider === 'apple'
      ? 'Apple'
      : identity.provider === 'google'
        ? 'Google'
        : identity.email
          ? `email ${identity.email}`
          : 'email',
  );
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
