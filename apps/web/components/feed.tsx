'use client';

import type { AgentMood, FeedEventView, FeedKind } from '@hustle/core/browser';
import Link from 'next/link';
import { useWorld } from '@/lib/api';
import { fmt } from '@/lib/money';
import { Portrait } from './portrait';

/** Which way money moved for the agent in each kind of event; unlisted kinds show no sign. */
const DIRECTION: Partial<Record<FeedKind, 1 | -1>> = {
  paid: 1,
  backed: 1,
  revived: 1,
  inference: -1,
  work: -1,
  tool_bought: -1,
  helper_hired: -1,
  upkeep: -1,
};

const MOOD: Partial<Record<FeedKind, AgentMood>> = {
  bid_won: 'celebrating',
  paid: 'celebrating',
  level_up: 'celebrating',
  revived: 'celebrating',
  backed: 'celebrating',
  bid_lost: 'stressed',
  spend_blocked: 'stressed',
  scam_spotted: 'stressed',
  refunded: 'stressed',
  dormant: 'sleeping',
  work: 'busy',
  inference: 'busy',
  tool_bought: 'busy',
  helper_hired: 'busy',
  delivered: 'busy',
};

const TONE_ROW: Record<FeedEventView['tone'], string> = {
  good: '',
  bad: '',
  neutral: '',
  money: '',
  shield: 'border-l-4 border-shield bg-shield-soft font-semibold text-ink',
};

const KIND_ICON: Partial<Record<FeedKind, string>> = {
  day_ended: '🌙',
  event: '📣',
  job_posted: '📌',
  wallet: '👛',
  approval_requested: '✋',
  approval_resolved: '✅',
};

/**
 * "Day N, HH:00". Day-end events are stamped on the tick that starts the next day, so their own
 * day reads as "end of day N" rather than "Day N, 00:00" (which would sort after the next day).
 */
export function gameTime(day: number, tick: number, dayTicks: number): string {
  const tickDay = Math.floor(tick / dayTicks) + 1;
  if (tickDay > day) return `End of day ${day}`;
  return `Day ${day}, ${tickClock(tick, dayTicks)}`;
}

export const tickClock = (tick: number, dayTicks: number) =>
  `${String(Math.floor(((tick % dayTicks) / dayTicks) * 24)).padStart(2, '0')}:00`;

export function FeedItem({
  event,
  fresh = false,
  dayTicks,
  jobLink = true,
}: {
  event: FeedEventView;
  fresh?: boolean;
  dayTicks: number;
  jobLink?: boolean;
}) {
  // A blocked payment in shield tone moved nothing; one in bad tone went through and was lost.
  // Payouts carry the job's profit, signed: negative is a loss on the job.
  const dir =
    event.kind === 'spend_blocked'
      ? event.tone === 'shield'
        ? undefined
        : -1
      : event.kind === 'paid' && event.amount
        ? BigInt(event.amount) < 0n
          ? -1
          : 1
        : DIRECTION[event.kind];
  const amount = event.amount && BigInt(event.amount) !== 0n ? BigInt(event.amount) : null;
  const shield = event.tone === 'shield';
  const mine = event.agent?.isMine;
  return (
    <li
      className={`flex gap-3 rounded-xl px-3 py-2.5 ${fresh ? 'feed-new' : ''} ${TONE_ROW[event.tone]} ${shield ? 'shield-in' : ''} ${mine && !shield ? 'bg-brand-soft/45' : ''}`}
    >
      <div className="mt-0.5 w-9 shrink-0">
        {event.agent ? (
          <Link href={`/agents/${event.agent.id}`} aria-label={`${event.agent.name}'s profile`}>
            <Portrait look={event.agent.look} mood={MOOD[event.kind] ?? 'idle'} size={36} still />
          </Link>
        ) : (
          <span
            className="grid size-9 place-items-center rounded-full bg-surface-2 text-lg"
            aria-hidden="true"
          >
            {KIND_ICON[event.kind] ?? '•'}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={`text-[15px] leading-snug ${event.kind === 'diary' ? 'italic text-ink-2' : ''}`}
        >
          {event.text}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span className="tnum">{gameTime(event.day, event.tick, dayTicks)}</span>
          {mine && <span className="font-semibold text-brand">Your agent</span>}
          {event.scope === 'owner' && <span>Only you see this</span>}
          {event.jobId && jobLink && (
            <Link
              href={`/jobs/${event.jobId}`}
              className="font-semibold text-ink-2 underline-offset-2 hover:underline"
            >
              View job
            </Link>
          )}
        </p>
      </div>
      {amount !== null && (
        <span
          className={`tnum self-start rounded-lg px-1.5 py-0.5 text-sm font-bold ${dir === 1 ? 'bg-good-soft text-good' : dir === -1 ? 'text-bad' : shield ? 'text-shield line-through' : 'text-ink-2'}`}
          title={shield ? 'Blocked: no money moved' : undefined}
        >
          {dir === 1 ? '+' : dir === -1 ? '−' : ''}
          {fmt(amount < 0n ? -amount : amount)}
        </span>
      )}
    </li>
  );
}

export function FeedList({
  events,
  fresh,
  empty,
  jobLinks = true,
}: {
  events: FeedEventView[];
  fresh?: Set<number>;
  empty?: React.ReactNode;
  /** Off on a job's own page, where "View job" would link to itself. */
  jobLinks?: boolean;
}) {
  const { data: world } = useWorld();
  const dayTicks = world?.dayTicks ?? 180;
  if (events.length === 0) return <>{empty ?? null}</>;
  return (
    <ol className="space-y-1" aria-label="Activity">
      {events.map((e) => (
        <FeedItem
          key={e.seq}
          event={e}
          fresh={fresh?.has(e.seq)}
          dayTicks={dayTicks}
          jobLink={jobLinks}
        />
      ))}
    </ol>
  );
}
