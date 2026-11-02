import { randomUUID } from 'node:crypto';
import type { IdFactory } from './types.js';

const compact = (): string => randomUUID().replaceAll('-', '');

export function defaultIds(): IdFactory {
  return {
    event: () => `evt_${compact()}`,
    worker: () => `wrk_${compact()}`,
    subscription: () => `sub_${compact()}`,
    approval: () => `apr_${compact()}`,
    audit: () => `aud_${compact()}`,
    task: () => `tsk_${compact()}`,
    decision: () => `dec_${compact()}`,
  };
}

/** Deterministic ids for tests. One counter, unique across kinds. */
export function sequentialIds(start = 0): IdFactory {
  let n = start;
  const next = (prefix: string) => {
    n += 1;
    return `${prefix}_${String(n).padStart(4, '0')}`;
  };
  return {
    event: () => next('evt'),
    worker: () => next('wrk'),
    subscription: () => next('sub'),
    approval: () => next('apr'),
    audit: () => next('aud'),
    task: () => next('tsk'),
    decision: () => next('dec'),
  };
}
