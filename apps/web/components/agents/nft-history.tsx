'use client';

import type { NftHistoryView, NftMoneyEntry } from '@hustle/core/browser';
import { CopyHash } from '@/components/copy-hash';
import { Badge, Empty, ErrorNote, Loading, Panel } from '@/components/ui';
import { ApiError, useApi } from '@/lib/api';
import { fmt } from '@/lib/money';
import { realTime } from '@/lib/time';

/** Plain names for the money kinds the history reports; anything new shows as the API sends it. */
const KIND_LABEL: Record<string, string> = {
  'starting credits': 'Starting credits',
  'job payout': 'Job payouts',
  tip: 'Tips',
  'bond returned': 'Bonds returned',
  'from the treasury': 'From the treasury',
  'paid by another agent': 'Paid by another agent',
  backing: 'Backing',
  'top-up': 'Top-ups',
  inference: 'Thinking',
  tool: 'Tools',
  helper: 'Helpers',
  upkeep: 'Upkeep',
  bond: 'Bonds',
  'withdrawn by the holder': 'Withdrawn by the holder',
};
const kindLabel = (k: string) =>
  KIND_LABEL[k] ?? k.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

const HOW: Record<NftHistoryView['holders'][number]['how'], string> = {
  minted: 'Minted to',
  sold: 'Sold to',
  transferred: 'Transferred to',
};

function MoneyTable({ rows, sign, who }: { rows: NftMoneyEntry[]; sign: '+' | '−'; who: string }) {
  if (rows.length === 0) return <p className="text-sm text-ink-2">Nothing yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              Kind
            </th>
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              {who}
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-semibold">
              Amount
            </th>
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              When
            </th>
            <th scope="col" className="py-1.5 font-semibold">
              Transaction
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.txHash}-${r.kind}-${r.amount}`}
              className="border-b border-line/60 align-top"
            >
              <td className="py-1.5 pr-3">
                {kindLabel(r.kind)}
                {r.memo && <span className="block text-xs text-muted">{r.memo}</span>}
              </td>
              <td className="py-1.5 pr-3">{r.counterparty}</td>
              <td
                className={`py-1.5 pr-3 text-right font-semibold tnum ${sign === '+' ? 'text-good' : 'text-bad'}`}
              >
                {sign}
                {fmt(r.amount)}
              </td>
              <td className="py-1.5 pr-3 whitespace-nowrap text-ink-2 tnum">{realTime(r.at)}</td>
              <td className="py-1.5">
                <CopyHash hash={r.txHash} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Everyone who has held the agent's NFT, and every payment in and out of its account. */
export function NftHistory({ id }: { id: string }) {
  const { data, error, isLoading, mutate } = useApi<NftHistoryView>(`/api/agents/${id}/history`);

  if (isLoading) return <Loading label="Loading the history" rows={4} />;
  if (error instanceof ApiError && error.status === 404) {
    return <Empty title="Agent not found">There's no agent with that id.</Empty>;
  }
  if (error) return <ErrorNote error={error} retry={() => void mutate()} />;
  if (!data) return null;
  const name = data.agent.name;

  return (
    <div className="space-y-6">
      <p className="text-sm text-ink-2">
        Everyone who has held {name}'s NFT, and every payment into and out of its account, read from
        the chain's transaction log.
      </p>

      {data.truncated && (
        <p className="rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn">
          This history is long, so it shows the most recent entries; older ones exist but aren't
          listed here.
        </p>
      )}

      <Panel title="Totals by kind">
        {data.totals.length === 0 ? (
          <p className="text-sm text-ink-2">No money has moved yet.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.totals.map((t) => {
              const v = BigInt(t.amount);
              return (
                <li
                  key={t.kind}
                  className="flex items-baseline justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2"
                >
                  <span className="text-sm">{kindLabel(t.kind)}</span>
                  <span
                    className={`font-semibold tnum ${v > 0n ? 'text-good' : v < 0n ? 'text-bad' : 'text-ink-2'}`}
                  >
                    {fmt(v, { sign: true })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="Holders">
        <ol className="relative space-y-4 border-l-2 border-line pl-5">
          {data.holders.map((h, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one transaction can mint and transfer, so the hash alone may repeat
            <li key={`${h.txHash}-${i}`} className="relative">
              <span
                aria-hidden="true"
                className={`absolute top-1.5 -left-[1.6rem] size-3 rounded-full border-2 border-line-strong ${i === data.holders.length - 1 ? 'bg-coin' : 'bg-surface'}`}
              />
              <p className="font-semibold">
                {HOW[h.how]} {h.name ?? h.accountId}
                {h.price && <span className="tnum"> for {fmt(h.price)}</span>}
                {i === data.holders.length - 1 && (
                  <Badge tone="coin" className="ml-2">
                    Holds it now
                  </Badge>
                )}
              </p>
              <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
                <span className="break-all">{h.accountId}</span>
                <span className="tnum">{realTime(h.at)}</span>
                <CopyHash hash={h.txHash} />
              </p>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title="Earned">
        <MoneyTable rows={data.earnings} sign="+" who="From" />
      </Panel>

      <Panel title="Paid out">
        <MoneyTable rows={data.payouts} sign="−" who="To" />
      </Panel>
    </div>
  );
}
