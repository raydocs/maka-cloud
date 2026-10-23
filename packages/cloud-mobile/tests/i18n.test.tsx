import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { languageFor, LanguageProvider, translator, useT } from '@/lib/i18n';
import { EN, PATTERNS_ZH, PHRASES_ZH, ZH } from '@/lib/strings';

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
