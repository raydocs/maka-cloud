import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Text } from 'react-native';
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import SectionsLayout from '@/app/(tabs)/_layout';

// The layout's landing (open the latest conversation after signing in) needs a session; not here.
jest.mock('@/lib/landing', () => ({ useLanding: () => {} }));

const root = join(__dirname, '..');

// `Icon` draws Material icons on Android through expo-symbols and throws without it: the app
// closed itself on the first screen of the Android emulator run.
test('the icons have the package their Android symbols need', () => {
  const icons = readFileSync(join(root, 'src/components/Icon.tsx'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  expect(icons).toMatch(/from 'expo-symbols'/u);
  expect(icons).toMatch(/\bandroid: '/u);
  expect(pkg.dependencies['expo-symbols']).toMatch(/^\d+\.\d+\.\d+$/u);
});

const app = () =>
  renderRouter(
    {
      '(tabs)/_layout': SectionsLayout,
      '(tabs)/index': () => <Text>Home screen</Text>,
      '(tabs)/chat': () => <Text>Chat screen</Text>,
      '(tabs)/projects': () => <Text>Projects screen</Text>,
      me: () => <Text>Me screen</Text>,
      search: () => <Text>Search screen</Text>,
    },
    { initialUrl: '/' },
  );

test('no bottom tab bar: a top pill with three sections, each with a fixed test id', async () => {
  const view = await app();
  expect(await screen.findByText('Home screen')).toBeTruthy();
  const tabs = ['tab-home', 'tab-chat', 'tab-projects'].map((id) => screen.getByTestId(id));
  expect(tabs.map((tab) => tab.props.accessibilityLabel)).toEqual(['Home', 'Chat', 'Projects']);
  expect(tabs.map((tab) => tab.props.accessibilityState.selected)).toEqual([true, false, false]);
  expect(screen.queryByTestId('tab-settings')).toBeNull();
  await fireEvent.press(screen.getByTestId('tab-projects'));
  expect(await screen.findByText('Projects screen')).toBeTruthy();
  expect(screen.getByTestId('tab-projects').props.accessibilityState.selected).toBe(true);
  expect(view.getPathname()).toBe('/projects');
  await fireEvent.press(screen.getByTestId('tab-chat'));
  expect(view.getPathname()).toBe('/chat');
});

test('search sits at the top left and Me at the top right; each opens its own screen', async () => {
  const view = await app();
  await screen.findByText('Home screen');
  expect(screen.getByRole('button', { name: 'Search' }).props.testID).toBe('button-search');
  await fireEvent.press(screen.getByTestId('button-me'));
  expect(await screen.findByText('Me screen')).toBeTruthy();
  expect(view.getPathname()).toBe('/me');
});

// Three words between two round buttons: on a narrow phone or with large text the pill's
// sections give way and their words shrink to one line, rather than being cut off.
test('the pill fits a narrow screen: its sections shrink and keep one line each', async () => {
  await app();
  await screen.findByText('Home screen');
  for (const id of ['tab-home', 'tab-chat', 'tab-projects']) {
    const segment = screen.getByTestId(id);
    const style = Object.assign({}, ...[segment.props.style].flat(Number.POSITIVE_INFINITY));
    expect([id, style.flexShrink]).toEqual([id, 1]);
  }
  const words = screen.getByText('Projects');
  expect(words.props.numberOfLines).toBe(1);
  expect(words.props.adjustsFontSizeToFit).toBe(true);
});
