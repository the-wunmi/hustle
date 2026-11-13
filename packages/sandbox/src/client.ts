import { connect } from 'node:net';
import { z } from 'zod';
import { MAX_OUTPUT, type RunRequest, type RunResult } from './protocol.ts';
import { runPython } from './runner.ts';

/** What a sandbox reply must look like, whatever sent it. */
const RunResultSchema = z.object({
  ok: z.boolean(),
  stdout: z.string().max(MAX_OUTPUT),
  stderr: z.string().max(MAX_OUTPUT),
  error: z.string().max(400).nullable(),
  runMs: z.number().int().min(0),
  truncated: z.boolean(),
});

export interface Sandbox {
  /** `socket`: the isolated sandbox service; `local`: in this process (development only). */
  readonly mode: 'socket' | 'local';
  run(req: RunRequest): Promise<RunResult>;
}

/** Runs on the sandbox service over its Unix socket. */
export function socketSandbox(socketPath: string): Sandbox {
  return {
    mode: 'socket',
    run: (req) =>
      new Promise((resolve) => {
        const conn = connect(socketPath);
        let body = '';
        const fail = (error: string) =>
          resolve({ ok: false, stdout: '', stderr: '', error, runMs: 0, truncated: false });
        conn.setEncoding('utf8');
        conn.setTimeout(120_000, () => {
          conn.destroy();
          fail('unavailable');
        });
        conn.on('data', (chunk: string) => {
          body += chunk;
          // A reply can't be bigger than capped stdout and stderr plus their JSON escaping.
          if (body.length > MAX_OUTPUT * 16) {
            conn.destroy();
            fail('unavailable');
          }
        });
        conn.on('end', () => {
          const parsed = RunResultSchema.safeParse(
            (() => {
              try {
                return JSON.parse(body);
              } catch {
                return null;
              }
            })(),
          );
          if (parsed.success) resolve(parsed.data);
          else fail('unavailable');
        });
        conn.on('error', () => fail('unavailable'));
        conn.end(JSON.stringify(req));
      }),
  };
}

/**
 * The sandbox for this process: the isolated service when `SANDBOX_SOCKET` is set (the server), else
 * in-process worker threads (development, where nothing untrusted runs). Production refuses to run
 * without the service.
 */
export function createSandbox(env: Record<string, string | undefined>): Sandbox | null {
  if (env.SANDBOX_SOCKET) return socketSandbox(env.SANDBOX_SOCKET);
  if (env.NODE_ENV === 'production') return null;
  return { mode: 'local', run: runPython };
}
