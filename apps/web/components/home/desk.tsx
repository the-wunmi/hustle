'use client';

import type { CallOptionView, CallView } from '@hustle/core/browser';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { errorText, post, useApi, useMe, useWorld } from '@/lib/api';
import { fmt, upkeepDays } from '@/lib/money';
import { useLiveTick } from '../jobs/job-bits';
import { Portrait } from '../portrait';
import { useSound, useToast } from '../providers';
import { Badge, Panel, Spinner } from '../ui';

/** Ticks an answered or lapsed call stays on the desk after its window, before moving to "Recent". */
const LINGER_TICKS = 10;

const KIND_LABEL: Record<CallView['kind'], string> = {
  pitch: 'Pitch',
  vendor: 'Payment request',
  contract: 'Contract offer',
};

const TONE_RING: Record<CallOptionView['tone'], string> = {
  good: 'border-good/60 hover:border-good',
  bad: 'border-bad/50 hover:border-bad',
  neutral: 'border-line hover:border-line-strong',
  shield: 'border-shield/60 hover:border-shield',
  coin: 'border-coin hover:border-line-strong',
};

const OUTCOME_TONE: Record<NonNullable<CallView['outcome']>['tone'], string> = {
  good: 'bg-good-soft text-good',
  bad: 'bg-bad-soft text-bad',
  neutral: 'bg-surface-2 text-ink-2',
  shield: 'bg-shield-soft text-shield',
  coin: 'bg-coin/25 text-coin-ink dark:text-coin',
};

/** The player's calls, shared by the desk, the header indicator and the recent list. */
export function useCalls() {
  const { data: me } = useMe();
  return useApi<CallView[]>(me?.agents.length ? '/api/calls' : null, {
    revalidateOnFocus: true,
    dedupingInterval: 1000,
  });
}

/** Seconds left before a call's default applies, ticking every second between world ticks. */
function useSecondsLeft(expiresTick: number): number | null {
  const { tick, tickMs } = useLiveTick();
  if (tick === null) return null;
  return Math.max(0, Math.ceil(((expiresTick - tick) * tickMs) / 1000));
}

