import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InstaboxWorkspaceExecutor, createInstaboxWorkspaceExecutorFromEnv } from '../index.js';

describe('createInstaboxWorkspaceExecutorFromEnv', () => {
  it('builds an executor from INSTABOX_* variables', () => {
    const executor = createInstaboxWorkspaceExecutorFromEnv({
      INSTABOX_API_KEY: 'ibk_x',
      INSTABOX_MACHINE_ID: 'm_x',
    });
    assert.ok(executor instanceof InstaboxWorkspaceExecutor);
  });

  it('names the missing variable and never the value of another', () => {
    assert.throws(
      () => createInstaboxWorkspaceExecutorFromEnv({ INSTABOX_MACHINE_ID: 'm_x' }),
      /INSTABOX_API_KEY is not set/,
    );
    assert.throws(
      () => createInstaboxWorkspaceExecutorFromEnv({ INSTABOX_API_KEY: 'ibk_secret' }),
      (error: Error) =>
        /INSTABOX_MACHINE_ID is not set/.test(error.message) &&
        !error.message.includes('ibk_secret'),
    );
  });
});
