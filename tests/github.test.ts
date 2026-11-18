import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GhApiError, GhClient } from '../src/github';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fakeGh(script: string): Promise<string> {
  const directory = await mkdtemp('/tmp/opencode/reviewer-gh-');
  directories.push(directory);
  const executable = join(directory, 'gh');
  await writeFile(executable, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  return executable;
}

describe('GhClient', () => {
  test('passes JSON by stdin and fixes the host without shell interpretation', async () => {
    const executable = await fakeGh(`console.log(JSON.stringify({ args: process.argv.slice(2), input: await Bun.stdin.text() }));`);
    const client = new GhClient({ executable });
    const body = { body: '$(touch /tmp/not-a-command) "quoted"\nvalue' };
    const response = await client.request('POST', '/repos/a/b/issues/1/comments', body);
    expect(response).toEqual({ args: ['api', '--hostname', 'github.com', '--method', 'POST', '-H',
      'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', '--input', '-', '--',
      '/repos/a/b/issues/1/comments'], input: JSON.stringify(body) });
  });

  test('rejects hosts, traversal, gh placeholders and malformed endpoints', async () => {
    const client = new GhClient({ executable: '/does/not/exist' });
    for (const path of ['https://evil.test/x', '//evil.test/x', '/repos/a/../b', '/repos/%2e%2e/b',
      '/repos/a/%2fetc', '/repos/a/%252e%252e', '/repos/{owner}/b', '/repos/a/b#fragment', '/repos/a\\b', '/repos/a/%00']) {
      await expect(client.request('GET', path)).rejects.toThrow();
    }
  });

  test('bounds stdout, stderr and execution time', async () => {
    const noisy = await fakeGh(`process.stdout.write('x'.repeat(2000));`);
    await expect(new GhClient({ executable: noisy, maxOutputBytes: 100 }).request('GET', '/repos/a/b')).rejects.toThrow('output exceeds');
    const stderr = await fakeGh(`process.stderr.write('x'.repeat(2000));`);
    await expect(new GhClient({ executable: stderr, maxOutputBytes: 100 }).request('GET', '/repos/a/b')).rejects.toThrow('output exceeds');
    const slow = await fakeGh(`setInterval(() => {}, 1000);`);
    await expect(new GhClient({ executable: slow, timeoutMs: 30 }).request('GET', '/repos/a/b')).rejects.toThrow('timed out');
  });

  test('handles no content, HTTP errors and malformed JSON', async () => {
    const empty = await fakeGh('');
    expect(await new GhClient({ executable: empty }).request('PUT', '/repos/a/b')).toBeNull();
    const invalid = await fakeGh(`console.log('not json');`);
    await expect(new GhClient({ executable: invalid }).request('GET', '/repos/a/b')).rejects.toThrow('invalid JSON');
    const missing = await fakeGh(`console.error('secret content (HTTP 404)'); process.exit(1);`);
    try {
      await new GhClient({ executable: missing }).request('PATCH', '/repos/a/b', {});
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(GhApiError);
      if (!(error instanceof GhApiError)) throw error;
      expect(error.status).toBe(404);
      expect(error.message).not.toContain('secret');
    }
  });

  test('paginates arrays while preserving filters', async () => {
    const executable = await fakeGh(`const url = new URL(process.argv.at(-1), 'https://api.github.com');
      if (url.searchParams.get('state') !== 'open' || url.searchParams.get('per_page') !== '100') process.exit(1);
      console.log(JSON.stringify(Array.from({length: url.searchParams.get('page') === '1' ? 100 : 2}, (_, i) => i)));`);
    const client = new GhClient({ executable });
    expect((await client.paginate('/repos/a/b/issues?state=open')).length).toBe(102);
    await expect(client.paginate('/repos/a/b/issues?page=2')).rejects.toThrow('managed');
  });

  test('rejects object endpoints, endless pagination and aggregate overflow', async () => {
    const object = await fakeGh(`console.log('{}');`);
    await expect(new GhClient({ executable: object }).paginate('/repos/a/b')).rejects.toThrow('array');
    const full = await fakeGh(`console.log(JSON.stringify(Array(100).fill(1)));`);
    await expect(new GhClient({ executable: full }).paginate('/repos/a/b')).rejects.toThrow('30 pages');
    await expect(new GhClient({ executable: full, maxOutputBytes: 300 }).paginate('/repos/a/b')).rejects.toThrow('pagination output');
  });
});
