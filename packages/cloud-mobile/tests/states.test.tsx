import { fireEvent, render, screen } from '@testing-library/react-native';
import { InboxStatus } from '@/components/InboxStatus';
import { Field, RoundButton } from '@/components/ui';
import { DARK, ThemeContext } from '@/lib/theme';

const wrap = (node: React.ReactElement) => (
  <ThemeContext.Provider value={DARK}>{node}</ThemeContext.Provider>
);

test('where decisions would be, Home says loading, could not be read, or nothing waits; never blank', async () => {
  let retried = 0;
  const { rerender } = await render(
    wrap(<InboxStatus loaded={false} failed={false} onRetry={() => retried++} />),
  );
  expect(screen.getByLabelText('Loading')).toBeTruthy();
  await rerender(wrap(<InboxStatus loaded={false} failed onRetry={() => retried++} />));
  expect(screen.getByText('Decisions could not be loaded.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(retried).toBe(1);
  await rerender(wrap(<InboxStatus loaded failed={false} onRetry={() => {}} />));
  expect(screen.getByText('Nothing needs you. Start something below.')).toBeTruthy();
  // An empty list that could not be refreshed is not "all clear".
  await rerender(wrap(<InboxStatus loaded failed onRetry={() => {}} />));
  expect(screen.queryByText('Nothing needs you. Start something below.')).toBeNull();
  expect(screen.getByText('Decisions could not be loaded.')).toBeTruthy();
});

test('the send button is plainly at rest when empty and filled when there is something to send', async () => {
  const sent: string[] = [];
  const { rerender } = await render(
    wrap(<RoundButton label="Send" glyph="↑" disabled onPress={() => sent.push('x')} />),
  );
  const flat = (style: unknown) => Object.assign({}, ...[style].flat(3).filter(Boolean));
  expect(flat(screen.getByRole('button', { name: 'Send' }).props.style).backgroundColor).toBe(
    DARK.chip,
  );
  await rerender(
    wrap(<RoundButton label="Send" glyph="↑" disabled={false} onPress={() => sent.push('x')} />),
  );
  expect(flat(screen.getByRole('button', { name: 'Send' }).props.style).backgroundColor).toBe(
    DARK.accent,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  expect(sent).toEqual(['x']);
});

test('a field can show its name above it, not only as a placeholder', async () => {
  await render(wrap(<Field label="Server address" showLabel placeholder="maka.example.com" />));
  expect(screen.getByText('Server address')).toBeTruthy();
  expect(screen.getByPlaceholderText('maka.example.com')).toBeTruthy();
});
