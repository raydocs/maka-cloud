import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

// NativeTabs and `Icon` draw Material icons on Android through expo-symbols and throw without it:
// the app closed itself on the first screen of the Android emulator run.
test('the tab bar and the icons have the package their Android symbols need', () => {
  const layout = readFileSync(join(root, 'src/app/(tabs)/_layout.tsx'), 'utf8');
  const icons = readFileSync(join(root, 'src/components/Icon.tsx'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  expect(layout).toMatch(/\bmd="/u);
  expect(icons).toMatch(/from 'expo-symbols'/u);
  expect(icons).toMatch(/\bandroid: '/u);
  expect(pkg.dependencies['expo-symbols']).toMatch(/^\d+\.\d+\.\d+$/u);
});

// The device tests find each tab by a fixed name, whatever the language the labels are in.
test('every tab has a fixed test id', () => {
  const layout = readFileSync(join(root, 'src/app/(tabs)/_layout.tsx'), 'utf8');
  for (const tab of ['tab-home', 'tab-chat', 'tab-settings'])
    expect(layout).toContain(`testID="${tab}"`);
});
