import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');

// expo-symbols draws Material icons on Android and throws without the package: the app closed
// itself on the first screen of the Android emulator run (then from the system tab bar's icons; now
// every icon the app draws goes through `Icon`).
test('the icons have the package their Android symbols need', () => {
  const icons = readFileSync(join(root, 'src/components/Icon.tsx'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  expect(icons).toMatch(/from 'expo-symbols'/u);
  expect(icons).toMatch(/\bandroid: '/u);
  expect(pkg.dependencies['expo-symbols']).toMatch(/^\d+\.\d+\.\d+$/u);
});
