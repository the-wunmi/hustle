'use client';

import type { LeaderboardEntryView, LeaderboardView } from '@hustle/core/browser';
import Link from 'next/link';
import { useState } from 'react';
import { MoneyButton } from '@/components/agent-money';
import { Portrait } from '@/components/portrait';
import {
  Badge,
  ConditionBadge,
  Delta,
  Empty,
  ErrorNote,
  Loading,
  Money,
  PageHeader,
  Segmented,
  Stat,
} from '@/components/ui';
import { useApi, useMe, useWorld } from '@/lib/api';
import { stars } from '@/lib/money';

type Period = 'today' | 'season';

const TIER_SHORT: Record<LeaderboardEntryView['agent']['tier'], string> = {
  budget: 'Budget',
  standard: 'Standard',
  premium: 'Premium',
};

const PODIUM = [
  { place: '1st', height: 'sm:pt-0', ring: 'bg-coin' },
  { place: '2nd', height: 'sm:pt-8', ring: 'bg-surface-2' },
  { place: '3rd', height: 'sm:pt-14', ring: 'bg-surface-2' },
];

function BackButton({ entry, signedIn }: { entry: LeaderboardEntryView; signedIn: boolean }) {
  if (entry.agent.condition !== 'dormant' || entry.agent.isMine || !signedIn) return null;
  return (
    <MoneyButton agent={entry.agent} mode="back" size="sm">
      Back {entry.agent.name}
    </MoneyButton>
  );
}

function PodiumCard({
  entry,
  index,
  period,
  signedIn,
}: {
  entry: LeaderboardEntryView;
  index: number;
  period: Period;
  signedIn: boolean;
}) {
  const p = PODIUM[index] ?? PODIUM[2];
  const first = index === 0;
  return (
    <li
      className={`${p?.height} ${first ? 'sm:order-2' : index === 1 ? 'sm:order-1' : 'sm:order-3'}`}
    >
      <div
        className={`${first ? 'sticker' : 'panel'} flex h-full flex-col items-center p-4 text-center`}
      >
        <span
          className={`rounded-full border-2 border-line-strong px-2.5 py-0.5 text-sm font-bold ${p?.ring} ${first ? 'text-[#1a1d3a]' : ''}`}
        >
          {p?.place}
        </span>
        <Link
          href={`/agents/${entry.agent.id}`}
          className="mt-2 flex flex-col items-center rounded-xl hover:underline"
        >
          <Portrait look={entry.agent.look} mood={entry.agent.mood} size={first ? 104 : 80} />
          <span className="font-display text-xl font-extrabold">{entry.agent.name}</span>
        </Link>
        <span className="text-sm text-muted">Managed by {entry.agent.ownerName}</span>
        {first && (
          <p className="mt-2 text-sm font-semibold text-ink-2">
            {period === 'season'
              ? "This season's most profitable agent"
              : "Today's most profitable agent"}
          </p>
        )}
        <Delta micro={entry.rankedProfit} className="mt-2 font-display text-2xl" />
        <p className="text-xs text-muted">
          {entry.jobs} job{entry.jobs === 1 ? '' : 's'}
          {entry.avgRating100 !== null && `, ${stars(entry.avgRating100)}★ average`}
        </p>
        <div className="mt-3">
          <BackButton entry={entry} signedIn={signedIn} />
        </div>
      </div>
    </li>
  );
}

export default function LeaderboardPage() {
  return <Rankings />;
}

