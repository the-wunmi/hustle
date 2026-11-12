'use client';

import type { ModesView } from '@hustle/core/browser';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, PageHeader, Panel, Skeleton } from '@/components/ui';
import { LiveCheck } from '@/components/world/live-check';
import { useAgents, useWorld } from '@/lib/api';

interface Row {
  part: string;
  real: string;
  now: (m: ModesView) => { text: string; live: boolean };
}

/** What each part of the game is in the real world, and what it is in this build right now. */
const ROWS: Row[] = [
  {
    part: 'Chain',
    real: 'NEAR accounts and contracts: agent NFTs, their wallets, the job board, reputation.',
    now: (m) =>
      m.chain === 'testnet'
        ? { text: 'NEAR testnet.', live: true }
        : m.chain === 'sandbox'
          ? { text: 'The same contracts on a local NEAR chain on this machine.', live: true }
          : { text: 'A simulator of the same contracts (tests only).', live: false },
  },
  {
    part: 'Brains',
    real: 'NEAR AI Cloud models, billed per call, with signed attestations.',
    now: (m) =>
      m.inference === 'live'
        ? {
            text: "Live NEAR AI Cloud for players' agents. House agents are the game's computer players, with scripted replies.",
            live: true,
          }
        : {
            text: 'Scripted replies at the real prices: no NEAR AI key is set.',
            live: false,
          },
  },
  {
    part: 'Sign-in',
    real: 'NEAR Auth: email, Google or a passkey, no seed phrase.',
    now: (m) =>
      m.auth === 'live'
        ? { text: 'Live NEAR Auth (testnet).', live: true }
        : { text: 'The email code shows on screen; nothing is sent.', live: false },
  },
];

function Section({ title, children, see }: { title: string; children: ReactNode; see: ReactNode }) {
  return (
    <Panel title={title}>
      <p className="text-ink-2">{children}</p>
      <p className="mt-3 text-sm font-semibold">{see}</p>
    </Panel>
  );
}

export default function HowItWorksPage() {
  const { data: world } = useWorld();
  const { data: agents } = useAgents();
  const example = agents?.find((a) => !a.isMine) ?? agents?.[0];
  const proof = example ? `/agents/${example.id}?tab=proof` : '/agents';
  return (
    <>
      <PageHeader
        title="How it works"
        lead="What runs for real, and where to see the proof for yourself."
      />
      <div className="space-y-6">
        <Panel title="What runs here">
          {!world ? (
            <Skeleton className="h-48" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <thead>
                  <tr className="border-b-2 border-line text-muted">
                    <th scope="col" className="py-2 pr-4 font-semibold">
                      Part
                    </th>
                    <th scope="col" className="py-2 pr-4 font-semibold">
                      In the real world
                    </th>
                    <th scope="col" className="py-2 font-semibold">
                      Here, now
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((r) => {
                    const n = r.now(world.modes);
                    return (
                      <tr key={r.part} className="border-b border-line/60 align-top last:border-0">
                        <th scope="row" className="py-2.5 pr-4 font-semibold whitespace-nowrap">
                          {r.part}
                        </th>
                        <td className="py-2.5 pr-4 text-ink-2">{r.real}</td>
                        <td className="py-2.5">
                          <Badge tone={n.live ? 'good' : 'warn'} className="mb-1">
                            {n.live ? 'Real' : 'Simulated'}
                          </Badge>
                          <p>{n.text}</p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section
            title="Each agent is an NFT and its own NEAR account"
            see={
              <Link href={proof} className="underline underline-offset-2">
                See it: any agent's Proof tab
              </Link>
            }
          >
            Adopting an agent mints an NFT whose token is a NEAR account that holds the agent's
            money. Whoever holds the NFT controls the account; selling the agent hands over its
            wallet, record and badges, and the seller is locked out.
          </Section>
          <Section
            title="Its own wallet enforces your rulebook"
            see={
              <Link href={proof} className="underline underline-offset-2">
                See it: the rulebook read from the chain, on the Proof tab
              </Link>
            }
          >
            Every payment an agent makes goes through its wallet contract, which checks the daily
            cap, the per-job and per-payment limits and the vendor list. A scam payment is refused
            on chain, so even a fooled model can't spend past your rules.
          </Section>
          <Section
            title="Every thought is paid for and checked"
            see={<span>See it: a job page, under "For the curious", or the live check below</span>}
          >
            A live model call goes to NEAR AI Cloud and is paid from the agent's wallet at the exact
            billed cost. Its signature is checked against an attestation report fetched with our own
            nonce first; a reply that fails is thrown away and not charged. Live AI spend has a
            daily budget; past it, agents use scripted replies until midnight UTC.
          </Section>
          <Panel title="Credits, not money">
            <p className="text-ink-2">
              Every amount in Hustle is credits, never real money: players start with credits and
              claim more each game day. The agents' accounts and contracts are real, on{' '}
              {world?.modes.chain === 'testnet' ? 'NEAR testnet' : 'a NEAR chain'}, which needs no
              real funds. The shops agents buy data from are accounts on the same chain, paid in
              credits.
            </p>
          </Panel>
        </div>

        <LiveCheck />
      </div>
    </>
  );
}
