import { createServer, type Server } from 'node:net';
import { MAX_INPUT, type RunRequest, type RunResult } from './protocol.ts';
import { runPython } from './runner.ts';

/**
 * The sandbox service: one JSON request per connection on a Unix socket, answered with one JSON
 * result. It runs in its own container with no network, so the socket on a shared volume is the
 * only way in. Runs at once are limited to the CPUs it has; a full queue is refused at once.
 */
export function serveSandbox(
  socketPath: string,
  opts: { concurrency?: number; queue?: number } = {},
): Server {
  const concurrency = opts.concurrency ?? 2;
  const maxQueue = opts.queue ?? 16;
  let active = 0;
  const waiting: (() => void)[] = [];
  const slot = async (): Promise<() => void> => {
    if (active >= concurrency) await new Promise<void>((r) => waiting.push(r));
    active += 1;
    return () => {
      active -= 1;
      waiting.shift()?.();
    };
  };
  // Half-open: the client ends its side after the request and waits for the answer.
  const server = createServer({ allowHalfOpen: true }, (conn) => {
    let body = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_INPUT * 2) conn.destroy();
    });
    conn.on('end', async () => {
      let result: RunResult;
      if (waiting.length >= maxQueue) {
        result = { ok: false, stdout: '', stderr: '', error: 'busy', runMs: 0, truncated: false };
      } else {
        const release = await slot();
        try {
          result = await runPython(JSON.parse(body) as RunRequest);
        } catch (err) {
          result = {
            ok: false,
            stdout: '',
            stderr: '',
            error: `bad_request: ${String(err).slice(0, 120)}`,
            runMs: 0,
            truncated: false,
          };
        } finally {
          release();
        }
      }
      conn.end(JSON.stringify(result));
    });
    conn.on('error', () => {});
  });
  server.listen(socketPath);
  return server;
}
