import { storageOutbox } from '@maka-cloud/client';

test('an unavailable secure store reports a failed outbox put instead of promising persistence', async () => {
  jest.resetModules();
  const secure = require('expo-secure-store') as typeof import('expo-secure-store');
  const spy = jest.spyOn(secure, 'isAvailableAsync').mockResolvedValue(false);
  try {
    const { readSecure, writeDurableSecure, removeSecure } =
      require('@/lib/secure') as typeof import('@/lib/secure');
    const outbox = storageOutbox(
      { get: readSecure, set: writeDurableSecure, remove: removeSecure },
      'scope',
    );
    // A storage rejection is surfaced to the feed, where it becomes the composer notice.
    await expect(outbox.put({ id: 'm', conversationId: 'c', text: 'hello', at: 1 })).resolves.toBe(
      false,
    );
  } finally {
    spy.mockRestore();
  }
});
