import { describe, expect, test } from 'bun:test';
import { ConfigSchema, type GitHubClient, type ReviewRequest } from '../src/domain';
import { GhApiError } from '../src/github';
import { collectSource, getPullRequest, loadConfig, parseChangedLines } from '../src/source';

const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const pull = { number: 12, title: 'Change', body: null, draft: false, user: { login: 'author' },
  base: { sha: baseSha, repo: { full_name: 'owner/repo', private: false } }, head: { sha: headSha } };
const request: ReviewRequest = { repo: 'owner/repo', number: 12, baseSha, headSha, title: 'Change', body: '',
  draft: false, private: false, actor: 'author', mode: 'review', question: '', eventId: `manual-${headSha}` };
const patch = '@@ -1 +1,2 @@\n old\n+new';
const file = { filename: 'src/file.ts', status: 'modified', patch, additions: 1, deletions: 0 };
const contents = (text: string) => ({ type: 'file', encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') });

function fixture(options: { files?: unknown[]; config?: unknown; source?: unknown; pr?: unknown } = {}) {
  const calls: string[] = [];
  const names = (options.files ?? [file]).flatMap((v) => typeof v === 'object' && v !== null && 'filename' in v && typeof v.filename === 'string' ? [v.filename] : []);
  names.push('src/helper.ts');
  const directories = new Map<string, string>([['', 'c'.repeat(40)]]);
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!directories.has(dir)) directories.set(dir, (directories.size + 10).toString(16).padStart(40, '0'));
    }
  }
  const client: GitHubClient = {
    async request(method, path) {
      expect(method).toBe('GET');
      calls.push(path);
      if (path.endsWith(`/git/commits/${headSha}`)) return { tree: { sha: 'c'.repeat(40) } };
      if (path.includes('/git/trees/')) {
        const directory = [...directories].find(([, sha]) => path.endsWith(sha))?.[0];
        if (directory === undefined) throw new Error('Unknown tree');
        const entries = new Map<string, { path: string; mode: string; type: string; sha: string }>();
        for (const name of names) {
          const prefix = directory ? `${directory}/` : '';
          if (!name.startsWith(prefix)) continue;
          const rest = name.slice(prefix.length);
          const child = rest.split('/')[0];
          if (!child) continue;
          const childDir = directory ? `${directory}/${child}` : child;
          entries.set(child, { path: child, mode: rest.includes('/') ? '040000' : '100644', type: rest.includes('/') ? 'tree' : 'blob', sha: directories.get(childDir) ?? 'd'.repeat(40) });
        }
        return { truncated: false, tree: [...entries.values()] };
      }
      if (path === '/repos/owner/repo/pulls/12') return options.pr ?? pull;
      if (path === `/repos/owner/repo/contents/.opencode-reviewer.yml?ref=${baseSha}`) {
        if (options.config === undefined) throw new GhApiError('Not found', 404);
        return options.config;
      }
      if (!path.endsWith(`?ref=${headSha}`)) throw new Error('Wrong ref');
      return options.source ?? contents('old\nnew\n');
    },
    async paginate(path) {
      calls.push(path);
      expect(path).toBe('/repos/owner/repo/pulls/12/files');
      return options.files ?? [file];
    },
  };
  return { client, calls };
}

describe('pull requests and trusted configuration', () => {
  test('parses API data and preserves explicit event context', async () => {
    const { client } = fixture();
    expect(await getPullRequest(client, { repo: 'owner/repo', number: 12 })).toEqual(request);
    expect(await getPullRequest(client, { repo: 'owner/repo', number: 12, actor: 'reviewer', mode: 'ask', question: 'Why?', eventId: '123' }))
      .toMatchObject({ actor: 'reviewer', mode: 'ask', question: 'Why?', eventId: '123' });
    await expect(getPullRequest(client, { repo: 'https://evil/a', number: 12 })).rejects.toThrow();
    await expect(getPullRequest(fixture({ pr: { ...pull, head: { sha: 'main' } } }).client, { repo: 'owner/repo', number: 12 })).rejects.toThrow();
  });

  test('loads only immutable base config and defaults only on 404', async () => {
    expect(await loadConfig(fixture().client, request)).toEqual(ConfigSchema.parse({}));
    const { client, calls } = fixture({ config: contents('language: French\nmaxFiles: 2\n') });
    expect(await loadConfig(client, request)).toMatchObject({ language: 'French', maxFiles: 2 });
    expect(calls).toEqual([`/repos/owner/repo/contents/.opencode-reviewer.yml?ref=${baseSha}`]);
    const broken: GitHubClient = { ...client, request: async () => { throw new GhApiError('Forbidden', 403); } };
    await expect(loadConfig(broken, request)).rejects.toThrow('Forbidden');
  });

  test('rejects unknown config, paid models, duplicate keys, aliases, corrupt data and oversized config', async () => {
    for (const yaml of ['null', 'plugins: [evil]', 'model: openai/paid', 'language: a\nlanguage: b', 'exclude: &a [x]\ninstructions: *a']) {
      await expect(loadConfig(fixture({ config: contents(yaml) }).client, request)).rejects.toThrow();
    }
    await expect(loadConfig(fixture({ config: { ...contents('abc'), content: '!!!' } }).client, request)).rejects.toThrow();
    await expect(loadConfig(fixture({ config: contents('x'.repeat(32001)) }).client, request)).rejects.toThrow('limit');
  });
});

