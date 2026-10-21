import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';
import type { CloudClient, DeliveryModel, TaskView } from '@maka-cloud/client';
import { DiffLines, DeliveryCard } from '@/components/Delivery';
import { DARK, ThemeContext } from '@/lib/theme';

const task = {
  taskId: 't1',
  title: 'Fix the login loop',
  state: 'succeeded',
  createdAt: 1,
  progress: [],
  cancelRequested: false,
  pauseRequested: false,
} as TaskView;

const wrap = (node: React.ReactElement) => (
  <ThemeContext.Provider value={DARK}>{node}</ThemeContext.Provider>
);

const model = (over: Partial<DeliveryModel> = {}): DeliveryModel => ({
  outcome: 'The login page no longer loops.',
  caption: 'The changes',
  actions: [
    { label: 'Open pull request', url: 'https://github.com/example/repo/pull/12' },
    { label: 'Open preview', url: 'https://preview.example.test/' },
  ],
  diff: { index: 1, name: 'out/changes.diff', kind: 'file' },
  ...over,
});

test('the card says the outcome, offers the changes and opens each action as a link', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue();
  const client = {
    readArtifact: async () => ({
      kind: 'text',
      name: 'changes.diff',
      text: '+redirect once\n-redirect forever',
    }),
  } as unknown as CloudClient;
  await render(
    wrap(<DeliveryCard client={client} task={task} model={model()} onOpenTask={() => {}} />),
  );
  expect(screen.getByText('The login page no longer loops.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Open pull request ↗' }));
  expect(open).toHaveBeenCalledWith('https://github.com/example/repo/pull/12');
  await fireEvent.press(screen.getByRole('button', { name: 'View the changes' }));
  expect(await screen.findByText('+redirect once')).toBeTruthy();
  expect(screen.getByText('-redirect forever')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByText('+redirect once')).toBeNull();
});

test('a result with no links offers none, and Details is only there when it can be opened', async () => {
  const client = {} as unknown as CloudClient;
  await render(wrap(<DeliveryCard client={client} task={task} model={model({ actions: [] })} />));
  expect(screen.queryByRole('button', { name: /↗/u })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
});

test('diff text is shown inert: a line that looks like markup stays text', async () => {
  await render(wrap(<DiffLines text={'+<b>bold</b>\n context'} />));
  expect(screen.getByText('+<b>bold</b>')).toBeTruthy();
});
