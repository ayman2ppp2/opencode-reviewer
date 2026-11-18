import { GhClient } from '../src/github';
import { getPullRequest, loadConfig, collectSource } from '../src/source';
import { validateProposal } from '../src/validation';
import { publishReview } from '../src/publish';
import { z } from 'zod';

const client = new GhClient();
const repo = 'ayman2ppp2/opencode-reviewer';
const actor = z.object({ login: z.string() }).parse(await client.request('GET', '/user')).login;
const request = await getPullRequest(client, { repo, number: 1, actor, eventId: 'deterministic-publisher-fixture-v1', mode: 'full' });
const bundle = await collectSource(client, request, await loadConfig(client, request));
const file = bundle.files.find((entry) => entry.path === 'examples/average-fixture.ts');
const evidence = file?.content.split('\n')[2];
if (!file || !evidence?.includes('/ (values.length - 1)')) throw new Error('The intentional publisher fixture is not present');
const result = validateProposal(bundle, {
  summary: 'Deterministic publisher validation fixture. This is not AI model output. The seeded arithmetic defect validates real GitHub inline anchors, suggestion rendering, summary state, and retry deduplication.',
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
