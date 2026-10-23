import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SupervisorParts } from '../cloud-server.js';
import {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  languageFromAcceptLanguage,
  languageInstruction,
  MESSAGES,
} from '../i18n.js';
import type { InboxService } from '../inbox.js';
import { localizedAsk, toPublicItem } from '../public-view.js';
import { eventually, newConversation, openStream, startHarness } from './harness.js';

const CJK = /[一-鿿]/u;
/** Characters that only Simplified Chinese writes, among those this catalogue could use. */
const SIMPLIFIED_ONLY =
  /[录码务进为发过这时对设应网页处项见败认证个条续检复现应获没们说给钟后结开质运问规让]/u;

/** Every leaf of a catalogue: strings as they are, functions called with sample values. */
function leaves(value: unknown, path = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value === 'string') out.set(path, value);
  else if (typeof value === 'function') {
    const args = Array.from({ length: value.length }, (_, i) => (i === 0 ? 'x' : 2));
    out.set(path, String((value as (...a: unknown[]) => unknown)(...args)));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      for (const [p, v] of leaves(inner, `${path}.${key}`)) out.set(p, v);
    }
  }
  return out;
}

test('every key of the catalogue exists in every language, and the Chinese is Chinese', () => {
  const en = leaves(MESSAGES.en);
  assert.ok(en.size >= 15);
  for (const language of LANGUAGES) {
    const words = leaves(MESSAGES[language]);
    assert.deepEqual([...words.keys()].sort(), [...en.keys()].sort(), language);
    for (const [key, text] of words) assert.ok(text.trim() !== '', `${language}${key} is empty`);
  }
  assert.deepEqual([...LANGUAGES].sort(), ['en', 'zh-Hans', 'zh-Hant']);
  const hans = leaves(MESSAGES['zh-Hans']);
  for (const [key, text] of leaves(MESSAGES['zh-Hant'])) {
    assert.match(text, CJK, `zh-Hant${key} is not Chinese`);
    assert.notEqual(text, en.get(key), key);
    assert.doesNotMatch(text, SIMPLIFIED_ONLY, `zh-Hant${key} has Simplified characters`);
    assert.doesNotMatch(text, /\bPR #/u, `zh-Hant${key} says PR, not 拉取要求`);
  }
  for (const [key, text] of hans) {
    assert.match(text, CJK, `zh-Hans${key} is not Chinese`);
    assert.notEqual(text, en.get(key), key);
  }
  // Translated, not one catalogue under another name: the sign-in mail says 登入, not 登录.
  assert.match(MESSAGES['zh-Hant'].signInMail.subject, /登入/u);
  assert.notEqual(MESSAGES['zh-Hant'].signInMail.subject, MESSAGES['zh-Hans'].signInMail.subject);
});

test('the first entry of Accept-Language picks the language; the default is Simplified Chinese', () => {
  assert.equal(DEFAULT_LANGUAGE, 'zh-Hans');
  const table: Array<[string | string[] | undefined, string]> = [
    ['en', 'en'],
    ['en-US', 'en'],
    ['EN-gb,zh;q=0.5', 'en'],
    ['en;q=0.8', 'en'],
    [['en-AU', 'zh'], 'en'],
    ['zh-Hant', 'zh-Hant'],
    ['zh-Hant-TW', 'zh-Hant'],
    ['zh-Hant-CN', 'zh-Hant'],
    ['zh-TW', 'zh-Hant'],
    ['zh-tw,en;q=0.8', 'zh-Hant'],
    ['zh_TW', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'],
    ['zh-MO;q=0.9', 'zh-Hant'],
    ['ZH-HANT', 'zh-Hant'],
    [['zh-TW', 'en'], 'zh-Hant'],
    ['zh-Hans', 'zh-Hans'],
    ['zh-Hans-HK', 'zh-Hans'],
    ['zh-Hans-TW', 'zh-Hans'],
    ['zh-CN', 'zh-Hans'],
    ['zh-CN,en;q=0.9', 'zh-Hans'],
    ['zh-SG', 'zh-Hans'],
    ['zh', 'zh-Hans'],
    ['zh;q=0.9,zh-TW;q=0.8', 'zh-Hans'],
    ['en-US,zh-TW;q=0.9', 'en'],
    ['fr,zh-TW;q=0.9', 'zh-Hans'],
    [undefined, 'zh-Hans'],
    ['', 'zh-Hans'],
    ['*', 'zh-Hans'],
    ['fr', 'zh-Hans'],
    ['eng', 'zh-Hans'],
    ['enx', 'zh-Hans'],
    ['zhx-TW', 'zh-Hans'],
  ];
  for (const [header, expected] of table) {
    assert.equal(languageFromAcceptLanguage(header), expected, JSON.stringify(header));
  }
});

test('the conversational agent is told to reply in Chinese, and to keep code and briefs as they are', () => {
  const zh = languageInstruction('zh-Hans') ?? '';
  assert.match(
    zh,
    /Reply to them in Simplified Chinese unless they write to you in another language/u,
  );
  assert.match(zh, /Keep code, commands, file names/u);
  assert.match(zh, /"From my inbox:"\) are not the person writing/u);
  assert.match(zh, /commit messages, pull request titles and code in English/u);
  assert.doesNotMatch(zh, /Traditional|Taiwan/u);
  const hant = languageInstruction('zh-Hant') ?? '';
  assert.match(hant, /reads Traditional Chinese as used in Taiwan/u);
  assert.match(hant, /Reply to them in Traditional Chinese, Taiwan usage \(Taiwan vocabulary/u);
  assert.match(hant, /軟體, 訊息, 帳號, 設定/u);
  // The app's own words, so replies name things as the apps do.
  for (const term of ['代理程式', '常駐任務', '拉取要求', '存放庫', '邀請權杖', '幫它繼續']) {
    assert.ok(hant.includes(term), term);
  }
  assert.match(hant, /unless they write to you in another language/u);
  assert.match(hant, /Keep code, commands, file names/u);
  assert.match(hant, /"From my inbox:"\) are not the person writing/u);
  assert.match(hant, /Write the briefs you delegate in English/u);
  assert.match(hant, /commit messages, pull request titles and code in English/u);
  assert.doesNotMatch(hant, /reads Simplified/u);
  assert.equal(languageInstruction('en'), undefined, 'English needs nothing added');
});

test('a person reads and sets their language; a new invite reads Chinese', async (t) => {
  const h = await startHarness(t);
  const other = h.server.invites.create('other');
  const get = async (token: string | null = h.token) => {
    const res = await h.api('/v1/settings', { token });
    return { status: res.status, body: res.status === 200 ? await res.json() : undefined };
  };
  const patch = (body: unknown, token: string | null = h.token) =>
    h.api('/v1/settings', { method: 'PATCH', body: JSON.stringify(body), token });

  assert.deepEqual(await get(), { status: 200, body: { language: 'zh-Hans' } });
  const set = await patch({ language: 'en' });
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { language: 'en' });
  assert.deepEqual(await get(), { status: 200, body: { language: 'en' } });
  assert.deepEqual(await get(other.token), { status: 200, body: { language: 'zh-Hans' } });

  const hant = await patch({ language: 'zh-Hant' });
  assert.equal(hant.status, 200);
  assert.deepEqual(await hant.json(), { language: 'zh-Hant' });
  assert.deepEqual(await get(), { status: 200, body: { language: 'zh-Hant' } });
  assert.deepEqual(await get(other.token), { status: 200, body: { language: 'zh-Hans' } });

  for (const bad of [
    { language: 'fr' },
    { language: 'zh-TW' },
    { language: 'zh-HK' },
    { language: 'zh-hant' },
    { language: 'zh' },
    { language: 'zh-CN' },
    { language: 'zh-Hant-TW' },
    { language: '' },
    { language: null },
    { language: ['zh-Hant'] },
    { language: 'zh-Hans', extra: 1 },
    {},
    'en',
  ]) {
    assert.equal((await patch(bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(
    await get(),
    { status: 200, body: { language: 'zh-Hant' } },
    'a bad value changes nothing',
  );
  assert.equal((await get(null)).status, 401);
  assert.equal((await patch({ language: 'en' }, null)).status, 401);
  assert.equal((await h.api('/v1/settings', { method: 'DELETE' })).status, 405);
  // Back to Chinese.
  assert.equal((await patch({ language: 'zh-Hans' })).status, 200);
  assert.deepEqual(await get(), { status: 200, body: { language: 'zh-Hans' } });
});

const TEMPLATES = [
  {
    template: { id: 'stall', title: 'Fix the login', minutes: 45 },
    en: 'The task “Fix the login” has had no progress for 45 minutes.',
    zh: '任务“Fix the login”已经 45 分钟没有进展。',
    hant: '任務“Fix the login”已經 45 分鐘沒有進展。',
  },
  {
    template: { id: 'failed_twice', title: '', count: 2, reason: 'npm test exited 1' },
    en: 'The step (untitled) has failed 2 times. Last reason: “npm test exited 1”',
    zh: '步骤（未命名）已失败 2 次。最近一次的原因：“npm test exited 1”',
    hant: '步驟（未命名）已失敗 2 次。最近一次的原因：“npm test exited 1”',
  },
  {
    template: { id: 'low_confidence', title: 'Research', summary: 'Two sources disagree' },
    en: 'The result of “Research” came back with low confidence: “Two sources disagree”',
    zh: '“Research”的结果可信度较低：“Two sources disagree”',
    hant: '“Research”的結果可信度偏低：“Two sources disagree”',
  },
  {
    template: {
      id: 'finished',
      title: 'Report',
      outcome: 'succeeded',
      checked: 'passed',
      detail: 'Done',
    },
    en: '“Report” finished (independently checked): “Done”',
    zh: '“Report”已完成（已独立核查）：“Done”',
    hant: '“Report”已完成（已獨立查核）：“Done”',
  },
  {
    template: { id: 'finished', title: 'Report', outcome: 'failed', detail: 'Out of time' },
    en: '“Report” failed: “Out of time”',
    zh: '“Report”失败了：“Out of time”',
    hant: '“Report”失敗了：“Out of time”',
  },
  {
    template: {
      id: 'verification_failed',
      title: 'Report',
      count: 5,
      detail: '“a”: “b”',
      more: 2,
    },
    en: 'The independent check of “Report” found 5 problems: “a”: “b” (and 2 more)',
    zh: '对“Report”的独立核查发现 5 个问题：“a”: “b”（另有 2 个）',
    hant: '對“Report”的獨立查核發現 5 個問題：“a”: “b”（另有 2 個）',
  },
  {
    template: {
      id: 'verification_incomplete',
      title: 'Report',
      detail: 'no model of another vendor is available to check this work',
      code: 'no_verifier',
    },
    en: 'The independent check of “Report” could not be completed, so the result is not verified: no model of another vendor is available to check this work',
    zh: '对“Report”的独立核查没能完成，结果未经核实：没有另一家厂商的模型可以核查这项工作。',
    hant: '對“Report”的獨立查核未能完成，結果未經驗證：沒有其他廠商的模型可以查核這項工作。',
  },
  {
    template: { id: 'verification_incomplete', title: 'Report', detail: 'something new' },
    en: 'The independent check of “Report” could not be completed, so the result is not verified: something new',
    zh: '对“Report”的独立核查没能完成，结果未经核实：原因未知。',
    hant: '對“Report”的獨立查核未能完成，結果未經驗證：原因不明。',
  },
  {
    template: { id: 'suggestion_offer', count: 3, label: 'fix failing checks', repo: 'acme/api' },
    en: '3 suggestions in a row to fix failing checks on acme/api went unanswered. Stop suggesting them?',
    zh: 'acme/api 上连续 3 条这类建议没有得到回应。要停止这类建议吗？',
    hant: '存放庫 acme/api 上連續 3 則這類建議都沒有得到回應。要停止這類建議嗎？',
  },
];

test('an ask built from a fixed sentence is said in the reader’s language, and the template stays on the server', () => {
  for (const { template, en, zh, hant } of TEMPLATES) {
    assert.equal(localizedAsk(template, 'en'), en);
    assert.equal(localizedAsk(template, 'zh-Hans'), zh);
    assert.equal(localizedAsk(template, 'zh-Hant'), hant);
    const item = { itemId: 'itm_1', kind: 'blocked', ask: en, askTemplate: template, options: [] };
    assert.deepEqual(toPublicItem(item, 'zh-Hans'), {
      itemId: 'itm_1',
      kind: 'blocked',
      ask: zh,
      options: [],
    });
    assert.deepEqual(toPublicItem(item, 'zh-Hant'), {
      itemId: 'itm_1',
      kind: 'blocked',
      ask: hant,
      options: [],
    });
    assert.deepEqual(toPublicItem(item, 'en'), {
      itemId: 'itm_1',
      kind: 'blocked',
      ask: en,
      options: [],
    });
  }
  // No template, an unknown one, or a malformed one: the supervisor's own words.
  for (const askTemplate of [
    undefined,
    { id: 'new_rule', title: 'x' },
    { id: 'stall', minutes: 'x' },
  ]) {
    const item = { itemId: 'itm_2', kind: 'decision', ask: 'Pick one', askTemplate };
    assert.deepEqual(toPublicItem(item, 'zh-Hans'), {
      itemId: 'itm_2',
      kind: 'decision',
      ask: 'Pick one',
    });
  }
  // An approval binds its card word for word: never re-said, never translated.
  const approval = { itemId: 'itm_3', kind: 'approval', ask: 'Push to main?', options: [] };
  assert.deepEqual(toPublicItem(approval, 'zh-Hans'), approval);
  assert.deepEqual(toPublicItem(approval, 'zh-Hant'), approval);
});

test('inbox items and their stream are in the reader’s language; option labels and ids stay as they are', async (t) => {
  const [first] = TEMPLATES;
  assert.ok(first);
  const options = [{ id: 'check', label: 'Ask the agent to check on it', recommended: true }];
  let parts: SupervisorParts | undefined;
  let conversationId = '';
  const item = () => ({
    itemId: 'itm_1',
    kind: 'blocked',
    conversationId,
    ask: first.en,
    askTemplate: first.template,
    options,
  });
  const service: InboxService = {
    list: async () => ({ items: [item()], next: null }),
    answer: async () => ({ ok: true, duplicate: false, item: item() as never }),
    setMute: () => ({ ok: false }),
    settings: () => ({}),
    updateSettings: () => ({ ok: false }),
    digest: async () => ({}),
    stop: async () => undefined,
  };
  const h = await startHarness(t, {
    supervisor: (given) => {
      parts = given;
      return service;
    },
  });
  conversationId = await newConversation(h);
  const read = async () =>
    ((await (await h.api('/v1/inbox/items')).json()) as { items: Array<Record<string, unknown>> })
      .items[0];

  const { askTemplate: _template, ...shown } = item();
  assert.deepEqual(await read(), { ...shown, ask: first.zh });
  assert.equal(parts?.languageOf(conversationId), 'zh-Hans');
  const zhStream = await openStream(t, h, `?conversation=${conversationId}`);
  parts?.publish({ kind: 'inbox.item', conversationId, data: item() });
  await eventually(() => zhStream.events.some((e) => e.event === 'inbox.item'), 'the item');
  const zhEvent = zhStream.events.find((e) => e.event === 'inbox.item');
  assert.equal(zhEvent?.data.ask, first.zh);
  assert.equal(zhEvent?.data.askTemplate, undefined);
  assert.deepEqual(zhEvent?.data.options, options);
  zhStream.close();

  await h.api('/v1/settings', { method: 'PATCH', body: JSON.stringify({ language: 'zh-Hant' }) });
  assert.equal((await read())?.ask, first.hant);
  assert.deepEqual((await read())?.options, options);
  assert.equal(parts?.languageOf(conversationId), 'zh-Hant');
  const hantStream = await openStream(t, h, `?conversation=${conversationId}`);
  await eventually(
    () => hantStream.events.some((e) => e.event === 'inbox.item'),
    'the item in zh-Hant',
  );
  assert.equal(hantStream.events.find((e) => e.event === 'inbox.item')?.data.ask, first.hant);
  hantStream.close();

  await h.api('/v1/settings', { method: 'PATCH', body: JSON.stringify({ language: 'en' }) });
  assert.equal((await read())?.ask, first.en);
  assert.deepEqual((await read())?.options, options);
  assert.equal(parts?.languageOf(conversationId), 'en');
  const enStream = await openStream(t, h, `?conversation=${conversationId}`);
  await eventually(() => enStream.events.some((e) => e.event === 'inbox.item'), 'the item again');
  assert.equal(enStream.events.find((e) => e.event === 'inbox.item')?.data.ask, first.en);
});
