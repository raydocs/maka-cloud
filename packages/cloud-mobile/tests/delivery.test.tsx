import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';
import type { CloudClient, DeliveryModel, TaskView } from '@maka-cloud/client';
import { DiffLines, DeliveryCard, TaskDelivery } from '@/components/Delivery';
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
    {
      label: 'Open pull request',
      url: 'https://github.com/example/repo/pull/12',
      host: 'github.com',
    },
    { label: 'Open preview', url: 'https://preview.example.test/', host: 'preview.example.test' },
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
  await fireEvent.press(screen.getByRole('button', { name: 'Open pull request · github.com' }));
  expect(open).toHaveBeenCalledWith('https://github.com/example/repo/pull/12');
  await fireEvent.press(screen.getByRole('button', { name: 'View the changes' }));
  expect(await screen.findByText('+redirect once')).toBeTruthy();
  expect(screen.getByText('-redirect forever')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByText('+redirect once')).toBeNull();
});

test('the other files a task made are one quiet line each, and open as inert text', async () => {
  const reads: number[] = [];
  const client = {
    readArtifact: async (_task: string, index: number) => {
      reads.push(index);
      return { kind: 'text', name: 'notes.md', text: '**Done.** <b>kept as text</b>' };
    },
  } as unknown as CloudClient;
  const finished = {
    ...task,
    manifest: { summary: 'The login page no longer loops.' },
  } as TaskView;
  const listings = [
    { index: 1, name: 'out/changes.diff', kind: 'file' as const },
    { index: 2, name: 'notes.md', kind: 'file' as const },
    {
      index: 3,
      name: 'https://example.test/',
      kind: 'link' as const,
      url: 'https://example.test/',
    },
  ];
  await render(wrap(<TaskDelivery client={client} task={finished} listings={listings} />));
  // The diff is already the card's "View the changes", and a link is not a file.
  expect(await screen.findByRole('button', { name: 'View the changes' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open out/changes.diff' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Open https/u })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Open notes.md' }));
  expect(await screen.findByText('**Done.** <b>kept as text</b>')).toBeTruthy();
  expect(reads).toEqual([2]);
});

test('with a picture as the proof, the diff is one of the quiet file lines', async () => {
  const client = {
    readArtifact: async () => ({ kind: 'image', name: 'a.png', blob: new Blob(['png']) }),
  } as unknown as CloudClient;
  const finished = { ...task, manifest: { summary: 'Done.' } } as TaskView;
  const listings = [
    { index: 1, name: 'out/changes.diff', kind: 'file' as const },
    { index: 2, name: 'login.png', kind: 'file' as const, image: true as const },
  ];
  await render(wrap(<TaskDelivery client={client} task={finished} listings={listings} />));
  expect(await screen.findByRole('button', { name: 'Open out/changes.diff' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open login.png' })).toBeNull();
});

test('a result with no links offers none, and Details is only there when it can be opened', async () => {
  const client = {} as unknown as CloudClient;
  await render(wrap(<DeliveryCard client={client} task={task} model={model({ actions: [] })} />));
  expect(screen.queryByRole('button', { name: / · /u })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
});

test('diff text is shown inert: a line that looks like markup stays text', async () => {
  await render(wrap(<DiffLines text={'+<b>bold</b>\n context'} />));
  expect(screen.getByText('+<b>bold</b>')).toBeTruthy();
});

test('a very long diff shows its first lines and the rest only when asked for', async () => {
  const text = Array.from({ length: 1000 }, (_, i) => `+line ${i}`).join('\n');
  await render(wrap(<DiffLines text={text} />));
  expect(screen.getByText('+line 399')).toBeTruthy();
  expect(screen.queryByText('+line 400')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Show 1000 of 1000 lines' }));
  expect(screen.getByText('+line 999')).toBeTruthy();
});

test('even "show more" stops at a hard cap, and says where to read the rest', async () => {
  const text = Array.from({ length: 6000 }, (_, i) => `+line ${i}`).join('\n');
  await render(wrap(<DiffLines text={text} />));
  await fireEvent.press(screen.getByRole('button', { name: 'Show 5000 of 6000 lines' }));
  expect(screen.getByText('+line 4999')).toBeTruthy();
  expect(screen.queryByText('+line 5000')).toBeNull();
  expect(
    screen.getByText('Showing the first 5000 of 6000 lines. Read the rest on the web.'),
  ).toBeTruthy();
});

test('screenshots at several sizes show side by side, labelled, instead of the changes', async () => {
  const reads: number[] = [];
  const client = {
    readArtifact: async (_task: string, index: number) => {
      reads.push(index);
      return {
        kind: 'image',
        name: `${index}.png`,
        blob: new Blob(['png'], { type: 'image/png' }),
      };
    },
  } as unknown as CloudClient;
  const desktop = {
    index: 3,
    name: 'home-desktop.png',
    kind: 'file' as const,
    image: true as const,
  };
  const phone = { index: 4, name: 'home-phone.png', kind: 'file' as const, image: true as const };
  await render(
    wrap(
      <DeliveryCard
        client={client}
        task={task}
        model={model({
          caption: 'Desktop and phone',
          shot: desktop,
          views: [
            { viewport: 'Desktop', listing: desktop },
            { viewport: 'Phone', listing: phone },
          ],
        })}
      />,
    ),
  );
  expect(screen.getByLabelText('Open large: Desktop')).toBeTruthy();
  expect(screen.getByLabelText('Open large: Phone')).toBeTruthy();
  expect(screen.getByText('Desktop')).toBeTruthy();
  expect(screen.getByText('Phone')).toBeTruthy();
  // The frames say what they are; the caption is not repeated, and the diff gives way.
  expect(screen.queryByText('Desktop and phone')).toBeNull();
  expect(screen.queryByRole('button', { name: 'View the changes' })).toBeNull();
  expect([...reads].sort()).toEqual([3, 4]);
});
