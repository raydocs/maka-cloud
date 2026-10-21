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
  useState,
} from 'react';
import { readSecure, removeSecure, writeSecure } from './secure';
import { normalizeServer } from './server';

const SERVER_KEY = 'maka.server';
const TOKEN_KEY = 'maka.token';

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

  const connect = useCallback(async (server: string, token: string) => {
    const workspace = await openWorkspace(token, {
      baseUrl: server,
      fetcher,
      onRevoked: () => {
        // The invite is gone: leave the workspace and keep nothing of it.
        void removeSecure(TOKEN_KEY);
        setSession({
          status: 'out',
          server,
          error: 'Your invite is no longer valid. Please sign in again.',
        });
      },
    });
    setSession({
      status: 'in',
      server,
      client: workspace.client,
      conversations: workspace.conversations,
      chosen: workspace.chosen,
      landing: workspace.landing,
    });
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      const server = (await readSecure(SERVER_KEY)) ?? '';
      const token = await readSecure(TOKEN_KEY);
      if (!current) return;
      if (!server || !token) return setSession({ status: 'out', server, error: '' });
      try {
        await connect(server, token);
      } catch (e) {
        // A refused invite is forgotten; any other failure keeps it for the next try.
        if (e instanceof ApiError && e.status === 401) await removeSecure(TOKEN_KEY);
        if (current) setSession({ status: 'out', server, error: errorText(e) });
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
        await connect(server, token.trim());
        await writeSecure(SERVER_KEY, server);
        await writeSecure(TOKEN_KEY, token.trim());
      },
      async signOut() {
        await removeSecure(TOKEN_KEY);
        setSession((previous) => ({
          status: 'out',
          server: previous.status === 'loading' ? '' : previous.server,
          error: '',
        }));
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
    [session, connect],
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
