import { describe, expect, test } from 'bun:test';
import { parseEngineOutput, trustedConfig } from '../src/engine';
import { createGateway, verifyFreeModel } from '../src/gateway';

describe('free inference boundaries', () => {
  test('rejects paid model and arbitrary destinations without fetching', async () => {
    let fetched = false;
    const handler = createGateway({ token: 'test', fetcher: async () => { fetched = true; return new Response(''); }, verify: async () => {} });
    const response = await handler(new Request('http://gateway/v1/chat/completions', { method: 'POST', headers: { 'x-reviewer-token': 'test' }, body: JSON.stringify({ model: 'deepseek-v4.1-flash' }) }));
    expect(response.status).toBe(403);
    expect(fetched).toBe(false);
    expect((await handler(new Request('http://gateway/https://evil.test', { headers: { 'x-reviewer-token': 'test' } }))).status).toBe(403);
  });
  test('bounds requests and strips credentials', async () => {
    let auth: string | null | undefined;
    const handler = createGateway({ token: 'test', maxRequests: 1, verify: async () => {}, fetcher: async (_url, options) => { auth = new Headers(options?.headers).get('authorization'); return new Response('ok'); } });
    const make = () => new Request('http://gateway/v1/chat/completions', { method: 'POST', headers: { 'x-reviewer-token': 'test', authorization: 'Bearer secret' }, body: JSON.stringify({ model: 'deepseek-v4.1-flash-free' }) });
    expect((await handler(make())).status).toBe(200);
    expect(auth).toBeNull();
    expect((await handler(make())).status).toBe(429);
  });
  test('checks actual pricing and fails closed on missing prices', async () => {
    await expect(verifyFreeModel(async () => Response.json({ data: [{ id: 'deepseek-v4.1-flash-free' }] }))).rejects.toThrow();
    await expect(verifyFreeModel(async () => Response.json({ data: [{ id: 'deepseek-v4.1-flash-free', cost: { text: { input: { price: 1 }, output: { price: 0 } } } }] }))).rejects.toThrow();
    await verifyFreeModel(async () => Response.json({ data: [{ id: 'deepseek-v4.1-flash-free', cost: { text: { input: { price: 0 }, output: { price: 0 } } } }] }));
  });
  test('denies all tools and pins auxiliary models', () => {
    const config = trustedConfig('http://gateway:8080/v1', 'test');
    expect(config.permissions).toEqual([{ action: '*', resource: '*', effect: 'deny' }]);
    expect(Object.values(config.agents).every((a) => a.model.endsWith('-free'))).toBe(true);
  });
  test('parses text events only and rejects inference errors', () => {
    const proposal = { summary: 'Checked supplied source.', walkthrough: [], findings: [] };
    expect(parseEngineOutput(JSON.stringify({ type: 'text', part: { text: JSON.stringify(proposal) } }))).toEqual(proposal);
    expect(() => parseEngineOutput(JSON.stringify({ type: 'error', error: { status: 429 } }))).toThrow();
    expect(() => parseEngineOutput(JSON.stringify({ type: 'text', part: { text: '{"summary":"x"}' } }))).toThrow();
  });
});
