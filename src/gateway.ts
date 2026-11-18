import { z } from 'zod';

export const FREE_MODEL_ID = 'deepseek-v4.1-flash-free';
const PriceSchema = z.object({ price: z.literal(0), cache: z.object({ read: z.literal(0) }).optional() });
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const CatalogSchema = z.object({ data: z.array(z.object({
  id: z.string(),
  cost: z.object({ text: z.object({ input: PriceSchema, output: PriceSchema }) }).optional(),
}).passthrough()) });

export async function verifyFreeModel(fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher('https://opencode.ai/inference/v1/models', { signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw new Error('Cannot verify current free model pricing');
  // Paid catalog entries must not invalidate the entire catalog.
  const raw = z.object({ data: z.array(z.object({ id: z.string() }).passthrough()) }).parse(await response.json());
  const model = raw.data.find((entry) => entry.id === FREE_MODEL_ID);
  if (!model) throw new Error('Free model is no longer listed');
  CatalogSchema.parse({ data: [model] });
  if (!('cost' in model) || !model.cost) throw new Error('Free model pricing is unknown');
}

export function createGateway(options: { token: string; maxRequests?: number; fetcher?: Fetcher; verify?: () => Promise<void> }) {
  let requests = 0;
  return async (request: Request): Promise<Response> => {
    if (request.headers.get('x-reviewer-token') !== options.token) return new Response('Forbidden', { status: 403 });
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions' || url.search) return new Response('Route denied', { status: 403 });
    if (requests >= (options.maxRequests ?? 2)) return new Response('Review inference budget exhausted', { status: 429 });
    requests += 1;
    try {
      const body = await request.text();
      if (Buffer.byteLength(body) > 1500000) return new Response('Request too large', { status: 413 });
      const parsed = z.object({ model: z.literal(FREE_MODEL_ID), stream: z.boolean().optional() }).passthrough().safeParse(JSON.parse(body));
      if (!parsed.success) return new Response('Only the explicitly free model is allowed', { status: 403 });
      await (options.verify ?? verifyFreeModel)();
      const headers = new Headers({ 'content-type': 'application/json' });
      for (const [name, value] of request.headers) {
        if (name === 'user-agent' || name.startsWith('x-opencode-') || name === 'x-anomaly-' || name === 'authorization') headers.set(name, value);
      }
      // Free-only isolated processes carry no Console key. Never forward a caller-supplied paid credential.
      headers.delete('authorization');
      const response = await (options.fetcher ?? fetch)('https://opencode.ai/inference/openai/v1/chat/completions', {
        method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(240000),
      });
      return new Response(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } });
    } catch {
      return new Response('Free inference unavailable; no paid fallback', { status: 503 });
    }
  };
}

if (import.meta.main) {
  const token = process.env.REVIEWER_GATEWAY_TOKEN;
  if (!token) throw new Error('Gateway token required');
  const handler = createGateway({ token });
  Bun.serve({ port: 8080, hostname: '0.0.0.0', maxRequestBodySize: 1500000, idleTimeout: 255, fetch: handler });
}
