import { Button } from '@astryxdesign/core';
import { AuthFlow, type AuthPlatform, type AuthState } from '@maka-cloud/client';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

/** "Chrome on Mac": what the list of signed-in devices calls this browser. */
export function browserLabel(userAgent: string): string {
  const browser = /Edg\//u.test(userAgent)
    ? 'Edge'
    : /Firefox\//u.test(userAgent)
      ? 'Firefox'
      : /Chrome\//u.test(userAgent)
        ? 'Chrome'
        : /Safari\//u.test(userAgent)
          ? 'Safari'
          : 'Browser';
  const system = /iPhone/u.test(userAgent)
    ? 'iPhone'
    : /iPad/u.test(userAgent)
      ? 'iPad'
      : /Android/u.test(userAgent)
        ? 'Android'
        : /Windows/u.test(userAgent)
          ? 'Windows'
          : /Mac OS X/u.test(userAgent)
            ? 'Mac'
            : /Linux/u.test(userAgent)
              ? 'Linux'
              : '';
  return system ? `${browser} on ${system}` : browser;
}

/** What only this browser can do. Apple's and Google's own sheets are not built in yet. */
const platform: AuthPlatform = {
  deviceLabel: browserLabel(typeof navigator === 'undefined' ? '' : navigator.userAgent),
  async credential(provider) {
    throw new Error(`${provider} sign-in is not available here yet.`);
  },
};

/** Which of Apple's and Google's sheets this page can show. */
const nativeWays = { apple: false, google: false };

/**
 * How a person signs in: an emailed code (and, for a new person, the invite code once), or an invite
 * token made by hand. `open` receives a session token and must either open the workspace or throw, so
 * a session that cannot be opened is ended instead of being left behind. `openInvite` is the old box.
 */
export function SignIn({
  open,
  openInvite,
  busy,
  notice,
}: {
  open: (token: string) => Promise<void>;
  openInvite: (token: string) => Promise<void>;
  busy: boolean;
  notice: string;
}) {
  const [tokenMode, setTokenMode] = useState(false);
  return (
    <div className="signin">
      {tokenMode ? (
        <InviteToken
          onSubmit={openInvite}
          busy={busy}
          notice={notice}
          onBack={() => setTokenMode(false)}
        />
      ) : (
        <Ways open={open} notice={notice} onToken={() => setTokenMode(true)} />
      )}
    </div>
  );
}

function InviteToken({
  onSubmit,
  busy,
  notice,
  onBack,
}: {
  onSubmit: (token: string) => Promise<void>;
  busy: boolean;
  notice: string;
  onBack: () => void;
}) {
  const [token, setToken] = useState('');
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit(token);
        }}
      >
        <label htmlFor="invite">Invite token</label>
        <input
          id="invite"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
        />
        <Button
          label={busy ? 'Connecting…' : 'Enter your workspace'}
          type="submit"
          variant="primary"
          isDisabled={busy}
        />
      </form>
      {notice && (
        <p role="alert" className="error">
          {notice}
        </p>
      )}
      <button type="button" className="signin-link" onClick={onBack}>
        Other ways to sign in
      </button>
    </>
  );
}

function Ways({
  open,
  notice,
  onToken,
}: {
  open: (token: string) => Promise<void>;
  notice: string;
  onToken: () => void;
}) {
  // One flow per mount; the latest `open` is read when it finishes.
  const latest = useRef(open);
  latest.current = open;
  const flow = useMemo(
    () => new AuthFlow({ platform, onSignedIn: (token) => latest.current(token) }),
    [],
  );
  useEffect(() => {
    void flow.start();
    // A flow the person has left must not sign this page in later.
    return () => flow.close();
  }, [flow]);
  const state = useSyncExternalStore(flow.subscribe, flow.getSnapshot);
  return <Step state={state} flow={flow} notice={notice} onToken={onToken} />;
}

function Step({
  state,
  flow,
  notice,
  onToken,
}: {
  state: AuthState;
  flow: AuthFlow;
  notice: string;
  onToken: () => void;
}) {
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState('');
  const error = (text: string) =>
    text ? (
      <p role="alert" className="error">
        {text}
      </p>
    ) : null;
  switch (state.step) {
    case 'loading':
      return <p className="muted">Connecting…</p>;
    case 'working':
      return <p className="muted">One moment…</p>;
    case 'signedIn':
      return <p className="muted">Signed in.</p>;
    case 'failed':
      return (
        <>
          {error(state.message)}
          <Button label="Try again" variant="primary" onClick={() => void flow.start()} />
          <button type="button" className="signin-link" onClick={onToken}>
            I have an invite token
          </button>
        </>
      );
    case 'emailSent':
      return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void flow.verifyEmail(code);
          }}
        >
          <h2 className="signin-heading">Check your email</h2>
          <p className="muted">
            We sent a 6-digit code to {state.address}. It works once, for ten minutes.
          </p>
          <label htmlFor="signin-code">Code</label>
          <input
            id="signin-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoCapitalize="none"
            maxLength={12}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            // The person has just been asked for it.
            autoFocus
            required
          />
          {error(state.error)}
          <Button label="Sign in" type="submit" variant="primary" isDisabled={!code.trim()} />
          <button
            type="button"
            className="signin-link"
            onClick={() => void flow.sendEmail(state.address)}
          >
            Send a new code
          </button>
          <button
            type="button"
            className="signin-link"
            onClick={() => {
              setCode('');
              flow.back();
            }}
          >
            Use another way
          </button>
        </form>
      );
    case 'needsInvite':
      return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void flow.claim(invite);
          }}
        >
          <h2 className="signin-heading">Enter your invite code</h2>
          <p className="muted">Maka is by invitation for now. You only need to do this once.</p>
          <label htmlFor="signin-invite">Invite code</label>
          <input
            id="signin-invite"
            type="password"
            autoComplete="off"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            autoFocus
            required
          />
          {error(state.error)}
          <Button label="Continue" type="submit" variant="primary" isDisabled={!invite.trim()} />
          <button
            type="button"
            className="signin-link"
            onClick={() => {
              setInvite('');
              flow.back();
            }}
          >
            Use another way
          </button>
        </form>
      );
    default: {
      const apple = state.ways.apple && nativeWays.apple;
      const google = state.ways.google && nativeWays.google;
      return (
        <>
          {apple && (
            <Button
              label="Continue with Apple"
              variant="primary"
              onClick={() => void flow.signInWith('apple')}
            />
          )}
          {google && (
            <Button
              label="Continue with Google"
              variant="secondary"
              onClick={() => void flow.signInWith('google')}
            />
          )}
          {state.ways.email ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void flow.sendEmail(address);
              }}
            >
              <label htmlFor="signin-email">Email</label>
              <input
                id="signin-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                placeholder="you@example.com"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                required
              />
              <Button
                label="Email me a code"
                type="submit"
                variant={apple || google ? 'secondary' : 'primary'}
                isDisabled={!address.trim()}
              />
            </form>
          ) : null}
          {!apple && !google && !state.ways.email ? (
            <p className="muted">This server has no sign-in set up yet. Use your invite token.</p>
          ) : null}
          {error(state.error || notice)}
          <button type="button" className="signin-link" onClick={onToken}>
            I have an invite token
          </button>
        </>
      );
    }
  }
}
