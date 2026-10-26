import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import Chat from '@/app/(tabs)/chat';
import { SessionProvider, useSession } from '@/lib/session';
import { LIGHT, ThemeContext } from '@/lib/theme';

/**
 * Chat against a scripted server, for the tests that send to running tasks and read the dock.
 * The test file mocks `expo-router` and `@/lib/live` as tests/chat.test.tsx does.
 */

const fetchMock = () => (globalThis as unknown as { __fetch: jest.Mock }).__fetch;

let frameId = 0;
export const frame = (kind: string, data: Record<string, unknown>) =>
  `id: ${++frameId}\nevent: ${kind}\ndata: ${JSON.stringify({ conversationId: 'c1', ...data })}\n\n`;
export const taskEvent = (at: number, event: Record<string, unknown>, taskId = 't1') =>
  frame('task.event', { seq: frameId + 1, at, event: { taskId, ...event } });

/** Sends more frames down the latest open stream of conversation c1. */
export let push: (frames: string) => void = () => {};

function stream(frames: string[], close: boolean): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (more: string) => controller.enqueue(new TextEncoder().encode(more));
      push = send;
      send(`: open\n\n${frames.join('')}`);
      if (close) controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** The person asked for a fix; a task started for it and is running. */
export const running = (title = 'Fix the login loop') => [
  frame('message.posted', { messageId: 'm1', role: 'user', text: title, at: 1000 }),
  taskEvent(1001, { type: 'task_created', sessionId: 's', title, mode: 'async' }),
  taskEvent(1002, { type: 'task_started' }),
];

export interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** Answers a request the default server does not; undefined leaves it to the default. */
export type Route = (call: Call) => Promise<Response> | Response | undefined;

/**
 * Signs in and opens conversation c1. Every request is recorded in `calls`. With `drop`, c1's
 * stream ends after its frames and is never reached again, so the chat is reconnecting.
 */
export async function openChat(
  frames: string[],
  route: Route = () => undefined,
  options: { drop?: boolean } = {},
) {
  const calls: Call[] = [];
  let opened = 0;
  fetchMock().mockImplementation(async (url: string, init: RequestInit = {}) => {
    const at = new URL(url);
    const call: Call = {
      method: init.method ?? 'GET',
      path: at.pathname,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const answer = await route(call);
    if (answer) return answer;
    if (at.pathname === '/v1/conversations')
      return Response.json({
        conversations: [
          { conversationId: 'c1', title: 'Login', createdAt: 1 },
          { conversationId: 'c2', title: 'Docs', createdAt: 2 },
        ],
      });
    if (at.pathname === '/v1/events') {
      if (at.searchParams.get('conversation') !== 'c1') return stream([], false);
      opened += 1;
      if (options.drop && opened > 1) return new Promise<Response>(() => {});
      return stream(frames, options.drop === true);
    }
    if (at.pathname.endsWith('/tasks')) return Response.json({ tasks: [] });
    // A message to the conversation is taken (a failed one would be kept for the next test).
    if (call.method === 'POST' && at.pathname === '/v1/conversations/c1/messages')
      return Response.json({});
    return new Response('{}', { status: 404 });
  });
  let api: ReturnType<typeof useSession> | undefined;
  function Gate() {
    api = useSession();
    return api.session.status === 'in' ? <Chat /> : <Text>out</Text>;
  }
  await render(
    <ThemeContext.Provider value={LIGHT}>
      <SessionProvider>
        <Gate />
      </SessionProvider>
    </ThemeContext.Provider>,
  );
  await screen.findByText('out');
  await act(async () => {
    await api?.signIn('maka.example.com', 'invite-token');
  });
  const open = (conversationId: string) =>
    act(async () => {
      if (api?.session.status === 'in') api.open(conversationId);
    });
  await open('c1');
  return { calls, open, chosen: () => (api?.session.status === 'in' ? api.session.chosen : '') };
}
