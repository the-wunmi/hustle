'use client';

import type { DayReportView } from '@hustle/core/browser';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useId } from 'react';
import { Portrait } from '@/components/portrait';
import { Badge, ButtonLink, Empty, ErrorNote, inputClass, Skeleton, Stars } from '@/components/ui';
import { ApiError, useAgent, useApi, useMe, useWorld } from '@/lib/api';
import { fmt, shownMicro } from '@/lib/money';
import { quoted } from '@/lib/text';

/** One agent's day reports, a day at a time (the day is in the URL: `?tab=work&day=N`). */
export function DayReports({ id }: { id: string }) {
  return (
    <Suspense fallback={<ReportSkeleton />}>
      <Report id={id} />
    </Suspense>
  );
}

function Report({ id }: { id: string }) {
  const search = useSearchParams();
  const router = useRouter();
  const { data: world } = useWorld();
  const { data: me, isLoading: meLoading } = useMe();
  const { data: agent } = useAgent(id);
  const today = world?.day ?? null;
  const firstDay = agent?.createdDay ?? 1;
  // With no day asked for, open the last day that has ended (the one a day skip just closed),
  // unless the agent was adopted today and has no finished day yet.
  const lastFinished = today === null ? null : today - 1 >= firstDay ? today - 1 : today;
  const asked = Number(search.get('day'));
  const day = Number.isInteger(asked) && asked >= 1 ? asked : agent ? lastFinished : null;
  const {
    data: report,
    error,
    mutate,
  } = useApi<DayReportView>(me && day ? `/api/agents/${id}/report?day=${day}` : null);
  const selectId = useId();

  if (!meLoading && !me) {
    return (
      <Empty
        title="Sign in to read reports"
        action={
          <ButtonLink href="/" variant="primary">
            Sign in
          </ButtonLink>
        }
      >
        Day reports are private to the agent's manager.
      </Empty>
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return (
      <Empty
        title="No report here"
        action={<ButtonLink href={`/agents/${id}`}>Back to the agent</ButtonLink>}
      >
        Only the agent's manager can read its day reports.
      </Empty>
    );
  }
  if (error && !report) return <ErrorNote error={error} retry={() => mutate()} />;
  if (!report || !today || !day) return <ReportSkeleton />;

  const go = (d: number) => router.replace(`/agents/${id}?tab=work&day=${d}`, { scroll: false });
  // Newest first, from today back to the day the agent was adopted.
  const days = Array.from({ length: Math.max(1, today - firstDay + 1) }, (_, i) => today - i);
  const r = report;
  const name = r.agent.name;
  const totalCosts =
    BigInt(r.costs.inference) +
    BigInt(r.costs.tools) +
    BigInt(r.costs.helpers) +
    BigInt(r.costs.upkeep) +
    BigInt(r.costs.fees) +
    BigInt(r.costs.bonds);
  const profit = BigInt(r.profit);
  // What the server left unitemised (zero when its numbers are complete).
  const unitemised = BigInt(r.revenue) - totalCosts - profit;
  // The payslip shows cents (four decimals under a cent), so it adds up the shown figures: the total
  // is shown revenue minus shown profit, and one line carries whatever the shown costs don't cover.
  const costKeys = ['inference', 'tools', 'helpers', 'upkeep', 'fees', 'bonds'] as const;
  const shownCosts = costKeys.reduce((sum, k) => sum + shownMicro(r.costs[k]), 0n);
  const shownTotal = shownMicro(r.revenue) - shownMicro(profit);
  const other = shownTotal - shownCosts;
  const levelUp = r.levelAfter > r.levelBefore;
  const bids = r.jobsWon + r.bidsLost;

  return (
    <div className="mx-auto max-w-3xl">
      <nav
        aria-label="Report days"
        className="mb-4 flex flex-wrap items-center justify-between gap-3"
      >
        <h2 className="font-display text-xl font-bold">Day reports</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => go(day - 1)}
            disabled={day <= firstDay}
            className="h-9 rounded-xl border-2 border-line bg-surface px-3 text-sm font-semibold whitespace-nowrap disabled:opacity-40"
          >
            Previous day
          </button>
          <label htmlFor={selectId} className="sr-only">
            Choose a day
          </label>
          <select
            id={selectId}
            value={day}
            onChange={(e) => go(Number(e.target.value))}
            className={`${inputClass} h-9 w-auto py-0`}
          >
            {days.map((d) => (
              <option key={d} value={d}>
                Day {d}
                {d === today ? ' (in progress)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => go(day + 1)}
            disabled={day >= today}
            className="h-9 rounded-xl border-2 border-line bg-surface px-3 text-sm font-semibold whitespace-nowrap disabled:opacity-40"
          >
            Next day
          </button>
        </div>
      </nav>

      <article className="sticker overflow-hidden" aria-labelledby={`${selectId}-title`}>
        <header className="border-b-2 border-line-strong bg-coin px-5 py-4 text-[#1a1d3a] sm:px-8">
          <div className="flex items-center gap-4">
            <Portrait
              look={r.agent.look}
              mood={
                profit > 0n
                  ? 'celebrating'
                  : r.agent.condition === 'dormant'
                    ? 'sleeping'
                    : profit < 0n
                      ? 'stressed'
                      : 'idle'
              }
              size={72}
            />
            <div className="min-w-0">
              <h1
                id={`${selectId}-title`}
                className="text-3xl leading-none font-extrabold sm:text-4xl"
              >
                The {name} Daily
              </h1>
              <p className="mt-1 font-semibold">
                Day {r.day} report{r.rank ? `, ranked #${r.rank} on the board` : ''}
              </p>
            </div>
            <div className="ml-auto hidden sm:block">
              {r.final ? <Stamp>Final</Stamp> : <Stamp>Day in progress</Stamp>}
            </div>
          </div>
          <div className="mt-2 sm:hidden">
            {r.final ? <Stamp>Final</Stamp> : <Stamp>Day in progress</Stamp>}
          </div>
        </header>

        <div className="px-5 py-5 sm:px-8">
          <p className="font-display text-2xl leading-tight font-extrabold sm:text-3xl">
            {headline(r, profit)}
          </p>
          {r.highlights.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {r.highlights.map((h) => (
                <li key={h} className="flex gap-2 text-ink-2">
                  <span aria-hidden="true">✦</span>
                  {h}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid gap-0 border-t-2 border-dashed border-line md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <section
            aria-label="Money"
            className="px-5 py-5 sm:px-8 md:border-r-2 md:border-dashed md:border-line"
          >
            <h2 className="mb-3 text-lg font-bold">Payslip</h2>
            <dl className="space-y-1.5 tnum">
              <Line
                label="Revenue from jobs"
                value={<span className="font-semibold text-good">{fmt(r.revenue)}</span>}
              />
              {BigInt(r.tips) > 0n && (
                <Line
                  label="of which 5★ tips"
                  value={<span className="text-good">{fmt(r.tips)}</span>}
                  indent
                />
              )}
              <Line label="Thinking (AI calls)" value={<Cost micro={r.costs.inference} />} indent />
              <Line label="Tools" value={<Cost micro={r.costs.tools} />} indent />
              <Line label="Helpers" value={<Cost micro={r.costs.helpers} />} indent />
              <Line label="Upkeep" value={<Cost micro={r.costs.upkeep} />} indent />
              <Line label="Platform fees" value={<Cost micro={r.costs.fees} />} indent />
              <Line label="Contract bonds lost" value={<Cost micro={r.costs.bonds} />} indent />
              {other !== 0n && (
                <Line
                  label={unitemised !== 0n ? 'Other (not itemised)' : 'Rounding'}
                  value={<Cost micro={other.toString()} />}
                  indent
                />
              )}
              <Line label="Total costs" value={<Cost micro={shownTotal.toString()} />} />
            </dl>
            <div className="mt-3 flex items-baseline justify-between border-t-4 border-double border-line-strong pt-3">
              <span className="font-display text-lg font-bold">Profit</span>
              <span
                className={`font-display text-3xl font-extrabold tnum ${profit > 0n ? 'text-good' : profit < 0n ? 'text-bad' : 'text-ink-2'}`}
              >
                {fmt(profit, { sign: true })}
              </span>
            </div>
          </section>

          <section
            aria-label="Work"
            className="border-t-2 border-dashed border-line px-5 py-5 sm:px-8 md:border-t-0"
          >
            <h2 className="mb-3 text-lg font-bold">The work</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Fact label="Jobs won">
                {r.jobsWon}
                {bids > 0 && (
                  <span className="text-sm font-normal text-muted">
                    {' '}
                    of {bids} {bids === 1 ? 'bid' : 'bids'}
                  </span>
                )}
              </Fact>
              <Fact label="Bids lost">{r.bidsLost}</Fact>
              <Fact label="Practice jobs">{r.practiceDone}</Fact>
              <Fact label="Rating">
                <Stars value={r.avgRating100 === null ? null : r.avgRating100 / 100} />
              </Fact>
              <Fact label="Level">
                {levelUp ? (
                  <span className="text-good">
                    {r.levelBefore} → {r.levelAfter} ▲
                  </span>
                ) : (
                  r.levelAfter
                )}
              </Fact>
              <Fact label="Rank">{r.rank ? `#${r.rank}` : 'Unranked'}</Fact>
            </dl>
            {r.scamsBlocked === 0 && BigInt(r.moneyLostToScams) === 0n ? (
              <p className="mt-4 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-ink-2">
                No scam payments today.
              </p>
            ) : (
              <div
                className={`mt-4 rounded-xl px-3 py-2.5 text-sm ${BigInt(r.moneyLostToScams) > 0n ? 'bg-bad-soft text-bad' : 'bg-shield-soft text-ink'}`}
              >
                <span className="font-semibold">
                  🛡 {r.scamsBlocked} scam payment{r.scamsBlocked === 1 ? '' : 's'} blocked.
                </span>{' '}
                {BigInt(r.moneyLostToScams) > 0n
                  ? `${fmt(r.moneyLostToScams)} lost to scams.`
                  : 'No money lost to scams.'}
              </div>
            )}
          </section>
        </div>

        <section
          aria-label="Calls and streak"
          className="grid gap-x-8 gap-y-3 border-t-2 border-dashed border-line px-5 py-5 sm:grid-cols-2 sm:px-8"
        >
          <div>
            <h2 className="mb-2 text-lg font-bold">Your calls</h2>
            <p className="text-ink-2">
              {r.calls.answered + r.calls.lapsed === 0
                ? `${name} didn't bring you any calls that day.`
                : `You answered ${r.calls.answered} of ${r.calls.answered + r.calls.lapsed} ${r.calls.answered + r.calls.lapsed === 1 ? 'call' : 'calls'}${r.calls.lapsed > 0 ? `; ${r.calls.lapsed} went to ${name}'s default` : ''}.`}
            </p>
            <p className="mt-1 text-ink-2">
              {BigInt(r.tips) > 0n
                ? `Clients tipped ${fmt(r.tips)} for 5★ work.`
                : 'No tips that day.'}
            </p>
          </div>
          <div>
            <h2 className="mb-2 text-lg font-bold">Contracts and streak</h2>
            <p className="text-ink-2">
              {r.contracts.won + r.contracts.lost === 0
                ? 'No contracts that day.'
                : `Contracts: ${r.contracts.won} won, ${r.contracts.lost} lost.`}
            </p>
            <p className="mt-1 font-display text-xl font-extrabold">
              🔥 Streak {r.streak}
              <span className="ml-2 text-sm font-normal text-muted">best {r.bestStreak}</span>
            </p>
          </div>
        </section>

        <section
          aria-label="Diary"
          className="border-t-2 border-dashed border-line bg-surface-2 px-5 py-5 sm:px-8"
        >
          <h2 className="mb-2 text-lg font-bold">From {name}'s diary</h2>
          {r.diary.length === 0 ? (
            <p className="text-ink-2 italic">
              {r.final ? 'Nothing written that day.' : `${name} hasn't written anything yet today.`}
            </p>
          ) : (
            <div className="space-y-2">
              {r.diary.map((line) => (
                <p key={line} className="font-display text-lg leading-snug italic">
                  {quoted(line.replace(new RegExp(`^${escapeRe(name)}:\\s*`), ''))}
                </p>
              ))}
            </div>
          )}
        </section>
      </article>
      {!r.final && (
        <p className="mt-3 text-center text-sm text-muted">
          This report fills in as the day goes on. It's final once day {r.day} ends.
        </p>
      )}
    </div>
  );
}

function headline(r: DayReportView, profit: bigint) {
  const name = r.agent.name;
  if (r.agent.condition === 'dormant' && profit <= 0n)
    return `${name} couldn't pay its upkeep and went to sleep.`;
  if (profit > 0n) return `${name} made ${fmt(profit)} after every cost.`;
  if (profit < 0n) return `${name} spent ${fmt(-profit)} more than it earned.`;
  if (r.jobsWon === 0 && r.bidsLost === 0) return `A quiet day for ${name}. No bids yet.`;
  return `${name} broke even.`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function Stamp({ children }: { children: React.ReactNode }) {
  return (
    <Badge className="rotate-[-4deg] border-2 border-[#1a1d3a] bg-white/70 px-3 py-1 text-sm text-[#1a1d3a]">
      {children}
    </Badge>
  );
}

function Line({
  label,
  value,
  indent = false,
}: {
  label: string;
  value: React.ReactNode;
  indent?: boolean;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-3 ${indent ? 'pl-4 text-ink-2' : 'font-semibold'}`}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** A payslip cost, to the exact fraction of a cent so the lines add up to the profit. */
function Cost({ micro }: { micro: string }) {
  const v = BigInt(micro);
  if (v < 0n) return <span className="text-good">+{fmt(-v)}</span>;
  return (
    <span className={v > 0n ? 'text-bad' : 'text-muted'}>{v > 0n ? `−${fmt(v)}` : fmt(v)}</span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-display text-xl font-bold tnum">{children}</dd>
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-4" role="status" aria-label="Loading report">
      <Skeleton className="h-10 w-1/2" />
      <Skeleton className="h-28" />
      <Skeleton className="h-64" />
    </div>
  );
}
