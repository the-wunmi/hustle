'use client';

import type { FeedEventView, MeView } from '@hustle/core/browser';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { api, useMe } from '@/lib/api';
import { FeedList } from '../feed';
import { Portrait } from '../portrait';
import { useFeed } from '../providers';
import { Empty, Panel, Segmented } from '../ui';
import { AgentCard } from './agent-card';
import { Approvals } from './approvals';
import { CallDesk, RecentCalls } from './desk';
import { WorldPanel } from './world-panel';

/** Players may run up to three agents (MAX_AGENTS_PER_PLAYER in the engine). */
const MAX_AGENTS = 3;
/** How long after adoption the practice-job hint shows. */
const NEWCOMER_MS = 3 * 60_000;

function Transport() {
  const { transport } = useFeed();
  const label = {
    live: 'Live',
    polling: 'Updating every 2 seconds',
    connecting: 'Connecting',
  }[transport];
  return (
    <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
      <span
        className={`size-2 rounded-full ${transport === 'live' ? 'bg-good' : transport === 'polling' ? 'bg-coin' : 'bg-muted'}`}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

/** Each of the player's agents' own history, so "My agents" isn't limited to the live window. */
function useMyHistory(enabled: boolean, agentIds: string[]): FeedEventView[] {
  const key = enabled && agentIds.length ? ['my-history', ...agentIds] : null;
  const { data } = useSWR(key, async () => {
    const lists = await Promise.all(
      agentIds.map((id) => api<FeedEventView[]>(`/api/feed?agent=${id}&limit=60`)),
    );
    return lists.flat();
  });
  return data ?? [];
}

export function LiveFeed({ mineOnly: initialMine = false }: { mineOnly?: boolean }) {
  const { events, fresh } = useFeed();
  const { data: me } = useMe();
  const [filter, setFilter] = useState<'all' | 'mine'>(initialMine ? 'mine' : 'all');
  const history = useMyHistory(filter === 'mine', me?.agents.map((a) => a.id) ?? []);
  const shown = useMemo(() => {
    if (filter === 'all') return events;
    const bySeq = new Map<number, FeedEventView>();
    for (const e of [...history, ...events.filter((e) => e.agent?.isMine)]) bySeq.set(e.seq, e);
    return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
  }, [filter, events, history]);
  // Screen readers hear only what just happened to the player's own agents, one line at a time,
  // rather than every rival's bid as the whole feed updates.
  const latestMine = events.find((e) => e.agent?.isMine && fresh.has(e.seq));
  return (
    <Panel title="The hustle" action={<Transport />} className="min-h-[24rem]">
      <p aria-live="polite" className="sr-only">
        {latestMine?.text ?? ''}
      </p>
      <div className="mb-3">
        <Segmented
          label="Show"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'Everyone' },
            { value: 'mine', label: 'My agents' },
          ]}
        />
      </div>
      {events.length === 0 ? (
        <div role="status" className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-12" />
          ))}
          <span className="sr-only">Loading the feed</span>
        </div>
      ) : (
        <FeedList
          events={shown.slice(0, 80)}
          fresh={fresh}
          empty={
            <Empty title="Nothing from your agents yet">
              Their bids, costs and payouts will show up here within a minute.
            </Empty>
          }
        />
      )}
    </Panel>
  );
}

export function Hustle({ me }: { me: MeView }) {
  const [selected, setSelected] = useState(0);
  const agent = me.agents[Math.min(selected, me.agents.length - 1)];
  if (!agent) return null;
  // The practice job is the first thing a new agent does; the view doesn't flag it, so use age.
  const newcomer =
    agent.reputation.jobs === 0 &&
    agent.currentJob &&
    Date.now() - new Date(agent.createdAt).getTime() < NEWCOMER_MS;
  return (
    <div className="space-y-5">
      <CallDesk />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,400px)_1fr]">
        <div className="space-y-5">
          {me.agents.length > 1 ? (
            <div className="flex items-center gap-2">
              {me.agents.length > 1 && (
                <div role="tablist" aria-label="Your agents" className="flex gap-1">
                  {me.agents.map((a, i) => (
                    <button
                      key={a.id}
                      type="button"
                      role="tab"
                      aria-selected={a.id === agent.id}
                      onClick={() => setSelected(i)}
                      className={`flex items-center gap-1 rounded-xl px-2 py-1 text-sm font-semibold ${a.id === agent.id ? 'bg-surface ring-2 ring-line-strong' : 'text-ink-2 hover:bg-surface'}`}
                    >
                      <Portrait look={a.look} mood={a.mood} size={28} still />
                      {a.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          {newcomer && (
            <p className="rounded-xl border-2 border-dashed border-brand/50 bg-brand-soft/50 p-3 text-sm">
              {agent.name} is doing a practice job to learn the ropes. Watch the feed: every bid,
              cost and payout shows up there.
            </p>
          )}
          <AgentCard agent={agent} canAdopt={me.agents.length < MAX_AGENTS} />
          <Approvals agentName={agent.name} />
          <RecentCalls />
          <WorldPanel />
        </div>
        <LiveFeed />
      </div>
    </div>
  );
}
