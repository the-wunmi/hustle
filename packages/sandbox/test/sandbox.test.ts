import { once } from 'node:events';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runPython, socketSandbox } from '../src/index.ts';
import { MAX_OUTPUT } from '../src/protocol.ts';
import { serveSandbox as serve } from '../src/server.ts';

process.env.SANDBOX_TEST_SECRET = 'do-not-leak';

const run = (code: string, files: Record<string, string> = {}, timeoutMs?: number) =>
  runPython({ code, files, ...(timeoutMs ? { timeoutMs } : {}) });

describe('the Python sandbox', () => {
  it('runs pandas on the files it was given', async () => {
    const r = await run(
      `import pandas as pd\ndf = pd.read_csv('holders.csv')\nprint(round(df.balance.max() / df.balance.sum(), 2))`,
      { 'holders.csv': 'account,balance\na,600\nb,400\n' },
    );
    expect(r).toMatchObject({ ok: true, error: null });
    expect(r.stdout.trim()).toBe('0.6');
  }, 60_000);

  it('reports a Python error by its last line', async () => {
    const r = await run('1/0');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ZeroDivisionError/);
  }, 60_000);

  it('has no way out: no JavaScript, no sockets, no HTTP, no subprocess, no secrets', async () => {
    for (const attempt of [
      'import js',
      'import pyodide_js',
      'import pyodide.code',
      'import socket',
      'import urllib.request',
      'import http.client',
      'import ctypes',
      'import subprocess',
    ]) {
      const r = await run(attempt);
      expect(r.ok, attempt).toBe(false);
      expect(r.error, attempt).toMatch(/not available in the sandbox|ModuleNotFoundError/);
    }
    const env = await run('import os\nprint(sorted(os.environ.items()))');
    expect(env.stdout).not.toContain('do-not-leak');
    expect(env.stdout).not.toMatch(/DATABASE_URL|HUSTLE_SECRET|NEARAI/);
  }, 120_000);

  it('holds when Python is escaped: the process can reach nothing (no commands, files or workers)', async () => {
    // The seal is defence in depth; these get past it, and the process boundary must still hold.
    const breakout = `
import sys
sys.meta_path.pop(0)
import _pyodide_core
p = _pyodide_core.to_js({}).constructor.constructor("return process")()
for label, fn in [('exec', lambda: p.getBuiltinModule('child_process').execSync('id')),
                  ('write', lambda: p.getBuiltinModule('fs').writeFileSync('/tmp/hustle-sandbox-pwn', 'x')),
                  ('read', lambda: p.getBuiltinModule('fs').readFileSync('/etc/hosts')),
                  ('worker', lambda: p.getBuiltinModule('worker_threads').Worker.new('1', {'eval': True}))]:
    try:
        fn(); print(label, 'WORKED')
    except Exception:
        print(label, 'blocked')
print('env', dict(p.env.object_entries()) if hasattr(p.env, 'object_entries') else 'empty')
`;
    const r = await run(breakout);
    expect(r.stdout).toContain('exec blocked');
    expect(r.stdout).toContain('write blocked');
    expect(r.stdout).toContain('read blocked');
    expect(r.stdout).toContain('worker blocked');
    expect(r.stdout).not.toContain('WORKED');
    expect(r.stdout).not.toContain('do-not-leak');
  }, 120_000);

  it('caps memory: a 1.5 GB allocation fails inside Python instead of taking the host down', async () => {
    const r = await run("b = b'x' * (1500 * 1024 * 1024)\nprint('allocated')");
    expect(r.ok).toBe(false);
    expect(r.stdout).not.toContain('allocated');
  }, 120_000);

  it('runs deterministically: the same code prints the same thing every time (fixed hash seed, UTC)', async () => {
    const code =
      "import time, random\nprint(set('abcdefghij'))\nprint(time.tzname, random.random())";
    const [a, b] = [await run(code), await run(code)];
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain('UTC');
  }, 120_000);

  it('keeps output written without a final newline', async () => {
    const r = await run("import sys\nsys.stdout.write('partial')");
    expect(r.stdout).toContain('partial');
  }, 60_000);

  it('stops a run that takes too long, and caps what it prints', async () => {
    const slow = await run('while True:\n    pass', {}, 1_500);
    expect(slow).toMatchObject({ ok: false, error: 'timeout' });
    const loud = await run(`print('x' * ${MAX_OUTPUT * 2})`);
    expect(loud.truncated).toBe(true);
    expect(loud.stdout.length).toBeLessThanOrEqual(MAX_OUTPUT);
  }, 120_000);

  it('refuses odd file names and oversized input before starting', async () => {
    expect(await run('print(1)', { '../etc/passwd': 'x' })).toMatchObject({
      error: 'bad_file_name',
    });
    expect(await run('print(1)', { 'big.txt': 'x'.repeat(2_100_000) })).toMatchObject({
      error: 'too_big',
    });
  });

  describe('as a service on a Unix socket', () => {
    // Unix socket paths are limited to about 104 bytes, so not under a long temp directory.
    const socket = join('/tmp', `hustle-sbx-${process.pid}.sock`);
    const server = serve(socket, { concurrency: 1 });
    afterAll(() => server.close());
    it('answers a run over the socket', async () => {
      if (!server.listening) await once(server, 'listening');
      const r = await socketSandbox(socket).run({ code: 'print(6 * 7)', files: {} });
      expect(r).toMatchObject({ ok: true });
      expect(r.stdout.trim()).toBe('42');
    }, 60_000);
  });
});
