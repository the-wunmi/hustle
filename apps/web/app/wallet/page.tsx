'use client';

import type { ChainTxView, WalletEntryView } from '@hustle/core/browser';
import Link from 'next/link';
import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { MoneyButton } from '@/components/agent-money';
import { Portrait } from '@/components/portrait';
import { useSound, useToast } from '@/components/providers';
import {
  Button,
  ButtonLink,
  ConditionBadge,
  Empty,
  ErrorNote,
  InlineError,
  Loading,
  Money,
  PageHeader,
  Panel,
} from '@/components/ui';
import { Receipts } from '@/components/world/receipts';
import { WalletHistory } from '@/components/world/wallet-history';
import { post, useApi, useMe, useWorld } from '@/lib/api';

function Allowance({ readyAtDay, day }: { readyAtDay: number | null; day: number | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const { play } = useSound();
  const waiting = readyAtDay !== null && day !== undefined && readyAtDay > day;
  return (
    <div className="space-y-2">
      <Button
        variant="coin"
        busy={busy}
        disabled={waiting}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await post('/api/wallet/allowance');
            play('coin');
            toast('Claimed today’s free credits.', 'good');
            await mutate(() => true);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        Claim free daily credits
      </Button>
      {waiting ? (
        <p className="text-sm text-ink-2">Already claimed. Come back on day {readyAtDay}.</p>
      ) : (
        <p className="text-sm text-ink-2">Free credits, once per game day.</p>
      )}
      <InlineError error={error} />
    </div>
  );
}

export default function WalletPage() {
  const { data: me, isLoading, error, mutate } = useMe();
  const { data: world } = useWorld();
  const history = useApi<WalletEntryView[]>(me ? '/api/wallet/history' : null);
  const [showChain, setShowChain] = useState(false);
  // Chain receipts load only when someone opens them.
  const txs = useApi<ChainTxView[]>(me && showChain ? '/api/wallet/txs' : null);

  if (isLoading) return <Loading label="Loading your wallet" />;
  if (error) return <ErrorNote error={error} retry={() => void mutate()} />;
  if (!me) {
    return (
      <>
        <PageHeader title="Wallet" />
        <Empty
          title="Sign in to see your wallet"
          action={
            <ButtonLink href="/" variant="primary">
              Sign in
            </ButtonLink>
          }
        >
          Your wallet holds the credits you use to top up your agent, post tasks and back other
          agents.
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Wallet"
        lead="Credits you can give your agents, spend on tasks, or use to back other players' agents."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="space-y-6">
          <section className="sticker p-5" aria-labelledby="wallet-balance">
            <h2 id="wallet-balance" className="text-sm font-semibold text-ink-2">
              Your wallet
            </h2>
            <p className="mt-1 font-display text-5xl leading-tight font-extrabold tnum">
              <Money micro={me.player.wallet} />
            </p>
            <p className="mt-1 text-xs break-all text-muted">
              {me.player.walletAccountId
                ? `Signed in as ${me.player.walletAccountId}. Your credits live in the game's account for you, ${me.player.accountId}.`
                : `Account ${me.player.accountId}`}
            </p>
            <div className="mt-5">
              <Allowance readyAtDay={me.player.faucetReadyAtDay} day={world?.day} />
            </div>
          </section>

          <Panel title="Your agents">
            {me.agents.length === 0 ? (
              <Empty
                title="No agent yet"
                action={
                  <ButtonLink href="/" variant="primary">
                    Adopt an agent
                  </ButtonLink>
                }
              >
                Adopt an agent and its wallet shows up here.
              </Empty>
            ) : (
              <ul className="divide-y divide-line">
                {me.agents.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
                    <Link
                      href={`/agents/${a.id}`}
                      className="flex min-w-[11rem] flex-1 items-center gap-3 hover:underline"
                    >
                      <Portrait look={a.look} mood={a.mood} size={44} still />
                      <span className="min-w-0">
                        <span className="block font-semibold">{a.name}</span>
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                          <Money micro={a.balance} className="font-semibold" />
                          <ConditionBadge condition={a.condition} />
                        </span>
                      </span>
                    </Link>
                    <div className="flex gap-2">
                      <MoneyButton agent={a} mode="topup" size="sm" />
                      <MoneyButton agent={a} mode="withdraw" size="sm" />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="History">
            <p className="-mt-1 mb-3 text-sm text-ink-2">
              Every time credits moved in or out of your wallet, newest first.
            </p>
            {history.error && (
              <ErrorNote error={history.error} retry={() => void history.mutate()} />
            )}
            {!history.data && !history.error && <Loading label="Loading history" rows={3} />}
            {history.data && history.data.length === 0 && (
              <Empty title="Nothing yet">Claims, top-ups and tasks you post show up here.</Empty>
            )}
            {history.data && history.data.length > 0 && <WalletHistory entries={history.data} />}

            <details
              className="mt-4 border-t border-line pt-3"
              onToggle={(e) => setShowChain((e.target as HTMLDetailsElement).open)}
            >
              <summary className="cursor-pointer text-sm font-semibold text-ink-2">
                Chain receipts
              </summary>
              <p className="mt-2 mb-3 text-sm text-ink-2">
                For the curious: each change to your account as a contract call, with its arguments
                and events.{' '}
                {world?.modes.chain === 'testnet'
                  ? 'These are real transactions on NEAR testnet; each hash can be looked up on testnet.nearblocks.io.'
                  : world?.modes.chain === 'sandbox'
                    ? 'These are real transactions on a local NEAR chain on this machine, so there is no public explorer to look them up in.'
                    : world?.modes.chain === 'sim'
                      ? 'In this build they come from a simulator that follows the same contract rules.'
                      : ''}
              </p>
              {txs.error && <ErrorNote error={txs.error} retry={() => void txs.mutate()} />}
              {showChain && !txs.data && !txs.error && (
                <Loading label="Loading receipts" rows={2} />
              )}
              {txs.data && txs.data.length === 0 && (
                <p className="text-sm text-muted">No receipts yet.</p>
              )}
              {txs.data && txs.data.length > 0 && <Receipts txs={txs.data} />}
            </details>
          </Panel>
        </div>
      </div>
    </>
  );
}
