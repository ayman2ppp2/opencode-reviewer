import { z } from 'zod';
import { parseDocument } from 'yaml';
import { BundleSchema, ConfigSchema, PathSchema, RepoSchema, RequestSchema, ShaSchema,
  type Config, type GitHubClient, type ReviewRequest, type SourceBundle } from './domain';
import { GhApiError } from './github';
import { posix } from 'node:path';
import { GitTreeGuard } from './git-tree';

const PullSchema = z.object({
  number: z.number().int().positive(), title: z.string(), body: z.string().nullable(), draft: z.boolean(),
  user: z.object({ login: z.string() }),
  base: z.object({ sha: ShaSchema, repo: z.object({ full_name: RepoSchema, private: z.boolean() }) }),
  head: z.object({ sha: ShaSchema }),
  changed_files: z.number().int().nonnegative().optional(),
});
const FileSchema = z.object({ filename: z.string().max(500), status: z.string().max(30), patch: z.string().optional(),
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() });
const ContentsSchema = z.object({ type: z.literal('file'), encoding: z.literal('base64'),
  content: z.string(), size: z.number().int().nonnegative() });

export async function getPullRequest(client: GitHubClient, input: {
  repo: string; number: number; actor?: string; mode?: ReviewRequest['mode']; question?: string; eventId?: string;
}): Promise<ReviewRequest> {
  const repo = RepoSchema.parse(input.repo);
  const number = z.number().int().positive().parse(input.number);
  const pr = PullSchema.parse(await client.request('GET', `/repos/${repo}/pulls/${number}`));
  if (pr.number !== number || pr.base.repo.full_name.toLowerCase() !== repo.toLowerCase()) throw new Error('Pull request repository mismatch');
  return RequestSchema.parse({ repo, number, baseSha: pr.base.sha, headSha: pr.head.sha, title: pr.title,
    body: pr.body ?? '', private: pr.base.repo.private, draft: pr.draft, actor: input.actor ?? pr.user.login,
    mode: input.mode ?? 'review', question: input.question ?? '', eventId: input.eventId ?? `manual-${pr.head.sha}` });
}

function decodeContents(value: unknown, limit: number): string {
  const file = ContentsSchema.parse(value);
  if (file.size > limit || file.content.length > Math.ceil(limit / 3) * 4 + 10000) throw new Error('File exceeds byte limit');
  const encoded = file.content.replace(/\n/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid base64 file');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== file.size || bytes.length > limit) throw new Error('File size mismatch or byte limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Binary file');
  return text;
}

function contentsPath(request: ReviewRequest, path: string, sha: string): string {
  return `/repos/${request.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`;
}

export async function loadConfig(client: GitHubClient, request: ReviewRequest): Promise<Config> {
  RequestSchema.parse(request);
  let value: unknown;
  try { value = await client.request('GET', contentsPath(request, '.opencode-reviewer.yml', request.baseSha)); }
  catch (error) {
    if (error instanceof GhApiError && error.status === 404) return ConfigSchema.parse({});
    throw error;
  }
  const text = decodeContents(value, 32000);
  const document = parseDocument(text, { uniqueKeys: true, strict: true });
  if (document.errors.length) throw new Error('Invalid reviewer YAML configuration');
  return ConfigSchema.parse(document.contents === null ? {} : document.toJS({ maxAliasCount: 0 }));
}

export function parseChangedLines(patch: string): number[] {
  const changed: number[] = [];
  let line = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let hunks = 0;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const text of lines) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(text);
    if (hunk) {
      if (oldRemaining || newRemaining) throw new Error('Truncated diff hunk');
      line = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1);
      newRemaining = Number(hunk[4] ?? 1);
      if (![line, oldRemaining, newRemaining].every(Number.isSafeInteger)) throw new Error('Invalid diff range');
      hunks++;
    } else if (text === '\\ No newline at end of file') {
      continue;
    } else if (hunks && text.startsWith('+')) {
      if (line < 1) throw new Error('Invalid added line');
      changed.push(line++);
      newRemaining--;
    } else if (hunks && text.startsWith('-')) {
      oldRemaining--;
    } else if (hunks && text.startsWith(' ')) {
      line++;
      oldRemaining--;
      newRemaining--;
    } else throw new Error('Invalid diff');
    if (oldRemaining < 0 || newRemaining < 0) throw new Error('Invalid diff hunk size');
  }
  if (!hunks || oldRemaining || newRemaining) throw new Error('Missing or truncated diff');
  return changed;
}

