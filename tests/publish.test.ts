import { expect, test } from 'bun:test';
import { z } from 'zod';
import { BundleSchema, type GitHubClient, type ReviewState } from '../src/domain';
import { publishReview, readState, updateControl } from '../src/publish';
import { encodeState, SUMMARY_MARKER } from '../src/state';
import { validateProposal } from '../src/validation';

const bundle = BundleSchema.parse({ request: { repo: 'a/b', number: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), title: '', body: '', private: false, draft: false, actor: 'a', eventId: 'event' }, config: {}, files: [{ path: 'a.ts', status: 'modified', patch: '', content: 'broken();', changedLines: [1] }], omissions: [] });
const result = validateProposal(bundle, { summary: 'A bug was found.', walkthrough: [{ path: 'a.ts', description: '@all ``` <img src=x>' }], findings: [{ path: 'a.ts', line: 1, severity: 'high', title: 'Broken function call', body: 'This invocation always throws at runtime.', evidence: 'broken();' }] });
const state: ReviewState = { version: 1, repo: 'a/b', number: 1, headSha: 'b'.repeat(40), baseSha: 'a'.repeat(40), paused: false, fingerprints: [], events: [] };
const BodySchema = z.object({ body: z.string() });
class FakeGitHub implements GitHubClient {
  issues: unknown[] = [];
  comments: unknown[] = [];
  reviews: unknown[] = [];
  writes: { method: string; path: string; body: unknown }[] = [];
  head = bundle.request.headSha;
  base = bundle.request.baseSha;
  closed = false;
  failSummary = false;
  changeAfterReview = false;
  reads = 0;
  changeAtRead = 0;
  async paginate(path: string): Promise<unknown[]> {
    if (path.includes('/issues/')) return this.issues;
    if (path.endsWith('/reviews')) return this.reviews;
    return this.comments;
  }
  async request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    if (method === 'GET') {
      this.reads++;
      if (this.reads === this.changeAtRead) this.head = 'c'.repeat(40);
      return { state: this.closed ? 'closed' : 'open', head: { sha: this.head }, base: { sha: this.base } };
    }
    if (path.endsWith('/reviews')) {
      this.writes.push({ method, path, body });
      const review = z.object({ body: z.string(), comments: z.array(z.object({ body: z.string() })), event: z.literal('COMMENT'), commit_id: z.literal(bundle.request.headSha) }).parse(body);
      this.reviews.push({ id: this.reviews.length + 1, body: review.body, user: { login: 'github-actions[bot]' } });
      for (const comment of review.comments) this.comments.push({ id: this.comments.length + 1, body: comment.body, user: { login: 'github-actions[bot]' } });
      if (this.changeAfterReview) this.head = 'c'.repeat(40);
      return { id: this.reviews.length };
    }
    if (this.failSummary) throw new Error('simulated summary failure');
    this.writes.push({ method, path, body });
    const parsed = BodySchema.parse(body);
    const comment = { id: 100, body: parsed.body, user: { login: 'github-actions[bot]' } };
    this.issues = [comment];
    return comment;
  }
}

