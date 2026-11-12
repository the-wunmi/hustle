'use client';

import {
  type AgentLook,
  type AgentView,
  BODIES,
  type BrainView,
  CATEGORIES,
  CATEGORY_LABEL,
  type Category,
  COLORS,
  TIERS,
  type Tier,
  TRAIT_BLURB,
  TRAIT_LABEL,
  TRAITS,
  type Trait,
  traitPhrase,
} from '@hustle/core/browser';
import { useRouter } from 'next/navigation';
import { type ReactNode, useId, useState } from 'react';
import { useSWRConfig } from 'swr';
import { post, useApi, useMe, useWorld } from '@/lib/api';
import { fmt } from '@/lib/money';
import { PALETTE, Portrait } from '../portrait';
import { useSound, useToast } from '../providers';
import { Button, InlineError, inputClass } from '../ui';

const NAME_IDEAS = [
  'Nova',
  'Pip',
  'Juniper',
  'Sprocket',
  'Tilly',
  'Moss',
  'Quill',
  'Echo',
  'Biscuit',
  'Fern',
];

const BODY_LABEL: Record<AgentLook['body'], string> = {
  bolt: 'Bolt',
  orb: 'Orb',
  boxy: 'Boxy',
  tall: 'Tall',
  squat: 'Squat',
  antenna: 'Antenna',
};

const TIER_PITCH: Record<Tier, { title: string; text: string }> = {
  budget: {
    title: 'Budget',
    text: 'Cheapest thinking. Wins on price, but clients notice the weaker work.',
  },
  standard: {
    title: 'Standard',
    text: 'Decent work at a cost most jobs can carry. The usual pick.',
  },
  premium: {
    title: 'Premium',
    text: 'The best work, but its thinking can cost more than a small job pays.',
  },
};

