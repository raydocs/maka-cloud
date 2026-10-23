import { AuthFlow, type AuthPlatform } from '@maka-cloud/client';
import { fetch as streamingFetch } from 'expo/fetch';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

/**
 * The sign-in flow for one server. A new server is a new flow; the old one is dropped with whatever
 * it held. `onSignedIn` receives the session token and must keep it where secrets go.
 */
export function useAuthFlow(
  server: string,
  platform: AuthPlatform,
  onSignedIn: (token: string) => Promise<void>,
) {
  // The latest callback is read when the flow finishes, so a re-render does not make a new flow.
  const latest = useRef(onSignedIn);
  latest.current = onSignedIn;
  const flow = useMemo(
    () =>
      new AuthFlow({
        baseUrl: server,
        fetcher: streamingFetch as unknown as typeof fetch,
        platform,
        onSignedIn: (token) => latest.current(token),
      }),
    [server, platform],
  );
  useEffect(() => {
    void flow.start();
    // A flow the person has left (another server, another screen) must not sign the phone in later.
    return () => flow.close();
  }, [flow]);
  const state = useSyncExternalStore(flow.subscribe, flow.getSnapshot);
  return { flow, state };
}
