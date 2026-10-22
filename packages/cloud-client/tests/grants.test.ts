import { expect, test } from 'vitest';
import { CloudClient, grantFacts, timeAgo, Unsupported } from '../src';

const H = 3_600_000;

test('a kept approval in words: its reach, its use, its end', () => {
  const now = 1_000 * H;
  expect(grantFacts({ scope: 'repository', uses: 0, lastUsedAt: null, expiresAt: now + 28 * 24 * H }, now)).toEqual({
    scope: 'For this repository',
    uses: 'Not used yet',
    ends: 'Ends in 28 days',
  });
  expect(grantFacts({ scope: 'task', uses: 1, lastUsedAt: now - 5 * 60_000, expiresAt: now + 2 * H }, now)).toEqual({
    scope: 'For one task',
    uses: 'Used once, last 5 min ago',
    ends: 'Ends in 2 h',
  });
  expect(grantFacts({ scope: 'task', uses: 3, lastUsedAt: now - 3 * H, expiresAt: now }, now).uses).toBe(
    'Used 3 times, last 3 h ago',
  );
  expect(timeAgo(now, now)).toBe('just now');
  expect(timeAgo(now - 72 * H, now)).toBe('3 days ago');
});

test('listing and revoking kept approvals use their routes; a server without them is Unsupported', async () => {
  const calls: string[] = [];
  const client = new CloudClient('t', (async (url, options) => {
    calls.push(`${options?.method ?? 'GET'} ${String(url)} ${options?.body ?? ''}`.trim());
    if (String(url).endsWith('/revoke')) return Response.json({ revoked: 2 });
    if (options?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ grants: [{ grantId: 'g/1', tool: 'open_pull_request' }] });
  }) as typeof fetch);
  expect((await client.listGrants())[0]?.grantId).toBe('g/1');
  await client.revokeGrant('g/1');
  expect(await client.revokeGrants({ repository: 'acme/widgets' })).toBe(2);
  expect(calls).toEqual([
    'GET /v1/inbox/grants',
    'DELETE /v1/inbox/grants/g%2F1',
    'POST /v1/inbox/grants/revoke {"repository":"acme/widgets"}',
  ]);
  const none = new CloudClient('t', (async () => Response.json({}, { status: 404 })) as typeof fetch);
  await expect(none.listGrants()).rejects.toBeInstanceOf(Unsupported);
});
