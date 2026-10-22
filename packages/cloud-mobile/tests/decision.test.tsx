import { fireEvent, render, screen } from '@testing-library/react-native';
import type { InboxItem, Question } from '@maka-cloud/client';
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
