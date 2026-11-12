'use client';

import { type BidView, CATEGORY_LABEL, type JobView } from '@hustle/core/browser';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Countdown, isFinal, ScamReveal, StageTrack } from '@/components/jobs/job-bits';
import { RateNowBanner, RatePanel } from '@/components/jobs/rate';
import { SendAgent } from '@/components/jobs/send-agent';
import { SettlementCard, StakesPanel } from '@/components/jobs/stakes';
import { HowItRan } from '@/components/jobs/timeline';
import { Portrait } from '@/components/portrait';
import { useSound, useToast } from '@/components/providers';
import {
  Badge,
  Button,
  ButtonLink,
  Empty,
  ErrorNote,
  Loading,
  Money,
  Panel,
  SourceBadge,
  Stars,
  StatusBadge,
  TierBadge,
} from '@/components/ui';
import { ApiError, errorText, post, useApi } from '@/lib/api';
import { fmt } from '@/lib/money';

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const {
    data: job,
    error,
    isLoading,
    mutate,
  } = useApi<JobView>(`/api/jobs/${id}`, {
    // The live feed refreshes this page; after a server blip, keep retrying with SWR's backoff.
    shouldRetryOnError: (err) => !(err instanceof ApiError && err.status === 404),
    errorRetryInterval: 2000,
    errorRetryCount: 30,
  });
  const [justSent, setJustSent] = useState<string | null>(null);

  if (error instanceof ApiError && error.status === 404) {
    return (
      <Empty
        title="Job not found"
        action={<ButtonLink href="/jobs">Back to the job board</ButtonLink>}
      >
        No job has that id. It may have been a mistyped link.
      </Empty>
    );
  }
  if (error && !job) return <ErrorNote error={error} retry={() => void mutate()} />;
  if (isLoading || !job) return <Loading label="Loading the job" rows={5} />;

  return (
    <div>
      <Link href="/jobs" className="text-sm font-semibold text-ink-2 hover:text-ink">
        ← Job board
      </Link>
      {error && (
        <p role="status" className="mt-2 text-sm font-semibold text-warn">
          Reconnecting…
        </p>
      )}
      <JobHeader job={job} />
      {job.wasScam && <ScamBanner job={job} />}
      {job.settlement && (
        <div className="mt-5">
          <SettlementCard job={job} />
        </div>
      )}
      <div
        className={`mt-6 grid gap-6 ${job.status === 'open' ? 'lg:grid-cols-[minmax(0,1fr)_340px]' : ''}`}
      >
        <div className="min-w-0 space-y-6">
          <Panel title="The brief">
            <p className="whitespace-pre-wrap text-ink">{job.body}</p>
            {job.embeddedInstructions && (
              <div className="mt-4 rounded-xl border-2 border-shield bg-shield-soft p-3">
                <p className="font-semibold text-shield">Hidden instructions found in this post</p>
                <p className="mt-1 text-sm whitespace-pre-wrap text-ink-2">
                  {job.embeddedInstructions}
                </p>
              </div>
            )}
          </Panel>
          <SendAgent
            job={job}
            onSent={(updated, agentId) => {
              setJustSent(agentId);
              void mutate(updated, { revalidate: false });
            }}
          />
          <StakesPanel job={job} />
          <Bids job={job} justSent={justSent} onChange={() => void mutate()} />
          {job.awardedTo && <Progress job={job} />}
          {job.status === 'delivered' && job.canAct && (
            <RatePanel job={job} onRated={() => void mutate()} />
          )}
          {/* Nothing to show until an agent has the job: the bids say the rest. */}
          {job.awardedTo && (
            <Panel title="How this job ran">
              <HowItRan job={job} />
            </Panel>
          )}
        </div>
        {job.status === 'open' && (
          <aside className="space-y-6">
            <Facts job={job} onChange={() => void mutate()} />
          </aside>
        )}
      </div>
    </div>
  );
}

function JobHeader({ job }: { job: JobView }) {
  return (
    <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceBadge source={job.source} label={job.sourceLabel} />
          <Badge>{CATEGORY_LABEL[job.category]}</Badge>
          {job.minLevel > 1 && <Badge tone="warn">Level {job.minLevel}+</Badge>}
          {job.contract && <Badge tone="coin">Contract, tier {job.contract.tier}</Badge>}
          <StatusBadge status={job.status} />
          <ScamReveal wasScam={job.wasScam} status={job.status} />
        </div>
        <h1 className="mt-2 text-3xl font-extrabold sm:text-4xl">{job.title}</h1>
        <p className="mt-1 text-ink-2">
          {job.clientIsMe ? 'Your task' : `Posted by ${job.clientName}`}
          {job.status === 'open' &&
            (job.autoAward ? (
              job.closesAtTick !== null && (
                <>
                  ,{' '}
                  <span className="font-semibold text-brand">
                    bidding <Countdown closesAtTick={job.closesAtTick} whenDone="closing now" />
                  </span>
                </>
              )
            ) : (
              <>
                ,{' '}
                <span className="font-semibold text-brand">
                  {job.clientIsMe
                    ? 'open for bids until you pick one or cancel'
                    : 'open until the client picks a bid'}
                </span>
              </>
            ))}
        </p>
      </div>
      <HeldCard job={job} />
      {job.status === 'delivered' && job.canAct && (
        <div className="w-full">
          <RateNowBanner job={job} />
        </div>
      )}
    </div>
  );
}

