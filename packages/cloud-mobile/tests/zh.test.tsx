import type { CloudClient, DeliveryModel, InboxItem, TaskView } from '@maka-cloud/client';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text } from 'react-native';
import Chat from '@/app/(tabs)/chat';
import Home from '@/app/(tabs)/index';
import Me from '@/app/me';
import SignIn from '@/app/sign-in';
import { DecisionCard } from '@/components/Decision';
import { DeliveryCard } from '@/components/Delivery';
import { InboxStatus } from '@/components/InboxStatus';
import { TaskRow } from '@/components/TaskRow';
import { LanguageProvider } from '@/lib/i18n';
import { SessionProvider, useSession } from '@/lib/session';

// The tab screens run outside a navigator here.
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ navigate: () => {} }),
  useFocusEffect: () => {},
}));

const fetchMock = () => (globalThis as unknown as { __fetch: jest.Mock }).__fetch;

const zh = (node: ReactElement) => <LanguageProvider language="zh-Hans">{node}</LanguageProvider>;

let api: ReturnType<typeof useSession>;
function Probe() {
  api = useSession();
  return <Text>{api.session.status}</Text>;
}

/** Signed in to a server that has no conversations and answers nothing else. */
async function signedIn(screenNode: ReactElement) {
  fetchMock().mockImplementation(async (url: string) =>
    new URL(url).pathname === '/v1/conversations'
      ? Response.json({ conversations: [] })
      : new Response('{}', { status: 404 }),
  );
  function Gate() {
    const { session } = useSession();
    return session.status === 'in' ? screenNode : null;
  }
  await render(
    zh(
      <SessionProvider>
        <Probe />
        <Gate />
      </SessionProvider>,
    ),
  );
  await screen.findByText('out');
  await act(async () => {
    await api.signIn('maka.example.com', 'invite-token');
  });
}

test("Home in Chinese: the greeting, a first visit's line, its field and its ideas", async () => {
  await signedIn(<Home />);
  expect(
    await screen.findByText('需要你的、正在做的和已经做完的事，都会出现在这里。'),
  ).toBeTruthy();
  expect(['早上好。', '下午好。', '晚上好。']).toContain(
    screen.getByTestId('home-today-title').props.children,
  );
  expect(screen.getByLabelText('想完成什么？')).toBeTruthy();
  expect(screen.getByText('不知道从哪开始？')).toBeTruthy();
  // The device tests still find the field by its fixed name.
  expect(screen.getByTestId('field-What would you like to get done?')).toBeTruthy();
});

test('an empty Chat can be talked to: an opening line, three ideas and the composer start one', async () => {
  await signedIn(<Chat />);
  const posted: Array<{ method: string; path: string; body: unknown }> = [];
  fetchMock().mockImplementation(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    posted.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'POST' && path === '/v1/conversations')
      return Response.json({ conversationId: 'c-new' });
    if (method === 'POST' && path === '/v1/conversations/c-new/messages')
      return Response.json({ messageId: 'm1' });
    if (path === '/v1/conversations') return Response.json({ conversations: [] });
    return new Response('{}', { status: 404 });
  });
  expect(await screen.findByText('想完成什么？')).toBeTruthy();
  // No card sending the person away to Home.
  expect(screen.queryByText(/去首页/u)).toBeNull();
  const ideas = ['home.idea.1', 'home.idea.2', 'home.idea.3'].map((id) =>
    screen.getByTestId(`button-${id}`),
  );
  expect(ideas).toHaveLength(3);
  const field = screen.getByTestId('field-Keep the conversation going');
  expect(field.props.value).toBe('');
  expect(screen.getByTestId('button-Send message').props.accessibilityState).toMatchObject({
    disabled: true,
  });
  await fireEvent.press(ideas[0] as never);
  const idea = String(screen.getByTestId('field-Keep the conversation going').props.value);
  expect(idea.length).toBeGreaterThan(0);
  await act(async () => {
    fireEvent.press(screen.getByTestId('button-Send message'));
  });
  const message = posted.find(
    (call) => call.method === 'POST' && call.path === '/v1/conversations/c-new/messages',
  );
  expect(message?.body).toMatchObject({ text: idea });
  // The new conversation is open: the ideas give way to it.
  expect(api.session.status === 'in' && api.session.chosen).toBe('c-new');
});

test('Me in Chinese: its title, appearance, language and account', async () => {
  await signedIn(<Me />);
  expect(await screen.findByText('外观')).toBeTruthy();
  expect(screen.getByText('我的')).toBeTruthy();
  expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '深色' })).toBeTruthy();
  // The language picker names each language in its own words.
  expect(screen.getByRole('button', { name: '语言：跟随系统' })).toBeTruthy();
  for (const name of ['简体中文', '繁體中文', 'English'])
    expect(screen.getByRole('button', { name })).toBeTruthy();
  expect(screen.getByText('语言')).toBeTruthy();
});

