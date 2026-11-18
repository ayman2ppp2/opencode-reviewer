import { mkdir, writeFile } from 'node:fs/promises';
import { trustedConfig } from './engine';
import { runProcess } from './process';

const token = process.env.REVIEWER_GATEWAY_TOKEN;
if (!token) throw new Error('Gateway token required');
await mkdir('/tmp/home/.config/opencode', { recursive: true });
await mkdir('/tmp/work', { recursive: true });
await writeFile('/tmp/home/.config/opencode/opencode.json', JSON.stringify(trustedConfig('http://gateway:8080/v1', token)));
const result = await runProcess(['/app/node_modules/.bin/opencode', '--standalone', 'run', '--model', 'opencode/deepseek-v4.1-flash-free', '--agent', 'reviewer', '--title', 'PR review', '--format', 'json', '--file', '/input/prompt.txt', 'Review the attached text. Return the requested JSON. No tools.'], {
  cwd: '/tmp/work',
  env: { HOME: '/tmp/home', PATH: '/usr/local/bin:/usr/bin:/bin', OPENCODE_DISABLE_FREE_MODELS: '0' },
  timeoutMs: 240000,
});
process.stdout.write(result.stdout);
if (result.code !== 0) process.stderr.write('Free OpenCode inference unavailable. No paid fallback.\n');
process.exitCode = result.code;
