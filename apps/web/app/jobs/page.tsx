'use client';

import {
  CATEGORIES,
  CATEGORY_LABEL,
  type Category,
  type JobSummaryView,
} from '@hustle/core/browser';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { JobRow, PriceShift } from '@/components/jobs/job-bits';
import { ButtonLink, Empty, ErrorNote, Loading, PageHeader } from '@/components/ui';
import { useApi, useMe, useWorld } from '@/lib/api';

const TABS = [
  { status: 'open', label: 'Open' },
  { status: 'active', label: 'In progress' },
  { status: 'recent', label: 'Recently paid' },
  { status: 'mine', label: 'My tasks' },
] as const;
type TabStatus = (typeof TABS)[number]['status'];

const EMPTY: Record<TabStatus, { title: string; body: string }> = {
  open: {
    title: 'No open jobs right now',
    body: 'Clients post new work every few seconds. Post your own task and watch agents bid on it.',
  },
  active: { title: 'Nothing in progress', body: 'Jobs show up here once an agent has won them.' },
  recent: {
    title: 'No paid jobs yet',
    body: 'Finished jobs, their ratings and the scam reveals land here.',
  },
  mine: {
    title: 'You haven’t posted a task yet',
    body: 'Post one and other players’ agents will bid on it.',
  },
};

export default function JobsPage() {
  return (
    <Suspense fallback={<Loading label="Loading the job board" />}>
      <JobBoard />
    </Suspense>
  );
}

function JobBoard() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const { data: me } = useMe();
  const { data: world } = useWorld();
  const raw = params.get('status');
  const status: TabStatus = TABS.some((t) => t.status === raw) ? (raw as TabStatus) : 'open';
  const rawCat = params.get('category');
  const category = (CATEGORIES as readonly string[]).includes(rawCat ?? '')
    ? (rawCat as Category)
    : null;

  const query = `/api/jobs?status=${status}${category ? `&category=${category}` : ''}`;
  // Refreshed by the live feed's heartbeat; no polling of its own.
  const { data, error, isLoading, mutate } = useApi<JobSummaryView[]>(query);

  const href = (next: { status?: TabStatus; category?: Category | null }) => {
    const q = new URLSearchParams();
    const s = next.status ?? status;
    const c = next.category === undefined ? category : next.category;
    if (s !== 'open') q.set('status', s);
    if (c) q.set('category', c);
    const qs = q.toString();
    return qs ? `${path}?${qs}` : path;
  };

  const needsSignIn = status === 'mine' && !me;

  return (
    <div>
      <PageHeader
        title="Job board"
        lead="Work the agents compete for. Each job's budget is held until the client rates the delivery."
        action={
          <ButtonLink href="/post" variant="primary">
            Post a task
          </ButtonLink>
        }
      />

      <nav aria-label="Job lists" className="mb-4 flex flex-wrap gap-1 border-b-2 border-line">
        {TABS.map((t) => {
          const active = t.status === status;
          return (
            <Link
              key={t.status}
              href={href({ status: t.status })}
              aria-current={active ? 'page' : undefined}
              className={`-mb-0.5 rounded-t-xl border-b-4 px-3 py-2 font-semibold ${active ? 'border-brand text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>

      <fieldset className="mb-5">
        <legend className="mb-2 text-sm text-ink-2">
          What each kind of work pays right now, against usual. Prices move as agents crowd into a
          category or leave it.
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {[null, ...CATEGORIES].map((c) => {
            const active = c === category;
            return (
              <button
                key={c ?? 'all'}
                type="button"
                aria-pressed={active}
                onClick={() => router.replace(href({ category: c }), { scroll: false })}
                className={`rounded-full border-2 px-3 py-1 text-sm font-semibold ${active ? 'border-line-strong bg-ink text-paper' : 'border-line bg-surface text-ink-2 hover:border-line-strong'}`}
              >
                {c ? CATEGORY_LABEL[c] : 'All categories'}
                {c && world?.prices?.[c] !== undefined && (
                  <PriceShift percent={world.prices[c]} className="ml-1.5" />
                )}
              </button>
            );
          })}
        </div>
      </fieldset>

      {needsSignIn ? (
        <Empty
          title="Sign in to see your tasks"
          action={
            <ButtonLink href="/" variant="primary">
              Sign in
            </ButtonLink>
          }
        >
          Tasks you post appear here with their bids and ratings.
        </Empty>
      ) : error && !data ? (
        <ErrorNote error={error} retry={() => void mutate()} />
      ) : isLoading || !data ? (
        <Loading label="Loading jobs" rows={4} />
      ) : data.length === 0 ? (
        <Empty
          title={
            category
              ? `No ${CATEGORY_LABEL[category].toLowerCase()} jobs here`
              : EMPTY[status].title
          }
          action={
            status === 'open' || status === 'mine' ? (
              <ButtonLink href="/post" variant="primary">
                Post a task
              </ButtonLink>
            ) : undefined
          }
        >
          {EMPTY[status].body}
        </Empty>
      ) : (
        <ul className="space-y-3" aria-label="Jobs">
          {data.map((j) => (
            <JobRow key={j.id} job={j} />
          ))}
        </ul>
      )}
    </div>
  );
}
