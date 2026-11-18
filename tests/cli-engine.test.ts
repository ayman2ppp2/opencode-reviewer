import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEngineOutput, trustedConfig } from '../src/engine';
import { runProcess } from '../src/process';

test('real pinned OpenCode uses the gateway, no tools, and free model only', async () => {
  const models: string[] = [];
  const proposal = { summary: 'Fixture review.', walkthrough: [], findings: [] };
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (request) => {
    const body = await request.json();
    models.push(body.model);
    expect(request.headers.get('x-reviewer-token')).toBe('fixture-token');
    const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4.1-flash-free' };
    return new Response([
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(proposal) }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const dir = await mkdtemp(join(tmpdir(), 'reviewer-cli-test-'));
  try {
    await mkdir(join(dir, 'home/.config/opencode'), { recursive: true });
    await mkdir(join(dir, 'work'));
    await writeFile(join(dir, 'home/.config/opencode/opencode.json'), JSON.stringify(trustedConfig(`http://127.0.0.1:${server.port}/v1`, 'fixture-token')));
    const result = await runProcess([resolve('node_modules/.bin/opencode'), '--standalone', 'run', '--agent', 'reviewer', '--model', 'opencode/deepseek-v4.1-flash-free', '--title', 'Fixture', '--format', 'json', 'Reply with the requested JSON.'], { cwd: join(dir, 'work'), env: { HOME: join(dir, 'home'), PATH: '/usr/local/bin:/usr/bin:/bin', OPENCODE_DISABLE_FREE_MODELS: '0' }, timeoutMs: 30000 });
    expect(result.code).toBe(0);
    expect(parseEngineOutput(result.stdout)).toEqual(proposal);
    expect(models).toEqual(['deepseek-v4.1-flash-free']);
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 35000);
