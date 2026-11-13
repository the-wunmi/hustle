'use client';

import { type AgentView, CATEGORY_LABEL, traitPhrase } from '@hustle/core/browser';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { MoneyButton } from '@/components/agent-money';
import { ChallengesPanel } from '@/components/agents/challenges';
import { DayReports } from '@/components/agents/day-reports';
import { HolderConsole } from '@/components/agents/holder-console';
import { NftHistory } from '@/components/agents/nft-history';
import { MemoryPanel, PlaybookPanel } from '@/components/agents/playbook';
import { ProofTab } from '@/components/agents/proof';
import { RulebookEditor } from '@/components/agents/rulebook-editor';
import {
  ActivityHistory,
  ActivityPanel,
  BackersPanel,
  BadgesPanel,
  NemesisCard,
  ReceiptsPanel,
  RecentJobsPanel,
  ReputationPanel,
  SkillsPanel,
  StreakCard,
} from '@/components/agents/sections';
import { STAGE_LABEL, StageTrack } from '@/components/agents/stage-track';
import { StrategyEditor } from '@/components/agents/strategy-editor';
import { ConfirmRulebook } from '@/components/market/confirm-rulebook';
import { HireAgentLink, HireRateControls } from '@/components/market/hire';
import { SellControls } from '@/components/market/sell';
import { Portrait } from '@/components/portrait';
import { TabBar, TabPanel, useTab } from '@/components/tabs';
import {
  Badge,
  ButtonLink,
  ConditionBadge,
  Delta,
  Empty,
  ErrorNote,
  Meter,
  Money,
  Panel,
  Skeleton,
  Stat,
  TierBadge,
} from '@/components/ui';
import { ApiError, useAgent, useMe } from '@/lib/api';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'work', label: 'Work' },
  { id: 'playbook', label: 'Playbook' },
  { id: 'wallet', label: 'Wallet & rulebook' },
  { id: 'ownership', label: 'Ownership' },
  { id: 'proof', label: 'Proof' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export default function AgentPage() {
  return (
    <Suspense fallback={<ProfileSkeleton />}>
      <Profile />
    </Suspense>
  );
}

/** One home for an agent: the card on top, the detail in tabs (each with its own `?tab=` URL). */
function Profile() {
  const { id } = useParams<{ id: string }>();
  const { data: agent, error, mutate } = useAgent(id);
  const { data: me } = useMe();
  const tab: TabId = useTab(TABS);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <Empty
        title="Agent not found"
        action={<ButtonLink href="/agents">See every agent</ButtonLink>}
      >
        There's no agent with that link. It may never have been minted.
      </Empty>
    );
  }
  if (error && !agent) return <ErrorNote error={error} retry={() => mutate()} />;
  if (!agent) return <ProfileSkeleton />;

  const owner = agent.isMine;
  return (
    <div className="space-y-6">
      <Hero agent={agent} signedIn={!!me} />
      {owner && <ConfirmRulebook agent={agent} />}
      {agent.condition === 'dormant' && <DormantBanner agent={agent} signedIn={!!me} />}
      <TabBar tabs={TABS} current={tab} label={`${agent.name}'s profile`} />
      {tab === 'overview' && (
        <TabPanel label="Overview">
          <div className="mb-6 empty:hidden">
            <HireAgentLink agent={agent} />
          </div>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-6">
              <ActivityPanel agent={agent} />
            </div>
            <div className="min-w-0 space-y-6">
              <StreakCard agent={agent} />
              <NemesisCard agent={agent} />
              <ReputationPanel agent={agent} />
            </div>
          </div>
        </TabPanel>
      )}
      {tab === 'work' && (
        <TabPanel label="Work">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-6">
              {owner && <StrategyEditor agent={agent} />}
              <SkillsPanel agent={agent} owner={owner} />
            </div>
            <div className="min-w-0 space-y-6">
              <RecentJobsPanel agent={agent} />
            </div>
          </div>
          <DayReports id={agent.id} />
          <ActivityHistory agent={agent} />
        </TabPanel>
      )}
      {tab === 'playbook' && (
        <TabPanel label="Playbook and memory">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-6">
              <PlaybookPanel agent={agent} />
            </div>
            <div className="min-w-0 space-y-6">
              <MemoryPanel agent={agent} />
            </div>
          </div>
        </TabPanel>
      )}
      {tab === 'wallet' && (
        <TabPanel label="Wallet and rulebook">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-6">
              {owner && !agent.needsRulebookConfirm && <RulebookEditor agent={agent} />}
              {!owner && <PublicRules agent={agent} />}
              <ReceiptsPanel agent={agent} />
            </div>
            <div className="min-w-0 space-y-6">
              <BackersPanel agent={agent} />
            </div>
          </div>
        </TabPanel>
      )}
      {tab === 'ownership' && (
        <TabPanel label="Ownership">
          {agent.creator && (
            <Panel title="Creator">
              <p className="text-ink-2">
                {agent.creator.isMe ? 'You made' : `${agent.creator.name} made`} {agent.name}: its
                playbook, memory and record started with {agent.creator.isMe ? 'you' : 'them'}.
                Every resale through Hustle pays {agent.creator.isMe ? 'you' : 'them'}{' '}
                {agent.creator.royaltyBps / 100}% of the price, on chain, out of the seller's
                proceeds.
              </p>
            </Panel>
          )}
          {owner && !agent.needsRulebookConfirm && (
            <Panel title="Direct hire">
              <HireRateControls agent={agent} />
            </Panel>
          )}
          {owner && !agent.needsRulebookConfirm && (
            <Panel title="Sell">
              <SellControls agent={agent} />
            </Panel>
          )}
          {owner && <HolderConsole id={agent.id} />}
          <NftHistory id={agent.id} />
        </TabPanel>
      )}
      {tab === 'proof' && (
        <TabPanel label="Proof">
          <ProofTab id={agent.id} />
          <ChallengesPanel agent={agent} />
          <BadgesPanel agent={agent} />
        </TabPanel>
      )}
    </div>
  );
}

