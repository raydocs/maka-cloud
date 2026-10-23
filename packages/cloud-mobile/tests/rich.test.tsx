import { render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Text } from 'react-native';
import { boldRuns, Card, Glass, Rich, withoutMarks } from '@/components/ui';
import { AppearanceProvider, ReduceTransparency } from '@/lib/appearance';
import { LIGHT, PANEL, ThemeContext } from '@/lib/theme';

const flat = (style: unknown) => Object.assign({}, ...[style].flat(3).filter(Boolean));

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

test('with Reduce Transparency on, glass and cards are solid fills', async () => {
  await render(
    <ReduceTransparency.Provider value>
      <ThemeContext.Provider value={LIGHT}>
        <Glass>
          <Text>On the sky</Text>
        </Glass>
        <Card label="A card">
          <Text>Card</Text>
        </Card>
      </ThemeContext.Provider>
      <ThemeContext.Provider value={PANEL}>
        <Glass>
          <Text>On the panel</Text>
        </Glass>
      </ThemeContext.Provider>
    </ReduceTransparency.Provider>,
  );
  const [sky, panel] = screen.getAllByTestId('glass-solid');
  expect(flat(sky?.props.style).backgroundColor).toBe(LIGHT.solid);
  expect(flat(panel?.props.style).backgroundColor).toBe(PANEL.panelRaised);
  expect(flat(screen.getByLabelText('A card').props.style).backgroundColor).toBe(LIGHT.solid);
});

test('without it, glass stays translucent', async () => {
  await render(
    <ThemeContext.Provider value={LIGHT}>
      <Glass>
        <Text>On the sky</Text>
      </Glass>
    </ThemeContext.Provider>,
  );
  expect(screen.queryByTestId('glass-solid')).toBeNull();
});

// The web preview has no Reduce Transparency setting: the app must still start there.
test('a platform without the setting starts with it off', async () => {
  const original = AccessibilityInfo.isReduceTransparencyEnabled;
  Object.defineProperty(AccessibilityInfo, 'isReduceTransparencyEnabled', {
    value: undefined,
    configurable: true,
  });
  try {
    await render(
      <AppearanceProvider>
        <Glass>
          <Text>Started</Text>
        </Glass>
      </AppearanceProvider>,
    );
    expect(screen.getByText('Started')).toBeTruthy();
    expect(screen.queryByTestId('glass-solid')).toBeNull();
  } finally {
    Object.defineProperty(AccessibilityInfo, 'isReduceTransparencyEnabled', {
      value: original,
      configurable: true,
    });
  }
});
