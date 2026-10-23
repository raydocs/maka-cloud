import { ApiError, errorText, quotaText } from '@maka-cloud/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import { LANGUAGES, languageFor, LanguageProvider, translator, useT } from '@/lib/i18n';
import { EN, PATTERNS_ZH, PHRASES_ZH, SERVER_CHOICES, ZH } from '@/lib/strings';
import { PATTERNS_HANT, PHRASES_HANT, ZH_HANT } from '@/lib/strings.hant';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/gu)].map((m) => m[1]).sort();
const secure = () => (globalThis as unknown as { __secure: Map<string, string> }).__secure;

test('every string exists in all three languages, with the same values to fill in', () => {
  for (const [name, table] of [
    ['zh-Hans', ZH],
    ['zh-Hant', ZH_HANT],
  ] as const) {
    expect([name, Object.keys(table).sort()]).toEqual([name, Object.keys(EN).sort()]);
    for (const [key, english] of Object.entries(EN)) {
      const chinese = table[key as keyof typeof EN];
      expect(english.trim()).not.toBe('');
      expect([name, key, chinese.trim() !== '']).toEqual([name, key, true]);
      expect([name, key, placeholders(chinese)]).toEqual([name, key, placeholders(english)]);
    }
  }
  // Traditional Chinese has its own words for everything the shared logic says.
  expect(Object.keys(PHRASES_HANT).sort()).toEqual(Object.keys(PHRASES_ZH).sort());
  expect(PATTERNS_HANT.length).toBe(PATTERNS_ZH.length);
  for (const phrases of [PHRASES_ZH, PHRASES_HANT])
    for (const [english, chinese] of Object.entries(phrases))
      expect([english, chinese.trim()]).not.toEqual([english, '']);
  // The web app and the server's messages name duties and kept approvals one way; the phone
  // must not coin its own words for them. The web's own catalogue is read, so a change there
  // without the phone (or here without the web) fails.
  const web = readFileSync(join(__dirname, '../../cloud-web/src/strings.ts'), 'utf8');
  for (const [table, phrases, duty, kept, noDuties] of [
    [ZH, PHRASES_ZH, '常驻任务', '已记住的授权', '还没有'],
    [ZH_HANT, PHRASES_HANT, '常駐任務', '已記住的授權', '還沒有'],
  ] as const) {
    expect(web).toContain(`'Kept approvals': '${kept}'`);
    expect(web).toContain(`'No duties yet.': '${noDuties}${duty}。'`);
    expect(table['me.grants']).toBe(kept);
    for (const key of [
      'projects.body',
      'projects.duties',
      'home.watching.one',
      'home.watching.many',
    ] as const)
      expect(table[key]).toContain(duty);
    expect(Object.values(phrases).some((text) => text.includes(duty))).toBe(true);
    for (const coined of ['日常任务', '例行任務', '值守任务', '值守任務', '已保留'])
      expect(
        `${Object.values(table).join('\n')}\n${Object.values(phrases).join('\n')}`,
      ).not.toContain(coined);
  }
  // No Traditional string is the Simplified one (a few short words are the same in both).
  const same = Object.keys(EN).filter(
    (key) =>
      /[一-鿿]/u.test(ZH[key as keyof typeof EN]) &&
      ZH[key as keyof typeof EN] === ZH_HANT[key as keyof typeof EN],
  );
  expect(same.length).toBeLessThan(Object.keys(EN).length / 5);
});

