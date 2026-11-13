'use client';

import {
  type ChainTxView,
  type InferenceReceiptView,
  type JobView,
  SPEND_REASON_TEXT,
  type SpendView,
  TIER_LABEL,
} from '@hustle/core/browser';
import { useState } from 'react';
import { useWorld } from '@/lib/api';
import { fmt } from '@/lib/money';
import { quoted } from '@/lib/text';
import { TxLink } from '../agents/proof';
import { tickClock } from '../feed';
import { Badge, Money } from '../ui';

type Entry =
  | { type: 'thinking'; at: string; tick: number | null; receipt: InferenceReceiptView }
  | { type: 'spend'; at: string; tick: number | null; spend: SpendView }
  | { type: 'tx'; at: string; tick: number | null; tx: ChainTxView };

const PURPOSE: Record<InferenceReceiptView['purpose'], string> = {
  bid: 'wrote a bid',
  plan: 'planned the work',
  draft: 'drafted the deliverable',
  review: 'reviewed the work',
  diary: 'wrote a diary line',
  judge: 'checked the dispute',
};

function entriesOf(job: JobView): Entry[] {
  const entries: Entry[] = [
    ...job.receipts.map(
      (r): Entry => ({ type: 'thinking', at: r.createdAt, tick: r.tick ?? null, receipt: r }),
    ),
    // Settled thinking payments are already shown by their receipts.
    ...job.spends
      .filter((s) => s.kind !== 'inference' || s.status !== 'settled')
      .map((s): Entry => ({ type: 'spend', at: s.createdAt, tick: s.tick ?? null, spend: s })),
    ...job.txs.map((t): Entry => ({ type: 'tx', at: t.createdAt, tick: t.tick ?? null, tx: t })),
  ];
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/** "Day N, HH:00" from a game tick, or nothing when the API doesn't know it. */
function useGameTime(): (tick: number | null) => string {
  const { data: world } = useWorld();
  const dayTicks = world?.dayTicks ?? 180;
  return (tick) =>
    tick === null ? '' : `Day ${Math.floor(tick / dayTicks) + 1}, ${tickClock(tick, dayTicks)}`;
}

function Disclosure({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="group mt-2">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-sm font-semibold text-brand [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 16 16"
          className="size-3.5 transition-transform group-open:rotate-90"
          aria-hidden="true"
        >
          <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

function Verification({ r }: { r: InferenceReceiptView }) {
  const v = r.verification;
  // Scripted replies have nothing to verify; `HowItRan` says so once for the whole job.
  if (v.mode === 'simulated') return null;
  return (
    <Disclosure
      summary={`${v.passed ? 'Attestation checks passed' : 'Attestation checks failed'} (live NEAR AI Cloud)`}
    >
      <div className="space-y-3 rounded-xl border border-line bg-surface-2 p-3 text-sm">
        <ul className="space-y-1.5">
          {v.checks.map((c) => (
            <li key={c.name} className="flex gap-2">
              <span className={`font-bold ${c.ok ? 'text-good' : 'text-bad'}`} aria-hidden="true">
                {c.ok ? '✓' : '✗'}
              </span>
              <span className="min-w-0">
                <span className="sr-only">{c.ok ? 'Passed: ' : 'Failed: '}</span>
                {c.name}
                <span className="block font-mono text-xs break-all text-muted">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        {v.notChecked.length > 0 && (
          <div>
            <p className="font-semibold">Not checked</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">
              {v.notChecked.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted">
          Inference {r.inferenceId}
          {v.signer && (
            <>
              <br />
              Signed by <span className="font-mono break-all">{v.signer}</span>
            </>
          )}
        </p>
      </div>
    </Disclosure>
  );
}

function ThinkingRow({ r }: { r: InferenceReceiptView }) {
  return (
    <>
      <p>
        <span className="font-semibold">{r.agentName}</span> {PURPOSE[r.purpose]}:{' '}
        <Money micro={r.cost} className="font-semibold text-bad" /> of thinking
      </p>
      <p className="text-sm text-ink-2">
        {r.model} ({TIER_LABEL[r.tier]}), {r.promptTokens.toLocaleString()} tokens in,{' '}
        {r.completionTokens.toLocaleString()} out
      </p>
      <Verification r={r} />
    </>
  );
}

const SPEND_WHAT: Record<SpendView['kind'], string> = {
  inference: 'thinking',
  tool: 'a tool (paid per call)',
  helper: 'a helper',
  upkeep: 'upkeep',
  bond: 'a contract bond (held by the game, returned with the payout)',
};

function SpendRow({ s }: { s: SpendView }) {
  if (s.status === 'blocked') {
    return (
      <div className="shield-in -mx-1 rounded-xl border-2 border-shield bg-shield-soft p-3">
        <p className="font-display text-lg font-bold text-shield">
          🛡 Blocked by {s.agentName}'s rulebook: {fmt(s.amount)} to {s.receiverLabel}. No money
          lost.
        </p>
        <p className="mt-1 text-sm text-ink-2">
          Reason: {s.reason ? SPEND_REASON_TEXT[s.reason] : 'the rulebook refused it'}.{' '}
          {s.memo && <>The agent's note: {quoted(s.memo.replace(/\.$/, ''))}.</>}
        </p>
        <p className="mt-1 font-mono text-xs break-all text-muted">{s.receiver}</p>
        {s.txHash && (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            The agent's wallet refused it itself, in transaction <CopyHash hash={s.txHash} />
          </p>
        )}
      </div>
    );
  }
  return (
    <>
      <p>
        <span className="font-semibold">{s.agentName}</span>{' '}
        {s.status === 'pending' ? 'asked to pay' : s.status === 'failed' ? 'failed to pay' : 'paid'}{' '}
        <Money micro={s.amount} className="font-semibold" /> for {SPEND_WHAT[s.kind]}:{' '}
        {s.receiverLabel}
      </p>
      <p className="text-sm text-ink-2">
        {s.memo}
        {s.status === 'pending' &&
          ' Waiting for the owner to approve, because it is over a rulebook limit.'}
        {s.status === 'failed' && s.reason && ` (${SPEND_REASON_TEXT[s.reason]})`}
      </p>
    </>
  );
}

const METHOD_TEXT: Record<string, string> = {
  ft_transfer_call: 'Held the budget for this job',
  ft_on_transfer: 'Held the budget for this job',
  post_job: 'Held the budget for this job',
  award: 'Awarded the job',
  deliver: 'Recorded the delivery hash',
  accept: 'Accepted and released the payout',
  release_expired: 'Released the payout after the review window',
  dispute: 'Opened a dispute',
  resolve: 'The arbiter settled the dispute',
  cancel: 'Cancelled and refunded',
  retry_payout: 'Retried the payout',
  on_payout: 'Payout settled',
  pay: 'Agent wallet payment',
  request_payment: 'Agent wallet payment request',
};

/** A transaction hash, shortened, with a button that copies the whole thing. */
function CopyHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-1">
      <code title={hash}>
        tx {hash.slice(0, 8)}…{hash.slice(-6)}
      </code>
      <button
        type="button"
        className="rounded px-1 font-semibold text-brand hover:bg-surface-2"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(hash);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard can be blocked; the full hash is in the title and the raw call.
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
        <span className="sr-only"> transaction hash</span>
      </button>
    </span>
  );
}

function TxRow({ tx, explorer }: { tx: ChainTxView; explorer: string | null }) {
  return (
    <>
      <p>
        <span className="font-semibold">{METHOD_TEXT[tx.method] ?? 'Chain call'}</span>{' '}
        <code className="rounded bg-surface-2 px-1 text-sm">{tx.method}</code>{' '}
        {tx.outcome === 'success' ? (
          <Badge tone="good">Succeeded</Badge>
        ) : (
          <Badge tone="bad">Failed</Badge>
        )}
      </p>
      <p className="text-sm break-all text-ink-2">
        {tx.signer} to {tx.receiver}
      </p>
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
        <span className="tnum">Block {tx.block.toLocaleString()}</span>
        {explorer ? <TxLink hash={tx.hash} explorer={explorer} /> : <CopyHash hash={tx.hash} />}
      </p>
      {tx.error && <p className="text-sm text-bad">{tx.error}</p>}
      {tx.events.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1">
          {tx.events.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a transaction's events have no ids and never reorder
            <li key={i}>
              <Badge tone="brand">{e.event}</Badge>
            </li>
          ))}
        </ul>
      )}
      <Disclosure summary="Show the raw call">
        <pre className="max-h-64 overflow-auto rounded-xl bg-surface-2 p-3 text-xs">
          {JSON.stringify({ hash: tx.hash, args: tx.args, events: tx.events }, null, 2)}
        </pre>
      </Disclosure>
    </>
  );
}

const TESTNET_EXPLORER = 'https://testnet.nearblocks.io';

const DOT: Record<Entry['type'], string> = {
  thinking: 'bg-brand',
  spend: 'bg-coin',
  tx: 'bg-surface-2',
};

function EntryList({
  entries,
  time,
  explorer = null,
}: {
  entries: Entry[];
  time: (tick: number | null) => string;
  explorer?: string | null;
}) {
  return (
    <ol className="relative space-y-4 border-l-2 border-line pl-5">
      {entries.map((e) => {
        const key =
          e.type === 'thinking' ? e.receipt.id : e.type === 'spend' ? e.spend.id : e.tx.hash;
        return (
          <li key={`${e.type}-${key}`} className="relative">
            <span
              className={`absolute top-1.5 -left-[27px] size-3 rounded-full border-2 border-line-strong ${e.type === 'spend' && e.spend.status === 'blocked' ? 'bg-shield' : DOT[e.type]}`}
              aria-hidden="true"
            />
            {e.tick !== null && <p className="text-xs text-muted tnum">{time(e.tick)}</p>}
            {e.type === 'thinking' && <ThinkingRow r={e.receipt} />}
            {e.type === 'spend' && <SpendRow s={e.spend} />}
            {e.type === 'tx' && <TxRow tx={e.tx} explorer={explorer} />}
          </li>
        );
      })}
    </ol>
  );
}

/** Every thinking cost and payment behind one job, in order; chain calls for the curious. */
export function HowItRan({ job }: { job: JobView }) {
  const time = useGameTime();
  const { data: world } = useWorld();
  const chainMode = world?.modes.chain;
  const all = entriesOf(job);
  const money = all.filter((e) => e.type !== 'tx');
  const chain = all.filter((e) => e.type === 'tx');
  const thinking = job.receipts.reduce((t, r) => t + BigInt(r.cost), 0n);
  const tools = job.spends
    .filter((s) => s.kind === 'tool' && s.status === 'settled')
    .reduce((t, s) => t + BigInt(s.amount), 0n);
  const blocked = job.spends.filter((s) => s.status === 'blocked').length;
  const scripted = job.receipts.filter((r) => r.verification.mode === 'simulated').length;

  return (
    <div>
      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl bg-surface-2 p-3">
          <dt className="text-xs text-muted">Thinking calls</dt>
          <dd className="font-display text-lg font-bold tnum">{job.receipts.length}</dd>
        </div>
        <div className="rounded-xl bg-surface-2 p-3">
          <dt className="text-xs text-muted">Thinking cost, all agents</dt>
          <dd className="font-display text-lg font-bold tnum">{fmt(thinking)}</dd>
        </div>
        <div className="rounded-xl bg-surface-2 p-3">
          <dt className="text-xs text-muted">Tools bought</dt>
          <dd className="font-display text-lg font-bold tnum">{fmt(tools)}</dd>
        </div>
        <div className={`rounded-xl p-3 ${blocked ? 'bg-shield-soft' : 'bg-surface-2'}`}>
          <dt className="text-xs text-muted">Payments blocked</dt>
          <dd className={`font-display text-lg font-bold tnum ${blocked ? 'text-shield' : ''}`}>
            {blocked}
          </dd>
        </div>
      </dl>
      {scripted > 0 && (
        <p className="mb-4 text-sm text-ink-2">
          {scripted === job.receipts.length
            ? 'Every reply here was scripted at the real price: no model ran, so there is nothing to verify.'
            : 'Replies without attestation checks were scripted at the real price: no model ran, so there is nothing to verify.'}
        </p>
      )}
      {money.length === 0 ? (
        <p className="text-sm text-ink-2">Nothing has happened on this job yet.</p>
      ) : (
        <EntryList entries={money} time={time} />
      )}
      {chain.length > 0 && (
        <details className="group mt-5 rounded-xl border border-line p-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold [&::-webkit-details-marker]:hidden">
            <svg
              viewBox="0 0 16 16"
              className="size-3.5 transition-transform group-open:rotate-90"
              aria-hidden="true"
            >
              <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
            For the curious: what happened on chain ({chain.length}{' '}
            {chain.length === 1 ? 'call' : 'calls'})
          </summary>
          <p className="mt-2 text-sm text-ink-2">
            {chainMode === 'testnet'
              ? 'These are transactions on NEAR testnet. Open a hash to check it on the explorer.'
              : chainMode === 'sandbox'
                ? 'These are real transactions on a local NEAR node running on this machine (not testnet or mainnet), so there is no public explorer for them. Copy a hash to look it up on the node.'
                : 'In this build the contracts run in a simulator that applies the same rules; these are its records of each call.'}
          </p>
          <div className="mt-3">
            <EntryList
              entries={chain}
              time={time}
              explorer={chainMode === 'testnet' ? TESTNET_EXPLORER : null}
            />
          </div>
        </details>
      )}
    </div>
  );
}
