import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const SRC = new URL('../src/', import.meta.url);

/**
 * The same files run in a browser and in React Native, so they may use only what
 * both have: `fetch`, streams, `TextDecoder` and `crypto`. A browser-only name
 * would work in the web app and fail on a phone, where nothing else catches it.
 */
const BROWSER_ONLY =
  /\b(window|document|localStorage|sessionStorage|navigator|location|Notification|ServiceWorker)\b\s*[.[]|from\s+['"](react|react-dom|react-native|expo[^'"]*)['"]/u;

test('the shared logic uses no DOM and no UI framework', () => {
  const files = readdirSync(SRC).filter((name) => name.endsWith('.ts'));
  expect(files).toContain('client.ts');
  for (const name of files) {
    const text = readFileSync(new URL(name, SRC), 'utf8')
      // A comment may name a browser; code may not.
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');
    expect(BROWSER_ONLY.exec(text)?.[0], name).toBeUndefined();
  }
});
