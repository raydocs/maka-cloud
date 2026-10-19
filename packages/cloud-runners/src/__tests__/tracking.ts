import type { TaskId } from '@maka-cloud/orchestrator';
import type { ModelAccess, ModelAccessProvider, SandboxLease, SandboxProvider } from '../types.js';
import { API_KEY, deferred, type Deferred } from './harness.js';

export const FAKE_MACHINE = 'm_aaaaaaaaaaaaaaaaaaaaaaaaaa';

/** A model access provider and sandbox provider that count what they hand out and take back. */
export class Tracking {
  issued = 0;
  revoked = 0;
  acquired = 0;
  released = 0;
  revokeMode: 'ok' | 'sync-throw' | 'reject' | 'hang' = 'ok';
  releaseMode: 'ok' | 'sync-throw' | 'reject' = 'ok';
  /** Set to make `issue` / `acquire` wait; the test opens the gate. */
  issueGate: Deferred | undefined;
  acquireGate: Deferred | undefined;
  issueFails: Error | undefined;
  acquireFails: Error | undefined;
  readonly issueEntered = deferred();
  readonly acquireEntered = deferred();
  readonly revokeEntered = deferred();
  readonly revokeDone = deferred();
  readonly releaseDone = deferred();

  readonly access: ModelAccessProvider = {
    issue: async ({ taskId }: { taskId: TaskId }): Promise<ModelAccess> => {
      this.issueEntered.resolve();
      await this.issueGate?.promise;
      if (this.issueFails) throw this.issueFails;
      this.issued++;
      return {
        apiKey: API_KEY,
        baseUrl: 'https://gateway.test/v1',
        revoke: () => {
          this.revoked++;
          this.revokeEntered.resolve();
          void taskId;
          switch (this.revokeMode) {
            case 'sync-throw':
              throw new Error('revoke blew up');
            case 'reject':
              return Promise.reject(new Error('revoke failed'));
            case 'hang':
              return new Promise<void>(() => undefined);
            default:
              this.revokeDone.resolve();
              return undefined;
          }
        },
      };
    },
  };

  lease(machineId = FAKE_MACHINE): SandboxLease {
    this.acquired++;
    return {
      machineId,
      release: () => {
        this.released++;
        this.releaseDone.resolve();
        if (this.releaseMode === 'sync-throw') throw new Error('release blew up');
        if (this.releaseMode === 'reject') return Promise.reject(new Error('release failed'));
        return undefined;
      },
    };
  }

  readonly sandboxes: SandboxProvider = {
    acquire: async () => {
      this.acquireEntered.resolve();
      await this.acquireGate?.promise;
      if (this.acquireFails) throw this.acquireFails;
      return this.lease();
    },
    restoreFromSnapshot: async () => this.lease(),
    knownMachines: () => [FAKE_MACHINE],
  };
}
