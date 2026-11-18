import { z } from 'zod';

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const RelayURL = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && /^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash && (!url.port || url.port === '443')
    && url.pathname === '/';
}, 'Expected a root HTTPS Quick Tunnel URL without credentials or query parameters');
const RelayKey = z.string().regex(/^[a-f0-9]{64}$/);
export const EgressSchema = z.discriminatedUnion('profile', [
  z.object({ profile: z.literal('direct') }).strict(),
  z.object({ profile: z.enum(['laptop', 'android']), url: RelayURL, key: RelayKey }).strict(),
]);
export type Egress = z.infer<typeof EgressSchema>;

export function resolveEgress(env: Record<string, string | undefined>): Egress {
  try {
    const profile = z.enum(['direct', 'laptop', 'android']).parse(env.REVIEWER_EGRESS_PROFILE || 'direct');
    if (profile === 'direct') return { profile };
    const prefix = profile === 'laptop' ? 'REVIEWER_LAPTOP_RELAY' : 'REVIEWER_ANDROID_RELAY';
    return EgressSchema.parse({ profile, url: env[`${prefix}_URL`], key: env[`${prefix}_KEY`] });
  } catch {
    throw new Error('Selected device relay is not configured correctly');
  }
}

export function egressEnvironment(egress: Egress): string {
  if (egress.profile === 'direct') return 'REVIEWER_EGRESS_PROFILE=direct\n';
  const prefix = egress.profile === 'laptop' ? 'REVIEWER_LAPTOP_RELAY' : 'REVIEWER_ANDROID_RELAY';
  return `REVIEWER_EGRESS_PROFILE=${egress.profile}\n${prefix}_URL=${egress.url}\n${prefix}_KEY=${egress.key}\n`;
}

const EnvelopeSchema = z.object({
  version: z.literal(1),
  status: z.number().int().min(200).max(599),
  contentType: z.string().max(150).refine((value) => /^(application\/json|text\/event-stream)(?:;[ -~]*)?$/.test(value)),
  bodyBase64: z.string().max(1400000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();

async function readEnvelope(response: Response): Promise<z.infer<typeof EnvelopeSchema>> {
  if (!response.ok || !response.body) throw new Error('Selected relay unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1500000) throw new Error('Relay envelope exceeds limit');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return EnvelopeSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export async function throughRelay(egress: Exclude<Egress, { profile: 'direct' }>, body: string, sourceHeaders: Headers, fetcher: Fetcher = fetch): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json', 'x-reviewer-relay-key': egress.key });
  for (const [name, value] of sourceHeaders) {
    if (name === 'user-agent' || name.startsWith('x-opencode-')) headers.set(name, value);
  }
  const response = await fetcher(`${new URL(egress.url).origin}/v1/relay`, {
    method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(110000),
  });
  const envelope = await readEnvelope(response);
  const bytes = Buffer.from(envelope.bodyBase64, 'base64');
  if (bytes.length > 1000000 || bytes.toString('base64') !== envelope.bodyBase64) throw new Error('Invalid relay response');
  const empty = [204, 205, 304].includes(envelope.status);
  if (empty && bytes.length) throw new Error('Invalid empty-status response');
  return new Response(empty ? null : bytes, { status: envelope.status, headers: { 'content-type': envelope.contentType } });
}
