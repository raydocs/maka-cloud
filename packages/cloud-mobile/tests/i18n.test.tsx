import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { languageFor, LanguageProvider, translator, useT } from '@/lib/i18n';
import { EN, PATTERNS_ZH, PHRASES_ZH, SERVER_CHOICES, ZH } from '@/lib/strings';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/gu)].map((m) => m[1]).sort();

test('every string exists in both languages, with the same values to fill in', () => {
  expect(Object.keys(ZH).sort()).toEqual(Object.keys(EN).sort());
  for (const [key, english] of Object.entries(EN)) {
    const chinese = ZH[key as keyof typeof EN];
    expect(english.trim()).not.toBe('');
    expect(chinese.trim()).not.toBe('');
    expect([key, placeholders(chinese)]).toEqual([key, placeholders(english)]);
  }
  for (const [english, chinese] of Object.entries(PHRASES_ZH)) {
    expect([english, chinese.trim()]).not.toEqual([english, '']);
  }
});

test('Chinese is the main language; English only when the phone puts English first', () => {
  expect(languageFor(['en-US', 'zh-Hans-CN'])).toBe('en');
  expect(languageFor(['en'])).toBe('en');
  expect(languageFor(['zh-Hans-CN', 'en-US'])).toBe('zh-Hans');
  expect(languageFor(['zh-Hant-TW'])).toBe('zh-Hans');
  expect(languageFor(['fr-FR', 'en-US'])).toBe('zh-Hans');
  expect(languageFor([])).toBe('zh-Hans');
});

test('values are filled in, and the shared logic’s English is translated only when known', () => {
  const zh = translator('zh-Hans');
  const en = translator('en');
  expect(zh.t('home.waiting', { count: 2 })).toBe('等你处理（2）');
  expect(en.t('home.waiting', { count: 2 })).toBe('Waiting on you (2)');
  expect(zh.tx('Reconnecting…')).toBe(PHRASES_ZH['Reconnecting…']);
  expect(zh.tx('in 5 min')).toBe('5 分钟后');
  expect(zh.tx('Request failed (502).')).toBe('请求失败（502）。');
  expect(zh.tx('Desktop, tablet and phone')).toBe('桌面、平板和手机');
  // Anything else, such as what the server or the agent wrote, is shown exactly as sent.
  expect(zh.tx('Fixed the login redirect')).toBe('Fixed the login redirect');
  expect(en.tx('Reconnecting…')).toBe('Reconnecting…');
  expect(zh.tx('constructor')).toBe('constructor');
  expect(zh.tx('toString')).toBe('toString');
  expect(PATTERNS_ZH.length).toBeGreaterThan(0);
});

test('the provider picks the language for everything under it', async () => {
  function Probe() {
    const { t, lang } = useT();
    return <Text>{`${lang}: ${t('tab.chat')}`}</Text>;
  }
  await render(
    <LanguageProvider language="zh-Hans">
      <Probe />
    </LanguageProvider>,
  );
  expect(screen.getByText('zh-Hans: 对话')).toBeTruthy();
});

// The fixed choices are the server's own: each must still be offered there, word for word.
test('every translated server choice is one the server offers, with that label', () => {
  const read = (path: string) => readFileSync(join(__dirname, '../..', path), 'utf8');
  const source = read('cloud-supervisor/src/rules.ts') + read('cloud-conductor/src/tools.ts');
  const constants: Record<string, string> = {
    approve_task: 'APPROVE_TASK_OPTION',
    approve_repository: 'APPROVE_REPOSITORY_OPTION',
  };
  for (const [id, label] of SERVER_CHOICES) {
    const quoted = label.includes("'") ? `"${label}"` : `'${label}'`;
    expect([id, label, source.includes(`label: ${quoted}`)]).toEqual([id, label, true]);
    expect([id, source.includes(constants[id] ?? `id: '${id}'`)]).toEqual([id, true]);
  }
  const zh = translator('zh-Hans');
  expect(zh.choice('ok', 'Got it')).toBe('知道了');
  expect(zh.choice('ok', 'Sure')).toBe('Sure');
  expect(zh.choice('maybe', 'Got it')).toBe('Got it');
  expect(translator('en').choice('reject', "Don't do it")).toBe("Don't do it");
});
