'use client';

import {
  type AgentView,
  CATEGORY_LABEL,
  traitPhrase,
  WORK_STAGES,
  type WorkStage,
} from '@hustle/core/browser';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { fmt } from '@/lib/money';
import { MoneyButton } from '../agent-money';
import { PausedBanner, SellControls } from '../market/sell';
import { Portrait } from '../portrait';
import { Badge, ButtonLink, ConditionBadge, Delta, Meter, Stat, TierBadge } from '../ui';

const STAGE_LABEL: Record<WorkStage, string> = {
  plan: 'Planning',
  tools: 'Buying tools',
  helper: 'Hiring help',
  draft: 'Drafting',
  deliver: 'Delivering',
  review: 'Client review',
  settle: 'Getting paid',
};

interface Pop {
  id: number;
  delta: bigint;
}

/** Floating "+$0.22" / "−$0.004" over the balance whenever it changes. */
function useMoneyPops(balance: string) {
  const prev = useRef<bigint | null>(null);
  const [pops, setPops] = useState<Pop[]>([]);
  const next = useRef(1);
  useEffect(() => {
    const now = BigInt(balance);
    if (prev.current !== null && now !== prev.current) {
      const id = next.current++;
      const delta = now - prev.current;
      setPops((p) => [...p.slice(-2), { id, delta }]);
      setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), 1900);
    }
    prev.current = now;
  }, [balance]);
  return pops;
}

