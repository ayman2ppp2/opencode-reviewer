import { parseArgs } from 'node:util';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { BundleSchema, ResultSchema, RepoSchema, ProposalSchema, type SourceBundle, type ReviewResult } from './domain';
import { GhClient } from './github';
import { collectSource, getPullRequest, loadConfig } from './source';
import { resolveTrigger, isMaintainer } from './events';
import { blockedResult, runEngine } from './engine';
import { validateProposal } from './validation';
import { publishReview, readState, updateControl } from './publish';
import { onboard } from './onboard';
import { runProcess } from './process';
import { policyHash } from './state';

const Help = `OpenCode reviewer (free models only)

Commands:
  build
  prepare --repo owner/repo --pr 1 --out .reviewer/bundle.json
  infer --input .reviewer/bundle.json --out .reviewer/result.json
  publish --input .reviewer/bundle.json --result .reviewer/result.json
  review --repo owner/repo --pr 1 [--publish]
  onboard --repo owner/repo --ref FULL_REVIEWER_SHA [--apply]

Review defaults to a local preview. Build the container first. Onboarding defaults
to a workflow preview. No paid models, provider keys, or billing setup are used.
`;

async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (file.size > 2000000) throw new Error('Input exceeds 2 MB');
  return file.json();
}

async function save(path: string, value: unknown) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function status(value: unknown) { process.stdout.write(`${JSON.stringify(value)}\n`); }

async function output(key: string, value: string) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

async function infer(bundle: SourceBundle): Promise<ReviewResult> {
  if (!bundle.files.length) return blockedResult('No reviewable source files were supplied. No clean-review conclusion is available.');
  try { return validateProposal(bundle, await runEngine(bundle)); }
  catch {
    return blockedResult('Free OpenCode inference is unavailable, exhausted, timed out, or returned invalid output. No paid fallback was attempted. No clean-review conclusion is available.');
  }
}

