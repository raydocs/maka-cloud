import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ComponentProps } from 'react';
import { TopBar } from '@/components/TopBar';
import { boldRuns, Rich, withoutMarks } from '@/components/ui';
import { LIGHT, PANEL, ThemeContext } from '@/lib/theme';

type Props = ComponentProps<typeof TopBar>;

function bar(index: number, prevent = false) {
  const routes = ['index', 'chat', 'settings'].map((name) => ({ key: `${name}-k`, name }));
  const titles: Record<string, string> = { index: 'Home', chat: 'Chat', settings: 'Settings' };
  const pressed: string[] = [];
  const props = {
    state: { index, routes },
    descriptors: Object.fromEntries(
      routes.map((route) => [route.key, { options: { title: titles[route.name] } }]),
    ),
    emitter: { emit: () => ({ defaultPrevented: prevent }) },
    navigateToTab: (key: string) => pressed.push(key),
    insets: { top: 47, bottom: 34, left: 0, right: 0 },
  } as unknown as Props;
  return { props, pressed };
}

const flat = (style: unknown) => Object.assign({}, ...[style].flat(3).filter(Boolean));

test('the sections are tabs in one pill: the open one is selected, the others navigate', async () => {
  const { props, pressed } = bar(0);
  await render(
    <ThemeContext.Provider value={LIGHT}>
      <TopBar {...props} />
    </ThemeContext.Provider>,
  );
  const tabs = screen.getAllByRole('tab');
  expect(tabs.map((tab) => tab.props.accessibilityLabel)).toEqual(['Home', 'Chat', 'Settings']);
  expect(screen.getByRole('tab', { name: 'Home' }).props.accessibilityState).toEqual({
    selected: true,
  });
  // Every segment is a full touch target.
  for (const tab of tabs) expect(flat(tab.props.style).minHeight).toBeGreaterThanOrEqual(44);
  // The open section is the one dark pill on the sky.
  expect(flat(screen.getByRole('tab', { name: 'Home' }).props.style).backgroundColor).toBe(
    LIGHT.pillOn,
  );
  await fireEvent.press(screen.getByRole('tab', { name: 'Home' }));
  await fireEvent.press(screen.getByRole('tab', { name: 'Chat' }));
  expect(pressed).toEqual(['chat-k']);
});

test('over the conversation the pill takes the panel glass, whatever the appearance', async () => {
  const { props } = bar(1);
  await render(
    <ThemeContext.Provider value={LIGHT}>
      <TopBar {...props} />
    </ThemeContext.Provider>,
  );
  const chat = screen.getByRole('tab', { name: 'Chat' });
  expect(flat(chat.props.style).backgroundColor).toBe(PANEL.panelGlassOn);
  expect(flat(screen.getByText('Home').props.style).color).toBe(PANEL.ink);
});

test('a prevented tab press does not navigate', async () => {
  const { props, pressed } = bar(0, true);
  await render(<TopBar {...props} />);
  await fireEvent.press(screen.getByRole('tab', { name: 'Settings' }));
  expect(pressed).toEqual([]);
});

test('bold lead-ins are drawn bold and read without their marks; nothing else changes', async () => {
  expect(boldRuns('**State is part of the design.** Empty, loading.')).toEqual([
    { text: 'State is part of the design.', bold: true },
    { text: ' Empty, loading.', bold: false },
  ]);
  expect(boldRuns('2 * 3 ** 2 and a lone **')).toEqual([
    { text: '2 * 3 ** 2 and a lone **', bold: false },
  ]);
  expect(withoutMarks('**One.** Two **three**')).toBe('One. Two three');
  await render(<Rich text="**One.** Two" />);
  expect(flat(screen.getByText('One.').props.style).fontWeight).toBe('700');
});
