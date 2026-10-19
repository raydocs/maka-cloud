import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeRunner, RunnerRegistry } from '@maka-cloud/orchestrator';
import { type CloudServerOptions, startCloudServer } from '../cloud-server.js';
import { conductorSession, recordingHandler } from './conductor.js';
import { eventually, newConversation, openStream, startHarness } from './harness.js';

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function options(t: { after(fn: () => unknown): void }): Promise<CloudServerOptions> {
  const dir = await mkdtemp(join(tmpdir(), 'startup-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dbPath: join(dir, 'server.sqlite'),
    invitesPath: join(dir, 'invites.sqlite'),
    handoffRoot: join(dir, 'handoff'),
    runners: new RunnerRegistry([new FakeRunner()]),
  };
}

// Each failing start must leave nothing behind: the database lock, the MCP port and
// the public port are all free again, which a second start over the same settings shows.
test('a start that fails on the public port releases the database and the MCP port', async (t) => {
  const base = { ...(await options(t)), mcp: { port: await freePort() } };
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const taken = (blocker.address() as net.AddressInfo).port;

  await assert.rejects(startCloudServer({ ...base, port: taken }), /EADDRINUSE/u);
  const server = await startCloudServer(base);
  await server.close();
});

test('a start that fails on the invite file releases the database and the MCP port', async (t) => {
  const base = { ...(await options(t)), mcp: { port: await freePort() } };
  // A directory cannot be opened as a database file.
  await mkdir(base.invitesPath);
  await assert.rejects(startCloudServer(base));
  await rm(base.invitesPath, { recursive: true });
  const server = await startCloudServer(base);
  await server.close();
});

test('a start that fails while restoring releases the database', async (t) => {
  const { handler, seen } = recordingHandler();
  const h = await startHarness(t, { handler });
  const conversationId = await newConversation(h);
  const { session } = await conductorSession(h, seen, conversationId);
  await h.server.orchestrator.delegate(session, { runner: 'fake', brief: 'running' });
  await eventually(() => h.fake.runs.length === 1, 'run');
  await h.server.close();
  // Restoring ends the unfinished task, which stamps a time; the clock fails.
  await assert.rejects(
    startCloudServer({
      ...h.options,
      orchestrator: {
        now: () => {
          throw new Error('clock failed');
        },
      },
    }),
    /clock failed/u,
  );
  const server = await startCloudServer(h.options);
  await server.close();
});

test('closing ends open streams, frees every slot, and may be called twice at once', async (t) => {
  const h = await startHarness(t);
  await newConversation(h);
  const stream = await openStream(t, h);
  await eventually(() => h.server.openStreams() === 1, 'stream opened');
  await Promise.all([h.server.close(), h.server.close()]);
  await stream.closed;
  assert.equal(h.server.openStreams(), 0);
  // The database lock went with it.
  const again = await startCloudServer({ ...h.options });
  await again.close();
});