async function main() {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, strict: true, options: {
    repo: { type: 'string' }, pr: { type: 'string' }, input: { type: 'string' }, result: { type: 'string' }, out: { type: 'string' },
    publish: { type: 'boolean' }, apply: { type: 'boolean' }, ref: { type: 'string' }, 'reviewer-repo': { type: 'string' },
    'event-file': { type: 'string' }, 'event-name': { type: 'string' }, actor: { type: 'string' }, 'event-id': { type: 'string' }, help: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (!command || values.help) { process.stdout.write(Help); return; }
  const required = (value: string | undefined, name: string) => { if (!value) throw new Error(`${name} required`); return value; };
  const client = new GhClient();
  if (command === 'build') {
    const result = await runProcess(['docker', 'build', '-t', 'opencode-reviewer:local', '.'], { cwd: resolve(import.meta.dir, '..'), timeoutMs: 600000, maxBytes: 2000000 });
    if (result.code) throw new Error('Container build failed');
    status({ status: 'built', image: 'opencode-reviewer:local' }); return;
  }
  if (command === 'onboard') {
    status(await onboard(client, { repo: required(values.repo, '--repo'), reviewerRepo: values['reviewer-repo'], ref: required(values.ref, '--ref'), apply: values.apply ?? false })); return;
  }
  if (command === 'infer') {
    const bundle = BundleSchema.parse(await readJson(required(values.input, '--input')));
    const result = await infer(bundle);
    await save(required(values.out, '--out'), result); status({ status: result.status, findings: result.findings.length }); return;
  }
  if (command === 'publish') {
    const bundle = BundleSchema.parse(await readJson(required(values.input, '--input')));
    const result = ResultSchema.parse(await readJson(required(values.result, '--result')));
    if (bundle.request.commandActor && !await isMaintainer(client, bundle.request.repo, bundle.request.commandActor)) throw new Error('Command actor no longer authorized');
    if (['pause', 'resume', 'help'].includes(bundle.request.mode)) {
      const action = z.enum(['pause', 'resume', 'help']).parse(bundle.request.mode);
      if (!await isMaintainer(client, bundle.request.repo, bundle.request.actor)) throw new Error('Control actor no longer authorized');
      status(await updateControl(client, bundle.request, action)); return;
    }
    // Revalidate engine-controlled findings using the source bundle from the trusted preparation job.
    const revalidated = validateProposal(bundle, ProposalSchema.parse({ summary: result.summary, walkthrough: result.walkthrough, findings: result.findings.map(({ fingerprint: _, ...finding }) => finding) }));
    const safeResult: ReviewResult = result.status === 'blocked' || result.status === 'failed' || result.status === 'superseded'
      ? { ...result, findings: [], walkthrough: [] }
      : { ...revalidated, status: revalidated.status === 'partial' ? 'partial' : result.status, rejected: [...result.rejected, ...revalidated.rejected].slice(0, 100) };
    status(await publishReview(client, bundle, safeResult)); return;
  }
  if (command !== 'prepare' && command !== 'review') throw new Error('Unknown command');
  const repo = RepoSchema.parse(required(values.repo, '--repo'));
  const local = !values['event-name'];
  const actor = values.actor ?? (local ? z.object({ login: z.string() }).parse(await client.request('GET', '/user')).login : '');
  const eventName = values['event-name'] ?? 'local';
  const payload = values['event-file'] ? await readJson(values['event-file']) : {};
  const trigger = await resolveTrigger(client, { repo, actor, eventName, payload, prNumber: values.pr });
  if (trigger.kind === 'skip') { await output('eligible', 'false'); status(trigger); return; }
  const request = await getPullRequest(client, { repo, number: trigger.number, actor, mode: trigger.mode, question: trigger.question, eventId: values['event-id'] ?? `manual-${crypto.randomUUID()}` });
  if (trigger.replyTo) request.replyTo = trigger.replyTo;
  if (eventName === 'issue_comment' || eventName === 'pull_request_review_comment' || eventName === 'workflow_dispatch') request.commandActor = actor;
  const config = await loadConfig(client, request);
  if (request.private && !config.allowPrivate) { await output('eligible', 'false'); status({ status: 'skipped', reason: 'Private source requires allowPrivate: true on the base branch' }); return; }
  if (request.draft && !config.reviewDrafts) { await output('eligible', 'false'); status({ status: 'skipped', reason: 'Draft review disabled' }); return; }
  const { state } = await readState(client, request, local ? actor : undefined);
  const control = request.mode === 'pause' || request.mode === 'resume' || request.mode === 'help';
  if (state?.paused && !control) { await output('eligible', 'false'); status({ status: 'paused' }); return; }
  if (request.mode === 'review' && state?.checkpoint?.headSha === request.headSha && state.checkpoint.baseSha === request.baseSha && state.checkpoint.policyHash === policyHash(config)) {
    await output('eligible', 'false'); status({ status: 'unchanged', reason: 'This exact revision and policy already received a complete review. Use /opencode full to force a rerun.' }); return;
  }
  const bundle: SourceBundle = control ? { request, config, files: [], omissions: [] } : await collectSource(client, request, config);
  if (command === 'prepare') {
    await save(required(values.out, '--out'), bundle);
    await output('eligible', 'true'); await output('number', String(request.number)); await output('control', String(control));
    status({ status: 'prepared', files: bundle.files.length, omissions: bundle.omissions.length }); return;
  }
  if (control) {
    if (values.publish) status(await updateControl(client, request, z.enum(['pause', 'resume', 'help']).parse(request.mode), actor));
    else status({ status: 'preview', mode: request.mode });
    return;
  }
  const result = await infer(bundle);
  if (values.publish) status(await publishReview(client, bundle, result, { botLogin: actor }));
  else status(result);
}

if (import.meta.main) {
  main().catch(() => {
    process.stderr.write('Reviewer operation failed. Check configuration, permissions, and bounded inputs. Secrets and source are not logged.\n');
    process.exitCode = 1;
  });
}
