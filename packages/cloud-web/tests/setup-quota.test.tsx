import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { CloudClient, quotaText, type Language, type QuotaReason } from '@maka-cloud/client';
import { SetupCards } from '../src/SetupCards';
import { QuotaNotice, Usage } from '../src/Quota';
import { LanguageProvider, translator } from '../src/i18n';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const quota: QuotaReason = {
  scope: 'day',
  usedUsd: 5,
  limitUsd: 5,
  resetsAt: Date.UTC(2026, 9, 24),
  nextStep: 'wait',
};

test.each(['zh-Hans', 'zh-Hant', 'en'] as Language[])(
  'setup cards follow server order, navigate and disappear on Later (%s)',
  async (language) => {
    let dismissed = false;
    const reports: unknown[] = [];
    const client = new CloudClient('test', (async (_url, init) => {
      if (init?.body) {
        const report = JSON.parse(String(init.body));
        reports.push(report);
        if (report.dismiss) dismissed = true;
      }
      return Response.json({
        readiness: {
          completed: ['language', 'model'],
          cards: dismissed ? [] : [{ id: 'project', action: 'projects' }],
        },
      });
    }) as typeof fetch);
    const actions: string[] = [];
    const { t } = translator(language);
    render(
      <LanguageProvider language={language}>
        <SetupCards client={client} version={1} onAction={(action) => actions.push(action)} />
      </LanguageProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: t('Connect a project') }));
    expect(actions).toEqual(['projects']);
    fireEvent.click(screen.getByRole('button', { name: t('Later') }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: t('Connect a project') })).toBeNull(),
    );
    expect(reports).toContainEqual({ dismiss: 'project' });
  },
);

test.each(['zh-Hans', 'zh-Hant', 'en'] as Language[])(
  'quota refusal and Me usage show actual amounts and reset (%s)',
  async (language) => {
    const client = new CloudClient('test', (async () =>
      Response.json({ limits: [quota], refusal: quota })) as typeof fetch);
    render(
      <LanguageProvider language={language}>
        <QuotaNotice quota={quota} />
        <Usage client={client} />
      </LanguageProvider>,
    );
    await waitFor(() => expect(screen.getAllByText(quotaText(quota, language))).toHaveLength(2));
    expect(screen.getByRole('region', { name: translator(language).t('Usage') })).toBeTruthy();
  },
);

test('an older server hides unsupported setup and usage', async () => {
  const client = new CloudClient('test', (async () =>
    Response.json({ error: 'not_found' }, { status: 404 })) as typeof fetch);
  const { container } = render(
    <>
      <SetupCards client={client} version={1} onAction={() => {}} />
      <Usage client={client} />
    </>,
  );
  await waitFor(() => expect(container.textContent).toBe(''));
});

test.each(['zh-Hans', 'zh-Hant', 'en'] as Language[])(
  'the composer presents a typed budget refusal in the selected language (%s)',
  async (language) => {
    const client = new CloudClient('test', (async (url, init) => {
      const path = String(url);
      if (path.startsWith('/v1/events'))
        return new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      if (path.includes('/tasks?')) return Response.json({ tasks: [] });
      if (path.endsWith('/messages') && init?.method === 'POST')
        return Response.json({ error: 'budget_exceeded', quota }, { status: 402 });
      return Response.json({});
    }) as typeof fetch);
    const { ConversationView } = await import('../src/App');
    const { t } = translator(language);
    render(
      <LanguageProvider language={language}>
        <ConversationView
          client={client}
          conversation={{ conversationId: 'quota-composer', title: 'Test', createdAt: 0 }}
        />
      </LanguageProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText(t('What would you like to do next?')), {
      target: { value: 'hello' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('Send message') }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(quotaText(quota, language)),
    );
  },
);

test('only granted devices upgrade notification readiness; unsupported browsers hide the card', async () => {
  const reports: unknown[] = [];
  const client = new CloudClient('test', (async (_url, init) => {
    if (init?.body) reports.push(JSON.parse(String(init.body)));
    return Response.json({
      readiness: { completed: [], cards: [{ id: 'notifications', action: 'me' }] },
    });
  }) as typeof fetch);
  vi.stubGlobal('Notification', { permission: 'default' });
  vi.stubGlobal('PushManager', class {});
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} });
  const { rerender } = render(<SetupCards client={client} version={1} onAction={() => {}} />);
  await screen.findByRole('button', { name: 'Enable notifications' });
  expect(reports).toEqual([]);
  vi.stubGlobal('Notification', { permission: 'granted' });
  rerender(<SetupCards client={client} version={2} onAction={() => {}} />);
  await waitFor(() => expect(reports).toEqual([{ notificationsAllowed: true }]));
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  rerender(<SetupCards client={client} version={3} onAction={() => {}} />);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull(),
  );
});
