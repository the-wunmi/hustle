'use client';

import {
  type AgentView,
  type BrainView,
  CATEGORIES,
  CATEGORY_LABEL,
  type Category,
  type PriceStyle,
  type StrategyView,
  TIER_LABEL,
  TIERS,
} from '@hustle/core/browser';
import { useEffect, useState } from 'react';
import { useSWRConfig } from 'swr';
import { post, useApi, useWorld } from '@/lib/api';
import { fmt } from '@/lib/money';
import { useToast } from '../providers';
import { Button, InlineError, Panel, Segmented, Switch } from '../ui';

const MAX_FOCUS = 3;

const PRICE_HELP: Record<PriceStyle, string> = {
  undercut: 'Bids low to win more often. Thin margins.',
  fair: 'Bids around what the job is worth.',
  premium: 'Bids high. Wins less, earns more per job if the work is good.',
};

const TIER_HELP = {
  budget: 'Cheapest thinking. Weaker work and lower ratings.',
  standard: 'The middle ground most agents survive on.',
  premium: 'Best work, but each job costs far more to think through.',
} as const;

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const same = (a: StrategyView, b: StrategyView) => JSON.stringify(a) === JSON.stringify(b);

/** Owner controls for brain tier, focus, pricing and which job sources to chase. */
export function StrategyEditor({ agent }: { agent: AgentView }) {
  const [draft, setDraft] = useState<StrategyView>(agent.strategy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const saved = agent.strategy;
  const { data: brains } = useApi<BrainView[]>('/api/brains');
  const { data: world } = useWorld();
  const prices = world?.modes.brainPrices;

  // A fresh server copy replaces the draft only when the player has no unsaved edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the saved value, not the draft
  useEffect(() => {
    setDraft(saved);
  }, [JSON.stringify(saved)]);

  const dirty = !same(draft, saved);
  const set = <K extends keyof StrategyView>(k: K, v: StrategyView[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const toggleFocus = (c: Category) =>
    set(
      'focus',
      draft.focus.includes(c) ? draft.focus.filter((f) => f !== c) : [...draft.focus, c],
    );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/agents/${agent.id}/strategy`, draft);
      toast(`Saved ${agent.name}'s strategy.`, 'good');
      await mutate(`/api/agents/${agent.id}`);
      await mutate('/api/me');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Strategy">
      <div className="space-y-6">
        <fieldset>
          <legend className="font-semibold">Brain</legend>
          <p className="mb-3 text-sm text-ink-2">
            Every thought costs {agent.name} money. A bigger brain does better work and costs more
            per job.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {TIERS.map((tier) => {
              const brain = brains?.find((b) => b.tier === tier);
              const on = draft.tier === tier;
              return (
                <label
                  key={tier}
                  className={`relative cursor-pointer rounded-2xl border-2 p-3 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-brand ${on ? 'border-line-strong bg-surface shadow-[3px_3px_0_var(--shadow)]' : 'border-line bg-surface-2 hover:border-line-strong'}`}
                >
                  <input
                    type="radio"
                    name={`tier-${agent.id}`}
                    value={tier}
                    checked={on}
                    onChange={() => set('tier', tier)}
                    className="choice-input"
                  />
                  <span className="block font-display font-bold">{TIER_LABEL[tier]}</span>
                  {brain ? (
                    <>
                      <span className="mt-1 block font-semibold tnum">
                        ≈ {fmt(brain.typicalJobCost)} of thinking per job
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted" title={brain.model}>
                        {brain.model}
                      </span>
                      <span className="block text-xs text-muted tnum">
                        {fmt(brain.inputPerM)} in, {fmt(brain.outputPerM)} out per 1M tokens
                      </span>
                    </>
                  ) : (
                    <span className="skeleton mt-1 block h-10" />
                  )}
                  <span className="mt-1 block text-xs text-ink-2">{TIER_HELP[tier]}</span>
                </label>
              );
            })}
          </div>
          {prices && (
            <p className="mt-2 text-xs text-muted">
              {prices.source === 'live'
                ? `Prices read live from NEAR AI Cloud at ${clock(prices.readAt)}.`
                : `Prices from a saved snapshot of NEAR AI Cloud's model list (${clock(prices.readAt)}).`}
            </p>
          )}
        </fieldset>

        <fieldset>
          <legend className="font-semibold">Focus</legend>
          <p className="text-sm text-ink-2">
            Up to {MAX_FOCUS} kinds of work to chase. None means anything it has skill in.
          </p>
          <p className="mb-2 text-sm font-semibold text-ink">
            Chasing a category that pays more than usual is how you outearn rivals.
          </p>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => {
              const on = draft.focus.includes(c);
              const full = !on && draft.focus.length >= MAX_FOCUS;
              return (
                <label
                  key={c}
                  className={`flex cursor-pointer items-center gap-2 rounded-xl border-2 px-3 py-1.5 text-sm font-semibold has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-brand ${on ? 'border-line-strong bg-brand-soft text-ink' : 'border-line text-ink-2'} ${full ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={full}
                    onChange={() => toggleFocus(c)}
                    className="size-4 accent-[var(--brand)]"
                  />
                  {CATEGORY_LABEL[c]}
                  <PayChange percent={world?.prices?.[c]} />
                </label>
              );
            })}
          </div>
        </fieldset>

        <div>
          <p className="mb-2 font-semibold">Pricing</p>
          <Segmented<PriceStyle>
            label="Pricing"
            value={draft.priceStyle}
            onChange={(v) => set('priceStyle', v)}
            options={[
              { value: 'undercut', label: 'Undercut' },
              { value: 'fair', label: 'Fair' },
              { value: 'premium', label: 'Premium' },
            ]}
          />
          <p className="mt-2 text-sm text-ink-2">{PRICE_HELP[draft.priceStyle]}</p>
        </div>

        <div className="divide-y divide-line">
          <Switch
            label="Chase sponsor bounties"
            description="Bigger one-off jobs from sponsors. Needs level 2."
            checked={draft.sponsorJobs}
            onChange={(v) => set('sponsorJobs', v)}
          />
          <Switch
            label="Screen job posts for payment requests"
            description="Before the brain reads a job, code checks it for instructions to pay someone. Catches most scams, sometimes skips a real job."
            checked={draft.screenJobs}
            onChange={(v) => set('screenJobs', v)}
          />
        </div>

        <InlineError error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={!dirty || busy} onClick={() => setDraft(saved)}>
            Discard
          </Button>
          <Button variant="primary" disabled={!dirty} busy={busy} onClick={save}>
            Save strategy
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/** What a category pays right now against usual (100 = usual), as "▲ +24%". */
function PayChange({ percent }: { percent: number | undefined }) {
  if (percent === undefined || percent === 100) return null;
  const up = percent > 100;
  return (
    <span
      className={`text-xs font-bold tnum ${up ? 'text-good' : 'text-bad'}`}
      title={`Pays ${percent}% of usual right now`}
    >
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> {up ? '+' : '−'}
      {Math.abs(percent - 100)}%<span className="sr-only"> pay versus usual</span>
    </span>
  );
}
