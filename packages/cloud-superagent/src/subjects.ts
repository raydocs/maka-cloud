import type { Subject, SubjectKind } from './types.js';

export function subjectKey(kind: SubjectKind, tenantId: string, rest: string): string {
  return `${kindLabel(kind)}:${tenantId}:${rest}`;
}

function kindLabel(kind: SubjectKind): string {
  if (kind === 'pull_request') return 'pr';
  if (kind === 'conversation') return 'chat';
  return kind;
}

export function pullRequestSubject(tenantId: string, repo: string, number: number): Subject {
  const key = subjectKey('pull_request', tenantId, `${repo.toLowerCase()}#${number}`);
  return { kind: 'pull_request', tenantId, key, repo: repo.toLowerCase(), number };
}

export function issueSubject(tenantId: string, repo: string, number: number): Subject {
  const key = subjectKey('issue', tenantId, `${repo.toLowerCase()}#${number}`);
  return { kind: 'issue', tenantId, key, repo: repo.toLowerCase(), number };
}

export function conversationSubject(tenantId: string, conversationId: string): Subject {
  const key = subjectKey('conversation', tenantId, conversationId);
  return { kind: 'conversation', tenantId, key, conversationId };
}

export function checkSubject(tenantId: string, repo: string, sha: string, name: string): Subject {
  const key = subjectKey('check', tenantId, `${repo.toLowerCase()}:${sha}:${name}`);
  return { kind: 'check', tenantId, key, repo: repo.toLowerCase() };
}

/** #460 watch → Super-agent subject. Does not copy the follow-up engine. */
export function subjectOfFollowUp(watch: {
  tenantId: string;
  repo: string;
  number: number;
}): Subject {
  return pullRequestSubject(watch.tenantId, watch.repo, watch.number);
}
