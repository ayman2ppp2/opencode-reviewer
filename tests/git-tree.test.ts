import { expect, test } from 'bun:test';
import { GitTreeGuard } from '../src/git-tree';
import { collectSource } from '../src/source';
import { ConfigSchema, RequestSchema, type GitHubClient } from '../src/domain';

const sha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const request = RequestSchema.parse({ repo: 'a/b', number: 1, baseSha: sha, headSha: sha, title: '', body: '', private: false, draft: false, actor: 'a', eventId: 'test' });
test('rejects symlinks even when Contents would dereference them into file responses', async () => {
  let contentReads = 0;
  const client: GitHubClient = {
    paginate: async () => [{ filename: 'notes.txt', status: 'added', patch: '@@ -0,0 +1 @@\n+.env', additions: 1, deletions: 0 }],
    request: async (_method, path) => {
      if (path.endsWith('/pulls/1')) return { number: 1, title: '', body: null, draft: false, user: { login: 'a' }, base: { sha, repo: { full_name: 'a/b', private: false } }, head: { sha } };
      if (path.includes('/git/commits/')) return { tree: { sha: treeSha } };
      if (path.includes('/git/trees/')) return { truncated: false, tree: [{ path: 'notes.txt', mode: '120000', type: 'blob', sha }] };
      contentReads++;
      const text = 'API_KEY=SENSITIVE_CANARY';
      return { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), size: text.length };
    },
  };
  const bundle = await collectSource(client, request, ConfigSchema.parse({}));
  expect(bundle.files).toHaveLength(0);
  expect(bundle.omissions[0]).toContain('symlinks');
  expect(contentReads).toBe(0);
  expect(JSON.stringify(bundle)).not.toContain('SENSITIVE_CANARY');
});
test('rejects symlink directories and submodules and fails closed on truncated trees', async () => {
  for (const mode of ['120000', '160000']) {
    const client: GitHubClient = { paginate: async () => [], request: async (_method, path) => path.includes('/git/commits/') ? { tree: { sha: treeSha } } : { truncated: false, tree: [{ path: 'dir', mode, type: 'blob', sha }] } };
    expect(await new GitTreeGuard(client, 'a/b', sha).isRegularFile('dir/file.ts')).toBe(false);
  }
  const client: GitHubClient = { paginate: async () => [], request: async (_method, path) => path.includes('/git/commits/') ? { tree: { sha: treeSha } } : { truncated: true, tree: [] } };
  await expect(new GitTreeGuard(client, 'a/b', sha).isRegularFile('file.ts')).rejects.toThrow();
});
test('import context cannot dereference a symlink into excluded content', async () => {
  let secretRead = false;
  const content = "import { secret } from './notes';\nexport const x = secret;";
  const client: GitHubClient = {
    paginate: async () => [{ filename: 'main.ts', status: 'added', patch: `@@ -0,0 +1,2 @@\n+${content.replace(/\n/g, '\n+')}`, additions: 2, deletions: 0 }],
    request: async (_method, path) => {
      if (path.endsWith('/pulls/1')) return { number: 1, title: '', body: null, draft: false, user: { login: 'a' }, base: { sha, repo: { full_name: 'a/b', private: false } }, head: { sha } };
      if (path.includes('/git/commits/')) return { tree: { sha: treeSha } };
      if (path.includes('/git/trees/')) return { truncated: false, tree: [{ path: 'main.ts', mode: '100644', type: 'blob', sha }, { path: 'notes.ts', mode: '120000', type: 'blob', sha }] };
      if (path.includes('/contents/notes')) secretRead = true;
      return { type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64'), size: content.length };
    },
  };
  const bundle = await collectSource(client, request, ConfigSchema.parse({}));
  expect(bundle.files).toHaveLength(1);
  expect(bundle.context ?? []).toHaveLength(0);
  expect(secretRead).toBe(false);
});
