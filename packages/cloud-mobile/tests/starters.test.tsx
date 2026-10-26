import type { InboxItem, ProjectView, Question, TaskView } from '@maka-cloud/client';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Animated } from 'react-native';
import { DecisionCard, QuestionBlock } from '@/components/Decision';
import { WorkBlock } from '@/components/Work';
import { ReduceMotion } from '@/lib/appearance';
import { LanguageProvider, translator } from '@/lib/i18n';
import { startersFor } from '@/lib/ideas';
import { forgetSteers } from '@/lib/steer';
import { LIGHT, ThemeContext } from '@/lib/theme';
import { clockOf } from '@/lib/work';
import { openChat } from './harness';

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ navigate: () => {}, push: () => {}, dismissTo: () => {}, back: () => {} }),
    useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]),
  };
});
jest.mock('@/lib/live', () => ({
  keepLive: (feed: { start(): void; stop(): void }) => {
    feed.start();
    return () => feed.stop();
  },
}));

beforeEach(() => forgetSteers());

const shown = (node: ReactElement, reduce = false) =>
  render(
    <LanguageProvider language="en">
      <ReduceMotion.Provider value={reduce}>
        <ThemeContext.Provider value={LIGHT}>{node}</ThemeContext.Provider>
      </ReduceMotion.Provider>
    </LanguageProvider>,
  );

const project = (repo: string): ProjectView => ({
  projectId: repo,
  repo,
  defaultBranch: 'main',
  duties: [],
});

describe('starter ideas', () => {
  const { t: say } = translator('en');
  test('come from the person’s projects and latest conversation, never the one open now', () => {
    const ideas = startersFor(
      [project('acme/web'), project('acme/api')],
      [
        { conversationId: 'c1', title: 'Login', createdAt: 1 },
        { conversationId: 'c2', title: 'Docs', createdAt: 2 },
      ],
      'c2',
      say,
    );
    expect(ideas).toEqual([
      {
        id: 'idea-fix',
        label: 'Fix the failing tests in acme/web',
        fill: 'Fix the failing tests in acme/web',
      },
      {
        id: 'idea-review',
        label: 'Review the open pull requests in acme/api',
        fill: 'Review the open pull requests in acme/api',
      },
      { id: 'idea-continue', label: 'Pick up “Login”', open: 'c1' },
    ]);
  });
  test('fall back to the fixed ideas with no project and no named conversation', () => {
    for (const projects of [undefined, []])
      expect(
        startersFor(
          projects,
          [{ conversationId: 'c1', title: null, createdAt: 1 }],
          undefined,
          say,
        ).map((idea) => idea.id),
      ).toEqual(['home.idea.1', 'home.idea.2', 'home.idea.3']);
  });
});

test('an empty conversation offers ideas from the person’s projects; one fills the box, another opens a conversation', async () => {
  const { chosen } = await openChat([], (call) =>
    call.path === '/v1/projects' ? Response.json({ projects: [project('acme/web')] }) : undefined,
  );
  await fireEvent.press(await screen.findByTestId('button-idea-fix'));
  expect(screen.getByTestId('field-Keep the conversation going').props.value).toBe(
    'Fix the failing tests in acme/web',
  );
  // Nothing was sent.
  expect(screen.queryByTestId('outgoing')).toBeNull();
  await fireEvent.press(screen.getByTestId('button-idea-continue'));
  expect(chosen()).toBe('c2');
});