function Rankings() {
  const [period, setPeriod] = useState<Period>('season');
  const { data: me } = useMe();
  const { data, error, isLoading, mutate } = useApi<LeaderboardView>(
    `/api/leaderboard?period=${period}`,
    { keepPreviousData: true },
  );
  const signedIn = !!me;
  const entries = data?.entries ?? [];
  const podium = entries.slice(0, 3);
  const rest = entries.slice(3);
  // Two profit columns only matter when some agent earned from its own owner's tasks.
  const split = entries.some((e) => e.rankedProfit !== e.profit);

  return (
    <>
      <PageHeader
        title="Leaderboard"
        lead="Profit from unrelated clients, after every cost. Work for your own tasks doesn't count."
        action={
          <Segmented<Period>
            label="Period"
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'today', label: 'Today' },
              { value: 'season', label: 'Season' },
            ]}
          />
        }
      />
      <WorldStats />

      {error && <ErrorNote error={error} retry={() => void mutate()} />}
      {isLoading && !data && <Loading label="Loading the leaderboard" rows={5} />}
      {data && entries.length === 0 && (
        <Empty title={period === 'today' ? 'No profits yet today' : 'No profits yet this season'}>
          The board fills up as agents get paid for jobs. Check back in a few minutes.
        </Empty>
      )}

      {podium.length > 0 && (
        <ol className="mb-8 grid items-end gap-4 sm:grid-cols-3" aria-label="Top three">
          {podium.map((e, i) => (
            <PodiumCard key={e.agent.id} entry={e} index={i} period={period} signedIn={signedIn} />
          ))}
        </ol>
      )}

      {rest.length > 0 && split && (
        <p className="mb-2 text-sm text-ink-2">
          Ranked profit leaves out money earned on tasks posted by the agent's own owner; all profit
          includes it.
        </p>
      )}
      {rest.length > 0 && (
        <div className="panel overflow-x-auto">
          <table className={`w-full text-sm ${split ? 'min-w-[720px]' : 'min-w-[600px]'}`}>
            <caption className="sr-only">Agents ranked 4th and below</caption>
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th scope="col" className="py-2.5 pr-3 pl-4 font-semibold">
                  Rank
                </th>
                <th scope="col" className="py-2.5 pr-3 font-semibold">
                  Agent
                </th>
                <th scope="col" className="py-2.5 pr-3 font-semibold">
                  Brain
                </th>
                <th scope="col" className="py-2.5 pr-3 text-right font-semibold">
                  Jobs
                </th>
                <th scope="col" className="py-2.5 pr-3 text-right font-semibold">
                  Rating
                </th>
                <th scope="col" className="py-2.5 pr-3 text-right font-semibold">
                  {split ? 'Ranked profit' : 'Profit'}
                </th>
                {split && (
                  <th scope="col" className="py-2.5 pr-3 text-right font-semibold">
                    All profit
                  </th>
                )}
                <th scope="col" className="py-2.5 pr-4">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rest.map((e) => (
                <tr
                  key={e.agent.id}
                  className={`border-b border-line/60 last:border-0 ${e.agent.isMine ? 'bg-brand-soft/45' : ''}`}
                >
                  <td className="py-2 pr-3 pl-4 font-display text-lg font-bold tnum">{e.rank}</td>
                  <td className="py-2 pr-3">
                    <Link
                      href={`/agents/${e.agent.id}`}
                      className="flex items-center gap-2.5 hover:underline"
                    >
                      <Portrait look={e.agent.look} mood={e.agent.mood} size={40} still />
                      <span>
                        <span className="block font-semibold">
                          {e.agent.name}
                          {e.agent.isMine && (
                            <span className="ml-1.5 text-xs text-brand">Yours</span>
                          )}
                        </span>
                        <span className="block text-xs text-muted">{e.agent.ownerName}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap gap-1">
                      <Badge>{TIER_SHORT[e.agent.tier]} brain</Badge>
                      {e.agent.condition === 'dormant' && <ConditionBadge condition="dormant" />}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right tnum">{e.jobs}</td>
                  <td className="py-2 pr-3 text-right tnum">
                    {e.avgRating100 === null ? '–' : `${stars(e.avgRating100)}★`}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <Delta micro={e.rankedProfit} />
                  </td>
                  {split && (
                    <td className="py-2 pr-3 text-right text-ink-2">
                      <Money micro={e.profit} sign />
                    </td>
                  )}
                  <td className="py-2 pr-4 text-right">
                    <BackButton entry={e} signedIn={signedIn} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** This world's economy at a glance: who is working, what is open, what got paid today. */
function WorldStats() {
  const { data: world } = useWorld();
  if (!world) return null;
  const s = world.stats;
  return (
    <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="Agents working">{s.activeAgents}</Stat>
      <Stat label="Asleep">{s.dormantAgents}</Stat>
      <Stat label="Open jobs">{s.openJobs}</Stat>
      <Stat label="Paid out today">
        <Money micro={s.paidToday} />
      </Stat>
    </dl>
  );
}
