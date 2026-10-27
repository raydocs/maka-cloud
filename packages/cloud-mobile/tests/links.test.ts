import { hrefOfNotification, hrefOfUrl } from '@/lib/links';

test('a link opens the task, the decision or Home, and carries only an id', () => {
  expect(hrefOfUrl('makacloud://task/t_123')).toBe('/chat?task=t_123');
  expect(hrefOfUrl('makacloud://decision/item:9')).toBe('/?decision=item%3A9');
  expect(hrefOfUrl('makacloud://')).toBe('/');
  expect(hrefOfUrl('makacloud://home')).toBe('/');
  // The same paths on the app's web domain (universal and App Links, once the owner sets them up).
  expect(hrefOfUrl('https://maka.example.com/task/t_123')).toBe('/chat?task=t_123');
  expect(hrefOfUrl('/decision/i7')).toBe('/?decision=i7');
  // A query or a fragment is never followed.
  expect(hrefOfUrl('makacloud://task/t1?token=secret#x')).toBe('/chat?task=t1');
});

test('anything else opens Home: unknown kinds, odd ids, extra parts', () => {
  for (const url of [
    'makacloud://settings',
    'makacloud://task/',
    'makacloud://task/a b',
    'makacloud://task/..%2Fsecret',
    `makacloud://task/${'x'.repeat(129)}`,
    'makacloud://task/t1/approve',
    'makacloud://decision/i7/approve',
    'javascript:alert(1)',
    '',
  ]) {
    expect([url, hrefOfUrl(url)]).toEqual([url, '/']);
  }
});

const TAG = 'a'.repeat(32);

test('a notification opens what it names only for the account signed in', () => {
  const finished = { type: 'task.finished', accountTag: TAG, conversationId: 'c1', taskId: 't9' };
  const needed = { type: 'inbox.needed', accountTag: TAG, itemId: 'i7', kind: 'approval' };
  expect(hrefOfNotification(finished, TAG)).toBe('/chat?task=t9&conversation=c1');
  expect(hrefOfNotification({ ...finished, conversationId: 'c 1' }, TAG)).toBe('/chat?task=t9');
  expect(hrefOfNotification(needed, TAG)).toBe('/?decision=i7');
  // Another account's, one with no tag, or with notifications not on here: Home only.
  expect(hrefOfNotification(finished, 'b'.repeat(32))).toBe('/');
  expect(hrefOfNotification({ ...finished, accountTag: undefined }, TAG)).toBe('/');
  expect(hrefOfNotification(finished, undefined)).toBe('/');
  // Unknown types and malformed data.
  expect(hrefOfNotification({ type: 'spend.alert', accountTag: TAG }, TAG)).toBe('/');
  expect(hrefOfNotification({ ...needed, itemId: '../x' }, TAG)).toBe('/');
  expect(hrefOfNotification(null, TAG)).toBe('/');
  expect(hrefOfNotification('task.finished', TAG)).toBe('/');
});