function Step({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t-2 border-line pt-5">
      <h2 id={id} className="text-xl font-bold">
        {title}
      </h2>
      {hint && <p className="text-sm text-ink-2">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

const choiceClass = (on: boolean) =>
  `cursor-pointer rounded-2xl border-2 p-3 text-left transition-colors has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand ${on ? 'border-line-strong bg-brand-soft shadow-[3px_3px_0_var(--shadow)]' : 'border-line bg-surface hover:border-line-strong'}`;

export function Creator({ first }: { first: boolean }) {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const { play } = useSound();
  const { data: brains } = useApi<BrainView[]>('/api/brains');
  const { data: me } = useMe();
  const { data: world } = useWorld();
  const [traitNote, setTraitNote] = useState(false);
  const [look, setLook] = useState<AgentLook>({ body: 'orb', color: 'grape' });
  const [name, setName] = useState('');
  const [traits, setTraits] = useState<Trait[]>([]);
  const [specialty, setSpecialty] = useState<Category>('summary');
  const [tier, setTier] = useState<Tier>('standard');
  const [busy, setBusy] = useState(false);
  const [born, setBorn] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const nameId = useId();
  const group = useId();

  const trimmed = name.trim();
  const nameOk =
    trimmed.length >= 2 && trimmed.length <= 16 && /^[\p{L}\p{N}][\p{L}\p{N} '-]*$/u.test(trimmed);
  const ready = nameOk && traits.length === 2;
  const shownName = trimmed || 'Your agent';
  /** The same name inside a sentence, where the placeholder must not be capitalised. */
  const nameInText = trimmed || 'your agent';

  const toggleTrait = (t: Trait) => {
    if (!traits.includes(t) && traits.length >= 2) {
      setTraitNote(true);
      return;
    }
    setTraitNote(false);
    setTraits((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const agent = await post<AgentView>('/api/agents', {
        name: trimmed,
        look,
        traits,
        specialty,
        tier,
      });
      setBorn(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      play('win');
      toast(`${agent.name} is alive and starting a practice job.`, 'good');
      await mutate(() => true);
      setTimeout(() => router.push(first ? '/' : `/agents/${agent.id}`), 1200);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_1fr] lg:gap-10">
      <aside className="lg:sticky lg:top-32 lg:self-start">
        <div className="sticker flex flex-col items-center p-6 text-center">
          <Portrait
            look={look}
            mood={born ? 'celebrating' : 'idle'}
            size={180}
            label={`${shownName}, preview`}
          />
          <p className="mt-2 font-display text-3xl font-extrabold">{shownName}</p>
          <p className="text-sm text-ink-2">
            {traits.length ? traitPhrase(traits) : 'Pick two traits'}
          </p>
          <p className="mt-1 text-sm text-ink-2">
            {CATEGORY_LABEL[specialty]} with a {TIER_PITCH[tier].title.toLowerCase()} brain
          </p>
        </div>
      </aside>

      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void create();
        }}
      >
        <div>
          <h1 className="text-3xl font-extrabold sm:text-4xl">
            {first ? 'Adopt your agent' : 'Adopt another agent'}
          </h1>
          <p className="mt-2 max-w-xl text-ink-2">
            It will look for paid work on its own and pay for every thought out of its own wallet.
            You set its strategy and its spending rules.
          </p>
        </div>

        <Step title="Look">
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">Body</legend>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {BODIES.map((b) => (
                <label
                  key={b}
                  className={`${choiceClass(look.body === b)} flex flex-col items-center p-2`}
                >
                  <input
                    type="radio"
                    name={`${group}-body`}
                    className="choice-input"
                    checked={look.body === b}
                    onChange={() => setLook((l) => ({ ...l, body: b }))}
                  />
                  <Portrait look={{ body: b, color: look.color }} size={56} still />
                  <span className="text-xs font-semibold">{BODY_LABEL[b]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="mt-4">
            <legend className="mb-2 text-sm font-semibold">Colour</legend>
            <div className="flex flex-wrap gap-2">
              {COLORS.map((c) => (
                <label
                  key={c}
                  title={c}
                  className={`grid size-11 cursor-pointer place-items-center rounded-full border-2 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand ${look.color === c ? 'border-line-strong shadow-[2px_2px_0_var(--shadow)]' : 'border-transparent'}`}
                >
                  <input
                    type="radio"
                    name={`${group}-color`}
                    className="choice-input"
                    checked={look.color === c}
                    onChange={() => setLook((l) => ({ ...l, color: c }))}
                  />
                  <span
                    className="size-8 rounded-full border-2 border-[#1a1d3a]"
                    style={{ background: PALETTE[c].fill }}
                  />
                  <span className="sr-only">{c}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </Step>

        <Step title="Name" hint="2 to 16 letters or numbers. It signs its bids and diary with it.">
          <div className="flex flex-wrap gap-2">
            <label htmlFor={nameId} className="sr-only">
              Agent name
            </label>
            <input
              id={nameId}
              value={name}
              maxLength={16}
              placeholder="e.g. Pebble"
              onChange={(e) => setName(e.target.value)}
              className={`${inputClass} max-w-xs`}
              aria-invalid={name.length > 0 && !nameOk}
            />
            <Button
              onClick={() => {
                const options = NAME_IDEAS.filter((n) => n !== trimmed);
                setName(options[Math.floor(Math.random() * options.length)] ?? 'Nova');
              }}
            >
              Suggest a name
            </Button>
          </div>
          {name.length > 0 && !nameOk && (
            <p role="alert" className="mt-1 text-xs font-medium text-bad">
              Use 2 to 16 letters, numbers, spaces, - or '.
            </p>
          )}
        </Step>

        <Step
          title="Personality"
          hint={`Pick two. Traits change how ${nameInText} bids, works and gets fooled.`}
        >
          <fieldset>
            <legend className="sr-only">Two personality traits</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {TRAITS.map((t) => {
                const on = traits.includes(t);
                const full = traits.length >= 2 && !on;
                return (
                  <label key={t} className={`${choiceClass(on)} ${full ? 'opacity-55' : ''}`}>
                    {/* aria-disabled, not disabled: a full set stays reachable by Tab and explains itself. */}
                    <input
                      type="checkbox"
                      className="choice-input"
                      checked={on}
                      aria-disabled={full || undefined}
                      aria-describedby={full ? `${group}-trait-note` : undefined}
                      onChange={() => toggleTrait(t)}
                    />
                    <span className="flex items-center justify-between gap-2 font-semibold">
                      {TRAIT_LABEL[t]}
                      <span
                        aria-hidden="true"
                        className={`grid size-5 place-items-center rounded-md border-2 border-line-strong text-xs ${on ? 'bg-brand text-brand-ink' : 'bg-surface'}`}
                      >
                        {on ? '✓' : ''}
                      </span>
                    </span>
                    <span className="mt-1 block text-sm text-ink-2">{TRAIT_BLURB[t]}</span>
                  </label>
                );
              })}
            </div>
            <p
              id={`${group}-trait-note`}
              role="status"
              className={`mt-2 text-sm font-semibold text-warn ${traitNote ? '' : 'sr-only'}`}
            >
              {traitNote ? 'Pick at most two: unselect one first.' : ''}
            </p>
          </fieldset>
        </Step>

        <Step title="Specialty" hint="Where it starts with some skill. It can train others later.">
          <fieldset>
            <legend className="sr-only">Specialty</legend>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <label
                  key={c}
                  className={`${choiceClass(specialty === c)} px-4 py-2 font-semibold`}
                >
                  <input
                    type="radio"
                    name={`${group}-specialty`}
                    className="choice-input"
                    checked={specialty === c}
                    onChange={() => setSpecialty(c)}
                  />
                  {CATEGORY_LABEL[c]}
                </label>
              ))}
            </div>
          </fieldset>
        </Step>

        <Step
          title="Brain"
          hint="The model it thinks with. It pays per token from its own wallet, so this is a real cost trade-off. You can change it later."
        >
          <fieldset>
            <legend className="sr-only">Brain tier</legend>
            <div className="grid gap-2 md:grid-cols-3">
              {TIERS.map((t) => {
                const b = brains?.find((x) => x.tier === t);
                return (
                  <label key={t} className={choiceClass(tier === t)}>
                    <input
                      type="radio"
                      name={`${group}-tier`}
                      className="choice-input"
                      checked={tier === t}
                      onChange={() => setTier(t)}
                    />
                    <span className="block font-display text-lg font-bold">
                      {TIER_PITCH[t].title}
                    </span>
                    {b ? (
                      <span className="mt-1 block">
                        <span className="block font-semibold tnum">
                          ≈ {fmt(b.typicalJobCost)} of thinking per job
                        </span>
                        <span className="mt-1 block text-xs [overflow-wrap:anywhere] text-muted">
                          {b.model}: {fmt(b.inputPerM)} in, {fmt(b.outputPerM)} out per 1M tokens
                        </span>
                      </span>
                    ) : (
                      <span className="skeleton mt-2 block h-9" />
                    )}
                    <span className="mt-2 block text-sm text-ink-2">{TIER_PITCH[t].text}</span>
                  </label>
                );
              })}
            </div>
            {world && (
              <p className="mt-2 text-xs text-muted">
                Prices{' '}
                {world.modes.brainPrices.source === 'live'
                  ? 'read live from NEAR AI Cloud'
                  : 'from a saved copy of NEAR AI Cloud’s price list'}{' '}
                at{' '}
                {new Date(world.modes.brainPrices.readAt).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                .
              </p>
            )}
          </fieldset>
        </Step>

        <div className="border-t-2 border-line pt-5">
          <InlineError error={error} />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button type="submit" variant="coin" size="lg" disabled={!ready} busy={busy}>
              Bring {trimmed || 'it'} to life
            </Button>
            {!ready && (
              <p className="text-sm text-muted">
                {!nameOk ? 'Give it a name' : 'Pick two traits'} to continue.
              </p>
            )}
          </div>
          {world && (
            <p className="mt-2 text-sm text-ink-2">
              {trimmed || 'It'} starts with {fmt(world.economy.starterAgentCredits)} of credits and
              a practice job, and pays {fmt(world.economy.upkeepPerDay)} upkeep each game day (about{' '}
              {Math.round((world.dayTicks * world.tickMs) / 60000)} minutes).{' '}
              {me
                ? `Your wallet has ${fmt(me.player.wallet)} for topping it up, and you can claim ${fmt(world.economy.dailyAllowance)} of free credits each game day on the Wallet page.`
                : ''}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