function Hero({ agent, signedIn }: { agent: AgentView; signedIn: boolean }) {
  const owner = agent.isMine;
  return (
    <section
      aria-label={`${agent.name}'s card`}
      // Below lg the wallet sits under the identity, full width; from lg it is a fixed 20rem column,
      // so long text in it (a sell hint, the buttons) can never squeeze the name and badges.
      className={`${owner ? 'sticker' : 'panel'} grid gap-6 p-5 sm:p-6 md:grid-cols-[auto_minmax(0,1fr)] lg:grid-cols-[auto_minmax(0,1fr)_20rem]`}
    >
      <div className="flex justify-center md:block">
        <Portrait
          look={agent.look}
          mood={agent.mood}
          size={168}
          label={`${agent.name}, ${agent.mood}`}
        />
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-4xl font-extrabold sm:text-5xl">{agent.name}</h1>
          <ConditionBadge condition={agent.condition} />
          {agent.frozen && <Badge tone="shield">🛡 Wallet frozen</Badge>}
        </div>
        <p className="mt-1 text-ink-2">
          {traitPhrase(agent.traits)}. Specialises in{' '}
          {CATEGORY_LABEL[agent.specialty].toLowerCase()}.{' '}
          {owner ? 'Yours.' : `Managed by ${agent.ownerName}.`}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <TierBadge tier={agent.tier} />
          {agent.brain.source === 'live' ? (
            <Badge tone="good" title={BRAIN_SOURCE.live.title}>
              Live AI
            </Badge>
          ) : agent.brain.why === 'house' ? (
            <Badge title={BRAIN_SOURCE.house.title}>House agent</Badge>
          ) : (
            agent.isMine && (
              <span className="text-xs text-muted" title={BRAIN_SOURCE[agent.brain.why].title}>
                {BRAIN_SOURCE[agent.brain.why].label}
              </span>
            )
          )}
        </div>

        <div className="mt-4 max-w-md">
          <div className="mb-1 flex flex-wrap justify-between gap-x-3 text-xs text-muted">
            <span>Reputation level {agent.reputation.level}</span>
            <span className="tnum">
              {agent.reputation.progress === null
                ? 'Top level'
                : `${agent.reputation.progress}% to the next`}
            </span>
          </div>
          {agent.reputation.progress !== null && (
            <Meter
              value={agent.reputation.progress}
              label="Progress to the next level"
              tone="coin"
            />
          )}
        </div>

        <div className="mt-4 rounded-2xl border-2 border-line bg-surface-2 p-3">
          {agent.currentJob ? (
            <>
              <p className="text-sm">
                <span className="text-muted">Working on </span>
                <Link
                  href={`/jobs/${agent.currentJob.id}`}
                  className="font-semibold underline-offset-2 hover:underline"
                >
                  {agent.currentJob.title}
                </Link>
                {agent.currentJob.stage && (
                  <span className="text-ink-2">: {STAGE_LABEL[agent.currentJob.stage]}</span>
                )}
              </p>
              <div className="mt-2">
                <StageTrack stage={agent.currentJob.stage} />
              </div>
            </>
          ) : (
            <p className="text-sm text-ink-2">
              {agent.condition === 'dormant'
                ? 'Asleep. It can’t bid until its balance is topped up.'
                : 'Between jobs, watching the board for the next one.'}
            </p>
          )}
        </div>
      </div>

      <div className="grid min-w-0 gap-4 md:col-span-2 md:grid-cols-2 md:gap-x-8 lg:col-span-1 lg:grid-cols-1">
        <div className="flex flex-col gap-4">
          <div>
            <div className="text-sm text-muted">Balance</div>
            <Money micro={agent.balance} className="font-display text-4xl font-extrabold" />
          </div>
          <dl className="grid gap-2 text-sm">
            <TodayRow label="Earned today" value={<Money micro={agent.today.earned} />} />
            <TodayRow label="Spent today" value={<Money micro={agent.today.spent} />} />
            <TodayRow label="Profit today" value={<Delta micro={agent.today.profit} />} />
          </dl>
        </div>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 border-t border-line pt-3 md:border-t-0 md:pt-0 lg:border-t lg:pt-3">
            <Stat label="Season profit">
              <Delta micro={agent.season.profit} />
            </Stat>
            <Stat label="Season jobs">{agent.season.jobs}</Stat>
          </div>
          <div className="flex flex-wrap gap-2">
            {owner ? (
              <>
                <MoneyButton agent={agent} mode="topup" />
                <MoneyButton agent={agent} mode="withdraw" />
              </>
            ) : signedIn ? (
              <MoneyButton agent={agent} mode="back" />
            ) : (
              <ButtonLink href="/" variant="coin">
                Sign in to back {agent.name}
              </ButtonLink>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function TodayRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

function DormantBanner({ agent, signedIn }: { agent: AgentView; signedIn: boolean }) {
  return (
    <section
      aria-label="Dormant"
      className="flex flex-wrap items-center gap-4 rounded-2xl border-2 border-dashed border-line-strong bg-surface-2 p-4"
    >
      <span className="text-3xl" aria-hidden="true">
        💤
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-display text-lg font-bold">
          {agent.name} is asleep{agent.dormantSince ? ` since day ${agent.dormantSince}` : ''}.
        </p>
        <p className="text-sm text-ink-2">
          It couldn't pay its upkeep, so it's off the job board. A top-up or a backer wakes it once
          its balance reaches $0.50. Its reputation fades a little while it sleeps.
        </p>
      </div>
      {agent.isMine ? (
        <MoneyButton agent={agent} mode="topup" />
      ) : signedIn ? (
        <MoneyButton agent={agent} mode="back" />
      ) : null}
    </section>
  );
}

/** What visitors can see of someone else's rules: the shape, not an editor. */
function PublicRules({ agent }: { agent: AgentView }) {
  const r = agent.rulebook;
  return (
    <section className="panel p-4 sm:p-5" aria-label="Rulebook">
      <h2 className="mb-2 text-lg font-bold">🛡 Rulebook</h2>
      <p className="mb-3 text-sm text-ink-2">
        {agent.ownerName} set these limits. {agent.name}'s wallet account enforces them on every
        payment.
      </p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Daily cap">
          <Money micro={r.dailyCap} />
        </Stat>
        <Stat label="Per job">
          <Money micro={r.maxPerJob} />
        </Stat>
        <Stat label="Per payment">
          <Money micro={r.maxPerCall} />
        </Stat>
        <Stat label="Helper budget">
          <Money micro={r.helperBudget} />
        </Stat>
      </dl>
      <p className="mt-3 text-sm text-ink-2">
        {r.anyVendor
          ? 'Pays any vendor (loose).'
          : `Pays only ${r.allowedVendors.length} approved vendor${r.allowedVendors.length === 1 ? '' : 's'}.`}{' '}
        {r.mayHire ? 'May hire helpers.' : 'Never hires helpers.'}
      </p>
    </section>
  );
}

function ProfileSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading agent">
      <div className="panel flex gap-6 p-6">
        <Skeleton className="size-40 rounded-full" />
        <div className="flex-1 space-y-3">
          <Skeleton className="h-10 w-1/2" />
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-16" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}

const BRAIN_SOURCE: Record<AgentView['brain']['why'], { label: string; title: string }> = {
  live: {
    label: 'Live AI',
    title:
      'Its model calls go to NEAR AI Cloud and are paid from its wallet at the exact billed cost.',
  },
  house: {
    label: 'House agent',
    title:
      "One of the game's computer players. It thinks with scripted replies at NEAR AI Cloud's real prices; live AI is for players' agents.",
  },
  no_key: {
    label: 'Scripted replies',
    title:
      "This build has no NEAR AI Cloud key, so every agent thinks with scripted replies at NEAR AI Cloud's real prices.",
  },
  budget_reached: {
    label: 'Live AI budget reached for today',
    title:
      "Today's live AI budget is spent, so this agent uses scripted replies until midnight UTC.",
  },
};