function Countdown({ call }: { call: CallView }) {
  const left = useSecondsLeft(call.expiresTick);
  const { data: world } = useWorld();
  const total = Math.max(
    1,
    ((call.expiresTick - call.openedTick) * (world?.tickMs ?? 2000)) / 1000,
  );
  if (left === null) return null;
  const r = 15;
  const circ = 2 * Math.PI * r;
  const share = Math.min(1, left / total);
  const urgent = left <= 8;
  return (
    <div className="relative grid size-14 shrink-0 place-items-center" aria-hidden="true">
      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r={r} fill="none" stroke="var(--line)" strokeWidth="4" />
        <circle
          cx="18"
          cy="18"
          r={r}
          fill="none"
          stroke={urgent ? 'var(--bad)' : 'var(--coin)'}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${circ * share} ${circ}`}
          className="transition-[stroke-dasharray] duration-1000 ease-linear"
        />
      </svg>
      <span className={`font-display text-lg font-extrabold tnum ${urgent ? 'text-bad' : ''}`}>
        {left}
      </span>
    </div>
  );
}

/** An amount with its sign shown once, as a word ("Would lose") rather than "+-". */
function Money({ label, micro, sign }: { label: string; micro: string; sign: '+' | '−' }) {
  const { data: world } = useWorld();
  const v = BigInt(micro);
  // A "gain" below zero is a loss; a "cost" below zero would be money back. Flip both cleanly.
  const flipped = v < 0n;
  const abs = flipped ? -v : v;
  const shownSign = flipped ? (sign === '+' ? '−' : '+') : sign;
  const shownLabel = flipped ? (sign === '+' ? 'Would lose' : 'Gets back') : label;
  const days = upkeepDays(abs, world?.economy.upkeepPerDay);
  return (
    <span className="block text-sm">
      <span className="text-muted">{shownLabel} </span>
      <span className={`font-semibold tnum ${shownSign === '+' ? 'text-good' : 'text-bad'}`}>
        {shownSign}
        {fmt(abs)}
      </span>
      {days && <span className="text-muted"> ({days})</span>}
    </span>
  );
}

/** Win chances arrive as a percentage (0–100); older answers used a share (0–1). */
const asPercent = (v: number) => Math.round(v > 1 ? v : v * 100);

function OptionButton({
  option,
  isDefault,
  chosen,
  lapsed,
  gainLabel,
  disabled,
  busy,
  onPick,
}: {
  option: CallOptionView;
  isDefault: boolean;
  chosen: boolean;
  /** The call ran out, so the chosen option is the default, not the player's pick. */
  lapsed: boolean;
  gainLabel: string;
  disabled: boolean;
  busy: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-pressed={chosen}
      className={`group relative flex h-full flex-col rounded-2xl border-2 bg-surface p-3 text-left transition-transform enabled:hover:-translate-y-0.5 enabled:active:translate-y-0 disabled:cursor-default ${chosen ? 'border-line-strong bg-brand-soft shadow-[3px_3px_0_var(--shadow)]' : TONE_RING[option.tone]} ${disabled && !chosen ? 'opacity-55' : ''}`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-display text-lg font-extrabold">{option.label}</span>
        {isDefault && !(chosen && lapsed) && <Badge>Default</Badge>}
        {chosen && <Badge tone="brand">{lapsed ? 'Default applied' : 'Your call'}</Badge>}
      </span>
      <span className="mt-0.5 block text-sm text-ink-2">{option.detail}</span>
      {option.winChance !== null && (
        <span className="mt-2 block">
          {/* The odds are an estimate given as a band in the detail line; the bar only sketches it. */}
          <span className="block text-xs text-muted">Chance to win</span>
          <span className="mt-0.5 block h-1.5 overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full bg-brand"
              style={{ width: `${asPercent(option.winChance)}%` }}
            />
          </span>
        </span>
      )}
      <span className="mt-auto block pt-2">
        {option.cost && <Money label="Puts up" micro={option.cost} sign="−" />}
        {option.gain && <Money label={gainLabel} micro={option.gain} sign="+" />}
      </span>
      {busy && <span className="sr-only">Sending your answer</span>}
    </button>
  );
}

/** One call from an agent to its manager: the decision, its tells, its options and its clock. */
function CallCard({ call }: { call: CallView }) {
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const { play } = useSound();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const left = useSecondsLeft(call.expiresTick);
  const open = call.status === 'open' && left !== 0;
  const fallback = call.options.find((o) => o.id === call.defaultOption);

  const answer = async (choice: string) => {
    setBusy(choice);
    setError(null);
    try {
      const updated = await post<CallView>(`/api/calls/${call.id}`, { choice });
      const picked = call.options.find((o) => o.id === choice);
      play(picked?.tone === 'bad' ? 'spend' : 'coin');
      toast(`${call.agent.name}: “${picked?.label ?? choice}.” Got it.`, 'good');
      await mutate<CallView[]>(
        '/api/calls',
        (list) => list?.map((c) => (c.id === updated.id ? updated : c)),
        { revalidate: true },
      );
    } catch (err) {
      setError(errorText(err));
      await mutate('/api/calls');
    } finally {
      setBusy(null);
    }
  };

  return (
    <article
      aria-labelledby={`call-${call.id}`}
      className={`sticker overflow-hidden ${open ? 'call-arrive' : ''}`}
    >
      <div className="flex items-start gap-3 border-b-2 border-line bg-coin/20 px-4 py-3 sm:px-5">
        <Portrait look={call.agent.look} mood={open ? 'busy' : 'idle'} size={52} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink-2">
            {call.agent.name} is calling <Badge tone="coin">{KIND_LABEL[call.kind]}</Badge>
          </p>
          <h3
            id={`call-${call.id}`}
            className="font-display text-xl leading-tight font-extrabold sm:text-2xl"
          >
            {call.title}
          </h3>
          {call.job && (
            <Link
              href={`/jobs/${call.job.id}`}
              className="text-sm font-semibold text-ink-2 hover:underline"
            >
              {call.title.includes(call.job.title) ? 'View the job' : call.job.title}
            </Link>
          )}
        </div>
        {open && <Countdown call={call} />}
      </div>

      {/* On a phone the options come before the tells, so the decision is on screen first. */}
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <p className="text-ink-2">{call.body}</p>

        {call.tells.length > 0 && (
          <div className="order-1 sm:order-none">
            <h4 className="mb-1.5 text-sm font-semibold">What to read</h4>
            <ul className="grid gap-2 sm:grid-cols-2">
              {call.tells.map((t) => (
                <li
                  key={t.label}
                  className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${t.tone === 'good' ? 'border-good/40 bg-good-soft' : t.tone === 'bad' ? 'border-bad/40 bg-bad-soft' : 'border-line bg-surface-2'}`}
                >
                  <span
                    aria-hidden="true"
                    className={`font-bold ${t.tone === 'good' ? 'text-good' : t.tone === 'bad' ? 'text-bad' : 'text-muted'}`}
                  >
                    {t.tone === 'good' ? '✓' : t.tone === 'bad' ? '!' : '•'}
                  </span>
                  <span>
                    <span className="block text-xs text-muted">{t.label}</span>
                    <span className="font-semibold">{t.value}</span>
                    <span className="sr-only">
                      {t.tone === 'good'
                        ? ' (points to trust)'
                        : t.tone === 'bad'
                          ? ' (warning)'
                          : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <fieldset
          className={`grid gap-2 ${call.options.length >= 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : call.options.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}
        >
          <legend className="sr-only">Your answer</legend>
          {call.options.map((o) => (
            <OptionButton
              key={o.id}
              option={o}
              isDefault={o.id === call.defaultOption}
              chosen={call.choice === o.id}
              lapsed={call.status === 'expired'}
              // A pitch's gain is the price less the platform fee and the work's cost.
              gainLabel={
                call.kind === 'pitch' ? 'Stands to make, after the platform fee' : 'Stands to make'
              }
              disabled={!open || !!busy}
              busy={busy === o.id}
              onPick={() => void answer(o.id)}
            />
          ))}
        </fieldset>

        {error && (
          <p role="alert" className="text-sm font-semibold text-bad">
            {error}
          </p>
        )}

        {open && fallback && (
          <p className="text-sm text-ink-2">
            If you don't answer{left !== null ? ` in ${left}s` : ''}, {call.agent.name} goes with{' '}
            <strong>{fallback.label}</strong>: {fallback.detail}
          </p>
        )}

        {!open && (
          <div className="space-y-2">
            <p className="text-sm text-ink-2">
              {call.status === 'answered'
                ? `You answered: ${call.options.find((o) => o.id === call.choice)?.label ?? call.choice}.`
                : `No answer in time, so ${call.agent.name} went with ${fallback?.label ?? call.defaultOption}.`}
            </p>
            <p
              role="status"
              className={`rounded-xl px-3 py-2 font-semibold ${call.outcome ? OUTCOME_TONE[call.outcome.tone] : 'bg-surface-2 text-ink-2'}`}
            >
              {call.outcome?.pending && <Spinner className="mr-2 inline-block align-[-2px]" />}
              {call.outcome?.text ?? 'Waiting to see how it turns out…'}
            </p>
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * The desk: the calls the player's agents are making right now, at the top of the home page. Calls
 * just answered or lapsed stay a little while with their outcome, then move to "Recent calls".
 */
export function CallDesk() {
  const { data } = useCalls();
  const { tick } = useLiveTick();
  if (!data || tick === null) return null;
  const active = data.filter(
    (c) => c.status === 'open' || c.expiresTick + LINGER_TICKS >= Math.floor(tick),
  );
  if (active.length === 0) return null;
  return (
    <section id="desk" aria-label="Calls from your agents" className="space-y-4">
      {active.map((c) => (
        <CallCard key={c.id} call={c} />
      ))}
    </section>
  );
}

/** Calls that have played out, with what happened. */
export function RecentCalls() {
  const { data } = useCalls();
  const { tick } = useLiveTick();
  if (!data || tick === null) return null;
  const past = data
    .filter((c) => c.status !== 'open' && c.expiresTick + LINGER_TICKS < Math.floor(tick))
    .slice(0, 6);
  return (
    <Panel title="Recent calls">
      {past.length === 0 ? (
        <p className="text-sm text-ink-2">
          About every half minute your agent brings you a decision: a price to pitch, a payment to
          allow, a contract to take. They show up at the top of this page.
        </p>
      ) : (
        <ul className="space-y-2">
          {past.map((c) => (
            <li key={c.id} className="rounded-xl border border-line p-2.5 text-sm">
              <p className="flex flex-wrap items-center gap-x-2">
                <span className="font-semibold">{c.title}</span>
                <Badge>{c.status === 'answered' ? 'Answered' : 'Default'}</Badge>
              </p>
              <p
                className={`mt-1 ${c.outcome?.tone === 'bad' ? 'text-bad' : c.outcome?.tone === 'good' || c.outcome?.tone === 'coin' ? 'text-good' : 'text-ink-2'}`}
              >
                {c.outcome?.text ?? 'Still playing out.'}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Raises a toast and the ring sound when a new call opens, wherever the player is. Calls already
 * open when the page loads don't ring.
 */
export function useCallAlerts() {
  const { data } = useCalls();
  const toast = useToast();
  const { play } = useSound();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!data) return;
    const open = data.filter((c) => c.status === 'open');
    if (seen.current === null) {
      seen.current = new Set(data.map((c) => c.id));
      return;
    }
    for (const c of open) {
      if (seen.current.has(c.id)) continue;
      seen.current.add(c.id);
      play('call');
      toast(`${c.agent.name} is calling: ${c.title}`, 'neutral');
    }
  }, [data, play, toast]);
}
