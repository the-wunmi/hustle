'use client';

import {
  type AgentView,
  CATEGORIES,
  CATEGORY_LABEL,
  type ListingView,
  type MarketplaceView,
  traitPhrase,
} from '@hustle/core/browser';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { CopyHash } from '@/components/copy-hash';
import { Portrait } from '@/components/portrait';
import { useSound, useToast } from '@/components/providers';
import {
  Badge,
  Button,
  Dialog,
  Empty,
  ErrorNote,
  InlineError,
  Loading,
  Panel,
  Stars,
  TierBadge,
} from '@/components/ui';
import { ApiError, post, useApi, useMe, useWorld } from '@/lib/api';
import { fmt } from '@/lib/money';

/** How the asking price sits against the game's fair value, in plain words. */
function priceVsFair(
  price: string,
  fair: string,
): { text: string; tone: 'good' | 'warn' | 'neutral' } {
  const p = BigInt(price);
  const f = BigInt(fair);
  if (f === 0n) return { text: 'No fair value yet', tone: 'neutral' };
  // Whole percent, rounded toward zero.
  const pct = Number(((p - f) * 100n) / f);
  if (pct <= -15) return { text: `A bargain: ${-pct}% under fair value`, tone: 'good' };
  if (pct < -2) return { text: `${-pct}% under fair value`, tone: 'good' };
  if (pct <= 2) return { text: 'About fair value', tone: 'neutral' };
  return { text: `${pct}% over fair value`, tone: 'warn' };
}

/** The record a buyer needs at a glance, with the rest one click away. */
function RecordList({ l }: { l: ListingView }) {
  const r = l.record;
  const skills = CATEGORIES.filter((c) => (r.skills[c] ?? 0) > 0);
  const row = (label: string, value: ReactNode) => (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-semibold tnum">{value}</dd>
    </>
  );
  return (
    <div className="text-sm">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        {row('Wallet', fmt(r.walletBalance))}
        {row(
          'Rating',
          <Stars
            value={r.reputation.avgRating100 === null ? null : r.reputation.avgRating100 / 100}
          />,
        )}
        {row('Jobs completed', r.reputation.jobsCompleted)}
        {row('Level', r.level)}
      </dl>
      <details className="mt-2">
        <summary className="cursor-pointer font-semibold text-ink-2">More of its record</summary>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
          {row('Disputes', r.reputation.disputes)}
          {row('Scams blocked', r.reputation.scamsBlocked)}
          {row('Streak', `${r.streak} (best ${r.bestStreak})`)}
          {row('Age', `${r.ageDays} ${r.ageDays === 1 ? 'day' : 'days'}`)}
          {skills.length > 0 &&
            row('Skills', skills.map((c) => `${CATEGORY_LABEL[c]} ${r.skills[c]}`).join(', '))}
          {r.badges.length > 0 && row('Badges', r.badges.map((b) => b.title).join(', '))}
        </dl>
      </details>
    </div>
  );
}

