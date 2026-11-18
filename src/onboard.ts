import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RepoSchema, ShaSchema, type GitHubClient } from './domain';

export const CALLER_PATH = '.github/workflows/opencode-reviewer.yml';
const SafeRepoSchema = RepoSchema.refine((repo) => repo.split('/').every((segment) => segment !== '.' && segment !== '..'), 'Unsafe repository');
const OptionsSchema = z.object({
  repo: SafeRepoSchema,
  reviewerRepo: SafeRepoSchema.default('ayman2ppp2/opencode-reviewer'),
  ref: ShaSchema,
  apply: z.boolean().default(false),
});
const CallerSchema = OptionsSchema.pick({ reviewerRepo: true, ref: true });
const RefSchema = z.object({ object: z.object({ sha: ShaSchema }) });
const ContentSchema = z.object({ type: z.literal('file'), encoding: z.literal('base64'), content: z.string() });
const PullSchema = z.object({ html_url: z.string().url() });
const ErrorSchema = z.object({ status: z.number() });

export function renderCaller(options: z.input<typeof CallerSchema>): string {
  const { reviewerRepo, ref } = CallerSchema.parse(options);
  return `name: OpenCode reviewer

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number
        required: true
        type: string
      egress_profile:
        description: Select one inference connection.
        type: choice
        default: configured
        options: [configured, direct, laptop, android]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: >-
      github.event_name != 'issue_comment' || github.event.issue.pull_request
    uses: ${reviewerRepo}/.github/workflows/review.yml@${ref}
    with:
      pr_number: \${{ github.event.inputs.pr_number || '' }}
      egress_profile: \${{ github.event.inputs.egress_profile || 'configured' }}
    secrets:
      REVIEWER_LAPTOP_RELAY_URL: \${{ secrets.REVIEWER_LAPTOP_RELAY_URL }}
      REVIEWER_LAPTOP_RELAY_KEY: \${{ secrets.REVIEWER_LAPTOP_RELAY_KEY }}
      REVIEWER_ANDROID_RELAY_URL: \${{ secrets.REVIEWER_ANDROID_RELAY_URL }}
      REVIEWER_ANDROID_RELAY_KEY: \${{ secrets.REVIEWER_ANDROID_RELAY_KEY }}
`;
}

function hasStatus(error: unknown, status: number): boolean {
  const parsed = ErrorSchema.safeParse(error);
  return parsed.success && parsed.data.status === status;
}

async function optionalGet(client: GitHubClient, path: string): Promise<unknown | undefined> {
  try {
    return await client.request('GET', path);
  } catch (error) {
    if (hasStatus(error, 404)) return undefined;
    throw error;
  }
}

function matches(content: unknown, workflow: string): boolean {
  const parsed = ContentSchema.safeParse(content);
  return parsed.success && Buffer.from(parsed.data.content, 'base64').toString('utf8') === workflow;
}

export async function onboard(
  client: GitHubClient,
  options: z.input<typeof OptionsSchema>,
): Promise<{ status: string; workflow: string; url?: string }> {
  const { repo, reviewerRepo, ref, apply } = OptionsSchema.parse(options);
  const workflow = renderCaller({ reviewerRepo, ref });
  if (!apply) return { status: 'dry-run', workflow };

  const root = `/repos/${repo}`;
  const repository = z.object({ default_branch: z.string().min(1) }).parse(await client.request('GET', root));
  const base = repository.default_branch;
  const baseRef = RefSchema.parse(await client.request('GET', `${root}/git/ref/heads/${base.split('/').map(encodeURIComponent).join('/')}`));
  const baseSha = baseRef.object.sha;
  const contentPath = `${root}/contents/${CALLER_PATH}`;
  const current = await optionalGet(client, `${contentPath}?ref=${baseSha}`);
  if (current !== undefined) return { status: matches(current, workflow) ? 'unchanged' : 'conflict', workflow };

  const digest = createHash('sha256').update(workflow).digest('hex').slice(0, 16);
  const branch = `opencode-reviewer/onboard-${digest}`;
  if (branch === base) return { status: 'conflict', workflow };
  const branchPath = `${root}/git/ref/heads/${branch}`;
  let branchRef = await optionalGet(client, branchPath);
  if (branchRef === undefined) {
    try {
      branchRef = await client.request('POST', `${root}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
    } catch (error) {
      if (!hasStatus(error, 422)) throw error;
      branchRef = await optionalGet(client, branchPath);
      if (branchRef === undefined) throw error;
    }
  }
  let branchSha = RefSchema.parse(branchRef).object.sha;
  const branchContent = await optionalGet(client, `${contentPath}?ref=${branchSha}`);
  if (branchContent === undefined) {
    if (branchSha !== baseSha) return { status: 'conflict', workflow };
    try {
      await client.request('PUT', contentPath, {
        message: 'ci: add pinned OpenCode reviewer',
        branch,
        content: Buffer.from(workflow).toString('base64'),
      });
      branchSha = RefSchema.parse(await client.request('GET', branchPath)).object.sha;
    } catch (error) {
      if (hasStatus(error, 409) || hasStatus(error, 422)) return { status: 'conflict', workflow };
      throw error;
    }
  } else if (!matches(branchContent, workflow)) {
    return { status: 'conflict', workflow };
  }

  // A matching file alone must not smuggle unrelated branch changes into the PR.
  const compare = z.object({
    status: z.literal('ahead'),
    files: z.array(z.object({ filename: z.string(), status: z.string() })).length(1),
  }).safeParse(await client.request('GET', `${root}/compare/${baseSha}...${branchSha}`));
  if (!compare.success || compare.data.files[0]?.filename !== CALLER_PATH || compare.data.files[0]?.status !== 'added') {
    return { status: 'conflict', workflow };
  }
  const head = `${repo.split('/')[0]}:${branch}`;
  const pulls = await client.paginate(`${root}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(base)}`);
  const existing = pulls[0];
  if (existing !== undefined) return { status: 'existing-pr', workflow, url: PullSchema.parse(existing).html_url };
  const pull = PullSchema.parse(await client.request('POST', `${root}/pulls`, {
    title: 'ci: add pinned OpenCode reviewer',
    head: branch,
    base,
    body: 'Add the shared OpenCode reviewer pinned to a full commit SHA. Uses only opencode/deepseek-v4.1-flash-free with no paid fallback. Review this workflow before merging. Direct mode requires no repository secrets. Optional device relays use explicitly forwarded secrets, never secrets: inherit.',
  }));
  return { status: 'created', workflow, url: pull.html_url };
}
