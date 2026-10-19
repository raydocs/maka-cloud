import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  Artifact,
  Capabilities,
  Events,
  FeedEvent,
  PushRegistration,
  TaskView,
} from '../src/contract';
import { applyEvent, emptyState } from '../src/state';
import { artifactFixtures, conversation, manifest, seedEvents } from './fixtures';

/** Local-only fake of every route. Installed exclusively by CLOUD_WEB_MOCK=1. */
export function mockMiddleware() {
  let events = seedEvents();
  let conversations = [conversation];
  let subscriptions: PushRegistration[] = [];
  const requests: { method: string; path: string; body: unknown; lastEventId?: string }[] = [];
  const clients = new Map<ServerResponse, string | null>();
  const messages = new Map<string, string>();
  let overrides: Record<string, number> = {};
  const capabilities: Capabilities = {
    taskCancel: true,
    taskPause: true,
    answers: true,
    taskCost: true,
    artifacts: true,
    push: true,
  };
  function frame(event: FeedEvent) {
    return `id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event.data)}\n\n`;
  }
  function emit<K extends keyof Events>(kind: K, data: Events[K]) {
    if (kind === 'task.event') {
      const taskData = data as Events['task.event'];
      taskData.seq = events.filter((event) => event.kind === 'task.event').length + 1;
    }
    const event = { id: (events.at(-1)?.id ?? 0) + 1, kind, data } as FeedEvent;
    events.push(event);
    for (const [client, id] of clients)
      if (!id || id === data.conversationId) client.write(frame(event));
  }
  const taskViews = (id: string): TaskView[] =>
    Object.values(
      events.filter((e) => e.data.conversationId === id).reduce(applyEvent, emptyState()).tasks,
    );
  const reply = (res: ServerResponse, status: number, value?: unknown) =>
    res
      .writeHead(status, { 'content-type': 'application/json' })
      .end(value === undefined ? undefined : JSON.stringify(value));

  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/v1/') && !path.startsWith('/__mock/')) return next();
    const method = req.method ?? 'GET';
    if (path.startsWith('/v1/') && req.headers.authorization !== 'Bearer demo-invite')
      return reply(res, 401, { error: 'unauthorized' });
    let body: Record<string, unknown> = {};
    try {
      if (method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk);
          size += buffer.length;
          if (size > 64 * 1024) return reply(res, 413, { error: 'request_too_large' });
          chunks.push(buffer);
        }
        body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body))
          return reply(res, 400, { error: 'invalid_request' });
      }
      if (path === '/__mock/reset') {
        for (const client of clients.keys()) client.end();
        clients.clear();
        events = seedEvents();
        conversations = [conversation];
        overrides = {};
        subscriptions = [];
        requests.length = 0;
        messages.clear();
        return reply(res, 200, { ok: true });
      }
      if (path === '/__mock/state') return reply(res, 200, { requests, subscriptions, events });
      if (path === '/__mock/overrides') {
        overrides = body as Record<string, number>;
        return reply(res, 200, {});
      }
      if (path === '/__mock/emit') {
        emit(body.kind as keyof Events, body.data as Events[keyof Events]);
        return reply(res, 200, {});
      }
      if (path === '/__mock/disconnect') {
        for (const client of clients.keys()) client.end();
        return reply(res, 200, {});
      }
      if (path === '/__mock/finish') {
        emit('task.event', {
          conversationId: conversation.conversationId,
          seq: events.length + 1,
          at: Date.now(),
          event: { type: 'task_succeeded', taskId: 'task_page', manifest },
        });
        return reply(res, 200, {});
      }
      requests.push({
        method,
        path: req.url ?? path,
        body,
        lastEventId: req.headers['last-event-id'] as string | undefined,
      });
      const override = overrides[`${method} ${path}`];
      if (override) return reply(res, override, { error: 'not_supported' });
      if (path === '/v1/capabilities' && method === 'GET') return reply(res, 200, capabilities);
      if (path === '/v1/conversations') {
        if (method === 'GET') return reply(res, 200, { conversations });
        if (method !== 'POST') return reply(res, 405, { error: 'method_not_allowed' });
        if (
          Object.keys(body).some((key) => key !== 'title') ||
          (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 200))
        )
          return reply(res, 400, { error: 'invalid_request' });
        const item = {
          conversationId: `cnv_${crypto.randomUUID()}`,
          title: typeof body.title === 'string' ? body.title : null,
          createdAt: Date.now(),
        };
        conversations.push(item);
        emit('conversation.created', {
          conversationId: item.conversationId,
          title: item.title,
          at: item.createdAt,
        });
        return reply(res, 201, { conversationId: item.conversationId });
      }
      if (path === '/v1/events') {
        if (method !== 'GET') return reply(res, 405, { error: 'method_not_allowed' });
        const id = url.searchParams.get('conversation');
        if (id !== null && !conversations.some((c) => c.conversationId === id))
          return reply(res, 404, { error: 'not_found' });
        const raw = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
        if (raw !== '' && !/^\d{1,15}$/.test(String(raw)))
          return reply(res, 400, { error: 'invalid_request' });
        const after = Number(raw);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': stream open\n\n');
        for (const event of events)
          if (event.id > after && (!id || event.data.conversationId === id))
            res.write(frame(event));
        clients.set(res, id);
        const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
        res.on('close', () => {
          clearInterval(heartbeat);
          clients.delete(res);
        });
        return;
      }
      const match = /^\/v1\/conversations\/([^/]+)\/(.+)$/.exec(path);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const suffix = match[2];
        if (!conversations.some((c) => c.conversationId === id))
          return reply(res, 404, { error: 'not_found' });
        if (suffix === 'messages' && method === 'POST') {
          if (
            typeof body.text !== 'string' ||
            !body.text ||
            Buffer.byteLength(body.text) > 32000 ||
            Object.keys(body).some((key) => !['text', 'clientMessageId'].includes(key)) ||
            (body.clientMessageId !== undefined &&
              (typeof body.clientMessageId !== 'string' ||
                !body.clientMessageId ||
                body.clientMessageId.length > 128))
          )
            return reply(res, 400, { error: 'invalid_request' });
          const key = `${id}:${body.clientMessageId ?? crypto.randomUUID()}`;
          let messageId = messages.get(key);
          if (!messageId) {
            messageId = `msg_${crypto.randomUUID()}`;
            messages.set(key, messageId);
            emit('message.posted', {
              conversationId: id,
              messageId,
              role: 'user',
              text: body.text,
              at: Date.now(),
            });
            emit('conductor.message', {
              conversationId: id,
              runId: 'run_demo',
              text: 'Got it. I’ll keep that in mind as we go.',
            });
          }
          return reply(res, 202, { messageId });
        }
        if (suffix === 'tasks' && method === 'GET') {
          const afterRaw = url.searchParams.get('after') || '0';
          const limitRaw = url.searchParams.get('limit') || '50';
          if (![afterRaw, limitRaw].every((value) => /^\d{1,15}$/.test(value)))
            return reply(res, 400, { error: 'invalid_request' });
          const after = Number(afterRaw);
          const limit = Math.min(Number(limitRaw), 200);
          const index = events.flatMap((event) =>
            event.kind === 'task.event' && event.data.event.type === 'task_created'
              ? [{ conversationId: event.data.conversationId, taskId: event.data.event.taskId }]
              : [],
          );
          const page = index
            .map((entry, n) => ({ ...entry, position: n + 1 }))
            .filter((entry) => entry.conversationId === id && entry.position > after)
            .slice(0, limit);
          const views = taskViews(id);
          const tasks = page.flatMap((entry) =>
            views.filter((view) => view.taskId === entry.taskId),
          );
          return reply(res, 200, {
            tasks,
            ...(page.length === limit ? { next: page.at(-1)?.position } : {}),
          });
        }
        const control = /^tasks\/([^/]+)\/(cancel|pause)$/.exec(suffix);
        if (control && method === 'POST') {
          const taskId = decodeURIComponent(control[1]);
          if (!taskViews(id).some((task) => task.taskId === taskId))
            return reply(res, 404, { error: 'not_found' });
          if (control[2] === 'pause')
            emit('task.paused', { conversationId: id, taskId, paused: body.paused === true });
          else {
            const all = taskViews(id);
            const ids = new Set([taskId]);
            for (let count = 0; count < all.length; count++)
              for (const task of all)
                if (task.parentTaskId && ids.has(task.parentTaskId)) ids.add(task.taskId);
            for (const task of all)
              if (ids.has(task.taskId) && ['running', 'queued'].includes(task.state))
                emit('task.event', {
                  conversationId: id,
                  seq: events.length + 1,
                  at: Date.now(),
                  event: { type: 'task_cancelled', taskId: task.taskId },
                });
          }
          return reply(res, 204);
        }
        if (suffix === 'answers' && method === 'POST') {
          const found = events.find(
            (event) =>
              event.kind === 'conductor.question' &&
              event.data.conversationId === id &&
              event.data.questionId === body.questionId,
          );
          if (!found || found.kind !== 'conductor.question')
            return reply(res, 404, { error: 'not_found' });
          if (!found.data.options.some((o) => o.id === body.optionId))
            return reply(res, 400, { accepted: false, reason: 'unknown_option' });
          const existing = events.find(
            (e) => e.kind === 'conductor.answered' && e.data.questionId === body.questionId,
          );
          if (
            existing &&
            existing.kind === 'conductor.answered' &&
            existing.data.optionId !== body.optionId
          )
            return reply(res, 409, { accepted: false, reason: 'conflict' });
          if (!existing)
            emit('conductor.answered', {
              conversationId: id,
              runId: found.data.runId,
              questionId: String(body.questionId),
              optionId: String(body.optionId),
              ...(body.text ? { text: String(body.text) } : {}),
            });
          return reply(res, 200, { accepted: true, duplicate: Boolean(existing) });
        }
        if (suffix === 'artifacts' && method === 'GET') {
          const artifact: Artifact | undefined =
            artifactFixtures[url.searchParams.get('ref') ?? ''];
          return artifact ? reply(res, 200, artifact) : reply(res, 404, { error: 'not_found' });
        }
        return ['messages', 'tasks', 'answers', 'artifacts'].includes(suffix) || control
          ? reply(res, 405, { error: 'method_not_allowed' })
          : reply(res, 404, { error: 'not_found' });
      }
      if (path === '/v1/push/config' && method === 'GET') {
        // Non-secret fixture key; browser push is stubbed, no push service contacted.
        return reply(res, 200, {
          applicationServerKey: Buffer.from(new Uint8Array(65).fill(4)).toString('base64url'),
        });
      }
      if (path === '/v1/push/subscriptions' && method === 'POST') {
        if (typeof body.endpoint !== 'string') return reply(res, 400, { error: 'invalid_request' });
        subscriptions = subscriptions.filter((s) => s.endpoint !== body.endpoint);
        subscriptions.push(body as unknown as PushRegistration);
        return reply(res, 204);
      }
      return reply(res, 404, { error: 'not_found' });
    } catch {
      return reply(res, 400, { error: 'invalid_json' });
    }
  };
}