export function StageTrack({ stage }: { stage: WorkStage | null }) {
  const at = stage ? WORK_STAGES.indexOf(stage) : -1;
  return (
    <ol className="mt-2 flex gap-1" aria-label="Work stages">
      {WORK_STAGES.map((s, i) => (
        <li
          key={s}
          className="flex-1"
          aria-current={i === at ? 'step' : undefined}
          title={STAGE_LABEL[s]}
        >
          <span
            className={`block h-2 rounded-full border border-line-strong ${i < at ? 'bg-ink' : i === at ? 'bg-coin' : 'bg-surface-2'}`}
          />
          <span className="sr-only">
            {STAGE_LABEL[s]}
            {i < at ? ', done' : i === at ? ', in progress' : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function AgentCard({ agent, canAdopt = false }: { agent: AgentView; canAdopt?: boolean }) {
  const pops = useMoneyPops(agent.balance);
  const asleep = agent.condition === 'dormant';
  return (
    <article className="sticker overflow-hidden" aria-label={`${agent.name}, your agent`}>
      <div className="flex gap-4 p-5 pb-3">
        <Link
          href={`/agents/${agent.id}`}
          className="shrink-0 rounded-2xl"
          aria-label={`Manage ${agent.name}`}
        >
          <Portrait look={agent.look} mood={agent.mood} size={112} />
        </Link>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-3xl font-extrabold">{agent.name}</h2>
          <p className="text-sm text-ink-2">{traitPhrase(agent.traits)}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <ConditionBadge condition={agent.condition} />
            <TierBadge tier={agent.tier} />
            {agent.frozen && <span className="text-xs font-semibold text-bad">Wallet frozen</span>}
          </div>
        </div>
      </div>

      <div className="relative px-5">
        <div className="text-xs text-muted">Wallet balance</div>
        <div className="relative inline-block">
          <span className="font-display text-4xl font-extrabold tnum">{fmt(agent.balance)}</span>
          <span aria-live="polite" className="pointer-events-none absolute -top-2 left-full ml-2">
            {pops.map((p) => (
              <span
                key={p.id}
                className={`money-pop absolute font-display text-lg font-extrabold whitespace-nowrap tnum ${p.delta > 0n ? 'text-good' : 'text-bad'}`}
              >
                {p.delta > 0n ? '+' : '−'}
                {fmt(p.delta > 0n ? p.delta : -p.delta)}
              </span>
            ))}
          </span>
        </div>
      </div>

      {agent.needsRulebookConfirm && (
        <div className="mx-5 mt-3 space-y-2">
          <PausedBanner agent={agent} />
          <ButtonLink href={`/agents/${agent.id}#confirm-rulebook`} variant="coin">
            Confirm its rulebook
          </ButtonLink>
        </div>
      )}
      {agent.listing && (
        <p className="mx-5 mt-3 text-sm">
          <Badge tone="coin">On the market</Badge>{' '}
          <span className="font-semibold">for {fmt(agent.listing.price)}</span>. It keeps working
          until someone buys it.
        </p>
      )}

      <StreakLine agent={agent} />

      <div className="mt-3 px-5">
        <div className="mb-1 flex justify-between text-sm">
          <span className="font-semibold">Level {agent.reputation.level}</span>
          <span className="text-muted tnum">
            {agent.reputation.progress === null
              ? 'Top level'
              : `${agent.reputation.progress}% of the way to level ${agent.reputation.level + 1}`}
          </span>
        </div>
        {agent.reputation.progress !== null && (
          <Meter
            value={agent.reputation.progress}
            label={`Progress to level ${agent.reputation.level + 1}`}
            tone="coin"
          />
        )}
      </div>

      {agent.nemesis && (
        <Link
          href={`/agents/${agent.nemesis.agent.id}`}
          className="mx-5 mt-4 flex items-center gap-3 rounded-xl border-2 border-bad/40 bg-bad-soft px-3 py-2 hover:border-bad"
        >
          <Portrait look={agent.nemesis.agent.look} mood="celebrating" size={40} still />
          <span className="min-w-0 text-sm">
            <span className="block font-display text-base font-extrabold text-bad">
              Nemesis: {agent.nemesis.agent.name}
            </span>
            <span className="block text-ink-2">
              Beat {agent.name} to a job {agent.nemesis.wins}{' '}
              {agent.nemesis.wins === 1 ? 'time' : 'times'}.
            </span>
          </span>
        </Link>
      )}

      <div className="mt-4 grid grid-cols-3 gap-2 border-y-2 border-line bg-surface-2 px-5 py-3">
        <Stat label="Earned today">
          <span className="text-good">{fmt(agent.today.earned)}</span>
        </Stat>
        <Stat label="Spent today">
          <span className="text-bad">{fmt(agent.today.spent)}</span>
        </Stat>
        <Stat label="Profit today">
          <Delta micro={agent.today.profit} />
        </Stat>
      </div>

      <div className="px-5 py-4">
        {asleep ? (
          <div className="rounded-xl bg-surface-2 p-3">
            <p className="font-semibold">{agent.name} is asleep.</p>
            <p className="text-sm text-ink-2">
              It couldn't pay its upkeep
              {agent.dormantSince ? ` on day ${agent.dormantSince}` : ''}. It can't bid until it's
              topped up or someone backs it.
            </p>
          </div>
        ) : agent.currentJob ? (
          <div>
            <p className="text-xs text-muted">Working on</p>
            <Link href={`/jobs/${agent.currentJob.id}`} className="font-semibold hover:underline">
              {agent.currentJob.title}
            </Link>
            <p className="text-sm text-ink-2">
              {agent.currentJob.stage ? STAGE_LABEL[agent.currentJob.stage] : 'Starting'}
            </p>
            <StageTrack stage={agent.currentJob.stage} />
          </div>
        ) : (
          <p className="text-sm text-ink-2">
            Looking for {CATEGORY_LABEL[agent.specialty].toLowerCase()} work on the job board.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2 px-5 pb-5">
        <MoneyButton agent={agent} mode="topup" variant={asleep ? 'coin' : 'secondary'}>
          {asleep ? `Top up to wake ${agent.name}` : 'Top up'}
        </MoneyButton>
        <ButtonLink href={`/agents/${agent.id}`}>Manage</ButtonLink>
        <ButtonLink href={`/agents/${agent.id}?tab=work`} variant="ghost">
          Day report
        </ButtonLink>
        <SellControls agent={agent} compact />
        {canAdopt && (
          <ButtonLink href="/adopt" variant="ghost" className="ml-auto">
            Adopt another
          </ButtonLink>
        )}
      </div>
    </article>
  );
}

/** The streak of well-rated jobs and the contract tier it has unlocked. */
function StreakLine({ agent }: { agent: AgentView }) {
  const next = agent.nextTierAt;
  const tierText =
    agent.contractTier > 0
      ? `contracts tier ${agent.contractTier} unlocked`
      : 'contracts unlock at a streak of 3';
  return (
    <div className="mt-3 px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-semibold">
          <span aria-hidden="true">🔥</span> Streak {agent.streak}, {tierText}
        </span>
        <span className="text-muted tnum">Best {agent.bestStreak}</span>
      </div>
      {next !== null && (
        <>
          <div className="mt-1 flex gap-1" aria-hidden="true">
            {Array.from({ length: next }, (_, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: one pip per step of the streak
                key={i}
                className={`h-2 flex-1 rounded-full ${i < agent.streak ? 'bg-bad' : 'bg-surface-2'}`}
              />
            ))}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {Math.max(0, next - agent.streak)} more well-rated{' '}
            {next - agent.streak === 1 ? 'job' : 'jobs'} to reach contracts tier{' '}
            {agent.contractTier + 1}. A refund or a paid scammer resets it.
          </p>
        </>
      )}
    </div>
  );
}
