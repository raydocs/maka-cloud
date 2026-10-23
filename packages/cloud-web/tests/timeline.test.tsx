import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { CloudClient, type TaskView, type TimelineStep } from '@maka-cloud/client';
import { TaskPage } from '../src/TaskPage';
import { LanguageProvider } from '../src/i18n';

afterEach(cleanup);
test.each(['en', 'zh-Hans', 'zh-Hant'] as const)('timeline distinguishes interrupted, failed and done in %s', async (language) => {
  const client = new CloudClient('test');
  vi.spyOn(client, 'listArtifacts').mockResolvedValue({ artifacts: [], total: 0 });
  vi.spyOn(client, 'listInbox').mockResolvedValue([]);
  vi.spyOn(client, 'listSources').mockResolvedValue({ sources: [], total: 0 });
  vi.spyOn(client, 'timeline').mockResolvedValue({ timeline: {
    taskId: 't', state: 'failed', createdAt: 0, runMs: 25, turns: [], turnsTotal: 0,
    stepsTotal: 3, cost: [], costReports: 0, messages: { sent: 0, read: 0, unseen: 0, withdrawn: 0 }, content: false,
    steps: ['done', 'failed', 'interrupted'].map((state, i) => ({
      stepId: String(i), kind: 'shell', state, replay: 'never', epoch: 1, attempts: 1, startedAt: 0, durationMs: 25,
    })) as TimelineStep[],
  } });
  render(<LanguageProvider language={language}><TaskPage client={client} task={{
    taskId: 't', state: 'failed', createdAt: 0, progress: [], cancelRequested: false, pauseRequested: false,
  } as TaskView} onBack={() => {}} /></LanguageProvider>);
  await waitFor(() => expect(document.querySelectorAll('[data-state]')).toHaveLength(3));
  const interrupted = document.querySelector('[data-state="interrupted"]')!;
  expect(interrupted.textContent).toContain({
    en: 'May or may not have happened — check before redoing it',
    'zh-Hans': '可能已执行，也可能未执行——重试前请先检查',
    'zh-Hant': '可能已執行，也可能未執行——重試前請先檢查',
  }[language]);
  expect(interrupted.textContent).toContain('25');
  expect(document.querySelector('[data-state="done"]')?.textContent).not.toEqual(interrupted.textContent);
});
