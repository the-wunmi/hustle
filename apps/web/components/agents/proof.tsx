'use client';

import type { ProofView } from '@hustle/core/browser';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CopyHash } from '@/components/copy-hash';
import { Badge, ErrorNote, Loading, Money, Panel, Stat } from '@/components/ui';
import { useApi } from '@/lib/api';

const CHAIN_NAME: Record<ProofView['chain'], string> = {
  testnet: 'NEAR testnet',
  sandbox: 'a local NEAR chain on this machine',
  sim: 'the chain simulator (tests only)',
};

/** Plain words for the contract calls an agent's account shows up in. */
const METHOD: Record<string, string> = {
  spend: 'Wallet payment',
  ft_transfer: 'Credits transfer',
  ft_transfer_call: 'Escrow or purchase',
  mint: 'Credits minted',
  mint_agent: 'Agent minted',
  mint_badge: 'Badge minted',
  nft_approve: 'Listed for sale',
  nft_revoke: 'Taken off sale',
  withdraw: 'Withdrawal',
  set_rulebook: 'Rulebook changed',
  set_frozen: 'Wallet frozen or unfrozen',
  award: 'Job awarded',
  deliver: 'Work delivered',
  accept: 'Job paid',
  record_scam_blocked: 'Scam recorded',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line py-2 last:border-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm font-semibold break-all">{children}</dd>
    </div>
  );
}

/** One hash: a link to the explorer where there is one, else copyable. */
export function TxLink({ hash, explorer }: { hash: string; explorer: string | null }) {
  if (!explorer) return <CopyHash hash={hash} />;
  return (
    <a
      href={`${explorer}/txns/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs underline underline-offset-2"
      title={hash}
    >
      {hash.slice(0, 6)}…{hash.slice(-4)}
    </a>
  );
}

/**
 * Everything a judge can check about this agent. The account, holder, rulebook and reputation are
 * read from the chain on each load; model calls and transactions are the game's own log of what it
 * sent, with hashes to check on chain.
 */
export function ProofTab({ id }: { id: string }) {
  const { data, error, isLoading, mutate } = useApi<ProofView>(`/api/agents/${id}/proof`);
  if (isLoading) return <Loading label="Reading the chain" rows={4} />;
  if (error) return <ErrorNote error={error} retry={() => void mutate()} />;
  if (!data) return null;
  const r = data.wallet.rulebook;
  const rep = data.reputation;
  return (
    <div className="space-y-6">
      <p className="text-sm text-ink-2">
        Read from {CHAIN_NAME[data.chain]} just now. It can run a moment ahead of the game's own
        totals while a job settles.
      </p>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Panel title="Account and holder">
          <dl>
            <Row label="Agent account (its NFT)">
              {data.explorer ? (
                <a
                  className="underline underline-offset-2"
                  href={`${data.explorer}/address/${data.accountId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {data.accountId}
                </a>
              ) : (
                data.accountId
              )}
            </Row>
            <Row label="Held by">{data.holder ?? 'Unknown'}</Row>
            <Row label="Owner changes">{data.wallet.rotationSeq}</Row>
            <Row label="Wallet">{data.wallet.frozen ? 'Frozen' : 'Active'}</Row>
          </dl>
        </Panel>
        <Panel title="Rulebook its wallet enforces">
          <dl>
            <Row label="Daily cap">
              <Money micro={r.dailyCap} />
            </Row>
            <Row label="Counted against the cap today">
              <Money micro={data.wallet.spentToday} />
            </Row>
            <Row label="Per job">
              <Money micro={r.maxPerJob} />
            </Row>
            <Row label="Per payment">
              <Money micro={r.maxPerCall} />
            </Row>
            <Row label="May pay">
              {r.anyVendor
                ? 'Any vendor'
                : r.allowedVendors.map((v) => v.split('.')[0]).join(', ') || 'No vendors'}
            </Row>
          </dl>
        </Panel>
      </div>
      <Panel title="Reputation contract">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Jobs completed">{rep.jobs}</Stat>
          <Stat label="Average rating">
            {rep.ratedJobs ? (rep.ratingSum / rep.ratedJobs).toFixed(1) : 'None yet'}
          </Stat>
          <Stat label="Disputes lost">{rep.disputes}</Stat>
          <Stat label="Scams blocked">{rep.scamsBlocked}</Stat>
        </dl>
      </Panel>
      <section aria-labelledby="game-record" className="space-y-3">
        <div>
          <h2 id="game-record" className="text-lg font-bold">
            The game's record
          </h2>
          <p className="text-sm text-ink-2">
            Logged by the game as it made each call.{' '}
            {data.explorer
              ? 'Open a hash to check the transaction on the explorer.'
              : 'Each hash can be looked up on the chain.'}
          </p>
        </div>
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Panel title="Recent model calls">
            {data.inference.length === 0 ? (
              <p className="text-sm text-ink-2">No model calls yet.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {data.inference.map((c) => (
                  <li key={c.at} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    {c.jobId ? (
                      <Link
                        href={`/jobs/${c.jobId}`}
                        className="font-semibold capitalize underline underline-offset-2"
                        title="Its job page shows the signature and attestation checks"
                      >
                        {c.purpose}
                      </Link>
                    ) : (
                      <span className="font-semibold capitalize">{c.purpose}</span>
                    )}
                    <span className="min-w-0 text-ink-2 break-all">{c.model}</span>
                    {c.source === 'recorded' ? (
                      <Badge title="No model ran: a scripted reply at the real price">
                        Scripted
                      </Badge>
                    ) : c.verified === null ? (
                      <Badge tone="bad">Live, call failed</Badge>
                    ) : (
                      <Badge tone={c.verified ? 'good' : 'bad'}>
                        {c.verified ? 'Live, verified' : 'Live, failed checks'}
                      </Badge>
                    )}
                    {c.cost && <Money micro={c.cost} className="ml-auto" />}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Recent transactions">
            {data.txs.length === 0 ? (
              <p className="text-sm text-ink-2">No transactions yet.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {data.txs.map((t) => (
                  <li key={t.hash} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="font-semibold">
                      {METHOD[t.method] ?? t.method.replaceAll('_', ' ')}
                    </span>
                    <span className="text-ink-2">
                      {t.outcome === 'success' ? 'succeeded' : 'refused'}
                    </span>
                    <span className="ml-auto">
                      <TxLink hash={t.hash} explorer={data.explorer} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </section>
    </div>
  );
}
