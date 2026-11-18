import { spawn } from 'node:child_process';
import type { GitHubClient } from './domain';

export class GhApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GhApiError';
  }
}

function validateEndpoint(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || path.length > 4000 || /[\s\\#{}\x00-\x1f\x7f]/.test(path)) {
    throw new Error('Expected a GitHub API relative path');
  }
  const [pathname] = path.split('?');
  for (const segment of (pathname ?? '').slice(1).split('/')) {
    const decoded = decodeURIComponent(segment);
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/\x00-\x1f\x7f%]/.test(decoded)) {
      throw new Error('Unsafe GitHub API path');
    }
  }
  if (path.split('?').length > 2) throw new Error('Invalid API query');
}

export class GhClient implements GitHubClient {
  private readonly executable: string;
  private readonly maxOutputBytes: number;
  private readonly timeoutMs: number;

  constructor(options: { executable?: string; maxOutputBytes?: number; timeoutMs?: number } = {}) {
    this.executable = options.executable ?? 'gh';
    this.maxOutputBytes = options.maxOutputBytes ?? 8_000_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes < 1 || this.maxOutputBytes > 8_000_000 ||
        !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new Error('Invalid GitHub transport limits');
    }
  }

  async request(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    validateEndpoint(path);
    if (!['GET', 'POST', 'PATCH', 'PUT'].includes(method)) throw new Error('Unsupported API method');
    const input = body === undefined ? undefined : JSON.stringify(body);
    if (input !== undefined && Buffer.byteLength(input) > this.maxOutputBytes) throw new Error('GitHub input exceeds limit');
    const args = ['api', '--hostname', 'github.com', '--method', method, '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2022-11-28'];
    if (input !== undefined) args.push('--input', '-');
    args.push('--', path);
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      const fail = (error: Error) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => fail(new Error('GitHub API request timed out')), this.timeoutMs);
      const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > this.maxOutputBytes) fail(new Error('GitHub API output exceeds limit'));
        else chunks.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.stdin.on('error', () => { /* The exit status reports a closed gh input pipe. */ });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) return reject(failure);
        if (code !== 0) {
          const match = Buffer.concat(stderr).toString('utf8').match(/\bHTTP (\d{3})\b/);
          const status = match?.[1] ? Number(match[1]) : undefined;
          return reject(new GhApiError(`GitHub API request failed${status ? ` (HTTP ${status})` : ''}`, status));
        }
        const text = Buffer.concat(stdout).toString('utf8');
        try { resolve(text.trim() === '' ? null : JSON.parse(text)); }
        catch { reject(new Error('GitHub API returned invalid JSON')); }
      });
      child.stdin.end(input);
    });
  }

  async paginate(path: string): Promise<unknown[]> {
    validateEndpoint(path);
    const url = new URL(path, 'https://api.github.com');
    if (url.searchParams.has('page') || url.searchParams.has('per_page')) throw new Error('Pagination parameters are managed by GhClient');
    const result: unknown[] = [];
    let bytes = 0;
    for (let page = 1; page <= 30; page++) {
      url.searchParams.set('per_page', '100');
      url.searchParams.set('page', String(page));
      const value = await this.request('GET', `${url.pathname}${url.search}`);
      if (!Array.isArray(value) || value.length > 100) throw new Error('Expected a paginated API array');
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (bytes > this.maxOutputBytes) throw new Error('GitHub pagination output exceeds limit');
      result.push(...value);
      if (value.length < 100) return result;
    }
    throw new Error('GitHub pagination exceeds 30 pages');
  }
}
