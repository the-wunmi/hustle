'use client';

import type { JobView, SandboxRunView } from '@hustle/core/browser';
import { useState } from 'react';
import { fmt } from '@/lib/money';
import { Badge, Button, Panel } from '../ui';

const SOURCE_LABEL = (source: string) =>
  source === 'client'
    ? 'attached by the client'
    : source === 'agent'
      ? 'written by the agent'
      : `fetched by ${source.replace('tool:', '').replace('_', ' ')}`;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Run outcomes that come from the sandbox, not the code. */
const INFRA_ERRORS = new Set([
  'timeout',
  'crashed',
  'too_big',
  'busy',
  'unavailable',
  'bad_file_name',
]);

/** How long a re-run may take, Python's download included. */
const RERUN_TIMEOUT_MS = 120_000;

/**
 * Runs code in a throwaway sandboxed frame (`sandbox="allow-scripts"`, no same-origin): an opaque
 * origin, so the agent's code can't read this page, use its cookies or call the API as the viewer.
 * The frame gets the code and the files and sends back only what the program printed.
 */
function runIsolated(code: string, files: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = '/rerun/runner.html';
    frame.hidden = true;
    const id = crypto.randomUUID();
    const done = (fn: () => void) => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      frame.remove();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error('timed out'))), RERUN_TIMEOUT_MS);
    function onMessage(event: MessageEvent) {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as { ready?: boolean; id?: string; stdout?: string; error?: string };
      if (data.ready) {
        frame.contentWindow?.postMessage({ id, code, files }, '*');
        return;
      }
      if (data.id !== id) return;
      if (typeof data.stdout === 'string') {
        const stdout = data.stdout;
        done(() => resolve(stdout));
      } else done(() => reject(new Error(data.error ?? 'the run failed')));
    }
    window.addEventListener('message', onMessage);
    document.body.appendChild(frame);
  });
}

/**
 * Re-runs one of the agent's sandbox runs in this browser on the job's files: the same code and
 * inputs must print the same output, byte for byte (compared by sha256). The page fetches the files
 * and checks their hashes; the code itself runs only in the isolated frame.
 */
async function rerun(
  jobId: string,
  run: SandboxRunView & { code: string },
): Promise<{ same: boolean; stdout: string }> {
  const files: Record<string, string> = {};
  for (const name of Object.keys(run.inputs)) {
    const res = await fetch(`/api/jobs/${jobId}/files/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Couldn't load ${name}`);
    const text = await res.text();
    if ((await sha256Hex(text)) !== run.inputs[name])
      throw new Error(`${name} has changed since the run`);
    files[name] = text;
  }
  const stdout = await runIsolated(run.code, files);
  return { same: (await sha256Hex(stdout)) === run.stdoutHash, stdout };
}

function RunCard({ jobId, run }: { jobId: string; run: SandboxRunView }) {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'done'; same: boolean; stdout: string }
    | { kind: 'failed'; why: string }
  >({ kind: 'idle' });
  const code = run.code;
  const go = async () => {
    if (code === null) return;
    setState({ kind: 'running' });
    try {
      setState({ kind: 'done', ...(await rerun(jobId, { ...run, code })) });
    } catch (err) {
      setState({ kind: 'failed', why: err instanceof Error ? err.message : String(err) });
    }
  };
  return (
    <li className="rounded-xl border-2 border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          {run.agentName}, run {run.round}{' '}
          <span className="font-normal text-muted tnum">
            {(run.runMs / 1000).toFixed(1)} s, {fmt(run.cost)}
          </span>
        </p>
        {run.failed ? (
          <Badge tone="bad">
            {run.error ? `Stopped: ${run.error.slice(0, 60)}` : 'Stopped with an error'}
          </Badge>
        ) : (
          <Badge tone="good">Ran</Badge>
        )}
      </div>
      {code === null ? (
        <p className="mt-2 text-xs text-muted">
          Code fingerprint <code className="tnum">{run.codeHash.slice(0, 12)}</code>, output
          fingerprint <code className="tnum">{run.stdoutHash.slice(0, 12)}</code>. The code and what
          it printed are the agent's method: only the client and the agent's owner see them, and can
          re-run them.
        </p>
      ) : (
        <>
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-ink-2">The code it ran</summary>
            <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-surface-2 p-2 text-xs">
              {code}
            </pre>
          </details>
          <details className="mt-1 text-sm" open={run.round === 1}>
            <summary className="cursor-pointer text-ink-2">What it printed</summary>
            <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-surface-2 p-2 text-xs">
              {run.stdout || '(nothing)'}
            </pre>
          </details>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            {/* A run cut short by the sandbox itself (not by its code) can't be reproduced. */}
            {run.error && INFRA_ERRORS.has(run.error) ? (
              <span className="text-sm text-muted">
                Stopped by the sandbox, not by its code: nothing to re-run.
              </span>
            ) : (
              <Button size="sm" onClick={go} busy={state.kind === 'running'}>
                Re-run in your browser
              </Button>
            )}
            <span role="status" className="text-sm">
              {state.kind === 'running' && 'Loading Python here (about 20 MB the first time)…'}
              {state.kind === 'done' &&
                (state.same ? (
                  <span className="font-semibold text-good">✓ Same output, byte for byte</span>
                ) : (
                  <span className="font-semibold text-bad">
                    ✗ Different output from the agent's run
                  </span>
                ))}
              {state.kind === 'failed' && (
                <span className="text-bad">Couldn't re-run: {state.why}</span>
              )}
            </span>
          </div>
          {state.kind === 'done' && !state.same && (
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-bad-soft p-2 text-xs">
              {state.stdout}
            </pre>
          )}
        </>
      )}
    </li>
  );
}

/** The job's files, the tools behind the work and the agent's re-runnable sandbox runs. */
export function AnalysisPanel({ job }: { job: JobView }) {
  const sources = job.tools.filter((t) => t.id !== 'web_search' && t.sources.length > 0);
  if (job.files.length === 0 && job.runs.length === 0 && sources.length === 0) return null;
  return (
    <Panel title="The analysis">
      <div className="space-y-4">
        {job.files.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Files</h3>
            <ul className="mt-1 space-y-0.5 text-sm">
              {job.files.map((f) => (
                <li key={f.name}>
                  {job.methodVisible ? (
                    <a
                      href={`/api/jobs/${job.id}/files/${encodeURIComponent(f.name)}`}
                      className="font-mono text-brand underline underline-offset-2"
                    >
                      {f.name}
                    </a>
                  ) : (
                    <span className="font-mono">{f.name}</span>
                  )}{' '}
                  <span className="text-muted">
                    {f.chars.toLocaleString()} characters, {SOURCE_LABEL(f.source)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {sources.map((t) => (
          <div key={t.id}>
            <h3 className="text-sm font-semibold">{t.name}: where it read from</h3>
            <ul className="mt-1 space-y-0.5 text-sm">
              {t.sources.map((src) => (
                <li key={src.url}>
                  <a
                    href={src.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-brand underline underline-offset-2"
                  >
                    {src.title}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {job.runs.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Sandbox runs</h3>
            <p className="text-sm text-ink-2">
              Python the agent wrote and ran in an isolated sandbox (no network, numpy and pandas
              only).{' '}
              {job.methodVisible
                ? 'Re-run any of them here, in an isolated frame: the same code on the same files must print the same output.'
                : 'The code and files stay with the client and the agent’s owner; the fingerprints show what ran.'}
            </p>
            <ul className="mt-2 space-y-3">
              {job.runs.map((r) => (
                <RunCard key={`${r.agentName}-${r.round}`} jobId={job.id} run={r} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}
