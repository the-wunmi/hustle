import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_INPUT,
  MAX_OUTPUT,
  MAX_TIMEOUT_MS,
  PACKAGES,
  type RunRequest,
  type RunResult,
} from './protocol.ts';

/** Start-up allowance on top of the run's own limit: starting Node, Pyodide and the packages. */
const BOOT_MS = 30_000;
/** WebAssembly memory a run may use, in 64 KiB pages (512 MiB): Python's whole heap. */
const WASM_PAGES = 8_192;
/** Most bytes a run's process may print (its result line carries capped stdout and stderr). */
const MAX_PROCESS_OUTPUT = MAX_OUTPUT * 4;

// Real paths: the permission model compares them after symlinks are resolved (pnpm links packages).
const childScript = realpathSync(fileURLToPath(new URL('./child.mjs', import.meta.url)));
const pyodideDir = realpathSync(
  dirname(createRequire(import.meta.url).resolve('pyodide/package.json')),
);

const failed = (error: string): RunResult => ({
  ok: false,
  stdout: '',
  stderr: '',
  error,
  runMs: 0,
  truncated: false,
});

/** The name the sandbox can open: letters, digits, `._-`, not `.` or `..`. */
const isRunFileName = (name: string) => /^[\w.-]{1,80}$/.test(name) && !/^\.+$/.test(name);

/**
 * Runs Python in a fresh process under Node's permission model: it may read only Pyodide's files and
 * its own script (no writes, no child processes, no workers, no addons), with WebAssembly memory
 * capped, an empty environment, and a hard kill at the time limit. A run that gets past the Python
 * seal still can't touch anything; on a server the sandbox container also has no network.
 */
export function runPython(req: RunRequest): Promise<RunResult> {
  const size = req.code.length + Object.values(req.files).reduce((t, f) => t + f.length, 0);
  if (size > MAX_INPUT) return Promise.resolve(failed('too_big'));
  if (!Object.keys(req.files).every(isRunFileName)) return Promise.resolve(failed('bad_file_name'));
  const timeoutMs = Math.min(req.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--permission',
        `--allow-fs-read=${pyodideDir}`,
        `--allow-fs-read=${childScript}`,
        `--wasm-max-mem-pages=${WASM_PAGES}`,
        '--max-old-space-size=256',
        childScript,
        pyodideDir,
        String(MAX_OUTPUT),
      ],
      { env: {}, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let out = '';
    let ready = false;
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(result);
    };
    // Until Python is up, the boot allowance; then the run's own limit.
    let timer = setTimeout(() => finish(failed('timeout')), BOOT_MS + timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      if (out.length > MAX_PROCESS_OUTPUT) finish(failed('too_big'));
      if (!ready && out.startsWith('READY\n')) {
        ready = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish(failed('timeout')), timeoutMs);
      }
    });
    child.on('error', () => finish(failed('crashed')));
    child.on('close', () => {
      const line = out.split('\n').filter(Boolean).at(-1) ?? '';
      try {
        const r = JSON.parse(line) as Omit<RunResult, 'ok'>;
        if (typeof r.stdout !== 'string' || typeof r.runMs !== 'number') throw new Error('shape');
        finish({
          ok: r.error === null,
          stdout: r.stdout.slice(0, MAX_OUTPUT),
          stderr: String(r.stderr ?? '').slice(0, MAX_OUTPUT),
          error: r.error === null ? null : String(r.error).slice(0, 300),
          runMs: r.runMs,
          truncated: Boolean(r.truncated),
        });
      } catch {
        finish(failed('crashed'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ code: req.code, files: req.files, packages: PACKAGES }));
  });
}
