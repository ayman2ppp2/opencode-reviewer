import { GhClient } from '../src/github';
import { getPullRequest, loadConfig, collectSource } from '../src/source';
import { validateProposal } from '../src/validation';
import { publishReview } from '../src/publish';
import { z } from 'zod';

const client = new GhClient();
const repo = 'ayman2ppp2/opencode-reviewer';
const actor = z.object({ login: z.string() }).parse(await client.request('GET', '/user')).login;
const request = await getPullRequest(client, { repo, number: 1, actor, eventId: 'deterministic-publisher-fixture-v1', mode: 'full' });
const thread = process.argv.includes('--thread');
if (thread) {
  const Comment = z.object({ id: z.number().int().positive(), path: z.string(), body: z.string(), user: z.object({ login: z.string() }) });
  const comments = (await client.paginate(`/repos/${repo}/pulls/1/comments`)).map((value) => Comment.safeParse(value));
  const root = comments.find((value) => value.success && value.data.user.login === actor && value.data.path === 'examples/average-fixture.ts' && value.data.body.includes('opencode-reviewer:finding:'));
  if (!root?.success) throw new Error('Run the publisher fixture first');
  request.mode = 'ask';
  request.replyTo = root.data.id;
  request.eventId = 'deterministic-thread-fixture-v1';
}
const bundle = await collectSource(client, request, await loadConfig(client, request));
const file = bundle.files.find((entry) => entry.path === 'examples/average-fixture.ts');
const evidence = file?.content.split('\n')[2];
if (!file || !evidence?.includes('/ (values.length - 1)')) throw new Error('The intentional publisher fixture is not present');
const result = validateProposal(bundle, {
  summary: thread ? 'Deterministic native-thread reply fixture. This is not AI model output. The correct divisor is values.length, not values.length - 1.' : 'Deterministic publisher validation fixture. This is not AI model output. The seeded arithmetic defect validates real GitHub inline anchors, suggestion rendering, summary state, and retry deduplication.',
  walkthrough: [{ path: file.path, description: 'Intentionally defective arithmetic fixture. Do not merge.' }],
  findings: [{ path: file.path, line: 3, severity: 'high', title: 'Fixture: average divides by the wrong element count', body: 'Deterministic test finding, not AI output. Dividing by values.length - 1 returns infinity for one element and an incorrect average for larger inputs.', evidence,
    suggestion: '  return values.reduce(function(sum, value) { return sum + value; }, 0) / values.length;',
  }],
});
if (!process.argv.includes('--publish')) {
  process.stdout.write(`${JSON.stringify({ status: 'preview', result })}\n`);
} else {
  const first = await publishReview(client, bundle, result, { botLogin: actor });
  const retry = await publishReview(client, bundle, result, { botLogin: actor });
  if (first.status !== 'complete' && first.status !== 'duplicate') throw new Error('Fixture publication did not complete');
  if (retry.status !== 'duplicate') throw new Error('Fixture retry was not deduplicated');
  process.stdout.write(`${JSON.stringify({ first, retry, provenance: 'deterministic fixture; not model output' })}\n`);
}