test('sign-in in Chinese', async () => {
  fetchMock().mockImplementation(async () => new Response('{}', { status: 404 }));
  await render(
    zh(
      <SessionProvider>
        <SignIn />
      </SessionProvider>,
    ),
  );
  expect(await screen.findByText('服务器地址')).toBeTruthy();
  expect(screen.getByRole('button', { name: '继续' })).toBeTruthy();
  expect(screen.getByTestId('button-Continue')).toBeTruthy();
});

test('the decision states and cards in Chinese; what the server sent stays as sent', async () => {
  const item: InboxItem = {
    itemId: 'i1',
    kind: 'approval',
    conversationId: 'c1',
    taskId: 't1',
    ask: 'Run "git push" on the repo?',
    options: [{ id: 'approve', label: 'Approve', recommended: true }],
    allowText: true,
    evidence: [{ kind: 'action', tool: 'Bash', args: '{}' }],
    state: 'open',
    closeReason: null,
    preconditionHash: 'h',
    version: 1,
    interrupts: false,
    delivery: 'none',
    createdAt: 1,
    updatedAt: 1,
  };
  await render(
    zh(
      <>
        <InboxStatus loaded failed={false} onRetry={() => {}} />
        <DecisionCard item={item} disabled={false} onAnswer={() => {}} />
      </>,
    ),
  );
  expect(screen.getByText(/没有需要你处理的事/u)).toBeTruthy();
  expect(screen.getByText('需要你批准')).toBeTruthy();
  expect(screen.getByText('等你回复后才会执行：Bash')).toBeTruthy();
  expect(screen.getByRole('button', { name: '添加备注' })).toBeTruthy();
  expect(screen.getByText('Run "git push" on the repo?')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
});

test('a task and its result card in Chinese', async () => {
  const task: TaskView = {
    taskId: 't1',
    title: 'Tag the release',
    state: 'running',
    createdAt: 1,
    progress: ['step: Checking tags'],
    cancelRequested: false,
    pauseRequested: false,
  };
  const model: DeliveryModel = {
    // A task's own summary can be a word the app also uses; it still stays as the task wrote it.
    outcome: 'Finished.',
    caption: 'The changes',
    actions: [
      { label: 'Open pull request', url: 'https://github.com/o/r/pull/1', host: 'github.com' },
    ],
  };
  await render(
    zh(
      <>
        <TaskRow task={task} tasks={[]} noPause={new Set()} busy={false} onControl={() => {}} />
        <DeliveryCard
          client={{} as CloudClient}
          task={{ ...task, state: 'succeeded' }}
          model={model}
        />
      </>,
    ),
  );
  expect(screen.getByText('当前步骤')).toBeTruthy();
  expect(screen.getByRole('button', { name: '暂停任务' })).toBeTruthy();
  expect(screen.getByText('已完成')).toBeTruthy();
  expect(screen.getByText('Finished.')).toBeTruthy();
  expect(screen.getByRole('button', { name: '打开拉取请求 · github.com' })).toBeTruthy();
  expect(screen.getByTestId('button-Open pull request · github.com')).toBeTruthy();
});

test('a decision card’s fixed server choices are in Chinese; any other choice stays as sent', async () => {
  const answers: string[] = [];
  const item: InboxItem = {
    itemId: 'i2',
    kind: 'finished',
    conversationId: 'c1',
    taskId: 't1',
    ask: 'Weekly report is ready.',
    options: [
      { id: 'ok', label: 'Got it', recommended: true },
      { id: 'later', label: 'Not now', recommended: false },
      { id: 'later2', label: 'Later, after lunch', recommended: false },
    ],
    allowText: false,
    evidence: [],
    state: 'open',
    closeReason: null,
    preconditionHash: 'h',
    version: 1,
    interrupts: false,
    delivery: 'none',
    createdAt: 1,
    updatedAt: 1,
  };
  await render(
    zh(<DecisionCard item={item} disabled={false} onAnswer={(id) => answers.push(id)} />),
  );
  expect(screen.getByRole('button', { name: '知道了' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '以后再说' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Later, after lunch' })).toBeTruthy();
  expect(screen.queryByText('Got it')).toBeNull();
  // The device tests still find the button by the server's label.
  await fireEvent.press(screen.getByTestId('button-Got it'));
  expect(answers).toEqual(['ok']);
});