test('the phone’s first language decides: each family of locales', () => {
  for (const tag of ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-TW', 'zh-Hant-HK', 'zh_TW'])
    expect([tag, languageFor([tag])]).toEqual([tag, 'zh-Hant']);
  for (const tag of ['zh-Hans', 'zh-CN', 'zh-SG', 'zh', 'zh-Hans-CN', 'zh-Hans-HK'])
    expect([tag, languageFor([tag])]).toEqual([tag, 'zh-Hans']);
  for (const tag of ['en', 'en-US', 'en-GB', 'en-AU'])
    expect([tag, languageFor([tag])]).toEqual([tag, 'en']);
  for (const tag of ['fr-FR', 'ja-JP', 'ko-KR', ''])
    expect([tag, languageFor([tag])]).toEqual([tag, 'zh-Hans']);
  expect(languageFor([])).toBe('zh-Hans');
  // Only the first language counts.
  expect(languageFor(['en-US', 'zh-Hant-TW'])).toBe('en');
  expect(languageFor(['fr-FR', 'en-US'])).toBe('zh-Hans');
});

test('a language picked in the app is kept on the device and wins over the phone’s', async () => {
  function Picker() {
    const { lang, chosen, choose, t } = useT();
    return (
      <>
        <Text>{`${lang} ${chosen ?? 'phone'} ${t('tab.projects')}`}</Text>
        {LANGUAGES.map((language) => (
          <Pressable key={language} accessibilityRole="button" onPress={() => choose(language)}>
            <Text>{`pick ${language}`}</Text>
          </Pressable>
        ))}
      </>
    );
  }
  // The test phone is set to English.
  const first = await render(
    <LanguageProvider>
      <Picker />
    </LanguageProvider>,
  );
  expect(await screen.findByText('en phone Projects')).toBeTruthy();
  await fireEvent.press(screen.getByText('pick zh-Hant'));
  expect(screen.getByText('zh-Hant zh-Hant 專案')).toBeTruthy();
  expect(secure().get('maka.language')).toBe('zh-Hant');
  await act(async () => first.unmount());
  // A new start reads the choice back.
  await render(
    <LanguageProvider>
      <Picker />
    </LanguageProvider>,
  );
  expect(await screen.findByText('zh-Hant zh-Hant 專案')).toBeTruthy();
  await fireEvent.press(screen.getByText('pick zh-Hans'));
  expect(screen.getByText('zh-Hans zh-Hans 项目')).toBeTruthy();
  expect(secure().get('maka.language')).toBe('zh-Hans');
});

test('"use phone language" clears a saved choice, and the phone decides again', async () => {
  function Phone() {
    const { lang, chosen, choose, t } = useT();
    return (
      <>
        <Text>{`${lang} ${chosen ?? 'phone'} ${t('tab.projects')}`}</Text>
        <Pressable accessibilityRole="button" onPress={() => choose(undefined)}>
          <Text>use phone</Text>
        </Pressable>
      </>
    );
  }
  secure().set('maka.language', 'zh-Hant');
  const first = await render(
    <LanguageProvider>
      <Phone />
    </LanguageProvider>,
  );
  expect(await screen.findByText('zh-Hant zh-Hant 專案')).toBeTruthy();
  await fireEvent.press(screen.getByText('use phone'));
  // The test phone is set to English.
  expect(screen.getByText('en phone Projects')).toBeTruthy();
  expect(secure().has('maka.language')).toBe(false);
  await act(async () => first.unmount());
  await render(
    <LanguageProvider>
      <Phone />
    </LanguageProvider>,
  );
  expect(await screen.findByText('en phone Projects')).toBeTruthy();
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
  const hant = translator('zh-Hant');
  expect(hant.t('home.waiting', { count: 2 })).toBe('等你處理（2）');
  expect(hant.tx('Reconnecting…')).toBe('正在重新連線…');
  expect(hant.tx('in 5 min')).toBe('5 分鐘後');
  expect(hant.tx('Desktop, tablet and phone')).toBe('桌機、平板和手機');
  expect(hant.tx('Fixed the login redirect')).toBe('Fixed the login redirect');
  expect(hant.tx('constructor')).toBe('constructor');
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
  // Every choice maps in all three languages: the catalogue's words in Chinese, the server's in English.
  for (const [id, label, key] of SERVER_CHOICES) {
    expect(translator('zh-Hans').choice(id, label)).toBe(ZH[key]);
    expect(translator('zh-Hant').choice(id, label)).toBe(ZH_HANT[key]);
    expect(translator('en').choice(id, label)).toBe(label);
  }
  const zh = translator('zh-Hans');
  expect(zh.choice('ok', 'Got it')).toBe('知道了');
  expect(translator('zh-Hant').choice('later', 'Not now')).toBe('以後再說');
  expect(zh.choice('ok', 'Sure')).toBe('Sure');
  expect(zh.choice('maybe', 'Got it')).toBe('Got it');
  expect(translator('en').choice('reject', "Don't do it")).toBe("Don't do it");
});

test.each(LANGUAGES)('quota errors use the phone language (%s)', (lang) => {
  const quota = {
    scope: 'day' as const,
    usedUsd: 5,
    limitUsd: 5,
    resetsAt: Date.UTC(2099, 9, 24),
    nextStep: 'wait' as const,
  };
  expect(translator(lang).tx(errorText(new ApiError(402, 'budget_exceeded', { quota })))).toBe(
    quotaText(quota, lang),
  );
  const service = {
    scope: 'service' as const,
    resetsAt: quota.resetsAt,
    nextStep: 'wait' as const,
  };
  expect(
    translator(lang).tx(errorText(new ApiError(402, 'budget_exceeded', { quota: service }))),
  ).toBe(quotaText(service, lang));
});