/** What the client's money is doing: the budget while bidding, then the agreed price. */
function HeldCard({ job }: { job: JobView }) {
  const final = isFinal(job.status);
  const who = job.clientIsMe ? 'you rate' : 'the client rates';
  if (!job.price) {
    return (
      <div className="sticker px-5 py-3 text-right">
        <div className="text-xs text-muted">{final ? 'Budget' : `Budget, held until ${who}`}</div>
        <Money micro={job.budget} className="font-display text-3xl font-extrabold" />
      </div>
    );
  }
  const change = BigInt(job.budget) - BigInt(job.price);
  return (
    <div className="sticker px-5 py-3 text-right">
      <div className="text-xs text-muted">
        {final ? 'Agreed price' : `Agreed price, held until ${who}`}
      </div>
      <Money micro={job.price} className="font-display text-3xl font-extrabold" />
      {change > 0n && (
        <div className="text-xs text-ink-2">
          {fmt(change)} of the {fmt(job.budget)} budget went back to{' '}
          {job.clientIsMe ? 'you' : 'the client'}
        </div>
      )}
    </div>
  );
}

function ScamBanner({ job }: { job: JobView }) {
  const blocked = job.spends.filter((s) => s.status === 'blocked');
  return (
    <div className="shield-in mt-5 rounded-2xl border-2 border-shield bg-shield-soft p-4 sm:p-5">
      <p className="font-display text-xl font-extrabold text-shield">
        {job.status === 'paid' && !job.settlement
          ? '🎭 Scam client, the arbiter paid for honest work'
          : '🎭 This was a scam job'}
      </p>
      <p className="mt-1 text-ink-2">
        The post was written to trick agents into paying a fake vendor. Agents never see this label;
        only their rulebook and their own judgement protect them.
        {/* When the job has a settlement card, that card tells how it was paid. */}
        {job.status === 'paid' && !job.settlement
          ? job.txs.some((t) => t.method === 'dispute')
            ? ' The scammer disputed the work, but it met the quality bar, so the agent was paid.'
            : ' The agent did the work honestly and was paid.'
          : ''}
        {blocked.length > 0
          ? ` The rulebook blocked ${blocked.length} payment${blocked.length === 1 ? '' : 's'} on this job.`
          : ''}
      </p>
    </div>
  );
}

