import { createHash } from 'node:crypto';
import { StateSchema, type ReviewState, type Config } from './domain';

export function policyHash(config: Config): string {
  return createHash('sha256').update(JSON.stringify({ version: 1, config })).digest('hex');
}

export const SUMMARY_MARKER = '<!-- opencode-reviewer:summary:v1 -->';
const PREFIX = '<!-- opencode-reviewer:state:v1:';

export function encodeState(state: ReviewState): string {
  const parsed = StateSchema.parse(state);
  return `${PREFIX}${Buffer.from(JSON.stringify(parsed)).toString('base64')} -->`;
}

export function decodeState(body: string, expected: Pick<ReviewState, 'repo' | 'number'>): ReviewState | null {
  if (body.length > 200000 || !body.includes(SUMMARY_MARKER)) return null;
  const matches = [...body.matchAll(/<!-- opencode-reviewer:state:v1:([A-Za-z0-9+/=]{1,100000}) -->/g)];
  if (matches.length !== 1) return null;
  const encoded = matches[0]?.[1];
  if (!encoded) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    const parsed = StateSchema.safeParse(data);
    if (!parsed.success || parsed.data.repo !== expected.repo || parsed.data.number !== expected.number) return null;
    return parsed.data;
  } catch { return null; }
}
