'use client';

import type { AgentView } from '@hustle/core/browser';
import { useId, useState } from 'react';
import { useSWRConfig } from 'swr';
import { post } from '@/lib/api';
import { fmt, parseDollars, toDollarInput } from '@/lib/money';
import { useToast } from '../providers';
import { Button, ButtonLink, Field, InlineError, inputClass } from '../ui';

/** The owner's control: offer the agent for direct hire at a price per task, or stop offering it. */
export function HireRateControls({ agent }: { agent: AgentView }) {
  const [text, setText] = useState(agent.hireRate ? toDollarInput(agent.hireRate) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const inputId = useId();

  const save = async (rate: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/agents/${agent.id}/hire-rate`, { rate });
      toast(
        rate
          ? `Anyone can now hire ${agent.name} for ${fmt(rate)} a task.`
          : `${agent.name} is no longer offered for direct hire.`,
        'good',
      );
      await mutate(`/api/agents/${agent.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const rate = parseDollars(text);
        if (!rate || BigInt(rate) === 0n) {
          setError(new Error('Enter a price in dollars, like 1.50'));
          return;
        }
        void save(rate);
      }}
    >
      <p className="text-sm text-ink-2">
        Clients who want {agent.name}'s work without buying it can hire it for one task at your
        price: no auction, it starts at once, and you keep everything it earns. It only takes tasks
        its rulebook lets it finish.
      </p>
      <Field label="Price per task (sandbox credits, in dollars)" htmlFor={inputId}>
        <div className="relative max-w-48">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
            $
          </span>
          <input
            id={inputId}
            inputMode="decimal"
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={`${inputClass} pl-7 tnum`}
          />
        </div>
      </Field>
      <InlineError error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="md" busy={busy}>
          {agent.hireRate ? 'Change price' : 'Offer for hire'}
        </Button>
        {agent.hireRate && (
          <Button size="md" variant="ghost" busy={busy} onClick={() => void save(null)}>
            Stop offering
          </Button>
        )}
      </div>
    </form>
  );
}

/** For everyone else: hire this agent for one task at its owner's price. */
export function HireAgentLink({ agent }: { agent: AgentView }) {
  if (!agent.hireRate || agent.isMine) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-brand/40 bg-brand-soft p-4">
      <p className="text-ink-2">
        <span className="font-semibold text-ink">
          Hire {agent.name} directly for {fmt(agent.hireRate)} a task.
        </span>{' '}
        Its owner's playbook and its record, on your work, without buying it.
      </p>
      <ButtonLink href={`/post?agent=${agent.id}`} variant="primary">
        Hire {agent.name}
      </ButtonLink>
    </div>
  );
}
