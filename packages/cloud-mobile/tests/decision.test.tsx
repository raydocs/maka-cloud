import { fireEvent, render, screen } from '@testing-library/react-native';
import type { InboxItem, Question, TaskView } from '@maka-cloud/client';
import { DecisionCard, QuestionBlock } from '@/components/Decision';
import { DARK } from '@/lib/theme';
import { ThemeContext } from '@/lib/theme';

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
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
  evidence: [{ kind: 'action', tool: 'Bash', args: '{"command":"git push"}' }],
  state: 'open',
  closeReason: null,
  preconditionHash: 'h',
  version: 1,
  interrupts: false,
  delivery: 'none',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const wrap = (node: React.ReactElement) => (
  <ThemeContext.Provider value={DARK}>{node}</ThemeContext.Provider>
);

test('an approval is shown exactly as the server sent it, with the held call, and one tap answers', async () => {
  const answers: [string, string | undefined][] = [];
  await render(
    wrap(<DecisionCard item={item()} disabled={false} onAnswer={(o, t) => answers.push([o, t])} />),
  );
  expect(screen.getByText('Run "git push" on the repo?')).toBeTruthy();
  expect(screen.getByText('{"command":"git push"}')).toBeTruthy();
  expect(screen.queryByText('The filled button is the recommended answer.')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
  expect(answers).toEqual([['approve', undefined]]);
});

test('an approval that cannot be shown exactly cannot be approved', async () => {
  await render(
    wrap(
      <DecisionCard
        item={item({ ask: 'Run "git push"‮ on the repo?' })}
        disabled={false}
        onAnswer={() => {}}
      />,
    ),
  );
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  expect(screen.getByText(/cannot be approved here/u)).toBeTruthy();
});

test('a disabled card sends nothing, and an answer being delivered says so instead of offering buttons', async () => {
  const answers: string[] = [];
  const { rerender } = await render(
    wrap(<DecisionCard item={item()} disabled onAnswer={(o) => answers.push(o)} />),
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
  expect(answers).toEqual([]);
  await rerender(
    wrap(
      <DecisionCard
        item={item({ state: 'answering', delivery: 'retrying' })}
        disabled={false}
        onAnswer={() => {}}
      />,
    ),
  );
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.getByText(/keep trying/u)).toBeTruthy();
});

test('outside text is filtered like on the web: vendor names and hidden characters never show', async () => {
  await render(
    wrap(
      <DecisionCard
        item={item({ kind: 'decision', ask: 'Ask GPT-5 and Claude​?', evidence: [] })}
        disabled={false}
        onAnswer={() => {}}
      />,
    ),
  );
  expect(screen.getByText('Ask assistant-5 and assistant?')).toBeTruthy();
});

test('a question with a note is answered with the note, and shows the recorded answer after', async () => {
  const question: Question = {
    questionId: 'q1',
    question: 'Which direction?',
    reason: 'taste',
    options: [
      { id: 'a', label: 'Left' },
      { id: 'b', label: 'Right' },
    ],
    recommended: 'b',
  } as Question;
  const answers: [string, string | undefined][] = [];
  const { rerender } = await render(
    wrap(
      <QuestionBlock
        question={question}
        disabled={false}
        onAnswer={(o, t) => answers.push([o, t])}
      />,
    ),
  );
  // The note is there only when asked for.
  expect(screen.queryByLabelText('Note')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Add a note' }));
  await fireEvent.changeText(screen.getByLabelText('Note'), 'soon please');
  await fireEvent.press(screen.getByRole('button', { name: 'Right' }));
  expect(answers).toEqual([['b', 'soon please']]);
  await rerender(
    wrap(<QuestionBlock question={question} answered="b" disabled={false} onAnswer={() => {}} />),
  );
  expect(screen.getByText('Answer recorded: Right')).toBeTruthy();
});

test('a finished task reads as title, how far it was checked, and the outcome; other wording stays whole', async () => {
  const finished = item({
    kind: 'finished',
    ask: '“Weekly report” finished (not independently checked): “The weekly report is ready.”',
    options: [{ id: 'ok', label: 'Got it', recommended: true }],
    evidence: [],
  });
  const answers: string[] = [];
  await render(
    wrap(<DecisionCard item={finished} disabled={false} onAnswer={(o) => answers.push(o)} />),
  );
  expect(screen.getByText('Weekly report finished')).toBeTruthy();
  expect(screen.getByText('Not independently checked')).toBeTruthy();
  expect(screen.getByText('The weekly report is ready.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Got it' }));
  expect(answers).toEqual(['ok']);
});

test('a finished card in another shape is shown exactly as sent', async () => {
  const odd = item({
    kind: 'finished',
    ask: 'Finished (independently checked): the login loop is fixed.',
    options: [],
    evidence: [],
  });
  await render(wrap(<DecisionCard item={odd} disabled={false} onAnswer={() => {}} />));
  expect(
    screen.getByText('Finished (independently checked): the login loop is fixed.'),
  ).toBeTruthy();
});

// The pull request tool's card, as the conductor builds it (`approvalCard`): the call, then its details.
const prCard = [
  'Allow open_pull_request(taskId: t1, title: "Fix the login loop")? It cannot be undone.',
  '',
  'Repository: example/site',
  'Branch: maka/t1',
  'Title: "Fix the login loop"',
  'Base branch: main',
].join('\n');

const scopedQuestion: Question = {
  questionId: 'q2',
  reason: 'irreversible',
  question: prCard,
  note: 'The fix is reviewed and the tests pass.',
  action: { tool: 'open_pull_request', args: { taskId: 't1', title: 'Fix the login loop' } },
  options: [
    { id: 'approve', label: 'Go ahead, just this once' },
    { id: 'approve_task', label: "Go ahead, and don't ask again for this repository in this task" },
    { id: 'approve_repository', label: "Go ahead, and don't ask again for this repository" },
    { id: 'reject', label: "Don't do it" },
  ],
  recommended: 'approve',
};

test('an approval fills its slots in order: what will happen, what it touches, the exact details, the scope', async () => {
  await render(
    wrap(<QuestionBlock question={scopedQuestion} disabled={false} onAnswer={() => {}} />),
  );
  // Found in the order they are drawn.
  const slots = screen.getAllByTestId(
    /^(decision-will|decision-touches|decision-exact|scope-approve)$/u,
  );
  expect(slots.map((node) => node.props.testID)).toEqual([
    'decision-will',
    'decision-touches',
    'decision-exact',
    'scope-approve',
  ]);
  expect(screen.getByText('Maka will open a pull request.')).toBeTruthy();
  expect(screen.getByText('The fix is reviewed and the tests pass.')).toBeTruthy();
  expect(screen.getByText('example/site · branch maka/t1 · into main')).toBeTruthy();
  // The exact text is shown whole, as sent: never paraphrased.
  expect(screen.getByTestId('decision-exact').props.children).toBe(prCard);
});

test('the scope is chosen above one "Go ahead" pill, which answers with it', async () => {
  const answers: string[] = [];
  await render(
    wrap(
      <QuestionBlock
        question={scopedQuestion}
        disabled={false}
        onAnswer={(optionId) => answers.push(optionId)}
      />,
    ),
  );
  // One approving pill, not three; refusing stays its own pill.
  expect(screen.getAllByText('Go ahead')).toHaveLength(1);
  expect(screen.getByRole('button', { name: "Don't do it" })).toBeTruthy();
  expect(screen.getByTestId('scope-approve').props.accessibilityState.selected).toBe(true);
  expect(screen.queryByTestId('scope-meaning')).toBeNull();
  await fireEvent.press(screen.getByRole('radio', { name: 'This repository' }));
  expect(screen.getByTestId('scope-approve_repository').props.accessibilityState.selected).toBe(
    true,
  );
  // A kept approval says what it means in full.
  expect(screen.getByTestId('scope-meaning').props.children).toBe(
    "Go ahead, and don't ask again for this repository",
  );
  await fireEvent.press(
    screen.getByRole('button', { name: "Go ahead, and don't ask again for this repository" }),
  );
  expect(answers).toEqual(['approve_repository']);
});

test('without scopes on offer there is no scope control, and only the recommended answer is filled', async () => {
  await render(wrap(<DecisionCard item={item()} disabled={false} onAnswer={() => {}} />));
  expect(screen.queryByTestId('scope-approve')).toBeNull();
  const fill = (name: string) =>
    Object.assign({}, ...[screen.getByRole('button', { name }).props.style].flat(9))
      .backgroundColor;
  expect(fill('Approve')).toBe(DARK.pillOn);
  expect(fill('Deny')).not.toBe(DARK.pillOn);
});

test('an answered approval shrinks to a one-line receipt that still opens what was approved', async () => {
  await render(
    wrap(
      <QuestionBlock
        question={scopedQuestion}
        answered="approve_task"
        disabled={false}
        onAnswer={() => {}}
      />,
    ),
  );
  expect(screen.getByTestId('decision-receipt')).toBeTruthy();
  expect(
    screen.getByText(
      "Answer recorded: Go ahead, and don't ask again for this repository in this task",
    ),
  ).toBeTruthy();
  expect(screen.queryByTestId('decision-exact')).toBeNull();
  // Only "Details" is left to press: no answer can be given twice.
  expect(screen.getAllByRole('button').map((button) => button.props.accessibilityLabel)).toEqual([
    'Details',
  ]);
  await fireEvent.press(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByTestId('decision-exact').props.children).toBe(prCard);
  expect(screen.getByText('{"taskId":"t1","title":"Fix the login loop"}')).toBeTruthy();
});

test('an approving answer in other words than the server’s own keeps its own pill', async () => {
  const answers: string[] = [];
  const odd: Question = {
    ...scopedQuestion,
    options: [
      { id: 'approve', label: 'Go ahead, just this once' },
      { id: 'approve_task', label: 'Go ahead for this task, and push to main as well' },
      { id: 'reject', label: "Don't do it" },
    ],
  };
  await render(
    wrap(<QuestionBlock question={odd} disabled={false} onAnswer={(id) => answers.push(id)} />),
  );
  expect(screen.queryByTestId('scope-approve')).toBeNull();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Go ahead for this task, and push to main as well' }),
  );
  expect(answers).toEqual(['approve_task']);
});

test('a card about a task shows what its checks reported as evidence badges', async () => {
  const task: TaskView = {
    taskId: 't1',
    state: 'running',
    createdAt: 1,
    progress: [],
    cancelRequested: false,
    pauseRequested: false,
    panels: [
      {
        panelId: 'tests',
        kind: 'tests',
        state: 'passed',
        title: 'Repository tests',
        summary: '41 passed',
      },
      {
        panelId: 'review',
        kind: 'review',
        state: 'passed',
        title: 'Second review',
        summary: '0 P1, 1 P2, 0 P3',
      },
    ],
  };
  await render(
    wrap(<DecisionCard item={item()} task={task} disabled={false} onAnswer={() => {}} />),
  );
  expect(screen.getByText('Tests · 41 passed')).toBeTruthy();
  expect(screen.getByText('Review · 0 P1, 1 P2, 0 P3')).toBeTruthy();
  // No task and no files or links: no evidence slot at all.
  await screen.rerender(wrap(<DecisionCard item={item()} disabled={false} onAnswer={() => {}} />));
  expect(screen.queryByTestId('decision-evidence')).toBeNull();
});
