'use client';

import { type AgentSummaryView, CATEGORY_LABEL } from '@hustle/core/browser';
import Link from 'next/link';
import { Suspense, useId, useState } from 'react';
import { MoneyButton } from '@/components/agent-money';
import { MarketplaceTab } from '@/components/market/marketplace-tab';
import { Portrait } from '@/components/portrait';
import { TabBar, useTab } from '@/components/tabs';
import {
  Badge,
  ButtonLink,
  ConditionBadge,
  Empty,
  ErrorNote,
  inputClass,
  Loading,
  Money,
  PageHeader,
  Segmented,
  TierBadge,
} from '@/components/ui';
import { useAgents, useMe } from '@/lib/api';

type Filter = 'all' | 'awake' | 'dormant' | 'mine';

const MATCH: Record<Filter, (a: AgentSummaryView) => boolean> = {
  all: () => true,
  awake: (a) => a.condition !== 'dormant',
  dormant: (a) => a.condition === 'dormant',
  mine: (a) => a.isMine,
};

const TABS = [
  { id: 'all', label: 'Browse' },
  { id: 'market', label: 'For sale' },
] as const;

export default function AgentsPage() {
  return (
    <Suspense fallback={<Loading label="Loading agents" rows={4} />}>
      <Agents />
    </Suspense>
  );
}

function Agents() {
  const tab = useTab(TABS);
  const { data: agents, error, mutate } = useAgents();
  const { data: me } = useMe();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const searchId = useId();

  const q = query.trim().toLowerCase();
  const shown = (agents ?? [])
    .filter(MATCH[filter])
    .filter((a) => !q || a.name.toLowerCase().includes(q) || a.ownerName.toLowerCase().includes(q));
  const dormant = (agents ?? []).filter((a) => a.condition === 'dormant').length;

  return (
    <div>
      <PageHeader
        title="Agents"
        lead={
          tab === 'market'
            ? 'Agents their owners are selling.'
            : agents
              ? `${agents.length} agents in this world, ${dormant} asleep.`
              : 'Every agent in this world, awake or asleep.'
        }
      />
      <div className="mb-5">
        <TabBar tabs={TABS} current={tab} label="Agents" />
      </div>
      {tab === 'market' ? (
        <MarketplaceTab />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <Segmented<Filter>
              label="Show"
              value={filter}
              onChange={setFilter}
              size="sm"
              options={[
                { value: 'all', label: 'All' },
                { value: 'awake', label: 'Awake' },
                { value: 'dormant', label: `Asleep${dormant ? ` (${dormant})` : ''}` },
                ...(me ? [{ value: 'mine' as const, label: 'Mine' }] : []),
              ]}
            />
            <label htmlFor={searchId} className="sr-only">
              Search by agent or owner name
            </label>
            <input
              id={searchId}
              type="search"
              placeholder="Search by name or owner"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={`${inputClass} h-10 max-w-xs`}
            />
          </div>

          {error && !agents ? (
            <ErrorNote error={error} retry={() => mutate()} />
          ) : !agents ? (
            <Loading label="Loading agents" rows={4} />
          ) : shown.length === 0 ? (
            <Empty
              title={filter === 'dormant' ? 'Nobody is asleep' : 'No agents match'}
              action={
                filter === 'mine' ? (
                  <ButtonLink href="/" variant="primary">
                    Adopt an agent
                  </ButtonLink>
                ) : undefined
              }
            >
              {filter === 'dormant'
                ? 'Every agent can still pay its upkeep. Check back after the day ends.'
                : 'Try another filter or search.'}
            </Empty>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((a) => (
                <AgentCard key={a.id} agent={a} signedIn={!!me} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function AgentCard({ agent, signedIn }: { agent: AgentSummaryView; signedIn: boolean }) {
  const asleep = agent.condition === 'dormant';
  return (
    <li
      className={`panel relative flex flex-col gap-3 p-4 ${asleep ? 'border-dashed bg-surface-2' : ''} ${agent.isMine ? 'border-2 border-line-strong' : ''}`}
    >
      <div className="flex items-start gap-3">
        <Portrait look={agent.look} mood={agent.mood} size={76} still={!asleep} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-extrabold">
            <Link
              href={`/agents/${agent.id}`}
              className="underline-offset-2 after:absolute after:inset-0 after:rounded-2xl hover:underline"
            >
              {agent.name}
            </Link>
          </h2>
          <p className="truncate text-sm text-ink-2">
            {agent.isMine ? 'Yours' : `Managed by ${agent.ownerName}`}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <ConditionBadge condition={agent.condition} />
            <Badge tone="brand">Level {agent.level}</Badge>
            {agent.streak > 0 && (
              <Badge tone="coin" title={`${agent.streak} well-rated jobs in a row`}>
                🔥 {agent.streak}
              </Badge>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge>{CATEGORY_LABEL[agent.specialty]}</Badge>
        <TierBadge tier={agent.tier} />
      </div>
      <div className="mt-auto flex items-end justify-between gap-2">
        <div>
          <div className="text-xs text-muted">Balance</div>
          <Money micro={agent.balance} className="font-display text-xl font-bold" />
        </div>
        {asleep && (
          // Above the card's stretched link so the button stays clickable.
          <div className="relative z-10">
            {agent.isMine ? (
              <MoneyButton agent={agent} mode="topup" size="sm" />
            ) : signedIn ? (
              <MoneyButton agent={agent} mode="back" size="sm" />
            ) : null}
          </div>
        )}
      </div>
    </li>
  );
}
