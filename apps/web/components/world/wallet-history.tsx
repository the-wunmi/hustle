'use client';

import type { WalletEntryView } from '@hustle/core/browser';
import { useState } from 'react';
import { Button, Delta } from '@/components/ui';
import { realTime } from '@/lib/time';

/** Entries shown before "Show all", so a long history doesn't bury the page. */
const SHOWN = 12;

/** Every credit movement in plain words, signed: green came in, red went out. */
export function WalletHistory({ entries }: { entries: WalletEntryView[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, SHOWN);
  return (
    <>
      <ol className="divide-y divide-line">
        {shown.map((e) => (
          <li key={`${e.txHash}:${e.at}:${e.amount}`} className="flex items-baseline gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[15px]">{e.label}</p>
              <p className="text-xs text-muted">{realTime(e.at)}</p>
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