test('publishes bound COMMENT review once and updates a stable summary', async () => {
  const client = new FakeGitHub();
  expect((await publishReview(client, bundle, result)).status).toBe('complete');
  expect(client.reviews).toHaveLength(1);
  expect((await publishReview(client, bundle, result)).status).toBe('duplicate');
  expect(client.reviews).toHaveLength(1);
  const saved = await readState(client, bundle.request);
  expect(saved.state?.fingerprints).toEqual(result.findings.map((f) => f.fingerprint));
  const summary = BodySchema.parse(client.issues[0]).body;
  expect(summary).toContain('whole supplied diff');
  expect(summary).not.toContain('@all');
  expect(summary).not.toContain('<img');
});
test('head, base, and closed state are checked before any writes', async () => {
  for (const change of ['head', 'base', 'closed', 'race']) {
    const client = new FakeGitHub();
    if (change === 'head') client.head = 'c'.repeat(40);
    if (change === 'base') client.base = 'c'.repeat(40);
    if (change === 'closed') client.closed = true;
    if (change === 'race') client.changeAtRead = 2;
    expect((await publishReview(client, bundle, result)).status).toBe('superseded');
    expect(client.writes).toHaveLength(0);
  }
});
test('does not write summary when head changes after review', async () => {
  const client = new FakeGitHub();
  client.changeAfterReview = true;
  expect((await publishReview(client, bundle, result)).status).toBe('superseded');
  expect(client.writes).toHaveLength(1);
});
test('recovers after review succeeds but summary fails', async () => {
  const client = new FakeGitHub();
  client.failSummary = true;
  await expect(publishReview(client, bundle, result)).rejects.toThrow('simulated');
  expect(client.reviews).toHaveLength(1);
  client.failSummary = false;
  await publishReview(client, bundle, result);
  expect(client.reviews).toHaveLength(1);
  expect(client.comments).toHaveLength(1);
  expect((await readState(client, bundle.request)).state?.events).toHaveLength(1);
});
test('ignores spoofed summaries and markers by other authors', async () => {
  const client = new FakeGitHub();
  client.issues = [{ id: 999, body: `${SUMMARY_MARKER}\n${encodeState({ ...state, paused: true })}`, user: { login: 'attacker' } }];
  client.comments = [{ id: 1, body: `<!-- opencode-reviewer:finding:${result.findings[0]?.fingerprint} -->`, user: { login: 'attacker' } }];
  expect((await readState(client, bundle.request)).state).toBeNull();
  await publishReview(client, bundle, result);
  expect(client.comments).toHaveLength(2);
});
test('pause survives review events, and help does not unpause', async () => {
  const client = new FakeGitHub();
  await updateControl(client, bundle.request, 'pause');
  expect((await publishReview(client, bundle, result)).status).toBe('paused');
  await updateControl(client, bundle.request, 'help');
  expect((await readState(client, bundle.request)).state?.paused).toBe(true);
  await updateControl(client, bundle.request, 'resume');
  expect((await publishReview(client, bundle, result)).status).toBe('complete');
});
test('new event preserves historical findings without reposting them', async () => {
  const client = new FakeGitHub();
  await publishReview(client, bundle, result);
  await publishReview(client, { ...bundle, request: { ...bundle.request, eventId: 'next' } }, result);
  expect(client.comments).toHaveLength(1);
  expect(client.writes.at(-1)?.method).toBe('PATCH');
  expect(BodySchema.parse(client.issues[0]).body).toContain('does not resolve or dismiss');
});
test('state readers accept only the configured identity and tolerate malformed API entries', async () => {
  const client = new FakeGitHub();
  client.issues = [null, { body: 'bad' }, { id: 42, body: `${SUMMARY_MARKER}\n${encodeState(state)}`, user: { login: 'my-reviewer' } }];
  expect((await readState(client, bundle.request)).state).toBeNull();
  expect((await readState(client, bundle.request, 'my-reviewer')).commentId).toBe(42);
});
test('failed results never post review comments or mark unposted findings', async () => {
  const client = new FakeGitHub();
  await publishReview(client, bundle, { ...result, status: 'failed' });
  expect(client.reviews).toHaveLength(0);
  expect((await readState(client, bundle.request)).state?.fingerprints).toHaveLength(0);
  expect(BodySchema.parse(client.issues[0]).body).toContain('No clean-review conclusion');
});
test('a blocked run can retry the same event after inference recovers', async () => {
  const client = new FakeGitHub();
  await publishReview(client, bundle, { ...result, status: 'blocked' });
  expect((await readState(client, bundle.request)).state?.events).toHaveLength(0);
  expect((await publishReview(client, bundle, result)).status).toBe('complete');
  expect(client.comments).toHaveLength(1);
});
test('summary and question modes cannot publish or suppress proposed findings', async () => {
  for (const mode of ['summary', 'ask'] as const) {
    const client = new FakeGitHub();
    await publishReview(client, { ...bundle, request: { ...bundle.request, mode } }, result);
    expect(client.comments).toHaveLength(0);
    expect((await readState(client, bundle.request)).state?.fingerprints).toHaveLength(0);
    await publishReview(client, { ...bundle, request: { ...bundle.request, eventId: 'real-review' } }, result);
    expect(client.comments).toHaveLength(1);
  }
});
test('large coverage reports preserve bounded recoverable state', async () => {
  const client = new FakeGitHub();
  const large = { ...bundle, omissions: Array.from({ length: 1000 }, () => 'omitted '.repeat(100)) };
  expect((await publishReview(client, large, result)).status).toBe('partial');
  expect(BodySchema.parse(client.issues[0]).body.length).toBeLessThan(65536);
  expect((await readState(client, bundle.request)).state).not.toBeNull();
});
