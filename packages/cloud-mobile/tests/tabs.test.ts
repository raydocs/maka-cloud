import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

// NativeTabs draws Material icons on Android through expo-symbols and throws without it: the app
// closed itself on the first screen of the Android emulator run.
test('the tab bar has the package its Android icons need', () => {
  const layout = readFileSync(join(root, 'src/app/(tabs)/_layout.tsx'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  expect(layout).toMatch(/\bmd="/u);
  expect(pkg.dependencies['expo-symbols']).toMatch(/^\d+\.\d+\.\d+$/u);
});
