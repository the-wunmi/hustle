'use client';

import type { WalletEntryView } from '@hustle/core/browser';
import { useState } from 'react';
import { tickClock } from '@/components/feed';
import { Button, Delta } from '@/components/ui';
import { useWorld } from '@/lib/api';

/** Entries shown before "Show all", so a long history doesn't bury the page. */
const SHOWN = 12;

/** Game time when the log has the tick (as everywhere else in the game), the real time otherwise. */
const when = (e: WalletEntryView, dayTicks: number) =>
  e.tick !== null
    ? `Day ${Math.floor(e.tick / dayTicks) + 1}, ${tickClock(e.tick, dayTicks)}`
    : realTime(e.at);

const realTime = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** Every credit movement in plain words, signed: green came in, red went out. */
export function WalletHistory({ entries }: { entries: WalletEntryView[] }) {
  const [all, setAll] = useState(false);
  const { data: world } = useWorld();
  const dayTicks = world?.dayTicks ?? 180;
  const shown = all ? entries : entries.slice(0, SHOWN);
  return (
    <>
      <ol className="divide-y divide-line">
        {shown.map((e) => (
          <li key={`${e.txHash}:${e.at}:${e.amount}`} className="flex items-baseline gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[15px]">{e.label}</p>
              <p className="text-xs text-muted">{when(e, dayTicks)}</p>
            </div>
            <Delta micro={e.amount} />
          </li>
        ))}
      </ol>
      {entries.length > SHOWN && (
        <Button size="sm" variant="ghost" className="mt-1" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${entries.length}`}
        </Button>
      )}
    </>
  );
}
