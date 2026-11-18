import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEngineOutput, trustedConfig } from '../src/engine';
import { runProcess } from '../src/process';
import { randomBytes } from 'node:crypto';
import { createGateway } from '../src/gateway';
import { EgressSchema } from '../src/egress';
import { z } from 'zod';

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

test('real OpenCode reconstructs a buffered device relay over actual HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reviewer-device-test-'));
  const key = randomBytes(32).toString('hex');
  await writeFile(join(dir, 'key'), key, { mode: 0o600 });
  const fixture = `
import sys,json,base64
sys.path.insert(0,'device')
from relay import Config,UpstreamResponse,make_server,MODEL
def transport(method,url,headers,body,**kwargs):
    if method=='GET':
        return UpstreamResponse(200,'application/json',json.dumps({'data':[{'id':MODEL,'cost':{'text':{'input':{'price':0},'output':{'price':0}}}}]}).encode())
    data=json.loads(body)
    assert data['model']==MODEL
    assert 'authorization' not in headers
    base={'id':'fixture','object':'chat.completion.chunk','created':1,'model':MODEL}
    text=json.dumps({'summary':'Buffered device fixture.','walkthrough':[],'findings':[]})
    chunks=[{**base,'choices':[{'index':0,'delta':{'role':'assistant','content':text},'finish_reason':None}]},{**base,'choices':[{'index':0,'delta':{},'finish_reason':'stop'}]}]
    stream=''.join('data: '+json.dumps(c)+'\\n\\n' for c in chunks)+'data: [DONE]\\n\\n'
    return UpstreamResponse(200,'text/event-stream',stream.encode())
server=make_server(Config(token_file=sys.argv[1],port=0),transport)
print(json.dumps({'port':server.server_port}),flush=True)
server.serve_forever()
`;
  const python = Bun.spawn(['python3', '-B', '-u', '-c', fixture, join(dir, 'key')], { stdout: 'pipe', stderr: 'pipe' });
  let gateway: ReturnType<typeof Bun.serve> | undefined;
  try {
    const reader = python.stdout.getReader();
    const first = await reader.read();
    if (!first.value) throw new Error('Device fixture did not start');
    const port = z.object({ port: z.number().int().positive() }).parse(JSON.parse(new TextDecoder().decode(first.value))).port;
    await reader.cancel();
    const route = EgressSchema.parse({ profile: 'laptop', url: 'https://fixture-device.trycloudflare.com/', key });
    gateway = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: createGateway({ token: 'ephemeral', egress: route, fetcher: async (url, init) => {
      expect(String(url)).toBe('https://fixture-device.trycloudflare.com/v1/relay');
      const response = await fetch(`http://127.0.0.1:${port}/v1/relay`, init);
      expect(response.headers.get('content-type')).toBe('application/json');
      return response;
    } }) });
    await mkdir(join(dir, 'home/.config/opencode'), { recursive: true });
    await mkdir(join(dir, 'work'));
    await writeFile(join(dir, 'home/.config/opencode/opencode.json'), JSON.stringify(trustedConfig(`http://127.0.0.1:${gateway.port}/v1`, 'ephemeral')));
    const result = await runProcess([resolve('node_modules/.bin/opencode'), '--standalone', 'run', '--agent', 'reviewer', '--model', 'opencode/deepseek-v4.1-flash-free', '--title', 'Device fixture', '--format', 'json', 'Return a JSON review. No tools.'], {
      cwd: join(dir, 'work'), env: { HOME: join(dir, 'home'), PATH: '/usr/local/bin:/usr/bin:/bin', OPENCODE_DISABLE_FREE_MODELS: '0' }, timeoutMs: 30000,
    });
    expect(result.code).toBe(0);
    expect(parseEngineOutput(result.stdout).summary).toBe('Buffered device fixture.');
  } finally {
    gateway?.stop(true);
    python.kill(9);
    await python.exited;
    await rm(dir, { recursive: true, force: true });
  }
}, 35000);
