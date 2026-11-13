'use client';

import type { AgentView, MarketplaceView } from '@hustle/core/browser';
import { useEffect, useId, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { api, post, useApi, useWorld } from '@/lib/api';
import { fmt, parseDollars, toDollarInput } from '@/lib/money';
import { useToast } from '../providers';
import { Badge, Button, Dialog, Field, InlineError, inputClass } from '../ui';

/** Refreshes every view a listing change shows up in. */
function useRefreshAgent(agentId: string) {
  const { mutate } = useSWRConfig();
  return () =>
    mutate(
      (k) =>
        typeof k === 'string' &&
        (k === '/api/me' || k === '/api/marketplace' || k.startsWith(`/api/agents/${agentId}`)),
    );
}

/** The dialog that lists an agent for sale, or changes the price of a listing. */
function SellDialog({
  agent,
  open,
  onClose,
}: {
  agent: AgentView;
  open: boolean;
  onClose: () => void;
}) {
  const [fair, setFair] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const refresh = useRefreshAgent(agent.id);
  const inputId = useId();
  const loaded = useRef(false);

  useEffect(() => {
    if (!open) {
      loaded.current = false;
      return;
    }
    if (loaded.current) return;
    loaded.current = true;
    setError(null);
    setText(agent.listing ? toDollarInput(agent.listing.price) : '');
    api<{ fairValue: string }>(`/api/agents/${agent.id}/value`)
      .then((v) => {
        setFair(v.fairValue);
        if (!agent.listing) setText(toDollarInput(v.fairValue));
      })
      .catch(() => setFair(null));
  }, [open, agent.id, agent.listing]);

  // The market's cut comes from the marketplace itself; until it loads, no fee line is shown.
  const { data: market } = useApi<MarketplaceView>(open ? '/api/marketplace' : null);
  const price = parseDollars(text);
  const fee = price && market ? (BigInt(price) * BigInt(market.feeBps)) / 10_000n : null;

  const submit = async () => {
    if (!price || BigInt(price) === 0n) {
      setError(new Error('Enter a price in dollars, like 4.50'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post(`/api/agents/${agent.id}/listing`, { price });
      toast(
        agent.listing
          ? `${agent.name}'s price is now ${fmt(price)}.`
          : `${agent.name} is on the market for ${fmt(price)}.`,
        'good',
      );
      await refresh();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={agent.listing ? `Change ${agent.name}'s price` : `Sell ${agent.name}`}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-sm text-ink-2">
          The buyer gets {agent.name} as it is: its wallet ({fmt(agent.balance)}), its level and
          rating, its badges and its streak, its playbook and what it remembers. Listing it records
          your price on chain as an approval for the market to sell it; nothing moves until someone
          buys.
        </p>
        {fair && (
          <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm">
            <span className="font-semibold">Fair value about {fmt(fair)}</span>: the money in its
            wallet plus what its record is worth to a buyer. Price above it and it may sit; below it
            and it sells fast.
          </p>
        )}
        <Field
          label="Asking price, in dollars"
          htmlFor={inputId}
          hint={
            price && fee !== null
              ? `You get ${fmt(BigInt(price) - fee)} after the market's ${fmt(fee)} fee.`
              : undefined
          }
        >
          <div className="relative">
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
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="coin" busy={busy}>
            {agent.listing ? 'Change price' : `List for ${price ? fmt(price) : '…'}`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Sell controls for the owner: list the agent, or, once listed, change the price or take it off
 * the market. Disabled while the agent is on a job (the market refuses then too).
 */
export function SellControls({ agent, compact = false }: { agent: AgentView; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const refresh = useRefreshAgent(agent.id);
  const onJob = !!agent.currentJob;

  if (agent.needsRulebookConfirm) return null;

  if (agent.listing) {
    return (
      <div className={compact ? 'flex flex-wrap items-center gap-2' : 'space-y-2'}>
        {!compact && (
          <p className="text-sm">
            <Badge tone="coin">On the market</Badge>{' '}
            <span className="font-semibold">for {fmt(agent.listing.price)}</span>. It keeps working
            until someone buys it.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="md" onClick={() => setOpen(true)}>
            Change price
          </Button>
          <Button
            size="md"
            variant="ghost"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await post(`/api/agents/${agent.id}/unlist`);
                toast(`${agent.name} is off the market.`, 'neutral');
                await refresh();
              } catch (err) {
                toast(
                  err instanceof Error ? err.message : 'Could not take it off the market',
                  'bad',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            Take it off the market
          </Button>
        </div>
        <SellDialog agent={agent} open={open} onClose={() => setOpen(false)} />
      </div>
    );
  }

  return (
    <>
      <Button
        size="md"
        variant="ghost"
        disabled={onJob}
        title={onJob ? `${agent.name} is on a job. You can list it once the job ends.` : undefined}
        onClick={() => setOpen(true)}
      >
        Sell this agent
      </Button>
      {onJob && !compact && (
        <p className="text-xs text-muted">
          {agent.name} is on a job. You can list it once the job ends.
        </p>
      )}
      <SellDialog agent={agent} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Shown on a bought agent until its new owner confirms the rulebook it came with. */
export function PausedBanner({ agent }: { agent: AgentView }) {
  const { data: world } = useWorld();
  if (!agent.needsRulebookConfirm) return null;
  return (
    <div className="rounded-xl border-2 border-warn/60 bg-warn-soft px-3 py-2 text-sm">
      <p className="font-semibold text-warn">
        Paused: its wallet is frozen until you confirm its rulebook.
      </p>
      <p className="text-ink-2">
        {agent.name} came with its old owner's spending limits. The wallet contract keeps it frozen
        until you keep them or set your own
        {world?.modes.chain === 'testnet'
          ? ' (a real transaction on NEAR testnet)'
          : world?.modes.chain === 'sandbox'
            ? ' (a real transaction on the local chain)'
            : ''}
        .
      </p>
    </div>
  );
}
