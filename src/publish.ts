import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ResultSchema, ShaSchema, type GitHubClient, type ReviewRequest, type ReviewResult, type ReviewState, type SourceBundle } from './domain';
import { decodeState, encodeState, SUMMARY_MARKER, policyHash } from './state';
import { sanitizeMarkdown } from './validation';

const CommentSchema = z.object({ id: z.number().int().positive(), body: z.string().max(200000), user: z.object({ login: z.string() }) });
const PullSchema = z.object({ state: z.enum(['open', 'closed']), head: z.object({ sha: ShaSchema }), base: z.object({ sha: ShaSchema }) });
const IdSchema = z.object({ id: z.number().int().positive() });
const root = (request: ReviewRequest) => `/repos/${request.repo}`;
const issuePath = (request: ReviewRequest) => `${root(request)}/issues/${request.number}/comments`;
const pullPath = (request: ReviewRequest) => `${root(request)}/pulls/${request.number}`;

export async function readState(client: GitHubClient, request: ReviewRequest, botLogin = 'github-actions[bot]'): Promise<{ state: ReviewState | null; commentId: number | null }> {
  let latest: { state: ReviewState; commentId: number } | null = null;
  for (const value of await client.paginate(issuePath(request))) {
    const parsed = CommentSchema.safeParse(value);
    if (!parsed.success || parsed.data.user.login !== botLogin) continue;
    const state = decodeState(parsed.data.body, request);
    if (state && (!latest || parsed.data.id > latest.commentId)) latest = { state, commentId: parsed.data.id };
  }
  return latest ?? { state: null, commentId: null };
}

async function isCurrent(client: GitHubClient, request: ReviewRequest): Promise<boolean> {
  const pull = PullSchema.parse(await client.request('GET', pullPath(request)));
  return pull.state === 'open' && pull.head.sha === request.headSha && pull.base.sha === request.baseSha;
}

function initialState(request: ReviewRequest): ReviewState {
  return { version: 1, repo: request.repo, number: request.number, headSha: request.headSha, baseSha: request.baseSha, paused: false, fingerprints: [], events: [] };
}

function summaryBody(parts: string[], state: ReviewState): string {
  const footer = `\n\n${encodeState(state)}`;
  const available = 65000 - footer.length;
  if (available < 500) throw new Error('Review state exceeds safe comment size');
  const visible = parts.join('\n\n');
  return (visible.length <= available ? visible : `${visible.slice(0, available - 100)}\n\nDisplay truncated. Coverage details are incomplete; no clean-review conclusion is available.`) + footer;
}

async function writeSummary(client: GitHubClient, request: ReviewRequest, commentId: number | null, body: string): Promise<number | null> {
  if (!await isCurrent(client, request)) return null;
  const response = await client.request(commentId ? 'PATCH' : 'POST', commentId ? `${root(request)}/issues/comments/${commentId}` : issuePath(request), { body });
  return IdSchema.parse(response).id;
}

