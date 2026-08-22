import { describe, expect, test } from 'bun:test';
import { join } from 'path';

// config.ts reads LOG_LEVEL once at module load, and the crash this guards
// against happened *inside* that load — pino throwing on an unrecognized level
// before anything could catch it. Re-importing in-process can't reproduce that
// (the module is already evaluated), so each case gets its own subprocess.
const ENTRY = join(import.meta.dir, '../../src/utils/logger.ts');

async function bootWith(logLevel: string) {
  const proc = Bun.spawn(
    ['bun', '-e', `import { log } from ${JSON.stringify(ENTRY)}; log.info('booted');`],
    { env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: logLevel }, stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('LOG_LEVEL handling', () => {
  test('an unrecognized value warns and falls back instead of killing the process', async () => {
    const { exitCode, stderr } = await bootWith('verbose');

    // The regression: this used to throw inside pino() at import time, so a typo
    // in `fly secrets set LOG_LEVEL` crash-looped every machine.
    expect(exitCode).toBe(0);
    expect(stderr).toContain('unrecognized LOG_LEVEL');
    expect(stderr).toContain('booted');
  });

  test('a valid value is honoured and warns about nothing', async () => {
    const { exitCode, stderr } = await bootWith('warn');

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('unrecognized LOG_LEVEL');
    // 'booted' is logged at info, which `warn` suppresses.
    expect(stderr).not.toContain('booted');
  });

  test('case and surrounding whitespace are tolerated', async () => {
    const { exitCode, stderr } = await bootWith('  INFO  ');

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('unrecognized LOG_LEVEL');
    expect(stderr).toContain('booted');
  });

  test('nothing reaches stdout, which is the MCP JSON-RPC channel', async () => {
    const { stdout } = await bootWith('info');

    expect(stdout).toBe('');
  });
});
