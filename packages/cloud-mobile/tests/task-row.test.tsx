import type { TaskView } from '@maka-cloud/client';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import * as ReactNative from 'react-native';
import { TaskRow } from '@/components/TaskRow';
import { AppearanceProvider, useAppearance } from '@/lib/appearance';
import { LIGHT, ThemeContext, useTheme } from '@/lib/theme';

const wrap = (node: React.ReactElement) => (
  <ThemeContext.Provider value={LIGHT}>{node}</ThemeContext.Provider>
);

const task = (over: Partial<TaskView>): TaskView => ({
  taskId: 't1',
  title: 'Tag the release',
  state: 'running',
  createdAt: 1,
  progress: ['step: Checking tags'],
  cancelRequested: false,
  pauseRequested: false,
  ...over,
});

test('a running task has quiet controls and its current step', async () => {
  const sent: string[] = [];
  await render(
    wrap(
      <TaskRow
        task={task({})}
        tasks={[]}
        noPause={new Set()}
        busy={false}
        onControl={(_, action) => sent.push(action)}
      />,
    ),
  );
  expect(screen.getByText('Current step')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Pause task' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel task' }));
  expect(sent).toEqual(['pause', 'cancel']);
  // Words, not full-width pills.
  expect(screen.getByText('Pause')).toBeTruthy();
});

test('a failed task says what happened in plain words, the raw reason behind Details, and no step', async () => {
  await render(
    wrap(
      <TaskRow
        task={task({
          state: 'failed',
          failureReason: 'invalid manifest: result.json was not written',
        })}
        tasks={[]}
        noPause={new Set()}
        busy={false}
        onControl={() => {}}
      />,
    ),
  );
  expect(screen.queryByText('Current step')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Cancel task' })).toBeNull();
  expect(
    screen.getByText(/Maka finished, but its report of what it did could not be read\./u),
  ).toBeTruthy();
  expect(screen.queryByText('invalid manifest: result.json was not written')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByText('invalid manifest: result.json was not written')).toBeTruthy();
});

function Probe() {
  const { choice, setMode } = useAppearance();
  const t = useTheme();
  return (
    <>
      <Text testID="choice">{choice}</Text>
      <Text testID="scheme">{t.scheme}</Text>
      <Text onPress={() => setMode('light')}>go light</Text>
    </>
  );
}

test('appearance follows the phone until a choice is made', async () => {
  const scheme = jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue('dark');
  await render(
    <AppearanceProvider>
      <Probe />
    </AppearanceProvider>,
  );
  expect(screen.getByTestId('choice').props.children).toBe('system');
  expect(screen.getByTestId('scheme').props.children).toBe('dark');
  await act(async () => {
    fireEvent.press(screen.getByText('go light'));
  });
  expect(screen.getByTestId('scheme').props.children).toBe('light');
  scheme.mockRestore();
});