describe('approval receipts', () => {
  const question = (over: Partial<Question> = {}): Question => ({
    questionId: 'q1',
    reason: 'irreversible',
    question: 'Allow open_pull_request({"repo":"acme/web"})? Repository: acme/web',
    options: [
      { id: 'approve', label: 'Go ahead, just this once' },
      {
        id: 'approve_task',
        label: "Go ahead, and don't ask again for this repository in this task",
      },
      { id: 'approve_repository', label: "Go ahead, and don't ask again for this repository" },
      { id: 'reject', label: "Don't do it" },
    ],
    recommended: 'approve',
    action: { tool: 'open_pull_request', args: { repo: 'acme/web' } },
    ...over,
  });

  test('restate how far the approval reaches, and a kept one links to Me', async () => {
    const opened: string[] = [];
    await shown(
      <QuestionBlock
        question={question()}
        answered="approve_repository"
        disabled={false}
        onAnswer={() => {}}
        onOpenGrants={() => opened.push('me')}
      />,
    );
    expect(screen.getByTestId('receipt-scope')).toHaveTextContent(
      'Approved for this repository. It won’t ask again here until you revoke it.',
    );
    await fireEvent.press(screen.getByRole('link', { name: 'Revoke in Me' }));
    expect(opened).toEqual(['me']);
  });

  test('an approval for once keeps nothing, so there is nothing to revoke; a refusal has no scope', async () => {
    const view = await shown(
      <QuestionBlock
        question={question()}
        answered="approve"
        disabled={false}
        onAnswer={() => {}}
        onOpenGrants={() => {}}
      />,
    );
    expect(screen.getByTestId('receipt-scope')).toHaveTextContent(
      'Approved just this once. Nothing is kept.',
    );
    expect(screen.queryByRole('link', { name: 'Revoke in Me' })).toBeNull();
    await view.rerender(
      <LanguageProvider language="en">
        <ThemeContext.Provider value={LIGHT}>
          <QuestionBlock
            question={question()}
            answered="reject"
            disabled={false}
            onAnswer={() => {}}
          />
        </ThemeContext.Provider>
      </LanguageProvider>,
    );
    expect(screen.queryByTestId('receipt-scope')).toBeNull();
  });

  /** Answers "this task" on an open card, then draws it as the server now has it. */
  const answerThisTask = async (itemId: string, taken: boolean) => {
    const item = (state: InboxItem['state']): InboxItem => ({
      itemId,
      kind: 'approval',
      conversationId: 'c1',
      taskId: 't1',
      ask: 'Allow Bash({"command":"git push"})? Repository: acme/web',
      options: [
        { id: 'approve', label: 'Go ahead, just this once', recommended: true },
        {
          id: 'approve_task',
          label: "Go ahead, and don't ask again for this repository in this task",
          recommended: false,
        },
        { id: 'reject', label: "Don't do it", recommended: false },
      ],
      allowText: false,
      evidence: [{ kind: 'action', tool: 'Bash', args: '{"command":"git push"}' }],
      state,
      closeReason: null,
      preconditionHash: 'h',
      version: 1,
      interrupts: false,
      delivery: 'sending',
      createdAt: 1,
      updatedAt: 1,
    });
    const answers: string[] = [];
    const view = await shown(
      <DecisionCard
        item={item('open')}
        disabled={false}
        onAnswer={(id) => {
          answers.push(id);
          return Promise.resolve(taken);
        }}
      />,
    );
    await fireEvent.press(screen.getByTestId('scope-approve_task'));
    await fireEvent.press(
      screen.getByRole('button', { name: /don.t ask again for this repository in this task/u }),
    );
    expect(answers).toEqual(['approve_task']);
    // Drawn anew once the answer is on its way, as the chat does.
    await view.unmount();
    await shown(
      <DecisionCard
        item={item('answering')}
        disabled={false}
        onAnswer={() => {}}
        onOpenGrants={() => {}}
      />,
    );
  };

  test('a card answered "this task" says so once the server took the answer', async () => {
    await answerThisTask('i-taken', true);
    expect(screen.getByTestId('receipt-scope')).toHaveTextContent(
      'Approved for the rest of this task. It won’t ask again for this repository until the task ends.',
    );
    expect(screen.getByRole('link', { name: 'Revoke in Me' })).toBeTruthy();
  });

  test('an answer the server refused (answered elsewhere) states no reach', async () => {
    await answerThisTask('i-refused', false);
    expect(screen.getByTestId('decision-receipt')).toBeTruthy();
    expect(screen.queryByTestId('receipt-scope')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Revoke in Me' })).toBeNull();
  });
});

describe('the working clock', () => {
  const running = (startedAt: number): TaskView => ({
    taskId: 't1',
    title: 'Fix the login loop',
    state: 'running',
    createdAt: startedAt,
    startedAt,
    progress: [],
    cancelRequested: false,
    pauseRequested: false,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
  });
  afterEach(() => jest.useRealTimers());

  test('reads m:ss, and h:mm:ss past an hour', () => {
    expect(clockOf(7_000)).toBe('0:07');
    expect(clockOf(750_000)).toBe('12:30');
    expect(clockOf(3_723_000)).toBe('1:02:03');
  });

  test('ticks each second while the work runs', async () => {
    await shown(<WorkBlock tasks={[running(1_000_000 - 65_000)]} working />);
    expect(screen.getByTestId('work-clock')).toHaveTextContent('Working for 1:05');
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId('work-clock')).toHaveTextContent('Working for 1:06');
  });

  test('under Reduce Motion it still ticks, and nothing about it moves', async () => {
    const loop = jest.spyOn(Animated, 'loop');
    const timing = jest.spyOn(Animated, 'timing');
    try {
      await shown(<WorkBlock tasks={[running(1_000_000 - 5_000)]} working />, true);
      await act(async () => {
        jest.advanceTimersByTime(2_000);
      });
      expect(screen.getByTestId('work-clock')).toHaveTextContent('Working for 0:07');
      expect(loop).not.toHaveBeenCalled();
      expect(timing).not.toHaveBeenCalled();
    } finally {
      loop.mockRestore();
      timing.mockRestore();
    }
  });

  test('a paused task has no clock', async () => {
    await shown(<WorkBlock tasks={[{ ...running(1), state: 'paused' }]} working />);
    expect(screen.queryByTestId('work-clock')).toBeNull();
  });
});
