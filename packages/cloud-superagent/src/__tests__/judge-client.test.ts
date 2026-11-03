import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createJudgeClientFromEnv, createJudgeFromEnv, FetchJudgeClient } from '../judge-client.js';
import { HeuristicJudge, ModelJudge } from '../router.js';

test('createJudgeFromEnv stays heuristic unless model is requested', () => {
  assert.ok(createJudgeFromEnv({}) instanceof HeuristicJudge);
  assert.ok(
    createJudgeFromEnv({ MAKA_CLOUD_SUPERAGENT_JUDGE: 'heuristic' }) instanceof HeuristicJudge,
  );
  assert.throws(
    () => createJudgeFromEnv({ MAKA_CLOUD_SUPERAGENT_JUDGE: 'model' }),
    /ANTHROPIC_API_KEY|MAKA_CLOUD_JUDGE_API_KEY/,
  );
});

test('FetchJudgeClient posts the Anthropic Messages path used by the host', async () => {
  const seen: Array<{
    url: string;
    key: string | undefined;
    version: string | undefined;
    body: unknown;
  }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        key: header(req, 'x-api-key'),
        version: header(req, 'anthropic-version'),
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ content: [{ type: 'text', text: '{"action":"ignore","reason":"ok"}' }] }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const client = new FetchJudgeClient({
      apiKey: 'sk-test-judge',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'claude-haiku-5-5',
    });
    const text = await client.complete('Decide ignore or spawn.');
    assert.equal(text, '{"action":"ignore","reason":"ok"}');
    assert.equal(seen[0]?.url, '/v1/messages');
    assert.equal(seen[0]?.key, 'sk-test-judge');
    assert.equal(seen[0]?.version, '2023-06-01');
    const posted = seen[0]?.body as { model?: string } | undefined;
    assert.equal(posted?.model, 'claude-haiku-5-5');
    const fromEnv = createJudgeFromEnv(
      {
        MAKA_CLOUD_SUPERAGENT_JUDGE: 'model',
        ANTHROPIC_API_KEY: 'sk-env',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      },
      fetch,
    );
    assert.ok(fromEnv instanceof ModelJudge);
    const viaEnv = createJudgeClientFromEnv(
      {
        MAKA_CLOUD_JUDGE_API_KEY: 'sk-env-2',
        MAKA_CLOUD_JUDGE_BASE_URL: `http://127.0.0.1:${port}`,
      },
      fetch,
    );
    assert.equal(await viaEnv.complete('x'), '{"action":"ignore","reason":"ok"}');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
