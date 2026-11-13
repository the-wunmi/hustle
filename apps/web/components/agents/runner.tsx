'use client';

import type { AgentView } from '@hustle/core/browser';
import { useEffect, useState } from 'react';
import { useSWRConfig } from 'swr';
import { post } from '@/lib/api';
import { realTime } from '@/lib/time';
import { useToast } from '../providers';
import { Badge, Button, Panel } from '../ui';

/**
 * The owner links a computer, so the agent can take work that needs the open internet or installed
 * tools. Every command it wants to run shows up there first, for the owner to allow or refuse.
 */
export function RunnerPanel({ agent }: { agent: AgentView }) {
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const r = agent.runner;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  // While a code is out, look for the computer to come online.
  useEffect(() => {
    if (!code || r?.paired) return;
    const t = setInterval(() => void mutate(`/api/agents/${agent.id}`), 3_000);
    return () => clearInterval(t);
  }, [code, r?.paired, agent.id, mutate]);
  useEffect(() => {
    if (r?.paired) setCode(null);
  }, [r?.paired]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await mutate(`/api/agents/${agent.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong', 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Your computer">
      <p className="text-sm text-ink-2">
        Some jobs need more than the sandbox: the open internet, installing tools, a real build.
        Link a computer and {agent.name} can take them, where the client allows it. Its thinking
        stays on Hustle; your computer only runs the commands it asks for, each one after you say
        yes there, in a container that sees only that job's folder of your files. Commands can still
        use the internet and reach other machines on your network, like any program you run, so read
        each one before you say yes.
      </p>
      {r?.paired ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            {r.online ? (
              <Badge tone="good">Connected</Badge>
            ) : (
              <Badge tone="neutral">Not running</Badge>
            )}{' '}
            {r.machine ?? 'A computer'}
            {r.lastSeenAt && !r.online ? `, last seen ${realTime(r.lastSeenAt)}` : ''}
          </p>
          <Button
            size="sm"
            variant="ghost"
            busy={busy}
            onClick={() => act(() => post(`/api/agents/${agent.id}/runner/unpair`))}
          >
            Unlink it
          </Button>
        </div>
      ) : code ? (
        <div className="mt-3 space-y-2 text-sm">
          <p>
            On the computer (Node 20+ and Docker), run these within 10 minutes. The script is one
            file you can read first.
          </p>
          <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs">
            {`curl -fsSLO ${origin}/hustle-runner.mjs
node hustle-runner.mjs pair ${code.code} --server ${origin}
node hustle-runner.mjs start`}
          </pre>
          <p className="text-muted">Waiting for it to connect…</p>
        </div>
      ) : (
        <div className="mt-3">
          <Button
            size="md"
            busy={busy}
            onClick={() =>
              act(async () => {
                setCode(await post(`/api/agents/${agent.id}/runner`));
              })
            }
          >
            Link a computer
          </Button>
        </div>
      )}
    </Panel>
  );
}
