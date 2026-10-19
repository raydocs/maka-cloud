import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ConversationView, QuestionCard } from '../src/App';
import { CloudClient } from '../src/client';
import { conversation, question, seedEvents } from '../mock/fixtures';
import type { FeedEvent } from '../src/contract';

afterEach(cleanup);

test('recommendation is first; keyboard can select a different answer and submit context', () => {
  const answers: unknown[] = [];
  render(
    <QuestionCard
      question={question}
      available
      disabled={false}
      onAnswer={(optionId, text) => answers.push({ optionId, text })}
    />,
  );
  const options = screen.getAllByRole('option');
  expect(options[0].textContent).toContain('A quieter launch');
  expect(options[0].textContent).toContain('Recommended');
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' });
  fireEvent.change(screen.getByLabelText('Additional context (optional)'), {
    target: { value: 'Keep it short' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  expect(answers).toEqual([{ optionId: 'bold', text: 'Keep it short' }]);
});

function viewFetcher(events: FeedEvent[], status = 200): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes('/tasks?')) return Response.json({ tasks: [] });
    if (path.startsWith('/v1/events')) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                events
                  .map((e) => `id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e.data)}\n\n`)
                  .join(''),
              ),
            );
            init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    return Response.json({ error: 'OpenAI Claude GPT Anthropic Codex' }, { status });
  }) as typeof fetch;
}

for (const status of [404, 405]) {
  test(`${status}: unsupported cancel and answers disappear without a false success`, async () => {
    const client = new CloudClient('fake', viewFetcher(seedEvents(), status));
    render(
      <ConversationView client={client} conversation={conversation} onDisconnect={() => {}} />,
    );
    await screen.findByRole('button', { name: 'Send answer' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel task' })[0]);
    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: 'Cancel task' })).toHaveLength(0),
    );
    expect(screen.getAllByText('In progress')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await screen.findByText('Answers are not supported by this server yet.');
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull();
    expect(screen.queryByText(/Answer recorded/)).toBeNull();
    expect(screen.getByRole('alert').textContent).not.toMatch(/Claude|Codex|GPT|OpenAI|Anthropic/i);
  });
}

test('all server content is presentation-filtered; absent costs never become zero', async () => {
  const events = seedEvents().filter((e) => e.kind !== 'task.cost');
  events.push({
    id: 100,
    kind: 'conductor.notice',
    data: { conversationId: 'cnv_demo', text: 'Claude, Codex, GPT, Anthropic, OpenAI' },
  });
  const client = new CloudClient('fake', viewFetcher(events));
  render(
    <ConversationView
      client={client}
      conversation={{ ...conversation, title: 'Claude launch with GPT' }}
      onDisconnect={() => {}}
    />,
  );
  await screen.findByText('assistant, assistant, assistant, assistant, assistant');
  expect(document.body.textContent).not.toMatch(/Claude|Codex|GPT|OpenAI|Anthropic/i);
  expect(screen.getAllByText(/Not reported/).length).toBeGreaterThan(1);
  expect(screen.queryByText('$0.00')).toBeNull();
  const tree = screen.getByRole('region', { name: 'Task tree' });
  expect(within(tree).getAllByRole('article')).toHaveLength(3);
  expect(within(tree).getByText('Checking the introduction at smaller screen sizes.')).toBeTruthy();
});
