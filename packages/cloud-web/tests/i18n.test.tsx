import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CloudClient } from '@maka-cloud/client';
import { ConversationView, QuestionCard, Settings } from '../src/App';
import { Home } from '../src/Home';
import { FailureNote } from '../src/Failure';
import { LANGUAGE_KEY, LanguageProvider, languageFor, translator, useT } from '../src/i18n';
import { en, serverChoices, zhHans, zhHant } from '../src/strings';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('all three catalogues contain every key and preserve interpolation parameters', () => {
  for (const catalogue of [zhHans, zhHant]) {
    expect(Object.keys(catalogue).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(catalogue[key], key).not.toBe('');
      expect((catalogue[key].match(/\{\w+\}/gu) ?? []).sort(), key).toEqual(
        (en[key].match(/\{\w+\}/gu) ?? []).sort(),
      );
    }
  }
});

test.each([
  [[], 'zh-Hans'],
  [['zh-TW', 'en-US'], 'zh-Hant'],
  [['zh-HK'], 'zh-Hant'],
  [['zh-MO'], 'zh-Hant'],
  [['zh-Hant'], 'zh-Hant'],
  [['zh-Hant-HK'], 'zh-Hant'],
  [['zh-Hans'], 'zh-Hans'],
  [['zh-CN'], 'zh-Hans'],
  [['zh-SG'], 'zh-Hans'],
  [['zh'], 'zh-Hans'],
  [['fr', 'en'], 'zh-Hans'],
  [['EN-gb', 'zh-CN'], 'en'],
  [['en'], 'en'],
])('first preferred languages %j resolve to %s', (tags, expected) => {
  expect(languageFor(tags)).toBe(expected);
});

test('fixed choices require both the id and the exact original English label', () => {
  const { choiceLabel } = translator('zh-Hans');
  for (const [id, label, key] of serverChoices) {
    expect(choiceLabel(id, label)).toBe(zhHans[key]);
    expect(choiceLabel(`custom-${id}`, label)).toBe(label);
    expect(choiceLabel(id, `${label}!`)).toBe(`${label}!`);
  }
  expect(choiceLabel('approve', 'Ｇo ahead')).toBe('Go ahead');
  expect(choiceLabel('approve', 'Go ahead\u200b')).toBe('Go ahead');
  expect(choiceLabel('custom', 'Ask Codex')).toBe('Ask assistant');
  expect(translator('en').choiceLabel('approve', 'Go ahead')).toBe('Go ahead');
});

