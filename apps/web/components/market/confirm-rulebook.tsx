'use client';

import type { AgentView } from '@hustle/core/browser';
import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { post } from '@/lib/api';
import { fmt } from '@/lib/money';
import { RulebookEditor } from '../agents/rulebook-editor';
import { useToast } from '../providers';
import { Button, InlineError } from '../ui';

/**
 * The first thing a new owner does with a bought agent: keep the spending rules it came with, or
 * set new ones. Until then the wallet contract keeps its wallet frozen.
 */
export function ConfirmRulebook({ agent }: { agent: AgentView }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const { mutate } = useSWRConfig();
  if (!agent.needsRulebookConfirm) return null;
  const r = agent.rulebook;

  const keep = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/agents/${agent.id}/confirm`, {});
      toast(`${agent.name} is yours and back at work.`, 'good');
      await mutate(
        (k) =>
          typeof k === 'string' && (k === '/api/me' || k.startsWith(`/api/agents/${agent.id}`)),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      id="confirm-rulebook"
      aria-labelledby="confirm-rulebook-h"
      className="sticker border-warn p-5"
    >
      <h2 id="confirm-rulebook-h" className="font-display text-2xl font-extrabold">
        Confirm {agent.name}'s rulebook
      </h2>
      <p className="mt-1 text-ink-2">
        {agent.name} is yours, wallet included. It came with its old owner's spending limits, and
        its wallet stays frozen until you confirm them or set your own: that's the wallet contract's
        rule for an agent that changes hands, so nobody's old limits run your money by surprise.
      </p>

      <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Daily spending cap</dt>
          <dd className="font-semibold tnum">{fmt(r.dailyCap)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Most per job</dt>
          <dd className="font-semibold tnum">{fmt(r.maxPerJob)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Most per payment</dt>
          <dd className="font-semibold tnum">{fmt(r.maxPerCall)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Helper budget</dt>
          <dd className="font-semibold tnum">{r.mayHire ? fmt(r.helperBudget) : 'Hiring off'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted">May pay</dt>
          <dd className="font-semibold">
            {r.anyVendor
              ? 'Any vendor (loose: a scam job can make it pay a stranger)'
              : r.allowedVendors.length
                ? r.allowedVendors.map((v) => v.split('.')[0]).join(', ')
                : 'No vendors'}
          </dd>
        </div>
      </dl>

      <InlineError error={error} />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="coin" busy={busy} onClick={() => void keep()}>
          Keep these and unfreeze
        </Button>
        <Button variant="secondary" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>
          {editing ? 'Keep the old rules after all' : 'Change them'}
        </Button>
      </div>

      {editing && (
        <div className="mt-4">
          <RulebookEditor agent={agent} confirm />
        </div>
      )}
    </section>
  );
}
