import {
  type CloudClient,
  type Conversation,
  openWorkspace,
  type VisitStore,
  errorText,
  ApiError,
} from '@maka-cloud/client';
import { fetch as streamingFetch } from 'expo/fetch';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { readSecure, removeSecure, writeSecure } from './secure';
import { normalizeServer } from './server';

/** The server and its token are one record, so a token can never be read back with another server. */
const ACCOUNT_KEY = 'maka.account';
/** Only a hint for the next sign-in screen; it holds no secret and outlives a sign-out. */
const SERVER_KEY = 'maka.server';

interface Account {
  server: string;
  token: string;
}

async function readAccount(): Promise<Account | undefined> {
  const raw = await readSecure(ACCOUNT_KEY);
  if (!raw) return undefined;
  try {
    const account = JSON.parse(raw) as Partial<Account>;
    return typeof account.server === 'string' && typeof account.token === 'string'
      ? { server: account.server, token: account.token }
      : undefined;
  } catch {
    return undefined;
  }
}

export type Session =
  | { status: 'loading' }
  | { status: 'out'; server: string; error: string }
  | {
      status: 'in';
      server: string;
      client: CloudClient;
      conversations: Conversation[];
      /** The conversation Chat shows. */
      chosen: string;
      /** Where to land right after signing in: the latest conversation, or Home on a first visit. */
      landing: 'home' | 'chat';
    };

interface SessionApi {
  session: Session;
  signIn(server: string, token: string): Promise<void>;
  signOut(): Promise<void>;
  /** A conversation was started: it is listed and opened. */
  started(conversation: Conversation): void;
  open(conversationId: string): void;
  visits: VisitStore;
}

const Context = createContext<SessionApi | undefined>(undefined);

/** Streaming responses (the event feed) need Expo's fetch; React Native's own cannot stream. */
const fetcher = streamingFetch as unknown as typeof fetch;

/** Remembered per invite fingerprint (never the token), in the secure store. */
const visits: VisitStore = {
  async read(fingerprint) {
    const stored = Number(await readSecure(`maka.visit.${fingerprint}`));
    return Number.isFinite(stored) && stored > 0 ? stored : undefined;
  },
  async write(fingerprint, at) {
    await writeSecure(`maka.visit.${fingerprint}`, String(at)).catch(() => {});
  },
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ status: 'loading' });
  /** Bumped by every sign-in, sign-out and revocation; an older operation never publishes or undoes a newer one. */
  const generation = useRef(0);
  /** Sign-in and sign-out run one after another, so a late write can never undo a sign-out. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const serialise = useCallback(<T,>(run: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(run, run);
    queue.current = next.catch(() => {});
    return next;
  }, []);

  /** Opens the workspace without publishing it: the caller saves the account first. */
  const connect = useCallback(async (server: string, token: string, mine: number) => {
    const workspace = await openWorkspace(token, {
      baseUrl: server,
      fetcher,
      onRevoked: () => {
        // The invite is gone: leave the workspace and keep nothing of it. A client of an older
        // session says nothing about the current one.
        if (generation.current !== mine) return;
        generation.current += 1;
        void removeSecure(ACCOUNT_KEY).catch(() => {});
        setSession({
          status: 'out',
          server,
          error: 'Your invite is no longer valid. Please sign in again.',
        });
      },
    });
    return {
      status: 'in',
      server,
      client: workspace.client,
      conversations: workspace.conversations,
      chosen: workspace.chosen,
      landing: workspace.landing,
    } satisfies Session;
  }, []);

  useEffect(() => {
    let current = true;
    const mine = ++generation.current;
    void (async () => {
      const account = await readAccount();
      const hint = account?.server ?? (await readSecure(SERVER_KEY)) ?? '';
      if (!current || generation.current !== mine) return;
      if (!account) return setSession({ status: 'out', server: hint, error: '' });
      try {
        const next = await connect(account.server, account.token, mine);
        if (current && generation.current === mine) setSession(next);
      } catch (e) {
        // A refused invite is forgotten; any other failure keeps it for the next try.
        if (e instanceof ApiError && e.status === 401)
          await removeSecure(ACCOUNT_KEY).catch(() => {});
        if (current && generation.current === mine)
          setSession({ status: 'out', server: account.server, error: errorText(e) });
      }
    })();
    return () => {
      current = false;
    };
  }, [connect]);

  const api = useMemo<SessionApi>(
    () => ({
      session,
      async signIn(address, token) {
        const server = normalizeServer(address);
        const secret = token.trim();
        const mine = ++generation.current;
        await serialise(async () => {
          const next = await connect(server, secret, mine);
          if (generation.current !== mine) return;
          // The session is published only once it is saved, so a failed save is a failed sign-in.
          await writeSecure(ACCOUNT_KEY, JSON.stringify({ server, token: secret }));
          await writeSecure(SERVER_KEY, server).catch(() => {});
          if (generation.current === mine) setSession(next);
        });
      },
      async signOut() {
        generation.current += 1;
        await serialise(async () => {
          // Access is reported removed only once the secret is gone; a failure is thrown to the caller.
          await removeSecure(ACCOUNT_KEY);
          setSession((previous) => ({
            status: 'out',
            server: previous.status === 'loading' ? '' : previous.server,
            error: '',
          }));
        });
      },
      started(conversation) {
        setSession((previous) =>
          previous.status === 'in'
            ? {
                ...previous,
                conversations: [...previous.conversations, conversation],
                chosen: conversation.conversationId,
              }
            : previous,
        );
      },
      open(conversationId) {
        setSession((previous) =>
          previous.status === 'in' ? { ...previous, chosen: conversationId } : previous,
        );
      },
      visits,
    }),
    [session, connect, serialise],
  );
  return <Context.Provider value={api}>{children}</Context.Provider>;
}

export function useSession(): SessionApi {
  const api = useContext(Context);
  if (!api) throw new Error('useSession needs a SessionProvider.');
  return api;
}

/** The signed-in session; the screens that need one are only shown when there is one. */
export function useWorkspace() {
  const { session, ...rest } = useSession();
  if (session.status !== 'in') throw new Error('Not signed in.');
  return { ...session, ...rest };
}
