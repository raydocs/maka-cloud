import type { CloudClient, DeliveryModel, InboxItem, TaskView } from '@maka-cloud/client';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Text } from 'react-native';
import Chat from '@/app/(tabs)/chat';
import Home from '@/app/(tabs)/index';
import Settings from '@/app/(tabs)/settings';
import SignIn from '@/app/sign-in';
import { DecisionCard } from '@/components/Decision';
import { DeliveryCard } from '@/components/Delivery';
import { InboxStatus } from '@/components/InboxStatus';
import { TaskRow } from '@/components/TaskRow';
import { LanguageProvider } from '@/lib/i18n';
import { SessionProvider, useSession } from '@/lib/session';

// The tab screens run outside a navigator here.
jest.mock('expo-router', () => ({
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

test('Home in Chinese: the start sentence, its field and its ideas', async () => {
  await signedIn(<Home />);
  expect(await screen.findByText('给下一个想法留个位置。')).toBeTruthy();
  expect(screen.getByLabelText('想完成什么？')).toBeTruthy();
  expect(screen.getByText('不知道从哪开始？')).toBeTruthy();
  // The device tests still find the field by its fixed name.
  expect(screen.getByTestId('field-What would you like to get done?')).toBeTruthy();
});

test('Chat in Chinese, with no conversation open', async () => {
  await signedIn(<Chat />);
  expect(await screen.findByText('还没有打开的对话')).toBeTruthy();
  expect(screen.getByText('去首页开始一个吧。')).toBeTruthy();
});

test('Settings in Chinese', async () => {
  await signedIn(<Settings />);
  expect(await screen.findByText('外观')).toBeTruthy();
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