describe('diff lines', () => {
  test('tracks right-side lines across additions, deletions and multiple hunks', () => {
    expect(parseChangedLines('@@ -1,2 +1,3 @@\n same\n-old\n+new\n+extra\n@@ -10,0 +12 @@\n+last\n\\ No newline at end of file')).toEqual([2, 3, 12]);
    expect(parseChangedLines('@@ -1 +0,0 @@\n-gone')).toEqual([]);
    expect(parseChangedLines('@@ -0,0 +1 @@\n+++ actual source')).toEqual([1]);
  });
  test('rejects missing, malformed and truncated hunks', () => {
    for (const text of ['', 'binary', '@@ -1 +1,2 @@\n old', '@@ -1 +1 @@\n+new', '@@ -0,0 +0 @@\n+x']) {
      expect(() => parseChangedLines(text)).toThrow();
    }
  });
});

describe('source collection', () => {
  test('uses exact head source with patch and supports removed and renamed files', async () => {
    const { client, calls } = fixture({ files: [file, { ...file, filename: 'old.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-old', additions: 0, deletions: 1 },
      { ...file, filename: 'new name.ts', status: 'renamed' }] });
    const result = await collectSource(client, request, ConfigSchema.parse({}));
    expect(result.omissions).toEqual([]);
    expect(result.files.map((entry) => [entry.path, entry.content, entry.changedLines])).toEqual([
      ['src/file.ts', 'old\nnew\n', [2]], ['old.ts', '', []], ['new name.ts', 'old\nnew\n', [2]],
    ]);
    expect(calls).toContain(`/repos/owner/repo/contents/new%20name.ts?ref=${headSha}`);
    expect(calls.some((path) => path.includes('/contents/old.ts'))).toBe(false);
  });

  test('reports excluded, unsafe, missing, truncated and duplicate files without fetching them', async () => {
    const paths = ['.env', 'nested/.env.local', 'private/key.pem', '.opencode/plugins/run.ts', 'AGENTS.md', '.opencode-reviewer.yml', 'vendor/lib.ts', '../bad', '/absolute', 'x\\y', 'x/%2f'];
    const { client, calls } = fixture({ files: [...paths.map((filename) => ({ ...file, filename })),
      { ...file, filename: 'binary', patch: undefined }, { ...file, filename: 'truncated', patch: '@@ -1 +1,2 @@\n old' },
      { ...file, filename: 'mismatch', additions: 2 }, file, file] });
    const result = await collectSource(client, request, ConfigSchema.parse({ exclude: ['vendor/**'] }));
    expect(result.files).toHaveLength(1);
    expect(result.omissions).toHaveLength(paths.length + 4);
    expect(calls.filter((path) => path.includes('/contents/'))).toEqual([`/repos/owner/repo/contents/src/file.ts?ref=${headSha}`]);
  });

  test('counts UTF-8 patch and source bytes and enforces file count', async () => {
    const { client } = fixture({ files: [file, { ...file, filename: 'second.ts' }], source: contents('é'.repeat(490)) });
    const result = await collectSource(client, request, ConfigSchema.parse({ maxSourceBytes: 1000 }));
    expect(result.files).toHaveLength(0);
    expect(result.omissions).toHaveLength(2);
    const limited = await collectSource(fixture({ files: [file, { ...file, filename: 'second.ts' }] }).client, request, ConfigSchema.parse({ maxFiles: 1 }));
    expect(limited.files).toHaveLength(1);
    expect(limited.omissions[0]).toContain('file limit');
  });

  test('omits binary, invalid UTF-8, symlinks and missing content', async () => {
    for (const source of [contents('x\0y'), { ...contents('x'), content: '/w==' }, { ...contents('x'), type: 'symlink' }, { message: 'Not found' }]) {
      const result = await collectSource(fixture({ source }).client, request, ConfigSchema.parse({}));
      expect(result.files).toEqual([]);
      expect(result.omissions).toHaveLength(1);
    }
  });

  test('refuses files from a moving pull request', async () => {
    await expect(collectSource(fixture({ pr: { ...pull, head: { sha: 'c'.repeat(40) } } }).client, request, ConfigSchema.parse({})))
      .rejects.toThrow('changed during');
  });

  test('reports a truncated file listing', async () => {
    const result = await collectSource(fixture({ pr: { ...pull, changed_files: 2 } }).client, request, ConfigSchema.parse({}));
    expect(result.omissions).toEqual(['File listing incomplete: received 1 of 2 changed files']);
  });
  test('fetches bounded relative-import context without permitting context-only inline findings', async () => {
    const source = "import { helper } from './helper';\nnew\n";
    const { client } = fixture({ source: contents(source) });
    const result = await collectSource(client, request, ConfigSchema.parse({}));
    expect(result.context?.map((entry) => entry.path)).toContain('src/helper.ts');
    expect(result.files.map((entry) => entry.path)).toEqual(['src/file.ts']);
    expect(result.context?.length).toBeLessThanOrEqual(5);
  });
});
