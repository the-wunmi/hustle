'use client';

import { type AgentView, MAX_PLAYBOOK, type MemoryView } from '@hustle/core/browser';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { useSWRConfig } from 'swr';
import { post, useApi } from '@/lib/api';
import { fmt } from '@/lib/money';
import { useToast } from '../providers';
import { Badge, Button, Empty, Field, InlineError, inputClass, Panel, Skeleton } from '../ui';

const tokensOf = (text: string) => Math.ceil(text.trim().length / 4);

/** What `tokens` more input costs on the agent's brain, per call. */
function perCall(agent: AgentView, tokens: number): string | null {
  const brain = agent.brains.find((b) => b.tier === agent.strategy.tier);
  if (!brain) return null;
  // Rounded up, so a short playbook never reads as free.
  return fmt(((BigInt(tokens) * BigInt(brain.inputPerM) + 999_999n) / 1_000_000n).toString());
}

const updated = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' }) : null;

/**
 * The owner's instructions for the agent. The owner edits the text; everyone else sees only that one
 * exists, its fingerprint and when it last changed, so a change in results can be traced to it.
 */
export function PlaybookPanel({ agent }: { agent: AgentView }) {
  const book = agent.playbook;
  if (!agent.isMine) {
    return (
      <Panel title="Playbook">
        {book.fingerprint ? (
          <p className="text-sm text-ink-2">
            {agent.name} works from its owner's private playbook ({book.chars.toLocaleString()}{' '}
            characters), fingerprint <code className="tnum">{book.fingerprint}</code>
            {book.updatedAt ? `, last changed ${updated(book.updatedAt)}` : ''}. A new fingerprint
            means new instructions, so read results from before and after it apart.
          </p>
        ) : (
          <p className="text-sm text-ink-2">
            No playbook: {agent.name} works from its traits and strategy alone.
          </p>
        )}
      </Panel>
    );
  }
  return <PlaybookEditor agent={agent} />;
}

function PlaybookEditor({ agent }: { agent: AgentView }) {
  const saved = agent.playbook.text ?? '';
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const id = useId();

  // A newly saved text replaces the draft.
  useEffect(() => setText(saved), [saved]);

  const dirty = text.trim() !== saved;
  const tokens = tokensOf(text);
  const cost = perCall(agent, tokens);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/agents/${agent.id}/playbook`, { text });
      toast(
        text.trim() ? `${agent.name} will follow the new playbook.` : 'Playbook cleared.',
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
    <Panel title="Playbook">
      <div className="space-y-4">
        <p className="text-sm text-ink-2">
          Your instructions, read by {agent.name} on every job: how to pitch, how to lay out the
          work, what to check, what to avoid. Others see only that it exists and its fingerprint,
          never the text. It goes with {agent.name} if you sell it. It can't change the rulebook or
          approve a payment.
        </p>
        <Field
          label="Instructions"
          htmlFor={id}
          hint={
            <>
              {text.trim().length.toLocaleString()}/{MAX_PLAYBOOK.toLocaleString()} characters
              {tokens > 0 && cost
                ? `, about ${tokens.toLocaleString()} tokens: ${cost} more on every call it's read on.`
                : '.'}
            </>
          }
        >
          <textarea
            id={id}
            value={text}
            maxLength={MAX_PLAYBOOK}
            rows={8}
            placeholder={`For example: "Open every research job with a three-row table. Name your sources. If the brief is vague, say what you assumed in one line."`}
            onChange={(e) => setText(e.target.value)}
            className={`${inputClass} h-auto py-2.5`}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={save} busy={busy} disabled={!dirty}>
            Save playbook
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setText(saved)} disabled={busy}>
              Discard
            </Button>
          )}
          {agent.playbook.fingerprint && !dirty && (
            <span className="text-xs text-muted">
              Fingerprint <code className="tnum">{agent.playbook.fingerprint}</code>
            </span>
          )}
          <InlineError error={error} />
        </div>
      </div>
    </Panel>
  );
}

/**
 * What the agent learned from finished jobs. It recalls the most relevant few into each new job (the
 * same client first), and pays for reading them like any other thinking.
 */
export function MemoryPanel({ agent }: { agent: AgentView }) {
  if (!agent.isMine) {
    return (
      <Panel title="Memory">
        <p className="text-sm text-ink-2">
          {agent.memoryCount === 0
            ? `${agent.name} hasn't kept any lessons yet.`
            : `${agent.name} keeps ${agent.memoryCount} lesson${agent.memoryCount === 1 ? '' : 's'} from finished jobs. They're private to its owner, and they go with it if it's sold.`}
        </p>
      </Panel>
    );
  }
  return <OwnMemory agent={agent} />;
}

function OwnMemory({ agent }: { agent: AgentView }) {
  const { data, error } = useApi<MemoryView[]>(`/api/agents/${agent.id}/memory`);
  return (
    <Panel
      title="Memory"
      action={agent.memoryCount > 0 ? <Badge>{agent.memoryCount} kept</Badge> : undefined}
    >
      <p className="mb-4 text-sm text-ink-2">
        After each finished client job {agent.name} writes itself one lesson, paid from its wallet.
        Before a job it recalls up to five (the same client first, then the same kind of work),
        which adds about {agent.contextTokens.toLocaleString()} tokens to each call with your
        playbook. It keeps the latest 40.
      </p>
      {error ? (
        <InlineError error={error} />
      ) : !data ? (
        <Skeleton className="h-24" />
      ) : data.length === 0 ? (
        <Empty title="Nothing remembered yet">
          Its first lesson comes after its first finished client job.
        </Empty>
      ) : (
        <ul className="divide-y divide-line">
          {data.map((m) => (
            <li key={m.jobId} className="py-3">
              <p className="text-sm">
                <Link href={`/jobs/${m.jobId}`} className="font-semibold hover:underline">
                  {m.jobTitle || 'A job'}
                </Link>{' '}
                <span className="text-muted">
                  for {m.client},{' '}
                  {m.outcome === 'refunded'
                    ? 'refunded'
                    : m.rating
                      ? `${m.rating}★ at ${fmt(m.price)}`
                      : `paid ${fmt(m.price)}`}
                </span>
              </p>
              <p className="mt-1 text-sm text-ink-2">
                {m.lesson ??
                  'No lesson from this one (it couldn’t pay for the reflection, or the reply didn’t pass its checks); it kept the facts.'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
