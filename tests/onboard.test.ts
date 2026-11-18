import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { ConfigSchema, type GitHubClient } from '../src/domain';
import { CALLER_PATH, onboard, renderCaller } from '../src/onboard';

const ref = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const commitSha = 'c'.repeat(40);
const options = { repo: 'owner/selected', reviewerRepo: 'ayman2ppp2/opencode-reviewer', ref };
const workflow = renderCaller(options);

class FakeGitHub implements GitHubClient {
  calls: { method: string; path: string; body?: unknown }[] = [];
  defaultContent: string | undefined;
  branchContent: string | undefined;
  branchSha: string | undefined;
  branch = '';
  pulls: unknown[] = [];
  unrelated = false;
  forbiddenRead = false;

  async request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    this.calls.push({ method, path, body });
    if (this.forbiddenRead) throw { status: 403 };
    const root = `/repos/${options.repo}`;
    if (method === 'GET' && path === root) return { default_branch: 'main' };
    if (method === 'GET' && path === `${root}/git/ref/heads/main`) return { object: { sha: baseSha } };
    if (method === 'GET' && path.includes('/git/ref/heads/')) {
      this.branch = decodeURIComponent(path.split('/heads/')[1] ?? '');
      if (!this.branchSha) throw { status: 404 };
      return { object: { sha: this.branchSha } };
    }
    if (method === 'GET' && path.includes('/contents/')) {
      const sha = path.split('?ref=')[1];
      const content = sha === baseSha ? this.defaultContent : this.branchContent;
      if (content === undefined) throw { status: 404 };
      return { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64') };
    }
    if (method === 'POST' && path.endsWith('/git/refs')) {
      this.branchSha = baseSha;
      return { object: { sha: baseSha } };
    }
    if (method === 'PUT' && path.endsWith(`/contents/${CALLER_PATH}`)) {
      this.branchContent = workflow;
      this.branchSha = commitSha;
      return {};
    }
    if (method === 'GET' && path.includes('/compare/')) {
      return {
        status: 'ahead',
        files: [
          { filename: CALLER_PATH, status: 'added' },
          ...(this.unrelated ? [{ filename: 'user-work.txt', status: 'modified' }] : []),
        ],
      };
    }
    if (method === 'POST' && path.endsWith('/pulls')) {
      const pull = { html_url: 'https://github.com/owner/selected/pull/1' };
      this.pulls = [pull];
      return pull;
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  }

  async paginate(path: string): Promise<unknown[]> {
    this.calls.push({ method: 'GET', path });
    return this.pulls;
  }

  writes() {
    return this.calls.filter((call) => call.method !== 'GET');
  }
}

describe('renderCaller', () => {
  test('examples match the generator and current configuration schema', async () => {
    const example = await Bun.file(new URL('../examples/caller.yml', import.meta.url)).text();
    expect(parse(example)).toEqual(parse(renderCaller({ reviewerRepo: options.reviewerRepo, ref: '0'.repeat(40) })));
    const config = parse(await Bun.file(new URL('../examples/.opencode-reviewer.yml', import.meta.url)).text());
    expect(ConfigSchema.parse(config).model).toBe('opencode/deepseek-v4.1-flash-free');
  });

  test('pins the central workflow and forwards explicit device secrets, never all secrets', () => {
    const caller = parse(workflow);
    expect(caller.jobs.review.uses).toBe(`ayman2ppp2/opencode-reviewer/.github/workflows/review.yml@${ref}`);
    expect(caller.jobs.review.with).toEqual({ pr_number: "${{ github.event.inputs.pr_number || '' }}", egress_profile: "${{ github.event.inputs.egress_profile || 'configured' }}" });
    expect(caller.on.pull_request_target.types).toEqual(['opened', 'synchronize', 'reopened', 'ready_for_review']);
    expect(caller.on.issue_comment.types).toEqual(['created']);
    expect(caller.on.workflow_dispatch.inputs.pr_number.type).toBe('string');
    expect(caller.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
    expect(caller.jobs.review.secrets).toEqual({
      REVIEWER_LAPTOP_RELAY_URL: '${{ secrets.REVIEWER_LAPTOP_RELAY_URL }}',
      REVIEWER_LAPTOP_RELAY_KEY: '${{ secrets.REVIEWER_LAPTOP_RELAY_KEY }}',
      REVIEWER_ANDROID_RELAY_URL: '${{ secrets.REVIEWER_ANDROID_RELAY_URL }}',
      REVIEWER_ANDROID_RELAY_KEY: '${{ secrets.REVIEWER_ANDROID_RELAY_KEY }}',
    });
    expect(workflow).not.toContain('secrets: inherit');
    expect(workflow).not.toContain('checkout');
  });

  test.each(['main', 'v1', 'abc123', `${ref}\n`, 'g'.repeat(40)])('rejects unpinned reference %s', (unsafe) => {
    expect(() => renderCaller({ reviewerRepo: options.reviewerRepo, ref: unsafe })).toThrow();
  });

  test.each(['owner/repo\npermissions: write-all', 'owner/repo@main', '../repo/name', 'https://github.com/owner/repo', '../repo', 'owner/..'])('rejects unsafe central repository %s', (reviewerRepo) => {
    expect(() => renderCaller({ reviewerRepo, ref })).toThrow();
  });
});

describe('onboard', () => {
  test('defaults to dry run without remote calls', async () => {
    const client = new FakeGitHub();
    expect(await onboard(client, options)).toEqual({ status: 'dry-run', workflow });
    expect(client.calls).toEqual([]);
  });

  test('rejects unsafe target repositories before any remote calls', async () => {
    const client = new FakeGitHub();
    await expect(onboard(client, { ...options, repo: 'owner/repo?x=y', apply: true })).rejects.toThrow();
    expect(client.calls).toEqual([]);
  });

  test('creates only a new branch, new file and pull request, never a default branch push', async () => {
    const client = new FakeGitHub();
    expect(await onboard(client, { ...options, apply: true })).toEqual({
      status: 'created', workflow, url: 'https://github.com/owner/selected/pull/1',
    });
    const writes = client.writes();
    expect(writes.map((call) => call.method)).toEqual(['POST', 'PUT', 'POST']);
    expect(writes[0]?.body).toEqual({ ref: `refs/heads/${client.branch}`, sha: baseSha });
    expect(writes[1]?.body).toEqual({
      message: 'ci: add pinned OpenCode reviewer', branch: client.branch, content: Buffer.from(workflow).toString('base64'),
    });
    expect(writes[2]?.body).toMatchObject({ head: client.branch, base: 'main' });
    expect(client.branch).toMatch(/^opencode-reviewer\/onboard-[a-f0-9]{16}$/);
  });

  test('repeating apply reuses the open pull request without writes', async () => {
    const client = new FakeGitHub();
    await onboard(client, { ...options, apply: true });
    client.calls = [];
    expect((await onboard(client, { ...options, apply: true })).status).toBe('existing-pr');
    expect(client.writes()).toEqual([]);
  });

  test('identical workflow on default branch is a no-op', async () => {
    const client = new FakeGitHub();
    client.defaultContent = workflow;
    expect((await onboard(client, { ...options, apply: true })).status).toBe('unchanged');
    expect(client.writes()).toEqual([]);
  });

  test('preserves an existing edited workflow', async () => {
    const client = new FakeGitHub();
    client.defaultContent = 'user workflow';
    expect((await onboard(client, { ...options, apply: true })).status).toBe('conflict');
    expect(client.defaultContent).toBe('user workflow');
    expect(client.writes()).toEqual([]);
  });

  test('preserves a conflicting onboarding branch workflow', async () => {
    const client = new FakeGitHub();
    client.branchSha = commitSha;
    client.branchContent = 'edited workflow';
    expect((await onboard(client, { ...options, apply: true })).status).toBe('conflict');
    expect(client.branchContent).toBe('edited workflow');
    expect(client.writes()).toEqual([]);
  });

  test('does not write to an unrelated branch without a workflow', async () => {
    const client = new FakeGitHub();
    client.branchSha = commitSha;
    expect((await onboard(client, { ...options, apply: true })).status).toBe('conflict');
    expect(client.writes()).toEqual([]);
  });

  test('does not propose unrelated branch edits even with an identical workflow', async () => {
    const client = new FakeGitHub();
    client.branchSha = commitSha;
    client.branchContent = workflow;
    client.unrelated = true;
    expect((await onboard(client, { ...options, apply: true })).status).toBe('conflict');
    expect(client.writes()).toEqual([]);
  });

  test('recovers from a created branch with no workflow after an interrupted apply', async () => {
    const client = new FakeGitHub();
    client.branchSha = baseSha;
    expect((await onboard(client, { ...options, apply: true })).status).toBe('created');
    expect(client.writes().map((call) => call.method)).toEqual(['PUT', 'POST']);
  });

  test('does not treat authorization errors as missing files', async () => {
    const client = new FakeGitHub();
    client.forbiddenRead = true;
    await expect(onboard(client, { ...options, apply: true })).rejects.toEqual({ status: 403 });
    expect(client.writes()).toEqual([]);
  });

  test('reconciles a branch created concurrently without overwriting it', async () => {
    class ConcurrentBranch extends FakeGitHub {
      override async request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<unknown> {
        if (method === 'POST' && path.endsWith('/git/refs')) {
          this.branchSha = commitSha;
          this.branchContent = 'another installer edit';
          throw { status: 422 };
        }
        return super.request(method, path, body);
      }
    }
    const client = new ConcurrentBranch();
    expect((await onboard(client, { ...options, apply: true })).status).toBe('conflict');
    expect(client.writes()).toEqual([]);
    expect(client.branchContent).toBe('another installer edit');
  });

  test('reports a concurrent file-creation conflict instead of retrying with an overwrite', async () => {
    class ConcurrentContent extends FakeGitHub {
      override async request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<unknown> {
        if (method === 'PUT') {
          this.calls.push({ method, path, body });
          throw { status: 422 };
        }
        return super.request(method, path, body);
      }
    }
    const client = new ConcurrentContent();
    expect((await onboard(client, { ...options, apply: true })).status).toBe('conflict');
    expect(client.writes().map((call) => call.method)).toEqual(['POST', 'PUT']);
  });
});
