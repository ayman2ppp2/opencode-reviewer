export async function runProcess(command: string[], options: {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
} = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  let failure: Error | undefined;
  const timeout = setTimeout(() => {
    failure = new Error('Process deadline exceeded');
    proc.kill(9);
  }, options.timeoutMs ?? 300000);
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > (options.maxBytes ?? 1000000)) {
        failure = new Error('Process output limit exceeded');
        proc.kill(9);
        break;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  };
  try {
    const [stdout, stderr, code] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
    if (failure) throw failure;
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    if (proc.exitCode === null) proc.kill(9);
  }
}