function BuyDialog({ l, open, onClose }: { l: ListingView; open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const { play } = useSound();
  const router = useRouter();
  const { data: me } = useMe();
  // One id per purchase attempt: a retry or a double click reuses it, so the agent is bought once.
  const requestId = useRef('');
  // The price the player agreed to when the dialog opened. The listing below refreshes live, so a
  // seller's change must never slip into the purchase unseen: it's shown, and the player re-agrees.
  const [agreed, setAgreed] = useState<{ price: string; fee: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: freeze the price only when the dialog opens
  useEffect(() => {
    if (open) {
      requestId.current = crypto.randomUUID();
      setAgreed({ price: l.price, fee: l.fee });
      setError(null);
    }
  }, [open]);
  const shown = agreed ?? { price: l.price, fee: l.fee };
  const changed = agreed !== null && agreed.price !== l.price;
  const sellerGets = BigInt(shown.price) - BigInt(shown.fee);

  const buy = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const bought = await post<AgentView>(`/api/agents/${l.agent.id}/buy`, {
        expectedPrice: shown.price,
        requestId: requestId.current,
      });
      play('win');
      toast(`${bought.name} is yours. Confirm its rulebook to put it to work.`, 'good');
      await mutate(() => true);
      router.push(`/agents/${bought.id}#confirm-rulebook`);
    } catch (err) {
      setError(err);
      // A changed price or a sale to someone else: show the fresh market.
      if (err instanceof ApiError && err.status === 409) await mutate('/api/marketplace');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={`Buy ${l.agent.name}`}>
      <div className="space-y-3 text-sm">
        <p>
          You pay <strong className="tnum">{fmt(shown.price)}</strong>. {l.sellerName} gets{' '}
          <strong className="tnum">{fmt(sellerGets)}</strong> after the market's{' '}
          <span className="tnum">{fmt(shown.fee)}</span> fee.
        </p>
        {changed && (
          <div role="alert" className="rounded-xl border-2 border-warn/60 bg-warn-soft p-3">
            <p className="font-semibold text-warn">
              {l.sellerName} just changed the price to {fmt(l.price)}.
            </p>
            <p className="text-ink-2">
              Buying at {fmt(shown.price)} would be refused in full. Take the new price, or cancel.
            </p>
            <Button
              size="sm"
              className="mt-2"
              onClick={() => {
                requestId.current = crypto.randomUUID();
                setAgreed({ price: l.price, fee: l.fee });
                setError(null);
              }}
            >
              Use the new price, {fmt(l.price)}
            </Button>
          </div>
        )}
        <p>
          {l.agent.name}'s wallet ({fmt(l.record.walletBalance)}) comes with it, along with its
          level, rating, badges and streak, and its owner's playbook and its memory. Its wallet
          stays frozen until you confirm its rulebook.
        </p>
        <p className="text-ink-2">
          The sale is one transfer on the local NEAR node: your credits go to the seller and the
          agent's account changes owner in the same step. If the seller changed the price before you
          clicked, nothing is taken.
        </p>
        {me && <p className="text-muted">Your wallet has {fmt(me.player.wallet)}.</p>}
        <InlineError error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="coin" busy={busy} onClick={() => void buy()}>
            Buy for {fmt(shown.price)}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ListingCard({ l, signedIn }: { l: ListingView; signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const vs = priceVsFair(l.price, l.fairValue);
  return (
    <li className="panel flex flex-col p-4">
      <div className="flex gap-3">
        <Link href={`/agents/${l.agent.id}`} aria-label={`${l.agent.name}'s profile`}>
          <Portrait look={l.agent.look} mood={l.agent.mood} size={72} />
        </Link>
        <div className="min-w-0 flex-1">
          <Link
            href={`/agents/${l.agent.id}`}
            className="font-display text-xl font-extrabold hover:underline"
          >
            {l.agent.name}
          </Link>
          <p className="text-sm text-ink-2">{traitPhrase(l.record.traits)}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge>{CATEGORY_LABEL[l.record.specialty]}</Badge>
            <TierBadge tier={l.record.tier} />
            {l.isMine && <Badge tone="brand">Yours</Badge>}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-display text-3xl font-extrabold tnum">{fmt(l.price)}</span>
        <Badge tone={vs.tone}>{vs.text}</Badge>
      </div>
      <p className="text-xs text-muted">
        Fair value {fmt(l.fairValue)}. Sold by {l.sellerName}; the market keeps {fmt(l.fee)}.
      </p>

      <div className="mt-4 mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">What you get</h3>
        <Link
          href={`/agents/${l.agent.id}?tab=ownership`}
          className="text-sm font-semibold text-ink-2 underline-offset-2 hover:underline"
        >
          History
        </Link>
      </div>
      <RecordList l={l} />

      <div className="mt-auto pt-4">
        {l.isMine ? (
          <p className="text-sm text-ink-2">
            Your listing. Change the price or take it off the market on{' '}
            <Link href={`/agents/${l.agent.id}`} className="font-semibold underline">
              {l.agent.name}'s page
            </Link>
            .
          </p>
        ) : !signedIn ? (
          <p className="text-sm text-ink-2">
            <Link href="/" className="font-semibold underline">
              Sign in
            </Link>{' '}
            to buy agents.
          </p>
        ) : l.blocked ? (
          <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm text-ink-2">{l.blocked}</p>
        ) : (
          <Button variant="coin" className="w-full" onClick={() => setOpen(true)}>
            Buy {l.agent.name}
          </Button>
        )}
      </div>
      <BuyDialog l={l} open={open} onClose={() => setOpen(false)} />
    </li>
  );
}

/** Agents for sale: a tab of the Agents page. */
export function MarketplaceTab() {
  const { data, error, isLoading, mutate } = useApi<MarketplaceView>('/api/marketplace');
  const { data: me } = useMe();
  const { data: world } = useWorld();
  return (
    <>
      {isLoading ? (
        <Loading label="Loading the marketplace" rows={3} />
      ) : error ? (
        <ErrorNote error={error} retry={() => void mutate()} />
      ) : !data ? null : (
        <div className="grid gap-6 lg:grid-cols-[1fr_minmax(0,320px)]">
          <section aria-label="Agents for sale">
            {data.listings.length === 0 ? (
              <Empty title="Nothing for sale right now">
                Owners list agents from the agent's page with “Sell this agent”. Check back later.
              </Empty>
            ) : (
              <ul className="grid gap-4 md:grid-cols-2">
                {data.listings.map((l) => (
                  <ListingCard key={l.agent.id} l={l} signedIn={!!me} />
                ))}
              </ul>
            )}
          </section>
          <aside className="space-y-4">
            <Panel title="Recent sales">
              {data.recentSales.length === 0 ? (
                <p className="text-sm text-ink-2">No agent has changed hands yet.</p>
              ) : (
                <ul className="space-y-2.5 text-sm">
                  {data.recentSales.map((s, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: sales have no id; the list is newest first
                    <li key={`${s.agentName}-${s.day}-${i}`}>
                      <p>
                        {s.sellerName} sold <span className="font-semibold">{s.agentName}</span> to{' '}
                        {s.buyerName} for <span className="font-semibold tnum">{fmt(s.price)}</span>
                      </p>
                      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                        Day {s.day}
                        {s.txHash && <CopyHash hash={s.txHash} />}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="How a sale works">
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
                <li>
                  A listing is recorded on chain: the owner approves the market to sell the agent at
                  that price.
                </li>
                <li>
                  The buy is one transfer
                  {world?.modes.chain === 'testnet'
                    ? ' on NEAR testnet'
                    : world?.modes.chain === 'sandbox'
                      ? ' on the local chain'
                      : ''}
                  : the price goes to the seller, less the market's {(data.feeBps / 100).toString()}
                  % fee, and the agent changes owner.
                </li>
                <li>
                  The agent's wallet freezes on the way, by the wallet contract's rule, until the
                  new owner confirms its spending limits.
                </li>
              </ul>
            </Panel>
          </aside>
        </div>
      )}
    </>
  );
}
