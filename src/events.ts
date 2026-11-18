import { z } from 'zod';
import { RepoSchema, type GitHubClient, type ReviewRequest } from './domain';

type Trigger = { kind: 'run'; number: number; mode: ReviewRequest['mode']; question: string; replyTo?: number } | { kind: 'skip'; reason: string };
const NumberSchema = z.coerce.number().int().positive();
const CommentSchema = z.object({ id: z.number().int().positive(), body: z.string().max(20000), user: z.object({ login: z.string() }) });
const PermissionSchema = z.object({ permission: z.string() });

export async function isMaintainer(client: GitHubClient, repo: string, actor: string): Promise<boolean> {
  RepoSchema.parse(repo);
  if (!/^[A-Za-z0-9-]{1,100}$/.test(actor)) return false;
  try {
    const permission = PermissionSchema.parse(await client.request('GET', `/repos/${repo}/collaborators/${actor}/permission`));
    return ['admin', 'maintain', 'write'].includes(permission.permission);
  } catch { return false; }
}

export async function resolveTrigger(client: GitHubClient, options: {
  repo: string; actor: string; eventName: string; payload: unknown; prNumber?: string;
}): Promise<Trigger> {
  const { repo, actor, eventName } = options;
  RepoSchema.parse(repo);
  if (eventName === 'workflow_dispatch' || eventName === 'local') {
    if (!await isMaintainer(client, repo, actor)) return { kind: 'skip', reason: 'Maintainer authorization required' };
    const number = NumberSchema.parse(options.prNumber);
    return { kind: 'run', number, mode: 'review', question: '' };
  }
  if (eventName === 'pull_request_target') {
    const event = z.object({ action: z.enum(['opened', 'synchronize', 'reopened', 'ready_for_review']), number: NumberSchema,
      pull_request: z.object({ head: z.object({ repo: z.object({ full_name: RepoSchema }).nullable() }) }),
    }).safeParse(options.payload);
    if (!event.success) return { kind: 'skip', reason: 'Unsupported PR event' };
    if (event.data.pull_request.head.repo?.full_name !== repo) return { kind: 'skip', reason: 'Fork PRs require a maintainer /opencode review command' };
    return { kind: 'run', number: event.data.number, mode: 'review', question: '' };
  }
  if (eventName === 'issue_comment' || eventName === 'pull_request_review_comment') {
    const common = z.object({ action: z.literal('created'), comment: CommentSchema }).safeParse(options.payload);
    if (!common.success || common.data.comment.user.login !== actor || actor.endsWith('[bot]')) return { kind: 'skip', reason: 'Not a supported user comment' };
    const command = /^\/opencode\s+(review|full|summary|help|pause|resume|ask)(?:\s+([\s\S]{1,4000}))?\s*$/.exec(common.data.comment.body.trim());
    if (!command) return { kind: 'skip', reason: 'Not an OpenCode command' };
    if (!await isMaintainer(client, repo, actor)) return { kind: 'skip', reason: 'Maintainer authorization required' };
    const mode = z.enum(['review', 'full', 'summary', 'help', 'pause', 'resume', 'ask']).parse(command[1]);
    if (mode !== 'ask' && command[2]?.trim()) return { kind: 'skip', reason: 'Unexpected command arguments' };
    if (mode === 'ask' && !command[2]?.trim()) return { kind: 'skip', reason: 'Ask requires a question' };
    let number: number;
    let context = '';
    if (eventName === 'issue_comment') {
      const event = z.object({ issue: z.object({ number: NumberSchema, pull_request: z.object({}).passthrough() }) }).safeParse(options.payload);
      if (!event.success) return { kind: 'skip', reason: 'Command is not on a PR' };
      number = event.data.issue.number;
      if (mode === 'ask') {
        const comments = await client.paginate(`/repos/${repo}/issues/${number}/comments`);
        context = comments.slice(-5).map((value) => CommentSchema.safeParse(value)).filter((v) => v.success).map((v) => v.data.body.slice(0, 500)).join('\n');
      }
    } else {
      const event = z.object({ pull_request: z.object({ number: NumberSchema }), comment: CommentSchema.extend({ in_reply_to_id: z.number().int().positive().optional() }) }).parse(options.payload);
      number = event.pull_request.number;
      if (mode === 'ask') {
        const id = event.comment.in_reply_to_id ?? event.comment.id;
        const parent = CommentSchema.extend({ diff_hunk: z.string().optional(), path: z.string().optional() }).parse(await client.request('GET', `/repos/${repo}/pulls/comments/${id}`));
        context = `Thread comment: ${parent.body.slice(0, 1200)}\nPath: ${parent.path ?? ''}\nDiff: ${(parent.diff_hunk ?? '').slice(0, 1000)}`;
      }
    }
    return { kind: 'run', number, mode, question: mode === 'ask' ? `${command[2]?.trim()}\nUntrusted conversation context:\n${context}`.slice(0, 4000) : '', ...(eventName === 'pull_request_review_comment' && mode === 'ask' ? { replyTo: z.object({ comment: z.object({ in_reply_to_id: z.number().int().positive().optional(), id: z.number().int().positive() }) }).parse(options.payload).comment.in_reply_to_id ?? common.data.comment.id } : {}) };
  }
  return { kind: 'skip', reason: 'Unsupported trigger' };
}
