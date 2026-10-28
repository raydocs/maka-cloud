import type { InboxItem, TaskView } from '@maka-cloud/client';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { Animated, Text, View } from 'react-native';
import Home from '@/app/(tabs)/index';
import { DecisionCard } from '@/components/Decision';
import { Appear, Shimmer } from '@/components/ui';
import { ReduceMotion } from '@/lib/appearance';
import { PHRASES_ZH, ZH } from '@/lib/strings';
import { PHRASES_HANT, ZH_HANT } from '@/lib/strings.hant';
import { SessionProvider, useSession } from '@/lib/session';
import { DARK, ThemeContext } from '@/lib/theme';

// Home runs outside a navigator here.
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ navigate: () => {} }),
  useFocusEffect: () => {},
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  selectionAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Warning: 'warning' },
}));

const wrap = (node: React.ReactElement) => (
  <ThemeContext.Provider value={DARK}>{node}</ThemeContext.Provider>
);

const flat = (style: unknown) => Object.assign({}, ...[style].flat(Number.POSITIVE_INFINITY));

/** Home, signed in, with one conversation whose one task finished a minute ago. */
async function homeWithFinished(over: Partial<TaskView>) {
  const finished: TaskView = {
    taskId: 't1',
    title: 'Tag the release',
    state: 'succeeded',
    createdAt: 1,
    finishedAt: Date.now() - 60_000,
    progress: [],
    cancelRequested: false,
    pauseRequested: false,
    manifest: { summary: 'Tagged v1.2.0.' } as TaskView['manifest'],
    ...over,
  };
  (globalThis as unknown as { __fetch: jest.Mock }).__fetch.mockImplementation(
    async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/conversations')
        return Response.json({
          conversations: [{ conversationId: 'c1', title: 'Release', createdAt: 1 }],
        });
      if (path === '/v1/conversations/c1/tasks') return Response.json({ tasks: [finished] });
      return new Response('{}', { status: 404 });
    },
  );
  let api: ReturnType<typeof useSession> | undefined;
  function Gate() {
    api = useSession();
    return api.session.status === 'in' ? <Home /> : null;
  }
  await render(
    <SessionProvider>
      <Gate />
    </SessionProvider>,
  );
  await act(async () => {
    await api?.signIn('maka.example.com', 'invite-token');
  });
  await screen.findByText('Since you were last here');
}

test('Home shows no spend tile, dash or "not reported" line when no spend was reported', async () => {
  await homeWithFinished({});
  expect(screen.getByText('Tag the release')).toBeTruthy();
  expect(screen.getByText('Tagged v1.2.0.')).toBeTruthy();
  expect(screen.queryByText('Spent')).toBeNull();
  expect(screen.queryByLabelText(/^Cost/u)).toBeNull();
  expect(screen.queryByText('—')).toBeNull();
  expect(screen.queryByText(/not reported/iu)).toBeNull();
});

test('Home shows the spend once the server reports one', async () => {
  await homeWithFinished({ costUsd: 0.5 });
  expect(screen.getByLabelText('Cost: $0.50')).toBeTruthy();
});

/** The typesetting slips a Chinese line can have, each with the text around it. */
function slips(text: string): string[] {
  const found: string[] = [];
  // Half-width punctuation straight after a Chinese character: Chinese takes ？！：，；.
  for (const m of text.matchAll(/\p{Script=Han}[?!:,;]/gu)) found.push(`half-width "${m[0]}"`);
  // Latin letters or digits run straight into Chinese: a space goes between them.
  // (A lookahead, so "共3个" counts both of its joins.)
  for (const m of text.matchAll(/(?=(\p{Script=Han}[A-Za-z0-9]|[A-Za-z0-9]\p{Script=Han}))/gu))
    found.push(`no space "${m[1]}"`);
  return found;
}

test('the typesetting check itself catches each slip and passes good Chinese', () => {
  expect(slips('完成了?')).toHaveLength(1);
  expect(slips('注意:这里')).toHaveLength(1);
  expect(slips('好的,继续')).toHaveLength(1);
  expect(slips('打开GitHub')).toHaveLength(1);
  expect(slips('共3个')).toHaveLength(2);
  expect(slips('完成了？注意：打开 GitHub，共 3 个。')).toEqual([]);
});

test.each([
  ['zh-Hans catalogue', ZH],
  ['zh-Hans phrases', PHRASES_ZH],
  ['zh-Hant catalogue', ZH_HANT],
  ['zh-Hant phrases', PHRASES_HANT],
])('the %s uses full-width punctuation and spaces Latin words', (_, table) => {
  const problems = Object.entries(table as Record<string, string>).flatMap(([key, value]) =>
    slips(value).map((slip) => `${key}: ${slip}`),
  );
  expect(problems).toEqual([]);
});

