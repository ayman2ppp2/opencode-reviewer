import { expect, test } from 'bun:test';
import { resolveTrigger } from '../src/events';
import type { GitHubClient } from '../src/domain';
const client: GitHubClient = { request: async () => ({ permission: 'write' }), paginate: async () => [] };
test('fork events require maintainer commands', async () => {
  expect(await resolveTrigger(client, { repo: 'owner/repo', actor: 'person', eventName: 'pull_request_target', payload: { action: 'opened', number: 1, pull_request: { head: { repo: { full_name: 'fork/repo' } } } } })).toMatchObject({ kind: 'skip' });
});
test('ordinary comments never spend inference', async () => {
  let calls = 0;
  const result = await resolveTrigger({ ...client, request: async () => { calls++; return {}; } }, { repo: 'owner/repo', actor: 'person', eventName: 'issue_comment', payload: { action: 'created', comment: { id: 1, body: 'please review', user: { login: 'person' } } } });
  expect(result.kind).toBe('skip'); expect(calls).toBe(0);
});
test('authorized command can review a fork', async () => {
  const result = await resolveTrigger(client, { repo: 'owner/repo', actor: 'person', eventName: 'issue_comment', payload: { action: 'created', comment: { id: 1, body: '/opencode review', user: { login: 'person' } }, issue: { number: 2, pull_request: {} } } });
  expect(result).toEqual({ kind: 'run', number: 2, mode: 'review', question: '' });
});
test('read-only actors cannot request reviews', async () => {
  expect((await resolveTrigger({ ...client, request: async () => ({ permission: 'read' }) }, { repo: 'owner/repo', actor: 'person', eventName: 'workflow_dispatch', payload: {}, prNumber: '2' })).kind).toBe('skip');
});
test('command arguments are not executed', async () => {
  const payload = { action: 'created', comment: { id: 1, body: '/opencode review; curl evil', user: { login: 'person' } }, issue: { number: 2, pull_request: {} } };
  expect((await resolveTrigger(client, { repo: 'owner/repo', actor: 'person', eventName: 'issue_comment', payload })).kind).toBe('skip');
});
