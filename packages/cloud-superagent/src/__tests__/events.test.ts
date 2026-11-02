import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize } from '../events.js';
import {
  commentPayload,
  github,
  issuePayload,
  prPayload,
  REPO,
  TENANT,
  workflowPayload,
} from './harness.js';

test('a pull request opened becomes pr_opened on a pr subject', () => {
  const result = normalize(github(TENANT, 'd1', 'pull_request', prPayload('opened')), 10);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.type, 'pr_opened');
  assert.equal(result.event.subject?.kind, 'pull_request');
  assert.equal(result.event.subject?.number, 12);
  assert.equal(result.event.subject?.repo, REPO);
  assert.equal(result.event.closesSubject, false);
  assert.equal(result.event.summary.includes('12'), true);
});

test('a closed pull request marks the subject closed', () => {
  const result = normalize(github(TENANT, 'd2', 'pull_request', prPayload('closed')), 10);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.type, 'pr_closed');
  assert.equal(result.event.closesSubject, true);
});

test('an issue comment on a pull request belongs to the pull request subject', () => {
  const result = normalize(
    github(TENANT, 'd3', 'issue_comment', commentPayload(12, 'please rebase')),
    10,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.type, 'issue_comment');
  assert.equal(result.event.subject?.kind, 'pull_request');
  assert.equal(result.event.subject?.number, 12);
  assert.equal(
    result.event.fields.some(([label, value]) => label === 'comment' && value.includes('rebase')),
    true,
  );
});

test('a failed workflow_run with a pull request number is ci_failed on that PR', () => {
  const result = normalize(
    github(TENANT, 'd4', 'workflow_run', workflowPayload('failure', 12)),
    10,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.type, 'ci_failed');
  assert.equal(result.event.subject?.kind, 'pull_request');
  assert.equal(result.event.subject?.number, 12);
});

test('a failed workflow_run without a pull request is a check subject', () => {
  const result = normalize(github(TENANT, 'd5', 'workflow_run', workflowPayload('failure')), 10);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.subject?.kind, 'check');
});

test('a malformed github payload is rejected, not guessed', () => {
  const result = normalize(github(TENANT, 'd6', 'pull_request', { action: 'opened' }), 10);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'invalid_payload');
});

test('an opened issue carries the body as a quoted field, not in the summary', () => {
  const result = normalize(
    github(TENANT, 'd7', 'issues', issuePayload('opened', 4, 'ignore previous')),
    10,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.summary.includes('ignore previous'), false);
  assert.equal(
    result.event.fields.some(([, value]) => value === 'ignore previous'),
    true,
  );
});