const approval: InboxItem = {
  itemId: 'i1',
  kind: 'approval',
  conversationId: 'c1',
  taskId: 't1',
  ask: 'Run "git push" on the repo?',
  options: [
    { id: 'deny', label: 'Deny', recommended: false },
    { id: 'approve', label: 'Approve', recommended: true },
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

test('the answers sit side by side, each as wide as its words; refusing buzzes a warning, approving taps lightly', async () => {
  const impact = jest.mocked(Haptics.impactAsync);
  const warn = jest.mocked(Haptics.notificationAsync);
  impact.mockClear();
  warn.mockClear();
  await render(wrap(<DecisionCard item={approval} disabled={false} onAnswer={() => {}} />));
  for (const name of ['Approve', 'Deny'])
    expect(flat(screen.getByRole('button', { name }).props.style).alignSelf).toBe('flex-start');
  await fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
  expect(impact).toHaveBeenCalledWith('light');
  expect(warn).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Deny' }));
  expect(warn).toHaveBeenCalledWith('warning');
});

test('choosing how far an approval reaches ticks like a selection; the one "Go ahead" still taps lightly', async () => {
  const impact = jest.mocked(Haptics.impactAsync);
  const tick = jest.mocked(Haptics.selectionAsync);
  impact.mockClear();
  tick.mockClear();
  const scoped: InboxItem = {
    ...approval,
    ask: 'Allow open_pull_request(taskId: t1, title: "Fix it")? It cannot be undone.',
    options: [
      { id: 'approve', label: 'Go ahead, just this once', recommended: true },
      {
        id: 'approve_task',
        label: "Go ahead, and don't ask again for this repository in this task",
        recommended: false,
      },
      { id: 'reject', label: "Don't do it", recommended: false },
    ],
  };
  const answers: string[] = [];
  await render(
    wrap(<DecisionCard item={scoped} disabled={false} onAnswer={(id) => answers.push(id)} />),
  );
  await fireEvent.press(screen.getByRole('radio', { name: 'This task' }));
  expect(tick).toHaveBeenCalledTimes(1);
  // Choosing the scope already chosen does nothing.
  await fireEvent.press(screen.getByRole('radio', { name: 'This task' }));
  expect(tick).toHaveBeenCalledTimes(1);
  const go = screen.getByRole('button', {
    name: "Go ahead, and don't ask again for this repository in this task",
  });
  expect(flat(go.props.style).alignSelf).toBe('flex-start');
  await fireEvent.press(go);
  expect(impact).toHaveBeenCalledWith('light');
  expect(answers).toEqual(['approve_task']);
});

// Every opacity below 1 on a node or anything around it.
type Node = { props: { style?: unknown }; parent: Node | null } | null;
const fadedAbove = (node: Node) => {
  const faded: number[] = [];
  for (let at = node; at; at = at.parent) {
    const opacity = flat(at.props.style).opacity;
    if (typeof opacity === 'number' && opacity < 1) faded.push(opacity);
  }
  return faded;
};

const moving = (reduce: boolean, node: React.ReactElement) =>
  render(
    <ReduceMotion.Provider value={reduce}>
      <View testID="around">{node}</View>
    </ReduceMotion.Provider>,
  );

test('something new rises into place on a spring', async () => {
  await moving(
    false,
    <Appear enter>
      <Text testID="new">New</Text>
    </Appear>,
  );
  const springing = flat(screen.getByTestId('new').parent?.props.style);
  expect(springing.opacity).toBe(0);
  expect(springing.transform).toEqual([{ translateY: 10 }]);
});

test('under Reduce Motion something new just appears', async () => {
  await moving(
    true,
    <Appear enter>
      <Text testID="new">New</Text>
    </Appear>,
  );
  expect(screen.getByTestId('new').parent?.props.testID).toBe('around');
});

test('what was already there when the screen opened does not move', async () => {
  await moving(
    false,
    <Appear enter={false}>
      <Text testID="old">Old</Text>
    </Appear>,
  );
  expect(screen.getByTestId('old').parent?.props.testID).toBe('around');
});

// The test renderer does not run native-driven animations, so these check that the breathing loop
// starts (and stops with the line), or never starts at all.
test('a working line breathes, and stops when it goes', async () => {
  const stop = jest.fn();
  const start = jest.fn();
  const loop = jest.spyOn(Animated, 'loop').mockReturnValue({ start, stop, reset: jest.fn() });
  try {
    await moving(
      false,
      <Shimmer>
        <Text testID="line">Working</Text>
      </Shimmer>,
    );
    expect(loop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalled();
    // The breathing is a decorative rule under the line; the words never fade, so they keep
    // their contrast.
    expect(
      screen.getByTestId('shimmer', { includeHiddenElements: true }).props
        .accessibilityElementsHidden,
    ).toBe(true);
    expect(fadedAbove(screen.getByTestId('line'))).toEqual([]);
    await screen.unmount();
    expect(stop).toHaveBeenCalled();
  } finally {
    loop.mockRestore();
  }
});

test('under Reduce Motion a working line holds still', async () => {
  const loop = jest.spyOn(Animated, 'loop');
  try {
    await moving(
      true,
      <Shimmer>
        <Text testID="line">Working</Text>
      </Shimmer>,
    );
    expect(loop).not.toHaveBeenCalled();
    expect(screen.queryByTestId('shimmer')).toBeNull();
    expect(fadedAbove(screen.getByTestId('line'))).toEqual([]);
  } finally {
    loop.mockRestore();
  }
});
