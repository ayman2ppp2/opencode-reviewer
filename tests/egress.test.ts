import { expect, test } from 'bun:test';
import { createGateway } from '../src/gateway';
import { resolveEgress, egressEnvironment, throughRelay, EgressSchema } from '../src/egress';
import { trustedConfig } from '../src/engine';

const laptop = EgressSchema.parse({ profile: 'laptop', url: 'https://laptop-fixture.trycloudflare.com/', key: 'a'.repeat(64) });
function request() {
  return new Request('http://gateway/v1/chat/completions', { method: 'POST', headers: { 'x-reviewer-token': 'worker', authorization: 'Bearer must-not-leak', 'user-agent': 'OpenCode fixture', 'x-opencode-test': 'fixture' }, body: JSON.stringify({ model: 'deepseek-v4.1-flash-free', stream: true }) });
}
test('relay credentials are confined to the gateway env file and never enter the OpenCode worker config', () => {
  if (laptop.profile === 'direct') throw new Error('Fixture profile');
  const env = egressEnvironment(laptop);
  expect(env).toContain('REVIEWER_LAPTOP_RELAY_URL=' + laptop.url);
  expect(env).toContain('REVIEWER_LAPTOP_RELAY_KEY=' + laptop.key);
  const workerConfig = JSON.stringify(trustedConfig('http://gateway:8080/v1', 'worker-token'));
  expect(workerConfig).not.toContain('laptop');
  expect(workerConfig).not.toContain('android');
  expect(workerConfig).not.toContain('RELAY_KEY');
  expect(workerConfig).not.toContain('trycloudflare');
});

test('routing is explicit, validates credentials, and does not select Android when laptop is missing', () => {
  expect(resolveEgress({})).toEqual({ profile: 'direct' });
  if (laptop.profile === 'direct') throw new Error('Fixture profile');
  expect(() => resolveEgress({ REVIEWER_EGRESS_PROFILE: 'laptop', REVIEWER_ANDROID_RELAY_URL: laptop.url, REVIEWER_ANDROID_RELAY_KEY: 'b'.repeat(64) })).toThrow('not configured');
  for (const url of ['http://a.trycloudflare.com/', 'https://evil.test/', 'https://a.trycloudflare.com/path', 'https://a.trycloudflare.com/?secret=abc', 'https://user:pass@a.trycloudflare.com/', 'https://a.trycloudflare.com:444/']) {
    expect(() => EgressSchema.parse({ profile: 'laptop', url, key: 'a'.repeat(64) })).toThrow();
  }
  expect(egressEnvironment(laptop)).not.toContain('ANDROID');
});
test('selected relay receives inference and local SSE is reconstructed without direct provider traffic', async () => {
  let calls = 0;
  let verifies = 0;
  const handler = createGateway({ token: 'worker', egress: laptop, verify: async () => { verifies++; }, fetcher: async (url, init) => {
    calls++;
    expect(String(url)).toBe('https://laptop-fixture.trycloudflare.com/v1/relay');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-reviewer-relay-key')).toBe('a'.repeat(64));
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-reviewer-token')).toBeNull();
    expect(init?.redirect).toBe('error');
    return Response.json({ version: 1, status: 200, contentType: 'text/event-stream', bodyBase64: Buffer.from('data: [DONE]\n\n').toString('base64') });
  } });
  const response = await handler(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(await response.text()).toBe('data: [DONE]\n\n');
  expect(calls).toBe(1); expect(verifies).toBe(0);
});
test('upstream quota and offline device never trigger direct or Android fallback', async () => {
  for (const offline of [false, true]) {
    const destinations: string[] = [];
    const handler = createGateway({ token: 'worker', egress: laptop, fetcher: async (url) => {
      destinations.push(String(url));
      if (offline) throw new Error('offline');
      return Response.json({ version: 1, status: 429, contentType: 'application/json', bodyBase64: Buffer.from('{"error":"quota"}').toString('base64') });
    } });
    expect((await handler(request())).status).toBe(offline ? 503 : 429);
    expect(destinations).toEqual(['https://laptop-fixture.trycloudflare.com/v1/relay']);
  }
});
test('rejects malformed, oversized, and noncanonical response envelopes', async () => {
  if (laptop.profile === 'direct') throw new Error('Fixture profile');
  for (const response of [
    Response.json({ version: 1, status: 200, contentType: 'text/html', bodyBase64: '' }),
    Response.json({ version: 1, status: 200, contentType: 'application/json', bodyBase64: 'Zh==' }),
    new Response('x'.repeat(1500001)),
  ]) {
    await expect(throughRelay(laptop, '{}', new Headers(), async () => response)).rejects.toThrow();
  }
});