const client = () =>
  new CloudClient('fake', async (input, init) => {
    const path = String(input);
    if (path.startsWith('/v1/events')) {
      return new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (path.includes('/tasks?')) return Response.json({ tasks: [] });
    if (path === '/v1/projects') return Response.json({ projects: [] });
    if (path.startsWith('/v1/inbox/items')) return Response.json({ items: [] });
    if (path === '/v1/grants') return Response.json({ grants: [] });
    return Response.json({});
  });

test('Home renders Chinese copy, accessible labels and the composer', async () => {
  render(
    <LanguageProvider language="zh-Hans">
      <Home client={client()} conversations={[]} onOpen={() => {}} onStarted={() => {}} />
    </LanguageProvider>,
  );
  expect(screen.getByRole('heading', { name: '给下一个想法留个位置。' })).toBeTruthy();
  expect(screen.getByPlaceholderText('想完成什么？')).toBeTruthy();
  expect(screen.getByRole('button', { name: '开始' })).toBeTruthy();
  expect(screen.getByText('用一句话告诉 Maka 你想完成什么，剩下的交给它。')).toBeTruthy();
  await screen.findByText('没有需要你处理的事。');
  expect(document.documentElement.lang).toBe('zh-Hans');
});

test('Chat renders Chinese while preserving server titles, question text and custom choices', async () => {
  const { rerender } = render(
    <LanguageProvider language="zh-Hans">
      <ConversationView
        client={client()}
        conversation={{ conversationId: 'c1', title: 'Home', createdAt: 1 }}
      />
    </LanguageProvider>,
  );
  expect(screen.getByRole('heading', { name: 'Home' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: '想完成什么？' })).toBeTruthy();
  expect(screen.getByPlaceholderText('接下来想做什么？')).toBeTruthy();
  expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
  expect(screen.getByRole('log', { name: '消息' })).toBeTruthy();
  await waitFor(() =>
    expect(
      screen.getByText('带来一个问题、一个项目或一个计划，Maka 会把工作都留在这里。'),
    ).toBeTruthy(),
  );
  rerender(
    <LanguageProvider language="zh-Hans">
      <QuestionCard
        question={{
          questionId: 'q1',
          recommended: 'approve',
          reason: 'irreversible',
          question: 'Go ahead',
          options: [
            { id: 'approve', label: 'Go ahead' },
            { id: 'custom', label: 'Go ahead' },
          ],
        }}
        disabled={false}
        onAnswer={() => {}}
      />
    </LanguageProvider>,
  );
  expect(screen.getByRole('heading', { name: 'Go ahead' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '可以执行' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Go ahead' })).toBeTruthy();
});

function CurrentLanguage() {
  const { language } = useT();
  return <output>{language}</output>;
}

test('Settings switches immediately, persists the choice, follows browser changes and sets html lang', async () => {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR', 'en-US']);
  const api = client();
  const view = render(
    <LanguageProvider>
      <Settings client={api} onDisconnect={() => {}} />
      <CurrentLanguage />
    </LanguageProvider>,
  );
  expect(screen.getByRole('heading', { name: '我的' })).toBeTruthy();
  expect(screen.getByText('语言', { exact: true })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '繁體中文' }));
  expect(screen.getByText('語言', { exact: true })).toBeTruthy();
  expect(screen.queryByText('语言', { exact: true })).toBeNull();
  expect(screen.getByRole('heading', { name: '我的' })).toBeTruthy();
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('zh-Hant');
  expect(document.documentElement.lang).toBe('zh-Hant');
  view.unmount();
  const traditional = render(
    <LanguageProvider>
      <Settings client={api} onDisconnect={() => {}} />
    </LanguageProvider>,
  );
  expect(screen.getByRole('heading', { name: '我的' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  expect(screen.getByRole('heading', { name: 'Me' })).toBeTruthy();
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en');
  expect(document.documentElement.lang).toBe('en');
  expect(document.title).toBe('Maka — your work, together');
  traditional.unmount();
  render(
    <LanguageProvider>
      <Settings client={api} onDisconnect={() => {}} />
      <CurrentLanguage />
    </LanguageProvider>,
  );
  expect(screen.getByRole('heading', { name: 'Me' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '简体中文' }));
  expect(screen.getByRole('heading', { name: '我的' })).toBeTruthy();
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('zh-Hans');
  fireEvent.click(
    within(screen.getByRole('group', { name: '语言' })).getByRole('button', { name: '跟随系统' }),
  );
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('system');
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-SG']);
  fireEvent(window, new Event('languagechange'));
  expect(screen.getByRole('heading', { name: 'Me' })).toBeTruthy();
});

test('blocked storage and invalid saved preferences safely follow the browser', () => {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue([]);
  localStorage.setItem(LANGUAGE_KEY, 'invalid');
  const view = render(
    <LanguageProvider>
      <CurrentLanguage />
    </LanguageProvider>,
  );
  expect(screen.getByText('zh-Hans')).toBeTruthy();
  view.unmount();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  render(
    <LanguageProvider>
      <Settings client={client()} onDisconnect={() => {}} />
      <CurrentLanguage />
    </LanguageProvider>,
  );
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  expect(screen.getByText('en')).toBeTruthy();
});

test('generated failure copy is Chinese but server prose and raw details remain as sent', () => {
  const { rerender } = render(
    <LanguageProvider language="zh-Hans">
      <FailureNote reason="runner error: connection reset" />
    </LanguageProvider>,
  );
  expect(screen.getByText('Maka 使用的电脑意外停止了。')).toBeTruthy();
  expect(screen.getByText('runner error: connection reset')).toBeTruthy();
  rerender(
    <LanguageProvider language="zh-Hans">
      <FailureNote reason="This task did not finish." />
    </LanguageProvider>,
  );
  expect(screen.getByText('This task did not finish.')).toBeTruthy();
  rerender(
    <LanguageProvider language="zh-Hans">
      <FailureNote reason="needs you: this task stopped; Decide whether to start it again." />
    </LanguageProvider>,
  );
  expect(screen.getByText('Decide whether to start it again.')).toBeTruthy();
});

test('the language is sent again when a replacement worker takes control', async () => {
  localStorage.setItem(LANGUAGE_KEY, 'zh-Hans');
  const oldWorker = { postMessage: vi.fn() };
  const newWorker = { postMessage: vi.fn() };
  const registration = { active: oldWorker };
  const workers = Object.assign(new EventTarget(), {
    getRegistration: vi.fn(async () => registration),
  });
  const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: workers });
  try {
    const view = render(
      <LanguageProvider>
        <span>Workspace</span>
      </LanguageProvider>,
    );
    await waitFor(() =>
      expect(oldWorker.postMessage).toHaveBeenCalledWith({
        type: 'maka.language',
        language: 'zh-Hans',
      }),
    );
    registration.active = newWorker;
    workers.dispatchEvent(new Event('controllerchange'));
    await waitFor(() =>
      expect(newWorker.postMessage).toHaveBeenCalledWith({
        type: 'maka.language',
        language: 'zh-Hans',
      }),
    );
    view.unmount();
    newWorker.postMessage.mockClear();
    workers.dispatchEvent(new Event('controllerchange'));
    await Promise.resolve();
    expect(newWorker.postMessage).not.toHaveBeenCalled();
  } finally {
    if (original) Object.defineProperty(navigator, 'serviceWorker', original);
    else Reflect.deleteProperty(navigator, 'serviceWorker');
  }
});

test('Chinese catalogues use full-width punctuation after Chinese words', () => {
  for (const catalogue of [zhHans, zhHant]) {
    for (const value of Object.values(catalogue))
      expect(value).not.toMatch(/[\p{Script=Han}][,:?()]/u);
  }
});
