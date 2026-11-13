'use client';

import {
  CATEGORY_LABEL,
  type JobStatus,
  type JobSummaryView,
  stagesFor,
  type WorkStage,
} from '@hustle/core/browser';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMe, useWorld } from '@/lib/api';
import { Portrait } from '../portrait';
import { useFeed } from '../providers';
import { Badge, Money, SourceBadge, Stars, StatusBadge } from '../ui';
import { SendAgentButton } from './send-agent';

/** Statuses after which nothing about the job changes any more. */
export const FINAL_STATUSES: readonly JobStatus[] = ['paid', 'refunded', 'cancelled', 'expired'];
export const isFinal = (s: JobStatus) => FINAL_STATUSES.includes(s);

/**
 * The world tick as of now: the live stream's tick when it is flowing, else the last world read,
 * advanced locally between reads so countdowns move smoothly.
 */
export function useLiveTick(): { tick: number | null; tickMs: number } {
  const { tick: streamTick } = useFeed();
  const { data: world } = useWorld();
  const tickMs = world?.tickMs ?? 2000;
  // The newer of the stream's tick and the last world read: if the stream drops to polling, its
  // last tick goes stale while the world keeps moving.
  const base =
    streamTick === null ? (world?.tick ?? null) : Math.max(streamTick, world?.tick ?? streamTick);
  const [now, setNow] = useState(() => Date.now());
  const [baseAt, setBaseAt] = useState(() => Date.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart the local clock whenever a new tick arrives
  useEffect(() => {
    setBaseAt(Date.now());
  }, [base]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (base === null) return { tick: null, tickMs };
  // Never run ahead by more than one tick between reads.
  const drift = Math.min(1, Math.max(0, (now - baseAt) / tickMs));
  return { tick: base + drift, tickMs };
}

export function closesIn(closesAtTick: number | null, tick: number | null, tickMs: number) {
  if (closesAtTick === null || tick === null) return null;
  const seconds = Math.ceil(((closesAtTick - tick) * tickMs) / 1000);
  // A job still open after its window is waiting for its client to pick, so the clock stops.
  if (seconds <= 0) return null;
  if (seconds < 60) return `closes in ${seconds}s`;
  return `closes in ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function Countdown({
  closesAtTick,
  whenDone,
}: {
  closesAtTick: number | null;
  /** Shown once the window has passed; omitted where a job can stay open past it. */
  whenDone?: string;
}) {
  const { tick, tickMs } = useLiveTick();
  const text = closesIn(closesAtTick, tick, tickMs) ?? (tick !== null ? whenDone : undefined);
  if (!text) return null;
  return <span className="tnum">{text}</span>;
}

export function ScamReveal({
  wasScam,
  status,
  compact = false,
}: {
  wasScam: boolean | null;
  status?: JobStatus;
  compact?: boolean;
}) {
  if (wasScam === null) return null;
  if (!wasScam) {
    return compact ? null : <Badge tone="good">Genuine job</Badge>;
  }
  const title = 'Revealed after the job ended. Agents never see this.';
  if (status === 'paid') {
    return (
      <Badge tone="shield" title={title}>
        🎭 Scam client, the arbiter paid for honest work
      </Badge>
    );
  }
  return (
    <Badge tone="shield" title={title}>
      🎭 This was a scam
    </Badge>
  );
}

/**
 * How a category pays right now against usual, from the world's price index (100 = usual): "+24%"
 * with an arrow, or nothing when it is at par.
 */
export function PriceShift({ percent, className = '' }: { percent: number; className?: string }) {
  if (percent === 100) return null;
  const up = percent > 100;
  return (
    <span
      className={`tnum font-semibold ${up ? 'text-good' : 'text-bad'} ${className}`}
      title={`Pays ${percent}% of usual right now`}
    >
      <span aria-hidden="true">{up ? '▲' : '▼'}</span>
      <span className="sr-only">{up ? 'up' : 'down'}</span> {up ? '+' : '−'}
      {Math.abs(percent - 100)}%
    </span>
  );
}

/** One row on the job board. */
export function JobRow({ job }: { job: JobSummaryView }) {
  const open = job.status === 'open';
  const { data: world } = useWorld();
  const { data: me } = useMe();
  const shift = world?.prices?.[job.category];
  // Only open jobs from someone else can be chased; the job page says why when one can't.
  const canSend = open && !job.clientIsMe && !!me?.agents.length;
  return (
    <li className="panel relative flex flex-col gap-3 p-4 transition-colors hover:border-line-strong sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceBadge source={job.source} label={job.sourceLabel} />
          <Badge>
            {CATEGORY_LABEL[job.category]}
            {shift !== undefined && <PriceShift percent={shift} />}
          </Badge>
          {job.minLevel > 1 && <Badge tone="warn">Level {job.minLevel}+</Badge>}
          {!open && <StatusBadge status={job.status} />}
          <ScamReveal wasScam={job.wasScam} status={job.status} compact />
        </div>
        <h3 className="mt-1.5 font-display text-lg leading-snug font-bold">
          {/* The title link stretches over the whole card, so the card is one click target. */}
          <Link
            href={`/jobs/${job.id}`}
            className="after:absolute after:inset-0 after:rounded-2xl after:content-['']"
          >
            {job.title}
          </Link>
        </h3>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-ink-2">
          <span>{job.clientIsMe ? 'Posted by you' : `Posted by ${job.clientName}`}</span>
          <span>
            {job.bidCount} {job.bidCount === 1 ? 'bid' : 'bids'}
          </span>
          {open && job.closesAtTick !== null && (
            <span className="font-semibold text-brand">
              <Countdown closesAtTick={job.closesAtTick} />
            </span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-4 sm:justify-end">
        {job.awardedTo && (
          <div className="flex items-center gap-2">
            <Portrait look={job.awardedTo.look} mood={job.awardedTo.mood} size={36} still />
            <div className="text-sm leading-tight">
              <div className="font-semibold">{job.awardedTo.name}</div>
              {job.rating !== null ? (
                <Stars value={job.rating} />
              ) : (
                <span className="text-muted">
                  {job.price ? 'at ' : ''}
                  {job.price && <Money micro={job.price} />}
                </span>
              )}
            </div>
          </div>
        )}
        {canSend && (
          <div className="relative z-10">
            <SendAgentButton jobId={job.id} title={job.title} />
          </div>
        )}
        <div className="text-right">
          <div className="text-xs text-muted">Budget</div>
          <Money micro={job.budget} className="font-display text-xl font-extrabold" />
        </div>
      </div>
    </li>
  );
}

const STAGE_LABEL: Record<WorkStage, string> = {
  plan: 'Plan',
  tools: 'Tools',
  helper: 'Helper',
  draft: 'Draft',
  work: 'Work',
  deliver: 'Deliver',
  review: 'Review',
  settle: 'Settle',
};

/** Where an awarded job is in its work stages. */
export function StageTrack({
  stage,
  status,
  loop = false,
}: {
  stage: WorkStage | null;
  status: JobStatus;
  /** Worked by the agent's own loop: its stages are Work, Deliver, Review, Settle. */
  loop?: boolean;
}) {
  const stages = stagesFor(loop);
  const done = status === 'paid' || status === 'refunded';
  const current = done ? stages.length : stage ? stages.indexOf(stage) : -1;
  return (
    <ol className={`grid gap-1 ${loop ? 'grid-cols-4' : 'grid-cols-7'}`} aria-label="Work stages">
      {stages.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'now' : 'todo';
        return (
          <li
            key={s}
            className="min-w-0 text-center"
            aria-current={state === 'now' ? 'step' : undefined}
          >
            <div
              className={`h-2.5 rounded-full border-2 ${state === 'done' ? 'border-line-strong bg-good' : state === 'now' ? 'border-line-strong bg-coin' : 'border-line bg-surface-2'}`}
            />
            <div
              className={`mt-1 truncate text-[11px] sm:text-xs ${state === 'now' ? 'font-bold text-ink' : 'text-muted'}`}
            >
              {STAGE_LABEL[s]}
              <span className="sr-only">
                {state === 'done' ? ' (done)' : state === 'now' ? ' (in progress)' : ''}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
