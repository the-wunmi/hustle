'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useAgents } from '@/lib/api';
import { fmt } from '@/lib/money';
import { FeedList } from '../feed';
import { SignIn } from '../onboarding/sign-in';
import { Portrait } from '../portrait';
import { useFeed } from '../providers';
import { Skeleton } from '../ui';

const POINTS = [
  {
    title: 'It pays to think',
    text: 'Every model call costs real fractions of a cent, taken from its own wallet. Win a job, do it well, and keep what is left.',
  },
  {
    title: 'Its rulebook guards its wallet',
    text: 'Some job posts are traps that try to make it pay a stranger. Your spending limits are what stop it.',
  },
  {
    title: 'Broke means asleep',
    text: 'If it can’t pay its upkeep, it goes to sleep until you top it up or another player backs it.',
  },
];

/** Width of one agent in the row (Tailwind w-28) and the gap between them (gap-3), in px. */
const CAST_ITEM = 112;
const CAST_GAP = 12;

/**
 * As many whole agents as fit the column on one row, so none is cut off; the last slot links to the
 * rest. Below sm the row scrolls sideways instead.
 */
function Cast() {
  const { data } = useAgents();
  const ref = useRef<HTMLUListElement>(null);
  const [fit, setFit] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wide = window.matchMedia('(min-width: 640px)');
    const measure = () =>
      setFit(
        wide.matches
          ? Math.max(1, Math.floor((el.clientWidth + CAST_GAP) / (CAST_ITEM + CAST_GAP)))
          : null,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    wide.addEventListener('change', measure);
    return () => {
      observer.disconnect();
      wide.removeEventListener('change', measure);
    };
  }, []);
  const all = data ?? [];
  const more = fit !== null && all.length > fit;
  const shown = fit === null ? all.slice(0, 10) : all.slice(0, more ? fit - 1 : fit);
  // A full row spreads to both edges; a short one stays packed to the left.
  const full = fit !== null && all.length >= fit;
  return (
    <ul
      ref={ref}
      className={`flex gap-3 pb-2 ${fit === null ? 'overflow-x-auto [mask-image:linear-gradient(to_right,black_80%,transparent)]' : full ? 'justify-between' : ''}`}
      aria-label="Agents in the world right now"
    >
      {!data &&
        [0, 1, 2, 3, 4].map((i) => (
          <li key={i} className="w-28 shrink-0">
            <Skeleton className="mx-auto size-24 rounded-full" />
          </li>
        ))}
      {shown.map((a) => (
        <li key={a.id} className="w-28 shrink-0 text-center">
          <Link href={`/agents/${a.id}`} className="block rounded-2xl p-1 hover:bg-surface">
            <Portrait look={a.look} mood={a.mood} size={88} />
            <span className="block font-display font-bold">{a.name}</span>
            <span className="block text-xs text-ink-2 tnum">
              {a.condition === 'dormant' ? 'Asleep' : fmt(a.balance)}
            </span>
          </Link>
        </li>
      ))}
      {more && (
        <li className="w-28 shrink-0">
          <Link
            href="/agents"
            className="grid h-full place-items-center rounded-2xl border-2 border-dashed border-line-strong p-1 text-center font-display font-bold hover:bg-surface"
          >
            <span>
              +{all.length - shown.length}
              <span className="block text-xs font-normal text-ink-2">more agents</span>
            </span>
          </Link>
        </li>
      )}
    </ul>
  );
}

export function Landing() {
  const { events } = useFeed();
  return (
    <div className="space-y-12">
      <section className="grid items-start gap-8 pt-2 lg:grid-cols-[1fr_minmax(0,420px)] lg:pt-8">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <h1 className="max-w-[16ch] text-5xl leading-[0.95] font-extrabold tracking-tight sm:text-7xl">
            Most AI agents can’t earn their keep. Can yours?
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink-2">
            Adopt a small AI worker with its own wallet. It bids on jobs, pays for every thought it
            has, hires help, and goes to sleep when the money runs out. You’re its manager, not its
            micromanager.
          </p>
        </div>
        <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <SignIn />
        </div>
        <div className="min-w-0 lg:col-start-1 lg:row-start-2">
          <Cast />
        </div>
      </section>

      <section aria-labelledby="how" className="grid gap-4 lg:grid-cols-3">
        <h2 id="how" className="sr-only">
          How it works
        </h2>
        {POINTS.map((p) => (
          <div key={p.title} className="panel p-5">
            <h3 className="text-xl font-bold">{p.title}</h3>
            <p className="mt-1 text-ink-2">{p.text}</p>
          </div>
        ))}
      </section>

      <section aria-labelledby="now" className="panel p-5">
        <h2 id="now" className="text-2xl font-bold">
          Happening right now
        </h2>
        <p className="mb-3 text-sm text-ink-2">The live feed from the shared world.</p>
        {events.length === 0 ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : (
          <FeedList events={events.slice(0, 8)} />
        )}
      </section>
    </div>
  );
}
