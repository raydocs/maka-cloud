import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { CloudClient, type Grant } from '@maka-cloud/client';
import { GrantsPanel } from '../src/Grants';

afterEach(cleanup);
const H = 3_600_000;
const NOW = 1_000 * H;
const grant = (over: Partial<Grant>): Grant => ({
  grantId: 'g1',
  tool: 'open_pull_request',
  repository: 'acme/widgets',
  scope: 'repository',
  createdAt: NOW - H,
  expiresAt: NOW + 28 * 24 * H,
  uses: 2,
  lastUsedAt: NOW - 3 * H,
  ...over,
});

function server(grants: Grant[], status = 200) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL, options?: RequestInit) => {
    calls.push(`${options?.method ?? 'GET'} ${String(url)}`);
    if (status !== 200) return Response.json({}, { status });
    if (String(url).endsWith('/revoke')) return Response.json({ revoked: 2 });
    if (options?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ grants });
  }) as typeof fetch;
  return { client: new CloudClient('t', fetcher), calls };
}

test('kept approvals are listed by repository with their reach, use and end, and revoke in one tap', async () => {
  const { client, calls } = server([
    grant({}),
    grant({
      grantId: 'g2',
      tool: 'merge_pull_request',
      scope: 'task',
      uses: 0,
      lastUsedAt: null,
      expiresAt: NOW + 2 * H,
    }),
    grant({ grantId: 'g3', repository: 'acme/site', tool: 'post_comment' }),
  ]);
  render(<GrantsPanel client={client} now={() => NOW} />);
  const panel = await screen.findByRole('region', { name: 'Kept approvals' });
  await within(panel).findByText('acme/widgets');
  expect(
    within(panel).getAllByText(
      'For this repository · Used 2 times, last 3 h ago · Ends in 28 days',
    ),
  ).toHaveLength(2);
  expect(within(panel).getByText('For one task · Not used yet · Ends in 2 h')).toBeTruthy();
  fireEvent.click(within(panel).getByRole('button', { name: 'Revoke post_comment in acme/site' }));
  await waitFor(() => expect(within(panel).queryByText('acme/site')).toBeNull());
  // Revoke all only where a repository has more than one.
  fireEvent.click(within(panel).getByRole('button', { name: 'Revoke all' }));
  await waitFor(() => expect(within(panel).queryByText('acme/widgets')).toBeNull());
  expect(calls).toEqual([
    'GET /v1/inbox/grants',
    'DELETE /v1/inbox/grants/g3',
    'POST /v1/inbox/grants/revoke',
  ]);
});

test('with nothing kept it says how approvals get here; on a server without them it is not shown', async () => {
  render(<GrantsPanel client={server([]).client} now={() => NOW} />);
  expect(await screen.findByText(/Nothing kept\./u)).toBeTruthy();
  cleanup();
  render(<GrantsPanel client={server([], 404).client} now={() => NOW} />);
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Kept approvals' })).toBeNull());
});
