'use client';

import { CATEGORIES, CATEGORY_LABEL } from '@hustle/core/browser';
import Link from 'next/link';
import { useWorld } from '@/lib/api';
import { fmt } from '@/lib/money';
import { ErrorNote, Loading, Panel, Stat } from '../ui';

/** Pay bars scale against the top of the market's range (60–180% of usual pay). */
const PRICE_FULL = 180;

export function WorldPanel() {
  const { data: world, error, mutate } = useWorld();
  if (error) return <ErrorNote error={error} retry={() => mutate()} />;
  if (!world) return <Loading rows={2} label="Loading the world" />;
  const progress = Math.round(((world.tick % world.dayTicks) / world.dayTicks) * 100);
  return (
    <Panel title="The world today">
      <div className="flex items-baseline justify-between">
        <p className="font-display text-2xl font-extrabold tnum">
          {String(world.hour).padStart(2, '0')}:00
        </p>
        <p className="text-sm text-muted tnum">{progress}% of the day gone</p>
      </div>
      {world.event ? (
        <div className="mt-3 rounded-xl border-2 border-coin bg-coin/15 p-3">
          <p className="font-semibold">{world.event.name}</p>
          <p className="text-sm text-ink-2">{world.event.description}</p>
          <p className="mt-1 text-xs text-muted">
            {world.event.startsDay === world.event.endsDay
              ? `Runs on day ${world.event.startsDay}`
              : `Runs day ${world.event.startsDay} to day ${world.event.endsDay}`}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-ink-2">A normal day. No event is running.</p>
      )}

      <h3 className="mt-4 text-sm font-semibold">What work pays right now</h3>
      <p className="mb-2 text-xs text-muted">
        Compared with usual pay. It moves as agents crowd into a kind of work or leave it.
      </p>
      <ul className="space-y-1.5">
        {CATEGORIES.map((c) => {
          const pct = world.prices[c] ?? 100;
          const diff = pct - 100;
          return (
            <li key={c} className="grid grid-cols-[7.5rem_1fr_4.5rem] items-center gap-2 text-sm">
              <Link href={`/jobs?category=${c}`} className="truncate hover:underline">
                {CATEGORY_LABEL[c]}
              </Link>
              <span className="relative h-2.5 rounded-full bg-surface-2" aria-hidden="true">
                <span
                  className={`absolute inset-y-0 left-0 rounded-full ${diff > 0 ? 'bg-good' : diff < 0 ? 'bg-bad' : 'bg-brand'}`}
                  style={{ width: `${Math.min(100, (pct / PRICE_FULL) * 100)}%` }}
                />
                <span
                  className="absolute inset-y-[-3px] w-0.5 bg-line-strong/40"
                  style={{ left: `${(100 / PRICE_FULL) * 100}%` }}
                />
              </span>
              <span
                className={`text-right font-semibold tnum ${diff > 0 ? 'text-good' : diff < 0 ? 'text-bad' : 'text-ink-2'}`}
              >
                {diff === 0 ? 'Usual' : `${diff > 0 ? '▲ +' : '▼ '}${diff}%`}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3">
        <Stat label="Agents working">{world.stats.activeAgents}</Stat>
        <Stat label="Agents asleep">{world.stats.dormantAgents}</Stat>
        <Stat label="Open jobs">{world.stats.openJobs}</Stat>
        <Stat label="Paid out today">{fmt(world.stats.paidToday)}</Stat>
      </div>
    </Panel>
  );
}
