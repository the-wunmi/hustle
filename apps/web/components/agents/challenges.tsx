'use client';

import { type AgentView, CATEGORY_LABEL } from '@hustle/core/browser';
import Link from 'next/link';
import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { post } from '@/lib/api';
import { useToast } from '../providers';
import { Button, Panel } from '../ui';

/**
 * Proof of a skill on fresh problems: each challenge is generated anew and graded by code, and the
 * same model sits the same instance plain. Its owner sends it at one; everyone sees the tally.
 */
export function ChallengesPanel({ agent }: { agent: AgentView }) {
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const { mutate } = useSWRConfig();
  return (
    <Panel title="Challenges">
      <p className="mb-3 text-sm text-ink-2">
        Each challenge is a fresh problem (new ledgers, a new bug, a new token) whose answer is
        worked out by code, so nothing can be memorised. {agent.name} works it with its own steps
        and pays for it; the same AI model, without the owner's playbook or tools, sits the same
        problem for comparison.
      </p>
      <ul className="space-y-2">
        {agent.challenges.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-line p-3"
          >
            <div className="min-w-0">
              <p className="font-semibold">
                {c.name}{' '}
                <span className="text-sm font-normal text-muted">{CATEGORY_LABEL[c.category]}</span>
              </p>
              <p className="text-sm text-ink-2 tnum">
                {c.attempts === 0
                  ? 'Not taken yet.'
                  : `Solved ${c.solved} of ${c.attempts} fresh challenge${c.attempts === 1 ? '' : 's'}`}
                {c.plainAttempts > 0 &&
                  ` · the same model plain: ${c.plainSolved} of ${c.plainAttempts}`}
                {c.lastJobId && (
                  <>
                    {' · '}
                    <Link href={`/jobs/${c.lastJobId}`} className="underline underline-offset-2">
                      latest attempt
                    </Link>
                  </>
                )}
              </p>
            </div>
            {agent.isMine && (
              <Button
                size="sm"
                busy={busy === c.id}
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(c.id);
                  try {
                    const { jobId } = await post<{ jobId: string }>(
                      `/api/agents/${agent.id}/challenge`,
                      { challengeId: c.id },
                    );
                    toast(`${agent.name} is on a fresh ${c.name} challenge.`, 'good');
                    await mutate(`/api/agents/${agent.id}`);
                    window.location.assign(`/jobs/${jobId}`);
                  } catch (err) {
                    toast(err instanceof Error ? err.message : 'Could not start it', 'bad');
                    setBusy(null);
                  }
                }}
              >
                Take a fresh one
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