export async function publishReview(client: GitHubClient, bundle: SourceBundle, result: ReviewResult, { botLogin = 'github-actions[bot]' }: { botLogin?: string } = {}): Promise<{ status: string; summaryId?: number }> {
  const validated = ResultSchema.parse(result);
  if (bundle.request.mode === 'ask' || bundle.request.mode === 'summary') validated.findings = [];
  if (validated.status === 'complete' && (bundle.omissions.length || validated.rejected.length)) validated.status = 'partial';
  if (validated.status === 'superseded') return { status: 'superseded' };
  const request = bundle.request;
  if (!await isCurrent(client, request)) return { status: 'superseded' };
  const { state: previous, commentId } = await readState(client, request, botLogin);
  if (previous?.paused) return { status: 'paused', ...(commentId ? { summaryId: commentId } : {}) };
  const state = previous ?? initialState(request);
  const fingerprints = new Set(state.fingerprints);
  const eventKey = createHash('sha256').update(JSON.stringify([request.eventId, request.headSha, request.baseSha])).digest('hex').slice(0, 32);
  const eventMarker = `<!-- opencode-reviewer:event:${eventKey} -->`;
  let recoveredEvent = false;
  for (const value of await client.paginate(`${pullPath(request)}/comments`)) {
    const parsed = CommentSchema.safeParse(value);
    if (!parsed.success || parsed.data.user.login !== botLogin) continue;
    if (parsed.data.body.includes(eventMarker)) recoveredEvent = true;
    for (const match of parsed.data.body.matchAll(/<!-- opencode-reviewer:finding:([a-f0-9]{32}) -->/g)) {
      if (match[1]) fingerprints.add(match[1]);
    }
  }
  for (const value of await client.paginate(`${pullPath(request)}/reviews`)) {
    const parsed = CommentSchema.safeParse(value);
    if (parsed.success && parsed.data.user.login === botLogin && parsed.data.body.includes(eventMarker)) recoveredEvent = true;
  }
  if (state.events.includes(eventKey)) return { status: 'duplicate', ...(commentId ? { summaryId: commentId } : {}) };
  const comments = validated.findings.filter((finding) => !fingerprints.has(finding.fingerprint)).map((finding) => ({
    path: finding.path, line: finding.line, side: 'RIGHT',
    body: `**${sanitizeMarkdown(finding.severity)}: ${sanitizeMarkdown(finding.title)}**\n\n${sanitizeMarkdown(finding.body)}${finding.suggestion === undefined || /[\r\n`~<>@]/.test(finding.suggestion) || /!\[/.test(finding.suggestion) ? '' : `\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``}\n\n<!-- opencode-reviewer:finding:${finding.fingerprint} -->`,
  }));
  if (!recoveredEvent && (validated.status === 'complete' || validated.status === 'partial')) {
    if (!await isCurrent(client, request)) return { status: 'superseded' };
    if (request.mode === 'ask') {
      const priorAnswers = await client.paginate(issuePath(request));
      const answered = priorAnswers.some((value) => {
        const parsed = CommentSchema.safeParse(value);
        return parsed.success && parsed.data.user.login === botLogin && parsed.data.body.includes(eventMarker);
      });
      if (!answered) {
        if (!await isCurrent(client, request)) return { status: 'superseded' };
        await client.request('POST', request.replyTo ? `${pullPath(request)}/comments/${request.replyTo}/replies` : issuePath(request), { body: `${sanitizeMarkdown(validated.summary)}\n\n${eventMarker}` });
      }
    } else {
      await client.request('POST', `${pullPath(request)}/reviews`, {
        commit_id: request.headSha, event: 'COMMENT', body: `Automated review (${validated.status}). See the summary for coverage.\n\n${eventMarker}`, comments,
      });
    }
    for (const finding of validated.findings) fingerprints.add(finding.fingerprint);
  }
  const finalized = validated.status === 'complete' || validated.status === 'partial';
  const next: ReviewState = { ...state, headSha: request.headSha, baseSha: request.baseSha, fingerprints: [...fingerprints].slice(-1000), events: finalized ? [...state.events, eventKey].slice(-100) : state.events };
  if (validated.status === 'complete' && (request.mode === 'review' || request.mode === 'full')) {
    next.checkpoint = { headSha: request.headSha, baseSha: request.baseSha, policyHash: policyHash(bundle.config) };
  }
  const body = summaryBody([
    SUMMARY_MARKER, `## OpenCode review`,
    `Status: **${validated.status}**. This automated review is advisory, not an approval.`,
    `Coverage: conservative whole supplied diff, ${bundle.files.length} supplied files, ${bundle.omissions.length} omissions, ${validated.rejected.length} rejected claims. Incremental skipping is not used.`,
    `Related context: ${bundle.context?.length ?? 0} bounded local-import files. This is not a full-repository audit.`,
    ...(validated.status !== 'complete' || bundle.omissions.length || validated.rejected.length ? ['Review incomplete. No clean-review conclusion is available.'] : []),
    sanitizeMarkdown(validated.summary),
    ...validated.walkthrough.map((entry) => `- ${sanitizeMarkdown(entry.path)}: ${sanitizeMarkdown(entry.description)}`),
    ...bundle.omissions.map((entry) => `- Omitted: ${sanitizeMarkdown(entry)}`),
    ...validated.rejected.map((entry) => `- Rejected: ${sanitizeMarkdown(entry)}`),
    'Previously posted findings remain historical. Absence from this run does not resolve or dismiss them.',
  ], next);
  const summaryId = await writeSummary(client, request, commentId, body);
  return summaryId === null ? { status: 'superseded' } : { status: validated.status, summaryId };
}

export async function updateControl(client: GitHubClient, request: ReviewRequest, action: 'pause' | 'resume' | 'help', botLogin = 'github-actions[bot]'): Promise<{ status: string; summaryId?: number }> {
  if (!await isCurrent(client, request)) return { status: 'superseded' };
  const { state, commentId } = await readState(client, request, botLogin);
  const next = state ?? initialState(request);
  if (action !== 'help') next.paused = action === 'pause';
  const body = summaryBody([SUMMARY_MARKER, `OpenCode reviewer is ${next.paused ? 'paused' : 'enabled'}.`,
    'Commands: /opencode review, /opencode full, /opencode summary, /opencode pause, /opencode resume, /opencode help.',
    'Control update only. This is not a review or a clean-review conclusion.'], next);
  const summaryId = await writeSummary(client, request, commentId, body);
  return summaryId === null ? { status: 'superseded' } : { status: action, summaryId };
}