const sensitivePatterns = ['**/.env*', '**/*.{pem,key,p12,pfx}', '**/id_{rsa,dsa,ecdsa,ed25519}*',
  '**/AGENTS.md', '**/.opencode/**', '**/opencode.json*', '**/.opencode-reviewer.y{ml,aml}', '**/.git/**',
  '**/{node_modules,vendor,dist,build,coverage}/**', '**/{package-lock.json,bun.lock,bun.lockb,yarn.lock,pnpm-lock.yaml}'];

export async function collectSource(client: GitHubClient, request: ReviewRequest, config: Config): Promise<SourceBundle> {
  RequestSchema.parse(request);
  ConfigSchema.parse(config);
  const entries = z.array(FileSchema).max(3000).parse(await client.paginate(`/repos/${request.repo}/pulls/${request.number}/files`));
  const current = PullSchema.parse(await client.request('GET', `/repos/${request.repo}/pulls/${request.number}`));
  if (current.number !== request.number || current.base.repo.full_name.toLowerCase() !== request.repo.toLowerCase() ||
      current.head.sha !== request.headSha || current.base.sha !== request.baseSha) throw new Error('Pull request changed during source collection');
  const bundle: SourceBundle = { request, config, files: [], omissions: [] };
  if (current.changed_files !== undefined && current.changed_files !== entries.length) {
    bundle.omissions.push(`File listing incomplete: received ${entries.length} of ${current.changed_files} changed files`);
  }
  const globs = [...sensitivePatterns, ...config.exclude].map((pattern) => new Bun.Glob(pattern));
  let bytes = 0;
  const seen = new Set<string>();
  const tree = new GitTreeGuard(client, request.repo, request.headSha);
  for (const file of entries) {
    const omit = (reason: string) => bundle.omissions.push(`${file.filename}: ${reason}`.slice(0, 1000));
    if (!PathSchema.safeParse(file.filename).success || file.filename.split('/').some((part) => !part || /[%{}]/.test(part))) {
      omit('unsafe path'); continue;
    }
    if (seen.has(file.filename)) { omit('duplicate file'); continue; }
    seen.add(file.filename);
    if (globs.some((glob) => glob.match(file.filename))) { omit('excluded path'); continue; }
    if (bundle.files.length >= config.maxFiles) { omit('file limit'); continue; }
    if (!file.patch) { omit('missing patch, binary or truncated file'); continue; }
    const patchBytes = Buffer.byteLength(file.patch);
    if (file.patch.length > 200000 || bytes + patchBytes > config.maxSourceBytes) { omit('patch exceeds byte budget'); continue; }
    let changedLines: number[];
    try {
      changedLines = parseChangedLines(file.patch);
      const deletions = file.patch.split('\n').filter((line) => line.startsWith('-')).length;
      if (changedLines.length !== file.additions || deletions !== file.deletions) throw new Error('Truncated patch');
    } catch { omit('invalid or truncated patch'); continue; }
    let content = '';
    if (file.status !== 'removed') {
      try {
        if (!await tree.isRegularFile(file.filename)) { omit('not a regular Git blob; symlinks and submodules are excluded'); continue; }
        content = decodeContents(await client.request('GET', contentsPath(request, file.filename, request.headSha)),
          config.maxSourceBytes - bytes - patchBytes);
      } catch { omit('source unavailable, binary, invalid or over byte budget'); continue; }
    }
    bytes += patchBytes + Buffer.byteLength(content);
    bundle.files.push({ path: file.filename, status: file.status, patch: file.patch, content, changedLines });
  }
  const candidates = new Set<string>();
  for (const file of bundle.files) {
    for (const match of file.content.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"](\.[^'"\n]+)['"]/g)) {
      if (!match[1] || candidates.size >= 10) break;
      const path = posix.normalize(posix.join(posix.dirname(file.path), match[1]));
      if (PathSchema.safeParse(path).success && !path.split('/').some((p) => /[%{}]/.test(p)) && !globs.some((glob) => glob.match(path))) candidates.add(path);
    }
  }
  let attempts = 0;
  for (const candidate of candidates) {
    if (bundle.context?.length === 5 || bytes >= config.maxSourceBytes || attempts >= 15) break;
    const paths = posix.extname(candidate) ? [candidate] : [`${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`, `${candidate}/index.ts`];
    for (const path of paths) {
      if (seen.has(path) || globs.some((glob) => glob.match(path)) || attempts >= 15) continue;
      attempts++;
      try {
        if (!await tree.isRegularFile(path)) continue;
        const content = decodeContents(await client.request('GET', contentsPath(request, path, request.headSha)), config.maxSourceBytes - bytes);
        bundle.context ??= [];
        bundle.context.push({ path, content });
        seen.add(path);
        bytes += Buffer.byteLength(content);
        break;
      } catch { /* Related context is optional and never changes which diff files were reviewed. */ }
    }
  }
  return BundleSchema.parse(bundle);
}
