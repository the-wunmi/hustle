'use client';

import {
  type AgentView,
  CATEGORIES,
  CATEGORY_LABEL,
  type Category,
  type ChainTxView,
  type FeedEventView,
  type JobSummaryView,
  MAX_SKILL_LEVEL,
  SPEND_REASON_TEXT,
  type SpendReason,
} from '@hustle/core/browser';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useSWRConfig } from 'swr';
import { post, useAgents, useApi, useWorld } from '@/lib/api';
import { fmt } from '@/lib/money';
import { FeedList, tickClock } from '../feed';
import { Portrait } from '../portrait';
import { useToast } from '../providers';
import {
  ago,
  Badge,
  Button,
  Empty,
  ErrorNote,
  Loading,
  Meter,
  Money,
  Panel,
  Stars,
  StatusBadge,
} from '../ui';

// ── Streak ──────────────────────────────────────────────────────────────────────────────────────

/** The streak at which contracts first unlock (the API's tier 1). */
const FIRST_TIER_AT = 3;

/** Well-rated jobs in a row, the contract tier they unlock, and how far the next tier is. */
export function StreakCard({ agent }: { agent: AgentView }) {
  const target = agent.nextTierAt;
  // Progress from the current tier's threshold (or zero) up to the next one.
  const pct = target ? Math.min(100, Math.round((agent.streak / target) * 100)) : 100;
  return (
    <section
      aria-label="Streak"
      className={`rounded-2xl border-2 p-4 ${agent.streak > 0 ? 'border-coin bg-coin/15' : 'border-line bg-surface'}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-display text-2xl font-extrabold tnum">
          {agent.streak > 0 ? '🔥 ' : ''}Streak {agent.streak}
        </p>
        <p className="text-sm text-muted tnum">Best {agent.bestStreak}</p>
      </div>
      <p className="mt-1 font-semibold">
        {agent.contractTier > 0
          ? `Contracts tier ${agent.contractTier} unlocked`
          : `Contracts unlock at a streak of ${target ?? FIRST_TIER_AT}`}
      </p>
      {target !== null && (
        <div className="mt-2">
          <Meter
            value={pct}
            tone="coin"
            label={`Streak progress toward ${agent.contractTier > 0 ? `tier ${agent.contractTier + 1}` : 'contracts'}`}
          />
          <p className="mt-1 text-xs text-muted tnum">
            {agent.streak} of {target} for{' '}
            {agent.contractTier > 0 ? `tier ${agent.contractTier + 1}` : 'the first contracts'}
          </p>
        </div>
      )}
      <p className="mt-2 text-sm text-ink-2">
        A streak counts well-rated jobs in a row. A refund, a dispute lost or money paid to a
        scammer resets it. Contracts are bigger jobs from picky clients, with a bond at stake.
      </p>
    </section>
  );
}

// ── Skills ──────────────────────────────────────────────────────────────────────────────────────

export function SkillsPanel({ agent, owner }: { agent: AgentView; owner: boolean }) {
  const { data: world } = useWorld();
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const [busy, setBusy] = useState<Category | null>(null);
  const [error, setError] = useState<unknown>(null);
  const training = CATEGORIES.find((c) => agent.skills[c].trainingUntilDay !== null);

  const train = async (c: Category) => {
    setBusy(c);
    setError(null);
    try {
      await post(`/api/agents/${agent.id}/train`, { category: c });
      toast(`${agent.name} started training in ${CATEGORY_LABEL[c]}.`, 'good');
      await mutate(`/api/agents/${agent.id}`);
      await mutate('/api/me');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Skills">
      <p className="mb-3 text-sm text-ink-2">
        Skill grows with every job in that category. Training adds a level for a fee
        {owner ? ', paid from your wallet' : ''}, and takes a day.
      </p>
      <ul className="divide-y divide-line">
        {CATEGORIES.map((c) => {
          const s = agent.skills[c];
          const next = s.level + 1;
          const top = s.level >= MAX_SKILL_LEVEL;
          const pct = s.nextAt ? Math.min(100, (s.xp / s.nextAt) * 100) : 100;
          return (
            <li key={c} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
              <div className="min-w-36 flex-1">
                <div className="flex items-center gap-2 font-semibold">
                  {CATEGORY_LABEL[c]}
                  {c === agent.specialty && <Badge tone="brand">Specialty</Badge>}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span
                    className="flex gap-1"
                    role="img"
                    aria-label={`Level ${s.level} of ${MAX_SKILL_LEVEL}`}
                  >
                    {Array.from({ length: MAX_SKILL_LEVEL }, (_, i) => (
                      <span
                        // biome-ignore lint/suspicious/noArrayIndexKey: fixed pips
                        key={i}
                        className={`size-3 rounded-full border-2 border-line-strong ${i < s.level ? 'bg-coin' : 'bg-surface-2'}`}
                      />
                    ))}
                  </span>
                  <span className="text-xs text-muted tnum">
                    {s.nextAt ? `${s.xp} / ${s.nextAt} XP` : 'Top level'}
                  </span>
                </div>
                {!top && (
                  <div className="mt-1 h-1.5 max-w-48 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              {s.trainingUntilDay !== null ? (
                <Badge tone="coin">
                  Training until day {s.trainingUntilDay}
                  {world && world.day >= s.trainingUntilDay ? ' (finishing)' : ''}
                </Badge>
              ) : owner && !top ? (
                <Button
                  size="sm"
                  busy={busy === c}
                  disabled={!!busy || !!training}
                  onClick={() => train(c)}
                  title={training ? 'Already training another skill' : undefined}
                >
                  Train to level {next}
                  {s.trainCost ? ` for ${fmt(s.trainCost)}` : ''}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <InlineErr error={error} />
    </Panel>
  );
}

function InlineErr({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="mt-3">
      <ErrorNote error={error} />
    </div>
  );
}

// ── Reputation and achievements ─────────────────────────────────────────────────────────────────

export function ReputationPanel({ agent }: { agent: AgentView }) {
  const r = agent.reputation;
  const earned = agent.achievements.filter((a) => a.earnedAt);
  const minted = new Set(agent.badges.map((b) => b.title.toLowerCase()));
  return (
    <Panel title="Reputation">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Rating</dt>
          <dd className="mt-0.5 flex items-center gap-1.5">
            <Stars value={r.avgRating100 === null ? null : r.avgRating100 / 100} />
            {r.avgRating100 !== null && (
              <span className="text-sm font-semibold tnum">
                {(r.avgRating100 / 100).toFixed(1)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Paid jobs</dt>
          <dd className="font-display text-lg font-bold tnum">{r.jobs}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Disputes</dt>
          <dd className="font-display text-lg font-bold tnum">{r.disputes}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Scams blocked</dt>
          <dd className="font-display text-lg font-bold text-shield tnum">🛡 {r.scamsBlocked}</dd>
        </div>
      </dl>
      <h3 className="mt-5 mb-2 font-bold">
        Achievements{' '}
        <span className="text-sm font-normal text-muted tnum">
          {earned.length} of {agent.achievements.length}
        </span>
      </h3>
      <ul className="grid gap-2 sm:grid-cols-2">
        {agent.achievements.map((a) => (
          <li
            key={a.id}
            className={`flex gap-3 rounded-xl border-2 p-2.5 ${a.earnedAt ? 'border-coin bg-coin/15' : 'border-dashed border-line opacity-70'}`}
          >
            <span className="text-xl" aria-hidden="true">
              {a.earnedAt ? '🏆' : '🔒'}
            </span>
            <span className="min-w-0">
              <span className="block font-semibold">{a.name}</span>
              <span className="block text-sm text-ink-2">{a.description}</span>
              <span className="block text-xs text-muted">
                {a.earnedAt ? `Earned ${ago(a.earnedAt)}` : 'Not yet'}
              </span>
              {minted.has(a.name.toLowerCase()) && (
                <Badge tone="brand" className="mt-1">
                  Minted as a badge
                </Badge>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ── Activity and diary ──────────────────────────────────────────────────────────────────────────

/** How many events the Overview shows, and how many each page of the Work tab's history loads. */
const OVERVIEW_EVENTS = 8;
const PAGE_EVENTS = 25;

function DiaryToggle({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <Button size="sm" variant="ghost" aria-pressed={on} onClick={() => set(!on)}>
      {on ? 'Show everything' : 'Diary only'}
    </Button>
  );
}

function emptyActivity(agent: AgentView, diaryOnly: boolean) {
  return (
    <Empty title={diaryOnly ? 'No diary entries yet' : 'Nothing yet'}>
      {diaryOnly
        ? `${agent.name} writes a line after each job.`
        : `${agent.name}'s bids, costs and payouts show up here as they happen.`}
    </Empty>
  );
}

/** The Overview's latest few events, with the full history one tab away. */
export function ActivityPanel({ agent }: { agent: AgentView }) {
  const [diaryOnly, setDiaryOnly] = useState(false);
  // A page's worth, so "Diary only" still finds a few lines among the other events.
  const { data, error, mutate } = useApi<FeedEventView[]>(
    `/api/feed?agent=${agent.id}&limit=${PAGE_EVENTS}`,
  );
  const all = (data ?? []).filter((e) => !diaryOnly || e.kind === 'diary');
  const events = all.slice(0, OVERVIEW_EVENTS);
  return (
    <Panel
      title={diaryOnly ? `${agent.name}'s diary` : 'Latest activity'}
      action={<DiaryToggle on={diaryOnly} set={setDiaryOnly} />}
    >
      {error ? (
        <ErrorNote error={error} retry={() => mutate()} />
      ) : !data ? (
        <Loading label="Loading activity" />
      ) : (
        <>
          <FeedList events={events} empty={emptyActivity(agent, diaryOnly)} />
          {data.length > OVERVIEW_EVENTS && (
            <Link
              href={`/agents/${agent.id}?tab=work#history`}
              className="mt-3 inline-block text-sm font-semibold text-brand underline-offset-2 hover:underline"
            >
              See all in Work
            </Link>
          )}
        </>
      )}
    </Panel>
  );
}

/** One page of history, older than `before` (or the newest page). */
function HistoryPage({
  agent,
  before,
  diaryOnly,
  onLast,
}: {
  agent: AgentView;
  before: number | null;
  diaryOnly: boolean;
  onLast: (seq: number | null) => void;
}) {
  const { data, error, mutate } = useApi<FeedEventView[]>(
    `/api/feed?agent=${agent.id}&limit=${PAGE_EVENTS}${before ? `&before=${before}` : ''}`,
  );
  useEffect(() => {
    if (data) onLast(data.length === PAGE_EVENTS ? (data.at(-1)?.seq ?? null) : null);
  }, [data, onLast]);
  if (error) return <ErrorNote error={error} retry={() => mutate()} />;
  if (!data) return <Loading label="Loading history" rows={2} />;
  const events = data.filter((e) => !diaryOnly || e.kind === 'diary');
  if (events.length === 0) return before ? null : emptyActivity(agent, diaryOnly);
  return <FeedList events={events} empty={null} />;
}

/** The Work tab's full history, newest first, a page at a time. */
export function ActivityHistory({ agent }: { agent: AgentView }) {
  const [diaryOnly, setDiaryOnly] = useState(false);
  // Cursors of the pages shown: null is the newest page; each next one starts below the last seq.
  const [pages, setPages] = useState<(number | null)[]>([null]);
  const [next, setNext] = useState<number | null>(null);
  const onLast = useCallback((seq: number | null) => setNext(seq), []);
  return (
    <section id="history">
      <Panel
        title={diaryOnly ? `${agent.name}'s diary` : 'History'}
        action={<DiaryToggle on={diaryOnly} set={setDiaryOnly} />}
      >
        <div className="space-y-2">
          {pages.map((before, i) => (
            <HistoryPage
              key={before ?? 'newest'}
              agent={agent}
              before={before}
              diaryOnly={diaryOnly}
              onLast={i === pages.length - 1 ? onLast : noop}
            />
          ))}
        </div>
        {next !== null && (
          <Button
            size="sm"
            variant="secondary"
            className="mt-3"
            onClick={() => {
              setPages((p) => [...p, next]);
              setNext(null);
            }}
          >
            Show older
          </Button>
        )}
      </Panel>
    </section>
  );
}

const noop = () => {};

// ── Backers ─────────────────────────────────────────────────────────────────────────────────────

export function BackersPanel({ agent }: { agent: AgentView }) {
  return (
    <Panel title="Backers">
      {agent.backers.length === 0 ? (
        <p className="text-sm text-ink-2">
          Nobody has backed {agent.name} yet. Backers send credits to keep an agent going.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {agent.backers.map((b, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: backers have no id; order is stable
              key={i}
              className="flex items-center justify-between gap-3 py-2"
            >
              <span>
                <span className="font-semibold">{b.name}</span>{' '}
                <span className="text-sm text-muted">on day {b.day}</span>
              </span>
              <Money micro={b.amount} className="font-semibold text-good" />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── Jobs ────────────────────────────────────────────────────────────────────────────────────────

export function RecentJobsPanel({ agent }: { agent: AgentView }) {
  const { data, error, mutate } = useApi<JobSummaryView[]>(`/api/agents/${agent.id}/jobs`);
  return (
    <Panel title="Recent jobs">
      {error ? (
        <ErrorNote error={error} retry={() => mutate()} />
      ) : !data ? (
        <Loading label="Loading jobs" rows={2} />
      ) : data.length === 0 ? (
        <Empty title="No jobs won yet">
          {agent.name} bids on its own. Wins show up here, with what each one paid.
        </Empty>
      ) : (
        <ul className="divide-y divide-line">
          {data.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <Link
                href={`/jobs/${j.id}`}
                className="min-w-0 flex-1 font-semibold underline-offset-2 hover:underline"
              >
                {j.title}
              </Link>
              {j.wasScam && j.status === 'paid' ? (
                <Badge tone="shield">Scam client, the arbiter paid for honest work</Badge>
              ) : (
                <>
                  <StatusBadge status={j.status} />
                  {j.wasScam && <Badge tone="bad">Was a scam</Badge>}
                </>
              )}
              {j.rating !== null && <Stars value={j.rating} />}
              <Money micro={j.price ?? j.budget} className="text-sm font-semibold" />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── Receipts (the chain transaction log, in plain words) ───────────────────────────────────────

type Tone = 'good' | 'bad' | 'shield' | 'neutral';
interface Receipt {
  text: string;
  tone: Tone;
}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const money = (v: unknown) => {
  const s = str(v);
  return s && /^-?\d+$/.test(s) ? fmt(s) : '';
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One chain transaction as a sentence about this agent's money. The chain detail stays in the
 * row's disclosure; unknown methods fall back to a neutral "Account change".
 */
function describe(
  tx: ChainTxView,
  account: string,
  nameOf: (accountId: string) => string,
): Receipt {
  const args = record(tx.args);
  const event = (name: string) => record(tx.events.find((e) => e.event === name)?.data);
  const has = (name: string) => tx.events.some((e) => e.event === name);
  if (tx.method === 'spend') {
    const req = record(args.request);
    const amount = money(req.amount);
    const to = nameOf(str(req.receiver_id) ?? '');
    const memo = str(req.memo);
    if (has('spend_blocked')) {
      const reason = str(event('spend_blocked').reason) as SpendReason | null;
      return {
        text: `Blocked: ${amount} to ${to}${reason && SPEND_REASON_TEXT[reason] ? `, ${SPEND_REASON_TEXT[reason]}` : ''}. No money moved.`,
        tone: 'shield',
      };
    }
    if (has('approval_requested')) {
      return { text: `Asked its manager to approve ${amount} to ${to}.`, tone: 'neutral' };
    }
    if (tx.outcome === 'failure') {
      return { text: `Payment of ${amount} to ${to} refused.`, tone: 'bad' };
    }
    // The same transaction shows on the payee's receipts too: there it is money in.
    if (str(req.receiver_id) === account) {
      const from = nameOf(tx.receiver);
      return {
        text: `Received ${amount} from ${from}${str(req.kind) === 'helper' ? ` for helping${memo ? `: ${memo}` : ''}` : ''}.`,
        tone: 'good',
      };
    }
    switch (str(req.kind)) {
      case 'inference':
        return { text: `Paid ${amount} for thinking${memo ? ` (${memo})` : ''}.`, tone: 'neutral' };
      case 'tool':
        return { text: `Paid ${to} ${amount} for a tool.`, tone: 'neutral' };
      case 'helper':
        return { text: `Paid ${to} ${amount} to help${memo ? `: ${memo}` : ''}.`, tone: 'neutral' };
      case 'upkeep':
        return { text: `Paid ${amount} daily upkeep.`, tone: 'neutral' };
      default:
        return { text: `Paid ${to} ${amount}.`, tone: 'neutral' };
    }
  }
  if (tx.method === 'accept' || has('job_paid')) {
    const transfers = event('job_settling').transfers;
    const payout = Array.isArray(transfers)
      ? transfers.map(record).find((t) => t.receiver_id === account)
      : undefined;
    const rating = typeof args.rating === 'number' ? ` (${args.rating}★)` : '';
    return payout
      ? { text: `Got paid ${money(payout.amount)} for a job${rating}.`, tone: 'good' }
      : { text: `A job it worked on was settled${rating}.`, tone: 'neutral' };
  }
  if (tx.method === 'award') {
    return args.agent_id === account
      ? { text: `Won a job at ${money(args.price)}.`, tone: 'good' }
      : { text: 'A job was awarded.', tone: 'neutral' };
  }
  if (tx.method === 'deliver')
    return { text: 'Delivered a job; its fingerprint was recorded.', tone: 'neutral' };
  if (tx.method === 'set_rulebook') return { text: 'Its rulebook was changed.', tone: 'neutral' };
  if (tx.method === 'set_frozen') {
    return {
      text: args.frozen ? 'Its wallet was frozen.' : 'Its wallet was unfrozen.',
      tone: 'neutral',
    };
  }
  if (tx.method === 'mint_agent')
    return { text: 'Came to life: its NFT and account were created.', tone: 'good' };
  if (tx.method === 'mint')
    return { text: `Received ${money(args.amount)} of starting credits.`, tone: 'good' };
  const transfer = event('ft_transfer');
  if (transfer.new_owner_id === account) {
    return {
      text: `Received ${money(transfer.amount)} from ${nameOf(str(transfer.old_owner_id) ?? '')}.`,
      tone: 'good',
    };
  }
  if (transfer.old_owner_id === account) {
    return {
      text: `Sent ${money(transfer.amount)} to ${nameOf(str(transfer.new_owner_id) ?? '')}.`,
      tone: 'neutral',
    };
  }
  if (has('sold')) {
    const sold = event('sold');
    return {
      text: `Changed hands: sold to ${nameOf(str(sold.buyer_id) ?? '')} for ${money(sold.price)}.`,
      tone: 'neutral',
    };
  }
  if (tx.method === 'nft_approve')
    return { text: 'Listed for sale on the marketplace.', tone: 'neutral' };
  if (tx.method === 'nft_revoke' || tx.method === 'cancel_listing')
    return { text: 'Taken off the marketplace.', tone: 'neutral' };
  if (tx.method === 'mint_badge' || has('mt_mint'))
    return { text: 'Earned a badge, minted to its own account.', tone: 'good' };
  if (tx.method === 'record_scam_blocked')
    return { text: 'A blocked scam was added to its record.', tone: 'shield' };
  return { text: capital(`account change (${tx.method.replaceAll('_', ' ')}).`), tone: 'neutral' };
}

const RECEIPT_TONE: Record<Tone, string> = {
  good: 'border-line bg-surface-2',
  bad: 'border-bad/40 bg-bad-soft',
  shield: 'border-shield/50 bg-shield-soft',
  neutral: 'border-line bg-surface-2',
};

/** Receipts shown before "Show all", so the log doesn't bury the page. */
const RECEIPTS_SHOWN = 8;

export function ReceiptsPanel({ agent }: { agent: AgentView }) {
  const { data, error, mutate } = useApi<ChainTxView[]>(`/api/agents/${agent.id}/txs`);
  const { data: agents } = useAgents();
  const [all, setAll] = useState(false);
  const shown = all ? data : data?.slice(0, RECEIPTS_SHOWN);
  const { data: world } = useWorld();
  const chain = world?.modes.chain;
  const nameOf = (id: string) =>
    agents?.find((a) => a.accountId === id)?.name ?? (id.split('.')[0] || 'someone');
  // A transaction's game time when the API knows its tick; otherwise how long ago it was.
  const when = (tx: ChainTxView) =>
    tx.tick !== null && tx.tick !== undefined && world
      ? `Day ${Math.floor(tx.tick / world.dayTicks) + 1}, ${tickClock(tx.tick, world.dayTicks)}`
      : ago(tx.createdAt);
  return (
    <Panel title="Receipts">
      <p className="mb-3 text-sm text-ink-2">
        Every payment {agent.name}'s own account made or received, in plain words. Open one for the
        chain detail.
        {chain === 'testnet' && (
          <span className="mt-1 block">
            {agent.name}'s money, rulebook, jobs and badges live in real NEAR contracts on NEAR
            testnet; each transaction hash can be looked up on testnet.nearblocks.io.
          </span>
        )}
        {chain === 'sandbox' && (
          <span className="mt-1 block">
            {agent.name}'s money, rulebook, jobs and badges live in real NEAR contracts, running on
            a local NEAR chain on this machine. The transaction hashes are real but local: there is
            no public explorer for them.
          </span>
        )}
        {chain === 'sim' && (
          <span className="mt-1 block">
            In this build the contracts run in a simulator that applies the same rules, so these are
            simulated transactions.
          </span>
        )}
      </p>
      {error ? (
        <ErrorNote error={error} retry={() => mutate()} />
      ) : !data ? (
        <Loading label="Loading receipts" rows={2} />
      ) : data.length === 0 ? (
        <Empty title="Nothing yet" />
      ) : (
        <ul className="space-y-2">
          {(shown ?? []).map((tx) => {
            const r = describe(tx, agent.accountId, nameOf);
            return (
              <li key={tx.hash}>
                <details className={`group rounded-xl border px-3 py-2 ${RECEIPT_TONE[r.tone]}`}>
                  <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 text-muted transition-transform group-open:rotate-90"
                    >
                      ▸
                    </span>
                    <span
                      className={`min-w-0 flex-1 ${r.tone === 'shield' ? 'font-semibold text-shield' : r.tone === 'good' ? 'font-semibold' : ''}`}
                    >
                      {r.tone === 'shield' ? '🛡 ' : ''}
                      {r.text}
                    </span>
                    <span className="shrink-0 text-xs text-muted tnum">{when(tx)}</span>
                  </summary>
                  <div className="mt-2 space-y-2 border-t border-line pt-2 text-sm">
                    <p className="text-xs text-muted">
                      What happened on chain: the <code className="text-ink-2">{tx.method}</code>{' '}
                      method, block {tx.block.toLocaleString()},{' '}
                      {tx.outcome === 'success' ? 'succeeded' : 'refused'}.
                    </p>
                    <p className="break-all text-ink-2">
                      <span className="font-semibold text-ink">{tx.signer}</span> called{' '}
                      <span className="font-semibold text-ink">{tx.receiver}</span>
                    </p>
                    {tx.error && <p className="text-bad">Refused: {tx.error}</p>}
                    {tx.events.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {tx.events.map((e, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: events are an ordered log
                          <Badge key={i} tone={e.event.includes('block') ? 'shield' : 'neutral'}>
                            {e.event}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <TxHash hash={tx.hash} block={tx.block} local={chain === 'sandbox'} />
                    <JsonBlock label="Arguments" value={tx.args} />
                    {tx.events.length > 0 && <JsonBlock label="Events" value={tx.events} />}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {data && data.length > RECEIPTS_SHOWN && (
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${data.length}`}
        </Button>
      )}
    </Panel>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-xs font-semibold text-muted">{label}</p>
      <pre className="mt-1 max-h-56 overflow-auto rounded-lg bg-surface p-2 text-xs leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/** A transaction hash, shortened, with a copy button and its block. */
function TxHash({ hash, block, local }: { hash: string; block: number; local: boolean }) {
  const [copied, setCopied] = useState(false);
  const short = hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <span>
        Transaction <code className="text-ink-2">{short}</code> in block {block.toLocaleString()}
        {local ? ' (local node, no public explorer)' : ''}
      </span>
      <button
        type="button"
        className="rounded-md border border-line px-1.5 py-0.5 font-semibold text-ink-2 hover:border-line-strong"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(hash);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard can be blocked; the full hash is in the arguments below anyway.
          }
        }}
        aria-label={`Copy transaction hash ${hash}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </p>
  );
}

// ── Badges ──────────────────────────────────────────────────────────────────────────────────────

/** NEP-245 badges the agent's own account holds. */
export function BadgesPanel({ agent }: { agent: AgentView }) {
  return (
    <Panel title="Badges">
      <p className="mb-3 text-sm text-ink-2">
        Badges are tokens on {agent.name}'s own account. They can't be sold or sent; they stay with{' '}
        {agent.name} if it changes hands.
      </p>
      {agent.badges.length === 0 ? (
        <Empty title="No badges yet">
          Some achievements are minted as badges the moment {agent.name} earns them.
        </Empty>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {agent.badges.map((b) => (
            <li
              key={b.tokenId}
              className="flex gap-3 rounded-2xl border-2 border-line-strong bg-coin/15 p-3 shadow-[3px_3px_0_var(--shadow)]"
            >
              <span
                aria-hidden="true"
                className="grid size-10 shrink-0 place-items-center rounded-full border-2 border-line-strong bg-coin text-lg"
              >
                ★
              </span>
              <span className="min-w-0">
                <span className="block font-display font-bold">{b.title}</span>
                <span className="block text-sm text-ink-2">{b.description}</span>
                <code className="mt-1 block text-xs [overflow-wrap:anywhere] text-muted">
                  Token {b.tokenId}
                </code>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── Nemesis ─────────────────────────────────────────────────────────────────────────────────────

/** The rival that has beaten this agent most often. */
export function NemesisCard({ agent }: { agent: AgentView }) {
  const n = agent.nemesis;
  if (!n) return null;
  const who = agent.isMine ? 'you' : agent.name;
  return (
    <Link
      href={`/agents/${n.agent.id}`}
      className="flex items-center gap-4 rounded-2xl border-2 border-bad bg-bad-soft p-4 shadow-[4px_4px_0_var(--shadow)] hover:-translate-y-0.5 transition-transform"
      aria-label={`Nemesis: ${n.agent.name}, beat ${who} ${n.wins} ${n.wins === 1 ? 'time' : 'times'}. Open ${n.agent.name}'s profile`}
    >
      <Portrait look={n.agent.look} mood="stressed" size={72} still />
      <span className="min-w-0">
        <span className="block text-xs font-bold text-bad">Nemesis</span>
        <span className="block font-display text-2xl leading-tight font-extrabold">
          {n.agent.name}
        </span>
        <span className="block text-sm text-ink">
          Beat {who} <strong className="tnum">{n.wins}</strong> time{n.wins === 1 ? '' : 's'}.
          {n.agent.ownerName ? ` Managed by ${n.agent.ownerName}.` : ''}
        </span>
      </span>
    </Link>
  );
}
