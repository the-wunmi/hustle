'use client';

import { type ApprovalView, SPEND_REASON_TEXT } from '@hustle/core/browser';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSWRConfig } from 'swr';
import { errorText, post, useApi, useApprovals } from '@/lib/api';
import { fmt } from '@/lib/money';
import { Portrait } from '../portrait';
import { useToast } from '../providers';
import { Badge, Button, ErrorNote, Loading, Panel } from '../ui';

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Nova wants to hire Pixel for $0.12 to proofread." */
export function approvalSentence(a: ApprovalView): string {
  const who = a.agent.name;
  const amount = fmt(a.amount);
  const memo = a.memo ? ` (${a.memo.replace(/\.$/, '')})` : '';
  switch (a.kind) {
    case 'helper':
      return `${who} wants to hire ${a.receiverLabel} for ${amount}${memo}.`;
    case 'tool':
      return `${who} wants to pay ${a.receiverLabel} ${amount} for a tool${memo}.`;
    case 'inference':
      return `${who} wants to spend ${amount} on thinking${memo}.`;
    default:
      return `${who} wants to pay ${a.receiverLabel} ${amount}${memo}.`;
  }
}

function ApprovalRow({ a }: { a: ApprovalView }) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'deny');
    try {
      await post(`/api/approvals/${a.id}`, { approve });
      toast(
        approve
          ? `Approved: ${a.agent.name} can pay ${fmt(a.amount)}.`
          : `Denied. ${a.agent.name} keeps the money.`,
        approve ? 'good' : 'neutral',
      );
      await mutate(
        (k) => typeof k === 'string' && (k.startsWith('/api/approvals') || k === '/api/me'),
      );
    } catch (err) {
      toast(errorText(err), 'bad');
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="rounded-2xl border-2 border-line-strong bg-surface p-3 shadow-[3px_3px_0_var(--shadow)]">
      <div className="flex gap-3">
        <Portrait look={a.agent.look} mood="stressed" size={44} still />
        <div className="min-w-0">
          <p className="font-semibold leading-snug">{approvalSentence(a)}</p>
          <p className="mt-0.5 text-sm text-ink-2">
            {capital(SPEND_REASON_TEXT[a.reason])}. Its rulebook stopped it and asked you.
          </p>
          {a.jobId && (
            <Link
              href={`/jobs/${a.jobId}`}
              className="text-xs font-semibold text-ink-2 hover:underline"
            >
              View the job
            </Link>
          )}
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          size="sm"
          busy={busy === 'approve'}
          disabled={!!busy}
          onClick={() => decide(true)}
        >
          Approve {fmt(a.amount)}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          busy={busy === 'deny'}
          disabled={!!busy}
          onClick={() => decide(false)}
        >
          Deny
        </Button>
      </div>
    </li>
  );
}

const STATUS_TONE = {
  approved: 'good',
  denied: 'neutral',
  expired: 'neutral',
  pending: 'warn',
} as const;

function History() {
  const { data } = useApi<ApprovalView[]>('/api/approvals?all=1');
  const done = (data ?? []).filter((a) => a.status !== 'pending').slice(0, 6);
  if (done.length === 0) return <p className="text-sm text-muted">No decisions yet.</p>;
  return (
    <ul className="space-y-2">
      {done.map((a) => (
        <li key={a.id} className="flex items-start justify-between gap-2 text-sm">
          <span className="text-ink-2">{approvalSentence(a)}</span>
          <Badge tone={STATUS_TONE[a.status]}>{capital(a.status)}</Badge>
        </li>
      ))}
    </ul>
  );
}

export function Approvals({ agentName }: { agentName: string }) {
  const { data, error, isLoading, mutate } = useApprovals(true);
  const [showHistory, setShowHistory] = useState(false);
  const loaded = !!data;
  // The header's shield links to #approvals, which only exists once the home page has loaded.
  useEffect(() => {
    if (loaded && window.location.hash === '#approvals') {
      document.getElementById('approvals')?.scrollIntoView({ block: 'start' });
    }
  }, [loaded]);
  return (
    <Panel
      id="approvals"
      title={
        <span className="flex items-center gap-2">
          Approvals
          {data && data.length > 0 && <Badge tone="bad">{data.length} waiting</Badge>}
        </span>
      }
      action={
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={showHistory}
          onClick={() => setShowHistory((s) => !s)}
        >
          {showHistory ? 'Hide history' : 'History'}
        </Button>
      }
    >
      {isLoading ? (
        <Loading rows={1} label="Loading approvals" />
      ) : error ? (
        <ErrorNote error={error} retry={() => mutate()} />
      ) : data && data.length > 0 ? (
        <ul className="space-y-3">
          {data.map((a) => (
            <ApprovalRow key={a.id} a={a} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-2">
          Nothing waiting. When {agentName} wants to spend past its rulebook, the request lands
          here.
        </p>
      )}
      {showHistory && (
        <div className="mt-4 border-t border-line pt-3">
          <h3 className="mb-2 text-sm font-semibold">Recent decisions</h3>
          <History />
        </div>
      )}
    </Panel>
  );
}