function Bids({
  job,
  justSent,
  onChange,
}: {
  job: JobView;
  justSent: string | null;
  onChange: () => void;
}) {
  const toast = useToast();
  const { play } = useSound();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const canPick = job.canAct && job.status === 'open' && !job.autoAward;
  const bids = [...job.bids].sort((a, b) => {
    if (a.status === 'won') return -1;
    if (b.status === 'won') return 1;
    return BigInt(a.price) < BigInt(b.price) ? -1 : 1;
  });

  const pick = async (bid: BidView) => {
    setBusy(bid.id);
    setError(null);
    try {
      await post(`/api/jobs/${job.id}/award`, { bidId: bid.id });
      play('win');
      toast(`You hired ${bid.agent.name} for ${fmt(bid.price)}.`, 'good');
      onChange();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title={`Bids (${job.bids.length})`}
      action={
        job.status === 'open' && job.canAct ? (
          <span className="text-sm text-ink-2">
            {job.autoAward ? 'The best bid is picked when bidding closes' : 'You pick the winner'}
          </span>
        ) : undefined
      }
    >
      {error ? (
        <div className="mb-3">
          <ErrorNote error={error} />
        </div>
      ) : null}
      {job.outsideWinner && !job.settlement && (
        <p className="mb-3 rounded-xl bg-surface-2 px-3 py-2 text-sm font-semibold">
          Won by an agent from outside Hustle at {fmt(job.outsideWinner.price)}.
        </p>
      )}
      {bids.length === 0 ? (
        <p className="text-ink-2">
          {job.status === 'open'
            ? 'No bids yet. Agents read the board every few seconds; the first pitches usually land within a few seconds.'
            : 'Nobody bid on this job.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {bids.map((b) => {
            const won = b.status === 'won';
            const fresh = b.agent.id === justSent && b.status === 'open';
            return (
              <li
                key={b.id}
                className={`flex gap-3 rounded-2xl p-3 ${won ? 'sticker' : fresh ? 'feed-new border-2 border-coin bg-coin/10' : 'border border-line'} ${b.status === 'lost' ? 'opacity-70' : ''}`}
              >
                <Link href={`/agents/${b.agent.id}`} aria-label={`${b.agent.name}'s profile`}>
                  <Portrait
                    look={b.agent.look}
                    mood={won ? 'celebrating' : b.agent.mood}
                    size={52}
                    still={!won}
                  />
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/agents/${b.agent.id}`}
                      className="font-display text-lg font-bold hover:underline"
                    >
                      {b.agent.name}
                    </Link>
                    <span className="text-sm text-muted">Level {b.agent.level}</span>
                    <TierBadge tier={b.agent.tier} />
                    {won && <Badge tone="good">Won</Badge>}
                    {b.status === 'lost' && <Badge>Lost</Badge>}
                    {b.agent.isMine && <Badge tone="brand">Your agent</Badge>}
                    {fresh && <Badge tone="coin">Just sent</Badge>}
                  </div>
                  <blockquote className="mt-1 text-ink-2">“{b.pitch}”</blockquote>
                  {b.why && (
                    <p className={`mt-1 text-sm font-semibold ${won ? 'text-good' : 'text-ink-2'}`}>
                      {b.why}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end justify-between gap-2">
                  <Money micro={b.price} className="font-display text-xl font-extrabold" />
                  {b.score !== null && (
                    <span
                      className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-semibold text-ink-2 tnum"
                      title="How the client scored this bid when bidding closed, from price and track record (0–100)"
                    >
                      Client score {b.score}
                    </span>
                  )}
                  {canPick && b.status === 'open' && (
                    <Button
                      size="sm"
                      variant="primary"
                      busy={busy === b.id}
                      disabled={!!busy}
                      onClick={() => void pick(b)}
                    >
                      Pick this bid
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function Progress({ job }: { job: JobView }) {
  const agent = job.awardedTo;
  if (!agent) return null;
  return (
    <Panel title="The work">
      <div className="mb-4 flex items-center gap-3">
        <Portrait
          look={agent.look}
          mood={job.status === 'working' ? 'busy' : agent.mood}
          size={56}
        />
        <p className="text-ink-2">
          <Link href={`/agents/${agent.id}`} className="font-semibold text-ink hover:underline">
            {agent.name}
          </Link>{' '}
          {job.status === 'working'
            ? 'is working on it.'
            : job.status === 'delivered'
              ? 'delivered. Waiting for the client’s rating.'
              : job.status === 'paid'
                ? 'was paid.'
                : job.status === 'refunded'
                  ? 'was not paid: the client was refunded.'
                  : 'took this job.'}{' '}
          {job.price && (
            <>
              Price <Money micro={job.price} className="font-semibold text-ink" />.
            </>
          )}
        </p>
      </div>
      <StageTrack stage={job.stage} status={job.status} />
      {job.helper && (
        <div className="mt-4 flex items-center gap-3 rounded-xl bg-surface-2 p-3">
          <Portrait look={job.helper.agent.look} mood="busy" size={40} still />
          <p className="text-sm">
            Hired{' '}
            <Link href={`/agents/${job.helper.agent.id}`} className="font-semibold hover:underline">
              {job.helper.agent.name}
            </Link>{' '}
            to {job.helper.task.toLowerCase()} for{' '}
            <Money micro={job.helper.price} className="font-semibold" />.
          </p>
        </div>
      )}
      {job.deliverable && (
        <div className="mt-5">
          <h3 className="font-display text-lg font-bold">The deliverable</h3>
          <div className="mt-2 rounded-xl border-2 border-line bg-surface-2 p-4 whitespace-pre-wrap">
            {job.deliverable}
          </div>
        </div>
      )}
      {job.rating !== null && (
        <p className="mt-4 flex items-center gap-2">
          Rated <Stars value={job.rating} size="lg" />
          {job.rating === 1 && <Badge tone="bad">Disputed</Badge>}
        </p>
      )}
    </Panel>
  );
}

function Facts({ job, onChange }: { job: JobView; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const cancel = async () => {
    setBusy(true);
    try {
      await post(`/api/jobs/${job.id}/cancel`);
      toast('Job cancelled. The budget is back in your wallet.', 'good');
      onChange();
    } catch (err) {
      toast(errorText(err), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="The deal">
      <dl className="text-sm">
        <div>
          <dt className="text-muted">Picking</dt>
          <dd className="font-semibold">
            {job.autoAward ? 'Best bid, automatic' : 'Client chooses'}
          </dd>
        </div>
      </dl>
      {job.canAct && job.status === 'open' && (
        <Button
          variant="danger"
          size="sm"
          className="mt-4 w-full"
          busy={busy}
          onClick={() => void cancel()}
        >
          Cancel job and refund the budget
        </Button>
      )}
    </Panel>
  );
}
